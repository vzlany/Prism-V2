#!/usr/bin/env node
'use strict';

// A page reloaded in the middle of a run: the Thought box must be open and streaming again,
// the tool card must be back to "working" instead of the folded "unfinished" line, and the
// live card must stay the last thing in the thread even after a tail refresh appended the
// answer under it.
//
//   node tests/live-restore.test.js
//
// It runs a real web server on a spare port with its own profile, seeds a conversation and a
// keeper-style presence entry, opens the page at phone size and reads the DOM back.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8899;
const PROFILE = 'uitest-live';
const USER_DATA = path.join(process.env.HOME || os.homedir(), '.config', `Prism V2-${PROFILE}`);
const PLAYWRIGHT = process.env.PRISM_PLAYWRIGHT || path.join(os.homedir(), '.prism', 'browser', 'node_modules', 'playwright');

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
 if (ok) { passed++; console.log(`  ok   ${name}`); }
 else { failed++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function seed() {
 fs.rmSync(USER_DATA, { recursive: true, force: true });
 fs.mkdirSync(path.join(USER_DATA, 'store', 'chats'), { recursive: true });
 const id = 'livechat01';
 fs.writeFileSync(path.join(USER_DATA, 'store', 'index.json'), JSON.stringify({
  version: 1,
  folders: [{ path: ROOT, name: 'Prism-V2', collapsed: false, added: Date.now() }],
  chats: [{ id, title: 'A run that was interrupted by a refresh', folder: ROOT, created: Date.now() - 60000, updated: Date.now(), pinned: false, named: true, model: '', mode: 'build', order: 0 }],
 }));
 const thinking = 'Let me look at the folder first and see what is there.';
 fs.writeFileSync(path.join(USER_DATA, 'store', 'chats', `${id}.json`), JSON.stringify({
  version: 1,
  messages: [
   { role: 'user', text: 'Look at the folder', content: 'Look at the folder', at: Date.now() - 50000 },
   {
    role: 'assistant',
    content: '',
    thinking,
    thinkingMs: 4200,
    turn: 't1',
    steps: [
     { role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } }] },
    ],
   },
  ],
 }, null, 1));
 return { id, thinking };
}

function presence(id, thinking) {
 fs.writeFileSync(path.join(USER_DATA, 'presence.json'), JSON.stringify({
  runs: [{
   id,
   origin: 'keeper',
   keeper: true,
   state: 'running',
   title: 'Look at the folder',
   model: 'test',
   started: Date.now() - 20000,
   status: 'working',
   todos: [],
   parts: [
    { id: 'p1', kind: 'thinking', text: `${thinking} Now the listing.`, live: true },
    { id: 'p2', kind: 'tool', callId: 'call-1', tool: 'list_files', toolKind: 'file', title: 'List files', summary: '.', state: 'running' },
   ],
   at: Date.now(),
  }],
 }));
}

(async () => {
 console.log('live restore after a refresh');
 const { id, thinking } = seed();
 presence(id, thinking);

 const server = spawn(process.execPath, [path.join(ROOT, 'tools', 'web-server.mjs'), '--port', String(PORT), '--host', '127.0.0.1', '--no-open', '--profile', PROFILE], { stdio: ['ignore', 'pipe', 'pipe'] });
 let log = '';
 server.stdout.on('data', chunk => { log += chunk; });
 server.stderr.on('data', chunk => { log += chunk; });
 const beat = setInterval(() => presence(id, thinking), 2000);

 try {
  // Wait for the port to answer.
  let up = false;
  for (let k = 0; k < 60; k++) {
   const ok = await new Promise(resolve => {
    const request = http.get({ host: '127.0.0.1', port: PORT, path: '/' }, response => { response.resume(); resolve(response.statusCode === 200); });
    request.on('error', () => resolve(false));
    request.setTimeout(1000, () => { request.destroy(); resolve(false); });
   });
   if (ok) { up = true; break; }
   await sleep(500);
  }
  check('the web server comes up', up, log.split('\n').slice(-6).join('\n'));
  if (!up) throw new Error('server did not start');

  const { chromium, firefox } = require(PLAYWRIGHT);
  const engine = fs.existsSync(path.join(os.homedir(), '.cache', 'ms-playwright', 'chromium_headless_shell-1248')) ? chromium : firefox;
  const browser = await engine.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: engine === chromium, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error.message)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);

  // The device picker covers the chat when another Prism answers on the network: pick this one.
  await page.evaluate(() => {
   const overlay = document.querySelector('.device-overlay');
   if (!overlay || overlay.hidden) return;
   const row = overlay.querySelector('.device-row');
   if (row) row.click();
  }).catch(() => {});
  await page.waitForTimeout(1200);

  // The app opens on a fresh chat; click the seeded one in the sidebar.
  const open = await page.evaluate(id => {
   const row = document.querySelector(`.chat-row[data-id="${id}"]`);
   if (row) row.click();
   return Boolean(row);
  }, id).catch(() => false);
  check('the seeded chat is in the list', open === true);
  await page.waitForTimeout(2500);

  const state = await page.evaluate(() => {
   const thread = document.querySelector('.thread');
   const list = document.querySelector('.thread-list');
   const thought = document.querySelector('.message-thinking');
   const card = document.querySelector('.tool');
   const live = document.querySelector('.live-card');
   const unfinished = document.querySelectorAll('.is-unfinished').length;
   // Everything after the live card in the thread: a message or a tool line that landed under
   // it is the "steps in the middle of the conversation" the mirror used to leave behind.
   const after = [];
   if (live && list) {
    let node = live.nextElementSibling;
    while (node) {
     after.push(`${node.className || node.tagName}`);
     node = node.nextElementSibling;
    }
   }
   return {
    thread: Boolean(thread),
    overflowAnchor: thread ? getComputedStyle(thread).overflowAnchor : '',
    thoughtOpen: thought ? thought.classList.contains('is-open') || thought.querySelector('[aria-expanded="true"]') !== null : false,
    thoughtText: thought ? thought.innerText.slice(0, 80) : '',
    cardRunning: card ? card.classList.contains('is-running') : false,
    cardOpen: card ? card.classList.contains('is-open') : false,
    unfinished,
    live: Boolean(live),
    liveText: live ? live.innerText.slice(0, 60) : '',
    after,
   };
  });
  fs.writeFileSync('/tmp/live-restore.png', await page.screenshot({ fullPage: false }));

  check('the thread is on screen', state.thread === true);
  check('the browser does not anchor the thread itself', state.overflowAnchor === 'none', state.overflowAnchor);
  check('the Thought box is open again', state.thoughtOpen === true, JSON.stringify(state.thoughtText));
  check('the running call is back to working', state.cardRunning === true, JSON.stringify(state.cardOpen));
  check('a running call is open', state.cardOpen === true);
  check('no card is left as "unfinished"', state.unfinished === 0, String(state.unfinished));
  check('the live card is there', state.live === true, JSON.stringify(state.liveText));
  check('nothing lands under the live card', state.after.every(name => /task-files|task-file/.test(name)), JSON.stringify(state.after));
  check('the page threw no errors', errors.length === 0, errors.join(' | '));

  // The jump the phone reported: content that arrives while the reader is at the bottom must
  // not move the view. A block is appended to the thread and the scroll must stay on the max.
  const jump = await page.evaluate(async () => {
   const thread = document.querySelector('.thread');
   const list = document.querySelector('.thread-list');
   thread.scrollTop = thread.scrollHeight;
   await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
   const before = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
   const block = document.createElement('div');
   block.className = 'message is-assistant';
   block.style.height = '64px';
   list.append(block);
   const dips = [];
   for (let k = 0; k < 20; k++) {
    await new Promise(resolve => setTimeout(resolve, 16));
    dips.push(Math.round(thread.scrollHeight - thread.scrollTop - thread.clientHeight));
   }
   block.remove();
   return { before: Math.round(before), worst: Math.max(...dips), last: dips[dips.length - 1] };
  });
  // 0 = pinned; a dip means the view was left above the bottom after the content grew.
  check('new content does not open a gap the spring has to chase', jump.worst <= 4, JSON.stringify(jump));

  await browser.close();
 } finally {
  clearInterval(beat);
  server.kill('SIGTERM');
  await sleep(800);
  try { execSync(`pkill -f "web-server.mjs --port ${PORT}"`, { stdio: 'ignore' }); } catch {}
 }
 console.log(`\n${passed} passed, ${failed} failed`);
 process.exit(failed ? 1 : 0);
})().catch(error => {
 console.error('the test itself broke:', error);
 process.exit(2);
});
