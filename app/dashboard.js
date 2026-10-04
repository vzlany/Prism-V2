// The Dashboard: the whole picture of Prism V2 — how many conversations, messages and
// tokens there are, what they cost, which models and workspaces did the most work. It sits
// above Folders in the conversation list, and reads the chats quietly in the background the
// first time it is opened; later opens reuse the numbers for a minute.
(() => {
'use strict';

const CACHE_TTL = 60 * 1000;
// Only this many of the newest conversations are read for their message counts, tokens and
// spend: a chat can hold megabytes, and the dashboard must stay instant on a full history.
const SAMPLE = 40;
const WORKERS = 4;

const escapeHtml = text => String(text ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);
const compact = value => {
 const n = num(value);
 if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
 if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
 if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
 return String(Math.round(n));
};
const dayKey = time => new Date(time || Date.now()).toISOString().slice(0, 10);

class Dashboard {
 constructor({ panel, library, settings }) {
  this.panel = panel;
  this.library = library;
  this.settings = settings;
  this.cache = null;
  this.busy = false;
  if (panel) panel.addEventListener('toggle', event => { if (event.newState === 'open') this.show(); });
 }

 toggle() {
  if (!this.panel) return;
  if (this.panel.matches(':popover-open')) this.panel.hidePopover?.();
  else this.panel.showPopover?.();
 }

 async show() {
  if (this.busy) return;
  if (this.cache && Date.now() - this.cache.at < CACHE_TTL) return this.paint(this.cache);
  this.busy = true;
  this.paint(null);
  try {
   const stats = await this.gather();
   this.cache = { at: Date.now(), ...stats };
   this.paint(this.cache);
  } finally {
   this.busy = false;
  }
 }

 async gather() {
  const chats = [...this.library.chats].sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const sample = chats.slice(0, SAMPLE);
  const bodies = new Map();
  let next = 0;
  const workers = Array.from({ length: Math.min(WORKERS, sample.length) }, async () => {
   for (;;) {
    const at = next++;
    if (at >= sample.length) return;
    const chat = sample[at];
    let data = null;
    try { data = await window.openghost?.store?.read?.(`chats/${chat.id}`); } catch {}
    bodies.set(chat.id, data || null);
   }
  });
  await Promise.all(workers);

  const models = new Map();
  const folders = new Map();
  const days = new Map();
  let messages = 0, tokens = 0, thinking = 0, spend = 0, priced = false, peak = 0;
  for (const chat of chats) {
   const folder = this.library.folders.find(item => item.path.toLowerCase() === String(chat.folder || '').toLowerCase());
   const name = folder?.name || String(chat.folder || '').split(/[\\/]/).pop() || '—';
   const bucket = folders.get(chat.folder) || { name, path: chat.folder, chats: 0, tokens: 0 };
   bucket.chats++;
   folders.set(chat.folder, bucket);
   const day = dayKey(chat.created || chat.updated);
   days.set(day, (days.get(day) || 0) + 1);
   const body = bodies.get(chat.id);
   if (!body) continue;
   const entries = Array.isArray(body.messages) ? body.messages : [];
   let own = 0;
   for (const entry of entries) {
    if (entry?.role === 'user' || entry?.role === 'assistant' || entry?.role === 'compact') own++;
    if (entry?.thinkingMs) thinking += num(entry.thinkingMs);
   }
   messages += own;
   const used = num(body.tokens);
   tokens += used;
   bucket.tokens += used;
   if (body.spend) peak = Math.max(peak, num(body.spend.context));
   const cost = window.Prices?.cost?.(chat.model, body.spend);
   if (cost != null) { spend += cost; priced = true; }
   const key = chat.model || 'unknown';
   const entry = models.get(key) || { id: key, chats: 0, messages: 0, tokens: 0, cost: 0 };
   entry.chats++;
   entry.messages += own;
   entry.tokens += used;
   if (cost != null) entry.cost += cost;
   models.set(key, entry);
  }

  const order = [...models.values()].sort((a, b) => (b.tokens || b.chats) - (a.tokens || a.chats));
  const topFolders = [...folders.values()].sort((a, b) => b.chats - a.chats).slice(0, 6);
  const busy = [...days.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  const created = chats.length ? Math.min(...chats.map(chat => chat.created || chat.updated || Date.now())) : 0;
  const updated = chats.length ? Math.max(...chats.map(chat => chat.updated || 0)) : 0;
  let memory = 0;
  try { memory = ((await window.openghost?.memory?.list?.()) || []).length; } catch {}
  let version = '';
  try { version = (await window.openghost?.app?.version?.()) || ''; } catch {}
  return {
   conversations: chats.length,
   sample: sample.length,
   messages,
   tokens,
   thinking,
   spend: priced ? spend : null,
   peak,
   order,
   folders: [...folders.values()].sort((a, b) => b.chats - a.chats),
   topFolders,
   busy,
   created,
   updated,
   memory,
   pinned: chats.filter(chat => chat.pinned).length,
   protected: chats.filter(chat => chat.lock).length,
   version,
  };
 }

 paint(stats) {
  if (!this.panel) return;
  if (!stats) {
   this.panel.innerHTML = `<div class="dash-head"><span class="dash-logo">${Glyphs.ghost}</span><span class="dash-title">${escapeHtml(I18n.t('dashboard.title'))}</span><button type="button" class="dash-close" aria-label="${escapeHtml(I18n.t('dashboard.close'))}">×</button></div><div class="dash-loading">${escapeHtml(I18n.t('dashboard.loading'))}</div>`;
   this.wire();
   return;
  }
  const card = (labelKey, value, note = '', tone = '') => `<div class="dash-card${tone ? ` is-${tone}` : ''}"><span class="dash-label">${escapeHtml(I18n.t(labelKey))}</span><span class="dash-value">${escapeHtml(value)}</span>${note ? `<span class="dash-note">${escapeHtml(note)}</span>` : ''}</div>`;
  const date = time => time ? new Date(time).toLocaleDateString(I18n.lang, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const models = stats.order.slice(0, 6);
  const top = models[0]?.tokens || models[0]?.chats || 1;
  const modelName = id => {
   const found = this.settings?.find?.(id);
   return found?.name || String(id || '').replace(/^[a-z0-9-]+:/i, '');
  };
  const modelRow = entry => {
   const width = Math.max(4, Math.round(((entry.tokens || entry.chats) / top) * 100));
   return `<div class="dash-model" data-model="${escapeHtml(entry.id)}">
    <span class="dash-model-icon"></span>
    <span class="dash-model-text"><span class="dash-model-name">${escapeHtml(modelName(entry.id))}</span><span class="dash-model-meta">${escapeHtml(`${entry.chats} chats · ${compact(entry.tokens)} ${I18n.t('dashboard.tokensShort')}${entry.cost ? ` · ${window.Prices?.format?.(entry.cost) || ''}` : ''}`)}</span></span>
    <span class="dash-bar"><span class="dash-bar-fill" style="width:${width}%"></span></span>
   </div>`;
  };
  const folderRow = folder => `<div class="dash-folder" title="${escapeHtml(folder.path || '')}"><span class="dash-folder-name">${escapeHtml(folder.name)}</span><span class="dash-folder-path">${escapeHtml(folder.path || '')}</span><span class="dash-folder-count">${escapeHtml(`${folder.chats} · ${compact(folder.tokens)}`)}</span></div>`;
  const average = stats.conversations ? Math.round(stats.messages / stats.conversations) : 0;
  const duration = ms => {
   const total = Math.round(ms / 1000);
   if (total < 60) return `${total}s`;
   const minutes = Math.floor(total / 60) % 60, hours = Math.floor(total / 3600);
   return hours ? `${hours}h ${minutes}m` : `${minutes}m ${total % 60}s`;
  };
  const busyText = stats.busy ? I18n.t('dashboard.busyDay', { date: date(new Date(`${stats.busy[0]}T12:00:00`).getTime()), count: stats.busy[1] }) : '';
  this.panel.innerHTML = `
   <header class="dash-head">
    <span class="dash-logo">${Glyphs.ghost}</span>
    <span class="dash-title">${escapeHtml(I18n.t('dashboard.title'))}<span class="dash-sub">Prism V2${stats.version ? ` ${escapeHtml(stats.version)}` : ''}</span></span>
    <button type="button" class="dash-refresh">${escapeHtml(I18n.t('dashboard.refresh'))}</button>
    <button type="button" class="dash-close" aria-label="${escapeHtml(I18n.t('dashboard.close'))}">×</button>
   </header>
   <div class="dash-grid">
    ${card('dashboard.conversations', compact(stats.conversations), stats.pinned || stats.protected ? `${stats.pinned} ${I18n.t('dashboard.pinned').toLowerCase()} · ${stats.protected} ${I18n.t('dashboard.protected').toLowerCase()}` : I18n.t('dashboard.since') + ' ' + date(stats.created))}
    ${card('dashboard.messages', compact(stats.messages), `${I18n.t('dashboard.average')}: ${average}`)}
    ${card('dashboard.tokens', compact(stats.tokens), stats.peak ? `${I18n.t('dashboard.window')}: ${compact(stats.peak)}` : '', 'accent')}
    ${stats.spend != null ? card('dashboard.spend', window.Prices?.format?.(stats.spend) || '', '') : card('dashboard.memory', compact(stats.memory), '')}
    ${stats.spend != null ? card('dashboard.memory', compact(stats.memory), '') : ''}
    ${stats.thinking ? card('dashboard.thinking', duration(stats.thinking), '') : ''}
   </div>
   <section class="dash-section">
    <h3 class="dash-section-title">${escapeHtml(I18n.t('dashboard.mostUsed'))}</h3>
    <div class="dash-models">${models.length ? models.map(modelRow).join('') : `<div class="dash-empty">${escapeHtml(I18n.t('dashboard.none'))}</div>`}</div>
   </section>
   <section class="dash-section">
    <h3 class="dash-section-title">${escapeHtml(I18n.t('dashboard.folders'))}</h3>
    <div class="dash-folders">${stats.topFolders.length ? stats.topFolders.map(folderRow).join('') : `<div class="dash-empty">${escapeHtml(I18n.t('dashboard.none'))}</div>`}</div>
   </section>
   <footer class="dash-foot">
    <span>${escapeHtml(I18n.t('dashboard.last'))}: ${escapeHtml(date(stats.updated))}</span>
    ${busyText ? `<span>${escapeHtml(busyText)}</span>` : ''}
    ${stats.sample < stats.conversations ? `<span>${escapeHtml(I18n.t('dashboard.sample', { count: stats.sample }))}</span>` : ''}
   </footer>`;
  // Every model row wears its own little logo, the same one the picker shows.
  for (const holder of this.panel.querySelectorAll('.dash-model')) {
   const info = this.settings?.find?.(holder.dataset.model) || { id: holder.dataset.model, api: holder.dataset.model };
   const icon = window.ModelIcons?.icon?.(info);
   if (icon) holder.querySelector('.dash-model-icon')?.replaceWith(icon);
  }
  this.wire();
 }

 wire() {
  this.panel.querySelector('.dash-close')?.addEventListener('click', () => this.panel.hidePopover?.());
  this.panel.querySelector('.dash-refresh')?.addEventListener('click', () => { this.cache = null; this.show(); });
 }
}

window.Dashboard = Dashboard;
})();
