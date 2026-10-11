'use strict';

// Settings -> Server: which machine this install serves (Auto follows the machine it runs on,
// or the user picks Windows/Linux explicitly for the Debian server), the root password the
// shell tools may hand to sudo on Linux, and the Linux autostart entry. Windows keeps its
// Startup-folder shortcut (main.js), macOS its login item — Linux gets an XDG desktop entry,
// written here, which every Debian session reads.
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MODES = ['auto', 'windows', 'linux'];

// The root password lives on this machine only, in userData/server.json — never in the shared
// store, so it does not travel to the phone or another profile.
function file() {
 return path.join(app.getPath('userData'), 'server.json');
}

function read() {
 let stored = {};
 try { stored = JSON.parse(fs.readFileSync(file(), 'utf8')) || {}; } catch {}
 const platform = MODES.includes(stored.platform) ? stored.platform : 'auto';
 return { platform, sudo: typeof stored.sudo === 'string' ? stored.sudo : '' };
}

function write(patch) {
 const next = { ...read(), ...(patch && typeof patch === 'object' ? patch : {}) };
 if (!MODES.includes(next.platform)) next.platform = 'auto';
 next.sudo = String(next.sudo ?? '');
 try {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  try { fs.chmodSync(file(), 0o600); } catch {}
 } catch {}
 return next;
}

// The platform the user picked, or this machine when the choice is Auto.
function platform() {
 const chosen = read().platform;
 if (chosen === 'windows') return 'win32';
 if (chosen === 'linux') return 'linux';
 return process.platform;
}

// --------------------------------------------------------------- Linux autostart
function autostartFile() {
 const home = process.env.HOME || os.homedir();
 return path.join(home, '.config', 'autostart', 'prism-v2.desktop');
}

const quote = value => {
 const text = String(value ?? '');
 return /[\s"'`$\\]/.test(text) ? `"${text.replace(/(["\\`$])/g, '\\$1')}"` : text;
};

// `enabled` mirrors Settings -> Auto "start with the system"; `args` are the launch arguments
// (the checkout path in development, --hidden when it should go straight to the tray).
function applyLinuxAutostart(enabled, args = []) {
 if (process.platform !== 'linux') return false;
 const target = autostartFile();
 try {
  if (!enabled) {
   fs.rmSync(target, { force: true });
   return false;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const exec = [process.execPath, ...args].map(quote).join(' ');
  fs.writeFileSync(target, [
   '[Desktop Entry]',
   'Type=Application',
   'Name=Prism V2',
   'Comment=Prism V2 — the local AI agent',
   `Exec=${exec}`,
   'Terminal=false',
   'X-GNOME-Autostart-enabled=true',
   '',
  ].join('\n'));
  return true;
 } catch (error) {
  console.log('[auto] could not write the Linux autostart entry:', error.message);
  return false;
 }
}

// --------------------------------------------------------------- autostart after updates
// An update must never leave the autostart of an older install behind: at the end of every
// update (and when a new build boots) every prism*.desktop in the autostart folder is
// checked — this install's entry is rewritten to the current binary, entries that point to
// a tree or binary that no longer exists are removed. When nothing is set up, nothing is
// created (that stays the user's choice in Settings -> Auto).
function ensureLinuxAutostart(installRoot = '') {
 if (process.platform !== 'linux') return { fixed: 0, removed: 0 };
 const dir = path.dirname(autostartFile());
 const own = path.basename(autostartFile());
 const binary = installRoot ? path.join(installRoot, 'prism-v2') : process.execPath;
 let names = [];
 try { names = fs.readdirSync(dir).filter(name => /^prism.*\.desktop$/i.test(name)); } catch { return { fixed: 0, removed: 0 }; }
 if (!names.length) return { fixed: 0, removed: 0 };
 const result = { fixed: 0, removed: 0 };
 for (const name of names) {
  const file = path.join(dir, name);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  const exec = String(/^Exec=(.+)$/m.exec(text)?.[1] || '').trim();
  const script = exec.split(/\s+/)[0].replace(/^"|"$/g, '');
  const alive = Boolean(script && fs.existsSync(script));
  if (name === own && fs.existsSync(binary)) {
   if (script !== binary) {
    const hidden = /--hidden/.test(exec) ? ' --hidden' : '';
    try {
     const next = /^Exec=/m.test(text) ? text.replace(/^Exec=.*$/m, `Exec=${quote(binary)}${hidden}`) : `${text.trimEnd()}\nExec=${quote(binary)}${hidden}\n`;
     fs.writeFileSync(file, next);
     result.fixed += 1;
    } catch {}
   }
   continue;
  }
  if (!alive) {
   try { fs.rmSync(file, { force: true }); result.removed += 1; } catch {}
  }
 }
 return result;
}

// --------------------------------------------------------------- sudo (Linux)
// sudo gets the password through an askpass helper: the helper file holds no secret, the
// password rides in the environment for the one command being run.
function askpassFile() {
 return path.join(app.getPath('userData'), 'sudo-askpass.sh');
}

function sudoEnv() {
 if (process.platform !== 'linux') return null;
 const { sudo } = read();
 if (!sudo) return null;
 const helper = askpassFile();
 try {
  const body = '#!/bin/sh\nprintf \'%s\\n\' "$PRISM_SUDO_PASS"\n';
  if (!fs.existsSync(helper) || fs.readFileSync(helper, 'utf8') !== body) {
   fs.writeFileSync(helper, body);
   try { fs.chmodSync(helper, 0o700); } catch {}
  }
 } catch {
  return null;
 }
 return { SUDO_ASKPASS: helper, PRISM_SUDO_PASS: sudo };
}

// Whether a root password is set: shown to the agent so it knows installations are possible.
function hasSudo() {
 return Boolean(read().sudo);
}

// "Test" on the Server page: sudo -v through the same askpass helper a command would use.
function sudoTest() {
 return new Promise(resolve => {
  if (process.platform !== 'linux') { resolve({ ok: false, error: 'this machine is not Linux' }); return; }
  const env = sudoEnv();
  if (!env) { resolve({ ok: false, error: 'no sudo password is saved' }); return; }
  let output = '';
  const child = spawn('bash', ['-c', 'sudo -A -v'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve({ ok: false, error: 'timed out' }); }, 15000);
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.on('error', error => { clearTimeout(timer); resolve({ ok: false, error: error.message }); });
  child.on('close', code => {
   clearTimeout(timer);
   resolve({ ok: code === 0, error: String(output).replace(/\s+/g, ' ').trim().slice(0, 200) });
  });
 });
}

// --------------------------------------------------------------- Settings -> Server IPC
function info() {
 const cfg = read();
 return {
  ...cfg,
  os: process.platform,
  chosen: platform(),
  version: app.getVersion(),
  host: os.hostname(),
  home: process.env.HOME || os.homedir(),
  userData: app.getPath('userData'),
  autostart: process.platform === 'linux' ? autostartFile() : '',
  sudoReady: hasSudo(),
 };
}

function register(fromApp, ipcMain) {
 ipcMain.handle('server:get', event => (fromApp(event) ? info() : null));
 ipcMain.handle('server:set', (event, patch) => {
  if (!fromApp(event)) return null;
  write({
   ...(patch?.platform !== undefined ? { platform: patch.platform } : {}),
   ...(patch?.sudo !== undefined ? { sudo: String(patch.sudo) } : {}),
  });
  return info();
 });
 ipcMain.handle('server:sudo-test', async event => (fromApp(event) ? sudoTest() : null));
}

module.exports = { read, write, platform, info, register, applyLinuxAutostart, ensureLinuxAutostart, sudoEnv, hasSudo, sudoTest, autostartFile };
