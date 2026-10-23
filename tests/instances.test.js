#!/usr/bin/env node
'use strict';

// The rule that keeps one Prism per machine: a window opened on top of a background engine —
// `prism server` under systemd, a web server left in a terminal — joins it and starts no
// second server or bot.
//
//   node tests/instances.test.js
//
// Real child processes are used for the pids, because desktop/instances.js re-verifies every
// entry against /proc (or tasklist) before it believes it, and a made-up pid would be refused.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Instances = require('../desktop/instances.js');

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
 if (ok) { passed++; console.log(`  ok   ${name}`); }
 else { failed++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
};

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-instances-'));

// A process whose command line says it is one of Prism's engines: the registry trusts the
// command line, not just the pid.
function engineChild(script, port = 0) {
 const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-fake-engine-'));
 const file = path.join(folder, script);
 fs.writeFileSync(file, `setTimeout(() => process.exit(0), 60000);`);
 return spawn(process.execPath, [file, ...(port ? ['--port', String(port)] : [])], { stdio: 'ignore' });
}

const write = entries => {
 fs.mkdirSync(userData, { recursive: true });
 fs.writeFileSync(path.join(userData, 'instances.json'), JSON.stringify({ version: 1, at: Date.now(), entries }));
};

(async () => {
 const server = engineChild('server.mjs', 8787);
 const web = engineChild('web-server.mjs', 8787);
 const bridge = engineChild('discord-bridge.mjs');
 await new Promise(resolve => setTimeout(resolve, 600));
 const entry = (child, role, extra = {}) => ({ pid: child.pid, role, port: 0, version: '2.6.2', root: '/home/server/prism-v2/resources/app', at: Date.now(), ...extra });

 console.log('instances: one Prism per machine');

 write([]);
 check('an empty registry reports nothing', Instances.background(userData) === null);

 write([entry(server, 'server', { port: 8787 })]);
 const found = Instances.background(userData);
 check('a background server is found', found?.roles.includes('server') === true, JSON.stringify(found));
 check('its port travels with it', found?.port === 8787, JSON.stringify(found));

 write([entry(server, 'server', { port: 8787 }), entry(web, 'web', { port: 8787 }), entry(bridge, 'bridge')]);
 const all = Instances.background(userData);
 check('a server with its two helpers is one engine', all?.roles.join(',') === 'server,web,bot' && all.pid === server.pid, JSON.stringify(all));

 write([entry(web, 'web', { port: 8787 })]);
 check('a lone web server still counts', Instances.background(userData)?.roles.join(',') === 'web');

 write([entry(bridge, 'bridge')]);
 check('a lone bot still counts', Instances.background(userData)?.roles.join(',') === 'bot');

 write([entry(server, 'server', { port: 8787 })]);
 check('the window can ignore its own children', Instances.background(userData, { exclude: [server.pid] }) === null);

 write([entry(server, 'server', { at: Date.now() - 5 * 60 * 1000 })]);
 check('a silent engine is dead', Instances.background(userData) === null);

 write([entry({ pid: 999999 }, 'server', { port: 8787 })]);
 check('a pid that no longer exists is dead', Instances.background(userData) === null);

 write([entry(server, 'app', { port: 8787 })]);
 check('another window is not a background engine', Instances.background(userData) === null);

 for (const child of [server, web, bridge]) child.kill('SIGKILL');
 fs.rmSync(userData, { recursive: true, force: true });
 console.log(`\n${passed} passed, ${failed} failed`);
 process.exit(failed ? 1 : 0);
})().catch(error => {
 console.error('the test itself broke:', error);
 process.exit(2);
});
