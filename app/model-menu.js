// A plain menu for choosing the model, in the spirit of OpenCode's picker: a search box, the
// models grouped by provider with their own little logos, the context window, a Free chip and
// a check on the one in use. It unfolds from the composer and folds back into it.
(() => {
'use strict';

const GROUPS = { chatgpt: 'ChatGPT', openai: 'OpenAI API', anthropic: 'Anthropic', deepseek: 'DeepSeek', 'opencode-go': 'OpenCode Go', opencode: 'OpenCode Zen — Free' };

// Windows are told the way providers tell them: 272K, 200K, 1M.
function size(tokens) {
 if (!tokens) return '';
 if (tokens < 950000) return `${Math.round(tokens / 1000)}K`;
 const m = tokens / 1e6, whole = Math.round(m);
 return `${Math.abs(m - whole) < 0.06 ? whole : m.toFixed(1)}M`;
}

const escapeHtml = text => String(text ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

class ModelMenu {
 constructor({ button, root, chat, settings }) {
  this.button = button;
  this.root = root;
  this.chat = chat;
  this.settings = settings;
  this.query = '';
  button.addEventListener('model-open', () => this.toggle());
  document.addEventListener('pointerdown', event => {
   if (!this.open) return;
   if (this.root.contains(event.target) || this.button.contains(event.target)) return;
   this.close();
  }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && this.open) this.close(); });
  const prior = settings.onModels;
  settings.onModels = () => { prior?.(); this.sync(); if (this.open) this.render(); };
  this.sync();
 }

 get open() {
  return this.root.matches(':popover-open');
 }

 toggle() {
  if (this.open) this.close();
  else this.show();
 }

 show() {
  this.render();
  window.PopoverMotion?.show ? window.PopoverMotion.show(this.root) : this.root.showPopover?.();
  this.button.setAttribute('expanded', '');
  setTimeout(() => this.root.querySelector('.model-menu-search')?.focus({ preventScroll: true }), 60);
 }

 close() {
  window.PopoverMotion?.hide ? window.PopoverMotion.hide(this.root) : this.root.hidePopover?.();
  this.button.removeAttribute('expanded');
 }

 sync() {
  const locked = this.chat.busy;
  const name = this.settings.find(this.chat.model)?.name || this.chat.model || '';
  this.button.setAttribute('label', I18n.t('model.current', { name }));
  this.button.toggleAttribute('disabled', locked);
  this.button.title = locked ? I18n.t('model.locked') : '';
  if (locked && this.open) this.close();
 }

 models() {
  const models = this.settings.models || [];
  const needle = this.query.trim().toLowerCase();
  if (!needle) return models;
  return models.filter(model => `${model.name || ''} ${model.id} ${model.provider}`.toLowerCase().includes(needle));
 }

 render() {
  const models = this.models();
  const providers = [...new Set(models.map(model => model.provider))];
  const current = this.chat.model;
  const body = providers.length
   ? providers.map(provider => `
   <div class="model-menu-group">${escapeHtml(GROUPS[provider] || provider)}</div>
   ${models.filter(model => model.provider === provider).map(model => this.row(model, current)).join('')}`).join('')
   : `<div class="model-menu-empty">${escapeHtml(I18n.t('model.none'))}</div>`;
  this.root.innerHTML = `<div class="model-menu-search"><span class="model-menu-search-icon">${Glyphs.search || ''}</span><input type="text" spellcheck="false" autocomplete="off" placeholder="${escapeHtml(I18n.t('model.search'))}" value="${escapeHtml(this.query)}"></div><div class="model-menu-list">${body}</div>`;
  const input = this.root.querySelector('.model-menu-search input');
  input.addEventListener('input', () => {
   this.query = input.value;
   const keeps = this.renderListOnly();
   input.focus();
   void keeps;
  });
  for (const row of this.root.querySelectorAll('.model-menu-row')) {
   row.addEventListener('click', () => this.pick(row.dataset.id));
   row.prepend(window.ModelIcons?.icon?.(this.settings.find(row.dataset.id) || { id: row.dataset.id }) || document.createElement('span'));
  }
  if (this.confirmId) this.confirm(this.confirmId);
 }

 // Typing in the search box only redraws the list, so the field keeps its focus and caret.
 renderListOnly() {
  const list = this.root.querySelector('.model-menu-list');
  if (!list) return this.render();
  const models = this.models();
  const providers = [...new Set(models.map(model => model.provider))];
  const current = this.chat.model;
  list.innerHTML = providers.length
   ? providers.map(provider => `
   <div class="model-menu-group">${escapeHtml(GROUPS[provider] || provider)}</div>
   ${models.filter(model => model.provider === provider).map(model => this.row(model, current)).join('')}`).join('')
   : `<div class="model-menu-empty">${escapeHtml(I18n.t('model.none'))}</div>`;
  for (const row of list.querySelectorAll('.model-menu-row')) {
   row.addEventListener('click', () => this.pick(row.dataset.id));
   row.prepend(window.ModelIcons?.icon?.(this.settings.find(row.dataset.id) || { id: row.dataset.id }) || document.createElement('span'));
  }
  return true;
 }

 row(model, current) {
  const free = Boolean(window.Prices?.free?.(model.id));
  const meta = [
   model.context ? I18n.t('model.context', { size: size(model.context) }) : '',
   I18n.t(model.vision === false ? 'model.text' : 'model.vision'),
  ].filter(Boolean).join(' · ');
  const on = model.id === current;
  return `<button type="button" class="model-menu-row${on ? ' is-current' : ''}" data-id="${escapeHtml(model.id)}" role="menuitemradio" aria-checked="${on}">
   <span class="model-menu-text"><span class="model-menu-name">${escapeHtml(model.name || model.id)}</span><span class="model-menu-meta">${escapeHtml(meta)}</span></span>
   ${free ? `<span class="model-free">${escapeHtml(I18n.t('model.free'))}</span>` : ''}
   ${on ? '<span class="model-menu-check" aria-hidden="true">✓</span>' : ''}
  </button>`;
 }

 pick(id) {
  if (id === this.chat.model) { this.close(); return; }
  // A chat with history is compacted before another model takes it over: ask first.
  if (this.chat.hasHistory(this.chat.active)) { this.confirm(id); return; }
  this.chat.setModel(id);
  this.settings.show(id);
  this.close();
 }

 confirm(id) {
  this.confirmId = id;
  const from = this.settings.find(this.chat.model)?.name || this.chat.model;
  const to = this.settings.find(id)?.name || id;
  let box = this.root.querySelector('.model-confirm');
  if (!box) {
   box = document.createElement('div');
   box.className = 'model-confirm';
   this.root.append(box);
  }
  box.hidden = false;
  box.innerHTML = `<p>${escapeHtml(I18n.t('model.confirm.text', { from, to }))}</p><div class="model-confirm-actions"><button type="button" class="settings-button is-primary" data-ok>${escapeHtml(I18n.t('model.confirm.ok'))}</button><button type="button" class="settings-button" data-cancel>${escapeHtml(I18n.t('model.confirm.cancel'))}</button></div>`;
  box.querySelector('[data-ok]').addEventListener('click', () => { box.hidden = true; this.confirmId = ''; this.chat.switchModel(id); this.settings.show(id); this.close(); });
  box.querySelector('[data-cancel]').addEventListener('click', () => { box.hidden = true; this.confirmId = ''; this.renderListOnly(); });
 }
}

window.ModelMenu = ModelMenu;
})();
