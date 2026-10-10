'use strict';

// Device discovery on the local network: every running Prism announces itself on UDP 48787 a
// few times a minute (name, platform, version, its web port, whether it is a server), and
// listens for the others. Dependency-free, LAN-only, and purely informational — messages to
// another device go through that device's own web server, exactly like the phone does.
// Devices added by hand live in device.json and are merged in for networks where broadcast
// is blocked (a firewall, a VLAN).
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 48787;
const BEAT = 4000;      // announce every 4s
const STALE = 12000;    // a device unheard from for 12s is gone
const MAGIC = 'prism-v2';

class Beacon {
 constructor({ id, userData, name = '', platform = '', version = '', port = 0, server = false }) {
  this.id = id;
  this.userData = userData;
  this.name = String(name || os.hostname() || 'device');
  this.platform = platform || process.platform;
  this.version = version || '';
  this.port = Number(port) || 0;
  this.server = Boolean(server);
  this.remotes = new Map();
  this.listeners = new Set();
  this.socket = null;
  this.timer = 0;
  this.pruner = 0;
 }

 on(callback) {
  this.listeners.add(callback);
  return () => this.listeners.delete(callback);
 }

 emit() {
  for (const callback of [...this.listeners]) {
   try { callback(); } catch {}
  }
 }

 payload() {
  return {
   magic: MAGIC,
   id: this.id,
   name: this.name,
   platform: this.platform,
   version: this.version,
   port: this.port,
   server: this.server,
   at: Date.now(),
  };
 }

 start() {
  if (this.socket) return;
  try {
   this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
   this.socket.on('error', error => console.log('[beacon] socket error:', error.message));
   this.socket.on('message', (raw, from) => this.receive(raw, from));
   this.socket.bind({ port: PORT, address: '0.0.0.0', exclusive: false }, () => {
    try { this.socket.setBroadcast(true); } catch {}
    this.announce();
    this.timer = setInterval(() => this.announce(), BEAT);
    this.pruner = setInterval(() => this.prune(), BEAT);
   });
  } catch (error) {
   console.log('[beacon] could not start:', error.message);
  }
 }

 stop() {
  clearInterval(this.timer);
  clearInterval(this.pruner);
  this.timer = 0;
  this.pruner = 0;
  try { this.socket?.close(); } catch {}
  this.socket = null;
 }

 announce() {
  if (!this.socket) return;
  const data = Buffer.from(JSON.stringify(this.payload()));
  try {
   this.socket.send(data, 0, data.length, PORT, '255.255.255.255', () => {});
  } catch {}
 }

 receive(raw, from) {
  let data = null;
  try { data = JSON.parse(String(raw)); } catch { return; }
  if (data?.magic !== MAGIC || !data.id || data.id === this.id) return;
  const stale = !this.remotes.has(data.id);
  this.remotes.set(data.id, { ...data, host: (from?.address || '').replace(/^::ffff:/, ''), seen: Date.now(), manual: false });
  if (stale || this.remotes.get(data.id)?.stale) this.emit();
 }

 prune() {
  let changed = false;
  const now = Date.now();
  for (const [id, device] of this.remotes) {
   if (now - device.seen > STALE) { this.remotes.delete(id); changed = true; }
  }
  if (changed) this.emit();
 }

 // --------------------------------------------------------------- the device list
 file() {
  return path.join(this.userData, 'device.json');
 }

 config() {
  try {
   const stored = JSON.parse(fs.readFileSync(this.file(), 'utf8')) || {};
   return { id: this.id, known: Array.isArray(stored.known) ? stored.known : [] };
  } catch {
   return { id: this.id, known: [] };
  }
 }

 saveConfig(patch) {
  const next = { ...this.config(), ...patch };
  try {
   fs.mkdirSync(path.dirname(this.file()), { recursive: true });
   fs.writeFileSync(this.file(), JSON.stringify(next, null, 2));
  } catch {}
  return next;
 }

 addManual(input) {
  const source = typeof input === 'string' ? { address: input } : (input || {});
  const raw = String(source.address || source.host || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  const [hostPart, portPart] = raw.split(':');
  const cleanHost = String(hostPart || '').trim();
  const cleanPort = Math.max(1, Math.min(65535, Number(source.port || portPart) || 8787));
  if (!cleanHost) return null;
  const entry = { name: String(source.name || cleanHost).trim().slice(0, 60), host: cleanHost, port: cleanPort, added: Date.now() };
  const known = this.config().known.filter(item => !(item.host === entry.host && Number(item.port) === entry.port));
  known.push(entry);
  this.saveConfig({ known });
  this.emit();
  return entry;
 }

 forgetManual(host, port) {
  const known = this.config().known.filter(item => !(item.host === host && Number(item.port) === Number(port)));
  this.saveConfig({ known });
  this.emit();
 }

 url(device) {
  if (device?.manual) return `http://${device.host}:${device.port}/`;
  if (!device?.port) return '';
  return `http://${device.host}:${device.port}/`;
 }

 list() {
  const self = { id: this.id, name: this.name, platform: this.platform, version: this.version, port: this.port, server: this.server, self: true, url: '' };
  const devices = [];
  for (const device of this.remotes.values()) {
   if (Date.now() - device.seen > STALE) continue;
   const { magic, at, seen, ...rest } = device;
   devices.push({ ...rest, self: false, url: this.url({ ...device, manual: false }) });
  }
  for (const known of this.config().known) {
   // A manual entry is only shown while no beacon with the same address is live.
   const live = devices.some(device => device.host === known.host && Number(device.port) === Number(known.port));
   if (live) continue;
   devices.push({
    id: `manual:${known.host}:${known.port}`,
    name: known.name,
    platform: '',
    version: '',
    server: false,
    manual: true,
    host: known.host,
    port: Number(known.port),
    self: false,
    url: this.url({ ...known, manual: true }),
   });
  }
  devices.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { self, devices, server: this.server };
 }
}

// One id per install, stable across launches.
function deviceId(userData) {
 const file = path.join(userData, 'device.json');
 try {
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (stored?.id && /^[a-z0-9-]{6,40}$/i.test(stored.id)) return stored.id;
 } catch {}
 const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
 try {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stored = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; } })();
  fs.writeFileSync(file, JSON.stringify({ ...stored, id }, null, 2));
 } catch {}
 return id;
}

module.exports = { Beacon, deviceId, PORT };
