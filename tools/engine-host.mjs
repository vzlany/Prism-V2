// The shared stand-in for Electron behind the Node tools (`prism web`, `prism discord`).
// The modules in desktop/ load behind a require hook that fakes the Electron pieces
// (app paths, ipcMain, shell, notifications), so tools, models, MCP servers and memory
// behave exactly like they do in the app.
import { Module, createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, cpSync } from "node:fs";
import { dirname, isAbsolute as isAbsolutePath, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function createEngineHost({ profile = "" } = {}) {
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

 return {
  ROOT,
  USER_DATA,
  electron,
  handlers,
  listeners,
  engines: { Tools, MCP, Memory, LLM, Discord, Skills },
  setSender(next) { sender = next; },
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
