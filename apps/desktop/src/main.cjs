// Kuru for Mac and Windows.
// The app is the web app the server serves at <server>/app, shown in a window.
// Serving it from the server keeps sign-in a plain same-site cookie, and the
// desktop app is always as new as the server. This file adds what a browser
// tab lacks: a window and menu, a Dock/taskbar badge, right-click menus,
// links that open in the real browser, and a page to pick the server.

const { app, BrowserWindow, Menu, clipboard, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_SERVER = process.env.KURU_SERVER_URL || "https://kuru.octessa.com";
const SETTINGS_FILE = path.join(app.getPath("userData"), "settings.json");
const SERVER_PAGE = path.join(__dirname, "server.html");
const PRELOAD = path.join(__dirname, "preload.cjs");

/** @type {BrowserWindow | null} */
let win = null;

// ---- Settings: the server address and the window's size, kept between launches.

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
}

function serverUrl() {
  return readSettings().server || DEFAULT_SERVER;
}

/** "my.server.com" → "https://my.server.com". Null when it is not a web address. */
function normalizeServer(input) {
  const typed = input.trim().replace(/\/+$/, "");
  if (!typed) return null;
  const local = /^(localhost|127\.|10\.|192\.168\.)/.test(typed);
  const withScheme = /^https?:\/\//i.test(typed) ? typed : `${local ? "http" : "https"}://${typed}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return null;
  }
}

// ---- The window.

function openApp() {
  win.loadURL(`${serverUrl()}/app`);
}

function openServerPage(error) {
  win.loadFile(SERVER_PAGE, { query: { server: serverUrl(), error: error || "" } });
}

/** The address's origin, or "" when it is not a valid address. */
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function isAppAddress(url) {
  return originOf(url) === originOf(serverUrl());
}

/** Opens http(s) links in the person's browser. Anything else is ignored. */
function openOutside(url) {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}

function createWindow() {
  const bounds = readSettings().bounds || { width: 1280, height: 820 };
  win = new BrowserWindow({
    ...bounds,
    minWidth: 900, // The wide layout starts at 900 (apps/mobile/src/desk/layout.ts).
    minHeight: 600,
    title: "Kuru",
    backgroundColor: "#000000",
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
  });
  win.once("ready-to-show", () => win.show());
  win.on("close", () => writeSettings({ bounds: win.getBounds() }));
  win.on("closed", () => {
    win = null;
  });

  const contents = win.webContents;

  // The server cannot be reached: show the server page with the reason.
  contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) openServerPage(`Could not reach the server (${description}).`);
  });
  // The server answered, but has no web app built.
  contents.on("did-navigate", (_event, url, status) => {
    if (status >= 400 && isAppAddress(url)) openServerPage(`This server has no desktop app yet (error ${status}).`);
  });

  // The window stays on the app. Google sign-in passes through Google's page;
  // any other link opens in the browser.
  contents.on("will-navigate", (event, url) => {
    if (isAppAddress(url) || url.startsWith("file:") || originOf(url) === "https://accounts.google.com") return;
    event.preventDefault();
    openOutside(url);
  });
  // Files the app opens (a PDF, a picture) get a window of their own; links go to the browser.
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("blob:") || isAppAddress(url)) return { action: "allow" };
    openOutside(url);
    return { action: "deny" };
  });

  contents.on("context-menu", (_event, params) => {
    const menu = contextMenu(params);
    if (menu.length > 0) Menu.buildFromTemplate(menu).popup({ window: win });
  });

  openApp();
}

/**
 * The right-click menu for text fields, selected text, links and pictures.
 * Messages have their own menu inside the app; the app stops this one there.
 */
function contextMenu(params) {
  const items = [];
  if (params.isEditable) {
    for (const word of params.dictionarySuggestions.slice(0, 4)) {
      items.push({ label: word, click: () => win.webContents.replaceMisspelling(word) });
    }
    if (items.length > 0) items.push({ type: "separator" });
    items.push({ role: "cut" }, { role: "copy" }, { role: "paste" }, { type: "separator" }, { role: "selectAll" });
    return items;
  }
  if (params.selectionText) items.push({ role: "copy" });
  if (params.linkURL) {
    items.push({ label: "Open Link in Browser", click: () => openOutside(params.linkURL) });
    items.push({ label: "Copy Link", click: () => clipboard.writeText(params.linkURL) });
  }
  if (params.mediaType === "image" && params.srcURL) {
    items.push({ label: "Save Image As…", click: () => win.webContents.downloadURL(params.srcURL) });
    items.push({ label: "Copy Image", click: () => win.webContents.copyImageAt(params.x, params.y) });
  }
  return items;
}

// ---- The app menu: the usual one, plus a way to change the server.

function buildMenu() {
  const changeServer = { label: "Change Server…", click: () => win && openServerPage() };
  const template = [
    ...(process.platform === "darwin"
      ? [{ role: "appMenu", submenu: [{ role: "about" }, { type: "separator" }, changeServer, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] }]
      : [{ label: "File", submenu: [changeServer, { type: "separator" }, { role: "quit" }] }]),
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- Messages from the page (preload.cjs).

ipcMain.on("badge", (_event, count) => {
  // macOS and Linux show the count on the icon; Windows has no number badge.
  if (process.platform !== "win32") app.setBadgeCount(count);
});

ipcMain.on("focus", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

// Only the local server page may change the server.
const fromServerPage = (event) => event.senderFrame?.url.startsWith("file:");

ipcMain.handle("server:set", (event, input) => {
  if (!fromServerPage(event)) return { ok: false };
  const url = normalizeServer(input);
  if (!url) return { ok: false, error: "That is not a web address." };
  writeSettings({ server: url === DEFAULT_SERVER ? undefined : url });
  openApp();
  return { ok: true };
});

// ---- Start.

// Google refuses to sign in inside apps that call themselves Electron, so the
// window presents itself as the Chrome it is built on.
app.userAgentFallback = app.userAgentFallback.replace(/ (Electron|Kuru|desktop)\/\S+/g, "");

if (process.platform === "win32") app.setAppUserModelId("com.kurubot.desktop");

// One copy of the app: opening it again brings the window forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    app.on("activate", () => {
      if (!win) createWindow();
    });
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
