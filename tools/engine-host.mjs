// The shared stand-in for Electron behind the Node tools (`prism web`, `prism discord`).
// The modules in desktop/ load behind a require hook that fakes the Electron pieces
// (app paths, ipcMain, shell, notifications), so tools, models, MCP servers and memory
// behave exactly like they do in the app.
import { Module, createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, cpSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute as isAbsolutePath, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function createEngineHost({ profile = "", webPort = 0 } = {}) {
 const APP_DATA = process.env.APPDATA || join(process.env.HOME || ".", ".config");
 const USER_DATA = join(APP_DATA, "Prism V2" + (profile ? `-${profile}` : ""));
 // A machine coming from Prism keeps its chats, keys and memory: copy what matters once.
 const legacy = join(APP_DATA, "Prism" + (profile ? `-${profile}` : ""));
 try {
  if (!existsSync(USER_DATA) && existsSync(legacy)) {
   mkdirSync(USER_DATA, { recursive: true });
   for (const name of ["store", "mcp.json", "memory.json", "discord.json", "skills", "Local Storage", "Session Storage"]) {
    if (!existsSync(join(legacy, name))) continue;
    try { cpSync(join(legacy, name), join(USER_DATA, name), { recursive: true }); } catch {}
   }
  }
 } catch {}
 const home = process.env.USERPROFILE || process.env.HOME || ".";
 const paths = {
  userData: USER_DATA,
  appData: APP_DATA,
  home,
  // The same Documents folder Electron hands the app (app.getPath('documents')): the shared
  // Chats/Public workspaces must resolve to one path in both engines, or the list shows them twice.
  documents: process.env.XDG_DOCUMENTS_DIR || join(home, "Documents"),
  temp: process.env.TEMP || "/tmp",
 };

 const handlers = new Map();
 const listeners = new Map();
 const noop = () => {};
 let sender = { send: noop, isDestroyed: () => false };
 const fakeEvent = { get sender() { return sender; } };

 const electron = {
  app: {
   getPath: name => paths[name] || USER_DATA,
   getVersion: () => "1.2.0-cli",
   getName: () => "Prism V2",
   getAppPath: () => ROOT,
   isPackaged: false,
   setPath: noop,
   on: noop,
   whenReady: () => Promise.resolve(),
   quit: noop,
   relaunch: noop,
  },
  ipcMain: {
   handle: (channel, fn) => handlers.set(channel, fn),
   on: (channel, fn) => listeners.set(channel, fn),
   emit: (channel, ...eventArgs) => {
    const listener = listeners.get(channel);
    if (listener) listener(fakeEvent, ...eventArgs);
   },
  },
  shell: {
   openPath: target => {
    const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", target]] : process.platform === "darwin" ? ["open", [target]] : ["xdg-open", [target]];
    try { spawn(opener[0], opener[1], { detached: true, stdio: "ignore" }).unref(); } catch {}
    return Promise.resolve("");
   },
   openExternal: url => electron.shell.openPath(url),
  },
  Notification: class { constructor() {} show() {} },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: text => Buffer.from(String(text)), decryptString: buffer => Buffer.from(buffer).toString() },
  clipboard: { writeText: noop, readText: () => "" },
  nativeTheme: { themeSource: "dark" },
  Menu: { setApplicationMenu: noop },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
 };

 const originalLoad = Module._load;
 Module._load = function (request, parent, isMain) {
  if (request === "electron") return electron;
  return originalLoad.apply(this, arguments);
 };

 // ------------------------------------------------------------- the desktop engines
 const Tools = require(join(ROOT, "desktop", "tools.js"));
 const MCP = require(join(ROOT, "desktop", "mcp.js"));
 const Memory = require(join(ROOT, "desktop", "memory.js"));
 const Instructions = require(join(ROOT, "desktop", "instructions.js"));
 const Skills = require(join(ROOT, "desktop", "skills.js"));
 const Discord = require(join(ROOT, "desktop", "discord.js"));
 const LLM = require(join(ROOT, "desktop", "llm.js"));

 const allow = () => true;
 LLM.register(allow);
 MCP.register(allow);
 Memory.register(allow);
 Instructions.register(allow);
 Skills.register(allow);
 Discord.register(allow);
 // Watch LLM activity: an automatic update swaps the install only when nothing streams.
 let llmActive = 0;
 const llmStart = listeners.get("llm:start");
 if (llmStart) listeners.set("llm:start", (...args) => { llmActive++; return llmStart(...args); });
 // The mode menu's "DM me on Discord when done" switch on a headless web run.
 handlers.set("discord:message", (event, payload) => Discord.note(
  typeof payload?.text === "string" ? payload.text : "",
  Array.isArray(payload?.files) ? payload.files : [],
 ));
 handlers.set("discord:dm", (event, payload) => Discord.send(
  typeof payload?.title === "string" && payload.title.trim() ? payload.title.trim() : "Prism V2",
  typeof payload?.outcome === "string" ? payload.outcome : "completed",
  typeof payload?.summary === "string" ? payload.summary : "",
  Array.isArray(payload?.files) ? payload.files : [],
  typeof payload?.chatId === "string" ? payload.chatId : "",
 ));
 MCP.init().catch(() => {});

 // store + tools + profile handlers, the same ones main.js registers
 const STORE_KEY = /^[a-z0-9_-]+(\/[a-z0-9_-]+)?$/;
 const storeFile = key => {
  if (typeof key !== "string" || !STORE_KEY.test(key)) throw new Error(`Bad store key: ${key}`);
  return join(USER_DATA, "store", `${key}.json`);
 };
 const readStore = async key => {
  try { return JSON.parse(readFileSync(storeFile(key), "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
 };
 const writeStore = async (key, value) => {
  const file = storeFile(key);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(value));
  renameSync(temp, file);
 };
 const removeStore = async key => rmSync(storeFile(key), { force: true });

 handlers.set("store:read", (event, key) => readStore(key));
 handlers.set("store:write", (event, key, value) => writeStore(key, value));
 handlers.set("store:remove", (event, key) => removeStore(key));
 handlers.set("tool:run", (event, id, name, toolArgs, cwd) => Tools.runTool(id, name, toolArgs, cwd, event.sender));
 handlers.set("tool:cancel", (event, id) => Tools.cancel(id));
 handlers.set("tool:environment", () => Tools.environment());
 handlers.set("folder:pick", () => null);
 // A path written in a reply: does it exist, and open it (the stand-in shell starts it).
 const fullPath = (target, cwd) => (isAbsolutePath(target) ? target : (typeof cwd === "string" && cwd ? join(cwd, target) : target));
 handlers.set("path:info", (event, target, cwd) => {
  if (typeof target !== "string" || !target) return null;
  const full = fullPath(target, cwd);
  try {
   const stat = statSync(full);
   return { path: full, exists: true, dir: stat.isDirectory(), image: /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(full), name: full.split(/[\\/]/).pop() || full };
  } catch {
   return { path: full, exists: false, dir: false, image: false, name: full.split(/[\\/]/).pop() || full };
  }
 });
 handlers.set("path:open", (event, target, cwd) => typeof target === "string" && target ? electron.shell.openPath(fullPath(target, cwd)) : false);
 // A folder without picking one: the shared Chats folder, or the shared Public one.
 handlers.set("workspace:create", (event, kind) => {
  const base = join(paths.documents, "Prism V2");
  const name = kind === "public" ? "Public" : "Chats";
  const folder = join(base, name);
  try { mkdirSync(folder, { recursive: true }); return { path: folder, name }; } catch { return null; }
 });
 handlers.set("window:titlebar", noop);
 handlers.set("profile:info", () => ({ name: profile || "default", profiles: [profile || "default"] }));
 handlers.set("profile:switch", () => false);
 handlers.set("app:version", () => {
  try { return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version || ""; } catch { return ""; }
 });
 handlers.set("mcp:open-config", () => {
  const file = join(USER_DATA, "mcp.json");
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ servers: {} }, null, 2));
  return electron.shell.openPath(file);
 });

 // ------------------------------------------------------------- updates (headless server)
 // The About page on the web and the AI's update_prism tool run here: the newest release is
 // downloaded and the install directory swapped in place; when a supervisor runs this process
 // (systemd, or `prism server`), it steps aside and the new build comes right back up.
 const updateCore = require(join(ROOT, "desktop", "update-core.js"));
 const installRoot = resolve(ROOT, "..", "..");

 // ------------------------------------------------------------- devices (LAN discovery)
 // This engine answers beacons itself, so a headless server (or a plain `prism web`) shows up
 // in the other apps' device list with its web port.
 const appVersion = (() => { try { return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version || ""; } catch { return ""; } })();
 const readAutoJson = () => { try { return JSON.parse(readFileSync(join(USER_DATA, "auto.json"), "utf8")) || {}; } catch { return {}; } };
 const serverMode = (() => {
  const auto = readAutoJson();
  return auto.server === true || (process.platform === "linux" && Boolean(process.env.PRISM_SUPERVISED || process.env.INVOCATION_ID || process.env.JOURNAL_STREAM));
 })();
 let beacon = null;
 if (!process.env.PRISM_NO_BEACON) {
  try {
   const { Beacon, deviceId } = require(join(ROOT, "desktop", "beacon.js"));
   beacon = new Beacon({ id: deviceId(USER_DATA), userData: USER_DATA, name: hostname(), platform: process.platform, version: appVersion, port: webPort, server: serverMode });
   beacon.start();
  } catch (error) {
   console.log("[beacon] could not start:", error.message);
  }
 }
 handlers.set("engine:info", () => ({ server: serverMode, name: hostname(), platform: process.platform, version: appVersion }));
 handlers.set("devices:list", () => (beacon ? { ...beacon.list(), name: hostname(), server: serverMode } : { self: { id: "", name: hostname(), platform: process.platform, version: appVersion, port: webPort, server: serverMode, self: true, url: "" }, devices: [], name: hostname(), server: serverMode }));
 handlers.set("devices:add", (event, entry) => (beacon ? beacon.addManual(entry || {}) : null));
 handlers.set("devices:forget", (event, host, port) => { beacon?.forgetManual(String(host || ""), Number(port) || 0); return true; });
 handlers.set("devices:open", (event, id) => {
  if (!beacon) return { error: "device discovery is off" };
  const list = beacon.list();
  if (!id || id === "self" || id === list.self.id) return { self: true };
  const device = list.devices.find(item => item.id === id);
  if (!device?.url) return { error: "that device does not serve the web UI" };
  return { url: device.url };
 });
 const updateSettings = patch => updateCore.writeSettings(USER_DATA, {
  ...(patch?.auto !== undefined ? { auto: patch.auto === true } : {}),
  ...(patch?.install !== undefined ? { install: patch.install === true } : {}),
  ...(patch?.token !== undefined ? { token: String(patch.token || "") } : {}),
 });
 const updateParams = () => {
  const stored = updateCore.readSettings(USER_DATA);
  return { ...stored, hasToken: Boolean(updateCore.tokenOf(stored)), current: updateCore.currentVersion(ROOT), platform: process.platform, server: true };
 };
 const supervised = () => Boolean(process.env.PRISM_SUPERVISED || process.env.INVOCATION_ID || process.env.JOURNAL_STREAM);
 async function runUpdate({ force = false } = {}) {
  const settings = updateCore.readSettings(USER_DATA);
  const token = updateCore.tokenOf(settings);
  let release = null;
  try { release = await updateCore.latest({ token }); } catch (error) { return { error: error.message }; }
  if (!release?.version) return { error: "no release found on GitHub" };
  const current = updateCore.currentVersion(ROOT);
  if (!force && !updateCore.isNewer(release.version, current)) return { latest: true, current };
  if (process.platform !== "linux") return { error: "the headless updater runs on Linux — update from the app on Windows" };
  const asset = updateCore.pickAsset(release, "linux");
  if (!asset) return { error: `v${release.version} has no Linux build` };
  const file = join(paths.temp, "prism-update", asset.name);
  try { await updateCore.download({ url: asset.url, file, token }); } catch (error) { return { error: error.message }; }
  let applied = null;
  try { applied = updateCore.applyLinux({ root: installRoot, tarFile: file }); } catch (error) { return { error: error.message }; }
  try {
   const Server = require(join(ROOT, "desktop", "server.js"));
   await updateCore.fixSandbox(installRoot, Server.sudoEnv());
  } catch {}
  const up = supervised();
  if (up) setTimeout(() => process.exit(75), 2500);
  return { ok: true, version: applied.version || release.version, restart: up };
 }
 handlers.set("update:params", () => updateParams());
 handlers.set("update:set", (event, patch) => { updateSettings(patch); return updateParams(); });
 handlers.set("update:check", async () => {
  const settings = updateCore.readSettings(USER_DATA);
  try {
   const release = await updateCore.latest({ token: updateCore.tokenOf(settings) });
   if (!release?.version) return { error: "no release found on GitHub" };
   const current = updateCore.currentVersion(ROOT);
   return updateCore.isNewer(release.version, current) ? { version: release.version } : { latest: true, current };
  } catch (error) {
   return { error: error.message };
  }
 });
 handlers.set("update:install", async () => {
  const result = await runUpdate({ force: false });
  return { ...result, message: updateCore.message(result) };
 });
 handlers.set("update:run", async (event, args) => {
  const result = await runUpdate({ force: args?.force === true });
  return { ...result, message: updateCore.message(result) };
 });
 // Auto-update on a server: every six hours, when "Install automatically" is on and nothing
 // is streaming. The supervisor brings the new build back after the 75 exit above.
 if (process.platform === "linux") {
  const tick = async () => {
   try {
    if (!updateCore.readSettings(USER_DATA).install || llmActive > 0) return;
    const result = await runUpdate({ force: false });
    if (result.ok) console.log(`[update] ${updateCore.message(result)}`);
    else if (result.error && !result.latest) console.log(`[update] auto-update skipped: ${result.error}`);
   } catch (error) {
    console.log(`[update] auto-update failed: ${error.message}`);
   }
  };
  setTimeout(tick, 90 * 1000);
  setInterval(tick, 6 * 60 * 60 * 1000);
 }

 return {
  ROOT,
  USER_DATA,
  electron,
  handlers,
  listeners,
  engines: { Tools, MCP, Memory, LLM, Discord, Skills },
  setSender(next) {
   const send = typeof next?.send === "function" ? next.send : noop;
   sender = { ...next, send: (channel, ...args) => {
    if (channel === "llm:event") {
     const type = args[0]?.type;
     if (type === "done" || type === "error") llmActive = Math.max(0, llmActive - 1);
    }
    return send(channel, ...args);
   } };
  },
  // Calls a registered ipcMain.handle-style handler the way a renderer invoke would.
  invoke(channel, ...args) {
   const handler = handlers.get(channel);
   if (!handler) throw new Error(`no handler for ${channel}`);
   return handler(fakeEvent, ...args);
  },
  // Fires an ipcMain.on-style listener the way a renderer send would.
  emit(channel, ...args) {
   const listener = listeners.get(channel);
   if (listener) listener(fakeEvent, ...args);
  },
 };
}
