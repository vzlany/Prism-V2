'use strict';

// Looks at the GitHub releases of this repository at launch (and every six hours). A newer
// tag gets a plain dialog: download it and start it, or say Later. With "Install updates
// automatically" on (Settings -> About) the update is applied by itself once the app is idle:
// on Windows the Setup.exe is downloaded and started (the app quits while it installs); on
// Linux the tar.gz is downloaded, the install directory swapped, the sandbox bit fixed and
// the app relaunched. The releases API needs a GitHub token while the repository is private.
const { app, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const core = require('./update-core');
const Server = require('./server');

const DELAY = 3500;               // let the window settle before the first check
const PERIOD = 6 * 60 * 60 * 1000;
const RETRY = 10 * 60 * 1000;     // an automatic install waits for idle and tries again

const userData = () => app.getPath('userData');
const settings = () => core.readSettings(userData());
const token = () => core.tokenOf(settings());
const current = () => process.env.PRISM_UPDATE_TEST_VERSION || app.getVersion();
const isNewer = core.isNewer;
const installRoot = () => path.dirname(process.resourcesPath);

// The release for this machine when something newer exists, else null.
async function check() {
 const release = await core.latest({ token: token() });
 if (!release?.version || !isNewer(release.version, current())) return null;
 return { version: release.version, page: release.page, asset: core.pickAsset(release, process.platform) };
}

// Everything the About page and the AI tool need.
function params() {
 const stored = settings();
 return {
  auto: stored.auto !== false,
  install: stored.install === true,
  token: stored.token,
  hasToken: Boolean(token()),
  current: current(),
  platform: process.platform,
  packaged: app.isPackaged,
 };
}

function updateSettings(patch) {
 core.writeSettings(userData(), {
  ...(patch?.auto !== undefined ? { auto: patch.auto === true } : {}),
  ...(patch?.install !== undefined ? { install: patch.install === true } : {}),
  ...(patch?.token !== undefined ? { token: String(patch.token || '') } : {}),
 });
 return params();
}

// The question both the launch check and the About page ask.
async function prompt(win, info) {
 const { response } = await dialog.showMessageBox(win, {
  type: 'info',
  title: 'Prism V2 update',
  message: `Prism V2 ${info.version} is available`,
  detail: `You are on ${current()}. Download it now? The installer starts when it is ready.`,
  buttons: ['Download and install', 'Later'],
  defaultId: 0,
  cancelId: 1,
  noLink: true,
 });
 return response === 0;
}

// Downloads and applies the release. On Windows the app quits and the Setup.exe replaces it;
// on Linux the install directory is swapped and the app relaunches itself.
async function install(info) {
 if (!info?.asset) {
  shell.openExternal(info?.page || `https://github.com/${core.REPO}/releases`);
  return { opened: true };
 }
 const win = require('electron').BrowserWindow.getAllWindows()[0] || null;
 const file = path.join(app.getPath('temp'), 'Prism V2-update', info.asset.name);
 const progress = win ? value => win.setProgressBar(Math.max(0, Math.min(1, value))) : null;
 await core.download({ url: info.asset.url, file, token: token(), onProgress: progress });
 win?.setProgressBar(-1);
 if (process.platform === 'linux') {
  const root = installRoot();
  const applied = core.applyLinux({ root, tarFile: file });
  await core.fixSandbox(root, Server.sudoEnv()).catch(() => false);
  // The new build is in place; the running one steps aside.
  setTimeout(() => { app.relaunch(); app.exit(0); }, 1200);
  return { ok: true, version: applied.version || info.version, restart: true };
 }
 await shell.openPath(file);
 // The installer replaces this very installation: step aside once it is up.
 setTimeout(() => app.quit(), 2500);
 return { ok: true, version: info.version, restart: true };
}

// A manual "update now" (About page, or the AI's update_prism tool). force installs even when
// the running version equals the latest - useful to repair an install.
async function updateNow({ force = false, onProgress } = {}) {
 let release = null;
 try {
  release = await core.latest({ token: token() });
 } catch (error) {
  return { error: error.message };
 }
 if (!release?.version) return { error: 'no release found on GitHub' };
 const newer = isNewer(release.version, current());
 if (!newer && !force) return { latest: true, current: current() };
 const asset = core.pickAsset(release, process.platform);
 if (!asset) return { error: `v${release.version} has no build for this machine` };
 const info = { version: release.version, page: release.page, asset };
 try {
  const applied = await install(info);
  return { ok: true, version: applied.version || info.version, restart: applied.restart !== false };
 } catch (error) {
  return { error: error.message };
 }
}

// Runs in the background; a failed check is only a quiet line in the log. `isIdle` tells
// whether no turn is running (automatic installs wait for one).
function start({ isIdle } = {}) {
 if (!app.isPackaged && !process.env.PRISM_UPDATE_TEST_VERSION) return;
 const run = async () => {
  let info = null;
  try {
   info = await check();
  } catch (error) {
   console.log('[update] check failed:', error.message);
   return;
  }
  if (!info) return;
  console.log(`[update] ${info.version} available (running ${current()})`);
  const stored = settings();
  if (stored.install) {
   if (isIdle && !isIdle()) { setTimeout(run, RETRY); return; }
   try {
    await install(info);
   } catch (error) {
    console.log('[update] automatic install failed:', error.message);
    shell.openExternal(info.page);
   }
   return;
  }
  if (stored.auto === false) return; // manual checks only
  if (!(await prompt(require('electron').BrowserWindow.getAllWindows()[0] || null, info))) return;
  try {
   await install(info);
  } catch (error) {
   console.log('[update] download failed:', error.message);
   shell.openExternal(info.page);
  }
 };
 setTimeout(run, DELAY);
 setInterval(run, PERIOD);
}

module.exports = { start, check, prompt, install, updateNow, params, updateSettings, describe: core.message, isNewer, installRoot, prune: () => core.pruneOld(installRoot()) };
