// A small pill beside the folder button: pick one instruction file and the agent follows it
// in every chat. The list is global — it gathers the instruction files of every workspace in
// the conversation list, grouped by folder — and the choice applies to all of them, not only
// to the folder the chat happens to be in. An older per-folder choice still works as the
// fallback until a global one is made.
// The menu can also open the current workspace's .prism folder, where an agent's
// instructions, skills and MCP files live together.
(() => {
'use strict';

const KEY = 'openghost.instructions';
const GLOBAL_KEY = 'openghost.instructionGlobal';
const readMap = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
const readGlobal = () => { try { const data = JSON.parse(localStorage.getItem(GLOBAL_KEY) || 'null'); return data?.file ? data : null; } catch { return null; } };
const escapeHtml = text => String(text ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

class InstructionsPill {
 constructor({ button, menu, chat, library }) {
  this.button = button;
  this.menu = menu;
  this.chat = chat;
  this.library = library || null;
  button.innerHTML = `${Glyphs.file}<span class="composer-instructions-text"></span>`;
  this.label = button.querySelector('.composer-instructions-text');
  button.addEventListener('click', () => this.open());
  menu.addEventListener('click', event => {
   if (event.target.closest('[data-open-folder]')) { this.openFolder(); return; }
   const item = event.target.closest('[data-file]');
   if (item) this.choose(item.dataset.folder || '', item.dataset.file || '');
  });
  this.sync();
 }

 folder() {
  const active = this.chat.active;
  if (!active) return '';
  // A draft keeps its own folder; an open chat keeps it on its record.
  return (active.record ? active.record.folder : active.folder?.path) || '';
 }

 // The global choice wins; an old per-folder choice is the fallback.
 chosen() {
  return readGlobal() || (() => {
   const folder = this.folder();
   const file = folder ? readMap()[folder] : '';
   return file ? { folder, file } : null;
  })();
 }

 sync() {
  if (!this.button) return;
  const folder = this.folder();
  this.button.hidden = !folder;
  if (!folder) return;
  const chosen = this.chosen();
  const name = chosen ? chosen.file.split(/[\\/]/).pop() : '';
  const source = chosen?.folder ? chosen.folder.split(/[\\/]/).filter(Boolean).pop() : '';
  this.label.textContent = chosen ? name : I18n.t('instructions.pick');
  this.button.classList.toggle('is-on', Boolean(chosen));
  this.button.title = chosen
   ? I18n.t('instructions.hintGlobal', { file: name, folder: source || chosen.folder })
   : I18n.t('instructions.hintEmpty');
 }

 // Every workspace's instruction files, grouped by workspace; the current folder always comes
 // first and is expanded even if the library does not know it yet.
 async folders() {
  const current = this.folder();
  const seen = new Map();
  const add = (path, name) => {
   if (!path || seen.has(path.toLowerCase())) return;
   seen.set(path.toLowerCase(), { path, name: name || path.split(/[\\/]/).filter(Boolean).pop() || path });
  };
  add(current);
  for (const folder of this.library?.folders || []) add(folder.path, folder.name);
  return [...seen.values()];
 }

 async open() {
  const current = this.folder();
  if (!current) return;
  const folders = await this.folders();
  const chosen = this.chosen();
  const groups = [];
  await Promise.all(folders.map(async folder => {
   let files = [];
   try { files = (await window.openghost?.instructions?.list?.(folder.path)) || []; } catch {}
   groups.push({ folder, files });
  }));
  groups.sort((a, b) => (a.folder.path === current ? -1 : b.folder.path === current ? 1 : a.folder.name.localeCompare(b.folder.name)));
  const fileButton = (folder, file) => {
   const name = file.split(/[\\/]/).pop();
   const on = chosen && chosen.folder.toLowerCase() === folder.path.toLowerCase() && chosen.file === file;
   return `<button type="button" class="instructions-item${on ? ' is-on' : ''}" data-folder="${escapeHtml(folder.path)}" data-file="${escapeHtml(file)}" title="${escapeHtml(`${folder.path} — ${file}`)}">${escapeHtml(name)}</button>`;
  };
  const canOpen = Boolean(window.openghost?.instructions?.open);
  this.menu.innerHTML = [
   `<div class="instructions-head">${escapeHtml(I18n.t('instructions.titleGlobal'))}</div>`,
   `<button type="button" class="instructions-item${chosen ? '' : ' is-on'}" data-folder="" data-file="">${escapeHtml(I18n.t('instructions.none'))}</button>`,
   ...groups.map(group => [
    `<div class="instructions-group">${escapeHtml(group.folder.name)}${group.folder.path === current ? ` · ${escapeHtml(I18n.t('instructions.current'))}` : ''}</div>`,
    ...group.files.map(file => fileButton(group.folder, file)),
    group.files.length ? '' : `<div class="instructions-empty">${escapeHtml(I18n.t('instructions.empty'))}</div>`,
   ].join('')),
   canOpen ? `<div class="instructions-sep" aria-hidden="true"></div><button type="button" class="instructions-open" data-open-folder>${Glyphs.folder}<span>${escapeHtml(I18n.t('instructions.open'))}</span></button>` : '',
  ].join('');
  this.menu.showPopover?.();
 }

 openFolder() {
  const folder = this.folder();
  if (!folder) return;
  this.menu.hidePopover?.();
  window.openghost?.instructions?.open?.(folder);
 }

 choose(folder, file) {
  if (!file) {
   localStorage.removeItem(GLOBAL_KEY);
  } else {
   localStorage.setItem(GLOBAL_KEY, JSON.stringify({ folder, file }));
  }
  // Mirror the choice into the store so the Discord bot follows the same instructions.
  try { Promise.resolve(window.openghost?.store?.write?.('instructions', file ? { folder, file } : {})).catch(() => {}); } catch {}
  this.menu.hidePopover?.();
  this.sync();
 }
}

window.InstructionsPill = InstructionsPill;
})();
