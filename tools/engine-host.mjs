// The shared stand-in for Electron behind the Node tools (`prism web`, `prism discord`).
// The modules in desktop/ load behind a require hook that fakes the Electron pieces
// (app paths, ipcMain, shell, notifications), so tools, models, MCP servers and memory
// behave exactly like they do in the app.
import { Module, createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, cpSync, chmodSync } from "node:fs";
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
  // tools.js reaches the web through Electron's net.fetch; a headless engine has no Electron,
  // so without this every fetch_url (and web_search, which rides on it) died with
  // "Cannot read properties of undefined (reading 'fetch')".
  net: { fetch: (input, init) => globalThis.fetch(input, init) },
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
 let lastRunAt = Date.now();
 const llmStart = listeners.get("llm:start");
 if (llmStart) listeners.set("llm:start", (...args) => { llmActive++; lastRunAt = Date.now(); writeBusy(); return llmStart(...args); });
 // A busy mirror for this machine's updater: the app waits for quiet before installing, and
 // the turns of the web pages (this process) and the Discord bot (its own process) live
 // outside the app — each writes what it is doing into a small file the updater reads.
 const busyFile = join(USER_DATA, webPort > 0 ? "web-busy.json" : "bot-busy.json");
 function writeBusy() {
  try { writeFileSync(busyFile, JSON.stringify({ at: Date.now(), busy: llmActive, lastAt: lastRunAt })); } catch {}
 }
 setInterval(writeBusy, 10000).unref?.();
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
   return { path: full, exists: true, dir: stat.isDirectory(), image: /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(full), name: full.split(/[\\/]/).pop() || full, size: stat.isFile() ? stat.size : 0 };
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
 // The version is read with a short memo, not once: an update (from the app, the bot, or the
 // About page) swaps package.json under a running engine, and every report — About, the
 // beacon, engine info — must tell the truth immediately instead of the version that was on
 // disk when the process happened to start.
 let versionMemo = { at: 0, value: "" };
 const appVersion = () => {
  const now = Date.now();
  if (versionMemo.value && now - versionMemo.at < 5000) return versionMemo.value;
  try { versionMemo = { at: now, value: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version || "" }; } catch {}
  return versionMemo.value || "";
 };
 const startedVersion = appVersion();
 // The updater's live state, mirrored to every page: available → downloading → restarting →
 // done. A page (a remote window, a phone) shows which device is updating.
 const updateStateFile = join(USER_DATA, "update-state.json");
 const readUpdateState = () => { try { return JSON.parse(readFileSync(updateStateFile, "utf8")); } catch { return null; } };
 const writeUpdateState = patch => { try { writeFileSync(updateStateFile, JSON.stringify({ at: Date.now(), ...patch })); } catch {} };
 // A boot that follows an update means the new build is running: say so for the pages, and
 // tell the user — a line in the conversation that asked, and a Discord DM — so a successful
 // update is never met with silence. Two shapes count as "an update just landed": the state
 // the updater wrote before stepping aside ("restarting"), and the state it left behind if it
 // was killed before that last write ("installing"/"downloading" with the running build
 // already at the announced version).
 {
  const prior = readUpdateState();
  const fresh = prior && Date.now() - (Number(prior.at) || 0) < 30 * 60 * 1000;
  const landed = fresh && String(prior.version || "") === startedVersion
   && ["restarting", "installing", "downloading"].includes(String(prior.phase));
  // Only the engine that serves the web UI handles this: every engine on the machine boots
  // from the same state file, and the Discord bridge's host (no port) used to consume the
  // "an update landed" state first — the web engine then found plain "done" and announced
  // nothing. Whoever owns the pages owns the announcement.
  if (webPort > 0) {
   if (landed) {
    const version = String(prior.version || startedVersion || "");
    writeUpdateState({ phase: "done", version, chatId: prior.chatId || "", announced: false });
    announceUpdate(version, prior.chatId || "").catch(() => {});
   } else if (prior?.phase === "downloading" || prior?.phase === "installing") writeUpdateState({ phase: "idle", version: prior.version || "" });
  }
 }
 async function announceUpdate(version, chatId) {
  const text = `✅ Prism V2 updated to v${version} — I'm back, running the new version.`;
  try {
   const notify = JSON.parse(readFileSync(join(USER_DATA, "store", "notify.json"), "utf8"));
   if (notify?.discord === true) await Discord.send("Prism V2", "completed", text);
  } catch {}
  if (!chatId) return;
  try {
   const file = join(USER_DATA, "store", "chats", `${chatId}.json`);
   const body = JSON.parse(readFileSync(file, "utf8"));
   if (!body || body.sealed || !Array.isArray(body.messages)) return;
   body.messages.push({ role: "assistant", content: text, turn: "update" });
   const temp = `${file}.tmp`;
   writeFileSync(temp, JSON.stringify(body));
   renameSync(temp, file);
   const indexFile = join(USER_DATA, "store", "index.json");
   const index = JSON.parse(readFileSync(indexFile, "utf8"));
   const record = (index?.chats || []).find(item => item?.id === chatId);
   if (record) { record.updated = Date.now(); writeFileSync(indexFile, JSON.stringify(index)); }
   // So the carry-on does not tell it a second time — and can tell it if this never ran.
   try {
    const state = JSON.parse(readFileSync(updateStateFile, "utf8")) || {};
    writeFileSync(updateStateFile, JSON.stringify({ ...state, announced: true }));
   } catch {}
   console.log(`[update] told conversation ${chatId} that v${version} is running`);
  } catch (error) { console.log(`[update] could not note the update in the chat: ${error.message}`); }
 }
 handlers.set("update:state", () => readUpdateState());
 // The switches live in the store (the app writes store/auto.json — this used to read the
 // parent folder, so an engine the app spawned never saw "server: true" at all).
 const readAutoJson = () => {
  for (const file of [join(USER_DATA, "store", "auto.json"), join(USER_DATA, "auto.json")]) {
   try { return JSON.parse(readFileSync(file, "utf8")) || {}; } catch {}
  }
  return {};
 };
 const serverMode = (() => {
  const auto = readAutoJson();
  return auto.server === true || process.env.PRISM_SERVER === "1" || (process.platform === "linux" && Boolean(process.env.PRISM_SUPERVISED || process.env.INVOCATION_ID || process.env.JOURNAL_STREAM));
 })();
 let beacon = null;
 // Only an engine that actually serves the web UI (a port) advertises itself: the Discord
 // bridge's own host has nothing to open, and the app's children already carry the app's
 // beacon (PRISM_NO_BEACON).
 if (!process.env.PRISM_NO_BEACON && webPort > 0) {
  try {
   const { Beacon, deviceId } = require(join(ROOT, "desktop", "beacon.js"));
   beacon = new Beacon({ id: deviceId(USER_DATA), userData: USER_DATA, name: hostname(), platform: process.platform, version: appVersion(), port: webPort, server: serverMode });
   beacon.start();
  } catch (error) {
   console.log("[beacon] could not start:", error.message);
  }
 }
 // Everything else on this machine — the Discord bot, the app's own helpers — never binds the
 // discovery port: the live list is mirrored to a file their devices:list fallback reads.
 if (beacon) {
  const mirror = () => { try { writeFileSync(join(USER_DATA, "beacon.json"), JSON.stringify({ at: Date.now(), ...beacon.list(), name: hostname(), server: serverMode })); } catch {} };
  mirror();
  setInterval(mirror, 10000).unref?.();
 }
 handlers.set("engine:info", () => ({ server: serverMode, name: hostname(), platform: process.platform, version: appVersion() }));
 // Live system information for the server's System panel.
 const sysinfo = require(join(ROOT, "desktop", "sysinfo.js"));
 handlers.set("sys:stats", () => sysinfo.stats());
 // A child of the app does not bind the discovery port (the app itself already does): it
 // reads the list the app mirrors to beacon.json instead, so the web UI the app serves —
 // on this machine or opened from a phone — still knows every device on the network.
 const cachedDevices = () => {
  try {
   const data = JSON.parse(readFileSync(join(USER_DATA, "beacon.json"), "utf8"));
   if (!data || Date.now() - Number(data.at || 0) > 90000) return null;
   return data;
  } catch { return null; }
 };
 const deviceList = () => {
  if (beacon) return { ...beacon.list(), name: hostname(), server: serverMode };
  const cached = cachedDevices();
  if (cached?.self) return { self: cached.self, devices: cached.devices || [], name: cached.name || hostname(), server: serverMode };
  return { self: { id: "", name: hostname(), platform: process.platform, version: appVersion(), port: webPort, server: serverMode, self: true, url: "" }, devices: [], name: hostname(), server: serverMode };
 };
 handlers.set("devices:list", deviceList);
 handlers.set("devices:add", (event, entry) => (beacon ? beacon.addManual(entry || {}) : null));
 handlers.set("devices:forget", (event, host, port) => { beacon?.forgetManual(String(host || ""), Number(port) || 0); return true; });
 handlers.set("devices:open", (event, id) => {
  const list = deviceList();
  if (!id || id === "self" || id === list.self.id) return { self: true };
  const device = (list.devices || []).find(item => item.id === id);
  if (!device?.url) return { error: "that device does not serve the web UI" };
  return { url: device.url };
 });

 // Settings -> Discord on the web: the same discord.json the app and the bot read, so the
 // token, the user id and the DM switch can be managed from a phone or another device.
 const discordFile = join(USER_DATA, "discord.json");
 const readDiscord = () => { try { return JSON.parse(readFileSync(discordFile, "utf8")) || {}; } catch { return {}; } };
 const discordState = () => {
  const cfg = readDiscord();
  return { enabled: cfg.enabled !== false, userId: String(cfg.userId || ""), hasToken: Boolean(cfg.token), tools: cfg.tools !== false };
 };
 handlers.set("discord:get", () => discordState());
 handlers.set("discord:set", (event, patch) => {
  const cfg = readDiscord();
  if (typeof patch?.token === "string" && patch.token.trim()) cfg.token = patch.token.trim();
  if (typeof patch?.userId === "string") cfg.userId = patch.userId.trim();
  if (patch?.enabled !== undefined) cfg.enabled = patch.enabled !== false;
  try {
   mkdirSync(USER_DATA, { recursive: true });
   writeFileSync(discordFile, JSON.stringify(cfg, null, 2));
   try { chmodSync(discordFile, 0o600); } catch {}
  } catch {}
  return discordState();
 });
 handlers.set("discord:test", async () => {
  const cfg = readDiscord();
  if (!cfg.token) return { ok: false, error: "no token saved yet — paste the bot token and press Save first" };
  if (!cfg.userId) return { ok: false, error: "no user id saved yet — paste your Discord user id and press Save first" };
  // This is the very DM the finish-notifications use — not just a token check — so what the
  // page reports is what actually landed in Discord.
  const result = await Discord.send("Prism V2", "test", "Discord notifications are wired up.");
  if (result?.ok) return result;
  if (result?.error === "not configured") return { ok: false, error: "DMs are switched off — tick \"send DMs\", press Save, then test again" };
  return { ok: false, error: result?.error || "unknown error" };
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
 // An update applied by any other surface (the desktop app's updater, the bot, the About
 // page in another window) swaps the install under a running engine: the files are the new
 // build while this process keeps the old code. Notice, keep reporting the fresh version,
 // and step aside — the supervisor brings the new build straight back.
 let versionNoticed = false;
 setInterval(() => {
  const fresh = appVersion();
  if (!fresh || fresh === startedVersion) return;
  if (beacon && beacon.version !== fresh) beacon.version = fresh;
  if (versionNoticed) return;
  versionNoticed = true;
  console.log(`[update] the install changed to v${fresh} (this process started v${startedVersion}) — restarting to match`);
  if (supervised()) process.exit(75);
  else console.log("[update] no supervisor is running this engine: restart it to pick the new build up");
 }, 20000).unref?.();
 async function runUpdate({ force = false, chatId = "" } = {}) {
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
  writeUpdateState({ phase: "downloading", version: release.version, chatId });
  try { await updateCore.download({ url: asset.url, file, token, onProgress: value => { const pct = Math.round((Number(value) || 0) * 100); if (pct % 5 === 0) writeUpdateState({ phase: "downloading", version: release.version, progress: Number(value) || 0, chatId }); } }); } catch (error) { writeUpdateState({ phase: "idle", version: release.version, chatId }); return { error: error.message }; }
  writeUpdateState({ phase: "installing", version: release.version, chatId });
  let applied = null;
  try { applied = updateCore.applyLinux({ root: installRoot, tarFile: file }); } catch (error) { writeUpdateState({ phase: "idle", version: release.version, chatId }); return { error: error.message }; }
  // The files on disk are the new build now: the next boot IS an update boot, and that is
  // recorded before anything else can kill this process (the supervisor's own rotation used
  // to win that race; the new build then announced nothing and carried nothing on).
  writeUpdateState({ phase: "restarting", version: applied?.version || release.version, chatId });
  try {
   const Server = require(join(ROOT, "desktop", "server.js"));
   await updateCore.fixSandbox(installRoot, Server.sudoEnv());
  } catch {}
  // The files on disk are the new build now — stop whatever still runs from the old one.
  // This is the cure for "three Prisms fought over port 8787 after an update": leftovers from
  // an earlier build (a hand-started web server, an app from a stale autostart, an old-era
  // bridge) are stopped here, the autostart entry is put back on the current install, and
  // the old trees are only then cleared. The supervisor itself is left alone: it cycles on
  // its own watcher, and under systemd the whole unit comes back on the new build.
  try {
   const Instances = require(join(ROOT, "desktop", "instances.js"));
   const fresh = updateCore.currentVersion(ROOT) || applied.version || release.version;
   const stopped = await Instances.sweep(USER_DATA, {
    keepPid: process.pid,
    test: entry => entry.role !== "server" && Instances.isForeignBuild(entry, { root: ROOT, version: fresh }),
   }).catch(() => []);
   if (stopped.length) console.log(`[update] stopped ${stopped.length} leftover process(es) from the old build`);
   updateCore.pruneOld(installRoot);
  } catch {}
  try {
   const Server = require(join(ROOT, "desktop", "server.js"));
   Server.ensureLinuxAutostart(installRoot);
  } catch {}
  const up = supervised();
  writeUpdateState({ phase: up ? "restarting" : "done", version: applied.version || release.version, chatId });
  if (up) {
   // Let the answer that asked for the update go out first: step aside once this engine is
   // idle again (at most two minutes), and the supervisor brings the new build right back.
   const deadline = Date.now() + 120000;
   const stepAside = () => {
    if (llmActive === 0 || Date.now() > deadline) process.exit(75);
    else setTimeout(stepAside, 1000);
   };
   setTimeout(stepAside, 2500);
  }
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
  const result = await runUpdate({ force: args?.force === true, chatId: String(args?.chatId || "") });
  return { ...result, message: updateCore.message(result) };
 });
 // Auto-update on a server: every six hours, when "Install automatically" is on and nothing
 // is streaming. Only the engine that serves the web UI runs this — the Discord bridge's own
 // host (no port) keeps its hands off the install. The supervisor brings the new build back
 // after the 75 exit above.
 if (process.platform === "linux" && webPort > 0) {
  const tick = async () => {
   try {
    const auto = updateCore.readSettings(USER_DATA);
    if (llmActive > 0 || Date.now() - lastRunAt < 10 * 60 * 1000) return;
    if (!auto.install) {
     // Auto-install off: still say that an update exists, so a watching page can show it.
     const release = await updateCore.latest({ token: updateCore.tokenOf(auto) }).catch(() => null);
     const current = updateCore.currentVersion(ROOT);
     if (release?.version && updateCore.isNewer(release.version, current)) writeUpdateState({ phase: "available", version: release.version });
     return;
    }
    const result = await runUpdate({ force: false });
    if (result.ok) console.log(`[update] ${updateCore.message(result)}`);
    else if (result.error && !result.latest) console.log(`[update] auto-update skipped: ${result.error}`);
   } catch (error) {
    console.log(`[update] auto-update failed: ${error.message}`);
   }
  };
  setTimeout(tick, 90 * 1000);
  setInterval(tick, 10 * 60 * 1000);
 }

 return {
  ROOT,
  USER_DATA,
  electron,
  handlers,
  listeners,
  // The Discord bridge (a sibling of the web engine) reads these: the same live device list
  // its own devices:list would serve, and whether this machine is a server.
  deviceList,
  serverMode,
  engines: { Tools, MCP, Memory, LLM, Discord, Skills },
  setSender(next) {
   const send = typeof next?.send === "function" ? next.send : noop;
   sender = { ...next, send: (channel, ...args) => {
    if (channel === "llm:event") {
     const type = args[0]?.type;
     if (type === "done" || type === "error") { llmActive = Math.max(0, llmActive - 1); writeBusy(); }
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
