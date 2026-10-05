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

document.addEventListener('visibilitychange', () => { if (!document.hidden) nudge(); });
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

connect();

window.openghost = {
 web: true,
 desktop: false,
 platform: 'web',
 // Downloads an attached file from the server, bytes intact whatever its type.
 saveFile: (path, name) => {
  return new Promise(resolve => {
   try {
    const link = document.createElement('a');
    link.href = `/file?path=${encodeURIComponent(path)}${name ? `&name=${encodeURIComponent(name)}` : ''}`;
    link.download = name || '';
    document.body.append(link);
    link.click();
    link.remove();
    resolve(name || path);
   } catch {
    resolve(null);
   }
  });
 },
 pickFolder: () => {
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
  // The web can send the same "finished" DM through the engine host.
  get: async () => ({ enabled: false, userId: '', hasToken: false }),
  set: async () => ({ enabled: false, userId: '', hasToken: false }),
  test: async () => ({ ok: false, error: 'works only in the desktop app' }),
  dm: payload => invoke('discord:dm', payload),
 },
 instructions: {
  list: directory => invoke('instructions:list', directory),
  read: (directory, file) => invoke('instructions:read', directory, file),
  open: directory => invoke('instructions:open', directory),
 },
 skills: {
  list: directory => invoke('skills:list', directory),
  install: url => invoke('skills:install', url),
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
