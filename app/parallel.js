// Parallel runs: the same prompt to several models at once, watched in a Runs tab of the
// right panel. Each run is a normal chat under the hood, so opening one shows everything.
(() => {
'use strict';

const runs = [];
const listeners = new Set();

window.ParallelRuns = {
 get runs() {
  return runs;
 },
 on(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
 },
 add(run) {
  run.started ||= Date.now();
  runs.unshift(run);
  this.emit();
 },
 update(id, patch) {
  const run = runs.find(item => item.id === id);
  if (!run) return;
  Object.assign(run, patch);
  this.emit();
 },
 emit() {
  for (const callback of [...listeners]) {
   try { callback(); } catch {}
  }
 },
};

const STATUS_KEY = { running: 'runs.running', completed: 'runs.completed', failed: 'runs.failed', error: 'runs.error' };

// The trigger: a small popover over the composer with model checkboxes.
class ParallelPanel {
 constructor({ button, panel, chat, settings, composerText, pickFolder, consume }) {
  this.button = button;
  this.panel = panel;
  this.chat = chat;
  this.settings = settings;
  this.composerText = composerText;
  this.pickFolder = pickFolder;
  this.consume = consume;
  this.selected = new Set();
  this.busy = false;
  this.list = panel.querySelector('.parallel-models');
  this.message = panel.querySelector('.parallel-message');
  this.runButton = panel.querySelector('.parallel-run');
  button.addEventListener('parallel-toggle', () => this.toggle());
  this.runButton.addEventListener('click', () => this.start());
  document.addEventListener('pointerdown', event => {
   if (!this.open) return;
   if (this.panel.contains(event.target) || this.button.contains(event.target)) return;
   this.panel.hidePopover?.();
  }, true);
 }

 get open() {
  return this.panel.matches(':popover-open');
 }

 toggle() {
  if (this.open) window.PopoverMotion?.hide ? window.PopoverMotion.hide(this.panel) : this.panel.hidePopover?.();
  else {
   this.render();
   window.PopoverMotion?.show ? window.PopoverMotion.show(this.panel) : this.panel.showPopover?.();
  }
 }

 render() {
  const models = this.settings.models || [];
  if (!this.selected.size) for (const model of models.slice(0, 2)) this.selected.add(model.id);
  // The message that will be sent to every model, so the panel says what it is about to do.
  const text = this.composerText?.text?.().trim() || '';
  if (this.message) {
   this.message.hidden = !text;
   this.message.textContent = text ? I18n.t('parallel.message', { text: text.length > 180 ? `${text.slice(0, 180)}…` : text }) : '';
  }
  this.list.innerHTML = models.map(model => `
   <label class="parallel-model">
    <span class="parallel-model-icon" data-model="${escapeAttr(model.id)}"></span>
    <input type="checkbox" data-model="${escapeAttr(model.id)}" ${this.selected.has(model.id) ? 'checked' : ''}>
    <span class="parallel-model-name">${escapeHtml(model.name || model.id)}</span>
    <span class="parallel-model-api">${escapeHtml(model.id)}</span>
   </label>`).join('');
  // Every row wears its model's own little logo, as the picker does.
  for (const holder of this.list.querySelectorAll('.parallel-model-icon')) {
   const model = models.find(item => item.id === holder.dataset.model) || { id: holder.dataset.model };
   holder.replaceWith(window.ModelIcons?.icon?.(model) || holder);
  }
  for (const input of this.list.querySelectorAll('input[data-model]')) {
   input.addEventListener('change', () => {
    if (input.checked) this.selected.add(input.dataset.model);
    else this.selected.delete(input.dataset.model);
    this.sync();
   });
  }
  this.sync();
 }

 sync() {
  const count = this.selected.size;
  this.runButton.disabled = !count;
  this.runButton.textContent = count > 1 ? I18n.t('parallel.runCount', { count }) : I18n.t('parallel.run');
 }

 async start() {
  if (this.busy) return;
  const models = (this.settings.models || []).filter(model => this.selected.has(model.id));
  const text = this.composerText.text().trim();
  if (!text || !models.length) return;
  this.busy = true;
  try {
   let folder = this.chat.folder;
   if (!folder && this.pickFolder) folder = await this.pickFolder();
   if (!folder) return;
   this.panel.hidePopover?.();
   await this.chat.runParallel(folder, models, text);
   this.consume?.();
  } finally {
   this.busy = false;
  }
 }
}

// The Runs tab in the right panel.
class RunsView {
 constructor({ chat }) {
  this.chat = chat;
  this.el = document.createElement('div');
  this.el.className = 'browser-view browser-runs';
  this.list = document.createElement('div');
  this.list.className = 'runs-list';
  this.el.append(this.list);
  // One row per run, patched in place: a working run's snippet updates as the answer grows,
  // which must not rebuild the panel.
  this.items = new Map();
  this.off = window.ParallelRuns.on(() => this.render());
  this.render();
  // Rows are rebuilt only when a run is added or removed. The per-second tick touches just
  // the running-time text on existing rows.
  this.timer = setInterval(() => this.tickClocks(), 1000);
 }

 tickClocks() {
  const runs = window.ParallelRuns.runs;
  if (!runs.some(run => run.status === 'running')) return;
  for (const run of runs) {
   if (run.status !== 'running') continue;
   const item = this.items.get(run.id);
   if (item) item.statusEl.textContent = `${I18n.t('runs.running')} · ${clock(run.started)}`;
  }
 }

 render() {
  const runs = window.ParallelRuns.runs;
  if (!runs.length) {
   if (!this.list.querySelector('.runs-empty')) this.list.innerHTML = `<div class="runs-empty">${escapeHtml(I18n.t('runs.empty'))}</div>`;
   this.items.clear();
   return;
  }
  if (this.list.querySelector('.runs-empty')) this.list.innerHTML = '';
  const seen = new Set();
  for (const run of runs) {
   seen.add(run.id);
   let item = this.items.get(run.id);
   if (!item) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'run-item';
    row.dataset.id = run.id;
    row.innerHTML = '<span class="run-top">'
     + '<span class="run-pulse" aria-hidden="true" hidden></span>'
     + '<span class="run-model"></span>'
     + '<span class="run-status"></span>'
     + '</span><span class="run-title"></span><span class="run-snippet" hidden></span>';
    item = {
     row,
     pulse: row.querySelector('.run-pulse'),
     modelEl: row.querySelector('.run-model'),
     statusEl: row.querySelector('.run-status'),
     titleEl: row.querySelector('.run-title'),
     snippetEl: row.querySelector('.run-snippet'),
     model: null,
     title: null,
     snippet: null,
    };
    // Opening the run is the point: the right panel steps aside so its conversation fills
    // the window, the way OpenCode opens the session a background task belongs to.
    row.addEventListener('click', async () => {
     await this.chat.open(run.id);
     window.browserPanel?.hide?.();
    });
    this.items.set(run.id, item);
    this.list.append(row);
   }
   this.patch(item, run);
  }
  for (const [id, item] of [...this.items]) {
   if (seen.has(id)) continue;
   item.row.remove();
   this.items.delete(id);
  }
 }

 patch(item, run) {
  const running = run.status === 'running';
  item.row.classList.toggle('is-running', running);
  item.pulse.hidden = !running;
  item.statusEl.className = `run-status is-${run.status}`;
  item.statusEl.textContent = `${I18n.t(STATUS_KEY[run.status] || 'runs.running')}${running ? ` · ${clock(run.started)}` : ''}`;
  const model = run.model || '';
  if (item.model !== model) { item.model = model; item.modelEl.textContent = model; }
  const title = run.title || '';
  if (item.title !== title) { item.title = title; item.titleEl.textContent = title; }
  const snippet = run.snippet || '';
  if (item.snippet !== snippet) {
   item.snippet = snippet;
   item.snippetEl.textContent = snippet;
   item.snippetEl.hidden = !snippet;
  }
 }
}

const elapsed = started => (started ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 0);
const clock = started => {
 const total = elapsed(started), pad = value => String(value).padStart(2, '0');
 return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${pad(total % 60)}s`;
};

// A small pill on the left of the composer: how many runs are working right now, with a
// living three-dot pulse. Clicking it brings the Runs tab forward.
class ParallelMeter {
 constructor({ button }) {
  this.button = button;
  this.refresh();
  // Event-driven: the runs and presence emitters cover every change the meter shows. The old
  // 1 s poll only existed for the running-time label, which the meter does not show.
  window.ParallelRuns.on(() => this.refresh());
  window.Presence?.on?.(() => this.refresh());
  button.addEventListener('click', () => window.browserPanel?.showRuns?.());
 }

 count() {
  // Only the runs of the parallel tab count: a plain chat working on another device is not
  // a parallel run and must not light this bubble.
  return window.ParallelRuns.runs.filter(run => run.status === 'running').length;
 }

 refresh() {
  const count = this.count();
  this.button.hidden = !count;
  if (!count) {
   this.button.replaceChildren();
   return;
  }
  if (!this.button.querySelector('.parallels-dots')) {
   const dots = document.createElement('span');
   dots.className = 'parallels-dots';
   dots.setAttribute('aria-hidden', 'true');
   dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
   const text = document.createElement('span');
   text.className = 'parallels-text';
   this.button.replaceChildren(dots, text);
  }
  this.button.querySelector('.parallels-text').textContent = I18n.t(count === 1 ? 'parallel.meterOne' : 'parallel.meter', { count });
  this.button.title = I18n.t('parallel.openRuns');
 }
}

function escapeHtml(text) {
 return String(text ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
}
function escapeAttr(text) {
 return escapeHtml(text).replace(/'/g, '&#39;');
}

window.ParallelPanel = ParallelPanel;
window.RunsView = RunsView;
window.ParallelMeter = ParallelMeter;
})();
