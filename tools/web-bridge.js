// The browser stand-in for the desktop bridge: the page talks to the prism web server
// over one WebSocket, and every window.openghost method maps onto it.
(() => {
'use strict';
if (window.openghost) return;

const state = { ws: null, pending: new Map(), listeners: new Map(), seq: 0, appConnected: false };
let ready = null;

// A quiet socket gets dropped by the browser or the network after a while, and the server
// aims its replies at whichever connection spoke last. A small call every twenty seconds
// keeps the socket warm and re-points the replies here, so a reply still being written when
// the page was away carries on arriving without the user having to prod it.
const PING = { every: 20000, channel: 'profile:info' };
let beat = 0;

function keepWarm() {
 clearTimeout(beat);
 beat = setTimeout(() => {
  nudge();
  keepWarm();
 }, PING.every);
}

function nudge() {
  try {
   if (state.ws && state.ws.readyState === 1) invoke(PING.channel).catch(() => {});
  } catch {}
}

function connect() {
 ready = new Promise((resolve, reject) => {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = state.ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
   resolve();
   keepWarm();
   nudge();
   watchVersion();
  };
  ws.onclose = () => {
   for (const pending of state.pending.values()) pending.reject(new Error('connection lost'));
   state.pending.clear();
   setTimeout(connect, 700);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = event => {
   let msg;
   try { msg = JSON.parse(event.data); } catch { return; }
   if (msg.t === 'result' || msg.t === 'error') {
    const pending = state.pending.get(msg.id);
    state.pending.delete(msg.id);
    if (!pending) return;
    if (msg.t === 'result') pending.resolve(msg.value);
    else pending.reject(new Error(msg.error || 'request failed'));
   } else if (msg.t === 'event') {
    for (const callback of state.listeners.get(msg.channel) || []) {
     try { callback(...msg.args); } catch {}
    }
   }
  };
 });
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) { nudge(); watchVersion(); } });
window.addEventListener('online', () => nudge());

const invoke = (channel, ...args) => {
 const id = ++state.seq;
 return ready.then(() => new Promise((resolve, reject) => {
  state.pending.set(id, { resolve, reject });
  state.ws.send(JSON.stringify({ t: 'invoke', id, channel, args }));
 }));
};
const send = (channel, ...args) => {
 ready.then(() => state.ws.send(JSON.stringify({ t: 'send', channel, args })));
};
const on = (channel, callback) => {
 const list = state.listeners.get(channel) || [];
 list.push(callback);
 state.listeners.set(channel, list);
};
// The server tells every page whether the desktop app is running; turns started here are
// handed to it while it is.
on('app:status', status => { state.appConnected = Boolean(status?.connected); });

// A tab can outlive the build it was loaded from: an update restarts the server under an
// open page, and the old script keeps running with the old behaviour — "nothing got fixed".
// On every reconnect and every return to the tab, the version the server reports is compared
// with the one this page loaded on; a different one reloads the page. A draft in the
// composer is never thrown away: that waits until the box is empty.
let seenVersion = '';
async function watchVersion() {
 try {
  const version = await invoke('app:version');
  if (typeof version !== 'string' || !version) return;
  if (seenVersion && version !== seenVersion) {
   const draft = document.querySelector('textarea.composer-input');
   if (!draft || !String(draft.value || '').trim()) { location.reload(); return; }
  }
  seenVersion = version;
 } catch {}
}

connect();

window.openghost = {
 web: true,
 desktop: false,
 platform: 'web',
 // Downloads an attached file from the server, bytes intact whatever its type.
 saveFile: (path, name) => {
  return new Promise(resolve => {
   try {
    const url = `/file?path=${encodeURIComponent(path)}${name ? `&name=${encodeURIComponent(name)}` : ''}`;
    // The server is asked first: a missing file, a bad path or a 404 must not keep the
    // button saying "Downloaded" while nothing ever reaches the device.
    fetch(url, { method: 'HEAD' }).then(response => {
     if (!response.ok) { resolve(null); return; }
     try {
      const link = document.createElement('a');
      link.href = url;
      link.download = name || '';
      document.body.append(link);
      link.click();
      link.remove();
      resolve(name || path);
     } catch { resolve(null); }
    }, () => {
     // The check itself failed (offline): let the plain link try anyway.
     try {
      const link = document.createElement('a');
      link.href = url;
      link.download = name || '';
      document.body.append(link);
      link.click();
      link.remove();
      resolve(name || path);
     } catch { resolve(null); }
    });
   } catch {
    resolve(null);
   }
  });
 },
 pickFolder: async () => {
  // A browser has no folder dialog and the Electron remote window has no window.prompt:
  // the in-page prompt asks for the path as text.
  if (window.PathPrompt) {
   const path = await window.PathPrompt.ask({ value: '', placeholder: '/home/server/projects' });
   if (!path) return null;
   const clean = String(path).replace(/[\\/]+$/, '');
   return { path: clean, name: clean.split(/[\\/]/).pop() || clean };
  }
  const path = window.prompt('Folder path for this chat:');
  if (!path) return null;
  const clean = path.replace(/[\\/]+$/, '');
  return { path: clean, name: clean.split(/[\\/]/).pop() || clean };
 },
 revealFolder: () => {},
 // A folder without picking one: a fresh per-chat workspace, or the shared Public one.
 workspace: kind => invoke('workspace:create', kind),
 path: {
  info: (target, cwd) => invoke('path:info', target, cwd),
  open: (target, cwd) => invoke('path:open', target, cwd),
 },
 setTitleBar: () => {},
 notify: (title, body) => {
  try { new Notification(String(title || 'Prism V2'), { body: String(body || ''), icon: '/desktop/icon.png' }); } catch {}
 },
 store: {
  read: key => invoke('store:read', key),
  write: (key, value) => invoke('store:write', key, value),
  remove: key => invoke('store:remove', key),
  onChange: callback => on('store:changed', callback),
  onChatChange: callback => on('chat:changed', callback),
 },
 tools: {
  run: (id, name, args, cwd) => invoke('tool:run', id, name, args, cwd),
  cancel: id => invoke('tool:cancel', id),
  environment: () => invoke('tool:environment'),
 },
 llm: {
  start: (id, request) => send('llm:start', id, request),
  abort: id => send('llm:abort', id),
  onEvent: callback => on('llm:event', callback),
  models: (provider, key) => invoke('llm:models', provider, key),
 },
 // A turn that runs on the server itself, not in this tab: it survives a refresh, a switch
 // to another conversation or a closed page, and publishes live presence like any other run.
 run: {
  start: request => invoke('run:start', request),
  stop: chatId => invoke('run:stop', chatId),
  state: chatId => invoke('run:state', chatId),
 },
 auth: {
  login: async () => ({ connected: false, error: 'sign-in works only in the desktop app' }),
  cancel: async () => ({ connected: false }),
  logout: async () => ({ connected: false }),
  status: async () => ({ connected: false }),
 },
 mcp: {
  status: () => invoke('mcp:status'),
  tools: () => invoke('mcp:tools'),
  call: (name, args) => invoke('mcp:call', name, args),
  reload: () => invoke('mcp:reload'),
  openConfig: () => invoke('mcp:open-config'),
  servers: () => invoke('mcp:servers'),
  save: (id, def) => invoke('mcp:save', id, def),
  remove: id => invoke('mcp:remove', id),
 },
 memory: {
  list: () => invoke('memory:list'),
  add: text => invoke('memory:add', text),
  update: (id, text) => invoke('memory:update', id, text),
  remove: id => invoke('memory:remove', id),
 },
 discord: {
  // Settings -> Discord from the web: read/write the same discord.json the app and the bot
  // use, so a server's token and user id can be managed from a phone or another device.
  get: () => invoke('discord:get'),
  set: patch => invoke('discord:set', patch),
  test: () => invoke('discord:test'),
  dm: payload => invoke('discord:dm', payload),
  message: payload => invoke('discord:message', payload),
 },
 instructions: {
  list: directory => invoke('instructions:list', directory),
  read: (directory, file) => invoke('instructions:read', directory, file),
  open: directory => invoke('instructions:open', directory),
  upload: (directory, name, base64) => invoke('instructions:write', directory, name, base64),
  remove: (directory, file) => invoke('instructions:remove', directory, file),
 },
 skills: {
  list: directory => invoke('skills:list', directory),
  install: url => invoke('skills:install', url),
  remove: target => invoke('skills:remove', target),
  onProgress: callback => {
   on('skills:progress', callback);
   return () => {
    const list = state.listeners.get('skills:progress') || [];
    const at = list.indexOf(callback);
    if (at >= 0) list.splice(at, 1);
   };
  },
 },
 app: {
  version: () => invoke('app:version'),
  // Whether the desktop app is running (its heartbeat is fresh): when it is, the website
  // hands it the turns so they run there, with its tools, and stream back here.
  connected: () => state.appConnected,
  onStatus: callback => on('app:status', callback),
 },
 auto: {
  // The Auto page is desktop-only; a browser has nothing to set.
  get: async () => null,
  set: async () => null,
 },
 update: {
  // Settings -> About on a headless server: the host checks GitHub, swaps the install and
  // comes back (the systemd unit, or `prism server`, restarts it).
  params: () => invoke('update:params'),
  set: patch => invoke('update:set', patch),
  check: () => invoke('update:check'),
  install: () => invoke('update:install'),
  // The updater's live state (available / downloading / restarting / done) for this device,
  // streamed by the web server so a page can say the device it is looking at is updating.
  state: () => invoke('update:state'),
  onState: callback => {
   on('update:state', callback);
   return () => {
    const list = state.listeners.get('update:state') || [];
    const at = list.indexOf(callback);
    if (at >= 0) list.splice(at, 1);
   };
  },
 },
 devices: {
  // The other Prism apps on this network. The page can only navigate: open() hands back the
  // device's web address and the caller goes there.
  list: () => invoke('devices:list'),
  open: id => invoke('devices:open', id),
  add: entry => invoke('devices:add', entry),
  forget: (host, port) => invoke('devices:forget', host, port),
 },
 engine: {
  // Whether this machine is a server (its composer shows only the Discord switch).
  info: () => invoke('engine:info'),
 },
 sys: {
  // Live machine statistics for the System panel (served by the host's sysinfo).
  stats: () => invoke('sys:stats'),
 },
 logs: {
  // Everything the server logs, streamed live; the page's own errors are mirrored in.
  tail: () => invoke('log:tail'),
  page: line => send('log:page', line),
  onLine: callback => on('log:event', callback),
 },
 // A file attached in this browser goes to the server first: the tools can then open the
 // real file (the phone has no path they could reach). Answers { path, name, size } or null.
 upload: async (file, chatId) => {
  try {
   const response = await fetch(`/upload?chat=${encodeURIComponent(chatId || 'misc')}&name=${encodeURIComponent(file?.name || 'file')}`, { method: 'POST', body: file });
   if (!response.ok) return null;
   const data = await response.json().catch(() => null);
   return data?.ok ? data : null;
  } catch {
   return null;
  }
 },
 // A turn started on this page, for the app to run.
 delegate: {
  send: request => send('delegate:add', request),
  onStatus: callback => on('delegate:status', callback),
 },
 presence: {
  set: (id, info) => send('presence:set', id, info),
  onEvent: callback => on('presence:event', callback),
 },
 profile: {
  info: () => invoke('profile:info'),
  switch: async () => false,
 },
};
})();
