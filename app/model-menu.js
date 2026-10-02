// A plain menu for choosing the model: grouped by provider, each model with a badge, its
// context window and whether it is free; the one in use carries a check.
(() => {
'use strict';

const GROUPS = { chatgpt: 'ChatGPT', openai: 'OpenAI API', anthropic: 'Anthropic', deepseek: 'DeepSeek', 'opencode-go': 'OpenCode Go' };
const FAMILIES = [
 [/deepseek/i, 'DS', '#5b74ff'],
 [/kimi|moonshot/i, 'KM', '#2b3444'],
 [/glm|zhipu/i, 'GLM', '#0ea5a4'],
 [/qwen/i, 'QW', '#7c5cff'],
 [/minimax/i, 'MM', '#f59e0b'],
 [/longcat/i, 'LC', '#eab308'],
 [/mimo/i, 'MI', '#ec4899'],
 [/grok|xai/i, 'X', '#64748b'],
 [/gpt|openai/i, 'GPT', '#10b981'],
 [/muse/i, 'MS', '#8b5cf6'],
 [/hunyuan|^hy/i, 'HY', '#3b82f6'],
 [/claude|anthropic/i, 'AN', '#d97757'],
];

// Windows are told the way providers tell them: 272K, 200K, 1M.
function size(tokens) {
 if (!tokens) return '';
 if (tokens < 950000) return `${Math.round(tokens / 1000)}K`;
 const m = tokens / 1e6, whole = Math.round(m);
 return `${Math.abs(m - whole) < 0.06 ? whole : m.toFixed(1)}M`;
}

function badgeOf(model) {
 const id = String(model?.api || model?.id || ''), name = String(model?.name || '');
 for (const [rule, text, color] of FAMILIES) if (rule.test(id) || rule.test(name)) return { text, color };
 const initials = (name || id).replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase();
 return { text: initials || 'AI', color: '#64748b' };
}

const escapeHtml = text => String(text ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

class ModelMenu {
 constructor({ button, root, chat, settings }) {
  this.button = button;
  this.root = root;
  this.chat = chat;
  this.settings = settings;
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
  this.root.showPopover?.();
  this.button.setAttribute('expanded', '');
 }

 close() {
  this.root.hidePopover?.();
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

 render() {
  const models = this.settings.models || [];
  const providers = [...new Set(models.map(model => model.provider))];
  const current = this.chat.model;
  const body = providers.length
   ? providers.map(provider => `
   <div class="model-menu-group">${escapeHtml(GROUPS[provider] || provider)}</div>
   ${models.filter(model => model.provider === provider).map(model => this.row(model, current)).join('')}`).join('')
   : `<div class="model-menu-empty">${escapeHtml(I18n.t('settings.key.needed', { provider: 'OpenCode Go' }))}</div>`;
  this.root.innerHTML = `<div class="model-menu-list">${body}</div>`;
  for (const row of this.root.querySelectorAll('.model-menu-row')) row.addEventListener('click', () => this.pick(row.dataset.id));
 }

 row(model, current) {
  const badge = badgeOf(model);
  const free = Boolean(window.Prices?.free?.(model.id));
  const meta = [
   model.context ? I18n.t('model.context', { size: size(model.context) }) : '',
   I18n.t(model.vision === false ? 'model.text' : 'model.vision'),
  ].filter(Boolean).join(' · ');
  const on = model.id === current;
  return `<button type="button" class="model-menu-row${on ? ' is-current' : ''}" data-id="${escapeHtml(model.id)}" role="menuitemradio" aria-checked="${on}">
   <span class="model-menu-badge" style="--badge:${badge.color}">${escapeHtml(badge.text)}</span>
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
  box.querySelector('[data-ok]').addEventListener('click', () => { box.hidden = true; this.chat.switchModel(id); this.settings.show(id); this.close(); });
  box.querySelector('[data-cancel]').addEventListener('click', () => { box.hidden = true; this.render(); });
 }
}

window.ModelMenu = ModelMenu;
})();
