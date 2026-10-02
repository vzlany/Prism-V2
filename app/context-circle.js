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
  this.price = button.querySelector('.context-price');
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
  // A conversation that has filled the window once keeps its memory: the ring reads from the
  // highest point it ever reached (spend.context is that peak and is saved with the chat), so
  // compacting the conversation never snaps it back to zero. Each completed window is a lap.
  const peak = Math.max(Number(context.spend?.context) || 0, tokens);
  const ratio = windowSize ? peak / windowSize : 0;
  const laps = Math.floor(ratio);
  const fraction = ratio - laps;
  const live = windowSize ? Math.min(1, tokens / windowSize) : 0;
  return { context, tokens, peak, windowSize, ratio, laps, fraction, live, cost: window.Prices?.cost(context.model, context.spend) ?? null };
 }

 toggle() {
  if (this.panel.matches(':popover-open')) this.panel.hidePopover?.();
  else { this.paint(); this.panel.showPopover?.(); }
 }

 // How deep the ring burns: the first window follows the usual gray → amber → red; every
 // completed lap deepens the tone, so a long conversation reads darker and darker.
 tone({ laps, live }) {
  if (laps >= 4) return 'rgb(222,82,124)';
  if (laps === 3) return 'rgb(240,96,104)';
  if (laps === 2) return 'rgb(255,128,92)';
  if (laps === 1) return 'rgb(255,172,96)';
  if (live >= 0.85) return 'rgb(255,128,128)';
  if (live >= 0.6) return 'rgb(255,196,120)';
  return 'rgba(var(--fg-rgb),.85)';
 }

 update() {
  const state = this.current();
  const show = state.tokens > 0 || state.context.messages.length > 0;
  this.button.hidden = !show;
  if (!show) return;
  const lapped = state.laps >= 1;
  this.button.classList.toggle('is-lapped', lapped);
  this.button.style.setProperty('--context-tone', this.tone(state));
  if (lapped) {
   // Filled: the ring stays whole and the dashes keep marching around it, a shade deeper
   // with every lap — it never empties again, so nothing looks like a reset.
   this.fill.style.strokeDasharray = '';
   this.fill.style.strokeDashoffset = '';
  } else {
   this.fill.style.strokeDasharray = `${CIRCUMFERENCE}`;
   this.fill.style.strokeDashoffset = `${(CIRCUMFERENCE * (1 - state.live)).toFixed(2)}`;
  }
  this.percent.textContent = lapped ? `${state.laps}×` : `${Math.round(state.live * 100)}%`;
  // The price of this conversation, spelled under the ring: ~$3.05, or nothing when the
  // model has no prices to go by.
  const spent = state.cost != null && state.cost > 0 ? `~${window.Prices.format(state.cost)}` : '';
  this.price.textContent = spent;
  this.price.hidden = !spent;
  this.button.setAttribute('aria-label', I18n.t('context.title'));
  this.button.title = lapped
   ? I18n.t('context.hintLaps', { laps: state.laps, used: size(state.peak), window: size(state.windowSize) })
   : I18n.t('context.hint', { used: size(state.tokens), window: size(state.windowSize), percent: Math.round(state.live * 100) });
  if (this.panel.matches(':popover-open')) this.paint();
 }

 paint() {
  const { context, tokens, peak, windowSize, laps, live, cost } = this.current();
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
   row('context.context', `${escapeHtml(size(tokens))} / ${escapeHtml(size(windowSize))} · ${Math.round(live * 100)}%`),
   row('context.peak', laps ? `${escapeHtml(size(peak))} / ${escapeHtml(size(windowSize))} · ${laps}×` : `${escapeHtml(size(peak))} / ${escapeHtml(size(windowSize))}`),
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
