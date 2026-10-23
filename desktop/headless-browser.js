'use strict';

// The agent's own browser — a real one, launched invisibly on this machine and driven with the
// same browser_* tools as the panel on the right of the desktop app. The panel needs a window
// and someone looking at it; this one needs neither, so the agent can open a page, click
// through a catalogue or read what JavaScript rendered even from `prism web`, from
// `prism server` under systemd, or from a Discord DM — with no app window open anywhere.
//
// It is headless: nothing appears on any screen, so only the agent sees the page. The profile
// lives in <userData>/browser-profile, next to the rest of this install's state, so a site
// stays logged in between runs exactly like the panel's own partition.
//
// The engine is Playwright (Chromium when the machine has it, Firefox otherwise). Prism does
// not ship it — it is a ~300 MB browser download and most desktops use the panel — so it is
// looked up in a few known places. `prism browser install` puts it where it is found here.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
const { INSTALL } = require('./browser');

const ROOT = path.join(__dirname, '..');
const WAIT = { load: 30000, stop: 15000, call: 15000, quiet: [300, 2000], pointer: 300 };
const VIEW = { width: 1280, height: 900 };
const IDLE = 10 * 60 * 1000;   // a browser nobody touched for this long is put away
const SHOT = { quality: 78, max: 1400, tall: 4 };
const READ_MAX = 4 * 1024 * 1024;
const WAIT_MAX = 60;

// --------------------------------------------------------------- engine lookup
// Where a Playwright install may sit. PRISM_PLAYWRIGHT wins (a path to the package or to its
// folder), then the install's own node_modules, then the per-install browser folder that
// `prism browser install` fills.
function candidates() {
 const out = [];
 const add = value => { if (value && !out.includes(value)) out.push(value); };
 add(process.env.PRISM_PLAYWRIGHT);
 add(path.join(ROOT, 'node_modules', 'playwright'));
 add(path.join(ROOT, '..', 'node_modules', 'playwright'));
 try { add(path.join(app.getPath('userData'), 'browser', 'node_modules', 'playwright')); } catch {}
 add(path.join(os.homedir(), '.prism', 'browser', 'node_modules', 'playwright'));
 add('/usr/lib/node_modules/playwright');
 add('/usr/local/lib/node_modules/playwright');
 return out;
}

let engine = null;
let engineError = null;

function loadEngine() {
 if (engine || engineError) return engine;
 for (const where of candidates()) {
  try {
   engine = require(where);
   return engine;
  } catch {}
 }
 engineError = 'No browser engine is installed on this machine, and the desktop app is not the one running the tools.';
 return null;
}

function installHint() {
 return 'Install it once with: prism browser install  (or npm i playwright && npx playwright install chromium inside '
  + '<userData>/browser — Settings → Server shows the folder).';
}

const plain = message => Object.assign(new Error(message), { plain: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function timed(promise, ms, message) {
 let timer;
 return Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(plain(message)), ms); })]).finally(() => clearTimeout(timer));
}

function userAgent() {
 const chrome = process.versions.chrome || '141.0.0.0';
 const system = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
  : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
   : 'X11; Linux x86_64';
 return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

// --------------------------------------------------------------- the session
const session = { context: null, launching: null, active: 0, idle: 0, downloads: [] };

async function launch() {
 const pw = loadEngine();
 if (!pw) throw plain(`${engineError} ${installHint()}`);
 const profile = path.join(app.getPath('userData'), 'browser-profile');
 fs.mkdirSync(profile, { recursive: true });
 const options = {
  headless: true,
  viewport: VIEW,
  userAgent: userAgent(),
  acceptDownloads: true,
  locale: 'en-US',
  // The profile is Prism's own: no extension from the user's desktop browser, no shared
  // cookies, and a fresh page per task.
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
 };
 const problems = [];
 for (const kind of [pw.chromium, pw.firefox]) {
  if (!kind) continue;
  try {
   const context = await timed(kind.launchPersistentContext(profile, options), 60000, 'The browser took too long to start');
   context.addInitScript(INSTALL);
   context.on('page', page => { page.on('download', item => record(item)); });
   for (const page of context.pages()) page.on('download', item => record(item));
   session.context = context;
   session.active = 0;
   context.on('close', () => { session.context = null; });
   return context;
  } catch (error) {
   problems.push(String(error?.message || error).split('\n')[0]);
  }
 }
 throw plain(`The browser could not start: ${problems.join(' · ')}. ${installHint()}`);
}

function record(item) {
 try {
  const folder = path.join(app.getPath('downloads'), 'prism');
  fs.mkdirSync(folder, { recursive: true });
  const base = String(item.suggestedFilename() || 'download').replace(/[\\/:*?"<>|]/g, '_');
  let file = path.join(folder, base), k = 1;
  while (fs.existsSync(file)) file = path.join(folder, `${path.parse(base).name} (${k++})${path.parse(base).ext}`);
  item.saveAs(file).then(() => session.downloads.push({ file, at: Date.now(), told: false })).catch(() => {});
 } catch {}
}

async function context() {
 if (session.context) return session.context;
 if (!session.launching) session.launching = launch().finally(() => { session.launching = null; });
 return session.launching;
}

// Tabs are the pages of the one context, in the order they were opened.
function tabs() {
 if (!session.context) return [];
 return session.context.pages().filter(page => !page.isClosed());
}

async function page() {
 const ctx = await context();
 const open = tabs();
 if (!open.length) {
  const fresh = await ctx.newPage();
  await fresh.goto('about:blank').catch(() => {});
  session.active = 0;
  return fresh;
 }
 if (session.active >= open.length) session.active = open.length - 1;
 const current = open[session.active];
 // A page loaded before the script was installed (the first about:blank) still needs it.
 await current.evaluate(INSTALL).catch(() => {});
 return current;
}

function touch() {
 clearTimeout(session.idle);
 session.idle = setTimeout(() => { close().catch(() => {}); }, IDLE);
 session.idle.unref?.();
}

async function close() {
 clearTimeout(session.idle);
 const ctx = session.context;
 session.context = null;
 if (ctx) await ctx.close().catch(() => {});
}

// --------------------------------------------------------------- page helpers
const CALL = `(async () => { try { return { ok: await (__EXPR__) }; } catch (error) { return { error: String((error && error.message) || error) }; } })()`;

async function world(target, expression) {
 const code = CALL.replace('__EXPR__', expression);
 const answer = await timed(target.evaluate(code), WAIT.call, 'The page is not responding');
 if (answer?.error) throw plain(answer.error);
 return answer?.ok;
}

function normalize(value) {
 const text = String(value || '').trim();
 if (!text) throw plain('url is empty');
 if (/^(https?|file|about|data):/i.test(text)) return text;
 if (text.startsWith('/')) return `file://${text}`;
 if (/^[a-zA-Z]:[\\/]/.test(text)) return `file:///${text.replace(/\\/g, '/')}`;
 if (/^(back|forward|reload)$/i.test(text)) return text.toLowerCase();
 if (/^(localhost|127\.0\.0\.1|\[::1\]|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(text)) return `http://${text}`;
 if (!/\s/.test(text) && /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/|$|\?|#)/i.test(text)) return `https://${text}`;
 return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

async function settle(target, loading = false) {
 await sleep(loading ? 250 : 120);
 await target.waitForLoadState('domcontentloaded', { timeout: WAIT.stop }).catch(() => {});
 await world(target, `__og.quiet(${WAIT.quiet[0]}, ${WAIT.quiet[1]})`).catch(() => {});
}

function percent(scroll) {
 const room = scroll.height - scroll.vh;
 return room > 4 ? Math.round((scroll.top / room) * 100) : 0;
}

async function state(target, { full = false, note = '' } = {}) {
 const snap = await world(target, `__og.snapshot(${JSON.stringify({ full })})`);
 const scroll = snap.scroll, head = [];
 if (note) head.push(note);
 head.push(`Page: ${(await target.title().catch(() => '')) || '(no title)'}`, `URL: ${target.url()}`);
 const screens = scroll.height / Math.max(1, scroll.vh);
 head.push(screens > 1.05
  ? `Viewport ${scroll.vw}×${scroll.vh}, scrolled ${percent(scroll)}% of a page ${screens.toFixed(1)} screens tall.`
  : `Viewport ${scroll.vw}×${scroll.vh}, the whole page fits on screen.`);
 const fresh = session.downloads.filter(item => !item.told);
 for (const item of fresh) { item.told = true; head.push(`Downloaded: ${item.file}`); }
 while (session.downloads.length > 20) session.downloads.shift();
 const tail = [];
 if (snap.skipped) tail.push(`[… ${snap.skipped} more lines not shown. ${full ? 'Scroll to them and take a snapshot' : 'Call browser_snapshot with full true or scroll'}.]`);
 else if (!full && scroll.below > 8) tail.push('[More content below: scroll down to see it.]');
 const body = snap.lines.length ? snap.lines.join('\n') : '(nothing readable on screen)';
 return {
  text: `Invisible browser on this machine (headless, no window — only you see it)\n${head.join('\n')}\n\n${body}${tail.length ? `\n${tail.join('\n')}` : ''}`,
  refs: snap.refs,
 };
}

async function pointFor(target, ref) {
 const spot = await world(target, `__og.point(${Number(ref)})`);
 return spot;
}

async function screenshot(target, full) {
 const size = await world(target, `({ w: innerWidth, h: Math.min(${full ? 'document.documentElement.scrollHeight' : 'innerHeight'}, innerHeight * ${SHOT.tall}) })`).catch(() => VIEW);
 const buffer = await timed(
  target.screenshot({ type: 'jpeg', quality: SHOT.quality, fullPage: !!full, timeout: WAIT.call }),
  WAIT.call,
  'The page did not draw a screenshot');
 const width = Math.min(SHOT.max, size?.w || VIEW.width), height = Math.round((size?.h || VIEW.height) * (width / (size?.w || VIEW.width)));
 return { image: `data:image/jpeg;base64,${buffer.toString('base64')}`, width, height, scale: 1 };
}

const KEYS = {
 enter: 'Enter', return: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape',
 backspace: 'Backspace', delete: 'Delete', space: 'Space', ' ': 'Space',
 arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
 up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
 pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End',
};

function combo(key) {
 const parts = String(key || '').split('+').map(part => part.trim()).filter(Boolean);
 if (!parts.length) throw plain('key is empty');
 const out = [];
 for (const part of parts.slice(0, -1)) {
  const name = part.toLowerCase();
  const mapped = name === 'ctrl' || name === 'control' ? 'Control'
   : name === 'cmd' || name === 'meta' || name === 'win' ? 'Meta'
    : name === 'alt' ? 'Alt' : name === 'shift' ? 'Shift' : '';
  if (!mapped) throw plain(`Unknown modifier ${part}. Use Control, Alt, Shift or Meta.`);
  out.push(mapped);
 }
 const last = parts.at(-1);
 const named = KEYS[last.toLowerCase()];
 if (named) return [...out, named].join('+');
 if (last.length !== 1) throw plain(`Unknown key ${last}. Use Enter, Tab, Escape, Backspace, Delete, Space, arrows, PageUp, PageDown, Home, End or a single character.`);
 return [...out, last].join('+');
}

async function tabsTool(args) {
 const action = String(args.action || 'list').toLowerCase();
 const list = () => tabs();
 const line = () => {
  const open = list();
  if (!open.length) return 'No tabs are open.';
  return open.map((item, k) => `${k + 1}. ${tabName(item)}${k === session.active ? ' (current)' : ''}`).join('\n');
 };
 const pick = () => {
  const open = list();
  const index = Math.round(Number(args.tab)) - 1;
  if (!open[index]) throw plain(`There is no tab ${args.tab}. Tabs:\n${line()}`);
  return index;
 };
 if (action === 'new') {
  const ctx = await context();
  const fresh = await ctx.newPage();
  session.active = Math.max(0, tabs().indexOf(fresh));
  if (!args.url) return { text: `Opened a new tab.\nTabs:\n${line()}` };
  const result = await act('browser_navigate', { url: args.url });
  return result.error ? result : { ...result, text: `Tabs:\n${line()}\n\n${result.text}` };
 }
 if (action === 'switch') {
  session.active = pick();
  const target = await page();
  await target.bringToFront().catch(() => {});
  return state(target, { note: `Switched to tab ${session.active + 1}.` });
 }
 if (action === 'close') {
  const index = pick();
  const target = list()[index];
  await target.close().catch(() => {});
  session.active = Math.max(0, Math.min(session.active, list().length - 1));
  return { text: `Closed. Tabs:\n${line()}` };
 }
 return { text: `Tabs:\n${line()}` };
}

function tabName(item) {
 try { return `${item.url() === 'about:blank' ? 'New tab' : item.url()}`; } catch { return 'Tab'; }
}

// --------------------------------------------------------------- the tools
async function act(name, args) {
 if (name === 'browser_tabs') return tabsTool(args);
 const target = await page();
 switch (name) {
  case 'browser_navigate': {
   const wanted = normalize(args.url);
   let note = '';
   if (wanted === 'back' || wanted === 'forward' || wanted === 'reload') {
    const run = wanted === 'back' ? target.goBack({ timeout: WAIT.load })
     : wanted === 'forward' ? target.goForward({ timeout: WAIT.load }) : target.reload({ timeout: WAIT.load });
    await run.catch(error => { if (!/Timeout/i.test(String(error?.message))) throw plain(String(error?.message || error).split('\n')[0]); note = 'The page takes long to load, this is what has loaded so far.'; });
   } else {
    try {
     await target.goto(wanted, { waitUntil: 'domcontentloaded', timeout: WAIT.load });
    } catch (error) {
     const message = String(error?.message || error).split('\n')[0];
     if (/Timeout/i.test(message)) note = 'The page takes long to load, this is what has loaded so far.';
     else if (!/interrupted by another navigation|NS_BINDING_ABORTED/i.test(message)) note = `The page could not be opened: ${message}`;
    }
   }
   await settle(target);
   return state(target, { note });
  }
  case 'browser_snapshot':
   return state(target, { full: !!args.full });
  case 'browser_click': {
   let x = Number(args.x), y = Number(args.y), note = '';
   if (args.ref !== undefined && args.ref !== null && args.ref !== '') {
    const spot = await pointFor(target, args.ref);
    ({ x, y } = spot);
    if (spot.covered) note = `Note: at that spot [${args.ref}] is covered by ${spot.covered}, the click went there.`;
   } else if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw plain('Pass ref from the snapshot, or x and y in page pixels');
   }
   await sleep(WAIT.pointer);
   await target.mouse.click(x, y, { clickCount: args.double ? 2 : 1 });
   await settle(target);
   return state(target, { note });
  }
  case 'browser_type': {
   const text = String(args.text ?? '');
   if (args.ref !== undefined && args.ref !== null && args.ref !== '') {
    const spot = await pointFor(target, args.ref);
    await sleep(WAIT.pointer);
    await target.mouse.click(spot.x, spot.y);
    await sleep(80);
   }
   if (args.clear !== false) {
    await target.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    if (!text) await target.keyboard.press('Delete');
   }
   if (text) await target.keyboard.insertText(text);
   if (args.submit) { await sleep(60); await target.keyboard.press('Enter'); }
   await settle(target);
   return state(target);
  }
  case 'browser_select': {
   const chosen = await world(target, `__og.choose(${Number(args.ref)}, ${JSON.stringify(String(args.option ?? ''))})`);
   await settle(target);
   return state(target, { note: `Chose "${chosen}".` });
  }
  case 'browser_press': {
   const key = combo(args.key);
   const count = Math.min(20, Math.max(1, Math.round(Number(args.times) || 1)));
   for (let k = 0; k < count; k++) await target.keyboard.press(key);
   await settle(target);
   return state(target);
  }
  case 'browser_scroll': {
   if (args.ref !== undefined && args.ref !== null && args.ref !== '') {
    await world(target, `__og.reveal(${Number(args.ref)})`);
   } else {
    const view = await world(target, '({ w: innerWidth, h: innerHeight })').catch(() => VIEW);
    const amount = Math.min(10, Math.max(0.1, Number(args.amount) || 0.8));
    const sign = String(args.direction || 'down').toLowerCase() === 'up' ? -1 : 1;
    await target.mouse.move(view.w / 2, view.h / 2);
    await target.mouse.wheel(0, sign * view.h * amount);
   }
   await sleep(250);
   await settle(target);
   return state(target);
  }
  case 'browser_screenshot': {
   const shot = await screenshot(target, !!args.full_page);
   const scale = 'one screenshot pixel is one page pixel, so x and y for browser_click can be read from it';
   return { ...shot, text: `Screenshot of ${args.full_page ? 'the page from the top' : 'the viewport'}: ${(await target.title().catch(() => '')) || target.url()}, ${shot.width}×${shot.height}; ${scale}.` };
  }
  case 'browser_read': {
   const html = await timed(target.content(), WAIT.call, 'The page is not responding');
   return { html: html.slice(0, READ_MAX), url: target.url(), title: await target.title().catch(() => '') };
  }
  case 'browser_wait': {
   const seconds = Math.min(WAIT_MAX, Math.max(0.5, Number(args.seconds) || (args.text ? 15 : 2)));
   const until = Date.now() + seconds * 1000;
   let found = !args.text;
   if (args.text) {
    while (Date.now() < until) {
     if (await world(target, `__og.has(${JSON.stringify(String(args.text))})`).catch(() => false)) { found = true; break; }
     await sleep(400);
    }
   } else {
    await sleep(seconds * 1000);
   }
   await settle(target);
   return state(target, { note: args.text ? (found ? `"${args.text}" is on the page.` : `"${args.text}" did not appear within ${seconds} s.`) : '' });
  }
  default:
   throw plain(`Unknown browser tool ${name}`);
 }
}

// --------------------------------------------------------------- public surface
// One call at a time: two tool calls in parallel would fight over the same tab.
let queue = Promise.resolve();

function run(name, args, signal) {
 const payload = args && typeof args === 'object' ? args : {};
 const job = queue.catch(() => {}).then(async () => {
  if (signal?.aborted) throw plain('Stopped by the user');
  touch();
  try {
   return await act(name, payload);
  } finally {
   touch();
  }
 });
 queue = job.catch(() => {});
 return job;
}

function status() {
 return {
  engine: Boolean(loadEngine()),
  running: Boolean(session.context),
  tabs: tabs().length,
  error: engineError || '',
 };
}

module.exports = { run, close, status, installHint };
