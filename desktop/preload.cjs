const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("orden", {
  chooseFolder: () => ipcRenderer.invoke("orden:choose-folder"),
  scan: (root) => ipcRenderer.invoke("orden:scan", root),
  apply: (root, sources) => ipcRenderer.invoke("orden:apply", root, sources),
  undoStatus: (root) => ipcRenderer.invoke("orden:undo-status", root),
  undo: (root) => ipcRenderer.invoke("orden:undo", root),
  journals: (root) => ipcRenderer.invoke("orden:journals", root),
  dupes: (root, minSize) => ipcRenderer.invoke("orden:dupes", root, minSize),
  configRead: (root) => ipcRenderer.invoke("orden:config-read", root),
  configWrite: (root, config) => ipcRenderer.invoke("orden:config-write", root, config),
});
