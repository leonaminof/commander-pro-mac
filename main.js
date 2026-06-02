const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');

// ── Network (lazy-loaded) ─────────────────────────────────────────────────────
let SftpClient = null;
let ftp = null;
function getSftp() { if (!SftpClient) SftpClient = require('ssh2-sftp-client'); return SftpClient; }
function getFtp()  { if (!ftp) ftp = require('basic-ftp'); return ftp; }

// Active SFTP/FTP sessions keyed by connectionId
const netSessions = {};

// Saved connections stored in userData
function connectionsFile() {
  return path.join(app.getPath('userData'), 'connections.json');
}
function loadConnections() {
  try { return JSON.parse(fs.readFileSync(connectionsFile(), 'utf8')); } catch { return []; }
}
function saveConnections(list) {
  fs.writeFileSync(connectionsFile(), JSON.stringify(list, null, 2));
}

// ── ADB helper ────────────────────────────────────────────────────────────────

const ADB_PATHS = [
  '/opt/homebrew/bin/adb',
  '/usr/local/bin/adb',
  '/usr/bin/adb',
];

function findAdb() {
  for (const p of ADB_PATHS) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return 'adb'; // fallback – hope it's in PATH
}

const ADB = findAdb();

function adb(...args) {
  return new Promise((resolve, reject) => {
    execFile(ADB, args, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

// adb with live progress — calls onProgress(percent, detail) from stderr
function adbWithProgress(args, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ADB, args);
    let stderr = '';
    proc.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
      // adb progress lines: "[ 42%] /remote/path"
      for (const line of text.split('\n')) {
        const m = line.match(/\[\s*(\d+)%\]\s*(.*)/);
        if (m) onProgress(parseInt(m[1], 10), m[2].trim());
      }
    });
    proc.stdout.on('data', () => {});
    proc.on('close', code => {
      if (code === 0) { onProgress(100, ''); resolve(); }
      else reject(new Error(stderr.trim() || `adb exited ${code}`));
    });
  });
}

// Streaming local file copy with progress callback
function copyFileWithProgress(src, dest, onProgress) {
  return new Promise((resolve, reject) => {
    let stat;
    try { stat = fs.statSync(src); } catch (e) { return reject(e); }
    const total = stat.size;
    if (total === 0) { fs.copyFileSync(src, dest); onProgress(100, 0, 0); return resolve(); }
    let copied = 0;
    const start = Date.now();
    const r = fs.createReadStream(src);
    const w = fs.createWriteStream(dest);
    r.on('data', chunk => {
      copied += chunk.length;
      const pct = Math.round((copied / total) * 100);
      const elapsed = (Date.now() - start) / 1000 || 0.001;
      const speed = copied / elapsed;
      onProgress(pct, copied, speed);
    });
    r.on('error', reject);
    w.on('error', reject);
    w.on('finish', resolve);
    r.pipe(w);
  });
}

// Parse `adb shell ls -la` output into entry objects
function parseLsLa(output, dirPath) {
  const lines = output.split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    // skip total line
    if (line.startsWith('total')) continue;
    // format: permissions links owner group size date time name
    // permissions can include s/S (setgid/setuid) and t/T (sticky)
    const m = line.match(/^([dlrwxsStT\-]{10})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+(.+)$/);
    if (!m) continue;
    const [, perms, sizeStr, dateStr, name] = m;
    if (name === '.' || name === '..') continue;
    // handle symlinks: "name -> target"
    const realName = name.split(' -> ')[0];
    const isDir  = perms[0] === 'd';
    const isLink = perms[0] === 'l';
    const mtime  = new Date(dateStr).getTime();
    entries.push({
      name: realName,
      isDirectory: isDir,
      isSymlink: isLink,
      size: parseInt(sizeStr, 10) || 0,
      mtime,
      mode: 0,
    });
  }
  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1e1e2e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── IPC Handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('fs:readdir', async (_, dirPath) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries.map(e => {
      const fullPath = path.join(dirPath, e.name);
      let stat = null;
      try { stat = fs.statSync(fullPath); } catch {}
      return {
        name: e.name,
        isDirectory: e.isDirectory(),
        isSymlink: e.isSymbolicLink(),
        size: stat ? stat.size : 0,
        mtime: stat ? stat.mtimeMs : 0,
        mode: stat ? stat.mode : 0
      };
    }).sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch (err) {
    throw new Error(err.message);
  }
});

ipcMain.handle('fs:homedir', () => os.homedir());

ipcMain.handle('fs:volumes', async () => {
  const vols = [];
  if (process.platform === 'darwin') {
    try {
      const names = fs.readdirSync('/Volumes');
      for (const v of names) vols.push({ name: v, path: `/Volumes/${v}`, type: 'local' });
    } catch { vols.push({ name: 'Macintosh HD', path: '/', type: 'local' }); }
  } else {
    vols.push({ name: 'Root', path: '/', type: 'local' });
  }
  return vols;
});

// ── ADB IPC ───────────────────────────────────────────────────────────────────

ipcMain.handle('adb:devices', async () => {
  try {
    const out = await adb('devices');
    const lines = out.split('\n').slice(1).filter(l => l.trim() && !l.startsWith('*'));
    return lines.map(l => {
      const [serial, status] = l.trim().split(/\s+/);
      return { serial, status };
    }).filter(d => d.serial);
  } catch { return []; }
});

ipcMain.handle('adb:readdir', async (_, serial, dirPath) => {
  // -L follows symlinks so /sdcard (a symlink) lists its contents
  const out = await adb('-s', serial, 'shell', `ls -laL "${dirPath}" 2>/dev/null`);
  return parseLsLa(out, dirPath);
});

ipcMain.handle('adb:mkdir', async (_, serial, dirPath) => {
  await adb('-s', serial, 'shell', `mkdir -p "${dirPath}"`);
});

ipcMain.handle('adb:rename', async (_, serial, oldPath, newPath) => {
  await adb('-s', serial, 'shell', `mv "${oldPath}" "${newPath}"`);
});

ipcMain.handle('adb:delete', async (_, serial, filePath) => {
  await adb('-s', serial, 'shell', `rm -rf "${filePath}"`);
});

ipcMain.handle('adb:pull', async (_, serial, remotePath, localPath) => {
  const name = remotePath.split('/').pop();
  await adbWithProgress(
    ['-s', serial, 'pull', remotePath, localPath],
    (pct, detail) => sendProgress(pct, name, detail, pct < 100 ? `Pulling from Android…` : '')
  );
});

ipcMain.handle('adb:push', async (_, serial, localPath, remotePath) => {
  const name = localPath.split('/').pop();
  await adbWithProgress(
    ['-s', serial, 'push', localPath, remotePath],
    (pct, detail) => sendProgress(pct, name, detail, pct < 100 ? `Pushing to Android…` : '')
  );
});

ipcMain.handle('adb:readfile', async (_, serial, remotePath) => {
  // Pull to temp, read, delete
  const tmp = path.join(os.tmpdir(), `adb_preview_${Date.now()}`);
  try {
    await adb('-s', serial, 'pull', remotePath, tmp);
    const stat = fs.statSync(tmp);
    if (stat.size > 2 * 1024 * 1024) { fs.unlinkSync(tmp); return null; }
    const content = fs.readFileSync(tmp, 'utf8');
    fs.unlinkSync(tmp);
    return content;
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error('Cannot read file from device');
  }
});

ipcMain.handle('fs:mkdir', async (_, dirPath) => {
  fs.mkdirSync(dirPath, { recursive: true });
});

ipcMain.handle('fs:rename', async (_, oldPath, newPath) => {
  fs.renameSync(oldPath, newPath);
});

ipcMain.handle('fs:delete', async (_, filePath) => {
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    fs.rmSync(filePath, { recursive: true, force: true });
  } else {
    fs.unlinkSync(filePath);
  }
});

ipcMain.handle('fs:copy', async (_, src, dest) => {
  await copyRecursiveWithProgress(src, dest);
});

ipcMain.handle('fs:move', async (_, src, dest) => {
  try {
    fs.renameSync(src, dest);
    sendProgress(100, path.basename(src), path.basename(src), '');
  } catch {
    await copyRecursiveWithProgress(src, dest);
    const stat = fs.statSync(src);
    if (stat.isDirectory()) fs.rmSync(src, { recursive: true, force: true });
    else fs.unlinkSync(src);
  }
});

ipcMain.handle('fs:open', async (_, filePath) => {
  await shell.openPath(filePath);
});

ipcMain.handle('fs:showInFinder', async (_, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('fs:readfile', async (_, filePath) => {
  const stat = fs.statSync(filePath);
  if (stat.size > 2 * 1024 * 1024) return null; // skip >2MB
  return fs.readFileSync(filePath, 'utf8');
});

ipcMain.handle('dialog:confirm', async (_, message, detail) => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Cancel', 'OK'],
    defaultId: 1,
    message,
    detail
  });
  return response === 1;
});

ipcMain.handle('dialog:rename', async (_, currentName) => {
  return null;
});

ipcMain.handle('dialog:mkdir', async () => null);

// ── Network IPC ───────────────────────────────────────────────────────────────

ipcMain.handle('net:list-connections', () => loadConnections());

ipcMain.handle('net:save-connection', (_, conn) => {
  const list = loadConnections();
  const idx = list.findIndex(c => c.id === conn.id);
  if (idx >= 0) list[idx] = conn; else list.push(conn);
  saveConnections(list);
  return list;
});

ipcMain.handle('net:delete-connection', (_, id) => {
  const list = loadConnections().filter(c => c.id !== id);
  saveConnections(list);
  return list;
});

ipcMain.handle('net:connect', async (_, conn) => {
  const { id, protocol, host, port, username, password, share } = conn;
  if (netSessions[id]) return { ok: true, mountPath: netSessions[id].mountPath };

  if (protocol === 'sftp') {
    const Sftp = getSftp();
    const client = new Sftp();
    await client.connect({ host, port: port || 22, username, password, readyTimeout: 10000 });
    netSessions[id] = { type: 'sftp', client };
    return { ok: true };
  }

  if (protocol === 'ftp' || protocol === 'ftps') {
    const { Client } = getFtp();
    const client = new Client();
    client.ftp.verbose = false;
    await client.access({ host, port: port || 21, user: username, password, secure: protocol === 'ftps' });
    netSessions[id] = { type: 'ftp', client };
    return { ok: true };
  }

  if (protocol === 'smb') {
    // Use macOS native mount_smbfs → browseable as local filesystem
    const safeName = host.replace(/[^a-z0-9]/gi, '_');
    const mountPoint = path.join(os.tmpdir(), `cpm_smb_${safeName}_${id}`);
    fs.mkdirSync(mountPoint, { recursive: true });
    const shareStr = share ? share.replace(/^\//, '') : '';
    const userPass = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
    const smbUrl  = `//${userPass}${host}/${shareStr}`;
    await new Promise((res, rej) => {
      execFile('mount_smbfs', [smbUrl, mountPoint], err => err ? rej(new Error(err.message)) : res());
    });
    netSessions[id] = { type: 'smb', mountPath: mountPoint };
    return { ok: true, mountPath: mountPoint };
  }

  throw new Error(`Unsupported protocol: ${protocol}`);
});

ipcMain.handle('net:disconnect', async (_, id) => {
  const sess = netSessions[id];
  if (!sess) return;
  try {
    if (sess.type === 'sftp') await sess.client.end();
    if (sess.type === 'ftp')  sess.client.close();
    if (sess.type === 'smb')  await new Promise(r => execFile('umount', [sess.mountPath], () => r()));
  } catch {}
  delete netSessions[id];
});

ipcMain.handle('net:readdir', async (_, id, dirPath) => {
  const sess = netSessions[id];
  if (!sess) throw new Error('Not connected');

  if (sess.type === 'sftp') {
    const list = await sess.client.list(dirPath || '/');
    return list.map(f => ({
      name: f.name, isDirectory: f.type === 'd', isSymlink: f.type === 'l',
      size: f.size, mtime: f.modifyTime, mode: f.rights
    })).filter(f => f.name !== '.' && f.name !== '..').sort((a,b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  if (sess.type === 'ftp') {
    const list = await sess.client.list(dirPath || '/');
    return list.map(f => ({
      name: f.name, isDirectory: f.isDirectory, isSymlink: false,
      size: f.size, mtime: f.modifiedAt ? new Date(f.modifiedAt).getTime() : 0, mode: 0
    })).filter(f => f.name !== '.' && f.name !== '..').sort((a,b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  // SMB: browse the mount point as local filesystem
  if (sess.type === 'smb') {
    const localPath = dirPath || sess.mountPath;
    const entries = fs.readdirSync(localPath, { withFileTypes: true });
    return entries.map(e => {
      const fp = path.join(localPath, e.name);
      let stat = null; try { stat = fs.statSync(fp); } catch {}
      return { name: e.name, isDirectory: e.isDirectory(), isSymlink: e.isSymbolicLink(),
               size: stat ? stat.size : 0, mtime: stat ? stat.mtimeMs : 0 };
    }).sort((a,b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }
});

ipcMain.handle('net:mkdir', async (_, id, dirPath) => {
  const sess = netSessions[id];
  if (sess.type === 'sftp') await sess.client.mkdir(dirPath, true);
  else if (sess.type === 'ftp') await sess.client.ensureDir(dirPath);
  else if (sess.type === 'smb') fs.mkdirSync(dirPath, { recursive: true });
});

ipcMain.handle('net:rename', async (_, id, oldPath, newPath) => {
  const sess = netSessions[id];
  if (sess.type === 'sftp') await sess.client.rename(oldPath, newPath);
  else if (sess.type === 'ftp') await sess.client.rename(oldPath, newPath);
  else if (sess.type === 'smb') fs.renameSync(oldPath, newPath);
});

ipcMain.handle('net:delete', async (_, id, remotePath) => {
  const sess = netSessions[id];
  if (sess.type === 'sftp') {
    const stat = await sess.client.stat(remotePath);
    if (stat.isDirectory) await sess.client.rmdir(remotePath, true);
    else await sess.client.delete(remotePath);
  } else if (sess.type === 'ftp') {
    try { await sess.client.removeDir(remotePath); }
    catch { await sess.client.remove(remotePath); }
  } else if (sess.type === 'smb') {
    const st = fs.statSync(remotePath);
    if (st.isDirectory()) fs.rmSync(remotePath, { recursive: true, force: true });
    else fs.unlinkSync(remotePath);
  }
});

ipcMain.handle('net:download', async (_, id, remotePath, localPath) => {
  const name = remotePath.split('/').pop();
  const sess = netSessions[id];
  sendProgress(0, name, 'Downloading…', 'Downloading');
  if (sess.type === 'sftp') {
    await sess.client.fastGet(remotePath, localPath, {
      step: (transferred, chunk, total) => {
        sendProgress(Math.round(transferred/total*100), name, `${formatBytes(transferred)} / ${formatBytes(total)}`, 'Downloading');
      }
    });
  } else if (sess.type === 'ftp') {
    await sess.client.downloadTo(localPath, remotePath);
  } else if (sess.type === 'smb') {
    await copyRecursiveWithProgress(remotePath, localPath);
  }
  sendProgress(100, name, '', 'Done');
});

ipcMain.handle('net:upload', async (_, id, localPath, remotePath) => {
  const name = localPath.split('/').pop();
  const sess = netSessions[id];
  sendProgress(0, name, 'Uploading…', 'Uploading');
  if (sess.type === 'sftp') {
    const stat = fs.statSync(localPath);
    await sess.client.fastPut(localPath, remotePath, {
      step: (transferred, chunk, total) => {
        sendProgress(Math.round(transferred/total*100), name, `${formatBytes(transferred)} / ${formatBytes(total)}`, 'Uploading');
      }
    });
  } else if (sess.type === 'ftp') {
    await sess.client.uploadFrom(localPath, remotePath);
  } else if (sess.type === 'smb') {
    await copyRecursiveWithProgress(localPath, remotePath);
  }
  sendProgress(100, name, '', 'Done');
});

ipcMain.handle('net:readfile', async (_, id, remotePath) => {
  const sess = netSessions[id];
  const tmp = path.join(os.tmpdir(), `cpm_preview_${Date.now()}`);
  try {
    if (sess.type === 'sftp') await sess.client.fastGet(remotePath, tmp);
    else if (sess.type === 'ftp') await sess.client.downloadTo(tmp, remotePath);
    else if (sess.type === 'smb') fs.copyFileSync(remotePath, tmp);
    const stat = fs.statSync(tmp);
    if (stat.size > 2 * 1024 * 1024) { fs.unlinkSync(tmp); return null; }
    const content = fs.readFileSync(tmp, 'utf8');
    fs.unlinkSync(tmp);
    return content;
  } catch { try { fs.unlinkSync(tmp); } catch {} throw new Error('Cannot preview remote file'); }
});

// Disconnect all on quit
app.on('before-quit', async () => {
  for (const id of Object.keys(netSessions)) {
    try {
      const sess = netSessions[id];
      if (sess.type === 'sftp') await sess.client.end();
      if (sess.type === 'ftp')  sess.client.close();
      if (sess.type === 'smb')  execFile('umount', [sess.mountPath], () => {});
    } catch {}
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function sendProgress(percent, filename, detail, op) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('progress:update', { percent, filename, detail, op });
  }
}

async function copyRecursiveWithProgress(src, dest, _collected) {
  // First pass: collect all files to know total size
  if (!_collected) {
    const files = [];
    collectFiles(src, dest, files);
    const totalBytes = files.reduce((s, f) => s + f.size, 0);
    let doneBytes = 0;
    const start = Date.now();
    for (const { from, to, size, name } of files) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      await copyFileWithProgress(from, to, (pct, copied, speed) => {
        const overall = Math.round(((doneBytes + copied) / (totalBytes || 1)) * 100);
        const speedStr = speed > 0 ? ` · ${formatBytes(speed)}/s` : '';
        sendProgress(overall, name, `${formatBytes(doneBytes + copied)} / ${formatBytes(totalBytes)}${speedStr}`, '');
      });
      doneBytes += size;
    }
    sendProgress(100, path.basename(src), '', '');
  }
}

function collectFiles(src, dest, out) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(src)) {
      collectFiles(path.join(src, child), path.join(dest, child), out);
    }
  } else {
    out.push({ from: src, to: dest, size: stat.size, name: path.basename(src) });
  }
}

function formatBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}
