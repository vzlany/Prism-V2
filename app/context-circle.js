// The big circle left of the composer: how much of the model's context this conversation
// has used, in the spirit of OpenCode's gauge. Hovering names the chat's size; pressing it
// opens a small card with tokens, context window, cache traffic and the price so far.
(() => {
'use strict';

const RADIUS = 18;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
// Windows are told the way providers tell them: 272K, 200K, 1M.
const size = value => {
 if (!value) return '0';
 if (value < 950000) return `${Math.round(value / 1000)}K`;
 const m = value / 1e6, whole = Math.round(m);
 return `${Math.abs(m - whole) < 0.06 ? whole : m.toFixed(1)}M`;
};

class ContextCircle {
 constructor({ button, panel, chat, settings }) {
  this.button = button;
  this.panel = panel;
  this.chat = chat;
  this.settings = settings;
  this.fill = button.querySelector('.context-fill');
  this.percent = button.querySelector('.context-percent');
  this.fill.style.strokeDasharray = `${CIRCUMFERENCE}`;
  this.button.addEventListener('click', () => this.toggle());
  window.addEventListener('prices-changed', () => this.update());
  this.update();
  setInterval(() => this.update(), 1500);
 }

 current() {
  const context = this.chat.context();
  const tokens = context.tokens || 0;
  const windowSize = this.settings.windowOf(context.model || this.settings.model) || 0;
  const percent = windowSize ? Math.min(100, Math.round(tokens / windowSize * 100)) : 0;
  return { context, tokens, windowSize, percent, cost: window.Prices?.cost(context.model, context.spend) ?? null };
 }

 toggle() {
  if (this.panel.matches(':popover-open')) this.panel.hidePopover?.();
  else { this.paint(); this.panel.showPopover?.(); }
 }

 update() {
  const state = this.current();
  const show = state.tokens > 0 || state.context.messages.length > 0;
  this.button.hidden = !show;
  if (!show) return;
  const tone = state.percent >= 85 ? 'is-high' : state.percent >= 60 ? 'is-mid' : '';
  this.button.classList.toggle('is-mid', tone === 'is-mid');
  this.button.classList.toggle('is-high', tone === 'is-high');
  this.fill.style.strokeDashoffset = `${(CIRCUMFERENCE * (1 - state.percent / 100)).toFixed(2)}`;
  this.percent.textContent = `${state.percent}%`;
  this.button.title = I18n.t('context.hint', { used: size(state.tokens), window: size(state.windowSize), percent: state.percent });
  if (this.panel.matches(':popover-open')) this.paint();
 }

 paint() {
  const { context, tokens, windowSize, percent, cost } = this.current();
  const spend = context.spend || {};
  const cached = Number(spend.cached) || 0, written = Number(spend.written) || 0;
  const reasoning = Number(spend.reasoning) || 0;
  const row = (label, value) => `<div class="context-row"><span class="context-label">${escapeHtml(I18n.t(label))}</span><span class="context-value">${value}</span></div>`;
  const cache = cached || written
   ? row('context.cache', `${escapeHtml(size(cached))} read${written ? ` · ${escapeHtml(size(written))} write` : ''}`)
   : '';
  const fresh = Math.max(0, (Number(spend.input) || 0) - cached - written);
  const out = Number(spend.output) || 0;
  this.panel.innerHTML = [
   `<div class="context-head">${escapeHtml(I18n.t('context.title'))}</div>`,
   row('context.context', `${escapeHtml(size(tokens))} / ${escapeHtml(size(windowSize))} · ${percent}%`),
   row('context.messages', String(context.messages.length)),
   row('context.input', `${escapeHtml(size(fresh))} fresh${cached ? ` · ${escapeHtml(size(cached))} cached` : ''}`),
   row('context.output', `${escapeHtml(size(Math.max(0, out - reasoning)))}${reasoning ? ` · ${escapeHtml(size(reasoning))} reasoning` : ''}`),
   cache,
   row('context.cost', cost != null ? `~${escapeHtml(window.Prices.format(cost))}` : escapeHtml(I18n.t('context.noPrice'))),
  ].join('');
 }
}

function escapeHtml(text) {
 return String(text ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
}

window.ContextCircle = ContextCircle;
})();
