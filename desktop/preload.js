'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openghost', {
 desktop: true,
 platform: process.platform,
 pickFolder: defaultPath => ipcRenderer.invoke('folder:pick', defaultPath),
 revealFolder: folder => ipcRenderer.invoke('folder:reveal', folder),
 // A folder without picking one: a fresh per-chat workspace, or the shared Public one.
 workspace: kind => ipcRenderer.invoke('workspace:create', kind),
 saveFile: (file, name) => ipcRenderer.invoke('file:save', file, name),
 setTitleBar: color => ipcRenderer.send('window:titlebar', color),
 notify: (title, body, summary) => ipcRenderer.send('notify', { title, body, summary }),
 store: {
  read: key => ipcRenderer.invoke('store:read', key),
  write: (key, value) => ipcRenderer.invoke('store:write', key, value),
  remove: key => ipcRenderer.invoke('store:remove', key),
  // Another process (prism web) wrote the index: the list re-reads it.
  onChange: callback => ipcRenderer.on('store:changed', () => callback()),
  // One conversation was saved elsewhere: the open thread reads it again.
  onChatChange: callback => ipcRenderer.on('chat:changed', (event, id) => callback(id)),
 },
 auto: {
  // Settings -> Auto: launch at login, start hidden, run the web server.
  get: () => ipcRenderer.invoke('auto:get'),
  set: patch => ipcRenderer.invoke('auto:set', patch),
  clients: () => ipcRenderer.invoke('auto:clients'),
 },
 server: {
  // Settings -> Server: which machine this install serves, the root password for sudo on
  // Linux, and where the Linux autostart entry lives.
  get: () => ipcRenderer.invoke('server:get'),
  set: patch => ipcRenderer.invoke('server:set', patch),
 },
 devices: {
  // The other Prism apps on this network: the startup picker, the list, and picking one to
  // work with (its own window, its own chats and tools).
  list: () => ipcRenderer.invoke('devices:list'),
  prompt: () => ipcRenderer.invoke('devices:prompt'),
  pick: id => ipcRenderer.invoke('devices:pick', id),
  add: entry => ipcRenderer.invoke('devices:add', entry),
  forget: (host, port) => ipcRenderer.invoke('devices:forget', host, port),
 },
 path: {
  // A path written in a reply: does it exist, and open it.
  info: (target, cwd) => ipcRenderer.invoke('path:info', target, cwd),
  open: (target, cwd) => ipcRenderer.invoke('path:open', target, cwd),
 },
 presence: {
  // The desktop's running turns are mirrored to presence.json, so `prism web` (the phone)
  // sees the same busy chats the app shows.
  set: (id, info) => ipcRenderer.send('presence:set', id, info),
 },
 delegate: {
  // Turns started on the website and handed to this app to run.
  onRequest: callback => ipcRenderer.on('turn:request', (event, data) => callback(data)),
 },
 tools: {
  run: (id, name, args, cwd) => ipcRenderer.invoke('tool:run', id, name, args, cwd),
  cancel: id => ipcRenderer.invoke('tool:cancel', id),
  environment: () => ipcRenderer.invoke('tool:environment'),
 },
 browser: {
  onEvent: callback => ipcRenderer.on('browser:event', (event, data) => callback(data)),
  shown: value => ipcRenderer.send('browser:shown', value),
 },
 profile: {
  info: () => ipcRenderer.invoke('profile:info'),
  switch: name => ipcRenderer.invoke('profile:switch', name),
 },
 skills: {
  list: directory => ipcRenderer.invoke('skills:list', directory),
  install: url => ipcRenderer.invoke('skills:install', url),
  remove: target => ipcRenderer.invoke('skills:remove', target),
  onProgress: callback => {
   const handler = (event, data) => callback(data);
   ipcRenderer.on('skills:progress', handler);
   return () => ipcRenderer.removeListener('skills:progress', handler);
  },
 },
 app: {
  version: () => ipcRenderer.invoke('app:version'),
  // A turn is running: the hidden window must keep its rAF and timers until the last one ends.
  setActiveTurn: active => ipcRenderer.invoke('app:set-background-throttle', !active),
 },
 update: {
  // Settings -> About: check / install now, the switches (check at launch, install
  // automatically) and the GitHub token the private repository's releases need.
  check: () => ipcRenderer.invoke('update:check'),
  params: () => ipcRenderer.invoke('update:params'),
  set: patch => ipcRenderer.invoke('update:set', patch),
  install: () => ipcRenderer.invoke('update:install'),
  run: args => ipcRenderer.invoke('update:run', args),
 },
 instructions: {
  list: directory => ipcRenderer.invoke('instructions:list', directory),
  read: (directory, file) => ipcRenderer.invoke('instructions:read', directory, file),
  open: directory => ipcRenderer.invoke('instructions:open', directory),
 },
 discord: {
  get: () => ipcRenderer.invoke('discord:get'),
  set: patch => ipcRenderer.invoke('discord:set', patch),
  test: () => ipcRenderer.invoke('discord:test'),
  dm: payload => ipcRenderer.invoke('discord:dm', payload),
  message: payload => ipcRenderer.invoke('discord:message', payload),
 },
 memory: {
  list: () => ipcRenderer.invoke('memory:list'),
  add: text => ipcRenderer.invoke('memory:add', text),
  update: (id, text) => ipcRenderer.invoke('memory:update', id, text),
  remove: id => ipcRenderer.invoke('memory:remove', id),
 },
 mcp: {
  status: () => ipcRenderer.invoke('mcp:status'),
  tools: () => ipcRenderer.invoke('mcp:tools'),
  call: (name, args) => ipcRenderer.invoke('mcp:call', name, args),
  reload: () => ipcRenderer.invoke('mcp:reload'),
  openConfig: () => ipcRenderer.invoke('mcp:open-config'),
  servers: () => ipcRenderer.invoke('mcp:servers'),
  save: (id, def) => ipcRenderer.invoke('mcp:save', id, def),
  remove: id => ipcRenderer.invoke('mcp:remove', id),
 },
 llm: {
  start: (id, request) => ipcRenderer.send('llm:start', id, request),
  abort: id => ipcRenderer.send('llm:abort', id),
  onEvent: callback => ipcRenderer.on('llm:event', (event, data) => callback(data)),
  models: (provider, key) => ipcRenderer.invoke('llm:models', provider, key),
 },
 auth: {
  login: () => ipcRenderer.invoke('auth:login'),
  cancel: () => ipcRenderer.invoke('auth:cancel'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  status: () => ipcRenderer.invoke('auth:status'),
 },
});
