// The System panel (server only): live CPU, memory, disks, network, temperatures and the
// server's console, straight from the machine Prism runs on. It polls twice a second while it
// is open — small JSON over the same channel the app already uses, values patched in place,
// so even 2 Hz costs nothing.
(() => {
'use strict';

const KEEP_LOGS = 300;

const bytes = value => {
 const size = Number(value) || 0;
 if (size < 1024) return `${Math.round(size)} B`;
 if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
 if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
 return `${(size / 1024 ** 3).toFixed(2)} GB`;
};
const percent = value => value == null ? '—' : `${Math.round(value * 100)}%`;
const duration = seconds => {
 const total = Math.max(0, Math.round(Number(seconds) || 0));
 const days = Math.floor(total / 86400), hours = Math.floor(total % 86400 / 3600), minutes = Math.floor(total % 3600 / 60);
 if (days) return `${days}d ${hours}h ${minutes}m`;
 if (hours) return `${hours}h ${minutes}m`;
 return `${minutes}m ${total % 60}s`;
};

class SystemPanel {
 constructor({ panel }) {
  this.panel = panel;
  this.timer = 0;
  this.polling = false;
  this.built = false;
  this.unsub = null;
  panel.addEventListener('toggle', () => {
   if (panel.matches(':popover-open')) this.start();
   else this.stop();
  });
 }

 toggle() {
  if (this.panel.matches(':popover-open')) this.panel.hidePopover?.();
  else window.PopoverMotion?.show ? window.PopoverMotion.show(this.panel) : this.panel.showPopover?.();
 }

 start() {
  if (!this.built) this.build();
  if (!this.timer) {
   this.timer = setInterval(() => this.poll(), 500);
   this.unsub = window.openghost?.logs?.onLine?.(line => this.addLog(line)) || null;
   Promise.resolve(window.openghost?.logs?.tail?.()).then(lines => {
    const box = this.logEl;
    if (!box || !Array.isArray(lines)) return;
    box.textContent = '';
    for (const line of lines.slice(-120)) this.addLog(line);
   }).catch(() => {});
  }
  this.poll();
 }

 stop() {
  clearInterval(this.timer);
  this.timer = 0;
  try { this.unsub?.(); } catch {}
  this.unsub = null;
 }

 async poll() {
  if (this.polling) return;
  this.polling = true;
  try {
   const stats = await (window.openghost?.sys?.stats?.() || Promise.resolve(null));
   if (stats) this.render(stats);
  } catch {}
  this.polling = false;
 }

 build() {
  this.built = true;
  this.panel.innerHTML = `
   <div class="dash-head">
    <span class="dash-logo">${Glyphs.terminal}</span>
    <span class="dash-title"><span class="dash-name" data-sys="host"></span><span class="dash-sub" data-sys="platform"></span></span>
    <span class="sys-live" aria-hidden="true"></span>
    <button type="button" class="dash-close" aria-label="${I18n.t('dashboard.close')}">×</button>
   </div>
   <div class="sys-grid">
    <section class="sys-card is-wide">
     <div class="sys-head"><span>${I18n.t('system.cpu')}</span><span class="sys-head-value" data-sys="cpu-line"></span></div>
     <div class="sys-bar"><span data-bar="cpu"></span></div>
     <div class="sys-detail" data-sys="cpu-model"></div>
     <div class="sys-cores" data-sys="cores"></div>
    </section>
    <section class="sys-card">
     <div class="sys-head"><span>${I18n.t('system.memory')}</span><span class="sys-head-value" data-sys="mem-line"></span></div>
     <div class="sys-bar"><span data-bar="mem"></span></div>
     <div class="sys-bar is-thin" data-sys="swap-wrap" hidden><span data-bar="swap"></span></div>
     <div class="sys-detail" data-sys="mem-detail"></div>
    </section>
    <section class="sys-card">
     <div class="sys-head"><span>${I18n.t('system.load')}</span><span class="sys-head-value" data-sys="load"></span></div>
     <div class="sys-detail" data-sys="uptime"></div>
     <div class="sys-detail" data-sys="engine"></div>
    </section>
    <section class="sys-card">
     <div class="sys-head"><span>${I18n.t('system.network')}</span><span class="sys-head-value" data-sys="net-rate"></span></div>
     <div class="sys-detail" data-sys="net-addresses"></div>
     <div class="sys-detail" data-sys="net-total"></div>
    </section>
    <section class="sys-card">
     <div class="sys-head"><span>${I18n.t('system.disks')}</span><span class="sys-head-value"></span></div>
     <div class="sys-detail" data-sys="disks"></div>
    </section>
    <section class="sys-card">
     <div class="sys-head"><span>${I18n.t('system.temps')}</span><span class="sys-head-value" data-sys="temps-head"></span></div>
     <div class="sys-detail" data-sys="temps"></div>
    </section>
   </div>
   <section class="sys-console">
    <div class="sys-head"><span>${I18n.t('system.console')}</span><span class="sys-head-value" data-sys="console-note">${I18n.t('system.consoleHint')}</span></div>
    <div class="sys-log" data-sys="log" role="log"></div>
   </section>`;
  this.logEl = this.panel.querySelector('[data-sys="log"]');
  this.get = name => this.panel.querySelector(`[data-sys="${name}"]`);
  this.bar = name => this.panel.querySelector(`[data-bar="${name}"]`);
  // The X closes the panel, the same way the Dashboard's does.
  this.panel.querySelector('.dash-close')?.addEventListener('click', () => this.panel.hidePopover?.());
 }

 set(name, text) {
  const node = this.get(name);
  if (node && node.textContent !== text) node.textContent = text;
 }

 setBar(name, value) {
  const node = this.bar(name);
  if (!node) return;
  const width = `${Math.round(Math.max(0, Math.min(1, value || 0)) * 100)}%`;
  if (node.style.width !== width) node.style.width = width;
 }

 render(stats) {
  this.set('host', stats.host || '');
  this.set('platform', `${stats.platform || ''} · ${stats.arch || ''} · node ${stats.node || ''}`);
  this.set('cpu-line', `${percent(stats.usage)}${stats.speeds ? ` · ${stats.speeds[1]} MHz` : ''}`);
  this.setBar('cpu', stats.usage);
  this.set('cpu-model', stats.cpuModel || '');
  const cores = this.get('cores');
  if (cores) {
   const values = stats.perCpu || [];
   while (cores.children.length > values.length) cores.lastElementChild.remove();
   for (let index = cores.children.length; index < values.length; index++) {
    const cell = document.createElement('span');
    cell.className = 'sys-core';
    cell.innerHTML = '<i></i>';
    cores.append(cell);
   }
   for (let index = 0; index < values.length; index++) {
    const fill = cores.children[index].firstElementChild;
    const width = `${Math.round(values[index] * 100)}%`;
    if (fill.style.width !== width) fill.style.width = width;
   }
  }
  const memory = stats.memory || {};
  this.set('mem-line', `${bytes(memory.used)} / ${bytes(memory.total)}`);
  this.setBar('mem', memory.total ? memory.used / memory.total : 0);
  const swapUsed = Math.max(0, (memory.swapTotal || 0) - (memory.swapFree || 0));
  const swapWrap = this.get('swap-wrap');
  if (swapWrap) {
   swapWrap.hidden = !memory.swapTotal;
   this.setBar('swap', memory.swapTotal ? swapUsed / memory.swapTotal : 0);
  }
  this.set('mem-detail', memory.swapTotal
   ? `cached ${bytes(memory.cached)} · free ${bytes(memory.free)} · swap ${bytes(swapUsed)} / ${bytes(memory.swapTotal)}`
   : `cached ${bytes(memory.cached)} · free ${bytes(memory.free)}`);
  const load = stats.load || {};
  this.set('load', `${(load.one || 0).toFixed(2)} · ${(load.five || 0).toFixed(2)} · ${(load.fifteen || 0).toFixed(2)}`);
  this.set('uptime', `up ${duration(stats.uptime)} · ${stats.cores} cores · ${stats.user || ''}`);
  this.set('engine', `Prism pid ${stats.engine?.pid || '?'} · rss ${bytes(stats.engine?.rss)} · heap ${bytes(stats.engine?.heap)}`);
  const net = stats.net;
  this.set('net-rate', net ? `↓ ${bytes(net.rx)}/s · ↑ ${bytes(net.tx)}/s` : I18n.t('system.waiting'));
  this.set('net-addresses', (stats.interfaces || []).map(item => `${item.name} ${item.address}`).join(' · ') || '—');
  this.set('net-total', net ? `total ↓ ${bytes(net.rxTotal)} · ↑ ${bytes(net.txTotal)}` : '');
  this.set('disks', (stats.disks || []).map(disk => {
   const value = disk.total ? Math.round(disk.used / disk.total * 100) : 0;
   return `${disk.path} — ${bytes(disk.used)} / ${bytes(disk.total)} (${value}%)`;
  }).join('  ·  ') || '—');
  const temps = stats.temps || [];
  this.set('temps-head', temps.length ? `${temps[0].value.toFixed(1)}°C` : '—');
  this.set('temps', temps.map(item => `${item.name} ${item.value.toFixed(0)}°C`).join(' · ') || I18n.t('system.noTemps'));
 }

 addLog(line) {
  if (!this.logEl) return;
  const near = this.logEl.scrollHeight - this.logEl.scrollTop - this.logEl.clientHeight < 40;
  const row = document.createElement('div');
  row.className = 'sys-log-line';
  row.textContent = String(line);
  this.logEl.append(row);
  while (this.logEl.childElementCount > KEEP_LOGS) this.logEl.firstElementChild.remove();
  if (near) this.logEl.scrollTop = this.logEl.scrollHeight;
 }
}

window.SystemPanel = SystemPanel;
})();
