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

function rowHtml(device, { self = false, failed = '', chip = '', localPc = false } = {}) {
 const name = escapeHtml(device.name || device.id || 'device');
 const chips = [
  chip ? `<span class="device-chip">${escapeHtml(chip)}</span>` : self ? `<span class="device-chip">${escapeHtml(I18n.t('devices.thisPc'))}</span>` : '',
  device.server && !self ? `<span class="device-chip is-server">${escapeHtml(I18n.t('devices.server'))}</span>` : '',
 ].join('');
 const meta = deviceMeta(device);
 const offline = !self && !localPc && !device.url ? `<span class="device-offline">${escapeHtml(I18n.t('devices.noWeb'))}</span>` : '';
 const fail = failed ? `<span class="device-fail">${escapeHtml(I18n.t('devices.kickedLine', { reason: failed }))}</span>` : '';
 return `<button type="button" class="device-row${self ? ' is-self' : ''}${failed ? ' is-failed' : ''}" data-device="${escapeHtml(device.id || 'self')}"${localPc ? ' data-local-pc="1"' : ''} ${!self && !localPc && !device.url ? 'data-offline="1"' : ''}>
  <span class="device-pc">${PC_ICON}</span>
  <span class="device-text">
   <span class="device-name">${name}${chips}</span>
   <span class="device-meta">${escapeHtml(meta)}</span>
   ${offline}
   ${fail}
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
// A remote window (the server's web UI inside the app): "This PC" asks the app to come back.
const FROM_DEVICE = (() => { try { return new URLSearchParams(location.search).get('from') || ''; } catch { return ''; } })();

async function pick(device) {
 if (isApp()) {
  const result = await window.openghost.devices.pick(device.id);
  return result || { mode: 'self' };
 }
 // Web: hand the page over to that device's own web UI.
 const result = await window.openghost?.devices?.open?.(device.id).catch(() => null);
 if (result?.self) {
  // "This PC" while sitting in a remote device window: go back to the local app.
  if (window.openghostRemote?.back) { await window.openghostRemote.back().catch(() => {}); return { mode: 'self' }; }
  return { mode: 'self' };
 }
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
    <p class="device-kicked" hidden></p>
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
  this.kicked = null;
  window.openghost?.devices?.onKicked?.(kicked => this.showKicked(kicked));
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
  const row = this.list.querySelector(`.device-row[data-device="${window.CSS?.escape ? CSS.escape(id) : id}"]`);
  this.note.textContent = I18n.t('devices.opening', { name: row?.querySelector('.device-name')?.textContent?.trim() || 'device' });
  const result = await pick({ id });
  if (result?.mode === 'offline') { this.note.textContent = I18n.t('devices.offline'); return; }
  if (result?.mode === 'error') { this.note.textContent = I18n.t('devices.failed', { name: result.name || 'device', error: result.error || '' }); return; }
  this.hide();
 }

 async render() {
  const data = await listOwn();
  if (!data) return;
  if (data.kicked) this.kicked = data.kicked;
  const rows = [rowHtml({ ...data.self, self: true }, { self: true })];
  for (const device of data.devices || []) rows.push(rowHtml(device, { failed: this.kicked?.id === device.id ? this.kicked.reason : '' }));
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

 // The device the app was connected to stopped answering: the picker comes back with that
 // device red and one line saying why.
 async showKicked(kicked) {
  this.kicked = kicked || null;
  const banner = this.el.querySelector('.device-kicked');
  if (banner) {
   banner.hidden = !kicked;
   banner.textContent = kicked ? I18n.t('devices.kickedBanner', { name: kicked.name || 'device', reason: kicked.reason || '' }) : '';
  }
  await this.show();
 }

 // The app asks on launch; the screen only appears when another device answers.
 async maybeShow() {
  if (!window.openghost?.devices?.prompt) return;
  let data = null;
  try { data = await window.openghost.devices.prompt(); } catch { data = null; }
  if (!data?.show) return;
  if (data.kicked) this.kicked = data.kicked;
  const banner = this.el.querySelector('.device-kicked');
  if (banner && this.kicked) {
   banner.hidden = false;
   banner.textContent = I18n.t('devices.kickedBanner', { name: this.kicked.name || 'device', reason: this.kicked.reason || '' });
  }
  const rows = [rowHtml({ ...data.self, self: true }, { self: true })];
  for (const device of data.devices || []) rows.push(rowHtml(device, { failed: this.kicked?.id === device.id ? this.kicked.reason : '' }));
  this.list.innerHTML = rows.join('');
  if ((data.devices || []).length) this.show();
 }
}

// --------------------------------------------------------------- the device menu
// Opened from the sidebar's DEVICES row (and, before, from a composer pill). A remote window
// (the server's UI in the app) gets the honest picture there: the server it is watching wears
// "This server", and the PC the app runs on wears "This PC" and leads back to it.
const IN_REMOTE = () => Boolean(window.openghostRemote?.back);

class DeviceMenu {
 constructor({ button, menu }) {
  this.button = button || null;
  this.menu = menu;
  if (!menu) return;
  if (this.button) {
   this.button.addEventListener('click', () => {
    if (this.menu.matches(':popover-open')) this.menu.hidePopover?.();
    else this.open();
   });
  }
  menu.addEventListener('click', async event => {
   const row = event.target.closest('.device-row');
   if (!row) return;
   const say = text => {
    let box = menu.querySelector('[data-device-note]');
    if (!box) {
     box = document.createElement('div');
     box.className = 'device-note';
     box.setAttribute('data-device-note', '1');
     menu.append(box);
    }
    box.textContent = text;
   };
   if (row.dataset.current === '1') { menu.hidePopover?.(); return; }
   // The PC this remote window was opened from: one press goes back to its own app.
   if (row.dataset.localPc === '1' && IN_REMOTE()) {
    menu.hidePopover?.();
    window.openghostRemote.back().catch(() => {});
    return;
   }
   if (row.dataset.offline === '1') { say(I18n.t('devices.offline')); return; }
   say(I18n.t('devices.opening', { name: row.querySelector('.device-name')?.textContent?.trim() || 'device' }));
   const result = await pick({ id: row.dataset.device });
   if (result?.mode === 'offline') { say(I18n.t('devices.offline')); return; }
   if (result?.mode === 'error') { say(I18n.t('devices.failed', { name: result.name || 'device', error: result.error || '' })); return; }
   menu.hidePopover?.();
  });
  document.addEventListener('pointerdown', event => {
   if (!this.menu.matches(':popover-open')) return;
   if (this.menu.contains(event.target) || this.button?.contains(event.target)) return;
   this.menu.hidePopover?.();
  }, true);
 }

 // The sidebar's DEVICES row opens the same menu, anchored under itself.
 async openAt(anchor) {
  const data = await listOwn().catch(() => null);
  if (!data || !(data.devices || []).length) return;
  if (anchor) {
   anchor.style.anchorName = '--device';
   if (this.button) this.button.style.anchorName = 'none';
   this.menu.addEventListener('toggle', event => {
    if (event.newState !== 'closed') return;
    anchor.style.anchorName = '';
    if (this.button) this.button.style.anchorName = '';
   }, { once: true });
  }
  await this.open();
 }

 async open() {
  const data = await listOwn().catch(() => null);
  if (!data) return;
  const kicked = data.kicked;
  const remote = IN_REMOTE();
  // In a remote window the engine's "self" is the server being watched (it wears "This
  // server"); the PC this window came from (?from=name) wears "This PC" and leads back home.
  const rows = [rowHtml(data.self, { self: true, ...(remote ? { chip: I18n.t('devices.thisServer') } : {}) })];
  for (const device of data.devices || []) {
   const localPc = remote && FROM_DEVICE && String(device.name || '').toLowerCase() === FROM_DEVICE.toLowerCase();
   rows.push(rowHtml(device, {
    failed: kicked?.id === device.id ? kicked.reason : '',
    ...(localPc ? { chip: I18n.t('devices.thisPc'), localPc: true } : {}),
   }));
  }
  this.menu.innerHTML = rows.join('');
  const current = this.menu.querySelector('.device-row.is-self');
  if (current) current.dataset.current = '1';
  window.PopoverMotion?.show ? window.PopoverMotion.show(this.menu) : this.menu.showPopover?.();
 }
}

window.DevicePicker = DevicePicker;
window.DeviceMenu = DeviceMenu;
})();
