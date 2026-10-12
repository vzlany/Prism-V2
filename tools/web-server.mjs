// prism web — serves Prism V2 to a browser on this machine (or the LAN with --host).
// The renderer talks to the same engines the desktop app uses: the modules in desktop/
// are loaded behind a small require-hook that stands in for the Electron pieces
// (app paths, ipcMain, shell, notifications), so tools, models, MCP servers and memory
// all keep working. Close the terminal to stop the server.
//
//   node tools/web-server.mjs [--port 8787] [--host 127.0.0.1] [--profile work] [--no-open]
import { existsSync, createReadStream, createWriteStream, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { networkInterfaces } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import { createEngineHost } from "./engine-host.mjs";
import { createKeeper } from "./run-keeper.mjs";

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
const host = createEngineHost({ profile: PROFILE, webPort: PORT });
const { USER_DATA } = host;

// --------------------------------------------------------------- one engine per role
// Announce this web server in the shared instance registry (desktop/instances.js), so an
// update — or a fresh start next to a leftover — can tell which engines belong to which
// build. A holder of our port that runs an older build is stopped; one that runs the same
// build is left alone and this server waits its turn.
const requireModule = createRequire(import.meta.url);
const Instances = requireModule(join(ROOT, "desktop", "instances.js"));
const UpdateCore = requireModule(join(ROOT, "desktop", "update-core.js"));
const VERSION = UpdateCore.currentVersion(ROOT);
const instance = Instances.attach({ userData: USER_DATA, role: "web", port: PORT, version: VERSION, root: ROOT });
// Leave the registry on the way out (the exit codes keep the supervisor's restart logic).
process.on("SIGTERM", () => { try { keeper.stopAll(); } catch {} try { instance.stop(); } catch {} process.exit(143); });
process.on("SIGINT", () => { try { keeper.stopAll(); } catch {} try { instance.stop(); } catch {} process.exit(130); });

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
 .replace('  <script src="desktop.js"></script>', '  <script src="/web-bridge.js"></script>\n  <script src="desktop.js"></script>')
 // Every script and stylesheet carries the build's version: a phone that reloads after an
 // update asks for new URLs, so it can never keep running an old chat.js out of its cache
 // ("the version changed but nothing looks different").
 .replace(/(src|href)="([^":/]+\.(?:js|css))"/g, (all, attr, file) => `${attr}="${file}?v=${VERSION}"`);

const stamp = () => new Date().toISOString().slice(11, 19);
let connections = 0;

// Dev serves every file fresh (a cached chat.js looks like a change that never happened);
// production answers a phone reload with a cheap 304 instead of re-sending styles.css and
// every module. `--dev` or PRISM_WEB_DEV=1 restores the old behaviour.
const DEV = process.env.PRISM_WEB_DEV === "1" || process.argv.includes("--dev");

const server = createServer((req, res) => {
 const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
 const send = (status, body, type) => {
  const headers = { "content-type": type || MIME[extname(url.pathname)] || "application/octet-stream" };
  if (DEV) {
   headers["cache-control"] = "no-store, no-cache, must-revalidate";
   headers.pragma = "no-cache";
   headers.expires = "0";
  } else {
   const etag = `"${createHash("md5").update(body).digest("hex").slice(0, 16)}"`;
   headers.etag = etag;
   // Revalidate every time (cheap 304s): a client that reloads right after an update must
   // never run hour-old scripts from its cache.
   headers["cache-control"] = "public, max-age=0, must-revalidate";
   if (req.headers["if-none-match"] === etag) { res.writeHead(304); res.end(); return; }
  }
  res.writeHead(status, headers);
  res.end(body);
 };
 if (url.pathname === "/ws") { res.writeHead(426); res.end("websocket only"); return; }
 // A file attached in a browser (a phone has no path the tools could open): the bytes are
 // written here and the answer hands the agent the real path, so read_file, a scan or a
 // script can work on the actual file instead of only what fit in the message.
 if (url.pathname === "/upload" && req.method === "POST") {
  const chat = String(url.searchParams.get("chat") || "misc").replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 60) || "misc";
  const asked = decodeURIComponent(String(url.searchParams.get("name") || "file")).replace(/[\x00-\x1f\x7f\r\n"\\/]+/g, "_").replace(/^\.+/, "").trim() || "file";
  const folder = join(USER_DATA, "uploads", chat);
  let name = asked.slice(0, 120).replace(/[ .]+$/, "") || "file";
  try {
   mkdirSync(folder, { recursive: true });
   const dot = name.lastIndexOf(".");
   const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
   let n = 1;
   while (existsSync(join(folder, name))) name = `${stem} (${++n})${ext}`;
   const file = join(folder, name);
   const limit = 512 * 1024 * 1024;
   let size = 0, tooBig = false;
   const out = createWriteStream(file);
   req.on("data", chunk => {
    size += chunk.length;
    if (size > limit) { tooBig = true; req.destroy(); out.destroy(); return; }
    out.write(chunk);
   });
   req.on("end", () => {
    out.end(() => {
     if (tooBig) { try { rmSync(file, { force: true }); } catch {} send(413, JSON.stringify({ ok: false, error: "the file is larger than 512 MB" }), "application/json"); return; }
     console.log(`[${stamp()}] upload ${chat}/${name} (${size} bytes)`);
     send(200, JSON.stringify({ ok: true, path: file, name, size }), "application/json");
    });
   });
   req.on("error", () => { try { out.destroy(); rmSync(file, { force: true }); } catch {} });
   out.on("error", () => { try { res.destroy(); } catch {} });
  } catch (error) {
   send(500, JSON.stringify({ ok: false, error: String(error?.message || error) }), "application/json");
  }
  return;
 }
 if (url.pathname === "/live" && req.method === "POST") {
  // The desktop app pushes its live runs here at typing speed (its presence.json path is
  // slower): the page watching that machine gets the mirror about every 35 ms.
  let body = "";
  req.on("data", chunk => { body += chunk; if (body.length > 2 * 1024 * 1024) req.destroy(); });
  req.on("end", () => {
   try {
    const data = JSON.parse(body);
    if (Array.isArray(data?.runs)) {
     // The app pushes only its own runs; runs published by other engines (the Discord bot's
     // live mirror lands in presence.json) stay, or they would blink out of every page on
     // each push.
     const incoming = data.runs.filter(run => run?.id);
     const ids = new Set(incoming.map(run => run.id));
     const keep = desktopPresence.filter(run => run?.id && !ids.has(run.id) && Date.now() - (Number(run.at) || 0) < PRESENCE_STALE);
     desktopPresence = [...incoming, ...keep];
     broadcastPresence();
    }
   } catch {}
   send(200, "ok", "text/plain");
  });
  return;
 }
 if (url.pathname === "/file") {
  // A file the agent attached, streamed as it is (any type) with its own name. An older
  // record may carry a path joined with backslashes (the old download join): try that
  // spelling too instead of a 404.
  const asked = url.searchParams.get("path") || "";
  const file = [asked, asked.includes("\\") ? asked.replace(/\\/g, "/") : ""].find(item => item && isAbsolute(item) && existsSync(item) && statSync(item).isFile()) || "";
  const name = String(url.searchParams.get("name") || basename(file || asked)).replace(/[\r\n"]/g, "");
  if (!file) return send(404, "no such file", "text/plain");  res.writeHead(200, {
   "content-type": "application/octet-stream",
   "content-disposition": `attachment; filename="${name}"`,
   "content-length": statSync(file).size,
   "cache-control": "no-store",
  });
  createReadStream(file).on("error", () => res.destroy()).pipe(res);
  return;
 }
 if (url.pathname === "/preview") {
  // A file shown INSIDE a page — a photo someone attached in Discord, an image the panel
  // opens: streamed inline with a type the browser can render, unlike /file, which downloads.
  const asked = url.searchParams.get("path") || "";
  const file = [asked, asked.includes("\\") ? asked.replace(/\\/g, "/") : ""].find(item => item && isAbsolute(item) && existsSync(item) && statSync(item).isFile()) || "";
  if (!file) return send(404, "no such file", "text/plain");
  const name = basename(file).replace(/[\r\n"]/g, "");
  const INLINE = {
   png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml", ico: "image/x-icon",
   mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska",
   mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac",
   pdf: "application/pdf", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8", log: "text/plain; charset=utf-8",
   json: "application/json; charset=utf-8", csv: "text/csv; charset=utf-8",
  };
  const type = INLINE[extname(file).slice(1).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
   "content-type": type,
   "content-disposition": `inline; filename="${name}"`,
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
// A busy port used to end this process ("web is not set up"), which could leave the machine
// with no web UI until someone noticed. Now: a holder that runs an older build is stopped and
// the port is taken over; a holder of the same build keeps it and this server stands by,
// retrying until the port frees up.
let retrying = false;
let toldBusy = false;
const busy = async error => {
 if (error?.code !== "EADDRINUSE") throw error;
 let tookOver = false;
 try {
  const done = await Instances.sweep(USER_DATA, {
   keepPid: process.pid,
   test: entry => entry.role === "web" && Number(entry.port) === PORT
    && (Instances.isForeignBuild(entry, { root: ROOT, version: VERSION }) || UpdateCore.isNewer(VERSION, entry.version)),
   grace: 2500,
  });
  tookOver = done.some(item => item.killed);
 } catch {}
 if (tookOver) console.log(`  port ${PORT} was held by an older Prism build — stopped it, taking over`);
 if (!toldBusy) {
  toldBusy = !tookOver;
  if (toldBusy) console.error(`\n  Port ${PORT} is already in use — another Prism V2 of this same build is serving it.\n  This one stands by and takes over the moment the port frees up.\n`);
 }
 if (retrying) return;
 retrying = true;
 setTimeout(() => {
  retrying = false;
  server.listen(PORT, HOST);
 }, tookOver ? 1200 : 30000).unref?.();
};
server.on("error", busy);
wss.on("error", error => { if (error?.code !== "EADDRINUSE") throw error; });

// --------------------------------------------------------------- the console mirror
// Every line this process logs is kept (the last 500) and streamed to the connected pages, so
// a remote window or a phone sees everything the server sees — including page errors mirrored
// in from the clients. The System panel shows this live.
const LOG_RING = [];
function logLine(text, level = "log") {
 const line = String(text ?? "").replace(/\s+$/, "");
 if (!line) return;
 LOG_RING.push(level === "error" ? `⚠ ${line}` : line);
 if (LOG_RING.length > 500) LOG_RING.splice(0, LOG_RING.length - 500);
 const frame = JSON.stringify({ t: "event", channel: "log:event", args: [LOG_RING[LOG_RING.length - 1]] });
 try {
  for (const client of wss.clients) if (client.readyState === 1) client.send(frame);
 } catch {}
}
for (const level of ["log", "warn", "error"]) {
 const original = console[level].bind(console);
 console[level] = (...parts) => {
  original(...parts);
  try {
   logLine(parts.map(part => typeof part === "string" ? part : (() => { try { return JSON.stringify(part); } catch { return String(part); } })()).join(" "), level);
  } catch {}
 };
}
// Which conversation is working on which page, so every other page (a phone waking up,
// a second window) can show the same busy ghost the page that started it sees. The desktop
// app cannot talk to this server directly, so it mirrors its runs into presence.json and
// they are merged in here.
const presence = new Map();
// Turns started from a page run right here, in this engine, and survive the page (a refresh,
// a switch, a closed tab). They publish their state into the same presence list, so a page
// sees them exactly like a run from another device: ghost in the list, live card, stop.
const keeper = createKeeper({
 userData: USER_DATA,
 root: ROOT,
 host,
 log: line => console.log(`[keeper] ${line}`),
 publish: (chatId, info) => {
  if (info) presence.set(chatId, info);
  else presence.delete(chatId);
  broadcastPresence();
 },
});
host.handlers.set("run:start", (event, request) => keeper.start(request));
host.handlers.set("run:stop", (event, chatId) => keeper.stop(chatId));
host.handlers.set("run:state", (event, chatId) => keeper.state(chatId));
// A message written while the run works: it joins the turn at the next step (the app's own
// interject), instead of waiting for the whole run to finish.
host.handlers.set("run:message", (event, chatId, text) => keeper.message(chatId, text));

// ----------------------------------------------------------- carrying on after an update
// An update triggered from a conversation leaves its chat id in update-state.json: when the
// new build is up, that conversation is picked back up by itself — a fresh turn in the same
// chat ("the restart cut your work off: finish it, test it, write the summary") — so the
// user's agent is not left silent after restarting the very machine it runs on. The
// engine-host already wrote the "✅ updated" line and the Discord DM at boot.
function continueAfterUpdate() {
 const state = readJsonSafe(updateStateFile);
 if (!state || state.phase !== "done" || state.continued) return;
 const chatId = String(state.chatId || "").replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 60);
 if (!chatId) return;
 if (Date.now() - (Number(state.at) || 0) > 30 * 60 * 1000) return console.log(`[update] carry-on skipped: the state is ${Math.round((Date.now() - Number(state.at)) / 60000)} minutes old`);
 const store = join(USER_DATA, "store");
 const index = readJsonSafe(join(store, "index.json"));
 const record = (index?.chats || []).find(item => item?.id === chatId);
 if (!record?.folder) return console.log(`[update] carry-on skipped: ${chatId} has no folder in the store`);
 const catalog = readJsonSafe(join(store, "catalog.json"));
 const keys = readJsonSafe(join(store, "keys.json"));
 const model = String(record.model || "");
 const provider = model.includes(":") ? model.split(":")[0] : model;
 const def = ((catalog?.providers || {})[provider] || []).find(item => item?.id === model) || null;
 const key = String((keys?.keys || {})[provider] || "");
 if (!provider || !key) { log(`[update] no key for ${provider || "?"} — not carrying the chat on`); markContinued(); return; }
 // The restart may have cut a turn off mid-step: a note about the restart goes in first, then
 // the ask to finish, exactly the way a person would write it.
 const text = `The update to v${String(state.version || "").replace(/^v/, "")} finished and the server restarted — if your last turn was cut off, it was the restart. Go on with the task from where you stopped: finish the work, test it here, and write the summary.`;
 try {
  const file = join(store, "chats", `${chatId}.json`);
  const body = readJsonSafe(file);
  if (!body || body.sealed || !Array.isArray(body.messages)) { markContinued(); return; }
  // The "✅ updated" line: the boot writes it (and flags the state), but if another engine
  // consumed the state first the chat used to hear nothing at all. Either way it is said once.
  if (!state.announced && !body.messages.some(entry => String(entry?.content || "").includes("Prism V2 updated to v"))) {
   const note = `✅ Prism V2 updated to v${String(state.version || "").replace(/^v/, "")} — I'm back, running the new version.`;
   body.messages.push({ role: "assistant", content: note, turn: "update" });
  }
  const last = [...body.messages].reverse().find(entry => entry?.role === "user");
  // `system: true` marks a line that exists for the model only: the page never draws it.
  if (!last || String(last.text || "").trim() !== text) body.messages.push({ role: "user", text, content: text, origin: "update", system: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(body));
  renameSync(temp, file);
 } catch (error) { console.log(`[keeper] could not note the restart in ${chatId}: ${error.message}`); markContinued(); return; }
 // Not marked done yet: this process may be the one the old supervisor started moments
 // before stepping the whole unit aside for the new build (see the settling wait below).
 // Only a carry-on that stays alive counts — otherwise the rebuild after the rotation
 // would find it "done" and leave the conversation silent.
 const stamp = String(state.version || "");
 setTimeout(() => {
  const now = readJsonSafe(updateStateFile) || {};
  if (!now.continued && now.phase === "done" && String(now.version || "") === stamp) markContinued();
 }, 30 * 1000);
 keeper.buildSystem({ folder: record.folder, mode: "full", model })
  .then(system => {
   const started = keeper.start({
    id: `u-${Date.now().toString(36)}`,
    chatId,
    folder: record.folder,
    mode: "full",
    title: String(record.title || ""),
    config: {
     provider,
     model: model.slice(provider.length + 1) || model,
     key,
     effort: def?.defaultEffort || "",
     vision: def?.vision !== false,
     context: Number(def?.context) || 128000,
     efforts: def?.efforts || [],
    },
    system,
    tools: keeper.schemas,
    prompt: text,
    origin: "update",
   });
   if (started?.ok) console.log(`[update] carrying the conversation ${chatId} on after the restart`);
   else console.log(`[update] could not carry ${chatId} on: ${started?.error || "unknown"}`);
  })
  .catch(error => console.log(`[update] could not carry ${chatId} on: ${error.message}`));
}

const readJsonSafe = file => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
// The keeper's own heartbeat: who is working right here. The Discord bridge reads it, so its
// "Working in app…" status stays true for a whole web-run turn — tools included, not only
// while a model call is streaming.
const keeperRunsFile = join(USER_DATA, "web-runs.json");
setInterval(() => {
 try { writeFileSync(keeperRunsFile, JSON.stringify({ at: Date.now(), runs: keeper.running })); } catch {}
}, 5000);
const markContinued = () => {
 try {
  const state = readJsonSafe(updateStateFile) || {};
  // `at` stays as it was: refreshing it would make the one-shot banner look fresh again.
  writeFileSync(updateStateFile, JSON.stringify({ ...state, continued: true, announced: true }));
 } catch {}
};
// Carrying on after an update has a race to survive: the update leaves the chat id in
// update-state, and the first process started on the new build is usually spawned by the
// OLD supervisor — which notices the new install about twenty seconds later and steps the
// whole unit aside (exit 75). A run started in that short-lived process is killed mid-step
// (12 Oct, 11:29: the "I'm back" line arrived, the carried-on turn died four seconds later,
// the chat stayed silent). So the carry-on waits until the stack has settled; and while
// this process is the interim one — its own folder moved aside (…old-*), deleted under it,
// or its parent still working in the moved-aside copy — it keeps waiting instead of burning
// the one shot. The build that ends up serving is the one that carries the conversation on.
const CARRY_WAIT_MS = 25 * 1000;
const CARRY_RETRY_MS = 10 * 1000;
const CARRY_GIVE_UP_MS = 6 * 60 * 1000;
const carriesFrom = Date.now();
const movedAside = () => {
 try { if (/\.old-|\(deleted\)/.test(process.cwd())) return true; } catch {}
 try { if (/\.old-|\(deleted\)/.test(readlinkSync(`/proc/${process.ppid}/cwd`))) return true; } catch {}
 return false;
};
setTimeout(function carryOnWhenSettled() {
 const state = readJsonSafe(updateStateFile);
 if (!state || state.phase !== "done" || state.continued) return;
 if (movedAside() && Date.now() - carriesFrom < CARRY_GIVE_UP_MS) {
  setTimeout(carryOnWhenSettled, CARRY_RETRY_MS);
  return;
 }
 continueAfterUpdate();
}, CARRY_WAIT_MS);
let desktopPresence = [];
const PRESENCE_STALE = 20000;
function readDesktopPresence() {
 try {
  const text = readFileSync(join(USER_DATA, "presence.json"), "utf8").replace(/^\uFEFF/, "");
  const data = JSON.parse(text);
  const now = Date.now();
  return (Array.isArray(data?.runs) ? data.runs : []).filter(run => run?.id && now - (Number(run.at) || 0) < PRESENCE_STALE);
 } catch {
  // Unreadable (mid-write) or missing: null keeps the last good list instead of flashing
  // "nothing is running" at every page.
  return null;
 }
}
const presenceList = () => {
 const list = [...presence.values()];
 for (const run of desktopPresence) if (!presence.has(run.id)) list.push(run);
 return list;
};
// The client that just published its own presence already knows it: echoing the same list
// back made every page re-render its chat list for its own heartbeat.
function broadcastPresence(except = null) {
 const list = presenceList();
 const frame = JSON.stringify({ t: "event", channel: "presence:event", args: [list] });
 for (const client of wss.clients) {
  if (client === except || client.readyState !== 1) continue;
  try { client.send(frame); } catch {}
 }
}
// The desktop app cannot talk to this server directly, so it drops a heartbeat into
// userData/app.json. While that is fresh, pages may hand their turns to the app instead of
// running them in the browser, and the app streams them like any other turn.
const APP_STALE = 25000;
const appFile = () => join(USER_DATA, "app.json");
let lastAppStatus = { connected: false, at: 0, version: "" };
function appStatus() {
 try {
  const data = JSON.parse(readFileSync(appFile(), "utf8").replace(/^\uFEFF/, ""));
  lastAppStatus = { connected: Date.now() - (Number(data?.at) || 0) < APP_STALE, at: Number(data?.at) || 0, version: data?.version || "" };
  return lastAppStatus;
 } catch {
  // A mid-write read used to look like "the app is gone" for a moment: keep the last answer.
  return lastAppStatus;
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
// The file is named after the page's own request id, so the page can ask (delegate:check)
// whether the app ever took it — a request still sitting here never ran.
function delegate(request) {
 if (!request?.chatId) return false;
 try {
  mkdirSync(join(USER_DATA, "delegate"), { recursive: true });
  const id = String(request.id || "").replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 60) || `d-${Date.now().toString(36)}`;
  writeFileSync(join(USER_DATA, "delegate", `${id}.json`), JSON.stringify({ id, at: Date.now(), ...request }));
  return true;
 } catch {
  return false;
 }
}
// Whether the request file is still waiting (exists) or was taken and deleted by the app.
host.handlers.set("delegate:check", (event, id) => {
 const clean = String(id || "").replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 60);
 if (!clean) return { exists: false };
 return { exists: existsSync(join(USER_DATA, "delegate", `${clean}.json`)) };
});
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
    const next = readDesktopPresence();
    if (next) desktopPresence = next;
    broadcastPresence();
   }, 250);
  });
  // The watcher can miss changes (a replaced file, a rename) and used to leave pages with an
  // empty picture while a run was going: a slow poll keeps the list honest either way.
  setInterval(() => {
   const before = JSON.stringify(desktopPresence);
   const next = readDesktopPresence();
   if (!next) return;
   desktopPresence = next;
   if (JSON.stringify(next) !== before) broadcastPresence();
  }, 4000);
 } catch {}
} catch {}
// Who is connected right now, so the app's Auto page can list the devices and the port.
const clients = new Map();
let clientsTimer = 0;
function writeClients() {
 clearTimeout(clientsTimer);
 clientsTimer = setTimeout(() => {
  try {
   writeFileSync(join(USER_DATA, "web-clients.json"), JSON.stringify({ at: Date.now(), port: PORT, host: HOST, clients: [...clients.values()].filter(entry => Date.now() - entry.at < 120000) }));
  } catch {}
 }, 300);
}

// The updater's own state (available → downloading → installing → restarting → done):
// mirrored to every page, so a remote window or a phone can say that the device it is
// looking at is updating.
const updateStateFile = join(USER_DATA, "update-state.json");
let lastUpdateState = "";
const readUpdateStateFile = () => { try { return JSON.parse(readFileSync(updateStateFile, "utf8")); } catch { return null; } };
// "Done" is a one-shot notice, not a standing state: a page opening an hour later must not be
// told the server "just updated" (that made every reload show the same banner). It is handed
// out only while the update really is fresh.
const DONE_FRESH = 2 * 60 * 1000;
const freshUpdateState = () => {
 const state = readUpdateStateFile();
 if (state?.phase === "done" && Date.now() - (Number(state.at) || 0) > DONE_FRESH) return null;
 return state;
};
function broadcastUpdateState(force = false) {
 const state = freshUpdateState();
 const key = JSON.stringify(state || null);
 if (!force && key === lastUpdateState) return;
 lastUpdateState = key;
 for (const client of wss.clients) {
  if (client.readyState !== 1) continue;
  try { client.send(JSON.stringify({ t: "event", channel: "update:state", args: [state] })); } catch {}
 }
}
setInterval(() => broadcastUpdateState(), 2000);

wss.on("connection", (ws, req) => {
 const data = { id: ++connections };
 data.send = (channel, ...eventArgs) => { try { ws.send(JSON.stringify({ t: "event", channel, args: eventArgs })); } catch {} };
 // Who is connected, for the Auto page: the address is shown (blurred) next to the port.
 const ip = String(req?.socket?.remoteAddress || "").replace(/^::ffff:/, "") || "local";
 // The console says which device this is, not just an address: the LAN list knows the name,
 // system and version behind the ip (a phone that never beacons stays "unknown device").
 const describe = () => {
  try {
   const list = host.deviceList();
   const device = (list?.devices || []).find(item => item.host === ip);
   if (device) {
    const system = device.platform === "win32" ? "Windows" : device.platform === "linux" ? "Linux" : (device.platform || "");
    return [device.name, system, device.version ? `v${device.version}` : "", ip].filter(Boolean).join(" · ");
   }
  } catch {}
  return `unknown device · ${ip}`;
 };
 data.who = describe();
 const seen = clients.get(ip) || { ip, count: 0, first: Date.now(), at: Date.now() };
 seen.count += 1;
 seen.at = Date.now();
 clients.set(ip, seen);
 writeClients();
 console.log(`[${stamp()}] connection ${data.id} opened (${data.who})`);
 // A page that just opened asks for a snapshot right away — with the app's runs read fresh,
 // so connecting in the middle of a turn shows the live card at once.
 const mine = new Set();
 {
  const next = readDesktopPresence();
  if (next) desktopPresence = next;
 }
 data.send("presence:event", presenceList());
 data.send("app:status", [appStatus()]);
 data.send("update:state", freshUpdateState());
 ws.on("close", () => {
  for (const id of mine) presence.delete(id);
  if (mine.size) broadcastPresence();
  const entry = clients.get(ip);
  if (entry) {
   entry.count -= 1;
   entry.at = Date.now();
   if (entry.count <= 0) clients.delete(ip);
   writeClients();
  }
  console.log(`[${stamp()}] connection ${data.id} closed (${data.who || `unknown device · ${ip}`})`);
 });
 ws.on("message", async raw => {
  let msg;
  try { msg = JSON.parse(String(raw)); } catch { return; }
  host.setSender({ send: data.send, isDestroyed: () => false });
  const reply = (t, id, payload) => ws.send(JSON.stringify({ t, id, ...payload }));
  try {
   if (msg.t === "invoke") {
    if (msg.channel === "log:tail") { reply("result", msg.id, { value: LOG_RING.slice(-200) }); return; }
    const value = await host.invoke(msg.channel, ...(msg.args || []));
    reply("result", msg.id, { value });
    if (String(msg.channel).startsWith("tool:")) console.log(`[${stamp()}] ${msg.channel} ok`);
   } else if (msg.t === "send") {
    if (msg.channel === "log:page") {
     const text = String((msg.args || [])[0] || "");
     // Browser-extension noise ("Script error." with no source, wallet injections) is not
     // this app's problem and used to bury the real lines.
     if (!/^Script error\./.test(text) && !text.includes("window.ethereum")) {
      logLine(`[page ${data.id}] ${text.slice(0, 400)}`);
     }
     return;
    }
    if (msg.channel === "presence:set") {
     const [id, info] = msg.args || [];
     if (info && id) { mine.add(id); presence.set(id, { id, ...info }); }
     else if (id) { mine.delete(id); presence.delete(id); }
     broadcastPresence(ws);
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
 instance.update({ port });
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
