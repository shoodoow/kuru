// The few things the page may ask of the desktop app. Read by apps/mobile/src/desk/notify-web.ts
// and by server.html.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kuruDesktop", {
  platform: process.platform,
  setBadge: (count) => ipcRenderer.send("badge", Number(count) || 0),
  focus: () => ipcRenderer.send("focus"),
  setServer: (url) => ipcRenderer.invoke("server:set", String(url)),
});
