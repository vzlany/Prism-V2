#!/usr/bin/env node
'use strict';

// Drives desktop/headless-browser.js the way the tool router does, but with the Electron
// module stubbed out, so the engine can be tested on a plain Node without starting the app.
//
//   node tests/headless-browser.test.js
//
// It starts a tiny page of its own (a link, a text field, a dropdown and a button), then walks
// the tool surface: navigate, snapshot, type, click, select, read, screenshot, tabs, wait.

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// --------------------------------------------------------------- the Electron stand-in
const userData = path.join(os.tmpdir(), 'prism-headless-test', 'userData');
const fake = {
 app: { getPath: name => (name === 'userData' ? userData : path.join(os.tmpdir(), 'prism-headless-test', name)) },
};
const load = Module._load;
Module._load = function (request, parent, isMain) {
 if (request === 'electron') return fake;
 return load.call(this, request, parent, isMain);
};

const browser = require('../desktop/headless-browser.js');

// --------------------------------------------------------------- the test page
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Prism Test Page</title>
<style>body{font:16px sans-serif;padding:20px}</style></head><body>
<h1>Hello from the test page</h1>
<p>This paragraph exists so the snapshot has something to read.</p>
<a href="/second">Next page</a>
<label>Your name <input id="name" placeholder="Your name"></label>
<label>Pick one <select id="pick"><option>alpha</option><option>beta</option><option>gamma</option></select></label>
<button id="say" onclick="document.getElementById('out').textContent = 'Said ' + document.getElementById('name').value">Say hello</button>
<div id="out"></div>
</body></html>`;

const SECOND = `<!doctype html><html><head><meta charset="utf-8"><title>Second Page</title></head>
<body><h1>You followed the link</h1></body></html>`;

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
 if (ok) { passed++; console.log(`  ok   ${name}`); }
 else { failed++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
};
const refOf = (snapshot, pattern) => {
 for (const [ref, label] of Object.entries(snapshot.refs || {})) if (pattern.test(label)) return Number(ref);
 return 0;
};

(async () => {
 const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(request.url.startsWith('/second') ? SECOND : PAGE);
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const origin = `http://127.0.0.1:${server.address().port}`;

 console.log('headless browser');

 let shot = await browser.run('browser_navigate', { url: origin });
 check('navigate returns a snapshot', /Hello from the test page/.test(shot.text || ''), shot.text?.slice(0, 300));
 check('the snapshot names the page', /Page: Prism Test Page/.test(shot.text || ''));
 check('the snapshot says it is invisible', /Invisible browser/.test(shot.text || ''));
 check('links and fields are numbered', Object.keys(shot.refs || {}).length >= 3, JSON.stringify(shot.refs));

 const field = refOf(shot, /textbox "Your name"/i) || refOf(shot, /textbox/i);
 shot = await browser.run('browser_type', { ref: field, text: 'Ada', clear: true });
 check('typing into a field', /Ada/.test(shot.text || ''), shot.text?.slice(0, 400));

 const button = refOf(shot, /button "Say hello"/i);
 shot = await browser.run('browser_click', { ref: button });
 check('clicking a button runs its handler', /Said Ada/.test(shot.text || ''), shot.text?.slice(0, 400));

 const select = refOf(shot, /combobox|listbox/i);
 shot = await browser.run('browser_select', { ref: select, option: 'gamma' });
 check('choosing from a dropdown', /gamma/i.test(shot.text || ''), shot.text?.slice(0, 400));

 const read = await browser.run('browser_read', {});
 check('reading the page source', String(read.html || '').includes('Say hello') && read.title === 'Prism Test Page');

 const picture = await browser.run('browser_screenshot', {});
 check('a screenshot comes back as a picture', /^data:image\/jpeg;base64,/.test(picture.image || '') && picture.image.length > 1000);

 const second = refOf(shot, /link "Next page"/i);
 shot = await browser.run('browser_click', { ref: second });
 check('following a link', /You followed the link/.test(shot.text || '') && /Second Page/.test(shot.text || ''), shot.text?.slice(0, 300));

 const back = await browser.run('browser_navigate', { url: 'back' });
 check('going back', /Prism Test Page/.test(back.text || ''), back.text?.slice(0, 300));

 const wait = await browser.run('browser_wait', { text: 'Hello from the test page', seconds: 5 });
 check('waiting for text', /is on the page/.test(wait.text || ''));

 const tabs = await browser.run('browser_tabs', { action: 'list' });
 check('listing tabs', /^Tabs:/m.test(tabs.text || '') && /127\.0\.0\.1/.test(tabs.text || ''), tabs.text);

 const opened = await browser.run('browser_tabs', { action: 'new', url: `${origin}/second` });
 check('opening a tab', /You followed the link/.test(opened.text || '') && /2\./.test(opened.text || ''), opened.text?.slice(0, 300));

 const closed = await browser.run('browser_tabs', { action: 'close', tab: 2 });
 check('closing a tab', /Closed/.test(closed.text || ''));

 const unknown = await browser.run('browser_navigate', { url: 'back' }).catch(error => ({ error: error.message }));
 check('a tool that fails answers with a message', Boolean(unknown.text || unknown.error));

 const status = browser.status();
 check('the engine reports what it is', status.engine === true && status.tabs >= 1, JSON.stringify(status));

 await browser.close();
 server.close();
 console.log(`\n${passed} passed, ${failed} failed`);
 process.exit(failed ? 1 : 0);
})().catch(async error => {
 console.error('the test itself broke:', error);
 try { await browser.close(); } catch {}
 process.exit(2);
});
