'use strict';

// Live system information for the server (and any machine Prism runs on): CPU usage from
// /proc/stat deltas, memory from /proc/meminfo, disks via statfs, network rates from
// /proc/net/dev, temperatures from the thermal/hwmon sysfs. Everything is best-effort — a
// missing file simply leaves its block out — and CPU/network rates are computed between two
// calls, so the caller polls (the panel asks every 100 ms).
const fs = require('node:fs');
const os = require('node:os');

let last = { cpu: null, net: null, at: 0 };

const read = file => {
 try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
};

function cpuTimes() {
 const line = read('/proc/stat').split('\n').find(row => row.startsWith('cpu '));
 if (!line) {
  // No /proc (Windows, macOS): the same numbers come from os.cpus() times.
  const cpus = os.cpus();
  if (!cpus.length) return null;
  let total = 0, idle = 0, user = 0, system = 0;
  for (const core of cpus) {
   const times = core.times || {};
   total += (times.user || 0) + (times.nice || 0) + (times.sys || 0) + (times.idle || 0) + (times.irq || 0);
   idle += times.idle || 0;
   user += times.user || 0;
   system += times.sys || 0;
  }
  return { total, idle, user, system };
 }
 const parts = line.trim().split(/\s+/).slice(1).map(Number);
 const total = parts.reduce((sum, value) => sum + (value || 0), 0);
 const idle = (parts[3] || 0) + (parts[4] || 0);
 return { total, idle, user: parts[0] || 0, system: parts[2] || 0 };
}

function perCore() {
 const rows = [];
 for (const line of read('/proc/stat').split('\n')) {
  const match = /^cpu(\d+)\s+(.*)$/.exec(line.trim());
  if (!match) continue;
  const parts = match[2].trim().split(/\s+/).map(Number);
  const total = parts.reduce((sum, value) => sum + (value || 0), 0);
  rows.push({ total, idle: (parts[3] || 0) + (parts[4] || 0) });
 }
 if (rows.length) return rows;
 return os.cpus().map(core => {
  const times = core.times || {};
  return { total: (times.user || 0) + (times.nice || 0) + (times.sys || 0) + (times.idle || 0) + (times.irq || 0), idle: times.idle || 0 };
 });
}

function meminfo() {
 const out = {};
 for (const line of read('/proc/meminfo').split('\n')) {
  const match = /^(\w+):\s+(\d+)/.exec(line);
  if (match) out[match[1]] = Number(match[2]) * 1024;
 }
 const total = out.MemTotal || os.totalmem();
 const available = out.MemAvailable ?? out.MemFree ?? os.freemem();
 return {
  total,
  available,
  used: Math.max(0, total - available),
  free: out.MemFree || 0,
  cached: (out.Cached || 0) + (out.Buffers || 0),
  swapTotal: out.SwapTotal || 0,
  swapFree: out.SwapFree || 0,
 };
}

const disk = path => {
 try {
  const stat = fs.statfsSync(path);
  const total = stat.blocks * stat.bsize;
  const free = stat.bavail * stat.bsize;
  return { total, free, used: total - free };
 } catch { return null; }
};

function netBytes() {
 let rx = 0, tx = 0;
 const lines = read('/proc/net/dev').split('\n').slice(2);
 for (const line of lines) {
  const [name, rest] = line.split(':');
  if (!rest || String(name).trim() === 'lo') continue;
  const cols = rest.trim().split(/\s+/).map(Number);
  rx += cols[0] || 0;
  tx += cols[8] || 0;
 }
 return { rx, tx };
}

function interfaces() {
 const out = [];
 const all = os.networkInterfaces();
 for (const [name, list] of Object.entries(all)) {
  for (const item of list || []) {
   if (item.family !== 'IPv4' || item.internal) continue;
   out.push({ name, address: item.address });
  }
 }
 return out;
}

function temperatures() {
 const out = [];
 try {
  for (const zone of fs.readdirSync('/sys/class/thermal')) {
   if (!zone.startsWith('thermal_zone')) continue;
   const value = Number(read(`/sys/class/thermal/${zone}/temp`).trim());
   if (!Number.isFinite(value)) continue;
   const type = read(`/sys/class/thermal/${zone}/type`).trim() || zone;
   out.push({ name: type, value: value / 1000 });
  }
 } catch {}
 if (out.length < 2) {
  try {
   for (const hw of fs.readdirSync('/sys/class/hwmon')) {
    const base = `/sys/class/hwmon/${hw}`;
    const chip = read(`${base}/name`).trim() || hw;
    for (const file of fs.readdirSync(base)) {
     if (!/^temp\d+_input$/.test(file)) continue;
     const value = Number(read(`${base}/${file}`).trim());
     if (!Number.isFinite(value)) continue;
     out.push({ name: `${chip} ${file.replace('_input', '')}`, value: value / 1000 });
    }
   }
  } catch {}
 }
 return out.filter(entry => entry.value > -50 && entry.value < 200).slice(0, 12);
}

function stats() {
 const now = Date.now();
 const cpu = cpuTimes();
 const cores = perCore();
 let usage = null;
 let perCpu = null;
 if (cpu && last.cpu && now > last.at) {
  const deltaTotal = cpu.total - last.cpu.total;
  const deltaIdle = cpu.idle - last.cpu.idle;
  if (deltaTotal > 0) {
   usage = Math.max(0, Math.min(1, 1 - deltaIdle / deltaTotal));
   if (last.cores?.length === cores.length) {
    perCpu = cores.map((core, index) => {
     const total = core.total - last.cores[index].total;
     const idle = core.idle - last.cores[index].idle;
     return total > 0 ? Math.max(0, Math.min(1, 1 - idle / total)) : 0;
    });
   }
  }
 }
 const net = netBytes();
 let rate = null;
 if (last.net && now > last.at) {
  const seconds = (now - last.at) / 1000;
  rate = {
   rx: Math.max(0, (net.rx - last.net.rx) / seconds),
   tx: Math.max(0, (net.tx - last.net.tx) / seconds),
   rxTotal: net.rx,
   txTotal: net.tx,
  };
 }
 last = { cpu, cores, net, at: now };

 const memory = meminfo();
 const usage_ = process.memoryUsage();
 const speeds = os.cpus().map(core => core.speed || 0).filter(Boolean);
 return {
  at: now,
  host: os.hostname(),
  user: os.userInfo().username,
  platform: `${os.type()} ${os.release()}`,
  release: os.release(),
  arch: os.arch(),
  uptime: os.uptime(),
  load: { one: os.loadavg()[0], five: os.loadavg()[1], fifteen: os.loadavg()[2] },
  cpuModel: os.cpus()[0]?.model || '',
  cores: os.cpus().length,
  usage,
  perCpu,
  speeds: speeds.length ? [Math.min(...speeds), Math.max(...speeds)] : null,
  memory,
  disks: [
   { path: '/', ...(disk('/') || {}) },
   { path: os.homedir(), ...(disk(os.homedir()) || {}) },
  ].filter(item => item.total),
  net: rate,
  interfaces: interfaces(),
  temps: temperatures(),
  engine: { pid: process.pid, rss: usage_.rss, heap: usage_.heapUsed },
  node: process.version,
 };
}

module.exports = { stats };
