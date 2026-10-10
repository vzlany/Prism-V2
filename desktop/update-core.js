'use strict';

// The plain-Node half of the updater: the update settings, the GitHub release lookup (which
// works with private repositories when a token is set), asset download, and the Linux install
// swap. The desktop app wraps this in updater.js (Windows uses the Setup.exe flow); the
// headless server (tools/engine-host.mjs) uses it directly so "update Prism V2" works when
// the AI is asked from the web or Discord.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const REPO = 'vzlany/Prism-V2';
const TIMEOUT = 20000;
const MAX_ASSET = 600 * 1024 * 1024;

// --------------------------------------------------------------- settings (store/update.json)
const settingsFile = userData => path.join(userData, 'store', 'update.json');

function readSettings(userData) {
 try {
  const stored = JSON.parse(fs.readFileSync(settingsFile(userData), 'utf8')) || {};
  return {
   auto: stored.auto !== false,
   install: stored.install === true,
   token: typeof stored.token === 'string' ? stored.token : '',
  };
 } catch {
  return { auto: true, install: false, token: '' };
 }
}

function writeSettings(userData, patch) {
 const next = { version: 1, ...readSettings(userData), ...(patch && typeof patch === 'object' ? patch : {}) };
 try {
  fs.mkdirSync(path.dirname(settingsFile(userData)), { recursive: true });
  fs.writeFileSync(settingsFile(userData), JSON.stringify(next));
 } catch {}
 return next;
}

// The token can also ride in the environment (the systemd unit), so a server needs no store edit.
const tokenOf = settings => String(settings?.token || process.env.PRISM_GITHUB_TOKEN || '');

// --------------------------------------------------------------- versions
const parts = value => String(value || '').replace(/^v/i, '').split('.').map(part => parseInt(part, 10) || 0);
function isNewer(a, b) {
 const x = parts(a), y = parts(b);
 for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
 return false;
}

function currentVersion(root) {
 try { return String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || ''); } catch { return ''; }
}

// --------------------------------------------------------------- GitHub
async function latest({ token = '' } = {}) {
 const headers = { 'User-Agent': 'Prism V2', Accept: 'application/vnd.github+json' };
 if (token) headers.Authorization = `token ${token}`;
 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), TIMEOUT);
 try {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers, signal: controller.signal });
  if (!response.ok) {
   if (response.status === 404 && !token) throw new Error('repository not found (404) — if it turned private, add a GitHub token in Settings → About');
   throw new Error(`GitHub said ${response.status}`);
  }
  const release = await response.json();
  const version = String(release?.tag_name || '').replace(/^v/i, '');
  if (!version) return null;
  return {
   version,
   name: String(release.name || release.tag_name || version),
   page: String(release.html_url || `https://github.com/${REPO}/releases`),
   assets: (release.assets || []).map(asset => ({ name: String(asset.name || ''), url: String(asset.browser_download_url || '') })),
  };
 } finally {
  clearTimeout(timer);
 }
}

// The release build for a platform: the Setup.exe on Windows, the tar.gz on Linux.
const pickAsset = (info, platform) => {
 const assets = info?.assets || [];
 if (platform === 'win32') return assets.find(asset => /setup\.exe$/i.test(asset.name)) || null;
 if (platform === 'linux') return assets.find(asset => /linux.*\.tar\.gz$/i.test(asset.name)) || null;
 return null;
};

async function download({ url, file, token = '', onProgress }) {
 const headers = { 'User-Agent': 'Prism V2' };
 if (token) headers.Authorization = `token ${token}`;
 const response = await fetch(url, { headers, redirect: 'follow' });
 if (!response.ok || !response.body) throw new Error(`the download failed (${response.status})`);
 const total = Math.min(Number(response.headers.get('content-length')) || 0, MAX_ASSET);
 fs.mkdirSync(path.dirname(file), { recursive: true });
 const part = `${file}.part`;
 const source = Readable.fromWeb(response.body);
 let got = 0;
 source.on('data', chunk => {
  got += chunk.length;
  if (got > MAX_ASSET) source.destroy(new Error('the download is larger than expected'));
  onProgress?.(total ? Math.min(1, got / total) : 0);
 });
 await pipeline(source, fs.createWriteStream(part));
 if (fs.statSync(part).size < 1024) { fs.rmSync(part, { force: true }); throw new Error('the download came back empty'); }
 fs.renameSync(part, file);
 return file;
}

// --------------------------------------------------------------- Linux install swap
// The install is a plain directory (prism-v2 + resources/app). The new build is unpacked next
// to it — same filesystem, so the swap is two renames — and the running process keeps its open
// files: on Linux it is safe to replace the tree under a live app.
function lockFile(root) {
 return `${root}.update.lock`;
}

function lock(root) {
 const file = lockFile(root);
 try {
  fs.writeFileSync(file, JSON.stringify({ at: Date.now(), pid: process.pid }), { flag: 'wx' });
  return true;
 } catch (error) {
  if (error.code !== 'EEXIST') return false;
  try {
   const held = JSON.parse(fs.readFileSync(file, 'utf8'));
   if (held?.at && Date.now() - held.at < 15 * 60 * 1000) return false;
  } catch {}
  try { fs.rmSync(file, { force: true }); fs.writeFileSync(file, JSON.stringify({ at: Date.now(), pid: process.pid }), { flag: 'wx' }); return true; } catch { return false; }
 }
}

function unlock(root) {
 try { fs.rmSync(lockFile(root), { force: true }); } catch {}
}

function applyLinux({ root, tarFile }) {
 if (!fs.existsSync(path.join(root, 'resources', 'app', 'package.json'))) throw new Error('this install cannot update itself (no resources/app found)');
 if (!lock(root)) throw new Error('an update is already running');
 const work = fs.mkdtempSync(path.join(path.dirname(root), '.prism-update-'));
 try {
  const tar = spawnSync('tar', ['-xzf', tarFile, '-C', work], { encoding: 'utf8' });
  if (tar.status !== 0) throw new Error(`could not unpack the update: ${String(tar.stderr || '').trim().slice(0, 300) || `tar exited ${tar.status}`}`);
  const top = fs.readdirSync(work)
   .map(name => path.join(work, name))
   .find(entry => {
    try { return fs.statSync(entry).isDirectory() && fs.existsSync(path.join(entry, 'resources', 'app', 'package.json')); } catch { return false; }
   });
  if (!top) throw new Error('the archive does not contain a Prism V2 install');
  const version = currentVersion(path.join(top, 'resources', 'app'));
  const old = `${root}.old-${Date.now().toString(36)}`;
  fs.renameSync(root, old);
  try {
   fs.renameSync(top, root);
  } catch (error) {
   try { fs.renameSync(old, root); } catch {}
   throw error;
  }
  return { version, old };
 } finally {
  try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  unlock(root);
 }
}

// Old trees from earlier swaps are left for the next start, when nothing runs from them.
function pruneOld(root) {
 try {
  const dir = path.dirname(root), base = path.basename(root);
  for (const name of fs.readdirSync(dir)) {
   if (!name.startsWith(`${base}.old-`)) continue;
   try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch {}
  }
 } catch {}
}

const quote = value => '"' + String(value).replace(/(["\\$`])/g, '\\$1') + '"';

// After a swap the fresh chrome-sandbox lost its setuid bit. When the root password is saved,
// sudo puts it back; without it the user-namespace sandbox usually still works.
async function fixSandbox(root, sudo = null) {
 if (process.platform !== 'linux') return false;
 const file = path.join(root, 'chrome-sandbox');
 if (!fs.existsSync(file)) return false;
 const command = sudo
  ? `sudo -A chown root:root ${quote(file)} && sudo -A chmod 4755 ${quote(file)}`
  : `chown root:root ${quote(file)} && chmod 4755 ${quote(file)}`;
 const attempt = env => new Promise(resolve => {
  const child = spawn('bash', ['-c', command], { env: env ? { ...process.env, ...env } : process.env, stdio: 'ignore' });
  child.on('error', () => resolve(false));
  child.on('close', code => resolve(code === 0));
 });
 if (!sudo) return attempt(null);
 return (await attempt(null)) || attempt(sudo);
}

// One wording for the app and the AI tool.
function message(result) {
 if (!result) return 'Could not update.';
 if (result.error) return `Could not update: ${result.error}`;
 if (result.latest) return `Prism V2 is already on the latest version (v${result.current}).`;
 if (result.ok) return `Prism V2 updated to v${result.version}.${result.restart === false ? ' Restart it to use the new version.' : ' It restarts by itself now — back in a few seconds.'}`;
 return 'Could not update.';
}

module.exports = { REPO, readSettings, writeSettings, tokenOf, isNewer, currentVersion, latest, pickAsset, download, applyLinux, pruneOld, fixSandbox, message };
