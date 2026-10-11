#!/usr/bin/env node
// prism server — the headless server for a Linux box: the web UI and the Discord bot in one
// process, no window and no desktop session. A child that dies is restarted after a pause,
// so a systemd unit (or nohup) can keep it up forever.
//
//   node tools/server.mjs                       web on :8787, Discord bot when configured
//   node tools/server.mjs --host 0.0.0.0 --port 8787
//   node tools/server.mjs --profile work        a separate workspace
//   node tools/server.mjs --no-web --no-bot     or either side alone
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
 const at = args.indexOf(name);
 return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const PROFILE = flag("--profile", "");
const PORT = flag("--port", "8787");
const HOST = flag("--host", "0.0.0.0");
const NO_WEB = args.includes("--no-web");
const NO_BOT = args.includes("--no-bot");
const ONCE = args.includes("--once");

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...parts) => console.log(`[${stamp()}]`, ...parts);

// The version this supervisor started with; an update swaps it on disk under our feet.
const version = () => {
 try { return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version || ""; } catch { return ""; }
};
const startedVersion = version();
let watching = startedVersion;

// The supervisor joins the shared instance registry and, before the children come up, stops
// every Prism process that belongs to another build — an old web server or bridge from before
// an update, an app started by a stale autostart, a second install. This is what keeps one
// Prism in charge of port 8787 instead of three of them fighting over it.
const requireModule = createRequire(import.meta.url);
const Instances = requireModule(join(root, "desktop", "instances.js"));
const USER_DATA = Instances.userDataFor(PROFILE);
const instance = Instances.attach({ userData: USER_DATA, role: "server", port: Number(PORT) || 0, version: startedVersion, root });
const sweepStrays = async why => {
 const done = await Instances.sweep(USER_DATA, {
  keepPid: process.pid,
  test: entry => Instances.isForeignBuild(entry, { root, version: version() }),
 }).catch(() => []);
 if (done.length) log(`stopped ${done.length} leftover Prism process(es) from another build (${why})`);
};
sweepStrays("startup");

const children = new Map();
let stopping = false;

function start(name, script, scriptArgs) {
 if (stopping) return;
 const child = spawn(process.execPath, [join(root, "tools", script), ...scriptArgs], {
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, PRISM_SUPERVISED: "1" },
 });
 children.set(name, child);
 log(`${name} started (pid ${child.pid})`);
 child.on("exit", code => {
  children.delete(name);
  if (stopping) return;
  // 1 = configuration problem (the Discord bot has no token yet): leave it off instead of
  // restarting every few seconds; the child explained what to set.
  if (code === 1) { log(`${name} is not set up — leaving it off until the next start`); return; }
  if (code === 0) return;
  // 75 = "the install changed under me" (an update): rotate the other helper too, so the
  // whole stack comes back on the same build instead of one half running the old code.
  if (code === 75) {
   log(`${name} updated the install — restarting the other helpers as well`);
   for (const [other, mate] of children) {
    if (other === name) continue;
    try { mate.kill("SIGTERM"); } catch {}
   }
   sweepStrays("update");
  }
  log(`${name} stopped${code != null ? ` (${code})` : ""} — restarting in 5s`);
  setTimeout(() => start(name, script, scriptArgs), 5000);
 });
 child.on("error", error => log(`${name} could not start:`, error.message));
}

if (!NO_WEB) start("web", "web-server.mjs", ["--host", HOST, "--port", String(PORT), "--no-open", ...(PROFILE ? ["--profile", PROFILE] : [])]);
if (!NO_BOT) start("discord", "discord-bridge.mjs", [...(PROFILE ? ["--profile", PROFILE] : [])]);

log(`prism server up — web on http://${HOST}:${PORT}${NO_BOT ? "" : ", Discord bot when a token is set"}`);

// An update can also land from elsewhere (the desktop app, the bot) while this supervisor
// keeps running: notice the new install and rotate. Under systemd the whole unit steps
// aside (exit 75) and comes back on the new build; without one, the children are bounced
// and come back with the new code on their own.
setInterval(() => {
 if (stopping) return;
 const fresh = version();
 if (!fresh || fresh === watching) return;
 log(`install changed to v${fresh} (this supervisor started v${startedVersion}) — rotating`);
 watching = fresh;
 sweepStrays("update");
 const supervised = Boolean(process.env.PRISM_SUPERVISED || process.env.INVOCATION_ID || process.env.JOURNAL_STREAM);
 if (supervised) { shutdown("update"); process.exit(75); }
 for (const child of children.values()) { try { child.kill("SIGTERM"); } catch {} }
}, 20000).unref?.();

function shutdown(signal) {
 if (stopping) return;
 stopping = true;
 log(`${signal} — stopping`);
 try { instance.stop(); } catch {}
 for (const child of children.values()) {
  try { child.kill("SIGTERM"); } catch {}
 }
 setTimeout(() => process.exit(0), 1500);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
if (ONCE) shutdown("--once");
