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

const children = new Map();
let stopping = false;

function start(name, script, scriptArgs) {
 if (stopping) return;
 const child = spawn(process.execPath, [join(root, "tools", script), ...scriptArgs], {
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env },
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
  log(`${name} stopped${code != null ? ` (${code})` : ""} — restarting in 5s`);
  setTimeout(() => start(name, script, scriptArgs), 5000);
 });
 child.on("error", error => log(`${name} could not start:`, error.message));
}

if (!NO_WEB) start("web", "web-server.mjs", ["--host", HOST, "--port", String(PORT), "--no-open", ...(PROFILE ? ["--profile", PROFILE] : [])]);
if (!NO_BOT) start("discord", "discord-bridge.mjs", [...(PROFILE ? ["--profile", PROFILE] : [])]);

log(`prism server up — web on http://${HOST}:${PORT}${NO_BOT ? "" : ", Discord bot when a token is set"}`);

function shutdown(signal) {
 if (stopping) return;
 stopping = true;
 log(`${signal} — stopping`);
 for (const child of children.values()) {
  try { child.kill("SIGTERM"); } catch {}
 }
 setTimeout(() => process.exit(0), 1500);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
if (ONCE) shutdown("--once");
