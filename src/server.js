'use strict';

/**
 * 多人字幕校订 HTTP 服务。
 *
 * 并发模型：每次编辑携带作品修订号（乐观锁）。
 * 过期提交 -> 409，并返回最新修订号与目标字幕段，供前端人工重试。
 */

const path = require('path');
const express = require('express');
const { openDb } = require('./db');
const {
  SrtError,
  parseSrt,
  parseTimeToMs,
  formatMs,
  serializeSrt,
} = require('./srt');
const { planShift } = require('./shift');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'subtitles.db');
const MAX_TEXT_LEN = 10000;
const MAX_TITLE_LEN = 200;
const MAX_NOTE_LEN = 500;

// sql.js 需要先加载 wasm，所有请求处理都会 await 此 promise
const dbReady = openDb(DB_PATH).then((instance) => {
  db = instance;
  /** 按开始时间重排作品内全部字幕段的展示序号 */
  reindexCues = db.transaction((workId) => {
    const rows = db
      .prepare('SELECT id FROM cues WHERE work_id = ? ORDER BY start_ms, end_ms, id')
      .all(workId);
    const stmt = db.prepare('UPDATE cues SET idx = ? WHERE id = ?');
    rows.forEach((r, i) => stmt.run(i + 1, r.id));
  });
  return db;
});
let db;
let reindexCues;
const app = express();

app.use(async (req, res, next) => {
  try {
    await dbReady;
    next();
  } catch (err) {
    next(err);
  }
});
app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function cueRow(row) {
  return {
    id: row.id,
    idx: row.idx,
    start_ms: row.start_ms,
    end_ms: row.end_ms,
    start: formatMs(row.start_ms),
    end: formatMs(row.end_ms),
    text: row.text,
  };
}

function getWorkOr404(workId) {
  const work = db.prepare('SELECT * FROM works WHERE id = ?').get(workId);
  if (!work) throw new HttpError(404, 'not_found', '作品不存在');
  return work;
}

function normalizeText(text) {
  if (typeof text !== 'string') {
    throw new HttpError(400, 'invalid_text', '字幕文字必须是字符串');
  }
  const t = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (t.trim() === '') {
    throw new HttpError(400, 'invalid_text', '字幕文字不能为空');
  }
  if (t.length > MAX_TEXT_LEN) {
    throw new HttpError(400, 'invalid_text', `字幕文字过长（上限 ${MAX_TEXT_LEN} 字）`);
  }
  return t;
}

/**
 * 解析并校验批量平移请求的公共部分：修订号、段选择、有符号整数毫秒偏移。
 * 返回 { revision, offsetMs, cueIds }；段是否存在/属于该作品由调用方在
 * 事务内结合最新数据检查。
 */
function parseShiftBody(body) {
  const b = body || {};

  if (!Number.isInteger(b.revision) || b.revision < 1) {
    throw new HttpError(400, 'invalid_revision', '缺少有效的作品修订号');
  }

  // 偏移量必须是整数毫秒：拒绝数字非整数、数字字符串非整数及其他类型
  const rawOffset = b.offset_ms;
  let offsetMs;
  if (typeof rawOffset === 'number') {
    offsetMs = rawOffset;
  } else if (typeof rawOffset === 'string' && /^\s*[+-]?\d+\s*$/.test(rawOffset)) {
    offsetMs = Number(rawOffset.trim());
  } else {
    throw new HttpError(400, 'invalid_offset', '偏移量必须是有符号整数毫秒（例如 -500 或 120）');
  }
  if (!Number.isInteger(offsetMs)) {
    throw new HttpError(400, 'invalid_offset', '偏移量必须是整数毫秒，不接受小数');
  }
  if (!Number.isSafeInteger(offsetMs)) {
    throw new HttpError(400, 'invalid_offset', '偏移量超出可表示范围');
  }

  if (!Array.isArray(b.cue_ids)) {
    throw new HttpError(400, 'invalid_selection', 'cue_ids 必须是字幕段 ID 数组');
  }
  if (b.cue_ids.length === 0) {
    throw new HttpError(400, 'empty_selection', '请至少选择一个字幕段');
  }
  const cueIds = [];
  for (const v of b.cue_ids) {
    if (!Number.isInteger(v) || v < 1) {
      throw new HttpError(400, 'invalid_selection', '字幕段 ID 必须是正整数');
    }
    if (cueIds.includes(v)) {
      throw new HttpError(400, 'duplicate_cue', `字幕段 ID ${v} 在选择中重复出现`);
    }
    cueIds.push(v);
  }

  return { revision: b.revision, offsetMs, cueIds };
}

/** 按 ID 列表取出作品内全部存在的字幕段；不存在或不属于该作品则 404 */
function loadCuesForShift(workId, cueIds) {
  const rows = db
    .prepare('SELECT * FROM cues WHERE work_id = ? ORDER BY idx, id')
    .all(workId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = cueIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new HttpError(
      404,
      'cue_not_found',
      `以下字幕段不存在或不属于该作品：${missing.join('、')}`,
      { cue_ids: missing }
    );
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* 待审提案：快照值 / 候选值 / 当前正式值                              */
/* ------------------------------------------------------------------ */

function trimName(v) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null;
}

/**
 * 校验提案携带的候选内容：修订号格式、候选起止时间格式、非负、结束晚于开始、
 * 文字合法性。不检查与其他段交叠——交叠随正式段变化，统一在采纳时重检。
 * 返回 { revision, startMs, endMs, text }。
 */
function parseProposalBody(body) {
  const b = body || {};

  if (!Number.isInteger(b.revision) || b.revision < 1) {
    throw new HttpError(400, 'invalid_revision', '缺少有效的作品修订号');
  }

  const startMs = parseTimeToMs(String(b.start ?? ''));
  const endMs = parseTimeToMs(String(b.end ?? ''));
  if (startMs === null || endMs === null) {
    throw new HttpError(
      400,
      'invalid_time',
      '时间格式应为 HH:MM:SS,mmm（例如 00:01:23,500）'
    );
  }
  if (startMs < 0 || endMs < 0) {
    throw new HttpError(422, 'negative_time', '时间不能为负数');
  }
  if (endMs <= startMs) {
    throw new HttpError(422, 'invalid_range', '结束时间必须晚于开始时间');
  }

  const text = normalizeText(b.text);

  let note = null;
  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== 'string') {
      throw new HttpError(400, 'invalid_note', '说明必须是字符串');
    }
    note = b.note.replace(/\r\n?/g, '\n').trim();
    if (note.length > MAX_NOTE_LEN) {
      throw new HttpError(400, 'invalid_note', `说明过长（上限 ${MAX_NOTE_LEN} 字）`);
    }
    note = note || null;
  }

  return { revision: b.revision, startMs, endMs, text, note };
}

/** 提案某一份“值”（原快照 / 候选 / 当前正式）的对外形态 */
function valueView(startMs, endMs, text) {
  return {
    start_ms: startMs,
    end_ms: endMs,
    start: formatMs(startMs),
    end: formatMs(endMs),
    text,
  };
}

/**
 * 组装一条提案的完整对外形态：含原值、候选值，以及目标段的当前正式值。
 * 同时标出目标段自快照以来是否已变化、按当前正式段计算候选值是否仍交叠。
 */
function presentProposal(p, cue) {
  const base = {
    id: p.id,
    work_id: p.work_id,
    cue_id: p.cue_id,
    cue_idx: cue ? cue.idx : p.cue_idx,
    status: p.status,
    base_revision: p.base_revision,
    note: p.note,
    submitter: p.submitter,
    reviewer: p.reviewer,
    created_at: p.created_at,
    closed_at: p.closed_at,
    original: valueView(p.orig_start_ms, p.orig_end_ms, p.orig_text),
    candidate: valueView(p.cand_start_ms, p.cand_end_ms, p.cand_text),
  };

  if (!cue) {
    // 目标段已随作品删除（当前实现段不单独删除，仅作品级联删除，理论上不会出现）
    return {
      ...base,
      cue_exists: false,
      current: null,
      target_changed: true,
      conflicts: [],
    };
  }

  const targetChanged =
    cue.start_ms !== p.orig_start_ms ||
    cue.end_ms !== p.orig_end_ms ||
    cue.text !== p.orig_text;

  // 按当前正式段重检候选值与其他段的交叠（半开区间，首尾相接允许）
  const conflicts = db
    .prepare(
      `SELECT id, idx, start_ms, end_ms
         FROM cues
        WHERE work_id = ? AND id != ? AND start_ms < ? AND end_ms > ?
        ORDER BY idx, id`
    )
    .all(p.work_id, cue.id, p.cand_end_ms, p.cand_start_ms)
    .map((c) => ({
      id: c.id,
      idx: c.idx,
      start: formatMs(c.start_ms),
      end: formatMs(c.end_ms),
    }));

  return {
    ...base,
    cue_exists: true,
    current: valueView(cue.start_ms, cue.end_ms, cue.text),
    target_changed: targetChanged,
    conflicts,
  };
}

/** 列出某作品的提案（默认仅待审），并附当前待审总数 */
function listProposals(workId, status) {
  const ps = db
    .prepare(
      `SELECT * FROM proposals
        WHERE work_id = ? ${status ? 'AND status = ?' : ''}
        ORDER BY (status = 'open') DESC, id DESC`
    )
    .all(...(status ? [workId, status] : [workId]));

  const cueIds = [...new Set(ps.map((p) => p.cue_id))];
  const cueById = new Map();
  for (const cueId of cueIds) {
    const cue = db.prepare('SELECT * FROM cues WHERE id = ? AND work_id = ?').get(cueId, workId);
    if (cue) cueById.set(cueId, cue);
  }

  return ps.map((p) => presentProposal(p, cueById.get(p.cue_id) || null));
}

/* ------------------------------------------------------------------ */
/* 作品：列表 / 详情 / 删除                                            */
/* ------------------------------------------------------------------ */

app.get('/api/works', (req, res) => {
  const works = db
    .prepare(
      `SELECT w.id, w.title, w.filename, w.revision, w.created_at, w.updated_at,
              COUNT(DISTINCT c.id) AS cue_count,
              COUNT(DISTINCT p.id) AS open_proposals
         FROM works w
         LEFT JOIN cues c ON c.work_id = w.id
         LEFT JOIN proposals p ON p.work_id = w.id AND p.status = 'open'
        GROUP BY w.id
        ORDER BY w.updated_at DESC, w.id DESC`
    )
    .all();
  res.json({ works });
});

app.get('/api/works/:id', (req, res, next) => {
  try {
    const work = getWorkOr404(req.params.id);
    const cues = db
      .prepare('SELECT * FROM cues WHERE work_id = ? ORDER BY idx, id')
      .all(work.id)
      .map(cueRow);
    const openCount = db
      .prepare("SELECT COUNT(*) AS n FROM proposals WHERE work_id = ? AND status = 'open'")
      .get(work.id).n;
    res.json({
      work: {
        id: work.id,
        title: work.title,
        filename: work.filename,
        revision: work.revision,
        created_at: work.created_at,
        updated_at: work.updated_at,
        open_proposals: openCount,
      },
      cues,
    });
  } catch (e) {
    next(e);
  }
});

app.delete('/api/works/:id', (req, res, next) => {
  try {
    const work = getWorkOr404(req.params.id);
    db.prepare('DELETE FROM works WHERE id = ?').run(work.id);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* 上传：严格校验，任何错误整份不入库                                  */
/* ------------------------------------------------------------------ */

app.post('/api/works', (req, res, next) => {
  try {
    const { title, filename, content } = req.body || {};

    if (typeof title !== 'string' || !title.trim()) {
      throw new HttpError(400, 'invalid_title', '作品标题不能为空');
    }
    if (title.trim().length > MAX_TITLE_LEN) {
      throw new HttpError(400, 'invalid_title', `标题过长（上限 ${MAX_TITLE_LEN} 字）`);
    }
    if (typeof filename !== 'string' || !filename.trim()) {
      throw new HttpError(400, 'invalid_filename', '缺少原始文件名');
    }
    if (typeof content !== 'string' || content.length === 0) {
      throw new HttpError(400, 'invalid_content', '缺少 SRT 文件内容');
    }
    if (content.includes('�')) {
      // 前端按 UTF-8 解码后仍出现替换符，基本可判定编码不对
      throw new SrtError('文件疑似不是 UTF-8 编码，请另存为 UTF-8 后重新上传', 1);
    }

    // 解析 + 时间合法性 + 交叠检查；抛错则下面的 catch 直接返回，绝不入库
    const parsed = parseSrt(content);

    const result = db.transaction(() => {
      const info = db
        .prepare('INSERT INTO works (title, filename) VALUES (?, ?)')
        .run(title.trim(), filename.trim());
      const workId = info.lastInsertRowid;

      const insertCue = db.prepare(
        'INSERT INTO cues (work_id, idx, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)'
      );
      parsed
        .slice()
        .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms)
        .forEach((c, i) => {
          insertCue.run(workId, i + 1, c.start_ms, c.end_ms, c.text);
        });

      db.prepare(
        'INSERT INTO revisions_log (work_id, revision, action) VALUES (?, 1, ?)'
      ).run(workId, 'import');

      return workId;
    })();

    res.status(201).json({ id: result, revision: 1, cue_count: parsed.length });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* 编辑单条字幕：乐观锁 + 时间合法性 + 交叠检查                        */
/* ------------------------------------------------------------------ */

app.put('/api/works/:id/cues/:cueId', (req, res, next) => {
  try {
    const workId = Number(req.params.id);
    const cueId = Number(req.params.cueId);
    const { revision, editor } = req.body || {};

    const work = getWorkOr404(workId);

    if (!Number.isInteger(revision) || revision < 1) {
      throw new HttpError(400, 'invalid_revision', '缺少有效的作品修订号');
    }

    const text = normalizeText(req.body && req.body.text);

    const startMs = parseTimeToMs(String(req.body.start ?? ''));
    const endMs = parseTimeToMs(String(req.body.end ?? ''));
    if (startMs === null || endMs === null) {
      throw new HttpError(
        400,
        'invalid_time',
        '时间格式应为 HH:MM:SS,mmm（例如 00:01:23,500）'
      );
    }
    if (startMs < 0 || endMs < 0) {
      throw new HttpError(422, 'negative_time', '时间不能为负数');
    }
    if (endMs <= startMs) {
      throw new HttpError(422, 'invalid_range', '结束时间必须晚于开始时间');
    }

    const outcome = db
      .transaction((wId, cId, expectedRevision) => {
        const w = db.prepare('SELECT revision FROM works WHERE id = ?').get(wId);
        if (!w) throw new HttpError(404, 'not_found', '作品不存在');

        const cue = db.prepare('SELECT * FROM cues WHERE id = ? AND work_id = ?').get(cId, wId);
        if (!cue) throw new HttpError(404, 'cue_not_found', '目标字幕段不存在或不属于该作品');

        // 修订号过期：拒绝覆盖，返回最新修订号和目标字幕段
        if (w.revision !== expectedRevision) {
          const latest = db.prepare('SELECT * FROM cues WHERE id = ?').get(cId);
          return { conflict: true, revision: w.revision, cue: latest };
        }

        // 同一作品其他字幕段不得交叠（半开区间，首尾相接允许）
        const overlap = db
          .prepare(
            `SELECT id FROM cues
              WHERE work_id = ? AND id != ? AND start_ms < ? AND end_ms > ?
              LIMIT 1`
          )
          .get(wId, cId, endMs, startMs);
        if (overlap) {
          throw new HttpError(422, 'overlap', '该时间段与同一作品的其他字幕段交叠');
        }

        db.prepare(
          'UPDATE cues SET start_ms = ?, end_ms = ?, text = ? WHERE id = ?'
        ).run(startMs, endMs, text, cId);

        const nextRevision = w.revision + 1;
        db.prepare("UPDATE works SET revision = ?, updated_at = datetime('now') WHERE id = ?")
          .run(nextRevision, wId);

        db.prepare(
          'INSERT INTO revisions_log (work_id, revision, editor, action, cue_id) VALUES (?, ?, ?, ?, ?)'
        ).run(wId, nextRevision, typeof editor === 'string' ? editor.slice(0, 80) : null, 'edit', cId);

        reindexCues(wId);
        const updated = db.prepare('SELECT * FROM cues WHERE id = ?').get(cId);
        return { conflict: false, revision: nextRevision, cue: updated };
      })
      .immediate(workId, cueId, revision);

    if (outcome.conflict) {
      throw new HttpError(409, 'revision_stale', '修订号已过期：该作品已被其他人修改', {
        latest_revision: outcome.revision,
        cue: cueRow(outcome.cue),
      });
    }

    res.json({ revision: outcome.revision, cue: cueRow(outcome.cue) });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* 批量平移：预览（基于当前修订号推演，不写库）                        */
/* ------------------------------------------------------------------ */

app.post('/api/works/:id/cues/shift/preview', (req, res, next) => {
  try {
    const workId = Number(req.params.id);
    const { revision, offsetMs, cueIds } = parseShiftBody(req.body);
    const work = getWorkOr404(workId);

    const allCues = loadCuesForShift(work.id, cueIds);
    const plan = planShift(allCues, cueIds, offsetMs);

    res.json({
      revision: work.revision, // 预览所依据的作品修订号，确认时必须原样带回
      expected_revision: work.revision,
      stale: work.revision !== revision,
      offset_ms: offsetMs,
      cue_ids: cueIds,
      valid: plan.valid,
      issues: plan.issues,
      cues: plan.entries,
    });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* 批量平移：确认（乐观锁 + 单事务重算应用，修订号只增加一次）         */
/* ------------------------------------------------------------------ */

app.post('/api/works/:id/cues/shift', (req, res, next) => {
  try {
    const workId = Number(req.params.id);
    const { revision, offsetMs, cueIds } = parseShiftBody(req.body);
    const { editor } = req.body || {};
    getWorkOr404(workId);

    const outcome = db
      .transaction((wId, ids, expectedRevision, offset) => {
        const w = db.prepare('SELECT revision FROM works WHERE id = ?').get(wId);
        if (!w) throw new HttpError(404, 'not_found', '作品不存在');

        // 预览依据的修订号与当前不一致：作品已被他人改动，拒绝按过期预览写入
        if (w.revision !== expectedRevision) {
          return { conflict: true, revision: w.revision };
        }

        const allRows = db
          .prepare('SELECT * FROM cues WHERE work_id = ? ORDER BY idx, id')
          .all(wId);
        const byId = new Map(allRows.map((r) => [r.id, r]));
        const missing = ids.filter((id) => !byId.has(id));
        if (missing.length > 0) {
          throw new HttpError(
            404,
            'cue_not_found',
            `以下字幕段不存在或不属于该作品：${missing.join('、')}`,
            { cue_ids: missing }
          );
        }

        const plan = planShift(allRows, ids, offset);
        if (!plan.valid) {
          throw new HttpError(
            422,
            'shift_rejected',
            '批量平移会产生负起点或时间交叠，已整批拒绝',
            { issues: plan.issues, cues: plan.entries }
          );
        }

        const update = db.prepare(
          'UPDATE cues SET start_ms = ?, end_ms = ? WHERE id = ?'
        );
        for (const e of plan.entries) {
          update.run(e.new_start_ms, e.new_end_ms, e.id);
        }

        const nextRevision = w.revision + 1;
        db.prepare("UPDATE works SET revision = ?, updated_at = datetime('now') WHERE id = ?")
          .run(nextRevision, wId);

        db.prepare(
          'INSERT INTO revisions_log (work_id, revision, editor, action) VALUES (?, ?, ?, ?)'
        ).run(
          wId,
          nextRevision,
          typeof editor === 'string' ? editor.slice(0, 80) : null,
          `shift x${ids.length} ${offset >= 0 ? '+' : ''}${offset}ms`
        );

        // 重算并应用全部时间后，在同一事务内重排展示序号
        reindexCues(wId);

        const cues = db
          .prepare('SELECT * FROM cues WHERE work_id = ? ORDER BY idx, id')
          .all(wId)
          .map(cueRow);
        return { conflict: false, revision: nextRevision, cues };
      })
      .immediate(workId, cueIds, revision, offsetMs);

    if (outcome.conflict) {
      throw new HttpError(409, 'revision_stale', '修订号已过期：该作品已被其他人修改，请基于最新版本重新预览后再确认', {
        latest_revision: outcome.revision,
      });
    }

    res.json({
      revision: outcome.revision,
      offset_ms: offsetMs,
      shifted_count: cueIds.length,
      cues: outcome.cues,
    });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* 待审提案：提交候选修改（不改变正式段与修订号）                      */
/* ------------------------------------------------------------------ */

app.post('/api/works/:id/proposals', (req, res, next) => {
  try {
    const workId = Number(req.params.id);
    const cueId = Number(req.body && req.body.cue_id);
    if (!Number.isInteger(cueId) || cueId < 1) {
      throw new HttpError(400, 'invalid_cue', '缺少有效的字幕段 ID（cue_id）');
    }

    const { revision, startMs, endMs, text, note } = parseProposalBody(req.body);
    const submitter = trimName(req.body && req.body.submitter);
    getWorkOr404(workId);

    const outcome = db
      .transaction((wId, cId, expectedRevision, candStart, candEnd, candText, candNote) => {
        const w = db.prepare('SELECT revision FROM works WHERE id = ?').get(wId);
        if (!w) throw new HttpError(404, 'not_found', '作品不存在');

        const cue = db.prepare('SELECT * FROM cues WHERE id = ? AND work_id = ?').get(cId, wId);
        if (!cue) throw new HttpError(404, 'cue_not_found', '目标字幕段不存在或不属于该作品');

        // 页面所见修订号已过期：拒绝且不生成提案
        if (w.revision !== expectedRevision) {
          return { conflict: true, revision: w.revision, cue: db.prepare('SELECT * FROM cues WHERE id = ?').get(cId) };
        }

        const info = db
          .prepare(
            `INSERT INTO proposals
               (work_id, cue_id, base_revision, cue_idx,
                orig_start_ms, orig_end_ms, orig_text,
                cand_start_ms, cand_end_ms, cand_text, note, submitter)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            wId, cId, w.revision, cue.idx,
            cue.start_ms, cue.end_ms, cue.text,
            candStart, candEnd, candText, candNote, submitter
          );

        const p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(info.lastInsertRowid);
        return { conflict: false, proposal: presentProposal(p, cue) };
      })
      .immediate(workId, cueId, revision, startMs, endMs, text, note);

    if (outcome.conflict) {
      throw new HttpError(409, 'revision_stale', '修订号已过期：该作品已被其他人修改，候选修改未提交', {
        latest_revision: outcome.revision,
        cue: cueRow(outcome.cue),
      });
    }

    // 提交提案不改正式段、不推进作品修订号、不影响 SRT 导出
    res.status(201).json({ revision, proposal: outcome.proposal });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* 待审提案：列表（默认仅待审，?status=all 含已结案）                  */
/* ------------------------------------------------------------------ */

app.get('/api/works/:id/proposals', (req, res, next) => {
  try {
    const work = getWorkOr404(req.params.id);
    const filter = req.query.status === 'all' || req.query.status === 'closed'
      ? req.query.status
      : 'open';
    const status = filter === 'all' ? null : filter === 'closed' ? 'closed' : 'open';
    // 'closed' 为便捷别名：实际包含 accepted / rejected 两种结案状态
    let proposals;
    if (status === 'closed') {
      const all = listProposals(work.id, null);
      proposals = all.filter((p) => p.status !== 'open');
    } else {
      proposals = listProposals(work.id, status);
    }
    const openCount = db
      .prepare("SELECT COUNT(*) AS n FROM proposals WHERE work_id = ? AND status = 'open'")
      .get(work.id).n;
    res.json({ revision: work.revision, open_count: openCount, proposals });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* 待审提案：采纳（单事务比对快照 → 重检 → 更新正式段）                */
/* ------------------------------------------------------------------ */

app.post('/api/works/:id/proposals/:pid/accept', (req, res, next) => {
  try {
    const workId = Number(req.params.id);
    const proposalId = Number(req.params.pid);
    const reviewer = trimName(req.body && req.body.reviewer);
    getWorkOr404(workId);

    const outcome = db
      .transaction((wId, pId) => {
        const w = db.prepare('SELECT revision FROM works WHERE id = ?').get(wId);
        if (!w) throw new HttpError(404, 'not_found', '作品不存在');

        const p = db.prepare('SELECT * FROM proposals WHERE id = ? AND work_id = ?').get(pId, wId);
        if (!p) throw new HttpError(404, 'proposal_not_found', '提案不存在或不属于该作品');

        // 已结案（已采纳/已驳回）不可再次处理
        if (p.status !== 'open') {
          return { closed: true, proposal: p };
        }

        const cue = db.prepare('SELECT * FROM cues WHERE id = ? AND work_id = ?').get(p.cue_id, wId);
        if (!cue) {
          return {
            targetChanged: true,
            revision: w.revision,
            proposal: presentProposal(p, null),
            issues: [{ type: 'cue_missing', message: '目标字幕段已不存在' }],
          };
        }

        // 必须确认目标段时间与文字仍与快照一致；其他段的修改不阻止采纳
        if (
          cue.start_ms !== p.orig_start_ms ||
          cue.end_ms !== p.orig_end_ms ||
          cue.text !== p.orig_text
        ) {
          return {
            targetChanged: true,
            revision: w.revision,
            proposal: presentProposal(p, cue),
            issues: [
              {
                type: 'target_changed',
                message:
                  '目标字幕段在提案提交后已被修改（正式值与快照不一致），为避免覆盖他人改动，本次未写入；请重新对照后处理',
              },
            ],
          };
        }

        // 重新检查候选值：非负时间、结束晚于开始
        const issues = [];
        if (p.cand_start_ms < 0 || p.cand_end_ms < 0) {
          issues.push({ type: 'negative_time', message: '候选时间为负数' });
        }
        if (p.cand_end_ms <= p.cand_start_ms) {
          issues.push({ type: 'invalid_range', message: '候选结束时间必须晚于开始时间' });
        }

        // 重新检查与同作品其他段不交叠（半开区间，首尾相接允许）
        const overlaps = db
          .prepare(
            `SELECT id, idx, start_ms, end_ms
               FROM cues
              WHERE work_id = ? AND id != ? AND start_ms < ? AND end_ms > ?
              ORDER BY idx, id`
          )
          .all(wId, cue.id, p.cand_end_ms, p.cand_start_ms);
        if (overlaps.length > 0) {
          issues.push({
            type: 'overlap',
            cue_ids: [cue.id, ...overlaps.map((c) => c.id)],
            cues: [{ id: cue.id, idx: cue.idx }, ...overlaps.map((c) => ({ id: c.id, idx: c.idx }))],
            message:
              `候选时间段 ${formatMs(p.cand_start_ms)} --> ${formatMs(p.cand_end_ms)}` +
              ` 当前与 ${overlaps.length} 个字幕段交叠：${overlaps.map((c) => `#${c.idx}`).join('、')}` +
              '（首尾相接不算交叠）',
          });
        }

        if (issues.length > 0) {
          // 目标虽未变但当前会产生交叠等：保留待审，返回当前段与冲突原因，不写入
          return {
            targetChanged: false,
            rejectedByRules: true,
            revision: w.revision,
            proposal: presentProposal(p, cue),
            issues,
          };
        }

        // 全部通过：更新正式段、修订号 +1、重排序号，提案结案
        db.prepare('UPDATE cues SET start_ms = ?, end_ms = ?, text = ? WHERE id = ?')
          .run(p.cand_start_ms, p.cand_end_ms, p.cand_text, cue.id);

        const nextRevision = w.revision + 1;
        db.prepare("UPDATE works SET revision = ?, updated_at = datetime('now') WHERE id = ?")
          .run(nextRevision, wId);

        db.prepare(
          'INSERT INTO revisions_log (work_id, revision, editor, action, cue_id) VALUES (?, ?, ?, ?, ?)'
        ).run(wId, nextRevision, reviewer, `accept proposal #${p.id}`, cue.id);

        db.prepare(
          "UPDATE proposals SET status = 'accepted', reviewer = ?, closed_at = datetime('now') WHERE id = ?"
        ).run(reviewer, p.id);

        reindexCues(wId);

        const updatedCue = db.prepare('SELECT * FROM cues WHERE id = ?').get(cue.id);
        const updatedProposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(p.id);
        return {
          ok: true,
          revision: nextRevision,
          cue: cueRow(updatedCue),
          proposal: presentProposal(updatedProposal, updatedCue),
        };
      })
      .immediate(workId, proposalId);

    if (outcome.closed) {
      throw new HttpError(
        409,
        'proposal_closed',
        `提案已结案（${outcome.proposal.status === 'accepted' ? '已采纳' : '已驳回'}），不可再次处理`,
        { proposal_id: outcome.proposal.id, status: outcome.proposal.status }
      );
    }
    if (outcome.targetChanged) {
      // 目标已变：保留待审，返回当前段与原因，不写入
      throw new HttpError(409, 'target_changed', outcome.issues[0].message, {
        latest_revision: outcome.revision,
        proposal: outcome.proposal,
        issues: outcome.issues,
      });
    }
    if (outcome.rejectedByRules) {
      // 当前产生交叠/时间非法：保留待审，返回当前段与冲突原因，不写入
      throw new HttpError(422, 'accept_rejected', '候选修改当前不满足时间/交叠约束，未写入，提案仍在待审区', {
        latest_revision: outcome.revision,
        proposal: outcome.proposal,
        issues: outcome.issues,
      });
    }

    res.json({
      revision: outcome.revision,
      cue: outcome.cue,
      proposal: outcome.proposal,
    });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* 待审提案：驳回（只结案，不改变正式段与修订号）                      */
/* ------------------------------------------------------------------ */

app.post('/api/works/:id/proposals/:pid/reject', (req, res, next) => {
  try {
    const workId = Number(req.params.id);
    const proposalId = Number(req.params.pid);
    const reviewer = trimName(req.body && req.body.reviewer);
    getWorkOr404(workId);

    const outcome = db
      .transaction((wId, pId) => {
        const w = db.prepare('SELECT id FROM works WHERE id = ?').get(wId);
        if (!w) throw new HttpError(404, 'not_found', '作品不存在');

        const p = db.prepare('SELECT * FROM proposals WHERE id = ? AND work_id = ?').get(pId, wId);
        if (!p) throw new HttpError(404, 'proposal_not_found', '提案不存在或不属于该作品');
        if (p.status !== 'open') {
          return { closed: true, proposal: p };
        }

        db.prepare(
          "UPDATE proposals SET status = 'rejected', reviewer = ?, closed_at = datetime('now') WHERE id = ?"
        ).run(reviewer, pId);

        const updated = db.prepare('SELECT * FROM proposals WHERE id = ?').get(pId);
        const cue = db.prepare('SELECT * FROM cues WHERE id = ? AND work_id = ?').get(p.cue_id, wId);
        return { ok: true, proposal: presentProposal(updated, cue || null) };
      })
      .immediate(workId, proposalId);

    if (outcome.closed) {
      throw new HttpError(
        409,
        'proposal_closed',
        `提案已结案（${outcome.proposal.status === 'accepted' ? '已采纳' : '已驳回'}），不可再次处理`,
        { proposal_id: outcome.proposal.id, status: outcome.proposal.status }
      );
    }

    // 驳回只结案：正式段、作品修订号、SRT 导出都不变
    res.json({ proposal: outcome.proposal });
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* 导出标准 SRT：按时间重新编号，保留文字换行                          */
/* ------------------------------------------------------------------ */

app.get('/api/works/:id/export', (req, res, next) => {
  try {
    const work = getWorkOr404(req.params.id);
    const cues = db
      .prepare('SELECT start_ms, end_ms, text FROM cues WHERE work_id = ? ORDER BY start_ms, end_ms, id')
      .all(work.id);

    const body = '\uFEFF' + serializeSrt(cues);
    const safeName =
      work.title
        .trim()
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
        .replace(/\s+/g, ' ')
        .slice(0, 120) || 'subtitles';

    res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}.srt`
    );
    res.send(body);
  } catch (e) {
    next(e);
  }
});

/* ------------------------------------------------------------------ */
/* 错误处理                                                            */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof SrtError) {
    return res.status(422).json({
      error: 'invalid_srt',
      message: err.message,
      line: err.line,
    });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: err.code,
      message: err.message,
      ...err.extra,
    });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'too_large', message: '上传文件过大（上限 6MB）' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'bad_json', message: '请求体不是合法 JSON' });
  }
  console.error(err);
  res.status(500).json({ error: 'internal', message: '服务器内部错误' });
});

if (require.main === module) {
  dbReady
    .then(() => {
      app.listen(PORT, () => {
        console.log(`字幕校订服务已启动: http://0.0.0.0:${PORT}`);
        console.log(`数据库: ${DB_PATH}`);
      });
    })
    .catch((err) => {
      console.error('存储初始化失败：', err);
      process.exit(1);
    });
}

module.exports = { app, get db() { return db; }, ready: dbReady };
