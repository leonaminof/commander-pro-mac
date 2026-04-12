/* ============================================================
   Commander Pro – Renderer Process
   ============================================================ */

'use strict';

const path = {
  join:    (...p) => p.join('/').replace(/\/+/g, '/').replace(/(.+)\/$/, '$1'),
  dirname: (p)    => p.split('/').slice(0, -1).join('/') || '/',
  basename:(p)    => p.split('/').pop(),
  extname: (p)    => { const b = p.split('/').pop(); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; }
};

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  left:  { cwd: '/', entries: [], selected: new Set(), cursor: 0, filter: '' },
  right: { cwd: '/', entries: [], selected: new Set(), cursor: 0, filter: '' },
  active: 'left',   // which pane has focus
  previewOpen: false
};

// ── DOM refs ─────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const dom = {
  pane:       side => $(`pane-${side}`),
  list:       side => $(`list-${side}`),
  breadcrumb: side => $(`breadcrumb-${side}`),
  status:     side => $(`status-${side}`),
  drive:      side => $(`drive-${side}`),
  statusbar:  $('statusbar-left'),
  preview:    $('preview-panel'),
  previewFile:$('preview-filename'),
  previewContent: $('preview-content'),
  searchInput:$('search-input'),
  modal:      $('modal-backdrop'),
  modalTitle: $('modal-title'),
  modalInput: $('modal-input'),
  modalOk:    $('modal-ok'),
  modalCancel:$('modal-cancel'),
};

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const home = await window.api.homedir();
  const volumes = await window.api.volumes();

  for (const side of ['left', 'right']) {
    populateDrives(side, volumes);
    dom.drive(side).addEventListener('change', e => navigate(side, e.target.value));
    dom.list(side).addEventListener('keydown', e => handleListKey(side, e));
    dom.list(side).addEventListener('focus', () => { state.active = side; updateActivePaneStyle(); });
    dom.pane(side).addEventListener('mousedown', () => { state.active = side; updateActivePaneStyle(); });
  }

  // Toolbar buttons
  $('btn-copy').addEventListener('click', () => operationCopyMove('copy'));
  $('btn-move').addEventListener('click', () => operationCopyMove('move'));
  $('btn-delete').addEventListener('click', () => operationDelete());
  $('btn-rename').addEventListener('click', () => operationRename());
  $('btn-new-folder').addEventListener('click', () => operationNewFolder());
  $('btn-refresh').addEventListener('click', () => { reload('left'); reload('right'); });
  $('btn-open-finder').addEventListener('click', () => {
    const s = state[state.active];
    const target = s.selected.size ? [...s.selected][0] : s.cwd;
    window.api.showInFinder(target);
  });

  // Preview close
  $('preview-close').addEventListener('click', closePreview);

  // Modal buttons
  dom.modalCancel.addEventListener('click', () => resolveModal(null));
  dom.modalOk.addEventListener('click',     () => resolveModal(dom.modalInput.value));
  dom.modalInput.addEventListener('keydown', e => {
    if (e.key === 'Enter')  resolveModal(dom.modalInput.value);
    if (e.key === 'Escape') resolveModal(null);
  });

  // Search filter
  dom.searchInput.addEventListener('input', e => {
    state[state.active].filter = e.target.value.toLowerCase();
    renderList(state.active);
  });

  // Global keyboard shortcuts
  document.addEventListener('keydown', handleGlobalKey);

  // Divider drag resize
  setupDividerDrag();

  // Navigate both panes to home
  await Promise.all([navigate('left', home), navigate('right', home)]);
  dom.list('left').focus();
}

// ── Navigation ───────────────────────────────────────────────────────────────

async function navigate(side, dirPath) {
  try {
    const entries = await window.api.readdir(dirPath);
    state[side].cwd = dirPath;
    state[side].entries = entries;
    state[side].selected.clear();
    state[side].cursor = 0;
    state[side].filter = '';
    dom.searchInput.value = '';
    renderBreadcrumb(side);
    renderList(side);
    updateStatus(side);
    // sync drive select
    const vol = getVolumeForPath(dirPath);
    if (vol) dom.drive(side).value = vol;
  } catch (err) {
    dom.status(side).textContent = `Error: ${err.message}`;
  }
}

async function reload(side) {
  await navigate(side, state[side].cwd);
}

function goUp(side) {
  const parent = path.dirname(state[side].cwd);
  if (parent !== state[side].cwd) navigate(side, parent);
}

function otherSide(side) { return side === 'left' ? 'right' : 'left'; }

// ── Rendering ────────────────────────────────────────────────────────────────

function renderList(side) {
  const s = state[side];
  const container = dom.list(side);
  const filter = s.filter;

  const visible = s.entries.filter(e =>
    !filter || e.name.toLowerCase().includes(filter)
  );

  container.innerHTML = '';

  // ".." entry
  const upRow = document.createElement('div');
  upRow.className = 'file-row up-row';
  upRow.innerHTML = `<span class="col-name"><span class="icon">📁</span>..</span><span class="col-size"></span><span class="col-date"></span>`;
  upRow.addEventListener('click', () => { s.cursor = -1; goUp(side); });
  upRow.addEventListener('dblclick', () => goUp(side));
  container.appendChild(upRow);

  visible.forEach((entry, idx) => {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.dataset.idx = idx;
    row.dataset.path = path.join(s.cwd, entry.name);

    if (s.selected.has(path.join(s.cwd, entry.name))) row.classList.add('selected');
    if (idx === s.cursor) row.classList.add('cursor');

    const icon = entry.isDirectory ? '📁' : getFileIcon(entry.name);
    const size = entry.isDirectory ? '<DIR>' : formatSize(entry.size);
    const date = formatDate(entry.mtime);

    row.innerHTML = `
      <span class="col-name"><span class="icon">${icon}</span>${escHtml(entry.name)}</span>
      <span class="col-size">${size}</span>
      <span class="col-date">${date}</span>
    `;

    row.addEventListener('click', e => handleRowClick(side, idx, entry, e));
    row.addEventListener('dblclick', () => handleRowDblClick(side, entry));
    container.appendChild(row);
  });

  // scroll cursor into view
  const cursorRow = container.querySelectorAll('.file-row')[s.cursor + 1];
  if (cursorRow) cursorRow.scrollIntoView({ block: 'nearest' });
}

function renderBreadcrumb(side) {
  const parts = state[side].cwd.split('/').filter(Boolean);
  const bc = dom.breadcrumb(side);
  bc.innerHTML = '';

  const rootSpan = document.createElement('span');
  rootSpan.className = 'bc-part';
  rootSpan.textContent = '/';
  rootSpan.addEventListener('click', () => navigate(side, '/'));
  bc.appendChild(rootSpan);

  let built = '';
  parts.forEach((p, i) => {
    built += '/' + p;
    const cap = built;
    const sep = document.createElement('span');
    sep.className = 'bc-sep';
    sep.textContent = '›';
    bc.appendChild(sep);
    const span = document.createElement('span');
    span.className = 'bc-part';
    if (i === parts.length - 1) span.classList.add('bc-current');
    span.textContent = p;
    span.addEventListener('click', () => navigate(side, cap));
    bc.appendChild(span);
  });
}

function updateStatus(side) {
  const s = state[side];
  const dirs = s.entries.filter(e => e.isDirectory).length;
  const files = s.entries.filter(e => !e.isDirectory).length;
  const selCount = s.selected.size;
  const selSize = [...s.selected].reduce((acc, p) => {
    const name = path.basename(p);
    const entry = s.entries.find(e => e.name === name);
    return acc + (entry && !entry.isDirectory ? entry.size : 0);
  }, 0);
  dom.status(side).textContent = selCount
    ? `${selCount} selected (${formatSize(selSize)}) | ${dirs} dirs, ${files} files`
    : `${dirs} dirs, ${files} files`;
}

function updateActivePaneStyle() {
  document.querySelectorAll('.pane').forEach(p => p.classList.remove('pane-active'));
  dom.pane(state.active).classList.add('pane-active');
}

// ── Row interaction ───────────────────────────────────────────────────────────

function handleRowClick(side, idx, entry, e) {
  const s = state[side];
  const fullPath = path.join(s.cwd, entry.name);
  state.active = side;
  updateActivePaneStyle();

  if (e.shiftKey) {
    const start = Math.min(s.cursor, idx);
    const end   = Math.max(s.cursor, idx);
    const visible = s.entries.filter(en => !s.filter || en.name.toLowerCase().includes(s.filter));
    for (let i = start; i <= end; i++) {
      s.selected.add(path.join(s.cwd, visible[i].name));
    }
  } else if (e.metaKey || e.ctrlKey) {
    if (s.selected.has(fullPath)) s.selected.delete(fullPath);
    else s.selected.add(fullPath);
  } else {
    s.selected.clear();
    s.selected.add(fullPath);
  }

  s.cursor = idx;
  renderList(side);
  updateStatus(side);
  dom.list(side).focus();
}

async function handleRowDblClick(side, entry) {
  if (entry.isDirectory) {
    await navigate(side, path.join(state[side].cwd, entry.name));
  } else {
    await window.api.open(path.join(state[side].cwd, entry.name));
  }
}

// ── Keyboard handling ─────────────────────────────────────────────────────────

function handleListKey(side, e) {
  const s = state[side];
  const visible = s.entries.filter(en => !s.filter || en.name.toLowerCase().includes(s.filter));
  const max = visible.length - 1;

  switch (e.key) {
    case 'ArrowUp':
      e.preventDefault();
      if (s.cursor > 0) s.cursor--;
      else { goUp(side); return; }
      if (!e.shiftKey) s.selected.clear();
      if (visible[s.cursor]) {
        if (e.shiftKey) s.selected.add(path.join(s.cwd, visible[s.cursor].name));
        else s.selected.add(path.join(s.cwd, visible[s.cursor].name));
      }
      renderList(side); updateStatus(side);
      break;

    case 'ArrowDown':
      e.preventDefault();
      if (s.cursor < max) s.cursor++;
      if (!e.shiftKey) s.selected.clear();
      if (visible[s.cursor]) {
        s.selected.add(path.join(s.cwd, visible[s.cursor].name));
      }
      renderList(side); updateStatus(side);
      break;

    case 'Enter':
      e.preventDefault();
      if (visible[s.cursor]) handleRowDblClick(side, visible[s.cursor]);
      break;

    case 'Backspace':
      e.preventDefault();
      goUp(side);
      break;

    case ' ':
      e.preventDefault();
      if (visible[s.cursor]) {
        const fp = path.join(s.cwd, visible[s.cursor].name);
        if (s.selected.has(fp)) s.selected.delete(fp);
        else s.selected.add(fp);
        if (s.cursor < max) s.cursor++;
        renderList(side); updateStatus(side);
      }
      break;

    case 'Tab':
      e.preventDefault();
      state.active = otherSide(side);
      updateActivePaneStyle();
      dom.list(state.active).focus();
      break;
  }
}

function handleGlobalKey(e) {
  if (dom.modal.hidden === false) return; // modal open

  switch (e.key) {
    case 'F5': e.preventDefault(); operationCopyMove('copy'); break;
    case 'F6': e.preventDefault(); operationCopyMove('move'); break;
    case 'F7': e.preventDefault(); operationNewFolder(); break;
    case 'F8': e.preventDefault(); operationDelete(); break;
    case 'F3': e.preventDefault(); togglePreview(); break;
    case 'Escape': closePreview(); break;
  }
}

// ── File operations ───────────────────────────────────────────────────────────

async function operationCopyMove(op) {
  const src = state[state.active];
  const dst = state[otherSide(state.active)];
  const targets = src.selected.size ? [...src.selected] : [];

  if (!targets.length) {
    const visible = src.entries.filter(e => !src.filter || e.name.toLowerCase().includes(src.filter));
    const cur = visible[src.cursor];
    if (cur) targets.push(path.join(src.cwd, cur.name));
  }

  if (!targets.length) return;

  const names = targets.map(p => path.basename(p)).join(', ');
  const confirmed = await window.api.confirm(
    `${op === 'copy' ? 'Copy' : 'Move'} ${targets.length} item(s)?`,
    `From: ${src.cwd}\nTo:   ${dst.cwd}\n\n${names}`
  );
  if (!confirmed) return;

  try {
    for (const t of targets) {
      const dest = path.join(dst.cwd, path.basename(t));
      if (op === 'copy') await window.api.copy(t, dest);
      else               await window.api.move(t, dest);
    }
    await reload('left');
    await reload('right');
    dom.statusbar.textContent = `${op === 'copy' ? 'Copied' : 'Moved'} ${targets.length} item(s).`;
  } catch (err) {
    dom.statusbar.textContent = `Error: ${err.message}`;
  }
}

async function operationDelete() {
  const s = state[state.active];
  const targets = s.selected.size ? [...s.selected] : [];
  if (!targets.length) {
    const visible = s.entries.filter(e => !s.filter || e.name.toLowerCase().includes(s.filter));
    const cur = visible[s.cursor];
    if (cur) targets.push(path.join(s.cwd, cur.name));
  }
  if (!targets.length) return;

  const names = targets.map(p => path.basename(p)).join(', ');
  const confirmed = await window.api.confirm(
    `Delete ${targets.length} item(s) permanently?`,
    names
  );
  if (!confirmed) return;

  try {
    for (const t of targets) await window.api.delete(t);
    await reload(state.active);
    dom.statusbar.textContent = `Deleted ${targets.length} item(s).`;
  } catch (err) {
    dom.statusbar.textContent = `Error: ${err.message}`;
  }
}

async function operationRename() {
  const s = state[state.active];
  const visible = s.entries.filter(e => !s.filter || e.name.toLowerCase().includes(s.filter));
  const cur = visible[s.cursor];
  if (!cur) return;

  const newName = await promptModal('Rename', cur.name);
  if (!newName || newName === cur.name) return;

  try {
    const oldPath = path.join(s.cwd, cur.name);
    const newPath = path.join(s.cwd, newName);
    await window.api.rename(oldPath, newPath);
    await reload(state.active);
    dom.statusbar.textContent = `Renamed to ${newName}`;
  } catch (err) {
    dom.statusbar.textContent = `Error: ${err.message}`;
  }
}

async function operationNewFolder() {
  const s = state[state.active];
  const name = await promptModal('New Folder', 'New Folder');
  if (!name) return;

  try {
    await window.api.mkdir(path.join(s.cwd, name));
    await reload(state.active);
    dom.statusbar.textContent = `Created folder: ${name}`;
  } catch (err) {
    dom.statusbar.textContent = `Error: ${err.message}`;
  }
}

// ── Preview ───────────────────────────────────────────────────────────────────

async function togglePreview() {
  if (state.previewOpen) { closePreview(); return; }
  const s = state[state.active];
  const visible = s.entries.filter(e => !s.filter || e.name.toLowerCase().includes(s.filter));
  const cur = visible[s.cursor];
  if (!cur || cur.isDirectory) return;

  const filePath = path.join(s.cwd, cur.name);
  dom.previewFile.textContent = cur.name;
  dom.previewContent.innerHTML = '<div class="preview-loading">Loading…</div>';
  dom.preview.classList.add('open');
  state.previewOpen = true;

  const ext = path.extname(cur.name).toLowerCase();
  const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'];
  if (imageExts.includes(ext)) {
    dom.previewContent.innerHTML = `<img src="file://${filePath}" alt="${escHtml(cur.name)}">`;
    return;
  }

  try {
    const text = await window.api.readfile(filePath);
    if (text === null) {
      dom.previewContent.innerHTML = '<div class="preview-loading">File too large to preview.</div>';
      return;
    }
    dom.previewContent.innerHTML = `<pre>${escHtml(text)}</pre>`;
  } catch {
    dom.previewContent.innerHTML = '<div class="preview-loading">Cannot preview this file.</div>';
  }
}

function closePreview() {
  dom.preview.classList.remove('open');
  state.previewOpen = false;
}

// ── Modal (prompt) ────────────────────────────────────────────────────────────

let _modalResolve = null;

function promptModal(title, defaultValue = '') {
  return new Promise(resolve => {
    _modalResolve = resolve;
    dom.modalTitle.textContent = title;
    dom.modalInput.value = defaultValue;
    dom.modal.hidden = false;
    setTimeout(() => {
      dom.modalInput.focus();
      dom.modalInput.select();
    }, 30);
  });
}

function resolveModal(value) {
  dom.modal.hidden = true;
  if (_modalResolve) { _modalResolve(value); _modalResolve = null; }
}

// ── Drives ────────────────────────────────────────────────────────────────────

let _volumes = [];

function populateDrives(side, volumes) {
  _volumes = volumes;
  const sel = dom.drive(side);
  sel.innerHTML = volumes.map(v =>
    `<option value="${escAttr(v.path)}">${escHtml(v.name)}</option>`
  ).join('');
}

function getVolumeForPath(p) {
  if (!_volumes.length) return null;
  const match = _volumes
    .filter(v => p.startsWith(v.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return match ? match.path : null;
}

// ── Divider drag ──────────────────────────────────────────────────────────────

function setupDividerDrag() {
  const divider = $('divider');
  const main = document.querySelector('.main');
  let dragging = false, startX = 0, startLeft = 0;

  divider.addEventListener('mousedown', e => {
    dragging = true;
    startX = e.clientX;
    startLeft = dom.pane('left').getBoundingClientRect().width;
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const totalW = main.getBoundingClientRect().width;
    const newLeft = Math.max(200, Math.min(totalW - 200, startLeft + (e.clientX - startX)));
    const pct = (newLeft / totalW) * 100;
    dom.pane('left').style.flex = `0 0 ${pct}%`;
    dom.pane('right').style.flex = `0 0 ${100 - pct}%`;
  });

  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; document.body.style.cursor = ''; }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(str) { return escHtml(str); }

function getFileIcon(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = {
    js: '🟨', ts: '🔷', jsx: '⚛️', tsx: '⚛️',
    py: '🐍', rb: '💎', go: '🐹', rs: '🦀',
    html: '🌐', css: '🎨', json: '📋', md: '📝',
    txt: '📄', pdf: '📕', doc: '📘', docx: '📘',
    xls: '📗', xlsx: '📗', ppt: '📙', pptx: '📙',
    zip: '📦', tar: '📦', gz: '📦', rar: '📦',
    png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️',
    svg: '🖼️', webp: '🖼️', ico: '🖼️',
    mp3: '🎵', wav: '🎵', flac: '🎵', m4a: '🎵',
    mp4: '🎬', mov: '🎬', avi: '🎬', mkv: '🎬',
    sh: '💻', bash: '💻', zsh: '💻',
    dmg: '💿', app: '🖥️', pkg: '📦',
  };
  return map[ext] || '📄';
}

// ── Boot ──────────────────────────────────────────────────────────────────────

init().catch(console.error);
