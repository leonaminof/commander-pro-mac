const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Local filesystem
  readdir:     (p)       => ipcRenderer.invoke('fs:readdir', p),
  homedir:     ()        => ipcRenderer.invoke('fs:homedir'),
  volumes:     ()        => ipcRenderer.invoke('fs:volumes'),
  mkdir:       (p)       => ipcRenderer.invoke('fs:mkdir', p),
  rename:      (o, n)    => ipcRenderer.invoke('fs:rename', o, n),
  delete:      (p)       => ipcRenderer.invoke('fs:delete', p),
  copy:        (s, d)    => ipcRenderer.invoke('fs:copy', s, d),
  move:        (s, d)    => ipcRenderer.invoke('fs:move', s, d),
  open:        (p)       => ipcRenderer.invoke('fs:open', p),
  showInFinder:(p)       => ipcRenderer.invoke('fs:showInFinder', p),
  readfile:    (p)       => ipcRenderer.invoke('fs:readfile', p),
  confirm:     (m, d)    => ipcRenderer.invoke('dialog:confirm', m, d),

  // Android (ADB)
  adbDevices:  ()              => ipcRenderer.invoke('adb:devices'),
  adbReaddir:  (s, p)          => ipcRenderer.invoke('adb:readdir', s, p),
  adbMkdir:    (s, p)          => ipcRenderer.invoke('adb:mkdir', s, p),
  adbRename:   (s, o, n)       => ipcRenderer.invoke('adb:rename', s, o, n),
  adbDelete:   (s, p)          => ipcRenderer.invoke('adb:delete', s, p),
  adbPull:     (s, remote, local) => ipcRenderer.invoke('adb:pull', s, remote, local),
  adbPush:     (s, local, remote) => ipcRenderer.invoke('adb:push', s, local, remote),
  adbReadfile: (s, p)          => ipcRenderer.invoke('adb:readfile', s, p),
});
