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
  this.open = window.Effects?.toolsMode !== 'closed';
  this.touched = false;
  const el = this.el = element('div', `tool is-running${this.open ? ' is-open' : ''}`);
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
  this.chevron = element('span', 'tool-chevron');
  this.head.append(icon, element('span', 'tool-title', this.titleOf()), this.summary, this.stat, this.status, this.chevron);
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
  if (!this.touched) this.open = Boolean(error) || window.Effects?.toolsMode === 'open';
  this.sync();
 }

 sync() {
  this.open = this.open && this.hasBody();
  this.el.classList.toggle('is-open', this.open);
  this.chevron.hidden = !this.hasBody();
  this.head.disabled = !this.hasBody();
  this.head.setAttribute('aria-expanded', String(this.open));
 }

 // A small action inside the head, e.g. "Open" on a subagent card: clicking it opens the
 // conversation that work belongs to without folding the card.
 addOpen(label, onClick) {
  const open = element('span', 'tool-open', label);
  open.setAttribute('role', 'button');
  open.tabIndex = 0;
  open.title = label;
  const go = event => { event.stopPropagation(); event.preventDefault(); onClick(); };
  open.addEventListener('click', go);
  open.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') go(event); });
  this.head.insertBefore(open, this.chevron);
  return open;
 }
}

window.ToolCard = ToolCard;
})();
