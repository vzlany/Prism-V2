(() => {
'use strict';

const STORAGE = { effort: 'deepseek.effort', mode: 'openghost.mode', model: 'openghost.model', catalog: 'openghost.catalog', catalogAt: 'openghost.catalogAt', apis: 'openghost.apis', apiActive: 'openghost.apiActive' };
const KEYS = { openai: 'openai.apiKey', anthropic: 'anthropic.apiKey', deepseek: 'deepseek.apiKey', 'opencode-go': 'opencode-go.apiKey' };
// The order providers appear in, in the settings and in the model picker.
const ORDER = ['opencode-go', 'chatgpt', 'openai', 'anthropic', 'deepseek'];
const DEFAULT_MODEL = 'deepseek-flash';
const EFFORTS = ['none', 'low', 'high', 'max'];
const DEFAULT_EFFORT = 'high';
const DEFAULT_CONTEXT = 1000000;
// Shown until a key loads the real list, so the picker works before the first check.
const KNOWN_DEEPSEEK = [
 { id: 'deepseek-flash', api: 'deepseek-flash', provider: 'deepseek', name: 'DeepSeek-V4.1-Flash', context: 1048576, efforts: EFFORTS, defaultEffort: DEFAULT_EFFORT, vision: true },
 { id: 'deepseek-v4-pro', api: 'deepseek-v4-pro', provider: 'deepseek', name: 'DeepSeek-V4-Pro', context: 1048576, efforts: EFFORTS, defaultEffort: DEFAULT_EFFORT, vision: false },
];
const LINKS = {
 openai: ['https://platform.openai.com/api-keys', 'platform.openai.com'],
 anthropic: ['https://console.anthropic.com/settings/keys', 'console.anthropic.com'],
 deepseek: ['https://platform.deepseek.com/api_keys', 'platform.deepseek.com'],
 'opencode-go': ['https://opencode.ai/console', 'opencode.ai/console'],
};
const MODES = ['ask', 'auto', 'full'];
// The website runs turns through the desktop app when it is there; locally (a headless
// `prism web`) Full access is the useful default, since the page is the only operator.
const DEFAULT_MODE = window.openghost?.web ? 'full' : 'ask';
const CHECK_DELAY = 400;
// How long a provider's model list is trusted. OpenCode adds and drops models on its side,
// so the catalog is re-read in the background once it is this old, and periodically after.
const CATALOG_TTL = 6 * 60 * 60 * 1000;
const CATALOG_EVERY = 30 * 60 * 1000;

const escapeHtml = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const uid = () => `api_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

// One provider can hold several API keys: entries live in localStorage under one list, one
// of them is equipped and is the one every model call uses. The old single-key storage is
// folded in on first load, so nothing typed before is lost.
function apiRow(provider) {
 const [href, host] = LINKS[provider];
 const note = I18n.has(`settings.${provider}.note`) ? ` ${escapeHtml(I18n.t(`settings.${provider}.note`))}` : '';
 return `
  <div class="settings-row is-wide">
   <div class="settings-text">
    <label class="settings-label" for="settings-key-${provider}">${escapeHtml(I18n.t(`settings.${provider}.key`))}</label>
    <p class="settings-hint"><span>${escapeHtml(I18n.t(`settings.${provider}.hint`))}</span> <a href="${href}" target="_blank" rel="noopener noreferrer">${host}</a>.${note}</p>
    <p class="settings-hint">${escapeHtml(I18n.t('settings.api.multiHint'))}</p>
   </div>
   <div class="settings-control">
    <div class="api-list" data-provider="${provider}" role="radiogroup" aria-label="${escapeHtml(I18n.t(`settings.${provider}.key`))}"></div>
    <div class="mcp-add-row api-add-row">
     <input class="settings-key api-new-name" placeholder="${escapeHtml(I18n.t('settings.api.namePlaceholder'))}" autocomplete="off" spellcheck="false">
     <input id="settings-key-${provider}" class="settings-key api-new-key is-secret" type="text" placeholder="${provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}" autocomplete="off" spellcheck="false">
     <button type="button" class="settings-button is-primary" data-api-add="${provider}">${escapeHtml(I18n.t('settings.api.add'))}</button>
    </div>
    <p class="settings-status" data-provider="${provider}" role="status"></p>
   </div>
  </div>`;
}

function accountRow() {
 return `
  <div class="settings-row is-wide">
   <div class="settings-text">
    <span class="settings-label">${escapeHtml(I18n.t('settings.chatgpt.label'))}</span>
    <p class="settings-hint">${escapeHtml(I18n.t('settings.chatgpt.hint'))}</p>
   </div>
   <div class="settings-control settings-account">
    <div class="settings-account-row">
     <span class="settings-account-who"></span>
     <button type="button" class="settings-button is-primary" data-action="login">${escapeHtml(I18n.t('settings.chatgpt.login'))}</button>
     <button type="button" class="settings-button" data-action="cancel">${escapeHtml(I18n.t('settings.chatgpt.cancel'))}</button>
     <button type="button" class="settings-button" data-action="logout">${escapeHtml(I18n.t('settings.chatgpt.logout'))}</button>
    </div>
    <p class="settings-status" data-provider="chatgpt" role="status"></p>
   </div>
  </div>`;
}

function section(id, name, rows) {
 return `
  <section class="provider" data-provider="${id}" aria-labelledby="provider-${id}">
   <header class="provider-head">
    <h3 class="provider-name" id="provider-${id}">${escapeHtml(name)}</h3>
    <span class="provider-models"></span>
    <span class="provider-state"></span>
   </header>
   ${rows}
  </section>`;
}

class Settings {
 constructor(dialog) {
  this.dialog = dialog;
  this.list = dialog.querySelector('.settings-providers');
  this.apis = this.readApis();
  this.activeApi = this.readActive();
  this.keys = Object.fromEntries(Object.keys(KEYS).map(provider => [provider, this.equippedKey(provider)]));
  this.account = { connected: false };
  this.catalog = this.readCatalog();
  this.shared = {};
  this.models = [];
  this.efforts = EFFORTS.slice();
  localStorage.removeItem('deepseek.model');
  this.model = localStorage.getItem(STORAGE.model) || DEFAULT_MODEL;
  this.shown = this.model;
  const effort = localStorage.getItem(STORAGE.effort);
  this.effort = typeof effort === 'string' && effort ? effort : DEFAULT_EFFORT;
  const mode = localStorage.getItem(STORAGE.mode);
  this.mode = MODES.includes(mode) ? mode : DEFAULT_MODE;
  this.checks = {};
  this.checked = new Set();
  // Keys saved in an earlier session count as working until a check says otherwise.
  this.accepted = new Set(Object.keys(KEYS).filter(provider => this.keys[provider]));
  this.syncSharedKeys();
  this.build();
  this.paintMcp();
  this.paintEffects();
  this.collect();
  dialog.addEventListener('dismiss', () => dialog.close());
  this.refreshAll();
 }

 // ------------------------------------------------------------- API keys per provider
 // The old single key per provider migrates into the list the first time this runs.
 readApis() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORAGE.apis)) || {}; } catch {}
  const apis = {};
  for (const provider of Object.keys(KEYS)) {
   const list = Array.isArray(saved[provider]) ? saved[provider].filter(entry => entry?.key) : [];
   const legacy = (localStorage.getItem(KEYS[provider]) || '').trim();
   if (legacy && !list.some(entry => entry.key === legacy)) list.unshift({ id: uid(), name: I18n.t('settings.api.default'), key: legacy, at: Date.now() });
   apis[provider] = list.map((entry, k) => ({ id: entry.id || uid(), name: String(entry.name || `${I18n.t('settings.api.default')} ${k + 1}`), key: String(entry.key), at: Number(entry.at) || Date.now() }));
  }
  return apis;
 }

 saveApis() {
  try { localStorage.setItem(STORAGE.apis, JSON.stringify(this.apis)); } catch {}
 }

 // The Discord bridge (a separate process) cannot read the browser's localStorage, so the
 // equipped keys are mirrored into the shared store; the bridge reads them from there.
 syncSharedKeys() {
  if (!window.openghost?.store?.write) return;
  const keys = {};
  for (const provider of Object.keys(KEYS)) if (this.keys[provider]) keys[provider] = this.keys[provider];
  try { Promise.resolve(window.openghost.store.write('keys', { at: Date.now(), keys })).catch(() => {}); } catch {}
 }

 readActive() {
  try { return JSON.parse(localStorage.getItem(STORAGE.apiActive)) || {}; } catch { return {}; }
 }

 saveActive() {
  try { localStorage.setItem(STORAGE.apiActive, JSON.stringify(this.activeApi)); } catch {}
 }

 equipped(provider) {
  const list = this.apis[provider] || [];
  const active = list.find(entry => entry.id === this.activeApi[provider]);
  return active || list[0] || null;
 }

 equippedKey(provider) {
  return this.equipped(provider)?.key || '';
 }

 // Equipping writes the key the rest of the app already reads (this.keys + the old storage
 // key), so every model call and every "is it connected" check follows at once.
 equip(provider, id) {
  if (!this.apis[provider]?.some(entry => entry.id === id)) return;
  this.activeApi[provider] = id;
  this.saveActive();
  this.keys[provider] = this.equippedKey(provider);
  if (this.keys[provider]) localStorage.setItem(KEYS[provider], this.keys[provider]);
  else localStorage.removeItem(KEYS[provider]);
  this.accepted.delete(provider);
  this.checked.delete(provider);
  this.paintApis(provider);
  this.paint();
  this.changed();
  this.syncSharedKeys();
  if (this.keys[provider]) this.checkKey(provider);
 }

 addApi(provider, name, key) {
  const value = String(key || '').trim();
  if (!value) return false;
  const list = this.apis[provider] ||= [];
  const entry = { id: uid(), name: String(name || '').trim() || `${I18n.t('settings.api.default')} ${list.length + 1}`, key: value, at: Date.now() };
  list.push(entry);
  this.saveApis();
  this.activeApi[provider] = entry.id;
  this.saveActive();
  this.keys[provider] = entry.key;
  localStorage.setItem(KEYS[provider], entry.key);
  this.accepted.delete(provider);
  this.checked.delete(provider);
  this.paintApis(provider);
  this.paint();
  this.changed();
  this.syncSharedKeys();
  this.checkKey(provider);
  return true;
 }

 removeApi(provider, id) {
  const list = this.apis[provider] || [];
  const at = list.findIndex(entry => entry.id === id);
  if (at < 0) return;
  list.splice(at, 1);
  if (this.activeApi[provider] === id) delete this.activeApi[provider];
  this.saveApis();
  this.saveActive();
  this.keys[provider] = this.equippedKey(provider);
  if (this.keys[provider]) localStorage.setItem(KEYS[provider], this.keys[provider]);
  else localStorage.removeItem(KEYS[provider]);
  this.accepted.delete(provider);
  this.checked.delete(provider);
  this.paintApis(provider);
  this.paint();
  this.changed();
  this.syncSharedKeys();
  if (this.keys[provider]) this.checkKey(provider);
 }

 renameApi(provider, id, name) {
  const entry = this.apis[provider]?.find(item => item.id === id);
  if (!entry) return;
  entry.name = String(name || '').trim() || entry.name;
  this.saveApis();
  this.paintApis(provider);
 }

 // The key of one entry changed in place; the equipped one updates the live key at once.
 editApi(provider, id, key) {
  const entry = this.apis[provider]?.find(item => item.id === id);
  if (!entry) return;
  entry.key = String(key);
  this.saveApis();
  const active = this.activeApi[provider] ? this.equipped(provider) : null;
  if ((active && active.id === id) || (!this.activeApi[provider] && (this.apis[provider] || [])[0]?.id === id)) {
   this.keys[provider] = entry.key;
   if (entry.key) localStorage.setItem(KEYS[provider], entry.key);
   else localStorage.removeItem(KEYS[provider]);
   this.accepted.delete(provider);
   this.checked.delete(provider);
   this.syncSharedKeys();
   clearTimeout(this.timer?.[provider]);
   this.timer = { ...this.timer };
   this.paint();
   if (entry.key) {
    this.setStatus(provider, I18n.t('settings.key.checking'));
    this.timer[provider] = setTimeout(() => this.checkKey(provider), CHECK_DELAY);
   } else this.changed();
  }
 }

 // Draws the provider's key list: one row per saved API, the equipped one first in the
 // radio group, with Add (above) collecting a new one.
 paintApis(provider) {
  const box = this.list?.querySelector(`.api-list[data-provider="${provider}"]`);
  if (!box) return;
  const list = this.apis[provider] || [];
  const active = this.equipped(provider)?.id || '';
  box.innerHTML = list.length ? list.map(entry => `
   <div class="api-item${entry.id === active ? ' is-active' : ''}" data-id="${escapeHtml(entry.id)}">
    <input type="radio" name="api-${provider}" class="api-radio" value="${escapeHtml(entry.id)}" ${entry.id === active ? 'checked' : ''} aria-label="${escapeHtml(I18n.t('settings.api.equip'))}">
    <input class="api-name" value="${escapeHtml(entry.name)}" spellcheck="false" autocomplete="off" aria-label="${escapeHtml(I18n.t('settings.api.name'))}">
    <input class="api-key is-secret" value="${escapeHtml(entry.key)}" spellcheck="false" autocomplete="off" aria-label="${escapeHtml(I18n.t(`settings.${provider}.key`))}">
    <button type="button" class="api-remove" title="${escapeHtml(I18n.t('settings.api.remove'))}" aria-label="${escapeHtml(I18n.t('settings.api.remove'))}">×</button>
   </div>`).join('')
   : `<p class="api-empty">${escapeHtml(I18n.t('settings.api.empty'))}</p>`;
  for (const item of box.querySelectorAll('.api-item')) {
   const id = item.dataset.id;
   item.querySelector('.api-radio')?.addEventListener('change', () => this.equip(provider, id));
   item.querySelector('.api-name')?.addEventListener('change', event => this.renameApi(provider, id, event.target.value));
   item.querySelector('.api-key')?.addEventListener('input', event => this.editApi(provider, id, event.target.value));
   item.querySelector('.api-remove')?.addEventListener('click', () => this.removeApi(provider, id));
  }
  box.querySelector(`.api-radio[value="${CSS.escape(active)}"]`)?.closest('.api-item')?.classList.add('is-active');
 }

 readCatalog() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORAGE.catalog)) || {}; } catch {}
  return { chatgpt: [], openai: [], anthropic: [], 'opencode-go': [], ...saved, deepseek: saved.deepseek?.length ? saved.deepseek : KNOWN_DEEPSEEK.slice() };
 }

 saveCatalog() {
  try { localStorage.setItem(STORAGE.catalog, JSON.stringify(this.catalog)); } catch {}
  // The website (and the phone) reads its models from here: the app has the keys, so its
  // list is the truth to pick from; a run there is handed back to the app anyway.
  if (window.openghost?.desktop) {
   try { window.openghost?.store?.write?.('catalog', { at: Date.now(), providers: this.catalog }); } catch {}
  }
 }

 // The desktop app's model catalog, shared through the store: the website offers the same
 // models and efforts even though it has no keys of its own.
 async loadShared() {
  if (!window.openghost?.web) return;
  try {
   const data = await window.openghost.store.read('catalog');
   if (!data?.providers) return;
   const providers = {};
   for (const [name, list] of Object.entries(data.providers)) if (Array.isArray(list) && list.length) providers[name] = list;
   this.shared = providers;
   this.changed();
  } catch {}
 }

 connected(provider) {
  if (provider === 'chatgpt') return !!this.account.connected || Boolean(this.shared?.[provider]?.length && window.openghost?.app?.connected?.());
  return !!this.keys[provider] || Boolean(this.shared?.[provider]?.length && window.openghost?.app?.connected?.());
 }

 // The badge turns green only once the provider has taken the key, so a mistyped key never looks connected.
 working(provider) {
  return this.connected(provider) && (provider === 'chatgpt' || this.accepted.has(provider));
 }

 // The picker offers the models of every connected provider, or the app's shared catalog for
 // the ones this page has no key for; with neither, DeepSeek, the app's own default.
 collect() {
  const models = ORDER
   .filter(provider => this.connected(provider))
   .flatMap(provider => this.catalog[provider]?.length ? this.catalog[provider] : (this.shared?.[provider] || []));
  this.models = models.length ? models : KNOWN_DEEPSEEK.slice();
  this.paint();
 }

 find(id) {
  return this.models.find(item => item.id === id) || null;
 }

 // A chat keeps its own model; one that is no longer offered falls back to the model new chats get.
 // Chats started before this was fixed kept the provider's model name rather than the picker's id, so that name is looked up too.
 resolve(id) {
  if (id && this.find(id)) return id;
  const named = id && this.models.find(item => item.api === id);
  if (named) return named.id;
  return this.find(this.model) ? this.model : this.models[0]?.id || DEFAULT_MODEL;
 }

 configFor(id) {
  const model = this.find(id) || KNOWN_DEEPSEEK.find(item => item.id === id) || null;
  const provider = model?.provider || 'deepseek';
  const efforts = Array.isArray(model?.efforts) ? model.efforts : EFFORTS;
  const effort = efforts.length ? (efforts.includes(this.effort) ? this.effort : [model?.defaultEffort, DEFAULT_EFFORT].find(level => efforts.includes(level)) || efforts[efforts.length - 1]) : '';
  return {
   provider,
   model: model?.api || id,
   name: model?.name || id,
   key: this.keys[provider] || '',
   ready: this.connected(provider),
   effort,
   efforts,
   vision: model?.vision !== false,
   thinking: model?.thinking,
   output: model?.output,
  };
 }

 get config() {
  return this.configFor(this.resolve(this.model));
 }

 windowOf(id) {
  return this.find(id)?.context || DEFAULT_CONTEXT;
 }

 // The effort steps follow the model of the chat on screen.
 show(id) {
  if (id === this.shown) return;
  this.shown = id;
  this.applyEfforts();
 }

 applyEfforts() {
  const model = this.find(this.shown);
  const efforts = Array.isArray(model?.efforts) ? model.efforts : EFFORTS;
  const same = efforts.length === this.efforts.length && efforts.every((level, i) => level === this.efforts[i]);
  this.efforts = efforts.slice();
  if (!efforts.length) {
   // A model without thinking levels keeps the last choice for the models that have them.
   this.effort = '';
  } else if (!efforts.includes(this.effort)) {
   const fallback = [model?.defaultEffort, DEFAULT_EFFORT].find(level => efforts.includes(level));
   this.effort = fallback || efforts[Math.min(efforts.length - 1, 2)];
   localStorage.setItem(STORAGE.effort, this.effort);
  }
  if (!same) this.onEfforts?.(this.efforts);
 }

 setModel(id) {
  if (id === this.model || !this.find(id)) return;
  this.model = id;
  localStorage.setItem(STORAGE.model, id);
 }

 setEffort(value) {
  this.effort = value;
  localStorage.setItem(STORAGE.effort, value);
 }

 setMode(value) {
  if (!MODES.includes(value)) return;
  this.mode = value;
  localStorage.setItem(STORAGE.mode, value);
 }

 changed() {
  this.collect();
  this.applyEfforts();
  this.onModels?.();
 }

 async refreshAll() {
  await this.syncAccount();
  await this.loadShared();
  await Promise.all(Object.keys(KEYS).filter(provider => this.keys[provider]).map(provider => this.checkKey(provider)));
  this.syncCatalogs();
 }

 // The live catalog drifts as OpenCode adds and retires models: lists older than the TTL are
 // re-read quietly, and a slow timer keeps doing it while the app runs. A model that appears
 // shows up in the picker on its own; one that is gone simply stops being offered.
 readAt() {
  try { return JSON.parse(localStorage.getItem(STORAGE.catalogAt) || '{}') || {}; } catch { return {}; }
 }

 saveAt(provider) {
  const at = this.readAt();
  at[provider] = Date.now();
  try { localStorage.setItem(STORAGE.catalogAt, JSON.stringify(at)); } catch {}
 }

 syncCatalogs() {
  clearInterval(this.catalogTimer);
  const tick = () => {
   const at = this.readAt();
   for (const provider of ORDER) {
    if (!this.connected(provider) || this.account.waiting) continue;
    if (provider === 'chatgpt' && !this.account.connected) continue;
    if (Date.now() - (at[provider] || 0) < CATALOG_TTL) continue;
    this.refresh(provider).catch(() => {});
   }
  };
  tick();
  this.catalogTimer = setInterval(tick, CATALOG_EVERY);
 }

 // A sign-in can lapse while the app runs, so the settings ask how it stands each time they open.
 async syncAccount() {
  const auth = window.openghost?.auth;
  if (!auth || this.account.waiting) return;
  const account = await auth.status().catch(() => null);
  if (account && !this.account.waiting) this.setAccount(account);
 }

 // Loads a provider's models into the catalog; the last request for a provider wins.
 async refresh(provider) {
  const token = (this.checks[provider] = (this.checks[provider] || 0) + 1);
  const models = await Providers.models(provider, this.keys[provider]);
  if (token !== this.checks[provider]) return false;
  this.catalog[provider] = models.length || provider !== 'deepseek' ? models : KNOWN_DEEPSEEK.slice();
  this.saveCatalog();
  this.saveAt(provider);
  this.changed();
  return true;
 }

 build() {
  this.list.innerHTML = [
   section('opencode-go', 'OpenCode Go', apiRow('opencode-go')),
   section('openai', 'OpenAI', accountRow() + apiRow('openai')),
   section('anthropic', 'Anthropic', apiRow('anthropic')),
   section('deepseek', 'DeepSeek', apiRow('deepseek')),
  ].join('');
  this.inputs = {};
  for (const provider of Object.keys(KEYS)) {
   this.paintApis(provider);
   const add = this.list.querySelector(`[data-api-add="${provider}"]`);
   const name = add?.closest('.api-add-row')?.querySelector('.api-new-name');
   const key = add?.closest('.api-add-row')?.querySelector('.api-new-key');
   this.inputs[provider] = key;
   const submit = () => {
    if (this.addApi(provider, name?.value, key?.value) && name && key) { name.value = ''; key.value = ''; }
    key?.focus();
   };
   add?.addEventListener('click', submit);
   key?.addEventListener('keydown', event => { if (event.key === 'Enter') submit(); });
  }
  this.statuses = Object.fromEntries([...this.list.querySelectorAll('.settings-status')].map(node => [node.dataset.provider, node]));
  this.accountBox = this.list.querySelector('.settings-account');
  this.accountBox.addEventListener('click', event => {
   const action = event.target.closest('[data-action]')?.dataset.action;
   if (action === 'login') this.login();
   else if (action === 'cancel') window.openghost?.auth?.cancel();
   else if (action === 'logout') this.logout();
  });
  if (!window.openghost?.auth) this.accountBox.closest('.settings-row').hidden = true;
  this.mcpPage = this.dialog.querySelector('.settings-mcp-page');
  this.autoPage = this.dialog.querySelector('.settings-auto-page');
  this.tabs = [...this.dialog.querySelectorAll('.settings-tab')];
  // The Auto page is about this desktop install: a browser has nothing to set there.
  if (!window.openghost?.desktop) {
   const autoTab = this.dialog.querySelector('.settings-tab[data-tab="auto"]');
   if (autoTab) autoTab.hidden = true;
  }
  this.pages = [...this.dialog.querySelectorAll('.settings-page')];
  for (const tab of this.tabs) tab.addEventListener('click', () => this.showTab(tab.dataset.tab));
 }

 paint() {
  if (!this.list) return;
  for (const node of this.list.querySelectorAll('.provider')) {
   const id = node.dataset.provider;
   if (id === 'mcp') continue;
   // OpenAI is connected through either the ChatGPT sign-in or a key; a model both offer counts once.
   const live = (id === 'openai' ? ['chatgpt', 'openai'] : [id]).filter(source => this.working(source));
   const on = live.length > 0, count = new Set(live.flatMap(source => this.catalog[source] || []).map(model => model.api)).size;
   const state = node.querySelector('.provider-state');
   state.textContent = I18n.t(on ? 'settings.connected' : 'settings.off');
   state.classList.toggle('is-on', on);
   node.querySelector('.provider-models').textContent = on && count ? I18n.t('settings.models', { count }) : '';
  }
  const box = this.accountBox;
  if (!box) return;
  box.dataset.state = this.account.waiting ? 'waiting' : this.account.connected ? 'connected' : 'idle';
  const who = [this.account.email, this.account.plan && I18n.t('settings.chatgpt.plan', { plan: this.account.plan.charAt(0).toUpperCase() + this.account.plan.slice(1) })].filter(Boolean).join(' · ');
  box.querySelector('.settings-account-who').textContent = this.account.waiting ? I18n.t('settings.chatgpt.waiting') : who;
 }

 showTab(name) {
  for (const tab of this.tabs || []) {
   if (tab.dataset.tab === name) tab.setAttribute('aria-current', 'page');
   else tab.removeAttribute('aria-current');
  }
  for (const page of this.pages || []) page.hidden = page.dataset.page !== name;
  const bar = document.querySelector('.settings-scrollbar');
  if (bar) bar.style.display = name === 'mcp' ? 'none' : '';
  if (name === 'mcp') this.paintMcp();
  if (name === 'prompt') this.paintPrompt();
  if (name === 'effects') this.paintEffects();
  if (name === 'memory') this.paintMemory();
  if (name === 'auto') this.paintAuto();
  else { clearInterval(this.autoTimer); this.autoTimer = 0; }
  if (name === 'about') this.paintAbout();
 }

 // Settings -> Auto: starting with Windows (optionally hidden, straight into the tray) and
 // running the web server alongside the app.
 async paintAuto() {
  const node = this.autoPage;
  if (!node) return;
  const auto = (await window.openghost?.auto?.get?.().catch(() => null)) || { login: false, hidden: false, web: false, bot: false, port: 8787, webRunning: false, botRunning: false };
  const row = (labelKey, hintKey, control) => `<div class="settings-row is-wide">
   <div class="settings-text">
    <span class="settings-label">${escapeHtml(I18n.t(labelKey))}</span>
    <p class="settings-hint">${escapeHtml(I18n.t(hintKey))}</p>
   </div>
   <div class="settings-control">${control}</div>
  </div>`;
  const toggle = (cls, on, disabled = false) => `<label class="mcp-auto"><input type="checkbox" class="${cls}" ${on ? 'checked' : ''} ${disabled ? 'disabled' : ''}>${escapeHtml(I18n.t('settings.auto.enable'))}</label>`;
  node.innerHTML = [
   row('settings.auto.login', 'settings.auto.loginHint', toggle('auto-login', auto.login)),
   row('settings.auto.hidden', 'settings.auto.hiddenHint', toggle('auto-hidden', auto.hidden, !auto.login)),
   row('settings.auto.web', 'settings.auto.webHint', `<div class="mcp-add-row">${toggle('auto-web', auto.web)}<input class="settings-key auto-port" type="number" min="1" max="65535" value="${auto.port}" ${auto.web ? '' : 'disabled'}><button type="button" class="settings-button" data-auto-open ${auto.webRunning || auto.web ? '' : 'disabled'}>${escapeHtml(I18n.t('settings.auto.open'))}</button></div>`),
   row('settings.auto.bot', 'settings.auto.botHint', `<div class="mcp-add-row">${toggle('auto-bot', auto.bot)}<span class="auto-bot-state ${auto.botRunning ? 'is-on' : ''}">${escapeHtml(I18n.t(auto.botRunning ? 'settings.auto.botRunning' : 'settings.auto.botStopped'))}</span></div>`),
   row('settings.auto.net', 'settings.auto.netHint', `<div data-auto-net></div>`),
   `<p class="settings-status" data-provider="auto" role="status"></p>`,
  ].join('');
  // The server's address and who is connected to it, refreshed while the page is open.
  const net = node.querySelector('[data-auto-net]');
  const paintNet = async () => {
   const data = (await window.openghost?.auto?.clients?.().catch(() => null)) || { port: auto.port, clients: [] };
   const on = auto.webRunning || auto.web;
   net.innerHTML = [
    `<div class="auto-server"><span class="${on ? 'is-on' : 'is-off'}">${escapeHtml(I18n.t(on ? 'settings.auto.serverOn' : 'settings.auto.serverOff', { port: data.port || auto.port }))}</span></div>`,
    data.clients.length
     ? `<div class="auto-devices">${data.clients.map(entry => `<div class="auto-device"><span class="auto-ip" role="button" tabindex="0" title="${escapeHtml(I18n.t('settings.auto.showIp'))}">${escapeHtml(entry.ip)}</span><span class="auto-device-meta">${escapeHtml(I18n.t('settings.auto.since', { time: new Date(Number(entry.at) || Date.now()).toLocaleTimeString(I18n.lang, { hour: '2-digit', minute: '2-digit' }) }))}</span></div>`).join('')}</div>`
     : `<div class="auto-empty">${escapeHtml(I18n.t('settings.auto.noDevices'))}</div>`,
   ].join('');
   for (const ip of net.querySelectorAll('.auto-ip')) {
    const reveal = () => ip.classList.toggle('is-shown');
    ip.addEventListener('click', reveal);
    ip.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') reveal(); });
   }
  };
  paintNet();
  clearInterval(this.autoTimer);
  this.autoTimer = setInterval(() => {
   const page = this.dialog.querySelector('.settings-page[data-page="auto"]');
   if (page && !page.hidden && this.dialog.open) paintNet();
  }, 5000);
  const save = async patch => {
   const next = await window.openghost?.auto?.set?.(patch).catch(() => null);
   if (!next) return;
   this.setStatus('auto', I18n.t('settings.auto.saved'));
   this.paintAuto();
  };
  node.querySelector('.auto-login')?.addEventListener('change', event => save({ login: event.target.checked }));
  node.querySelector('.auto-hidden')?.addEventListener('change', event => save({ hidden: event.target.checked }));
  node.querySelector('.auto-web')?.addEventListener('change', event => save({ web: event.target.checked }));
  node.querySelector('.auto-bot')?.addEventListener('change', event => save({ bot: event.target.checked }));
  node.querySelector('.auto-port')?.addEventListener('change', event => save({ port: Number(event.target.value) || 8787 }));
  node.querySelector('[data-auto-open]')?.addEventListener('click', () => window.open(`http://localhost:${auto.port}/`, '_blank'));
 }

 mcpNote(text, tone = '') {
  const node = this.mcpPage?.querySelector('.mcp-status');
  if (!node) return;
  node.textContent = text || '';
  node.classList.toggle('is-error', tone === 'error');
 }

 // Settings -> Prompt: a global system prompt (switchable) and a prompt per model.
 async paintPrompt() {
  const node = this.dialog.querySelector('.settings-prompt-page');
  if (!node || !window.Prompts) return;
  const data = await window.Prompts.load(true);
  const models = this.models || [];
  const options = models.map(model => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name || model.id)}</option>`).join('');
  node.innerHTML = `
   <div class="settings-row is-wide">
    <div class="settings-text">
     <span class="settings-label">${escapeHtml(I18n.t('settings.prompt.global'))}</span>
     <p class="settings-hint">${escapeHtml(I18n.t('settings.prompt.globalHint'))}</p>
    </div>
    <div class="settings-control">
     <label class="mcp-auto"><input type="checkbox" class="prompt-enabled"${data.enabled ? ' checked' : ''}>${escapeHtml(I18n.t('settings.prompt.enabled'))}</label>
     <textarea class="settings-key prompt-global" rows="5" spellcheck="true" placeholder="${escapeHtml(I18n.t('settings.prompt.placeholder'))}">${escapeHtml(data.global)}</textarea>
    </div>
   </div>
   <div class="settings-row is-wide">
    <div class="settings-text">
     <span class="settings-label">${escapeHtml(I18n.t('settings.prompt.module'))}</span>
     <p class="settings-hint">${escapeHtml(I18n.t('settings.prompt.moduleHint'))}</p>
    </div>
    <div class="settings-control">
     ${models.length ? `<select class="settings-select prompt-model" aria-label="${escapeHtml(I18n.t('settings.prompt.model'))}">${options}</select>
     <textarea class="settings-key prompt-model-text" rows="4" spellcheck="true" placeholder="${escapeHtml(I18n.t('settings.prompt.modelPrompt'))}"></textarea>` : `<p class="settings-hint">${escapeHtml(I18n.t('settings.prompt.empty'))}</p>`}
    </div>
   </div>
   <div class="settings-row is-wide">
    <div class="settings-text">
     <span class="settings-label">${escapeHtml(I18n.t('settings.prompt.builtin'))}</span>
     <p class="settings-hint">${escapeHtml(I18n.t('settings.prompt.builtinHint'))}</p>
    </div>
    <div class="settings-control">
     <details class="prompt-builtin">
      <summary>${escapeHtml(I18n.t('settings.prompt.builtinAgent'))}</summary>
      <pre class="prompt-pre">${escapeHtml(window.AgentPrompt?.template || '')}</pre>
     </details>
     ${window.PrismFormat?.guide ? `<details class="prompt-builtin">
      <summary>${escapeHtml(I18n.t('settings.prompt.builtinFormat'))}</summary>
      <pre class="prompt-pre">${escapeHtml(window.PrismFormat.guide)}</pre>
     </details>` : ''}
    </div>
   </div>
   <p class="settings-status" data-provider="prompt" role="status"></p>`;
  const flush = async (patch = {}) => {
   const current = await window.Prompts.load();
   const next = await window.Prompts.save({ ...current, ...patch });
   this.setStatus('prompt', I18n.t('settings.prompt.saved'));
   return next;
  };
  const enabled = node.querySelector('.prompt-enabled');
  const global = node.querySelector('.prompt-global');
  const select = node.querySelector('.prompt-model');
  const modelText = node.querySelector('.prompt-model-text');
  let timer = 0;
  const queue = run => {
   clearTimeout(timer);
   timer = setTimeout(() => Promise.resolve().then(run).catch(() => {}), 350);
  };
  global?.addEventListener('input', () => queue(() => flush({ global: global.value })));
  enabled?.addEventListener('change', () => queue(() => flush({ enabled: enabled.checked })));
  let shown = select?.value || '';
  const showModel = () => { if (modelText) modelText.value = data.models?.[shown] || ''; };
  const commitModel = async () => {
   const current = await window.Prompts.load();
   const models = { ...(current.models || {}) };
   const value = (modelText?.value || '').trim();
   if (value) models[shown] = modelText.value;
   else delete models[shown];
   await window.Prompts.save({ ...current, models });
   data.models = models;
   this.setStatus('prompt', I18n.t('settings.prompt.saved'));
  };
  select?.addEventListener('change', async () => {
   clearTimeout(timer);
   await commitModel();
   shown = select.value;
   showModel();
  });
  modelText?.addEventListener('input', () => queue(commitModel));
  showModel();
 }

 async paintMemory() {  const node = this.dialog.querySelector('.settings-memory-page');
  if (!node || !window.openghost?.memory) return;
  let memories = [];
  try { memories = (await window.openghost.memory.list()) || []; } catch {}
  // Oldest first: a memory the user adds here lands at the bottom of the list.
  memories.sort((a, b) => (a.created || 0) - (b.created || 0));
  // The field stays pinned at the top of the page, so adding one more never needs a scroll.
  node.innerHTML = `<div class="memory-add-row">
   <input class="settings-key memory-input" placeholder="${escapeHtml(I18n.t('settings.memory.placeholder'))}" spellcheck="false">
   <button type="button" class="settings-button is-primary" data-memory-add>${escapeHtml(I18n.t('settings.memory.add'))}</button>
  </div>
  <p class="settings-status" data-provider="memory" role="status"></p>
  <div class="memory-list">${memories.length
   ? memories.map(item => `<div class="memory-row" data-id="${escapeHtml(item.id)}">
      <div class="memory-body">
       <div class="memory-text">${escapeHtml(item.text)}</div>
       <div class="memory-when">${escapeHtml(item.id)} · ${new Date(item.created || Date.now()).toLocaleDateString()}</div>
      </div>
      <button type="button" class="settings-button memory-remove" title="${escapeHtml(I18n.t('settings.memory.remove'))}">${escapeHtml(I18n.t('settings.memory.remove'))}</button>
     </div>`).join('')
   : `<div class="settings-mcp-empty">${escapeHtml(I18n.t('settings.memory.empty'))}</div>`}</div>`;
  const add = async () => {
   const input = node.querySelector('.memory-input');
   const text = input?.value.trim();
   if (!text) return;
   await window.openghost?.memory?.add(text);
   await this.paintMemory();
   this.dialog.querySelector('.settings-memory-page .memory-input')?.focus();
  };
  node.querySelector('[data-memory-add]')?.addEventListener('click', add);
  node.querySelector('.memory-input')?.addEventListener('keydown', event => {
   if (event.key === 'Enter') add();
  });
  for (const row of node.querySelectorAll('.memory-row')) {
   row.querySelector('.memory-remove')?.addEventListener('click', async () => {
    await window.openghost?.memory?.remove(row.dataset.id);
    await this.paintMemory();
   });
  }
 }

 async paintAbout() {
  const node = this.dialog.querySelector('.settings-about-page');
  if (!node) return;
  let version = '';
  try { version = (await window.openghost?.app?.version?.()) || ''; } catch {}
  // Only the desktop app can fetch and run an installer; the web build just shows itself.
  const updatable = Boolean(window.openghost?.desktop && window.openghost?.update?.check);
  let auto = true;
  try { auto = ((await window.openghost?.store?.read?.('update')) || {})?.auto !== false; } catch {}
  node.innerHTML = `
   <div class="about-hero">
    <span class="about-logo">${Glyphs.ghost}</span>
    <span class="about-title">
     <span class="about-name">Prism V2${version ? `<span class="about-version">${escapeHtml(version)}</span>` : ''}</span>
     <p class="settings-hint">${escapeHtml(I18n.t('settings.about.line'))}</p>
    </span>
   </div>
   ${updatable ? `<div class="settings-row about-row">
    <div class="settings-text">
     <span class="settings-label">${escapeHtml(I18n.t('settings.about.updates'))}</span>
     <p class="settings-hint">${escapeHtml(I18n.t('settings.about.updatesHint'))}</p>
    </div>
    <div class="settings-control">
     <label class="mcp-auto"><input type="checkbox" class="about-auto"${auto ? ' checked' : ''}>${escapeHtml(I18n.t('settings.about.auto'))}</label>
     <button type="button" class="settings-button is-primary" data-about-check>${escapeHtml(I18n.t('settings.about.check'))}</button>
    </div>
   </div>` : ''}
   <div class="settings-row about-row">
    <div class="settings-text">
     <span class="settings-label">${escapeHtml(I18n.t('settings.about.repo'))}</span>
     <p class="settings-hint">${escapeHtml(I18n.t('settings.about.repoHint'))}</p>
    </div>
    <div class="settings-control">
     <a class="settings-button" href="https://github.com/vzlany/Prism-V2" target="_blank" rel="noopener noreferrer">github.com/vzlany/Prism-V2</a>
    </div>
   </div>
   <p class="settings-hint about-fine">${escapeHtml(I18n.t('settings.about.notice'))}</p>
   <p class="settings-status" data-provider="about" role="status"></p>`;
  node.querySelector('[data-about-check]')?.addEventListener('click', async () => {
   this.setStatus('about', I18n.t('settings.about.checking'));
   const result = await window.openghost.update.check().catch(() => null);
   if (result?.version) this.setStatus('about', I18n.t('settings.about.found', { version: result.version }));
   else if (result?.latest) this.setStatus('about', I18n.t('settings.about.latest', { version }));
   else this.setStatus('about', I18n.t('settings.about.failed'), 'error');
  });
  node.querySelector('.about-auto')?.addEventListener('change', async event => {
   const on = event.target.checked;
   try { await window.openghost?.store?.write?.('update', { version: 1, auto: on }); } catch {}
   this.setStatus('about', I18n.t(on ? 'settings.about.autoOn' : 'settings.about.autoOff'));
  });
 }

 async paintEffects() {
  const node = this.dialog.querySelector('.settings-effects-page');
  if (!node) return;
  const choice = (group, current, values, labels) => `<div class="effects-choice">${values.map(value => `<button type="button" class="settings-button${value === current ? ' is-primary' : ''}" data-effect-group="${group}" data-effect-value="${value}">${escapeHtml(labels[value])}</button>`).join('')}</div>`;
  const row = (labelKey, hintKey, choiceHtml) => `<div class="settings-row">
   <div class="settings-text">
    <span class="settings-label">${escapeHtml(I18n.t(labelKey))}</span>
    <p class="settings-hint">${escapeHtml(I18n.t(hintKey))}</p>
   </div>
   <div class="settings-control">${choiceHtml}</div>
  </div>`;
  const viewLabels = { auto: I18n.t('settings.effects.auto'), open: I18n.t('settings.effects.open'), closed: I18n.t('settings.effects.closed') };
  const thinkingLabels = { auto: I18n.t('settings.effects.auto'), extended: I18n.t('settings.effects.extended') };
  const typingLabels = { both: I18n.t('settings.effects.both'), deleting: I18n.t('settings.effects.deleting') };
  const effects = window.Effects;
let profile = { name: 'default', profiles: ['default'] };
  try { profile = (await window.openghost?.profile?.info?.()) || profile; } catch {}
  const profileBlock = `<div class="settings-row is-wide">
   <div class="settings-text">
    <span class="settings-label">${escapeHtml(I18n.t('settings.profile.title'))}</span>
    <p class="settings-hint">${escapeHtml(I18n.t('settings.profile.hint'))}</p>
   </div>
   <div class="settings-control">
    <div class="mcp-add-row">
     <select class="profile-select">${profile.profiles.map(name => `<option value="${escapeHtml(name)}"${name === profile.name ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select>
     <input class="settings-key profile-input" placeholder="${escapeHtml(I18n.t('settings.profile.new'))}" spellcheck="false" autocomplete="off">
     <button type="button" class="settings-button is-primary" data-profile-switch>${escapeHtml(I18n.t('settings.profile.switch'))}</button>
    </div>
    <p class="settings-status" data-provider="profile" role="status"></p>
   </div>
  </div>`;
  let discord = { enabled: false, hasToken: false, userId: '' };
  try { discord = (await window.openghost?.discord?.get?.()) || discord; } catch {}
  const discordBlock = `<div class="settings-row is-wide">
   <div class="settings-text">
    <span class="settings-label">${escapeHtml(I18n.t('settings.discord.title'))}</span>
    <p class="settings-hint">${escapeHtml(I18n.t('settings.discord.hint'))}</p>
   </div>
   <div class="settings-control">
    <div class="mcp-add-row">
     <input class="settings-key discord-token" type="password" placeholder="${escapeHtml(discord.hasToken ? I18n.t('settings.discord.tokenSaved') : I18n.t('settings.discord.token'))}" autocomplete="off" spellcheck="false">
     <input class="settings-key discord-user" value="${escapeHtml(discord.userId)}" placeholder="${escapeHtml(I18n.t('settings.discord.user'))}" spellcheck="false">
    </div>
    <div class="mcp-add-row" style="margin-top:6px">
     <label class="mcp-auto"><input type="checkbox" class="discord-enabled" ${discord.enabled ? 'checked' : ''}>${escapeHtml(I18n.t('settings.discord.enable'))}</label>
     <button type="button" class="settings-button is-primary" data-discord-save>${escapeHtml(I18n.t('settings.discord.save'))}</button>
     <button type="button" class="settings-button" data-discord-test>${escapeHtml(I18n.t('settings.discord.test'))}</button>
    </div>
    <p class="settings-status" data-provider="discord" role="status"></p>
   </div>
  </div>`;
  // Sounds: the chimes OpenCode ships, for a finished task, a waiting question and an error.
  const sounds = window.Sounds?.settings || { on: true, finishOn: true, finish: 'staplebops-01', questionOn: true, question: 'staplebops-02', errorOn: true, error: 'nope-03' };
  const soundOptions = selected => (window.Sounds?.options || []).map(id => `<option value="${id}"${id === selected ? ' selected' : ''}>${id}</option>`).join('');
  const soundRow = (kind, labelKey, hintKey, on, selected) => `<div class="settings-row">
    <div class="settings-text">
     <span class="settings-label">${escapeHtml(I18n.t(labelKey))}</span>
     <p class="settings-hint">${escapeHtml(I18n.t(hintKey))}</p>
    </div>
    <div class="settings-control">
     <div class="effects-choice">
      <button type="button" class="settings-button${on ? ' is-primary' : ''}" data-sound-toggle="${kind}" data-sound-on="1">${escapeHtml(I18n.t('settings.sounds.on'))}</button>
      <button type="button" class="settings-button${on ? '' : ' is-primary'}" data-sound-toggle="${kind}" data-sound-on="">${escapeHtml(I18n.t('settings.sounds.off'))}</button>
     </div>
     <div class="mcp-add-row sound-pick">
      <select class="settings-select" data-sound-kind="${kind}" aria-label="${escapeHtml(I18n.t(labelKey))}">${soundOptions(selected)}</select>
      <button type="button" class="settings-button" data-sound-preview="${kind}">${escapeHtml(I18n.t('settings.sounds.play'))}</button>
     </div>
    </div>
   </div>`;
  const soundsBlock = `${row('settings.sounds.title', 'settings.sounds.hint', `<div class="effects-choice"><button type="button" class="settings-button${sounds.on ? ' is-primary' : ''}" data-sound-master="1">${escapeHtml(I18n.t('settings.sounds.on'))}</button><button type="button" class="settings-button${sounds.on ? '' : ' is-primary'}" data-sound-master="">${escapeHtml(I18n.t('settings.sounds.off'))}</button></div>`)}
   ${soundRow('finish', 'settings.sounds.finish', 'settings.sounds.finishHint', sounds.finishOn, sounds.finish)}
   ${soundRow('question', 'settings.sounds.question', 'settings.sounds.questionHint', sounds.questionOn, sounds.question)}
   ${soundRow('error', 'settings.sounds.error', 'settings.sounds.errorHint', sounds.errorOn, sounds.error)}`;
  node.innerHTML = [
   profileBlock,
   discordBlock,
   row('settings.effects.title', 'settings.effects.hint', choice('text', effects ? effects.mode : 'both', ['both', 'deleting'], typingLabels)),
   row('settings.effects.thinking', 'settings.effects.thinkingHint', choice('thinking', effects ? effects.thinkingMode : 'auto', ['auto', 'extended'], thinkingLabels)),
   row('settings.effects.tools', 'settings.effects.toolsHint', choice('tools', effects ? effects.toolsMode : 'auto', ['auto', 'open', 'closed'], viewLabels)),
   soundsBlock,
  ].join('');
  node.querySelector('[data-discord-save]')?.addEventListener('click', async () => {
   const token = node.querySelector('.discord-token')?.value.trim();
   const userId = node.querySelector('.discord-user')?.value.trim() ?? '';
   const enabled = !!node.querySelector('.discord-enabled')?.checked;
   await window.openghost?.discord?.set?.({ ...(token ? { token } : {}), userId, enabled });
   this.setStatus('discord', I18n.t('settings.discord.saved'));
   this.paintEffects();
  });
  node.querySelector('[data-discord-test]')?.addEventListener('click', async () => {
   this.setStatus('discord', I18n.t('settings.discord.testing'));
   const result = await window.openghost?.discord?.test?.();
   this.setStatus('discord', result?.ok ? I18n.t('settings.discord.ok') : `${I18n.t('settings.discord.fail')} ${result?.error || ''}`, result?.ok ? '' : 'error');
  });
  node.querySelector('[data-profile-switch]')?.addEventListener('click', () => {
   const typed = node.querySelector('.profile-input')?.value.trim().toLowerCase();
   const name = typed || node.querySelector('.profile-select')?.value || 'default';
   if (name !== 'default' && !/^[a-z0-9-]{1,24}$/.test(name)) {
    this.setStatus('profile', I18n.t('settings.profile.bad'), 'error');
    return;
   }
   if (name === profile.name) {
    this.setStatus('profile', I18n.t('settings.profile.current'));
    return;
   }
   this.setStatus('profile', I18n.t('settings.profile.switching', { name }));
   window.openghost?.profile?.switch?.(name);
  });
for (const button of node.querySelectorAll('[data-effect-group]')) {
   button.addEventListener('click', () => {
    const { effectGroup, effectValue } = button.dataset;
    if (effectGroup === 'text') window.Effects?.set(effectValue);
    else if (effectGroup === 'thinking') window.Effects?.setThinking(effectValue);
    else if (effectGroup === 'tools') window.Effects?.setTools(effectValue);
    this.paintEffects();
   });
  }
  for (const button of node.querySelectorAll('[data-sound-master]')) {
   button.addEventListener('click', () => {
    window.Sounds?.set({ on: button.dataset.soundMaster === '1' });
    this.paintEffects();
   });
  }
  for (const button of node.querySelectorAll('[data-sound-toggle]')) {
   button.addEventListener('click', () => {
    const kind = button.dataset.soundToggle, on = button.dataset.soundOn === '1';
    window.Sounds?.set({ [`${kind}On`]: on });
    if (on) window.Sounds?.preview(node.querySelector(`[data-sound-kind="${kind}"]`)?.value || window.Sounds?.settings?.[kind]);
    this.paintEffects();
   });
  }
  for (const select of node.querySelectorAll('[data-sound-kind]')) {
   select.addEventListener('change', () => {
    const kind = select.dataset.soundKind;
    window.Sounds?.set({ [kind]: select.value });
    window.Sounds?.preview(select.value);
   });
  }
  for (const button of node.querySelectorAll('[data-sound-preview]')) {
   button.addEventListener('click', () => {
    const kind = button.dataset.soundPreview;
    const select = node.querySelector(`[data-sound-kind="${kind}"]`);
    window.Sounds?.preview(select?.value || window.Sounds?.settings?.[kind]);
   });
  }
 }

 async paintMcp() {
  const node = this.mcpPage;
  if (!node || !window.openghost?.mcp) return;
  const [data, tools] = await Promise.all([
   window.openghost.mcp.servers().catch(() => ({ servers: [] })),
   window.openghost.mcp.tools().catch(() => []),
  ]);
  const counts = {};
  for (const tool of tools) counts[tool.server] = (counts[tool.server] || 0) + 1;
  const cards = (data.servers || []).map(server => {
   const def = server.def || {};
   const tone = server.state === 'ready' ? 'is-on' : server.state === 'failed' ? 'is-bad' : '';
   const text = server.state === 'ready' ? I18n.t('settings.mcp.ready', { count: counts[server.id] ?? server.tools ?? 0 }) : I18n.t(`settings.mcp.${server.state}`);
   const target = def.type === 'remote' || def.url ? def.url || '' : (def.command || []).join(' ');
   return `<div class="mcp-card" data-id="${escapeHtml(server.id)}">
    <div class="mcp-card-head">
     <span class="mcp-card-name">${escapeHtml(server.id)}</span>
     <span class="settings-mcp-state ${tone}">${escapeHtml(text)}</span>
     <label class="mcp-auto"><input type="checkbox" data-mcp-auto ${def.autoApprove ? 'checked' : ''}>${escapeHtml(I18n.t('settings.mcp.auto'))}</label>
     <button type="button" class="settings-button" data-mcp-remove>${escapeHtml(I18n.t('settings.mcp.remove'))}</button>
    </div>
    <div class="mcp-card-detail" title="${escapeHtml(target)}">${escapeHtml(target)}</div>
    ${server.error ? `<div class="mcp-card-error">${escapeHtml(server.error)}</div>` : ''}
   </div>`;
  }).join('');
  node.innerHTML = `
   <div class="mcp-list">${cards || `<div class="settings-mcp-empty">${escapeHtml(I18n.t('settings.mcp.none'))}</div>`}</div>
   <div class="mcp-add">
    <div class="mcp-add-title">${escapeHtml(I18n.t('settings.mcp.addTitle'))}</div>
    <div class="mcp-add-row">
     <input class="settings-key mcp-add-name" placeholder="${escapeHtml(I18n.t('settings.mcp.namePlaceholder'))}" spellcheck="false" autocomplete="off">
     <select class="mcp-add-type"><option value="local">local</option><option value="remote">remote</option></select>
     <label class="mcp-auto"><input type="checkbox" class="mcp-add-auto">${escapeHtml(I18n.t('settings.mcp.auto'))}</label>
    </div>
    <div class="mcp-add-row">
     <input class="settings-key mcp-add-target" placeholder="${escapeHtml(I18n.t('settings.mcp.targetPlaceholder'))}" spellcheck="false" autocomplete="off">
     <button type="button" class="settings-button is-primary" data-mcp-add>${escapeHtml(I18n.t('settings.mcp.add'))}</button>
    </div>
    <div class="mcp-add-hint">${escapeHtml(I18n.t('settings.mcp.addHint'))} <a href="#" class="settings-mcp-open">${escapeHtml(I18n.t('settings.mcp.open'))}</a></div>
    <div class="mcp-status" role="status"></div>
   </div>`;
  for (const card of node.querySelectorAll('.mcp-card')) {
   const id = card.dataset.id;
   card.querySelector('[data-mcp-remove]')?.addEventListener('click', () => this.removeMcpServer(id));
   card.querySelector('[data-mcp-auto]')?.addEventListener('change', event => this.saveMcpServer(id, { autoApprove: event.target.checked }));
  }
  node.querySelector('[data-mcp-add]')?.addEventListener('click', () => this.addMcpServer());
  node.querySelector('.settings-mcp-open')?.addEventListener('click', event => { event.preventDefault(); window.openghost?.mcp?.openConfig(); });
 }

 async addMcpServer() {
  const node = this.mcpPage;
  if (!node || !window.openghost?.mcp) return;
  const name = node.querySelector('.mcp-add-name')?.value.trim();
  const type = node.querySelector('.mcp-add-type')?.value || 'local';
  const target = node.querySelector('.mcp-add-target')?.value.trim();
  const autoApprove = !!node.querySelector('.mcp-add-auto')?.checked;
  if (!name) return this.mcpNote(I18n.t('settings.mcp.needName'), 'error');
  if (!target) return this.mcpNote(I18n.t('settings.mcp.needTarget'), 'error');
  this.mcpNote(I18n.t('settings.mcp.startingNew'));
  try {
   await window.openghost.mcp.save(name, type === 'remote' ? { type: 'remote', url: target, autoApprove } : { type: 'local', command: target, autoApprove });
   await this.paintMcp();
   window.AgentTools?.refreshMcp?.();
   this.mcpNote('');
  } catch (error) {
   this.mcpNote(String(error?.message || error), 'error');
  }
 }

 async saveMcpServer(id, patch) {
  try {
   await window.openghost.mcp.save(id, patch);
   await this.paintMcp();
   window.AgentTools?.refreshMcp?.();
  } catch (error) {
   this.mcpNote(String(error?.message || error), 'error');
  }
 }

 async removeMcpServer(id) {
  try {
   await window.openghost.mcp.remove(id);
   await this.paintMcp();
   window.AgentTools?.refreshMcp?.();
  } catch (error) {
   this.mcpNote(String(error?.message || error), 'error');
  }
 }

 async reloadMcp() {
  if (!window.openghost?.mcp) return;
  this.mcpNote(I18n.t('settings.mcp.checking'));
  try {
   await window.openghost.mcp.reload();
   await this.paintMcp();
   window.AgentTools?.refreshMcp?.();
   this.mcpNote('');
  } catch (error) {
   this.mcpNote(String(error?.message || error), 'error');
  }
 }

 setAccount(account) {
  const was = this.account.connected;
  this.account = { connected: !!account?.connected, email: account?.email || '', plan: account?.plan || '' };
  if (account?.error) this.setStatus('chatgpt', account.error, 'error');
  if (this.account.connected && !this.catalog.chatgpt.length) this.refresh('chatgpt').catch(() => {});
  if (was !== this.account.connected) this.changed();
  else this.paint();
 }

 async login() {
  const auth = window.openghost?.auth;
  if (!auth || this.account.waiting) return;
  this.setStatus('chatgpt', '');
  this.account = { ...this.account, waiting: true };
  this.paint();
  const account = await auth.login();
  this.setAccount(account);
  // The badge turning green and the account line say it all; a "signed in" line under them would only repeat it.
  if (account?.connected) await this.refresh('chatgpt').catch(() => {});
 }

 async logout() {
  const auth = window.openghost?.auth;
  if (!auth) return;
  this.setAccount(await auth.logout());
  this.setStatus('chatgpt', '');
 }

 open(reason = '', provider = '') {
  if (!this.dialog.open) {
   this.dialog.showModal();
   this.dialog.focus();
   this.syncAccount();
   this.paintMcp();
  }
  if (reason) {
   const target = provider || 'deepseek';
   this.setStatus(target, reason, 'error');
   const field = target === 'chatgpt' ? this.accountBox.querySelector('[data-action="login"]') : this.inputs[target];
   field?.scrollIntoView({ block: 'center' });
   field?.focus();
   return;
  }
  for (const provider of Object.keys(KEYS)) {
   if (this.keys[provider] && !this.checked.has(provider)) this.checkKey(provider);
  }
 }

 // A working key shows only in the badge; the line under the field is for the check in progress and for what went wrong.
 async checkKey(provider) {
  const key = this.keys[provider];
  this.setStatus(provider, I18n.t('settings.key.checking'));
  try {
   const current = await this.refresh(provider);
   if (!current || key !== this.keys[provider]) return;
   this.accepted.add(provider);
   this.checked.add(provider);
   this.setStatus(provider, '');
  } catch (error) {
   if (key !== this.keys[provider]) return;
   this.accepted.delete(provider);
   this.setStatus(provider, error.message, 'error');
  }
  this.paint();
 }

 setStatus(provider, text, tone = '') {
  const node = this.statuses?.[provider];
  if (!node) return;
  node.textContent = text;
  node.dataset.tone = tone;
 }
}

window.Settings = Settings;
})();
