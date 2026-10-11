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
   if (event.target.closest('[data-add-file]')) { this.menu.querySelector('.instructions-file-input')?.click(); return; }
   const drop = event.target.closest('[data-remove]');
   if (drop) { this.remove(drop.dataset.removeFolder || '', drop.dataset.remove || ''); return; }
   const item = event.target.closest('[data-file]');
   if (item) this.choose(item.dataset.folder || '', item.dataset.file || '');
  });
  // On the web (a remote window, a phone) there is no file manager to open: a dropped or
  // picked file is uploaded into the workspace's .prism/instructions instead.
  menu.addEventListener('dragover', event => { if (window.openghost?.instructions?.upload) event.preventDefault(); });
  menu.addEventListener('drop', event => {
   if (!window.openghost?.instructions?.upload) return;
   event.preventDefault();
   this.upload(event.dataTransfer?.files);
  });
  menu.addEventListener('change', event => {
   if (event.target.classList?.contains('instructions-file-input')) this.upload(event.target.files);
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
   const removable = Boolean(window.openghost?.instructions?.remove);
   return `<div class="instructions-row"><button type="button" class="instructions-item${on ? ' is-on' : ''}" data-folder="${escapeHtml(folder.path)}" data-file="${escapeHtml(file)}" title="${escapeHtml(`${folder.path} — ${file}`)}">${escapeHtml(name)}</button>${removable ? `<button type="button" class="instructions-x" data-remove="${escapeHtml(file)}" data-remove-folder="${escapeHtml(folder.path)}" title="${escapeHtml(I18n.t('instructions.remove'))}" aria-label="${escapeHtml(I18n.t('instructions.remove'))}">×</button>` : ''}</div>`;
  };
  const canUpload = Boolean(window.openghost?.instructions?.upload);
  const canOpen = Boolean(window.openghost?.desktop && window.openghost?.instructions?.open);
  this.menu.innerHTML = [
   `<div class="instructions-head">${escapeHtml(I18n.t('instructions.titleGlobal'))}</div>`,
   `<button type="button" class="instructions-item${chosen ? '' : ' is-on'}" data-folder="" data-file="">${escapeHtml(I18n.t('instructions.none'))}</button>`,
   ...groups.map(group => [
    `<div class="instructions-group">${escapeHtml(group.folder.name)}${group.folder.path === current ? ` · ${escapeHtml(I18n.t('instructions.current'))}` : ''}</div>`,
    ...group.files.map(file => fileButton(group.folder, file)),
    group.files.length ? '' : `<div class="instructions-empty">${escapeHtml(I18n.t('instructions.empty'))}</div>`,
   ].join('')),
   canUpload ? `<div class="instructions-sep" aria-hidden="true"></div><button type="button" class="instructions-open" data-add-file>${Glyphs.file}<span>${escapeHtml(I18n.t('instructions.add'))}</span></button><input type="file" class="instructions-file-input" accept=".md,.txt,text/markdown,text/plain" multiple hidden>` : '',
   canOpen ? `<button type="button" class="instructions-open" data-open-folder>${Glyphs.folder}<span>${escapeHtml(I18n.t('instructions.open'))}</span></button>` : '',
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

 // The X beside a file removes it from the workspace (shared by app, web and the bot on
 // this machine). A removed file that was the chosen one clears the choice with it.
 async remove(folder, file) {
  if (!folder || !file) return;
  const ok = await window.openghost?.instructions?.remove?.(folder, file).catch(() => false);
  if (!ok) return;
  const chosen = this.chosen();
  if (chosen && chosen.folder.toLowerCase() === folder.toLowerCase() && chosen.file === file) {
   localStorage.removeItem(GLOBAL_KEY);
   try { Promise.resolve(window.openghost?.store?.write?.('instructions', {})).catch(() => {}); } catch {}
   this.sync();
  }
  await this.open();
 }

 // A picked or dropped file lands in the workspace's .prism/instructions and becomes the
 // chosen one right away, so it is in effect from the next turn on.
 async upload(files) {
  const list = [...(files || [])].slice(0, 5);
  if (!list.length) return;
  const folder = this.folder();
  if (!folder) return;
  let last = null;
  for (const file of list) {
   try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    last = await window.openghost?.instructions?.upload?.(folder, file.name, btoa(binary));
   } catch { last = null; }
  }
  if (last?.path) this.choose(folder, last.path);
  await this.open();
 }
}

window.InstructionsPill = InstructionsPill;
})();
