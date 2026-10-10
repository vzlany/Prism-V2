'use strict';

const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, nativeTheme, powerSaveBlocker, screen, shell, Notification } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Tools = require('./tools');
const Browser = require('./browser');
const LLM = require('./llm');
const MCP = require('./mcp');
const Memory = require('./memory');
const Instructions = require('./instructions');
const Skills = require('./skills');
const Discord = require('./discord');
const Updater = require('./updater');
const CliCommand = require('./cli-command');
const Server = require('./server');

const APP_ID = 'com.prismv2.app';
// Set when the app is really quitting (tray -> Quit, update install, system shutdown): only
// then does the window's close actually close it.
let quitting = false;
// Prism V2 is the V2 fork of Prism: it keeps its data under its own name, and a machine that
// already ran Prism has its folder copied over once, so chats, keys, memory and MCP config
// carry on here.
const APP_NAME = 'Prism V2';
const DATA_ROOT = path.join(app.getPath('appData'), APP_NAME);
// Profiles: prism --profile work keeps a separate workspace (chats, memory, keys, MCP config).
const PROFILE = (() => {
 const at = process.argv.indexOf('--profile');
 const value = at >= 0 ? String(process.argv[at + 1] || '').trim() : '';
 return /^[a-z0-9-]{1,24}$/.test(value.toLowerCase()) ? value.toLowerCase() : '';
})();
// Settings -> Auto can start the app with Windows, optionally straight into the tray.
const HIDDEN = process.argv.includes('--hidden');
function inheritLegacyData() {
 const target = PROFILE ? `${DATA_ROOT}-${PROFILE}` : DATA_ROOT;
 const legacy = path.join(app.getPath('appData'), PROFILE ? `Prism-${PROFILE}` : 'Prism');
 try {
  if (fs.existsSync(target) || !fs.existsSync(legacy)) return;
  // Only the things worth carrying: chats, keys, memory, MCP config and the small
  // localStorage store (effects, sounds, drafts). Caches are left behind.
  const keep = ['store', 'mcp.json', 'memory.json', 'discord.json', 'skills', 'Local Storage', 'Session Storage'];
  fs.mkdirSync(target, { recursive: true });
  for (const name of keep) {
   const from = path.join(legacy, name);
   if (!fs.existsSync(from)) continue;
   try { fs.cpSync(from, path.join(target, name), { recursive: true }); } catch {}
  }
  console.log(`[data] copied the old Prism data into ${target}`);
 } catch (error) {
  console.log('[data] could not copy the old Prism data:', error.message);
 }
}
inheritLegacyData();
if (PROFILE) app.setPath('userData', PROFILE ? `${DATA_ROOT}-${PROFILE}` : DATA_ROOT);
const ROOT = path.join(__dirname, '..');
// Windows takes the .ico; macOS and Linux take the .png.
const ICON = path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const CHAT_BG = '#191919';
const TITLE_BAR = { height: 36, symbolColor: '#9a9a9a' };
const STORE_KEY = /^[a-z0-9_-]+(\/[a-z0-9_-]+)?$/;

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
// Both the packaged build and a development checkout claim com.prismv2.app: Windows dresses
// the taskbar button with the icon of the Start Menu shortcut that carries the same identity
// (`installIdentityShortcut`), and that is what gives a checkout the app's own icon instead
// of Electron's.
app.setAppUserModelId(APP_ID);
nativeTheme.themeSource = 'dark';
Menu.setApplicationMenu(null);

function createShortcut() {
 const link = path.join(app.getPath('desktop'), 'Prism V2.lnk');
 const ok = shell.writeShortcutLink(link, 'create', {
  target: process.execPath,
  args: `"${ROOT}"`,
  cwd: ROOT,
  icon: ICON,
  iconIndex: 0,
  appUserModelId: APP_ID,
  description: 'Prism V2',
 });
 console.log(ok ? `Shortcut: ${link}` : 'Could not create the shortcut');
}

// Windows takes the taskbar and toast icon from the identity the window claims (its AppUser
// Model ID), and that identity is only dressed when a Start Menu shortcut with the same id
// and the app's icon exists. In a packaged build the installer makes one; a development
// checkout gets one here, so both the taskbar and the notifications wear Prism's icon
// instead of Electron's.
function installIdentityShortcut() {
 if (process.platform !== 'win32') return;
 try {
  const dir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  fs.mkdirSync(dir, { recursive: true });
  shell.writeShortcutLink(path.join(dir, 'Prism V2.lnk'), 'create', {
   target: process.execPath,
   args: `"${ROOT}"`,
   cwd: ROOT,
   icon: ICON,
   iconIndex: 0,
   appUserModelId: APP_ID,
   description: 'Prism V2',
  });
 } catch {}
}

const storeDir = () => path.join(app.getPath('userData'), 'store');
const writes = new Map();

function storeFile(key) {
 if (typeof key !== 'string' || !STORE_KEY.test(key)) throw new Error(`Bad store key: ${key}`);
 return path.join(storeDir(), `${key}.json`);
}

async function readStore(key) {
 try {
  return JSON.parse(await fs.promises.readFile(storeFile(key), 'utf8'));
 } catch (error) {
  if (error.code === 'ENOENT') return null;
  throw error;
 }
}

function writeStore(key, value) {
 const file = storeFile(key), data = JSON.stringify(value);
 const next = (writes.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.promises.writeFile(temp, data, 'utf8');
  await fs.promises.rename(temp, file);
 });
 writes.set(file, next);
 next.finally(() => { if (writes.get(file) === next) writes.delete(file); }).catch(() => {});
 return next;
}

async function removeStore(key) {
 const file = storeFile(key);
 await (writes.get(file) || Promise.resolve()).catch(() => {});
 await fs.promises.rm(file, { force: true });
}

// The app and `prism web` share the store folder but run as separate processes: a watcher
// tells this window when the other one wrote the index, so a project made in one place
// shows up in the other without a restart, and vice versa.
function watchStore(win) {
 try {
  const dir = storeDir();
  fs.mkdirSync(dir, { recursive: true });
  let timer = 0, stamp = '';
  const chatTimers = new Map();
  fs.watch(dir, { recursive: true }, (event, name) => {
   const file = String(name || '').replace(/\\/g, '/');
   const chat = /(?:^|\/)chats\/([a-z0-9_-]+)\.json$/i.exec(file);
   if (chat) {
    const id = chat[1];
    clearTimeout(chatTimers.get(id));
    chatTimers.set(id, setTimeout(() => {
     chatTimers.delete(id);
     if (!win.isDestroyed()) win.webContents.send('chat:changed', id);
    }, 150));
    return;
   }
   clearTimeout(timer);
   timer = setTimeout(() => {
    let next = '';
    try {
     const stat = fs.statSync(path.join(dir, 'index.json'));
     next = `${stat.mtimeMs}:${stat.size}`;
    } catch {}
    if (!next || next === stamp) return;
    stamp = next;
    if (!win.isDestroyed()) win.webContents.send('store:changed');
   }, 120);
  });
 } catch {}
}

// The turns this window is running are mirrored into presence.json; `prism web` reads it and
// shows the phone the same busy chats the app shows. The file is kept fresh while runs live
// so a reader can tell a live run from one left behind by a closed app.
const presenceRuns = new Map();
let presenceTimer = 0;
function flushPresence() {
 presenceTimer = 0;
 const file = path.join(app.getPath('userData'), 'presence.json');
 fs.promises.writeFile(file, JSON.stringify({ at: Date.now(), runs: [...presenceRuns.values()] })).catch(() => {});
}
function touchPresence() {
 clearTimeout(presenceTimer);
 presenceTimer = setTimeout(flushPresence, 250);
}
ipcMain.on('presence:set', (event, id, info) => {
 if (!fromApp(event) || !id) return;
 if (info) presenceRuns.set(id, { id, ...info, at: Date.now() });
 else presenceRuns.delete(id);
 touchPresence();
});

// A heartbeat so `prism web` knows the app is running and can hand it the turns started on
// the website (and only then: without the app, the web runs them itself). With no page
// connected it is a disk write for nobody, so it only runs while a page is open; the web
// server's web-clients.json changing wakes it the moment one connects.
function webClientsOpen() {
 try {
  const data = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'web-clients.json'), 'utf8'));
  return Array.isArray(data?.clients) && data.clients.some(entry => Date.now() - (Number(entry?.at) || 0) < 120000);
 } catch {
  return false;
 }
}
function beatApp() {
 if (!webClientsOpen()) return;
 const file = path.join(app.getPath('userData'), 'app.json');
 fs.promises.writeFile(file, JSON.stringify({ at: Date.now(), version: app.getVersion(), pid: process.pid })).catch(() => {});
}
beatApp();
setInterval(beatApp, 10000);
try {
 fs.watch(app.getPath('userData'), (event, name) => { if (name === 'web-clients.json') beatApp(); });
} catch {}

// --------------------------------------------------------------- Settings -> Auto + tray
// Launching with Windows (optionally hidden, straight into the tray), and running the web
// server with the app so the phone can reach it without a terminal.
function autoFile() {
 return path.join(app.getPath('userData'), 'store', 'auto.json');
}
function readAuto() {
 try { return JSON.parse(fs.readFileSync(autoFile(), 'utf8')) || {}; } catch { return {}; }
}
function writeAuto(patch) {
 const next = { ...readAuto(), ...patch };
 try {
  fs.mkdirSync(path.dirname(autoFile()), { recursive: true });
  fs.writeFileSync(autoFile(), JSON.stringify(next));
 } catch {}
 return next;
}
// Windows' own Run key (what setLoginItemSettings writes) points at electron.exe, so Task
// Manager's startup list shows "electron.exe" with Electron's icon. A shortcut in the
// Startup folder wears Prism V2's own name and icon instead, and Task Manager lists it by
// the shortcut — where Windows expects startup apps to live. Other platforms keep the
// native login item.
function startupLink() {
 return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Prism V2.lnk');
}
function writeStartupShortcut(hidden) {
 const link = startupLink();
 fs.mkdirSync(path.dirname(link), { recursive: true });
 const args = app.isPackaged ? (hidden ? ['--hidden'] : []) : [`"${ROOT}"`, ...(hidden ? ['--hidden'] : [])];
 try { fs.rmSync(link, { force: true }); } catch {}
 return shell.writeShortcutLink(link, 'create', {
  target: process.execPath,
  args: args.join(' '),
  cwd: ROOT,
  icon: ICON,
  iconIndex: 0,
  appUserModelId: APP_ID,
  description: 'Prism V2',
 });
}
function removeStartupShortcut() {
 try { fs.rmSync(startupLink(), { force: true }); } catch {}
}
function applyAuto(auto = readAuto()) {
 try {
  if (process.platform === 'win32') {
   // Never leave the old registry entry behind as a second, ugly startup item.
   app.setLoginItemSettings({ openAtLogin: false });
   if (auto.login) writeStartupShortcut(Boolean(auto.hidden));
   else removeStartupShortcut();
   return;
  }
  if (process.platform === 'linux') {
   // Linux starts with the session through an XDG desktop entry (Settings -> Server shows
   // the file); --hidden goes straight into the tray, the web server and the bot stay up.
   const args = app.isPackaged ? [] : [ROOT];
   if (auto.hidden) args.push('--hidden');
   Server.applyLinuxAutostart(Boolean(auto.login), args);
   return;
  }
  app.setLoginItemSettings({
   openAtLogin: Boolean(auto.login),
   path: process.execPath,
   args: auto.login && auto.hidden ? ['--hidden'] : [],
  });
 } catch {}
}
let webChild = null;
function webPort(auto = readAuto()) {
 return Math.max(1, Math.min(65535, Number(auto.port) || 8787));
}
function stopWeb() {
 if (!webChild) return;
 try { webChild.kill(); } catch {}
 webChild = null;
}
function startWeb(auto = readAuto()) {
 if (webChild || !auto.web) return;
 const script = path.join(ROOT, 'tools', 'web-server.mjs');
 try {
  webChild = spawn(process.execPath, [script, '--port', String(webPort(auto)), '--host', '0.0.0.0', '--no-open', ...(PROFILE ? ['--profile', PROFILE] : [])], {
   env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
   windowsHide: true,
   stdio: 'ignore',
  });
  webChild.on('exit', () => { webChild = null; });
  console.log(`[auto] web server on port ${webPort(auto)}`);
 } catch (error) {
  console.log('[auto] could not start the web server:', error.message);
 }
}
// The Discord bridge is a separate Node process (Electron runs it as Node). It shows the bot
// online with a status, answers DMs with the app's equipped keys and the same tools.
let botChild = null;
function stopBot() {
 if (!botChild) return;
 try { botChild.kill(); } catch {}
 botChild = null;
}
function startBot(auto = readAuto()) {
 if (botChild || !auto.bot) return;
 const script = path.join(ROOT, 'tools', 'discord-bridge.mjs');
 try {
  botChild = spawn(process.execPath, [script, ...(PROFILE ? ['--profile', PROFILE] : [])], {
   env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
   windowsHide: true,
   stdio: 'ignore',
  });
  botChild.on('exit', code => { botChild = null; console.log(`[auto] discord bot stopped${code ? ` (${code})` : ''}`); });
  console.log('[auto] discord bot started');
 } catch (error) {
  console.log('[auto] could not start the discord bot:', error.message);
 }
}
ipcMain.handle('auto:get', event => {
 if (!fromApp(event)) return null;
 const auto = readAuto();
 return { login: !!auto.login, hidden: !!auto.hidden, web: !!auto.web, bot: !!auto.bot, awake: auto.awake !== false, port: webPort(auto), webRunning: Boolean(webChild), botRunning: Boolean(botChild) };
});
// The web server lists its live connections in web-clients.json (it may also be running
// from a terminal, not started by this app): the Auto page shows the port and the devices.
ipcMain.handle('auto:clients', event => {
 if (!fromApp(event)) return null;
 try {
  const data = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'web-clients.json'), 'utf8'));
  const clients = (Array.isArray(data?.clients) ? data.clients : []).filter(entry => entry?.ip && Date.now() - (Number(entry.at) || 0) < 120000);
  return { port: Number(data?.port) || webPort(), host: String(data?.host || ''), at: Number(data?.at) || 0, clients };
 } catch {
  return { port: webPort(), host: '', at: 0, clients: [] };
 }
});
ipcMain.handle('auto:set', (event, patch) => {
 if (!fromApp(event)) return null;
 const auto = writeAuto({
  ...(typeof patch?.login === 'boolean' ? { login: patch.login } : {}),
  ...(typeof patch?.hidden === 'boolean' ? { hidden: patch.hidden } : {}),
  ...(typeof patch?.web === 'boolean' ? { web: patch.web } : {}),
  ...(typeof patch?.bot === 'boolean' ? { bot: patch.bot } : {}),
  ...(typeof patch?.awake === 'boolean' ? { awake: patch.awake } : {}),
  ...(patch?.port !== undefined ? { port: webPort({ port: patch.port }) } : {}),
 });
 applyAuto(auto);
 if (auto.web) { stopWeb(); startWeb(auto); }
 else stopWeb();
 if (auto.bot) { stopBot(); startBot(auto); }
 else stopBot();
 // A turn is running right now and the setting just changed: apply it at once.
 if (turnsActive && auto.awake === false) keepAwake(false);
 else if (turnsActive) keepAwake(true);
 return { login: !!auto.login, hidden: !!auto.hidden, web: !!auto.web, bot: !!auto.bot, awake: auto.awake !== false, port: webPort(auto), webRunning: Boolean(webChild), botRunning: Boolean(botChild) };
});

let tray = null;
function showWindow(win) {
 if (!win || win.isDestroyed()) return;
 if (win.isMinimized()) win.restore();
 win.show();
 win.focus();
}
function createTray(win) {
 try {
  tray = new Tray(ICON);
  tray.setToolTip('Prism V2');
  const refresh = () => {
   if (!tray || tray.isDestroyed()) return;
   const runs = presenceRuns.size;
   tray.setToolTip(runs ? `Prism V2 — ${runs} working` : 'Prism V2');
   tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Prism', click: () => showWindow(win) },
    { label: 'Open web', click: () => {
     const auto = readAuto();
     if (!webChild) startWeb({ ...auto, web: true });
     shell.openExternal(`http://localhost:${webPort(auto)}/`);
    } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
   ]));
  };
  refresh();
  setInterval(refresh, 10000);
  tray.on('click', () => {
   if (!win || win.isDestroyed()) return;
   if (win.isVisible() && win.isFocused()) win.hide();
   else showWindow(win);
  });
 } catch (error) {
  console.log('[tray] could not create the tray icon:', error.message);
 }
}

// The other half of that bridge: turns the website asked this app to run. Each request is a
// small file in userData/delegate; it is read, handed to the window and deleted.
function watchDelegate(win) {
 const dir = path.join(app.getPath('userData'), 'delegate');
 const seen = new Set();
 const take = () => {
  let names = [];
  try { names = fs.readdirSync(dir).filter(name => name.endsWith('.json')); } catch { return; }
  for (const name of names) {
   const file = path.join(dir, name);
   let request = null;
   try { request = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
   try { fs.rmSync(file, { force: true }); } catch {}
   if (!request?.chatId || seen.has(request.id || name)) continue;
   seen.add(request.id || name);
   if (!win.isDestroyed()) win.webContents.send('turn:request', request);
  }
 };
 try {
  fs.mkdirSync(dir, { recursive: true });
  fs.watch(dir, () => setTimeout(take, 150));
  take();
 } catch {}
}

function external(url) {
 if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
}

// A chat finished while the app was not in front: the taskbar button flashes natively and a
// badge blinks on it — green when the work completed, red when it failed or errored (the
// native flash respects Windows' own "flash taskbar" setting, the badge always shows).
// Focusing the window clears both. Subagents never get here: chat.js keeps them silent.
const ATTENTION = { every: 600, icon: null, ok: null, timer: 0 };
function stopAttention(win) {
 clearInterval(ATTENTION.timer);
 ATTENTION.timer = 0;
 if (!win || win.isDestroyed()) return;
 try { win.setOverlayIcon(null, ''); } catch {}
 try { win.flashFrame(false); } catch {}
}
function startAttention(win, bad = true) {
 if (!win || win.isDestroyed() || process.platform !== 'win32') return;
 ATTENTION.icon ||= nativeImage.createFromPath(path.join(__dirname, 'attention.png'));
 ATTENTION.ok ||= nativeImage.createFromPath(path.join(__dirname, 'attention-ok.png'));
 const badge = bad ? ATTENTION.icon : ATTENTION.ok;
 clearInterval(ATTENTION.timer);
 let on = false;
 const tick = () => {
  on = !on;
  try { win.setOverlayIcon(on ? badge : null, on ? (bad ? 'Conversation failed' : 'Conversation finished') : ''); } catch {}
 };
 tick();
 ATTENTION.timer = setInterval(tick, ATTENTION.every);
 try { win.flashFrame(true); } catch {}
}

function createWindow() {
 // The window follows the monitor: a little wider and taller than the old fixed 1280×840,
 // with sensible bounds for very small and very large screens.
 const { workAreaSize } = screen.getPrimaryDisplay();
 const width = Math.min(Math.max(Math.round(workAreaSize.width * 0.8), 1280), 1720);
 const height = Math.min(Math.max(Math.round(workAreaSize.height * 0.88), 800), 1180);
 const win = new BrowserWindow({
  width,
  height,
  center: true,
  minWidth: 760,
  minHeight: 540,
  show: false,
  title: 'Prism V2',
  icon: ICON,
  backgroundColor: CHAT_BG,
  // Linux window managers draw their own title bar; Windows and macOS get the app's own.
  ...(process.platform === 'linux' ? {} : {
   titleBarStyle: 'hidden',
   titleBarOverlay: { color: CHAT_BG, symbolColor: TITLE_BAR.symbolColor, height: TITLE_BAR.height },
  }),
  webPreferences: {
   preload: path.join(__dirname, 'preload.js'),
   contextIsolation: true,
   sandbox: true,
   spellcheck: true,
   webviewTag: true,
   // Prism's own chimes must play even when the window is not focused. A hidden window
   // throttles rAF/timers (tray stays cool); while a turn is running chat.js flips that off
   // through app:set-background-throttle, so a reply in the tray still streams at full rate.
   autoplayPolicy: 'no-user-gesture-required',
   backgroundThrottling: true,
  },
 });
 win.once('ready-to-show', () => { if (!HIDDEN) win.show(); });
 // Coming back to the app stops the alert: the user has seen it.
 win.on('focus', () => stopAttention(win));
 win.on('closed', () => stopAttention(win));
 // Closing the window hides it: Prism keeps running in the tray, the web server and the
 // Discord bot stay up, and a running turn is not interrupted. Tray -> Quit really quits.
 win.on('close', event => {
  if (quitting) return;
  event.preventDefault();
  win.hide();
 });
 // On Windows the taskbar icon of an unpackaged app otherwise stays Electron's; set it
 // explicitly as well as through the Start Menu identity shortcut.
 try { win.setIcon(nativeImage.createFromPath(ICON)); } catch {}
 // Renderer warnings and errors land in the app's log, so a silent delegated run is visible.
 win.webContents.on('console-message', (event, level, message) => {
  const text = message || event?.message || '';
  const where = event?.sourceId ? ` (${event.sourceId}:${event.lineNumber})` : '';
  if (text) console.log(`[renderer] ${text}${where}`);
 });
 win.webContents.on('will-attach-webview', (event, prefs, params) => {
  if (!Browser.guard(win.webContents, prefs, params)) event.preventDefault();
 });
 win.webContents.on('did-attach-webview', (event, guest) => Browser.adopt(win.webContents, guest));
 win.webContents.setWindowOpenHandler(({ url }) => {
  external(url);
  return { action: 'deny' };
 });
 win.webContents.on('will-navigate', (event, url) => {
  if (url === win.webContents.getURL()) return;
  event.preventDefault();
  external(url);
 });
 win.webContents.on('before-input-event', (event, input) => {
  if (input.type !== 'keyDown') return;
  const key = input.key.toLowerCase();
  // Cmd on macOS, Ctrl elsewhere.
  const command = input.meta || input.control;
  if (key === 'f12' || (command && input.shift && key === 'i') || (input.meta && input.alt && key === 'i')) {
   win.webContents.toggleDevTools();
   event.preventDefault();
  } else if (key === 'f5' || (command && !input.shift && key === 'r')) {
   win.webContents.reload();
   event.preventDefault();
  }
 });
 win.loadFile(path.join(ROOT, 'app', 'index.html'));
 return win;
}

// A path written in a message (a folder the agent made, a file it built): the app can say
// whether it exists and open it in Explorer, so the reply can carry a real link.
ipcMain.handle('path:info', async (event, target, cwd) => {
 if (!fromApp(event) || typeof target !== 'string' || !target) return null;
 const full = path.isAbsolute(target) ? target : (typeof cwd === 'string' && cwd ? path.join(cwd, target) : target);
 try {
  const stat = await fs.promises.stat(full);
  return { path: full, exists: true, dir: stat.isDirectory(), image: /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(full), name: path.basename(full) };
 } catch {
  return { path: full, exists: false, dir: false, image: false, name: path.basename(full) };
 }
});
ipcMain.handle('path:open', (event, target, cwd) => {
 if (!fromApp(event) || typeof target !== 'string' || !target) return false;
 const full = path.isAbsolute(target) ? target : (typeof cwd === 'string' && cwd ? path.join(cwd, target) : target);
 shell.openPath(full).catch(() => {});
 return true;
});

// A workspace folder without picking one: the shared Chats folder (all "Chat workspace"
// conversations live together under one heading instead of one timestamped folder each),
// or the shared Public one.
ipcMain.handle('workspace:create', async (event, kind) => {
 if (!fromApp(event)) return null;
 const base = path.join(app.getPath('documents'), 'Prism V2');
 const name = kind === 'public' ? 'Public' : 'Chats';
 const folder = path.join(base, name);
 try {
  await fs.promises.mkdir(folder, { recursive: true });
  return { path: folder, name };
 } catch {
  return null;
 }
});

ipcMain.handle('folder:pick', async (event, defaultPath) => { const win = BrowserWindow.fromWebContents(event.sender);
 const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory', 'promptToCreate'], ...(typeof defaultPath === 'string' && defaultPath ? { defaultPath } : {}) });
 if (result.canceled || !result.filePaths.length) return null;
 const folder = result.filePaths[0];
 await fs.promises.mkdir(folder, { recursive: true });
 return { path: folder, name: path.basename(folder) || folder };
});

ipcMain.handle('folder:reveal', (event, folder) => typeof folder === 'string' && shell.openPath(folder));
// A file the agent attached: "Download" asks where to keep it and copies the real bytes.
ipcMain.handle('file:save', async (event, file, name) => {
 if (!fromApp(event) || typeof file !== 'string') return null;
 const win = BrowserWindow.fromWebContents(event.sender);
 const label = String(name || path.basename(file) || 'file').replace(/[\\/:*?"<>|]/g, '-');
 const result = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), label) });
 if (result.canceled || !result.filePath) return null;
 await fs.promises.copyFile(file, result.filePath);
 return result.filePath;
});
ipcMain.handle('store:read', (event, key) => readStore(key));
ipcMain.handle('store:write', (event, key, value) => writeStore(key, value));
ipcMain.handle('store:remove', (event, key) => removeStore(key));
ipcMain.on('window:titlebar', (event, color) => {
 const win = BrowserWindow.fromWebContents(event.sender);
 if (process.platform === 'linux') return;
 if (win && typeof win.setTitleBarOverlay === 'function' && typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) win.setTitleBarOverlay({ color, symbolColor: TITLE_BAR.symbolColor, height: TITLE_BAR.height });
});

ipcMain.on('notify', (event, payload) => {
 const win = BrowserWindow.fromWebContents(event.sender);
 // Only when the window is not in front: an overnight run should reach the user, an open app should not buzz.
 if (!win || win.isFocused()) return;
 const title = typeof payload?.title === 'string' && payload.title.trim() ? payload.title.trim().slice(0, 120) : 'Prism V2';
 const body = typeof payload?.body === 'string' ? payload.body.slice(0, 200) : 'completed';
 try {
  new Notification({ title, body, icon: ICON, silent: false }).show();
 } catch {}
 // The app is in the background: blink the taskbar button until the window is focused —
 // green for a clean finish, red for a failure or error.
 startAttention(win, body !== 'completed');
 // The Discord DM is a separate switch ("DM me on Discord" in the mode menu) and is sent by
 // the discord:dm handler below; this toast must not also DM, or every finish arrives twice.
});

const fromApp = event => event.sender.getType() === 'window' && event.senderFrame?.url.startsWith('file:');
ipcMain.handle('tool:run', (event, id, name, args, cwd) => fromApp(event) ? Tools.runTool(id, name, args, cwd, event.sender) : { error: 'Not allowed' });
ipcMain.handle('app:version', event => fromApp(event) ? app.getVersion() : null);
// A running turn turns throttling off; the last one to finish turns it back on. While any
// turn runs the display is also kept awake (Settings -> Auto can turn that off), so a long
// task is not interrupted by the screen locking.
let turnsActive = false;
let sleepBlocker = 0;
function keepAwake(on) {
 if (on && !sleepBlocker) { try { sleepBlocker = powerSaveBlocker.start('prevent-display-sleep'); } catch {} }
 else if (!on && sleepBlocker) { try { powerSaveBlocker.stop(sleepBlocker); } catch {} sleepBlocker = 0; }
}
ipcMain.handle('app:set-background-throttle', (event, on) => {
 if (!fromApp(event)) return false;
 for (const win of BrowserWindow.getAllWindows()) win.webContents.setBackgroundThrottling(Boolean(on));
 turnsActive = !on;
 keepAwake(turnsActive && readAuto().awake !== false);
 return true;
});
ipcMain.handle('update:check', async event => {
 if (!fromApp(event)) return null;
 try {
  const info = await Updater.check();
  if (!info) return { latest: true, current: app.getVersion() };
  const win = BrowserWindow.fromWebContents(event.sender);
  if (await Updater.prompt(win, info)) {
   if (info.asset) Updater.install(info).catch(() => shell.openExternal(info.page));
   else shell.openExternal(info.page);
  }
  return { version: info.version };
 } catch (error) {
  return { error: String(error?.message || error) };
 }
});
// Settings -> About: the update switches, the GitHub token, and Update now.
ipcMain.handle('update:params', event => (fromApp(event) ? Updater.params() : null));
ipcMain.handle('update:set', (event, patch) => (fromApp(event) ? Updater.updateSettings(patch) : null));
ipcMain.handle('update:install', async event => {
 if (!fromApp(event)) return null;
 const result = await Updater.updateNow({ force: false });
 return { ...result, message: Updater.describe(result) };
});
// The AI's update_prism tool: same path, optionally forced.
ipcMain.handle('update:run', async (event, args) => {
 if (!fromApp(event)) return null;
 const result = await Updater.updateNow({ force: args?.force === true });
 return { ...result, message: Updater.describe(result) };
});
ipcMain.on('browser:shown', (event, value) => { if (fromApp(event)) Browser.setShown(value); });
ipcMain.handle('tool:cancel', (event, id) => { if (fromApp(event)) Tools.cancel(id); });
ipcMain.handle('tool:environment', event => fromApp(event) ? Tools.environment() : null);
LLM.register(fromApp);
MCP.register(fromApp);
Memory.register(fromApp);
Instructions.register(fromApp);
Skills.register(fromApp);
Discord.register(fromApp);
Server.register(fromApp, ipcMain);
// The mode menu's "DM me on Discord when done" switch: a finished reply sends its own DM,
// whether or not the Windows toast was shown.
ipcMain.handle('discord:dm', (event, payload) => {
 if (!fromApp(event)) return { ok: false };
 return Discord.send(
  typeof payload?.title === 'string' && payload.title.trim() ? payload.title.trim() : 'Prism V2',
  typeof payload?.outcome === 'string' ? payload.outcome : 'completed',
  typeof payload?.summary === 'string' ? payload.summary : '',
  Array.isArray(payload?.files) ? payload.files : [],
  typeof payload?.chatId === 'string' ? payload.chatId : '',
 );
});
// The agent talking to the user on Discord on its own (a <send_discord_message> block).
ipcMain.handle('discord:message', (event, payload) => {
 if (!fromApp(event)) return { ok: false };
 return Discord.note(
  typeof payload?.text === 'string' ? payload.text : '',
  Array.isArray(payload?.files) ? payload.files : [],
 );
});
ipcMain.handle('profile:info', event => {
 if (!fromApp(event)) return { name: PROFILE || 'default', profiles: [] };
 let profiles = [];
 try {
  profiles = fs.readdirSync(app.getPath('appData'), { withFileTypes: true })
   .filter(entry => entry.isDirectory() && (entry.name === APP_NAME || entry.name.startsWith(`${APP_NAME}-`)))
   .map(entry => (entry.name === APP_NAME ? 'default' : entry.name.slice(APP_NAME.length + 1)))
   .filter(name => /^[a-z0-9-]{1,24}$/.test(name));
 } catch {}
 return { name: PROFILE || 'default', profiles: [...new Set(['default', PROFILE, ...profiles].filter(Boolean))] };
});
ipcMain.handle('profile:switch', (event, name) => {
 if (!fromApp(event)) return false;
 const target = String(name || '').toLowerCase() === 'default' ? '' : String(name || '').toLowerCase();
 if (target && !/^[a-z0-9-]{1,24}$/.test(target)) return false;
 const args = [];
 const argv = process.argv.slice(1);
 for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--profile') { i++; continue; }
  if (/^--profile=/.test(argv[i])) continue;
  args.push(argv[i]);
 }
 if (target) args.push('--profile', target);
 app.relaunch({ args });
 app.exit(0);
 return true;
});

if (process.argv.includes('--create-shortcut')) {
 app.whenReady().then(() => {
  createShortcut();
  app.quit();
 });
} else if (!app.requestSingleInstanceLock()) {
 app.quit();
} else {
 let win = null;
 app.on('second-instance', () => {
  if (!win) return;
  // The window may be hidden in the tray, not minimized: show it again.
  showWindow(win);
 });
 app.whenReady().then(() => {
  Browser.setup();
  installIdentityShortcut();
  // Installed builds put the `prism` command in the terminal for the current user.
  if (CliCommand.install()) console.log('The prism command is now available in terminals');
  win = createWindow();
  watchStore(win);
  watchDelegate(win);
  createTray(win);
  applyAuto();
  startWeb();
  startBot();
  // Old trees from an earlier Linux self-update are cleared once nothing runs from them.
  if (app.isPackaged && process.platform === 'linux') Updater.prune();
  Updater.start({ isIdle: () => presenceRuns.size === 0 });
  MCP.init().catch(() => {});
  win.on('closed', () => {
   win = null;
   Tools.cancelAll();
   LLM.cancelAll();
   MCP.stopAll();
  });
 });
 app.on('window-all-closed', () => app.quit());
 app.on('before-quit', event => {
  quitting = true;
  Tools.cancelAll();
  MCP.stopAll();
  stopWeb();
  stopBot();
  if (!writes.size) return;
  event.preventDefault();
  Promise.allSettled([...writes.values()]).then(() => app.quit());
 });
}
