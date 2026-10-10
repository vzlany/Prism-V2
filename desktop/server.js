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

// --------------------------------------------------------------- Settings -> Server IPC
function info() {
 const cfg = read();
 return {
  ...cfg,
  os: process.platform,
  chosen: platform(),
  version: app.getVersion(),
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
}

module.exports = { read, write, platform, info, register, applyLinuxAutostart, sudoEnv, hasSudo, autostartFile };
