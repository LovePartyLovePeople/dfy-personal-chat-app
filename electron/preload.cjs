const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dafeiyu", {
  isDesktop: true,
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (patch) => ipcRenderer.invoke("config:set", patch),
  getAutostart: () => ipcRenderer.invoke("autostart:get"),
  setAutostart: (on) => ipcRenderer.invoke("autostart:set", on),
  copyText: (text) => ipcRenderer.invoke("clipboard:write", text),
  readText: () => ipcRenderer.invoke("clipboard:read"),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
});
