// A compact card for every tool call: what ran, what it wrote, what it printed.
(() => {
'use strict';

const PREVIEW_LINES = 60;
const OUTPUT_CHARS = 4000;
const ICONS = { command: 'terminal', file: 'file', web: 'globe' };
// Two white dashes, half a loop apart, glide around the card while it runs. An SVG rect is
// used so the dash travels the whole perimeter at one speed, unlike a rotating gradient.
const SNAKE = '<svg class="tool-snake" aria-hidden="true"><rect pathLength="100"/></svg>';

function element(tag, className, text) {
 const el = document.createElement(tag);
 el.className = className;
 if (text !== undefined) el.textContent = text;
 return el;
}

function lines(text, sign, className) {
 const all = String(text).replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
 const shown = all.slice(0, PREVIEW_LINES).map(line => {
  const row = element('div', `tool-line ${className}`);
  row.append(element('span', 'tool-sign', sign), element('span', 'tool-text', line || ' '));
  return row;
 });
 if (all.length > PREVIEW_LINES) shown.push(element('div', 'tool-more', I18n.t('approve.more', { count: all.length - PREVIEW_LINES })));
 return shown;
}

class ToolCard {
 constructor(info) {
  this.info = info || {};
  this.parallel = info?.tool === 'subagent';
  // Simple visuals shows one collapsed line per call (subagent boxes keep their big form);
  // the settings' "stay open" does not apply to the simple lines.
  this.plain = Boolean(window.Effects?.simple) && !this.parallel;
  this.open = this.plain ? false : window.Effects?.toolsMode !== 'closed';
  this.touched = false;
  const el = this.el = element('div', `tool is-running${this.parallel ? ' is-parallel' : ''}${this.open ? ' is-open' : ''}`);
  el.setAttribute('role', 'group');
  el.insertAdjacentHTML('afterbegin', SNAKE);
  this.head = element('button', 'tool-head');
  this.head.type = 'button';
  const icon = element('span', 'tool-icon');
  icon.innerHTML = Glyphs[ICONS[info?.kind] || 'terminal'] || '';
  this.summary = element('span', 'tool-summary', this.summaryOf());
  // How many lines a write or an edit touched: green +N and red −M beside the file name.
  const count = text => {
   const clean = String(text ?? '').replace(/\r\n/g, '\n').replace(/\n$/, '');
   return clean ? clean.split('\n').length : 0;
  };
  this.added = count(info?.added);
  this.removed = count(info?.removed);
  this.stat = element('span', 'tool-stat');
  if (this.removed) this.stat.append(element('span', 'tool-stat-num is-del', `−${this.removed}`));
  if (this.added) this.stat.append(element('span', 'tool-stat-num is-add', `+${this.added}`));
  this.stat.hidden = !this.added && !this.removed;
  this.status = element('span', 'tool-status');
  // Simple visuals shows how long the step took beside its line ("(5.2s)").
  this.timeEl = element('span', 'tool-time');
  this.timeEl.hidden = true;
  this.chevron = element('span', 'tool-chevron');
  // A parallel (subagent) card shows a spinning blue circle before its icon while it works;
  // ordinary tools already have the snake around the card, so no space is wasted on them.
  this.spinner = this.parallel ? element('span', 'tool-spinner') : null;
  const head = this.spinner ? [this.spinner, icon] : [icon];
  // The simple line: the reason the model gave for the step, falling back to the plain title.
  this.reasonEl = element('span', 'tool-reason', String(this.info.reason || this.titleOf() || '').slice(0, 90));
  this.head.append(...head, element('span', 'tool-title', this.titleOf()), this.reasonEl, this.summary, this.stat, this.status, this.timeEl, this.chevron);
  this.body = element('div', 'tool-body');
  this.inner = element('div', 'tool-body-inner');
  this.body.append(this.inner);
  el.append(this.head, this.body);
  this.render();
  this.head.addEventListener('click', () => {
   this.touched = true;
   this.open = !this.open && this.hasBody();
   this.sync();
  });
  this.sync();
 }

 titleOf() {
  const info = this.info;
  if (info.tool === 'read_file') return I18n.t('tool.read');
  if (info.tool === 'list_files') return I18n.t('tool.list');
  return info?.title || '';
 }

 summaryOf() {
  const info = this.info;
  const raw = info.path || info.url || info.text || (info.code ? String(info.code).split('\n')[0] : '') || '';
  return String(raw).replace(/\s+/g, ' ').slice(0, 110);
 }

 hasBody() {
  return this.inner.childElementCount > 0;
 }

 render() {
  const info = this.info;
  if (info.kind === 'command' && info.code) this.inner.append(element('pre', 'tool-code', String(info.code)));
  if (info.kind === 'file' && (info.removed || info.added)) {
   const diff = element('div', 'tool-diff');
   if (info.removed) diff.append(...lines(info.removed, '−', 'is-removed'));
   if (info.added) diff.append(...lines(info.added, info.removed ? '+' : '', info.removed ? 'is-added' : 'is-new'));
   this.inner.append(diff);
  }
 }

 setResult(output, error = false) {
  this.el.classList.remove('is-running');
  this.el.classList.add(error ? 'is-error' : 'is-done');
  const text = String(output ?? '');
  const shown = text.length > OUTPUT_CHARS ? `${text.slice(0, OUTPUT_CHARS)}\n… (${text.length - OUTPUT_CHARS} more characters)` : text;
  if (shown.trim()) this.inner.append(element('pre', `tool-output${error ? ' is-error' : ''}`, shown));
  if (!this.touched) this.open = Boolean(error) || (!this.plain && window.Effects?.toolsMode === 'open');
  this.sync();
 }

 // How long the step took, shown beside a Simple visuals line.
 setDuration(ms) {
  if (!this.timeEl || !Number.isFinite(ms)) return;
  this.timeEl.textContent = ms >= 1000 ? `(${(ms / 1000).toFixed(1)}s)` : `(${Math.max(1, Math.round(ms))}ms)`;
  this.timeEl.hidden = false;
 }

 sync() {
  this.open = this.open && this.hasBody();
  this.el.classList.toggle('is-open', this.open);
  this.chevron.hidden = !this.hasBody();
  this.head.disabled = !this.hasBody();
  this.head.setAttribute('aria-expanded', String(this.open));
 }

 // A small action inside the head, e.g. "Open" on a subagent card or Preview/Download on a
 // file card: clicking it acts without folding the card.
 addAction(label, onClick) {
  const action = element('span', 'tool-action', label);
  action.setAttribute('role', 'button');
  action.tabIndex = 0;
  action.title = label;
  const go = event => { event.stopPropagation(); event.preventDefault(); onClick(); };
  action.addEventListener('click', go);
  action.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') go(event); });
  this.head.insertBefore(action, this.chevron);
  return action;
 }

 addOpen(label, onClick) {
  const action = this.addAction(label, onClick);
  action.classList.add('tool-open');
  return action;
 }
}

window.ToolCard = ToolCard;
})();
