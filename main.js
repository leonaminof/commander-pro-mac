const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

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
  if (process.platform === 'darwin') {
    try {
      const vols = fs.readdirSync('/Volumes');
      return vols.map(v => ({ name: v, path: `/Volumes/${v}` }));
    } catch { return [{ name: 'Macintosh HD', path: '/' }]; }
  }
  return [{ name: 'Root', path: '/' }];
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
  copyRecursive(src, dest);
});

ipcMain.handle('fs:move', async (_, src, dest) => {
  try {
    fs.renameSync(src, dest);
  } catch {
    // cross-device move: copy then delete
    copyRecursive(src, dest);
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      fs.rmSync(src, { recursive: true, force: true });
    } else {
      fs.unlinkSync(src);
    }
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
  // We'll handle rename input in the renderer via a custom modal
  return null;
});

ipcMain.handle('dialog:mkdir', async () => null);

// ── Helpers ───────────────────────────────────────────────────────────────────

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      copyRecursive(path.join(src, child), path.join(dest, child));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}
