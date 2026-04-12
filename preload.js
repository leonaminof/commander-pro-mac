const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
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
});
