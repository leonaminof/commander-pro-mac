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

// ── State ─────────────────────────────────────────────────────────────────────
// cwd for android panes is a plain unix path (e.g. /sdcard)
// pane.android = { serial, model } when in android mode, else null

const state = {
  left:  { cwd: '/', entries: [], selected: new Set(), cursor: 0, filter: '', android: null },
  right: { cwd: '/', entries: [], selected: new Set(), cursor: 0, filter: '', android: null },
  active: 'left',
  previewOpen: false,
  androidDevices: [],
};

// ── DOM refs ──────────────────────────────────────────────────────────────────

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
  progressOverlay: $('progress-overlay'),
  progressOp:      $('progress-op'),
  progressFilename:$('progress-filename'),
  progressPct:     $('progress-pct'),
  progressBar:     $('progress-bar'),
  progressDetail:  $('progress-detail'),
};

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  const home = await window.api.homedir();
  const volumes = await window.api.volumes();

  // Detect Android devices
  await refreshAndroidDevices(volumes);

  for (const side of ['left', 'right']) {
    dom.drive(side).addEventListener('change', e => handleDriveChange(side, e.target.value));
    dom.list(side).addEventListener('keydown', e => handleListKey(side, e));
    dom.list(side).addEventListener('focus', () => { state.active = side; updateActivePaneStyle(); });
    dom.pane(side).addEventListener('mousedown', () => { state.active = side; updateActivePaneStyle(); });

    // Android quick-nav buttons
    document.querySelectorAll(`#android-quicknav-${side} .aqn-btn`).forEach(btn => {
      btn.addEventListener('click', () => navigate(side, btn.dataset.path));
    });
  }

  // Toolbar
  $('btn-copy').addEventListener('click',       () => operationCopyMove('copy'));
  $('btn-move').addEventListener('click',       () => operationCopyMove('move'));
  $('btn-delete').addEventListener('click',     () => operationDelete());
  $('btn-rename').addEventListener('click',     () => operationRename());
  $('btn-new-folder').addEventListener('click', () => operationNewFolder());
  $('btn-refresh').addEventListener('click',    async () => {
    await refreshAndroidDevices();
    reload('left'); reload('right');
  });
  $('btn-open-finder').addEventListener('click', () => {
    const s = state[state.active];
    if (s.android) return; // can't open android path in Finder
    const target = s.selected.size ? [...s.selected][0] : s.cwd;
    window.api.showInFinder(target);
  });

  // Preview close
  $('preview-close').addEventListener('click', closePreview);

  // Modal
  dom.modalCancel.addEventListener('click', () => resolveModal(null));
  dom.modalOk.addEventListener('click',     () => resolveModal(dom.modalInput.value));
  dom.modalInput.addEventListener('keydown', e => {
    if (e.key === 'Enter')  resolveModal(dom.modalInput.value);
    if (e.key === 'Escape') resolveModal(null);
  });

  // Filter
  dom.searchInput.addEventListener('input', e => {
    state[state.active].filter = e.target.value.toLowerCase();
    renderList(state.active);
  });

  document.addEventListener('keydown', handleGlobalKey);
  setupDividerDrag();

  // Progress listener
  let progressDoneTimer = null;
  window.api.onProgress(({ percent, filename, detail, op }) => {
    dom.progressOverlay.hidden = false;
    dom.progressBar.classList.remove('indeterminate');
    dom.progressOp.textContent = op || (percent < 100 ? 'Copying' : 'Done');
    dom.progressFilename.textContent = filename || '';
    dom.progressPct.textContent = `${percent}%`;
    dom.progressBar.style.width = `${percent}%`;
    dom.progressDetail.textContent = detail || '';
    clearTimeout(progressDoneTimer);
    if (percent >= 100) {
      progressDoneTimer = setTimeout(() => { dom.progressOverlay.hidden = true; }, 1800);
    }
  });

  await Promise.all([navigate('left', home), navigate('right', home)]);
  dom.list('left').focus();
}

// ── Android device detection ──────────────────────────────────────────────────

async function refreshAndroidDevices(existingVolumes) {
  const devices = await window.api.adbDevices();
  state.androidDevices = devices;

  const volumes = existingVolumes || await window.api.volumes();

  for (const side of ['left', 'right']) {
    populateDrives(side, volumes, devices);
  }
}

function isAndroidSerial(val) {
  return val && val.startsWith('android:');
}

function parseAndroidDriveValue(val) {
  // format: "android:<serial>"
  const serial = val.replace('android:', '');
  return serial;
}

async function handleDriveChange(side, val) {
  if (isAndroidSerial(val)) {
    const serial = parseAndroidDriveValue(val);
    const device = state.androidDevices.find(d => d.serial === serial);
    if (!device) return;
    if (device.status !== 'device') {
      dom.status(side).textContent = `Device unauthorized — accept "Allow USB debugging" on your phone.`;
      return;
    }
    state[side].android = { serial };
    await navigate(side, '/sdcard');
  } else {
    state[side].android = null;
    await navigate(side, val);
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────

async function navigate(side, dirPath) {
  const s = state[side];
  try {
    let entries;
    if (s.android) {
      entries = await window.api.adbReaddir(s.android.serial, dirPath);
    } else {
      entries = await window.api.readdir(dirPath);
    }
    s.cwd = dirPath;
    s.entries = entries;
    s.selected.clear();
    s.cursor = 0;
    s.filter = '';
    dom.searchInput.value = '';
    renderBreadcrumb(side);
    renderList(side);
    updateStatus(side);
    updateAndroidQuicknav(side);
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

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderList(side) {
  const s = state[side];
  const container = dom.list(side);
  const filter = s.filter;
  const visible = s.entries.filter(e => !filter || e.name.toLowerCase().includes(filter));

  container.innerHTML = '';

  // ".." row
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
    const fullPath = path.join(s.cwd, entry.name);
    row.dataset.path = fullPath;

    if (s.selected.has(fullPath)) row.classList.add('selected');
    if (idx === s.cursor) row.classList.add('cursor');

    const icon = entry.isDirectory ? '📁' : (entry.isSymlink ? '🔗' : getFileIcon(entry.name));
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

  const cursorRow = container.querySelectorAll('.file-row')[s.cursor + 1];
  if (cursorRow) cursorRow.scrollIntoView({ block: 'nearest' });
}

function renderBreadcrumb(side) {
  const s = state[side];
  const parts = s.cwd.split('/').filter(Boolean);
  const bc = dom.breadcrumb(side);
  bc.innerHTML = '';

  if (s.android) {
    const androidLabel = document.createElement('span');
    androidLabel.className = 'bc-part bc-android';
    androidLabel.textContent = `📱 ${s.android.serial}`;
    bc.appendChild(androidLabel);
  }

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
  const prefix = s.android ? `📱 Android · ` : '';
  const dirs  = s.entries.filter(e => e.isDirectory).length;
  const files = s.entries.filter(e => !e.isDirectory).length;
  const selCount = s.selected.size;
  const selSize = [...s.selected].reduce((acc, p) => {
    const name = path.basename(p);
    const entry = s.entries.find(e => e.name === name);
    return acc + (entry && !entry.isDirectory ? entry.size : 0);
  }, 0);
  dom.status(side).textContent = prefix + (selCount
    ? `${selCount} selected (${formatSize(selSize)}) | ${dirs} dirs, ${files} files`
    : `${dirs} dirs, ${files} files`);
}

function updateActivePaneStyle() {
  document.querySelectorAll('.pane').forEach(p => p.classList.remove('pane-active'));
  dom.pane(state.active).classList.add('pane-active');
}

function updateAndroidQuicknav(side) {
  const qn = $(`android-quicknav-${side}`);
  qn.hidden = !state[side].android;
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
    for (let i = start; i <= end; i++) s.selected.add(path.join(s.cwd, visible[i].name));
  } else if (e.metaKey || e.ctrlKey) {
    if (s.selected.has(fullPath)) s.selected.delete(fullPath);
    else s.selected.add(fullPath);
  } else {
    s.selected.clear();
    s.selected.add(fullPath);
  }
  s.cursor = idx;
  renderList(side); updateStatus(side);
  dom.list(side).focus();
}

async function handleRowDblClick(side, entry) {
  const s = state[side];
  const fullPath = path.join(s.cwd, entry.name);

  if (entry.isDirectory) {
    await navigate(side, fullPath);
    return;
  }

  if (s.android) {
    // Symlinks may point to directories — try navigating first
    if (entry.isSymlink) {
      try {
        await navigate(side, fullPath);
        return;
      } catch { /* not a directory, fall through to file open */ }
    }
    // Pull file to temp and open; use basename of fullPath to avoid any slashes in name
    const safeName = fullPath.split('/').pop() || 'file';
    const tmp = `/tmp/adb_open_${Date.now()}_${safeName}`;
    try {
      await window.api.adbPull(s.android.serial, fullPath, tmp);
      await window.api.open(tmp);
      dom.statusbar.textContent = `Opened ${entry.name} from Android (temp copy).`;
    } catch (err) {
      dom.statusbar.textContent = `Error opening file: ${err.message}`;
    }
  } else {
    await window.api.open(fullPath);
  }
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

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
      if (visible[s.cursor]) s.selected.add(path.join(s.cwd, visible[s.cursor].name));
      renderList(side); updateStatus(side);
      break;
    case 'ArrowDown':
      e.preventDefault();
      if (s.cursor < max) s.cursor++;
      if (!e.shiftKey) s.selected.clear();
      if (visible[s.cursor]) s.selected.add(path.join(s.cwd, visible[s.cursor].name));
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
  if (!dom.modal.hidden) return;
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
  const srcSide = state.active;
  const dstSide = otherSide(srcSide);
  const src = state[srcSide];
  const dst = state[dstSide];

  const targets = src.selected.size ? [...src.selected] : [];
  if (!targets.length) {
    const visible = src.entries.filter(e => !src.filter || e.name.toLowerCase().includes(src.filter));
    const cur = visible[src.cursor];
    if (cur) targets.push(path.join(src.cwd, cur.name));
  }
  if (!targets.length) return;

  const names = targets.map(p => path.basename(p)).join(', ');
  const srcLabel = src.android ? `📱 Android:${src.cwd}` : src.cwd;
  const dstLabel = dst.android ? `📱 Android:${dst.cwd}` : dst.cwd;

  const confirmed = await window.api.confirm(
    `${op === 'copy' ? 'Copy' : 'Move'} ${targets.length} item(s)?`,
    `From: ${srcLabel}\nTo:   ${dstLabel}\n\n${names}`
  );
  if (!confirmed) return;

  // Show indeterminate bar immediately
  dom.progressOverlay.hidden = false;
  dom.progressOp.textContent = op === 'copy' ? 'Copying' : 'Moving';
  dom.progressFilename.textContent = names.length > 40 ? names.slice(0, 40) + '…' : names;
  dom.progressPct.textContent = '0%';
  dom.progressBar.style.width = '0%';
  dom.progressBar.classList.add('indeterminate');
  dom.progressDetail.textContent = '';

  try {
    for (const t of targets) {
      const destPath = path.join(dst.cwd, path.basename(t));

      if (!src.android && !dst.android) {
        // local → local
        if (op === 'copy') await window.api.copy(t, destPath);
        else               await window.api.move(t, destPath);
      } else if (src.android && !dst.android) {
        // android → local (pull)
        await window.api.adbPull(src.android.serial, t, destPath);
        if (op === 'move') await window.api.adbDelete(src.android.serial, t);
      } else if (!src.android && dst.android) {
        // local → android (push)
        await window.api.adbPush(dst.android.serial, t, destPath);
        if (op === 'move') await window.api.delete(t);
      } else {
        // android → android (pull to tmp, push)
        const tmp = `/tmp/adb_xfer_${Date.now()}_${path.basename(t)}`;
        await window.api.adbPull(src.android.serial, t, tmp);
        await window.api.adbPush(dst.android.serial, tmp, destPath);
        await window.api.delete(tmp);
        if (op === 'move') await window.api.adbDelete(src.android.serial, t);
      }
    }
    await reload('left'); await reload('right');
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

  const confirmed = await window.api.confirm(
    `Delete ${targets.length} item(s) permanently?`,
    targets.map(p => path.basename(p)).join(', ')
  );
  if (!confirmed) return;

  try {
    for (const t of targets) {
      if (s.android) await window.api.adbDelete(s.android.serial, t);
      else           await window.api.delete(t);
    }
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
  const oldPath = path.join(s.cwd, cur.name);
  const newPath = path.join(s.cwd, newName);
  try {
    if (s.android) await window.api.adbRename(s.android.serial, oldPath, newPath);
    else           await window.api.rename(oldPath, newPath);
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
  const newPath = path.join(s.cwd, name);
  try {
    if (s.android) await window.api.adbMkdir(s.android.serial, newPath);
    else           await window.api.mkdir(newPath);
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
  dom.previewFile.textContent = (s.android ? '📱 ' : '') + cur.name;
  dom.previewContent.innerHTML = '<div class="preview-loading">Loading…</div>';
  dom.preview.classList.add('open');
  state.previewOpen = true;

  const ext = path.extname(cur.name).toLowerCase();
  const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'];

  if (!s.android && imageExts.includes(ext)) {
    dom.previewContent.innerHTML = `<img src="file://${filePath}" alt="${escHtml(cur.name)}">`;
    return;
  }

  try {
    let text;
    if (s.android) {
      text = await window.api.adbReadfile(s.android.serial, filePath);
    } else {
      text = await window.api.readfile(filePath);
    }
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

// ── Modal ─────────────────────────────────────────────────────────────────────

let _modalResolve = null;

function promptModal(title, defaultValue = '') {
  return new Promise(resolve => {
    _modalResolve = resolve;
    dom.modalTitle.textContent = title;
    dom.modalInput.value = defaultValue;
    dom.modal.hidden = false;
    setTimeout(() => { dom.modalInput.focus(); dom.modalInput.select(); }, 30);
  });
}

function resolveModal(value) {
  dom.modal.hidden = true;
  if (_modalResolve) { _modalResolve(value); _modalResolve = null; }
}

// ── Drives ────────────────────────────────────────────────────────────────────

let _volumes = [];

function populateDrives(side, volumes, androidDevices = []) {
  _volumes = volumes;
  const sel = dom.drive(side);
  const localOpts = volumes.map(v =>
    `<option value="${escAttr(v.path)}">${escHtml(v.name)}</option>`
  ).join('');

  const androidOpts = androidDevices.map(d => {
    const label = d.status === 'device'
      ? `📱 Android (${d.serial})`
      : `📱 Android — ${d.status} (${d.serial})`;
    return `<option value="android:${escAttr(d.serial)}">${escHtml(label)}</option>`;
  }).join('');

  sel.innerHTML = localOpts + (androidOpts
    ? `<optgroup label="── Android ──">${androidOpts}</optgroup>`
    : '');
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
    dragging = true; startX = e.clientX;
    startLeft = dom.pane('left').getBoundingClientRect().width;
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const totalW = main.getBoundingClientRect().width;
    const newLeft = Math.max(200, Math.min(totalW - 200, startLeft + (e.clientX - startX)));
    const pct = (newLeft / totalW) * 100;
    dom.pane('left').style.flex  = `0 0 ${pct}%`;
    dom.pane('right').style.flex = `0 0 ${100 - pct}%`;
  });
  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; document.body.style.cursor = ''; }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms), pad = n => String(n).padStart(2, '0');
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
    js:'🟨', ts:'🔷', jsx:'⚛️', tsx:'⚛️', py:'🐍', rb:'💎', go:'🐹', rs:'🦀',
    html:'🌐', css:'🎨', json:'📋', md:'📝', txt:'📄', pdf:'📕',
    doc:'📘', docx:'📘', xls:'📗', xlsx:'📗', ppt:'📙', pptx:'📙',
    zip:'📦', tar:'📦', gz:'📦', rar:'📦', '7z':'📦',
    png:'🖼️', jpg:'🖼️', jpeg:'🖼️', gif:'🖼️', svg:'🖼️', webp:'🖼️',
    mp3:'🎵', wav:'🎵', flac:'🎵', m4a:'🎵', aac:'🎵',
    mp4:'🎬', mov:'🎬', avi:'🎬', mkv:'🎬',
    apk:'📱', sh:'💻', dmg:'💿', app:'🖥️', pkg:'📦',
  };
  return map[ext] || '📄';
}

// ── Boot ──────────────────────────────────────────────────────────────────────

init().catch(console.error);
