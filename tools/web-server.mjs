// prism web — serves Prism V2 to a browser on this machine (or the LAN with --host).
// The renderer talks to the same engines the desktop app uses: the modules in desktop/
// are loaded behind a small require-hook that stands in for the Electron pieces
// (app paths, ipcMain, shell, notifications), so tools, models, MCP servers and memory
// all keep working. Close the terminal to stop the server.
//
//   node tools/web-server.mjs [--port 8787] [--host 127.0.0.1] [--profile work] [--no-open]
import { existsSync, createReadStream, mkdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import { createEngineHost } from "./engine-host.mjs";

// The addresses a phone on the same network would use: non-internal IPv4, LAN ranges first.
function lanAddresses() {
 const out = [];
 for (const list of Object.values(networkInterfaces())) {
  for (const item of list || []) {
   if (item.family === "IPv4" && !item.internal) out.push(item.address);
  }
 }
 const rank = value => (/^192\.168\./.test(value) ? 0 : /^10\./.test(value) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(value) ? 2 : 3);
 return out.sort((a, b) => rank(a) - rank(b));
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
 const at = args.indexOf(name);
 return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const PORT = Number(flag("--port", "8787"));
const HOST = flag("--host", "127.0.0.1");
const rawProfile = String(flag("--profile", "")).toLowerCase();
const PROFILE = /^[a-z0-9-]{1,24}$/.test(rawProfile) ? rawProfile : "";
const OPEN = !args.includes("--no-open");

// --------------------------------------------------------------- the engine host
const host = createEngineHost({ profile: PROFILE });
const { USER_DATA } = host;

// --------------------------------------------------------------- http + websocket
const MIME = {
 ".html": "text/html; charset=utf-8",
 ".js": "text/javascript; charset=utf-8",
 ".css": "text/css; charset=utf-8",
 ".svg": "image/svg+xml",
 ".png": "image/png",
 ".jpg": "image/jpeg",
 ".ico": "image/x-icon",
 ".woff2": "font/woff2",
 ".json": "application/json",
 ".map": "application/json",
};

const page = () => readFileSync(join(ROOT, "app", "index.html"), "utf8")
 .replace('  <script src="desktop.js"></script>', '  <script src="/web-bridge.js"></script>\n  <script src="desktop.js"></script>');

const stamp = () => new Date().toISOString().slice(11, 19);
let connections = 0;

const server = createServer((req, res) => {
 const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
 const send = (status, body, type) => {
  // The renderer gets edited by hand while it is being worked on, and a browser holding an old
  // copy of chat.js or styles.css looks exactly like a change that never happened. Never cache.
  res.writeHead(status, {
   "content-type": type || MIME[extname(url.pathname)] || "application/octet-stream",
   "cache-control": "no-store, no-cache, must-revalidate",
   "pragma": "no-cache",
   "expires": "0",
  });
  res.end(body);
 };
 if (url.pathname === "/ws") { res.writeHead(426); res.end("websocket only"); return; }
 if (url.pathname === "/file") {
  // A file the agent attached, streamed as it is (any type) with its own name.
  const file = url.searchParams.get("path") || "";
  const name = String(url.searchParams.get("name") || basename(file)).replace(/[\r\n"]/g, "");
  if (!isAbsolute(file) || !existsSync(file) || !statSync(file).isFile()) return send(404, "no such file", "text/plain");
  res.writeHead(200, {
   "content-type": "application/octet-stream",
   "content-disposition": `attachment; filename="${name}"`,
   "content-length": statSync(file).size,
   "cache-control": "no-store",
  });
  createReadStream(file).on("error", () => res.destroy()).pipe(res);
  return;
 }
 if (url.pathname === "/web-bridge.js") return send(200, readFileSync(join(ROOT, "tools", "web-bridge.js")), "text/javascript; charset=utf-8");
 if (url.pathname === "/" || url.pathname === "/index.html") return send(200, page(), "text/html; charset=utf-8");
 const safe = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
 const direct = join(ROOT, safe);
 const renderer = join(ROOT, "app", safe);
 if (!direct.startsWith(ROOT)) return send(403, "forbidden", "text/plain");
 // Renderer files live in app/; a few shared assets (icons, cursor) stay in desktop/.
 for (const file of [direct, renderer]) {
  if (existsSync(file) && statSync(file).isFile() && !file.endsWith("index.html")) return send(200, readFileSync(file));
 }
 return send(200, page(), "text/html; charset=utf-8");
});

const wss = new WebSocketServer({ server, path: "/ws" });
// A busy port is a normal thing to hit: say so plainly instead of a stack trace.
const busy = error => {
 if (error?.code !== "EADDRINUSE") throw error;
 console.error(`\n  Port ${PORT} is already in use — another Prism V2 web is probably running.\n  Stop it, or start this one elsewhere:  prism web --port ${PORT + 1}\n`);
 process.exit(1);
};
server.on("error", busy);
wss.on("error", busy);
// Which conversation is working on which page, so every other page (a phone waking up,
// a second window) can show the same busy ghost the page that started it sees. The desktop
// app cannot talk to this server directly, so it mirrors its runs into presence.json and
// they are merged in here.
const presence = new Map();
let desktopPresence = [];
const PRESENCE_STALE = 20000;
function readDesktopPresence() {
 try {
  const text = readFileSync(join(USER_DATA, "presence.json"), "utf8").replace(/^\uFEFF/, "");
  const data = JSON.parse(text);
  const now = Date.now();
  return (Array.isArray(data?.runs) ? data.runs : []).filter(run => run?.id && now - (Number(run.at) || 0) < PRESENCE_STALE);
 } catch {
  return [];
 }
}
const presenceList = () => {
 const list = [...presence.values()];
 for (const run of desktopPresence) if (!presence.has(run.id)) list.push(run);
 return list;
};
function broadcastPresence() {
 const list = presenceList();
 for (const client of wss.clients) {
  if (client.readyState !== 1) continue;
  try { client.send(JSON.stringify({ t: "event", channel: "presence:event", args: [list] })); } catch {}
 }
}
// The desktop app cannot talk to this server directly, so it drops a heartbeat into
// userData/app.json. While that is fresh, pages may hand their turns to the app instead of
// running them in the browser, and the app streams them like any other turn.
const APP_STALE = 25000;
const appFile = () => join(USER_DATA, "app.json");
function appStatus() {
 try {
  const data = JSON.parse(readFileSync(appFile(), "utf8").replace(/^\uFEFF/, ""));
  return { connected: Date.now() - (Number(data?.at) || 0) < APP_STALE, at: Number(data?.at) || 0, version: data?.version || "" };
 } catch {
  return { connected: false, at: 0, version: "" };
 }
}
function broadcastApp() {
 const status = appStatus();
 for (const client of wss.clients) {
  if (client.readyState !== 1) continue;
  try { client.send(JSON.stringify({ t: "event", channel: "app:status", args: [status] })); } catch {}
 }
}
// A turn started on the website: a small request per chat, picked up and deleted by the app.
function delegate(request) {
 if (!request?.chatId) return false;
 try {
  mkdirSync(join(USER_DATA, "delegate"), { recursive: true });
  const id = `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(join(USER_DATA, "delegate", `${id}.json`), JSON.stringify({ id, at: Date.now(), ...request }));
  return true;
 } catch {
  return false;
 }
}
try {
 const file = appFile();
 if (!existsSync(file)) writeFileSync(file, JSON.stringify({ at: 0, version: "" }));
 watch(file, () => broadcastApp());
 setInterval(() => broadcastApp(), 10000);
} catch {}

// The store folder is shared with the desktop app (and a second browser): when the index
// changes somewhere else, every page is told so its project and chat lists stay live.
let indexStamp = "";
function indexSignature() {
 try {
  const stat = statSync(join(USER_DATA, "store", "index.json"));
  return `${stat.mtimeMs}:${stat.size}`;
 } catch {
  return "";
 }
}
function broadcastStore() {
 for (const client of wss.clients) {
  if (client.readyState !== 1) continue;
  try { client.send(JSON.stringify({ t: "event", channel: "store:changed", args: [] })); } catch {}
 }
}
try {
 mkdirSync(join(USER_DATA, "store"), { recursive: true });
 indexStamp = indexSignature();
 let watchTimer = 0;
 const chatTimers = new Map();
 watch(join(USER_DATA, "store"), { recursive: true }, (event, name) => {
  const file = String(name || "").replace(/\\/g, "/");
  // A single conversation was saved: tell the pages about that chat at once, so an open
  // thread updates the moment the other process writes it.
  const chat = /(?:^|\/)chats\/([a-z0-9_-]+)\.json$/i.exec(file);
  if (chat) {
   const id = chat[1];
   clearTimeout(chatTimers.get(id));
   chatTimers.set(id, setTimeout(() => {
    chatTimers.delete(id);
    for (const client of wss.clients) {
     if (client.readyState !== 1) continue;
     try { client.send(JSON.stringify({ t: "event", channel: "chat:changed", args: [id] })); } catch {}
    }
   }, 150));
   return;
  }
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
   const next = indexSignature();
   if (!next || next === indexStamp) return;
   indexStamp = next;
   broadcastStore();
  }, 120);
 });
 let presenceTimer = 0;
 // The desktop app writes this file; it may not exist before its first turn, so a stub is
 // made for the watcher to hold on to.
 try {
  const file = join(USER_DATA, "presence.json");
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ at: 0, runs: [] }));
  watch(file, () => {
   clearTimeout(presenceTimer);
   presenceTimer = setTimeout(() => {
    desktopPresence = readDesktopPresence();
    broadcastPresence();
   }, 250);
  });
 } catch {}
} catch {}
wss.on("connection", ws => {
 const data = { id: ++connections };
 data.send = (channel, ...eventArgs) => { try { ws.send(JSON.stringify({ t: "event", channel, args: eventArgs })); } catch {} };
 console.log(`[${stamp()}] connection ${data.id} opened`);
 // A page that just opened asks for a snapshot right away.
 const mine = new Set();
 data.send("presence:event", presenceList());
 data.send("app:status", [appStatus()]);
 ws.on("close", () => {
  for (const id of mine) presence.delete(id);
  if (mine.size) broadcastPresence();
  console.log(`[${stamp()}] connection ${data.id} closed`);
 });
 ws.on("message", async raw => {
  let msg;
  try { msg = JSON.parse(String(raw)); } catch { return; }
  host.setSender({ send: data.send, isDestroyed: () => false });
  const reply = (t, id, payload) => ws.send(JSON.stringify({ t, id, ...payload }));
  try {
   if (msg.t === "invoke") {
    const value = await host.invoke(msg.channel, ...(msg.args || []));
    reply("result", msg.id, { value });
    if (String(msg.channel).startsWith("tool:")) console.log(`[${stamp()}] ${msg.channel} ok`);
   } else if (msg.t === "send") {
    if (msg.channel === "presence:set") {
     const [id, info] = msg.args || [];
     if (info && id) { mine.add(id); presence.set(id, { id, ...info }); }
     else if (id) { mine.delete(id); presence.delete(id); }
     broadcastPresence();
     return;
    }
    if (msg.channel === "delegate:add") {
     const [request] = msg.args || [];
     const ok = Boolean(appStatus().connected) && delegate(request);
     if (ok) console.log(`[${stamp()}] turn delegated to the app: ${request?.chatId}`);
     else console.log(`[${stamp()}] delegate refused (app ${appStatus().connected ? "busy" : "not running"})`);
     data.send("delegate:status", [String(request?.id || ""), ok]);
     return;
    }
    host.emit(msg.channel, ...(msg.args || []));
    if (msg.channel === "llm:start") console.log(`[${stamp()}] llm:start ${msg.args?.[1]?.provider}/${msg.args?.[1]?.model}`);
   }
  } catch (error) {
   reply("error", msg.id, { error: String(error?.message || error) });
   console.log(`[${stamp()}] ${msg.channel} error: ${String(error?.message || error).slice(0, 160)}`);
  }
 });
});

server.listen(PORT, HOST, () => {
 const shown = HOST === "0.0.0.0" ? "localhost" : HOST;
 const port = server.address().port;
 console.log(`\n  Prism V2 web  ->  http://${shown}:${port}`);
 console.log(`  store      ->  ${USER_DATA}`);
 const addresses = lanAddresses();
 if (HOST === "0.0.0.0") {
  for (const address of addresses) console.log(`  on your network  ->  http://${address}:${port}   (open this on your phone)`);
  if (!addresses.length) console.log("  note: no network address found — only this computer can reach it right now.");
  console.log("  note: reachable from your network; anyone on it can run tools on this computer.");
 } else if (addresses.length) {
  console.log(`  from your phone  ->  start with  prism web --host 0.0.0.0`);
  console.log(`                        then open  http://${addresses[0]}:${port}  on a phone on the same Wi-Fi`);
 }
 console.log("  the terminal stays like this: requests, models and tools show up below.\n");
 if (OPEN) {
  const url = `http://localhost:${server.address().port}`;
  const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try { spawn(opener[0], opener[1], { detached: true, stdio: "ignore" }).unref(); } catch {}
 }
});
