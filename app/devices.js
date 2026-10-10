// Other Prism devices on the network: the picker that asks on launch which device this
// window should use, and the little switcher in the composer. Both read the list from the
// beacon (the app's own main process, or the server's engine host on the web).
(() => {
'use strict';

const PC_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/></svg>';
const GO_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';

const osName = value => value === 'win32' ? 'Windows' : value === 'linux' ? 'Linux' : value === 'darwin' ? 'macOS' : (value || '');
const deviceMeta = device => [
 osName(device.platform),
 device.version ? `v${device.version}` : '',
 device.manual ? I18n.t('devices.manual') : '',
].filter(Boolean).join(' · ');

function rowHtml(device, { self = false } = {}) {
 const name = escapeHtml(device.name || device.id || 'device');
 const chips = [
  self ? `<span class="device-chip">${escapeHtml(I18n.t('devices.thisPc'))}</span>` : '',
  device.server && !self ? `<span class="device-chip is-server">${escapeHtml(I18n.t('devices.server'))}</span>` : '',
 ].join('');
 const meta = deviceMeta(device);
 const offline = !self && !device.url ? `<span class="device-offline">${escapeHtml(I18n.t('devices.noWeb'))}</span>` : '';
 return `<button type="button" class="device-row${self ? ' is-self' : ''}" data-device="${escapeHtml(device.id || 'self')}" ${!self && !device.url ? 'data-offline="1"' : ''}>
  <span class="device-pc">${PC_ICON}</span>
  <span class="device-text">
   <span class="device-name">${name}${chips}</span>
   <span class="device-meta">${escapeHtml(meta)}</span>
   ${offline}
  </span>
  <span class="device-go">${GO_ICON}</span>
 </button>`;
}

function escapeHtml(text) {
 return String(text ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
}

function listOwn() {
 return window.openghost?.devices?.list?.() || Promise.resolve(null);
}

// Which surface this page is: the desktop app can open windows; the web can only navigate.
const isApp = () => Boolean(window.openghost?.desktop && window.openghost?.devices?.pick);

async function pick(device) {
 if (isApp()) {
  const result = await window.openghost.devices.pick(device.id);
  return result || { mode: 'self' };
 }
 // Web: hand the page over to that device's own web UI.
 const result = await window.openghost?.devices?.open?.(device.id).catch(() => null);
 if (result?.self) return { mode: 'self' };
 if (result?.url) { window.location.href = result.url; return { mode: 'remote' }; }
 return { mode: 'offline', error: result?.error || I18n.t('devices.offline') };
}

// --------------------------------------------------------------- the launch picker
class DevicePicker {
 constructor({ root }) {
  this.root = root;
  this.el = document.createElement('div');
  this.el.className = 'device-overlay';
  this.el.hidden = true;
  this.el.innerHTML = `
   <div class="device-sheet" role="dialog" aria-modal="true" aria-label="${escapeHtml(I18n.t('devices.title'))}">
    <div class="device-head">${I18n.t('devices.title')}</div>
    <p class="device-hint">${escapeHtml(I18n.t('devices.hint'))}</p>
    <div class="device-list"></div>
    <div class="device-foot">
     <input class="device-address" type="text" spellcheck="false" autocomplete="off" placeholder="${escapeHtml(I18n.t('devices.addPlaceholder'))}">
     <button type="button" class="settings-button device-add">${escapeHtml(I18n.t('devices.add'))}</button>
    </div>
    <p class="device-note">${escapeHtml(I18n.t('devices.addHint'))}</p>
   </div>`;
  root.append(this.el);
  this.list = this.el.querySelector('.device-list');
  this.note = this.el.querySelector('.device-note');
  this.el.addEventListener('click', event => {
   const row = event.target.closest('.device-row');
   if (!row) return;
   this.choose(row.dataset.device, row.dataset.offline === '1');
  });
  this.el.querySelector('.device-add')?.addEventListener('click', () => this.add());
  this.el.querySelector('.device-address')?.addEventListener('keydown', event => {
   if (event.key === 'Enter') this.add();
  });
 }

 async add() {
  const input = this.el.querySelector('.device-address');
  const value = String(input?.value || '').trim();
  if (!value) return;
  const device = await window.openghost?.devices?.add?.(value.includes(':') ? { host: value.split(':')[0], port: value.split(':')[1] } : { host: value }).catch(() => null);
  if (input) input.value = '';
  if (device) this.note.textContent = `${device.name} @ ${device.host}:${device.port}`;
  await this.render();
 }

 async choose(id, offline = false) {
  if (offline) { this.note.textContent = I18n.t('devices.offline'); return; }
  const result = await pick({ id });
  if (result?.mode === 'offline' || result?.error) { this.note.textContent = result.error || I18n.t('devices.offline'); return; }
  this.hide();
 }

 async render() {
  const data = await listOwn();
  if (!data) return;
  const rows = [rowHtml({ ...data.self, self: true }, { self: true })];
  for (const device of data.devices || []) rows.push(rowHtml(device));
  this.list.innerHTML = rows.join('');
 }

 async show() {
  await this.render();
  this.el.hidden = false;
  this.el.classList.add('is-shown');
 }

 hide() {
  this.el.classList.remove('is-shown');
  this.el.hidden = true;
 }

 // The app asks on launch; the screen only appears when another device answers.
 async maybeShow() {
  if (!window.openghost?.devices?.prompt) return;
  let data = null;
  try { data = await window.openghost.devices.prompt(); } catch { data = null; }
  if (!data?.show) return;
  const rows = [rowHtml({ ...data.self, self: true }, { self: true })];
  for (const device of data.devices || []) rows.push(rowHtml(device));
  this.list.innerHTML = rows.join('');
  if ((data.devices || []).length) this.show();
 }
}

// --------------------------------------------------------------- the composer switcher
class DeviceMenu {
 constructor({ button, menu }) {
  this.button = button;
  this.menu = menu;
  if (!button || !menu) return;
  button.addEventListener('click', () => {
   if (this.menu.matches(':popover-open')) this.menu.hidePopover?.();
   else this.open();
  });
  menu.addEventListener('click', async event => {
   const row = event.target.closest('.device-row');
   if (!row) return;
   if (row.dataset.current === '1') { menu.hidePopover?.(); return; }
   if (row.dataset.offline === '1') return;
   menu.hidePopover?.();
   await pick({ id: row.dataset.device });
  });
  document.addEventListener('pointerdown', event => {
   if (!this.menu.matches(':popover-open')) return;
   if (this.menu.contains(event.target) || this.button.contains(event.target)) return;
   this.menu.hidePopover?.();
  }, true);
  this.refresh();
  // Devices come and go; a quiet check keeps the button honest.
  setInterval(() => this.refresh(), 15000);
 }

 async refresh() {
  const data = await listOwn().catch(() => null);
  const remotes = data?.devices || [];
  this.button.hidden = remotes.length === 0;
  if (!remotes.length) return;
  const name = data?.name || data?.self?.name || '';
  this.button.title = I18n.t('devices.switch');
  this.button.setAttribute('aria-label', I18n.t('devices.switch'));
  if (!this.button.querySelector('.composer-device-text')) {
   this.button.innerHTML = `<span class="composer-device-icon">${PC_ICON}</span><span class="composer-device-text"></span>`;
  }
  this.button.querySelector('.composer-device-text').textContent = name;
 }

 async open() {
  const data = await listOwn().catch(() => null);
  if (!data) return;
  const rows = [rowHtml(data.self, { self: true })];
  for (const device of data.devices || []) rows.push(rowHtml(device));
  this.menu.innerHTML = rows.join('');
  const current = this.menu.querySelector(`.device-row[data-device="self"], .device-row.is-self`);
  if (current) current.dataset.current = '1';
  window.PopoverMotion?.show ? window.PopoverMotion.show(this.menu) : this.menu.showPopover?.();
 }
}

window.DevicePicker = DevicePicker;
window.DeviceMenu = DeviceMenu;
})();
