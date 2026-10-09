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
  // What the parallel runs started from this chat have spent, looked up by chat id: the ring
  // keeps the chat's own context, but its price is the whole tree's price.
  this.childSpend = new Map();
  this.childTried = new Map();
  this.button.addEventListener('click', () => this.toggle());
  window.addEventListener('prices-changed', () => this.update(true));
  this.update(true);
  // The circle used to walk every message and every step 40 times a minute. It now reads
  // state only when a cheap signature changed, with a slow fallback beat.
  setInterval(() => this.update(), 5000);
 }

 // A cheap fingerprint of what the ring draws: changing it means the context or the price
 // moved, and only then is the walk over the chat's messages done.
 signature() {
  const conv = this.chat.active;
  if (!conv) return '';
  const last = conv.messages[conv.messages.length - 1];
  const size = typeof last?.content === 'string' ? last.content.length : Array.isArray(last?.content) ? last.content.length : 0;
  return `${conv.id}|${conv.messages.length}|${conv.tokens || 0}|${size}|${conv.spend ? `${conv.spend.input}|${conv.spend.output}|${conv.spend.cached}|${conv.spend.context}` : ''}`;
 }

 // Every chat descending from the active one (runs, their runs, subagents of both).
 descendants() {
  const active = this.chat.active?.id;
  if (!active) return [];
  const byParent = new Map();
  for (const chat of this.chat.library?.chats || []) {
   if (!chat.parent || chat.parent === chat.id) continue;
   const kids = byParent.get(chat.parent) || [];
   kids.push(chat);
   byParent.set(chat.parent, kids);
  }
  const out = [], seen = new Set([active]);
  const walk = id => {
   for (const kid of byParent.get(id) || []) {
    if (seen.has(kid.id)) continue;
    seen.add(kid.id);
    out.push(kid);
    walk(kid.id);
   }
  };
  walk(active);
  return out;
 }

 // The runs' price, added to the chat's own. A run this session never opened is read from
 // its file once, quietly, so an app restart does not lose the number.
  parallelCost() {
  let cost = 0, runs = 0;
  const now = performance.now();
  for (const record of this.descendants()) {
   const conv = this.chat.conversations.get(record.id);
   const spend = conv?.spend || this.childSpend.get(record.id) || null;
   if (!spend) {
    if ((this.childTried.get(record.id) || 0) > now - 15000) continue;
    this.childTried.set(record.id, now);
    this.chat.library.conversation(record.id).then(({ spend: loaded }) => {
     if (!loaded) return;
     this.childSpend.set(record.id, loaded);
     this.update(true);
    }).catch(() => {});
    continue;
   }
   const model = conv ? this.chat.modelOf(conv) : record.model;
   const value = window.Prices?.cost(model, spend);
   if (value) { cost += value; runs++; }
  }
  return { cost, runs };
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

 update(force = false) {
  const signature = this.signature();
  const open = this.panel.matches(':popover-open');
  if (!force && !open && signature === this.signatureAt) return;
  this.signatureAt = signature;
  const state = this.current();
  const show = state.tokens > 0 || state.context.messages.length > 0;
  this.button.hidden = !show;
  if (!show) return;
  const parallel = this.parallelCost();
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
  // The price under the ring is the whole tree's: this chat plus every parallel run it
  // started (and their runs), so the number matches what the work really cost.
  const total = (state.cost || 0) + parallel.cost;
  const spent = total > 0 ? `~${window.Prices.format(total)}` : '';
  this.price.textContent = spent;
  this.price.hidden = !spent;
  this.parallel = parallel;
  this.button.setAttribute('aria-label', I18n.t('context.title'));
  this.button.title = lapped
   ? I18n.t('context.hintLaps', { laps: state.laps, used: size(state.peak), window: size(state.windowSize) })
   : I18n.t('context.hint', { used: size(state.tokens), window: size(state.windowSize), percent: Math.round(state.live * 100) });
  this.button.classList.toggle('has-parallel', parallel.runs > 0);
  if (this.panel.matches(':popover-open')) this.paint();
 }

 paint() {
  const { context, tokens, peak, windowSize, laps, live, cost } = this.current();
  const parallel = this.parallel || this.parallelCost();
  const total = (cost || 0) + parallel.cost;
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
   parallel.cost > 0 ? row('context.parallel', `~${escapeHtml(window.Prices.format(parallel.cost))} · ${parallel.runs}`) : '',
   row('context.cost', total > 0 ? `~${escapeHtml(window.Prices.format(total))}` : escapeHtml(I18n.t('context.noPrice'))),
  ].join('');
 }
}

function escapeHtml(text) {
 return String(text ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
}

window.ContextCircle = ContextCircle;
})();
