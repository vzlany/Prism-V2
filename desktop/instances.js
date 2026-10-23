'use strict';

// Every running Prism engine on this machine — the desktop app, the headless supervisor
// (tools/server.mjs), the web server child and the Discord bridge — announces itself here, so
// "who else is running, and from which build?" has one answer. Two problems need it: an
// update must stop the leftovers of the old build instead of letting them fight over the web
// port, and a starting engine must know whether the process holding its port belongs to a
// newer one (then it waits) or to an older install (then it may take over).
//
// The file is <userData>/instances.json. It is written by every engine with a heartbeat and
// cleaned by itself: an entry that stops beating, or whose process is gone, is dead. Pids are
// re-verified before anything is stopped, so a recycled pid is never killed by mistake.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TTL = 60000;   // an entry with no heartbeat for a minute is considered dead
const BEAT = 20000;  // heartbeat period

const file = userData => path.join(userData, 'instances.json');

// The same userData engine-host.mjs resolves (APPDATA on Windows, ~/.config elsewhere), so a
// tool that never builds an engine host can still join the registry.
function userDataFor(profile = '') {
 const base = process.env.APPDATA || path.join(process.env.HOME || '.', '.config');
 return path.join(base, 'Prism V2' + (profile ? `-${profile}` : ''));
}

const read = userData => {
 try {
  const data = JSON.parse(fs.readFileSync(file(userData), 'utf8'));
  return Array.isArray(data?.entries) ? data : { at: 0, entries: [] };
 } catch { return { at: 0, entries: [] }; }
};

const write = (userData, entries) => {
 try {
  fs.mkdirSync(userData, { recursive: true });
  const target = file(userData);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, at: Date.now(), entries }));
  fs.renameSync(temp, target);
 } catch {}
};

const alive = pid => {
 try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
};

// Is the pid really still the kind of process the entry described? (Windows: the image name
// from tasklist; Linux: the command line of the process.)
function verified(entry) {
 if (!entry?.pid) return false;
 if (entry.pid === process.pid) return true;
 if (!alive(entry.pid)) return false;
 try {
  if (process.platform === 'linux') {
   const cmd = fs.readFileSync(`/proc/${entry.pid}/cmdline`, 'utf8').split('\0').join(' ').trim();
   if (!cmd) return false;
   if (entry.root && cmd.includes(entry.root)) return true;
   const wanted = ['web-server.mjs', 'discord-bridge.mjs', 'server.mjs', 'main.js', 'prism-cli.mjs'];
   if (wanted.some(name => cmd.includes(name))) return true;
   // A packaged binary: the exe path carries the app name.
   return /prism/i.test(cmd);
  }
  if (process.platform === 'win32') {
   const out = spawnSync('tasklist', ['/FI', `PID eq ${entry.pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
   const text = String(out.stdout || '').toLowerCase();
   if (!text) return true;
   if (/prism v2/.test(text)) return true;
   return /(electron|node)\.exe/.test(text) && /(web-server|discord-bridge|server)\.mjs|prism/i.test(String(entry.exe || entry.root || ''));
  }
  return true;
 } catch { return false; }
}

// The entries that are alive right now, newest heartbeat wins per pid.
function list(userData) {
 const seen = new Map();
 for (const entry of read(userData).entries) {
  if (!entry?.pid || !entry.at || Date.now() - entry.at > TTL) continue;
  const prior = seen.get(entry.pid);
  if (!prior || (entry.at || 0) > (prior.at || 0)) seen.set(entry.pid, entry);
 }
 return [...seen.values()].filter(entry => entry.pid === process.pid || alive(entry.pid));
}

// Publish this process (once per role). Returns a handle with the heartbeat and a clean stop.
function attach({ userData, role, port = 0, version = '', root = '', extra = {} }) {
 if (!userData || !role) throw new Error('instances.attach needs userData and role');
 const startedAt = Date.now();
 const state = { role, port: Number(port) || 0, version: String(version || ''), root: String(root || ''), extra: { ...extra } };
 const beat = () => {
  const entries = read(userData).entries
   .filter(entry => entry?.pid && entry.pid !== process.pid && entry.at && Date.now() - entry.at < TTL * 4);
  entries.push({
   pid: process.pid,
   role: state.role,
   port: state.port,
   version: state.version,
   root: state.root,
   exe: process.execPath,
   startedAt,
   at: Date.now(),
   ...state.extra,
  });
  write(userData, entries);
 };
 beat();
 const timer = setInterval(beat, BEAT);
 timer.unref?.();
 return {
  beat,
  update(patch = {}) {
   if (patch.port !== undefined) state.port = Number(patch.port) || 0;
   if (patch.version !== undefined) state.version = String(patch.version || '');
   if (patch.root !== undefined) state.root = String(patch.root || '');
   if (patch.extra && typeof patch.extra === 'object') state.extra = { ...state.extra, ...patch.extra };
   beat();
  },
  stop() {
   clearInterval(timer);
   const entries = read(userData).entries.filter(entry => entry?.pid !== process.pid);
   write(userData, entries);
  },
 };
}

// Stop another engine (graceful first, then firm) and drop its entry.
function stopEntry(userData, entry, { grace = 3000 } = {}) {
 const result = { pid: entry.pid, role: entry.role, killed: false, forced: false };
 try { process.kill(entry.pid, 'SIGTERM'); } catch { return finish(userData, entry, result); }
 const until = Date.now() + grace;
 // A plain synchronous pause: callers here are startup paths that may be scripts without an
 // event loop to spare. It only ever runs while something old is actually being stopped.
 while (Date.now() < until && alive(entry.pid)) {
  try { spawnSync(process.platform === 'win32' ? 'cmd' : 'sleep', process.platform === 'win32' ? ['/c', 'ping', '-n', '1', '127.0.0.1'] : ['0.2']); } catch {}
 }
 if (alive(entry.pid)) {
  try { process.kill(entry.pid, 'SIGKILL'); result.forced = true; } catch {}
 }
 return finish(userData, entry, result);
}

function finish(userData, entry, result) {
 result.killed = !alive(entry.pid);
 const entries = read(userData).entries.filter(item => item?.pid !== entry.pid);
 write(userData, entries);
 return result;
}

// The async twin, for callers with an event loop (tool runs, update flows).
async function stopEntryAsync(userData, entry, { grace = 3000 } = {}) {
 const result = { pid: entry.pid, role: entry.role, killed: false, forced: false };
 try { process.kill(entry.pid, 'SIGTERM'); } catch { return finish(userData, entry, result); }
 const until = Date.now() + grace;
 while (Date.now() < until && alive(entry.pid)) await new Promise(resolve => setTimeout(resolve, 200));
 if (alive(entry.pid)) {
  try { process.kill(entry.pid, 'SIGKILL'); result.forced = true; } catch {}
 }
 return finish(userData, entry, result);
}

// Stop every listed engine that `test` accepts (and that is re-verified as a Prism process).
async function sweep(userData, { keepPid = process.pid, test = () => true, grace = 3000 } = {}) {
 const targets = list(userData).filter(entry => entry.pid !== keepPid && test(entry) && verified(entry));
 const done = [];
 for (const entry of targets) done.push(await stopEntryAsync(userData, entry, { grace }));
 return done;
}

// Stop the engines of any other build: a different install root (an old .old-* tree, a second
// install next to this one) or a different version. Same build, same version keeps running.
const isForeignBuild = (entry, { root, version }) => {
 const entryRoot = String(entry.root || '');
 const ownRoot = String(root || '');
 if (entryRoot && ownRoot && entryRoot !== ownRoot) return true;
 const entryVersion = String(entry.version || '');
 const ownVersion = String(version || '');
 return Boolean(entryVersion && ownVersion && entryVersion !== ownVersion);
};

// The engine that is already doing this machine's serving: `prism server` under systemd, a web
// server left running in a terminal, a bot that outlived its app. A window opening on top of it
// brings the interface and must start nothing of its own — a second web server fights for the
// port and a second bot for the lock file — so this is what tells it to join instead.
function background(userData, { roles = ['server', 'web', 'bridge'], exclude = [] } = {}) {
 const skip = new Set([process.pid, ...exclude.filter(Boolean).map(Number)]);
 const live = list(userData).filter(entry => !skip.has(entry.pid) && roles.includes(entry.role) && verified(entry));
 if (!live.length) return null;
 const pick = role => live.find(entry => entry.role === role) || null;
 const server = pick('server'), web = pick('web'), bot = pick('bridge');
 const first = server || web || bot;
 return {
  pid: first.pid,
  roles: [server && 'server', web && 'web', bot && 'bot'].filter(Boolean),
  port: Number(server?.port || web?.port) || 0,
  version: first.version || '',
 };
}

module.exports = { userDataFor, attach, list, stopEntry, stopEntryAsync, sweep, verified, isForeignBuild, background, file };
