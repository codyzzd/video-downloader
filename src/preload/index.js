import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  // Settings
  getSettings:  ()     => ipcRenderer.invoke('settings:get'),
  setSettings:  (data) => ipcRenderer.invoke('settings:set', data),
  chooseFolder: ()     => ipcRenderer.invoke('dialog:choose-folder'),

  // Downloads
  downloadVideo:  (opts) => ipcRenderer.invoke('download:video', opts),
  cancelDownload: (id)   => ipcRenderer.invoke('download:cancel', id),

  // Download events (renderer side)
  onDownloadProgress: (cb) => ipcRenderer.on('download:progress', (_, d) => cb(d)),
  onDownloadDone:     (cb) => ipcRenderer.on('download:done',     (_, d) => cb(d)),
  onDownloadError:    (cb) => ipcRenderer.on('download:error',    (_, d) => cb(d)),
  offDownloadEvents:  ()   => {
    ipcRenderer.removeAllListeners('download:progress')
    ipcRenderer.removeAllListeners('download:done')
    ipcRenderer.removeAllListeners('download:error')
  },

  // Shell
  showInFolder:  (path) => ipcRenderer.invoke('shell:show-in-folder', path),
  openExternal:  (url)  => ipcRenderer.invoke('shell:open-external', url),
})
