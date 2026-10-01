'use strict';

/* 字幕校订台前端：无框架，直接操作 DOM。 */

const $ = (sel) => document.querySelector(sel);

const state = {
  works: [],
  current: null, // { work, cues, dirty:Set<cueId>, selection:Set<cueId> }
  editor: localStorage.getItem('srt-editor') || '',
  // 最近一次批量平移预览：{ revision, offsetMs, cueIds, valid, stale }
  shiftPreview: null,
};

$('#editor-name').value = state.editor;
$('#editor-name').addEventListener('input', (e) => {
  state.editor = e.target.value.trim();
  localStorage.setItem('srt-editor', state.editor);
});

/* ------------------------------------------------------------------ */
/* API 封装                                                            */
/* ------------------------------------------------------------------ */

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    const err = new Error((data && data.message) || `请求失败（${res.status}）`);
    err.status = res.status;
    err.data = data || {};
    throw err;
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* 上传                                                                */
/* ------------------------------------------------------------------ */

$('#upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#upload-msg');
  msg.className = 'msg';
  msg.textContent = '读取文件中…';

  const title = $('#work-title').value.trim();
  const file = $('#srt-file').files[0];
  if (!title || !file) {
    msg.className = 'msg error';
    msg.textContent = '请填写标题并选择 .srt 文件';
    return;
  }

  let content;
  try {
    const buf = await file.arrayBuffer();
    // fatal: true 让非 UTF-8 字节直接报错，而不是静默变成替换符
    content = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (_) {
    msg.className = 'msg error';
    msg.textContent =
      '该文件不是合法 UTF-8 编码（读取到非法字节）。\n请用文本编辑器另存为 UTF-8 后重新上传。';
    return;
  }

  try {
    const r = await api('POST', '/api/works', {
      title,
      filename: file.name,
      content,
    });
    msg.className = 'msg ok';
    msg.textContent = `校验通过，已导入 ${r.cue_count} 段（修订号 ${r.revision}）`;
    $('#work-title').value = '';
    $('#srt-file').value = '';
    await loadWorks();
    await openWork(r.id);
  } catch (err) {
    msg.className = 'msg error';
    if (err.data && err.data.error === 'invalid_srt') {
      msg.textContent =
        `文件未通过校验，整份文件没有入库。\n第 ${err.data.line} 行：${err.data.message}`;
    } else {
      msg.textContent = err.message;
    }
  }
});

/* ------------------------------------------------------------------ */
/* 作品列表                                                            */
/* ------------------------------------------------------------------ */

async function loadWorks() {
  const r = await api('GET', '/api/works');
  state.works = r.works;
  const ul = $('#work-list');
  ul.innerHTML = '';

  if (state.works.length === 0) {
    const li = document.createElement('li');
    li.className = 's';
    li.textContent = '暂无作品';
    ul.appendChild(li);
    return;
  }

  for (const w of state.works) {
    const li = document.createElement('li');
    if (state.current && state.current.work.id === w.id) li.classList.add('active');

    const t = document.createElement('div');
    t.className = 't';
    t.textContent = w.title;
    const s = document.createElement('div');
    s.className = 's';
    s.textContent = `${w.cue_count} 段 · 修订 ${w.revision}`;
    li.append(t, s);
    li.addEventListener('click', () => openWork(w.id));
    ul.appendChild(li);
  }
}

$('#refresh-list').addEventListener('click', loadWorks);

/* ------------------------------------------------------------------ */
/* 打开作品、渲染字幕表                                                */
/* ------------------------------------------------------------------ */

async function openWork(id) {
  const r = await api('GET', `/api/works/${id}`);
  state.current = { work: r.work, cues: r.cues, dirty: new Set(), selection: new Set() };
  state.shiftPreview = null;

  $('#empty-view').hidden = true;
  $('#work-view').hidden = false;
  $('#stale-banner').hidden = true;
  $('#shift-panel').hidden = true;
  $('#shift-offset').value = '';
  $('#shift-select-all').checked = false;

  $('#work-title-display').textContent = r.work.title;
  $('#work-filename').textContent = r.work.filename;
  $('#work-revision').textContent = r.work.revision;
  $('#cue-count').textContent = r.cues.length;
  $('#work-updated').textContent = r.work.updated_at;
  $('#export-link').href = `/api/works/${id}/export`;

  renderCues();
  updateShiftCount();
  await loadWorks();
}

function renderCues() {
  const tbody = $('#cue-tbody');
  tbody.innerHTML = '';

  for (const cue of state.current.cues) {
    const tr = document.createElement('tr');
    tr.dataset.cueId = cue.id;

    // 批量平移勾选
    const pickTd = document.createElement('td');
    pickTd.className = 'col-pick';
    const pick = document.createElement('input');
    pick.type = 'checkbox';
    pick.className = 'cue-pick';
    pick.addEventListener('change', () => {
      if (pick.checked) state.current.selection.add(cue.id);
      else state.current.selection.delete(cue.id);
      tr.classList.toggle('picked', pick.checked);
      invalidateShiftPreview();
      updateShiftCount();
    });
    pickTd.appendChild(pick);

    const idxTd = document.createElement('td');
    idxTd.className = 'col-idx';
    idxTd.textContent = cue.idx;

    // 开始时间
    const startTd = document.createElement('td');
    const startInput = document.createElement('input');
    startInput.type = 'text';
    startInput.value = cue.start;
    startInput.spellcheck = false;
    startInput.dataset.field = 'start';
    startTd.appendChild(startInput);

    // 结束时间
    const endTd = document.createElement('td');
    const endInput = document.createElement('input');
    endInput.type = 'text';
    endInput.value = cue.end;
    endInput.spellcheck = false;
    endInput.dataset.field = 'end';
    endTd.appendChild(endInput);

    // 文字（多行）
    const textTd = document.createElement('td');
    const ta = document.createElement('textarea');
    ta.value = cue.text;
    ta.rows = String(cue.text).split('\n').length;
    ta.dataset.field = 'text';
    ta.addEventListener('input', () => {
      ta.rows = Math.max(1, ta.value.split('\n').length);
      markDirty(tr, cue);
    });
    textTd.appendChild(ta);

    const rowMsg = document.createElement('span');
    rowMsg.className = 'row-msg';
    textTd.appendChild(rowMsg);

    // 保存
    const saveTd = document.createElement('td');
    const saveBtn = document.createElement('button');
    saveBtn.className = 'save-btn';
    saveBtn.textContent = '保存';
    saveBtn.addEventListener('click', () =>
      saveCue(tr, cue, { startInput, endInput, ta, rowMsg, saveBtn })
    );
    saveTd.appendChild(saveBtn);

    const onEdit = () => markDirty(tr, cue);
    startInput.addEventListener('input', onEdit);
    endInput.addEventListener('input', onEdit);

    tr.append(pickTd, idxTd, startTd, endTd, textTd, saveTd);
    tbody.appendChild(tr);
  }
}

function markDirty(tr, cue) {
  state.current.dirty.add(cue.id);
  tr.classList.add('edited');
}

function clearDirty(tr, cue) {
  state.current.dirty.delete(cue.id);
  tr.classList.remove('edited', 'row-err');
}

$('#reload-work').addEventListener('click', async () => {
  if (!state.current) return;
  if (
    state.current.dirty.size > 0 &&
    !confirm('有尚未保存的修改，重新载入将丢弃它们。确定继续？')
  ) {
    return;
  }
  await openWork(state.current.work.id);
});

$('#stale-reload').addEventListener('click', () => openWork(state.current.work.id));

$('#delete-work').addEventListener('click', async () => {
  if (!state.current) return;
  const { work } = state.current;
  if (!confirm(`确定删除作品「${work.title}」及其全部 ${state.current.cues.length} 条字幕？此操作不可撤销。`)) {
    return;
  }
  await api('DELETE', `/api/works/${work.id}`);
  state.current = null;
  $('#work-view').hidden = true;
  $('#empty-view').hidden = false;
  await loadWorks();
});

/* ------------------------------------------------------------------ */
/* 保存单条：携带修订号，处理 409                                      */
/* ------------------------------------------------------------------ */

async function saveCue(tr, cue, els) {
  const { startInput, endInput, ta, rowMsg, saveBtn } = els;
  rowMsg.className = 'row-msg';
  rowMsg.textContent = '';
  tr.classList.remove('row-err');

  const payload = {
    revision: state.current.work.revision,
    start: startInput.value.trim(),
    end: endInput.value.trim(),
    text: ta.value,
    editor: state.editor || null,
  };

  saveBtn.disabled = true;
  tr.classList.add('saving');
  try {
    const r = await api(
      'PUT',
      `/api/works/${state.current.work.id}/cues/${cue.id}`,
      payload
    );
    // 成功：更新本地修订号和该段基线
    state.current.work.revision = r.revision;
    Object.assign(cue, r.cue);
    startInput.value = r.cue.start;
    endInput.value = r.cue.end;
    ta.value = r.cue.text;
    ta.rows = Math.max(1, ta.value.split('\n').length);
    clearDirty(tr, cue);
    rowMsg.classList.add('ok');
    rowMsg.textContent = `已保存（修订号 ${r.revision}）`;
    $('#work-revision').textContent = r.revision;
    $('#stale-banner').hidden = true;
    // 本地修订号已推进，此前的批量平移预览失效
    invalidateShiftPreview();
  } catch (err) {
    tr.classList.add('row-err');
    rowMsg.classList.add('error');

    if (err.status === 409 && err.data.error === 'revision_stale') {
      const latest = err.data.cue;
      // 更新全局最新修订号，供人工重试携带
      state.current.work.revision = err.data.latest_revision;
      $('#work-revision').textContent = err.data.latest_revision;
      $('#stale-rev').textContent = err.data.latest_revision;
      $('#stale-banner').hidden = false;
      invalidateShiftPreview();

      rowMsg.innerHTML = '';
      const intro = document.createElement('div');
      intro.textContent =
        `修订号过期，已拒绝覆盖（最新修订号 ${err.data.latest_revision}）。` +
        '请对照下方服务器最新内容，人工合并后再保存：';
      const pre = document.createElement('pre');
      pre.className = 'latest-snapshot';
      pre.textContent =
        `${latest.start} --> ${latest.end}\n${latest.text}`;

      const useLatest = document.createElement('button');
      useLatest.className = 'linklike';
      useLatest.type = 'button';
      useLatest.textContent = '直接采用最新内容（放弃我这行的输入）';
      useLatest.addEventListener('click', () => {
        startInput.value = latest.start;
        endInput.value = latest.end;
        ta.value = latest.text;
        ta.rows = Math.max(1, ta.value.split('\n').length);
        Object.assign(cue, latest);
        clearDirty(tr, cue);
        rowMsg.className = 'row-msg';
        rowMsg.textContent = '已填入最新版本；如仍需调整可直接修改后保存。';
      });

      rowMsg.append(intro, pre, useLatest);
    } else {
      rowMsg.textContent = err.message;
    }
  } finally {
    saveBtn.disabled = false;
    tr.classList.remove('saving');
  }
}

/* ------------------------------------------------------------------ */
/* 批量时间轴平移：勾选、预览、确认                                    */
/* ------------------------------------------------------------------ */

function invalidateShiftPreview() {
  if (!state.shiftPreview) return;
  state.shiftPreview = null;
  const rev = $('#shift-preview-rev');
  rev.textContent = '预览已失效（选择或偏移已变化），请重新预览';
  rev.className = 'shift-rev stale';
  $('#shift-confirm-btn').disabled = true;
}

function updateShiftCount() {
  const n = state.current ? state.current.selection.size : 0;
  $('#shift-count').textContent = `已选 ${n} 段`;
  const all = state.current ? state.current.cues.length : 0;
  $('#shift-select-all').checked = all > 0 && n === all;
}

$('#shift-select-all').addEventListener('change', (e) => {
  if (!state.current) return;
  const checked = e.target.checked;
  state.current.selection = new Set(checked ? state.current.cues.map((c) => c.id) : []);
  document.querySelectorAll('#cue-tbody tr').forEach((tr) => {
    const box = tr.querySelector('.cue-pick');
    box.checked = checked;
    tr.classList.toggle('picked', checked);
  });
  invalidateShiftPreview();
  updateShiftCount();
});

$('#shift-offset').addEventListener('input', invalidateShiftPreview);

function readShiftOffset() {
  const raw = $('#shift-offset').value.trim();
  if (!/^[+-]?\d+$/.test(raw)) {
    throw new Error('偏移量必须是有符号整数毫秒，例如 -500、120；不接受小数或非数字');
  }
  return Number(raw);
}

async function previewShift() {
  if (!state.current) return;
  const offset = readShiftOffset();
  const cueIds = [...state.current.selection];
  if (cueIds.length === 0) {
    throw new Error('请先勾选至少一个字幕段');
  }

  const summary = $('#shift-summary');
  summary.className = 'shift-summary';
  summary.textContent = '计算中…';

  const r = await api('POST', `/api/works/${state.current.work.id}/cues/shift/preview`, {
    revision: state.current.work.revision,
    cue_ids: cueIds,
    offset_ms: offset,
  });

  state.shiftPreview = {
    revision: r.expected_revision, // 预览所依据的作品修订号，确认时原样带回
    offsetMs: offset,
    cueIds,
    valid: r.valid,
  };
  renderShiftPreview(r);
}

function renderShiftPreview(r) {
  const panel = $('#shift-panel');
  panel.hidden = false;
  panel.classList.toggle('invalid', !r.valid);

  const rev = $('#shift-preview-rev');
  if (r.stale) {
    rev.textContent = `预览基于修订号 ${r.expected_revision}，但当前本地修订号已不同，请重新载入后再预览`;
    rev.className = 'shift-rev stale';
  } else {
    rev.textContent = `预览依据修订号：${r.expected_revision}（确认时必须与此一致）`;
    rev.className = 'shift-rev';
  }

  const summary = $('#shift-summary');
  const sign = r.offset_ms >= 0 ? `+${r.offset_ms}` : `${r.offset_ms}`;
  if (r.valid) {
    summary.className = 'shift-summary ok';
    summary.textContent =
      `将对 ${r.cues.length} 段统一平移 ${sign} 毫秒，文字不变；检查通过，可以确认。`;
  } else {
    summary.className = 'shift-summary error';
    summary.textContent =
      `将对 ${r.cues.length} 段统一平移 ${sign} 毫秒：存在 ${r.issues.length} 处问题，整批无法应用。`;
  }

  const issueByCue = new Map();
  for (const issue of r.issues) {
    for (const id of issue.cue_ids) {
      if (!issueByCue.has(id)) issueByCue.set(id, []);
      issueByCue.get(id).push(issue);
    }
  }

  const tbody = $('#shift-preview-tbody');
  tbody.innerHTML = '';
  for (const c of r.cues) {
    const tr = document.createElement('tr');
    tr.className = c.negative_start || c.out_of_range || c.collisions.length > 0 ? 'bad' : 'ok';

    const idxTd = document.createElement('td');
    idxTd.textContent = `#${c.idx}`;

    const beforeTd = document.createElement('td');
    beforeTd.className = 'tc';
    beforeTd.textContent = `${c.start}\n→ ${c.end}`;

    const afterTd = document.createElement('td');
    afterTd.className = 'tc';
    afterTd.textContent = `${c.new_start}\n→ ${c.new_end}`;

    const hitTd = document.createElement('td');
    const parts = [];
    if (c.negative_start) parts.push('✗ 新起点为负');
    if (c.out_of_range) parts.push('✗ 时间超出范围');
    if (c.collisions.length > 0) {
      parts.push(
        '✗ 交叠：' +
          c.collisions.map((x) => `#${x.idx}（${x.start} → ${x.end}）`).join('；')
      );
    }
    if (parts.length === 0) parts.push('无碰撞');
    hitTd.textContent = parts.join('\n');

    tr.append(idxTd, beforeTd, afterTd, hitTd);
    tbody.appendChild(tr);
  }

  $('#shift-confirm-btn').disabled = !r.valid || r.stale;
}

$('#shift-preview-btn').addEventListener('click', async () => {
  if (!state.current) return;
  try {
    await previewShift();
  } catch (err) {
    $('#shift-panel').hidden = false;
    $('#shift-summary').className = 'shift-summary error';
    $('#shift-summary').textContent = err.message;
    $('#shift-preview-tbody').innerHTML = '';
    $('#shift-preview-rev').textContent = '';
    $('#shift-confirm-btn').disabled = true;
  }
});

$('#shift-cancel-btn').addEventListener('click', () => {
  state.shiftPreview = null;
  $('#shift-panel').hidden = true;
});

$('#shift-confirm-btn').addEventListener('click', async () => {
  if (!state.current || !state.shiftPreview) return;
  const p = state.shiftPreview;

  if (state.current.dirty.size > 0) {
    if (
      !confirm(
        '有字幕段的单段编辑尚未保存，应用批量平移将按服务器当前时间整体重算，' +
          '未保存的文字/时间修改可能被覆盖。确定继续？'
      )
    ) {
      return;
    }
  }
  const btn = $('#shift-confirm-btn');
  btn.disabled = true;
  try {
    const r = await api('POST', `/api/works/${state.current.work.id}/cues/shift`, {
      revision: p.revision, // 携带预览所依据的修订号
      cue_ids: p.cueIds,
      offset_ms: p.offsetMs,
      editor: state.editor || null,
    });
    // 成功：按服务器重排后的结果整体刷新（openWork 会清空选择与预览状态）
    await openWork(state.current.work.id);
  } catch (err) {
    btn.disabled = false;
    const rev = $('#shift-preview-rev');
    if (err.status === 409 && err.data.error === 'revision_stale') {
      state.shiftPreview = null;
      rev.textContent =
        `作品在预览后已被其他人改动（最新修订号 ${err.data.latest_revision}），` +
        '本次确认已拒绝。请重新载入并重新预览。';
      rev.className = 'shift-rev stale';
      $('#shift-summary').className = 'shift-summary error';
      $('#shift-summary').textContent =
        '不能按过期预览写入；请重新载入作品、重新选择并预览后再确认。';
      btn.disabled = true;
    } else if (err.status === 422 && err.data.issues) {
      // 理论上预览 valid 后不会出现；若发生则要求重新预览
      state.shiftPreview = null;
      $('#shift-summary').className = 'shift-summary error';
      $('#shift-summary').textContent =
        `${err.data.message}（请重新预览）`;
      btn.disabled = true;
    } else {
      $('#shift-summary').className = 'shift-summary error';
      $('#shift-summary').textContent = err.message;
    }
  }
});

/* ------------------------------------------------------------------ */
/* 离开页面前提醒未保存修改                                            */
/* ------------------------------------------------------------------ */

window.addEventListener('beforeunload', (e) => {
  if (state.current && state.current.dirty.size > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/* 初始化 */
loadWorks().catch((err) => {
  const ul = $('#work-list');
  ul.innerHTML = '';
  const li = document.createElement('li');
  li.className = 's';
  li.textContent = `加载失败：${err.message}`;
  ul.appendChild(li);
});
