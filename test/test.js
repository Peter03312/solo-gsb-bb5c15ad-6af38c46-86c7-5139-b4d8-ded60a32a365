'use strict';

/* 无第三方依赖的集成测试：内存 SQLite + 真实 HTTP 服务。
   运行：npm test
   退出码非 0 表示有失败用例。 */

process.env.DB_PATH = ':memory:';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { parseSrt, serializeSrt, SrtError, parseTimeToMs, formatMs } = require('../src/srt');

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      console.error(`  ✗ ${name}`);
      console.error(err);
      process.exitCode = 1;
    });
}

function expectSrtError(fn, expectedLine, partOfMessage) {
  try {
    fn();
    assert.fail('应当抛出 SrtError');
  } catch (e) {
    assert.ok(e instanceof SrtError, `应是 SrtError，实际 ${e.constructor.name}`);
    assert.strictEqual(e.line, expectedLine, `行号应为 ${expectedLine}，实际 ${e.line}`);
    if (partOfMessage) {
      assert.ok(
        e.message.includes(partOfMessage),
        `错误信息应包含“${partOfMessage}”，实际：${e.message}`
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* SRT 解析/序列化单元测试                                             */
/* ------------------------------------------------------------------ */

function runUnitTests() {
  test('正常文件：多行文字、CRLF、BOM 都能解析', () => {
    const raw =
      '\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\n第一行\r\n第二行\r\n\r\n' +
      '2\r\n00:00:02,500 --> 00:00:03,000\r\n结尾相接可以\r\n';
    const cues = parseSrt(raw);
    assert.strictEqual(cues.length, 2);
    assert.strictEqual(cues[0].start_ms, 1000);
    assert.strictEqual(cues[0].end_ms, 2500);
    assert.strictEqual(cues[0].text, '第一行\n第二行');
    assert.strictEqual(cues[1].text, '结尾相接可以');
  });

  test('序号行格式错误，报出行号', () => {
    const raw = '1\n00:00:01,000 --> 00:00:02,000\n甲\n\n??\n00:00:03,000 --> 00:00:04,000\n乙\n';
    expectSrtError(() => parseSrt(raw), 5, '序号');
  });

  test('时间轴格式错误，报出时间轴所在行号', () => {
    const raw = '1\n00:00:01,000 -> 00:00:02,000\n甲\n';
    expectSrtError(() => parseSrt(raw), 2, '时间轴');
  });

  test('结束不晚于开始，报出行号', () => {
    const raw = '1\n00:00:05,000 --> 00:00:05,000\n甲\n';
    expectSrtError(() => parseSrt(raw), 2, '结束时间');
  });

  test('缺少字幕文字，报出行号', () => {
    const raw = '1\n00:00:01,000 --> 00:00:02,000\n\n2\n00:00:03,000 --> 00:00:04,000\n乙\n';
    expectSrtError(() => parseSrt(raw), 2, '文字');
  });

  test('整份文件内时间交叠，报出后一段序号所在行', () => {
    const raw =
      '1\n00:00:01,000 --> 00:00:03,000\n甲\n\n' +
      '2\n00:00:02,000 --> 00:00:04,000\n乙\n';
    expectSrtError(() => parseSrt(raw), 5, '交叠');
  });

  test('空文件报错', () => {
    expectSrtError(() => parseSrt('   \n\n'), 1, '没有任何字幕');
  });

  test('时间码换算与格式化', () => {
    assert.strictEqual(parseTimeToMs('01:02:03,456'), 3723456);
    assert.strictEqual(formatMs(3723456), '01:02:03,456');
    // 点号也接受
    assert.strictEqual(parseTimeToMs('00:00:00.500'), 500);
  });

  test('序列化按时间重新编号并保留多行换行', () => {
    const out = serializeSrt([
      { start_ms: 2000, end_ms: 3000, text: 'b 行1\nb 行2' },
      { start_ms: 1000, end_ms: 2000, text: 'a' },
    ]);
    const expected =
      '1\n00:00:01,000 --> 00:00:02,000\na\n\n' +
      '2\n00:00:02,000 --> 00:00:03,000\nb 行1\nb 行2\n';
    assert.strictEqual(out, expected);
  });
}

/* ------------------------------------------------------------------ */
/* HTTP 集成测试                                                       */
/* ------------------------------------------------------------------ */

const VALID_SRT =
  '1\r\n00:00:01,000 --> 00:00:02,000\r\n你好世界\r\n第二行\r\n\r\n' +
  '2\r\n00:00:02,000 --> 00:00:03,500\r\n第二段\r\n';

async function main() {
  console.log('SRT 解析单元测试：');
  runUnitTests();

  // 集成测试使用临时文件库（而非 :memory:），以覆盖快照落盘、
  // export() 后预编译语句失效重建、重启持久化等路径。
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-collab-test-'));
  process.env.DB_PATH = path.join(tmpDir, 'test.db');

  const { app, ready } = require('../src/server');
  await ready;
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  };

  console.log('\nHTTP 接口测试：');

  await test('非法 SRT 上传返回 422 与行号，且整份不入库', async () => {
    const bad = '1\n00:00:01,000 --> 00:00:02,000\n甲\n\n2\n00:00:02,000 --> 00:00:01,000\n乙\n';
    const r = await call('POST', '/api/works', { title: '坏文件', filename: 'bad.srt', content: bad });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error, 'invalid_srt');
    assert.strictEqual(r.json.line, 6);

    const list = await call('GET', '/api/works');
    assert.strictEqual(list.json.works.length, 0, '坏文件不应产生任何作品');
  });

  await test('合法 SRT 上传成功，修订号为 1', async () => {
    const r = await call('POST', '/api/works', { title: '测试片', filename: 'sample.srt', content: VALID_SRT });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    assert.strictEqual(r.json.revision, 1);
    assert.strictEqual(r.json.cue_count, 2);
  });

  let cueId;
  let cue2Id;
  await test('作品详情按时间顺序返回字幕段', async () => {
    const r = await call('GET', '/api/works/1');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.cues.length, 2);
    assert.strictEqual(r.json.cues[0].text, '你好世界\n第二行');
    assert.strictEqual(r.json.cues[0].idx, 1);
    cueId = r.json.cues[0].id;
    cue2Id = r.json.cues[1].id;
  });

  await test('携带正确修订号编辑：多行文字与时间可改，修订号变 2', async () => {
    // cue2 为 02.000–03.500，这里与它首尾相接，不构成交叠
    const r = await call('PUT', `/api/works/1/cues/${cueId}`, {
      revision: 1,
      start: '00:00:01,200',
      end: '00:00:02,000',
      text: '改后第一行\n改后第二行\n第三行',
      editor: '阿校对',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.revision, 2);
    assert.strictEqual(r.json.cue.start_ms, 1200);
    assert.strictEqual(r.json.cue.end_ms, 2000);
    assert.strictEqual(r.json.cue.text, '改后第一行\n改后第二行\n第三行');
  });

  await test('用过期修订号 1 再次编辑：409，返回最新修订号与目标字幕段', async () => {
    const r = await call('PUT', `/api/works/1/cues/${cueId}`, {
      revision: 1,
      start: '00:00:01,300',
      end: '00:00:02,000',
      text: '过期修改',
    });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.error, 'revision_stale');
    assert.strictEqual(r.json.latest_revision, 2);
    assert.strictEqual(r.json.cue.id, cueId);
    // 目标字幕段是服务器上的最新版本
    assert.strictEqual(r.json.cue.text, '改后第一行\n改后第二行\n第三行');
    assert.strictEqual(r.json.cue.start, '00:00:01,200');
  });

  await test('时间结束早于开始：422 拒绝，修订号与内容不变', async () => {
    const r = await call('PUT', `/api/works/1/cues/${cueId}`, {
      revision: 2,
      start: '00:00:05,000',
      end: '00:00:01,000',
      text: '改后第一行\n改后第二行\n第三行',
    });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error, 'invalid_range');

    const detail = await call('GET', '/api/works/1');
    assert.strictEqual(detail.json.work.revision, 2, '失败的编辑不应推进修订号');
    assert.strictEqual(detail.json.cues[0].start, '00:00:01,200');
  });

  await test('非法时间格式：400 拒绝', async () => {
    const r = await call('PUT', `/api/works/1/cues/${cueId}`, {
      revision: 2,
      start: '1秒',
      end: '00:00:02,000',
      text: 'x',
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error, 'invalid_time');
  });

  await test('与其他字幕段交叠：422 拒绝', async () => {
    // cue2 当前 02.000–03.500；把 cue1 改成 01.500–02.200 会与之交叠
    const r = await call('PUT', `/api/works/1/cues/${cueId}`, {
      revision: 2,
      start: '00:00:01,500',
      end: '00:00:02,200',
      text: '改后第一行\n改后第二行\n第三行',
    });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error, 'overlap');

    const detail = await call('GET', '/api/works/1');
    assert.strictEqual(detail.json.work.revision, 2);
    assert.strictEqual(detail.json.cues[0].start, '00:00:01,200');
  });

  await test('首尾相接（前一段结束==后一段开始）不算交叠，允许保存', async () => {
    // cue1 改为 00:00:01,200 -> 00:00:02,000，正好接上 cue2 的开始
    const r = await call('PUT', `/api/works/1/cues/${cueId}`, {
      revision: 2,
      start: '00:00:01,200',
      end: '00:00:02,000',
      text: '改后第一行\n改后第二行\n第三行',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.revision, 3);
  });

  await test('空文字被拒绝', async () => {
    const r = await call('PUT', `/api/works/1/cues/${cue2Id}`, {
      revision: 3,
      start: '00:00:02,000',
      end: '00:00:03,500',
      text: '   \n  ',
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error, 'invalid_text');
  });

  await test('并发两处相同修订号提交：恰好一个成功、另一个 409', async () => {
    const [a, b] = await Promise.all([
      call('PUT', `/api/works/1/cues/${cueId}`, {
        revision: 3,
        start: '00:00:01,200',
        end: '00:00:02,000',
        text: '并发编辑',
      }),
      call('PUT', `/api/works/1/cues/${cue2Id}`, {
        revision: 3,
        start: '00:00:02,000',
        end: '00:00:03,500',
        text: '第二处并发',
      }),
    ]);
    const ok = [a, b].filter((r) => r.status === 200);
    const conflicts = [a, b].filter((r) => r.status === 409);
    assert.strictEqual(ok.length, 1, `应有一个成功，实际 ${ok.length}：${JSON.stringify([a.json, b.json])}`);
    assert.strictEqual(conflicts.length, 1, '应有一个 409 冲突');
    assert.strictEqual(conflicts[0].json.latest_revision, 4);
  });

  await test('导出标准 SRT：按时间重新编号，换行保留，带 UTF-8 BOM', async () => {
    const res = await fetch(base + '/api/works/1/export');
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('x-subrip'));
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, '应以 BOM 开头');
    const body = buf.toString('utf8').replace(/^\uFEFF/, '');
    const lines = body.replace(/\r\n?/g, '\n').split('\n');
    // 编号从 1 连续递增
    assert.strictEqual(lines[0], '1');
    assert.ok(lines.some((l) => l === '2'));
    // 多行文字换行仍在（并发测试中恰好一处保存成功）
    assert.ok(
      body.includes('改后第一行\n改后第二行\n第三行') ||
        body.includes('并发编辑') ||
        body.includes('第二处并发'),
      '导出内容应包含多行文字换行'
    );
  });

  /* ---------------- 批量时间轴平移 ---------------- */

  // 新作品，各段时长/间隙不同，便于区分“交叠”与“首尾相接”：
  // #1 1000-2000  #2 3000-4000  #3 5000-7000  #4 9000-10000
  const SHIFT_SRT =
    '1\n00:00:01,000 --> 00:00:02,000\n甲\n\n' +
    '2\n00:00:03,000 --> 00:00:04,000\n乙\n\n' +
    '3\n00:00:05,000 --> 00:00:07,000\n丙\n\n' +
    '4\n00:00:09,000 --> 00:00:10,000\n丁\n';
  let shiftWorkId;
  let sIds = {};
  const byIdx = (cues, i) => cues.find((c) => c.idx === i);

  await test('批量：上传测试作品（4 段，带间隙）', async () => {
    const r = await call('POST', '/api/works', { title: '批量片', filename: 'shift.srt', content: SHIFT_SRT });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    assert.strictEqual(r.json.revision, 1);
    shiftWorkId = r.json.id;
    const d = await call('GET', `/api/works/${shiftWorkId}`);
    [1, 2, 3, 4].forEach((i) => {
      sIds[i] = byIdx(d.json.cues, i).id;
    });
  });

  await test('批量预览：合法后移 1000ms，返回调整前后时间，无碰撞，valid=true', async () => {
    const r = await call('POST', `/api/works/${shiftWorkId}/cues/shift/preview`, {
      revision: 1,
      cue_ids: [sIds[2]],
      offset_ms: 1000,
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.valid, true);
    assert.strictEqual(r.json.expected_revision, 1);
    assert.deepStrictEqual(r.json.issues, []);
    const c = r.json.cues[0];
    assert.strictEqual(c.start, '00:00:03,000');
    assert.strictEqual(c.new_start, '00:00:04,000');
    assert.strictEqual(c.new_end, '00:00:05,000');
    assert.deepStrictEqual(c.collisions, []);
  });

  await test('批量预览：前移导致负起点，valid=false 并指出该段', async () => {
    const r = await call('POST', `/api/works/${shiftWorkId}/cues/shift/preview`, {
      revision: 1,
      cue_ids: [sIds[1]],
      offset_ms: -1500,
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.valid, false);
    assert.strictEqual(r.json.issues[0].type, 'negative_start');
    assert.deepStrictEqual(r.json.issues[0].cue_ids, [sIds[1]]);
    assert.strictEqual(r.json.cues[0].new_start_ms, -500);
  });

  await test('批量预览：后移撞上下一段，碰撞对象含未选段 #3', async () => {
    const r = await call('POST', `/api/works/${shiftWorkId}/cues/shift/preview`, {
      revision: 1,
      cue_ids: [sIds[2]],
      offset_ms: 1500, // 3000-4000 -> 4500-5500，与 #3 的 5000-7000 交叠
    });
    assert.strictEqual(r.json.valid, false);
    const issue = r.json.issues.find((x) => x.type === 'overlap');
    assert.ok(issue, '应有交叠问题');
    assert.ok(issue.cue_ids.includes(sIds[2]) && issue.cue_ids.includes(sIds[3]));
    const entry = r.json.cues[0];
    assert.strictEqual(entry.collisions.length, 1);
    assert.strictEqual(entry.collisions[0].id, sIds[3]);
    assert.strictEqual(entry.collisions[0].selected, false);
  });

  await test('批量预览：首尾相接（新起点 == 邻段结束）允许，valid=true', async () => {
    // #4 9000-10000 前移 2000ms -> 7000-8000，新起点 7000 正好等于 #3 结束
    const r = await call('POST', `/api/works/${shiftWorkId}/cues/shift/preview`, {
      revision: 1,
      cue_ids: [sIds[4]],
      offset_ms: -2000,
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.valid, true);
    assert.deepStrictEqual(r.json.cues[0].collisions, []);
  });

  await test('批量确认：多段同量平移 + 重排序号，单事务修订号只 +1', async () => {
    // #3 5000-7000 -> 6000-8000（接 #4 起点 9000，不撞）
    // #1 1000-2000 -> 2000-3000（接 #2 起点 3000）；#1 与 #3 交换展示顺序
    const r = await call('POST', `/api/works/${shiftWorkId}/cues/shift`, {
      revision: 1,
      cue_ids: [sIds[1], sIds[3]],
      offset_ms: 1000,
      editor: '排片同学',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.revision, 2, '整批只应增加一次修订号');
    assert.strictEqual(r.json.shifted_count, 2);

    // 返回的是按新时间重排的全部段
    const starts = r.json.cues.map((c) => c.start);
    assert.deepStrictEqual(starts, [
      '00:00:02,000', // 原 #1 甲
      '00:00:03,000', // #2 乙未选
      '00:00:06,000', // 原 #3 丙
      '00:00:09,000', // #4 丁未选
    ]);
    r.json.cues.forEach((c, i) => assert.strictEqual(c.idx, i + 1, '展示序号应从 1 连续重排'));

    // 文字与段标识不变：原 #1（id 不变）仍是“甲”，原 #3 仍是“丙”
    const c1 = r.json.cues.find((c) => c.id === sIds[1]);
    const c3 = r.json.cues.find((c) => c.id === sIds[3]);
    assert.strictEqual(c1.text, '甲');
    assert.strictEqual(c3.text, '丙');
    assert.strictEqual(c1.start_ms, 2000);
    assert.strictEqual(c1.end_ms, 3000);
    assert.strictEqual(c3.start_ms, 6000);
    assert.strictEqual(c3.end_ms, 8000);
  });

  await test('批量确认后导出 SRT 按新时间排序编号', async () => {
    const res = await fetch(base + `/api/works/${shiftWorkId}/export`);
    const body = (await res.text()).replace(/^﻿/, '');
    assert.ok(body.startsWith('1\n00:00:02,000'), body.slice(0, 60));
    assert.ok(body.includes('2\n00:00:03,000 --> 00:00:04,000\n乙'));
    assert.ok(/3\n00:00:06,000 --> 00:00:08,000\n丙/.test(body), '原 #3（丙）按新时间排到第 3 条');
    assert.ok(/4\n00:00:09,000 --> 00:00:10,000\n丁/.test(body));
  });

  await test('批量确认：会交叠的批次 422 整批拒绝，修订号与全部时间不变', async () => {
    // rev2 时间线：甲 2000-3000、乙 3000-4000、丙 6000-8000、丁 9000-10000
    // 乙 +1500 -> 4500-5500，落在乙、丙之间的间隙（4000-6000），合法 -> rev3
    const fit = await call('POST', `/api/works/${shiftWorkId}/cues/shift`, {
      revision: 2,
      cue_ids: [sIds[2]],
      offset_ms: 1500,
    });
    assert.strictEqual(fit.status, 200, JSON.stringify(fit.json));
    assert.strictEqual(fit.json.revision, 3);

    // rev3：乙已在 4500-5500；乙再 +2500 -> 7000-8000，与丙 6000-8000 交叠
    const bad = await call('POST', `/api/works/${shiftWorkId}/cues/shift`, {
      revision: 3,
      cue_ids: [sIds[2]],
      offset_ms: 2500,
    });
    assert.strictEqual(bad.status, 422);
    assert.strictEqual(bad.json.error, 'shift_rejected');
    assert.ok(bad.json.issues.some((x) => x.type === 'overlap'));
    assert.ok(bad.json.issues[0].cues.some((c) => c.id === sIds[2]));

    const d = await call('GET', `/api/works/${shiftWorkId}`);
    assert.strictEqual(d.json.work.revision, 3, '被拒绝的批量调整不应推进修订号');
    const yi = byIdx(d.json.cues, 2);
    assert.strictEqual(yi.start, '00:00:04,500'); // 前一次合法平移的结果保留
  });

  await test('批量确认：负起点 422 拒绝', async () => {
    const r = await call('POST', `/api/works/${shiftWorkId}/cues/shift`, {
      revision: 3,
      cue_ids: [sIds[1]], // 甲当前 2000-3000
      offset_ms: -3000,
    });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.issues[0].type, 'negative_start');
    const d = await call('GET', `/api/works/${shiftWorkId}`);
    assert.strictEqual(d.json.work.revision, 3);
  });

  await test('批量确认：预览后作品被单段编辑改动 -> 409 返回最新修订号，不写入', async () => {
    // rev3 时间线：甲 2000-3000、乙 4500-5500、丙 6000-8000、丁 9000-10000
    const before = await call('GET', `/api/works/${shiftWorkId}`);
    const yi = byIdx(before.json.cues, 2);
    assert.strictEqual(yi.start, '00:00:04,500');

    const preview = await call('POST', `/api/works/${shiftWorkId}/cues/shift/preview`, {
      revision: 3,
      cue_ids: [sIds[4]], // 丁 9000-10000
      offset_ms: -500,
    });
    assert.strictEqual(preview.status, 200);
    assert.strictEqual(preview.json.valid, true);

    // 他人改动同一作品：修订号推进到 4
    const other = await call('PUT', `/api/works/${shiftWorkId}/cues/${sIds[1]}`, {
      revision: 3,
      start: '00:00:02,000',
      end: '00:00:02,500',
      text: '甲被别人改短',
      editor: '别人',
    });
    assert.strictEqual(other.status, 200, JSON.stringify(other.json));

    // 仍按旧预览的修订号 3 确认 -> 409
    const confirm = await call('POST', `/api/works/${shiftWorkId}/cues/shift`, {
      revision: 3,
      cue_ids: [sIds[4]],
      offset_ms: -500,
    });
    assert.strictEqual(confirm.status, 409);
    assert.strictEqual(confirm.json.error, 'revision_stale');
    assert.strictEqual(confirm.json.latest_revision, 4);

    const after = await call('GET', `/api/works/${shiftWorkId}`);
    assert.strictEqual(after.json.work.revision, 4);
    const ding = after.json.cues.find((c) => c.id === sIds[4]);
    assert.strictEqual(ding.start, '00:00:09,000', '丁不应被过期预览写入');
  });

  await test('批量：空选择、重复段、不存在段、非整数偏移均报错', async () => {
    const base_ = `/api/works/${shiftWorkId}/cues/shift`;
    const empty = await call('POST', `${base_}/preview`, { revision: 4, cue_ids: [], offset_ms: 100 });
    assert.strictEqual(empty.status, 400);
    assert.strictEqual(empty.json.error, 'empty_selection');

    const dup = await call('POST', `${base_}/preview`, { revision: 4, cue_ids: [sIds[1], sIds[1]], offset_ms: 100 });
    assert.strictEqual(dup.status, 400);
    assert.strictEqual(dup.json.error, 'duplicate_cue');

    const notFound = await call('POST', `${base_}/preview`, { revision: 4, cue_ids: [999999], offset_ms: 100 });
    assert.strictEqual(notFound.status, 404);
    assert.strictEqual(notFound.json.error, 'cue_not_found');

    for (const bad of [1.5, '1.5', 'abc', null, {}, true]) {
      const r = await call('POST', `${base_}/preview`, { revision: 4, cue_ids: [sIds[1]], offset_ms: bad });
      assert.strictEqual(r.status, 400, `偏移量 ${JSON.stringify(bad)} 应被拒绝`);
      assert.strictEqual(r.json.error, 'invalid_offset');
    }
  });

  await test('批量：整数字符串偏移与 0 偏移接受；不选非数组报错', async () => {
    const base_ = `/api/works/${shiftWorkId}/cues/shift`;
    const str = await call('POST', `${base_}/preview`, { revision: 4, cue_ids: [sIds[2]], offset_ms: '-500' });
    assert.strictEqual(str.status, 200, JSON.stringify(str.json));
    assert.strictEqual(str.json.offset_ms, -500);

    const zero = await call('POST', `${base_}/preview`, { revision: 4, cue_ids: [sIds[2]], offset_ms: 0 });
    assert.strictEqual(zero.status, 200);
    assert.strictEqual(zero.json.valid, true);

    const noArr = await call('POST', `${base_}/preview`, { revision: 4, cue_ids: sIds[2], offset_ms: 0 });
    assert.strictEqual(noArr.status, 400);
    assert.strictEqual(noArr.json.error, 'invalid_selection');
  });

  /* ---------------- 待审提案（多人校订） ---------------- */

  // 提案作品：#1 1-2s  #2 3-4s  #3 5-6s  #4 7-8s
  const PROP_SRT =
    '1\n00:00:01,000 --> 00:00:02,000\n原一\n\n' +
    '2\n00:00:03,000 --> 00:00:04,000\n原二\n\n' +
    '3\n00:00:05,000 --> 00:00:06,000\n原三\n\n' +
    '4\n00:00:07,000 --> 00:00:08,000\n原四\n';
  let propWorkId;
  let pIds = {};
  let firstProposalId;

  await test('提案：上传测试作品（4 段，修订号 1）', async () => {
    const r = await call('POST', '/api/works', { title: '提案片', filename: 'prop.srt', content: PROP_SRT });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    propWorkId = r.json.id;
    const d = await call('GET', `/api/works/${propWorkId}`);
    [1, 2, 3, 4].forEach((i) => {
      pIds[i] = byIdx(d.json.cues, i).id;
    });
  });

  await test('提案：携带页面修订号提交候选，201 且保存原段快照', async () => {
    const r = await call('POST', `/api/works/${propWorkId}/proposals`, {
      revision: 1,
      cue_id: pIds[1],
      start: '00:00:01,000',
      end: '00:00:02,000',
      text: '候选一\n第二行',
      note: '听录修正',
      submitter: '提交人甲',
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    assert.strictEqual(r.json.revision, 1, '提交时返回页面所依据修订号');
    const p = r.json.proposal;
    firstProposalId = p.id;
    assert.strictEqual(p.status, 'open');
    assert.strictEqual(p.base_revision, 1);
    assert.strictEqual(p.cue_id, pIds[1]);
    assert.deepStrictEqual(p.original, {
      start_ms: 1000, end_ms: 2000, start: '00:00:01,000', end: '00:00:02,000', text: '原一',
    });
    assert.strictEqual(p.candidate.text, '候选一\n第二行');
    assert.strictEqual(p.current.text, '原一');
    assert.strictEqual(p.target_changed, false);
    assert.deepStrictEqual(p.conflicts, []);
  });

  await test('提案：提交不改变正式段、作品修订号与导出', async () => {
    const d = await call('GET', `/api/works/${propWorkId}`);
    assert.strictEqual(d.json.work.revision, 1);
    assert.strictEqual(d.json.work.open_proposals, 1);
    assert.strictEqual(d.json.cues[0].text, '原一');
    assert.strictEqual(d.json.cues[0].start, '00:00:01,000');
    const body = await (await fetch(base + `/api/works/${propWorkId}/export`)).text();
    assert.ok(body.includes('原一'), '导出仍为正式段原文');
    assert.ok(!body.includes('候选一'), '候选文字不得进入导出');
  });

  await test('提案：修订号过期拒绝且不生成提案（409 带最新值）', async () => {
    // 先制造一次正式修改把修订号推到 2
    const edit = await call('PUT', `/api/works/${propWorkId}/cues/${pIds[4]}`, {
      revision: 1,
      start: '00:00:07,000',
      end: '00:00:08,500',
      text: '原四加长',
    });
    assert.strictEqual(edit.status, 200);
    const r = await call('POST', `/api/works/${propWorkId}/proposals`, {
      revision: 1, // 过期
      cue_id: pIds[1],
      start: '00:00:01,000',
      end: '00:00:02,000',
      text: '过期候选',
    });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.error, 'revision_stale');
    assert.strictEqual(r.json.latest_revision, 2);
    const list = await call('GET', `/api/works/${propWorkId}/proposals`);
    assert.strictEqual(list.json.proposals.length, 1, '过期提交不得新增提案');
    assert.ok(!list.json.proposals.some((p) => p.candidate.text === '过期候选'));
  });

  await test('提案：候选内容非法（格式/负时间/区间/空文字/段不存在）均拒绝且不生成', async () => {
    const url = `/api/works/${propWorkId}/proposals`;
    const baseBody = { revision: 2, cue_id: pIds[1] };
    const badTime = await call('POST', url, { ...baseBody, start: '1秒', end: '00:00:02,000', text: 'x' });
    assert.strictEqual(badTime.status, 400);
    assert.strictEqual(badTime.json.error, 'invalid_time');
    const negative = await call('POST', url, { ...baseBody, start: '-00:00:01,000', end: '00:00:02,000', text: 'x' });
    // 负号不属于合法时间码 -> 格式 400
    assert.ok(negative.status === 400 || negative.status === 422, JSON.stringify(negative.json));
    const range = await call('POST', url, { ...baseBody, start: '00:00:03,000', end: '00:00:02,000', text: 'x' });
    assert.strictEqual(range.status, 422);
    assert.strictEqual(range.json.error, 'invalid_range');
    const empty = await call('POST', url, { ...baseBody, start: '00:00:01,000', end: '00:00:02,000', text: '   ' });
    assert.strictEqual(empty.status, 400);
    assert.strictEqual(empty.json.error, 'invalid_text');
    const noCue = await call('POST', url, { revision: 2, cue_id: 999999, start: '00:00:01,000', end: '00:00:02,000', text: 'x' });
    assert.strictEqual(noCue.status, 404);
    assert.strictEqual(noCue.json.error, 'cue_not_found');
    const list = await call('GET', url);
    assert.strictEqual(list.json.proposals.length, 1, '所有非法提交都不得生成提案');
  });

  await test('提案：驳回只结案，正式段与修订号不变；已结案不可再处理', async () => {
    const r = await call('POST', `/api/works/${propWorkId}/proposals/${firstProposalId}/reject`, {
      reviewer: '审阅人乙',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.proposal.status, 'rejected');
    assert.strictEqual(r.json.proposal.reviewer, '审阅人乙');

    const d = await call('GET', `/api/works/${propWorkId}`);
    assert.strictEqual(d.json.work.revision, 2, '驳回不推进修订号');
    assert.strictEqual(d.json.cues[0].text, '原一');
    assert.strictEqual(d.json.work.open_proposals, 0);

    const againReject = await call('POST', `/api/works/${propWorkId}/proposals/${firstProposalId}/reject`, {});
    assert.strictEqual(againReject.status, 409);
    assert.strictEqual(againReject.json.error, 'proposal_closed');
    const acceptClosed = await call('POST', `/api/works/${propWorkId}/proposals/${firstProposalId}/accept`, {});
    assert.strictEqual(acceptClosed.status, 409);
    assert.strictEqual(acceptClosed.json.error, 'proposal_closed');
  });

  await test('提案：采纳成功——更新正式段、修订号 +1、重排序号', async () => {
    // 新候选：#1 原 1-2s 改到 8.5-9.5s（不与加长后的 #4 7-8.5s 交叠，首尾留间隙），
    // 采纳后该段应重排到最后（idx=4）
    const created = await call('POST', `/api/works/${propWorkId}/proposals`, {
      revision: 2,
      cue_id: pIds[1],
      start: '00:00:08,500',
      end: '00:00:09,500',
      text: '原一移到最后',
      note: '时间轴整体错位',
      submitter: '提交人甲',
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.json));
    const pid = created.json.proposal.id;

    const r = await call('POST', `/api/works/${propWorkId}/proposals/${pid}/accept`, {
      reviewer: '审阅人乙',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.revision, 3);
    assert.strictEqual(r.json.proposal.status, 'accepted');
    assert.strictEqual(r.json.cue.id, pIds[1]);
    assert.strictEqual(r.json.cue.start, '00:00:08,500');
    assert.strictEqual(r.json.cue.end, '00:00:09,500');
    assert.strictEqual(r.json.cue.text, '原一移到最后');
    assert.strictEqual(r.json.cue.idx, 4, '应按新时间重排为第 4 段');

    const d = await call('GET', `/api/works/${propWorkId}`);
    assert.strictEqual(d.json.work.revision, 3);
    assert.deepStrictEqual(d.json.cues.map((c) => c.text), ['原二', '原三', '原四加长', '原一移到最后']);
    d.json.cues.forEach((c, i) => assert.strictEqual(c.idx, i + 1));
  });

  await test('提案：其他段的修改不阻止采纳（只比对目标段快照）', async () => {
    // rev3 时间线：原二 3-4、原三 5-6、原四加长 7-8.5、原一移到最后 8.5-9.5
    // 针对 #2（原二，自 rev3 起未被改动）在 rev2 视角之外提交候选——此时修订号 3
    const created = await call('POST', `/api/works/${propWorkId}/proposals`, {
      revision: 3,
      cue_id: pIds[2],
      start: '00:00:03,000',
      end: '00:00:04,200',
      text: '原二改字',
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.json));
    const pid = created.json.proposal.id;

    // 他人修改了“其他段” #3，修订号推进到 4
    const other = await call('PUT', `/api/works/${propWorkId}/cues/${pIds[3]}`, {
      revision: 3,
      start: '00:00:05,000',
      end: '00:00:06,500',
      text: '原三别人改',
    });
    assert.strictEqual(other.status, 200, JSON.stringify(other.json));

    // 候选结束 4.2 < 原三起点 5，无交叠；目标段 #2 未变，采纳成功
    const r = await call('POST', `/api/works/${propWorkId}/proposals/${pid}/accept`, {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.revision, 5);
    assert.strictEqual(r.json.cue.text, '原二改字');
  });

  await test('提案：目标段已变 -> 409 保留待审，返回当前段，不写入', async () => {
    // rev5：#3 已为 5-6.5 “原三别人改”。就 #3 当前值提交一个候选
    const created = await call('POST', `/api/works/${propWorkId}/proposals`, {
      revision: 5,
      cue_id: pIds[3],
      start: '00:00:05,000',
      end: '00:00:06,500',
      text: '原三候选A',
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.json));
    const pid = created.json.proposal.id;

    // 目标段被直接保存改动（结束 6.5 -> 6.8），修订号到 6
    const edit = await call('PUT', `/api/works/${propWorkId}/cues/${pIds[3]}`, {
      revision: 5,
      start: '00:00:05,000',
      end: '00:00:06,800',
      text: '原三别人又改',
    });
    assert.strictEqual(edit.status, 200);

    const r = await call('POST', `/api/works/${propWorkId}/proposals/${pid}/accept`, {});
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.error, 'target_changed');
    assert.strictEqual(r.json.latest_revision, 6);
    assert.strictEqual(r.json.proposal.status, 'open', '目标已变时提案必须保留待审');
    assert.strictEqual(r.json.proposal.target_changed, true);
    assert.strictEqual(r.json.proposal.current.text, '原三别人又改');
    assert.strictEqual(r.json.proposal.current.end, '00:00:06,800');
    assert.ok(r.json.issues.some((i) => i.type === 'target_changed'));

    const d = await call('GET', `/api/works/${propWorkId}`);
    assert.strictEqual(d.json.work.revision, 6, '冲突采纳不得推进修订号');
    assert.strictEqual(d.json.cues.find((c) => c.id === pIds[3]).text, '原三别人又改');
    assert.strictEqual(d.json.work.open_proposals, 1);
  });

  await test('提案：当前产生交叠 -> 422 保留待审并指出冲突段，不写入；障碍移除后可采纳', async () => {
    // rev6 时间线：原二改字 3-4.2、原三别人又改 5-6.8、原四加长 7-8.5、原一移到最后 8.5-9.5
    // 对 #2 提交候选：移到 6000-6500（提交时与 #3 5-6.8 交叠，但提交只校验内容本身，允许进入待审）
    const created = await call('POST', `/api/works/${propWorkId}/proposals`, {
      revision: 6,
      cue_id: pIds[2],
      start: '00:00:06,000',
      end: '00:00:06,500',
      text: '原二想插进六点',
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.json));
    const pid = created.json.proposal.id;
    assert.strictEqual(created.json.proposal.conflicts[0].id, pIds[3], '列表即标出当前冲突段 #3');

    const r = await call('POST', `/api/works/${propWorkId}/proposals/${pid}/accept`, {});
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.json.error, 'accept_rejected');
    assert.ok(r.json.issues.some((i) => i.type === 'overlap'));
    assert.deepStrictEqual(r.json.issues.find((i) => i.type === 'overlap').cue_ids, [pIds[2], pIds[3]]);
    assert.strictEqual(r.json.proposal.status, 'open');
    const before = await call('GET', `/api/works/${propWorkId}`);
    assert.strictEqual(before.json.work.revision, 6, '交叠采纳不得推进修订号');
    assert.strictEqual(before.json.cues.find((c) => c.id === pIds[2]).text, '原二改字', '正式段不写入');

    // 把障碍段 #3 挪开（5-5.5，与候选 6-6.5 首尾留间隙），修订号到 7；目标段 #2 未变
    const move = await call('PUT', `/api/works/${propWorkId}/cues/${pIds[3]}`, {
      revision: 6,
      start: '00:00:05,000',
      end: '00:00:05,500',
      text: '原三别人又改',
    });
    assert.strictEqual(move.status, 200);

    const ok = await call('POST', `/api/works/${propWorkId}/proposals/${pid}/accept`, {});
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
    assert.strictEqual(ok.json.revision, 8);
    assert.strictEqual(ok.json.cue.start, '00:00:06,000');
    assert.strictEqual(ok.json.cue.text, '原二想插进六点');
  });

  await test('提案：同段两条待审，采纳其一后另一条目标已变不可采纳', async () => {
    // rev8：#4（原四加长 7-8.5）提交两条候选
    const a = await call('POST', `/api/works/${propWorkId}/proposals`, {
      revision: 8, cue_id: pIds[4], start: '00:00:07,000', end: '00:00:08,500', text: '原四候选甲',
    });
    const b = await call('POST', `/api/works/${propWorkId}/proposals`, {
      revision: 8, cue_id: pIds[4], start: '00:00:07,000', end: '00:00:08,000', text: '原四候选乙',
    });
    assert.strictEqual(a.status, 201);
    assert.strictEqual(b.status, 201);

    const acceptA = await call('POST', `/api/works/${propWorkId}/proposals/${a.json.proposal.id}/accept`, {});
    assert.strictEqual(acceptA.status, 200);
    assert.strictEqual(acceptA.json.revision, 9);

    const acceptB = await call('POST', `/api/works/${propWorkId}/proposals/${b.json.proposal.id}/accept`, {});
    assert.strictEqual(acceptB.status, 409);
    assert.strictEqual(acceptB.json.error, 'target_changed');
    assert.strictEqual(acceptB.json.proposal.status, 'open', '未采纳的另一条仍保留待审');
    assert.strictEqual(acceptB.json.proposal.current.text, '原四候选甲');
  });

  await test('提案：列表支持仅待审/全部；并列返回原值候选值当前值', async () => {
    const open = await call('GET', `/api/works/${propWorkId}/proposals`);
    assert.strictEqual(open.status, 200);
    assert.ok(open.json.proposals.every((p) => p.status === 'open'));
    assert.strictEqual(open.json.open_count, open.json.proposals.length);

    const all = await call('GET', `/api/works/${propWorkId}/proposals?status=all`);
    assert.ok(all.json.proposals.length >= open.json.proposals.length);
    assert.ok(all.json.proposals.some((p) => p.status === 'accepted'));
    assert.ok(all.json.proposals.some((p) => p.status === 'rejected'));
    const sample = all.json.proposals.find((p) => p.status === 'accepted');
    assert.ok(sample.original && sample.candidate && sample.current, '三值并列');
  });

  await test('提案：删除作品级联清除其全部提案', async () => {
    const list = await call('GET', `/api/works/${propWorkId}/proposals?status=all`);
    assert.ok(list.json.proposals.length > 0);
    const del = await call('DELETE', `/api/works/${propWorkId}`);
    assert.strictEqual(del.status, 200);
    const after = await call('GET', `/api/works/${propWorkId}/proposals`);
    assert.strictEqual(after.status, 404);
  });

  await test('持久化：用 openDb 重新打开文件，数据与修订号都在', async () => {
    const { openDb } = require('../src/db');
    const db2 = await openDb(process.env.DB_PATH);
    const w = db2.prepare('SELECT title, revision FROM works WHERE id = ?').get(1);
    assert.ok(w, '重开后应能读到作品');
    assert.ok(w.revision >= 4, `修订号应为并发后的 >=4，实际 ${w.revision}`);
    const n = db2.prepare('SELECT COUNT(*) AS n FROM cues WHERE work_id = ?').get(1);
    assert.strictEqual(n.n, 2);
  });

  await test('删除作品后列表与详情都消失', async () => {
    const r = await call('DELETE', '/api/works/1');
    assert.strictEqual(r.status, 200);
    const detail = await call('GET', '/api/works/1');
    assert.strictEqual(detail.status, 404);
  });

  await new Promise((resolve) => server.close(resolve));

  if (process.exitCode) {
    console.log(`\n有失败用例；通过 ${passed} 个。`);
  } else {
    console.log(`\n全部 ${passed} 个用例通过。`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
