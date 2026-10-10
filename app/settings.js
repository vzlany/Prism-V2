(() => {
'use strict';

const STORAGE = { effort: 'deepseek.effort', mode: 'openghost.mode', model: 'openghost.model', catalog: 'openghost.catalog', catalogAt: 'openghost.catalogAt', apis: 'openghost.apis', apiActive: 'openghost.apiActive' };
const KEYS = { openai: 'openai.apiKey', anthropic: 'anthropic.apiKey', deepseek: 'deepseek.apiKey', 'opencode-go': 'opencode-go.apiKey' };
// The order providers appear in, in the settings and in the model picker.
const ORDER = ['opencode-go', 'opencode', 'chatgpt', 'openai', 'anthropic', 'deepseek'];
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
  // A second, delayed mirror: if the first read happened before storage was ready, this one
  // fills the bot's copy as soon as the keys are readable.
  setTimeout(() => this.syncSharedKeys(), 5000);
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
 // equipped keys are mirrored into the shared store; the bridge reads them from there. The
 // keys are re-read from storage here, and an empty set is never written: a renderer that
 // came up before its storage did must not wipe the bot's copy of the keys.
 syncSharedKeys() {
  if (!window.openghost?.store?.write) return;
  const apis = this.readApis();
  const active = this.readActive();
  const keys = {};
  for (const provider of Object.keys(KEYS)) {
   const list = apis[provider] || [];
   const entry = list.find(item => item.id === active[provider]) || list[0];
   if (entry?.key) keys[provider] = entry.key;
  }
  if (!Object.keys(keys).length) return;
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
  return { chatgpt: [], openai: [], anthropic: [], 'opencode-go': [], opencode: [], ...saved, deepseek: saved.deepseek?.length ? saved.deepseek : KNOWN_DEEPSEEK.slice() };
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
  // Only OpenCode Zen's Free tier is offered, and those models take no key: always connected.
  if (provider === 'opencode') return true;
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
  this.serverPage = this.dialog.querySelector('.settings-server-page');
  this.tabs = [...this.dialog.querySelectorAll('.settings-tab')];
  // The Auto and Server pages are about this desktop install: a browser has nothing to set there.
  if (!window.openghost?.desktop) {
   for (const name of ['auto', 'server']) {
    const tab = this.dialog.querySelector(`.settings-tab[data-tab="${name}"]`);
    if (tab) tab.hidden = true;
   }
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
  if (name === 'skills') this.paintSkills();
  if (name === 'discord') this.paintDiscord();
  if (name === 'effects') this.paintEffects();
  if (name === 'memory') this.paintMemory();
  if (name === 'auto') this.paintAuto();
  if (name === 'server') this.paintServer();
  else if (name !== 'auto') { clearInterval(this.autoTimer); this.autoTimer = 0; }
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
   row('settings.auto.awake', 'settings.auto.awakeHint', toggle('auto-awake', auto.awake !== false)),
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
  node.querySelector('.auto-awake')?.addEventListener('change', event => save({ awake: event.target.checked }));
  node.querySelector('.auto-port')?.addEventListener('change', event => save({ port: Number(event.target.value) || 8787 }));
  node.querySelector('[data-auto-open]')?.addEventListener('click', () => window.open(`http://localhost:${auto.port}/`, '_blank'));
 }

  // Settings -> Server: where this app runs (this machine or the Debian server), the one
  // switch that turns it into a server (autostart, hidden, web, bot), the root password sudo
  // uses on Linux, and the commands that install and run it on Debian.
  async paintServer() {
   const node = this.serverPage;
   if (!node) return;
   const host = window.openghost?.platform || 'win32';
   const info = (await window.openghost?.server?.get?.().catch(() => null)) || { platform: 'auto', sudo: '', os: host, chosen: host, version: '', autostart: '', sudoReady: false };
   const auto = (await window.openghost?.auto?.get?.().catch(() => null)) || { login: false, hidden: false, web: false, bot: false, port: 8787 };
   const row = (labelKey, hintKey, control) => `<div class="settings-row is-wide">
    <div class="settings-text">
     <span class="settings-label">${escapeHtml(I18n.t(labelKey))}</span>
     <p class="settings-hint">${escapeHtml(I18n.t(hintKey))}</p>
    </div>
    <div class="settings-control">${control}</div>
   </div>`;
   const toggle = (cls, on, label) => `<label class="mcp-auto"><input type="checkbox" class="${cls}" ${on ? 'checked' : ''}>${escapeHtml(label)}</label>`;
   const osName = value => value === 'win32' ? 'Windows' : value === 'linux' ? 'Linux' : String(value || '?');
   const chosen = info.chosen || host;
   const version = String(info.version || '');
   const repo = 'vzlany/Prism-V2';
   const asset = `Prism-V2-${version}-linux.tar.gz`;
   const port = auto.port || 8787;
   const download = [
    'curl -fL -H "Authorization: token $GH_TOKEN" \\',
    `  -o prism.tar.gz https://github.com/${repo}/releases/download/v${version}/${asset}`,
    'mkdir -p ~/prism-v2 && tar -xzf prism.tar.gz -C ~/prism-v2 --strip-components=1',
   ].join('\n');
   const headless = [
    '# headless: web UI + Discord bot in one process (Node 20+)',
    'cd ~/prism-v2/resources/app',
    `node tools/server.mjs --host 0.0.0.0 --port ${port}`,
   ].join('\n');
   const desktop = [
    '# or the desktop app with its tray (needs a desktop session)',
    'cd ~/prism-v2 && ./prism-v2 --hidden',
   ].join('\n');
   const block = (id, text) => `<pre class="prompt-pre server-cmd" id="server-cmd-${id}">${escapeHtml(text)}</pre>
    <button type="button" class="settings-button server-copy" data-copy="${id}">${escapeHtml(I18n.t('settings.server.copy'))}</button>`;
   node.innerHTML = [
    row('settings.server.machine', 'settings.server.machineHint', `<div class="auto-server"><span class="is-on">${escapeHtml(osName(info.os))}${version ? ` · v${escapeHtml(version)}` : ''}</span>${chosen !== info.os ? `<span class="server-other">${escapeHtml(I18n.t('settings.server.elsewhere', { system: osName(chosen) }))}</span>` : ''}</div>`),
    row('settings.server.where', 'settings.server.whereHint', `<select class="settings-select server-platform" aria-label="${escapeHtml(I18n.t('settings.server.where'))}">
      <option value="auto" ${info.platform === 'auto' ? 'selected' : ''}>${escapeHtml(I18n.t('settings.server.auto'))}</option>
      <option value="windows" ${info.platform === 'windows' ? 'selected' : ''}>Windows</option>
      <option value="linux" ${info.platform === 'linux' ? 'selected' : ''}>Linux (Debian)</option>
     </select>`),
    row('settings.server.mode', 'settings.server.modeHint', `<div class="mcp-add-row server-toggles">
      ${toggle('server-login', auto.login, I18n.t('settings.auto.login'))}
      ${toggle('server-hidden', auto.hidden, I18n.t('settings.auto.hidden'))}
      ${toggle('server-web', auto.web, I18n.t('settings.auto.web'))}
      ${toggle('server-bot', auto.bot, I18n.t('settings.auto.bot'))}
      <button type="button" class="settings-button server-all">${escapeHtml(I18n.t('settings.server.enableAll'))}</button>
     </div>`),
    row('settings.server.sudo', 'settings.server.sudoHint', `<div class="mcp-add-row">
      <input class="settings-key server-sudo" type="password" value="${escapeHtml(info.sudo)}" autocomplete="off" spellcheck="false" placeholder="••••••">
      <button type="button" class="settings-button server-sudo-save">${escapeHtml(I18n.t('settings.server.sudoSave'))}</button>
      <button type="button" class="settings-button server-sudo-clear">${escapeHtml(I18n.t('settings.server.sudoClear'))}</button>
     </div>`),
    chosen === 'linux'
     ? `<div class="settings-row is-wide">
      <div class="settings-text">
       <span class="settings-label">${escapeHtml(I18n.t('settings.server.install'))}</span>
       <p class="settings-hint">${escapeHtml(I18n.t('settings.server.installHint', { version }))}</p>
      </div>
      <div class="settings-control">
       ${block('download', download)}
       ${block('headless', headless)}
       ${block('desktop', desktop)}
      </div>
     </div>`
     : '',
    `<p class="settings-status" role="status" data-server-status></p>`,
   ].join('');
   const status = node.querySelector('[data-server-status]');
   const say = (text, tone = '') => { status.textContent = text; status.dataset.tone = tone; };
   const saveAuto = async patch => {
    const next = await window.openghost?.auto?.set?.(patch).catch(() => null);
    if (next) { say(I18n.t('settings.server.saved')); this.paintServer(); }
   };
   node.querySelector('.server-platform')?.addEventListener('change', async event => {
    const next = await window.openghost?.server?.set?.({ platform: event.target.value }).catch(() => null);
    if (next) { say(I18n.t('settings.server.saved')); this.paintServer(); }
   });
   node.querySelector('.server-login')?.addEventListener('change', event => saveAuto({ login: event.target.checked }));
   node.querySelector('.server-hidden')?.addEventListener('change', event => saveAuto({ hidden: event.target.checked }));
   node.querySelector('.server-web')?.addEventListener('change', event => saveAuto({ web: event.target.checked }));
   node.querySelector('.server-bot')?.addEventListener('change', event => saveAuto({ bot: event.target.checked }));
   node.querySelector('.server-all')?.addEventListener('click', () => saveAuto({ login: true, hidden: true, web: true, bot: true }));
   node.querySelector('.server-sudo-save')?.addEventListener('click', async () => {
    const value = node.querySelector('.server-sudo')?.value || '';
    const next = await window.openghost?.server?.set?.({ sudo: value }).catch(() => null);
    say(next ? I18n.t(next.sudoReady ? 'settings.server.sudoSaved' : 'settings.server.sudoCleared') : I18n.t('settings.server.sudoFailed'), next ? '' : 'error');
   });
   node.querySelector('.server-sudo-clear')?.addEventListener('click', async () => {
    const next = await window.openghost?.server?.set?.({ sudo: '' }).catch(() => null);
    const field = node.querySelector('.server-sudo');
    if (field) field.value = '';
    say(next ? I18n.t('settings.server.sudoCleared') : I18n.t('settings.server.sudoFailed'), next ? '' : 'error');
   });
   for (const button of node.querySelectorAll('.server-copy')) {
    button.addEventListener('click', () => {
     const text = node.querySelector(`#server-cmd-${button.dataset.copy}`)?.textContent || '';
     window.Clip?.text?.(text);
     const was = button.textContent;
     button.textContent = I18n.t('settings.server.copied');
     setTimeout(() => { button.textContent = was; }, 1500);
    });
   }
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
     ${window.AgentPromptV1?.template ? `<details class="prompt-builtin">
      <summary>${escapeHtml(I18n.t('settings.prompt.builtinV1'))}</summary>
      <p class="settings-hint">${escapeHtml(I18n.t('settings.prompt.builtinV1Hint'))}</p>
      <pre class="prompt-pre">${escapeHtml(window.AgentPromptV1.template)}</pre>
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

 // Settings -> Skills: install Claude-style SKILL.md folders from a GitHub repository.
 async paintSkills() {
  const node = this.dialog.querySelector('.settings-skills-page');
  if (!node) return;
  let skills = [];
  try { skills = (await window.openghost?.skills?.list?.()) || []; } catch {}
  node.innerHTML = `
   <div class="settings-row is-wide">
    <div class="settings-text">
     <span class="settings-label">${escapeHtml(I18n.t('settings.skills.installButton'))}</span>
     <p class="settings-hint">${escapeHtml(I18n.t('settings.skills.installHint'))}</p>
    </div>
    <div class="settings-control">
     <div class="mcp-add-row">
      <input class="settings-key skills-url" placeholder="${escapeHtml(I18n.t('settings.skills.url'))}" spellcheck="false" autocomplete="off">
      <button type="button" class="settings-button is-primary" data-skills-install>${escapeHtml(I18n.t('settings.skills.installButton'))}</button>
     </div>
     <div class="skills-log" data-skills-log role="status"></div>
    </div>
   </div>
   <div class="settings-row is-wide">
    <div class="settings-text">
     <span class="settings-label">${escapeHtml(I18n.t('settings.skills.list'))}</span>
    </div>
    <div class="settings-control">
     <div class="skills-list">${skills.length
      ? skills.map(skill => `<div class="skill-row" data-skill="${escapeHtml(skill.path || '')}"><span class="skill-name">${escapeHtml(skill.name)}</span><span class="skill-desc">${escapeHtml(skill.description || '')}</span><button type="button" class="skill-remove" title="${escapeHtml(I18n.t('settings.skills.remove'))}" aria-label="${escapeHtml(I18n.t('settings.skills.remove'))}">&#215;</button></div>`).join('')
      : `<div class="settings-mcp-empty">${escapeHtml(I18n.t('settings.skills.empty'))}</div>`}</div>
    </div>
   </div>`;
  const log = node.querySelector('[data-skills-log]');
  const line = (text, tone = '') => {
   if (!log) return;
   const row = document.createElement('div');
   row.className = `skill-log-line${tone ? ` is-${tone}` : ''}`;
   row.textContent = text;
   log.append(row);
   log.scrollTop = log.scrollHeight;
  };
  this.skillOff?.();
  this.skillOff = window.openghost?.skills?.onProgress?.(data => {
   if (data?.stage === 'loading') line(I18n.t('settings.skills.loadingSkill', { name: data.name }));
   else if (data?.stage === 'loaded') line(I18n.t('settings.skills.loadedSkill', { name: data.name }), 'ok');
   else if (data?.stage === 'backup') line(I18n.t('settings.skills.backupSkill', { name: data.name }), 'ok');
   else if (data?.stage === 'failed') line(String(data.name), 'error');
  });
  const button = node.querySelector('[data-skills-install]');
  const input = node.querySelector('.skills-url');
  button?.addEventListener('click', async () => {
   const url = input?.value.trim();
   if (!url) return;
   button.disabled = true;
   line(I18n.t('settings.skills.loading'));
   const result = await window.openghost?.skills?.install?.(url).catch(() => null);
   button.disabled = false;
   if (result?.ok) {
    if (!result.installed?.length) line(I18n.t('settings.skills.none'), 'error');
    else line(I18n.t('settings.skills.done', { count: result.installed.length }), 'ok');
    setTimeout(() => this.paintSkills(), 700);
   } else {
    line(I18n.t('settings.skills.failed', { error: result?.error || 'unknown error' }), 'error');
   }
  });
  // Every row (built-in or installed) can be taken out: the folder is renamed aside, not
  // deleted, and the list is repainted without it.
  for (const row of node.querySelectorAll('.skill-row')) {
   row.querySelector('.skill-remove')?.addEventListener('click', async () => {
    const target = row.dataset.skill;
    if (!target || row.classList.contains('is-removing')) return;
    row.classList.add('is-removing');
    const result = await (window.openghost?.skills?.remove?.(target) || Promise.resolve(null)).catch(() => null);
    if (result?.ok) {
     line(I18n.t('settings.skills.removed', { name: result.name || '' }), 'ok');
     this.paintSkills();
    } else {
     row.classList.remove('is-removing');
     line(I18n.t('settings.skills.removeFailed', { error: result?.error || 'unknown error' }), 'error');
    }
   });
  }
 }

 // Settings -> Discord: the bot itself, the DM switch, and the conversations it keeps.
 async paintDiscord() {
  const node = this.dialog.querySelector('.settings-discord-page');
  if (!node) return;
  let discord = { enabled: false, hasToken: false, userId: '' };
  try { discord = (await window.openghost?.discord?.get?.()) || discord; } catch {}
  let auto = { bot: false, botRunning: false };
  try { auto = (await window.openghost?.auto?.get?.()) || auto; } catch {}
  const dmOn = await Promise.resolve(window.DiscordNotify?.load?.()).then(data => data?.discord === true).catch(() => false);
  let chats = [];
  try {
   const index = await window.openghost?.store?.read?.('index');
   chats = (index?.chats || []).filter(chat => /discord$/i.test(String(chat.folder || '').replace(/[\\/]+$/, '')));
   chats.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  } catch {}
  const row = (labelKey, hintKey, control) => `<div class="settings-row is-wide">
   <div class="settings-text">
    <span class="settings-label">${escapeHtml(I18n.t(labelKey))}</span>
    <p class="settings-hint">${escapeHtml(I18n.t(hintKey))}</p>
   </div>
   <div class="settings-control">${control}</div>
  </div>`;
  node.innerHTML = [
   row('settings.discord.title', 'settings.discord.hint', `<div class="mcp-add-row">
     <input class="settings-key discord-token" type="password" placeholder="${escapeHtml(discord.hasToken ? I18n.t('settings.discord.tokenSaved') : I18n.t('settings.discord.token'))}" autocomplete="off" spellcheck="false">
     <input class="settings-key discord-user" value="${escapeHtml(discord.userId)}" placeholder="${escapeHtml(I18n.t('settings.discord.user'))}" spellcheck="false">
    </div>
    <div class="mcp-add-row" style="margin-top:6px">
     <label class="mcp-auto"><input type="checkbox" class="discord-enabled" ${discord.enabled ? 'checked' : ''}>${escapeHtml(I18n.t('settings.discord.enable'))}</label>
     <button type="button" class="settings-button is-primary" data-discord-save>${escapeHtml(I18n.t('settings.discord.save'))}</button>
     <button type="button" class="settings-button" data-discord-test>${escapeHtml(I18n.t('settings.discord.test'))}</button>
    </div>
    <p class="settings-status" data-provider="discord" role="status"></p>`),
   row('settings.discord.botTitle', 'settings.discord.botHint', `<div class="mcp-add-row">
     <label class="mcp-auto"><input type="checkbox" class="discord-bot" ${auto.bot ? 'checked' : ''}>${escapeHtml(I18n.t('settings.auto.enable'))}</label>
     <span class="auto-bot-state ${auto.botRunning ? 'is-on' : ''}">${escapeHtml(I18n.t(auto.botRunning ? 'settings.auto.botRunning' : 'settings.auto.botStopped'))}</span>
    </div>`),
   row('settings.discord.notifyTitle', 'settings.discord.notifyHint', `<label class="mcp-auto"><input type="checkbox" class="discord-notify" ${dmOn ? 'checked' : ''}>${escapeHtml(I18n.t('settings.auto.enable'))}</label>`),
   row('settings.discord.chatsTitle', 'settings.discord.chatsHint', chats.length
    ? `<div class="discord-chats">${chats.slice(0, 20).map(chat => `<div class="discord-chat"><span class="discord-chat-name">${escapeHtml(chat.title || I18n.t('chat.new'))}</span><span class="discord-chat-id">${escapeHtml(chat.id)}</span></div>`).join('')}</div>`
    : `<div class="settings-mcp-empty">${escapeHtml(I18n.t('settings.discord.chatsEmpty'))}</div>`),
  ].join('');
  const status = text => {
   const node2 = node.querySelector('.settings-status[data-provider="discord"]');
   if (node2) node2.textContent = text || '';
  };
  node.querySelector('[data-discord-save]')?.addEventListener('click', async () => {
   const token = node.querySelector('.discord-token')?.value.trim();
   const userId = node.querySelector('.discord-user')?.value.trim() ?? '';
   const enabled = !!node.querySelector('.discord-enabled')?.checked;
   await window.openghost?.discord?.set?.({ ...(token ? { token } : {}), userId, enabled });
   status(I18n.t('settings.discord.saved'));
   this.paintDiscord();
  });
  node.querySelector('[data-discord-test]')?.addEventListener('click', async () => {
   status(I18n.t('settings.discord.testing'));
   const result = await window.openghost?.discord?.test?.();
   status(result?.ok ? I18n.t('settings.discord.ok') : `${I18n.t('settings.discord.fail')} ${result?.error || ''}`);
  });
  node.querySelector('.discord-bot')?.addEventListener('change', async event => {
   await window.openghost?.auto?.set?.({ bot: event.target.checked }).catch(() => {});
   setTimeout(() => this.paintDiscord(), 600);
  });
  node.querySelector('.discord-notify')?.addEventListener('change', event => {
   window.DiscordNotify?.save?.({ discord: event.target.checked });
  });
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
  const simpleLabels = { on: I18n.t('settings.sounds.on'), off: I18n.t('settings.sounds.off') };
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
   row('settings.effects.title', 'settings.effects.hint', choice('text', effects ? effects.mode : 'both', ['both', 'deleting'], typingLabels)),
   row('settings.effects.thinking', 'settings.effects.thinkingHint', choice('thinking', effects ? effects.thinkingMode : 'auto', ['auto', 'extended'], thinkingLabels)),
   row('settings.effects.tools', 'settings.effects.toolsHint', choice('tools', effects ? effects.toolsMode : 'auto', ['auto', 'open', 'closed'], viewLabels)),
   row('settings.effects.simple', 'settings.effects.simpleHint', choice('simple', effects?.simple ? 'on' : 'off', ['on', 'off'], simpleLabels)),
   soundsBlock,
  ].join('');
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
    else if (effectGroup === 'simple') window.Effects?.setSimple(effectValue === 'on');
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
