import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  getInfo: (url) => ipcRenderer.invoke('api:get-info', url),
  getLink: (url, formatId) => ipcRenderer.invoke('api:get-link', url, formatId),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  downloadStart: (url) => ipcRenderer.invoke('download:start', url),
})
