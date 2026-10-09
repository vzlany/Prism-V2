(() => {
'use strict';

const INDEX = 'index';
const SAVE_DELAY = 250;
const TITLE_MAX = 60;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const baseName = path => path.split(/[\\/]/).filter(Boolean).pop() || path;
// Paths are compared the way Windows does: case-insensitive, both slash kinds, no trailing one.
const canonical = value => String(value || '').toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
const samePath = (a, b) => canonical(a) === canonical(b);
const key = path => canonical(path);
// The Discord bridge keeps its conversations in a folder of its own; it is not a workspace the
// user chose, so it must never become the default folder of a new chat.
const INTERNAL_PATH = /[\\/]Prism V2[\\/]Discord[\\/]?$/i;
const internalFolder = folder => /^[-_]/.test(String(folder?.name || '')) || INTERNAL_PATH.test(String(folder?.path || ''));

function titleFrom(text, attachments) {
 const lines = text.split('\n').map(part => part.trim()).filter(Boolean);
 const line = lines.find(part => !part.startsWith('>')) || lines[0]?.replace(/^>\s*/, '') || attachments.map(item => item.name).join(', ');
 if (!line) return I18n.t('chat.new');
 return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
}

class Library {
 constructor(store, onChange) {
  this.store = store;
  this.onChange = onChange;
  this.folders = [];
  this.chats = [];
  this.timer = 0;
  // Keys and titles of the protected chats that are open right now: they live in memory only.
  this.keys = new Map();
  this.titles = new Map();
  this.writes = new Map();
  // When this window last changed a chat or a folder: a reload from the shared store keeps
  // such an entry alive briefly (its own save may still be on the way) and drops the rest.
  this.touched = new Map();
  this.folderTouched = new Map();
  this.ready = this.load();
 }

 async load() {
  const index = await this.store.read(INDEX).catch(() => null);
  this.folders = (Array.isArray(index?.folders) ? index.folders : []).filter(folder => typeof folder?.path === 'string');
  this.chats = (Array.isArray(index?.chats) ? index.chats : []).filter(chat => chat?.id && typeof chat.folder === 'string');
  for (const chat of this.chats) {
   delete chat.archived;
   this.folder({ path: chat.folder });
  }
  this.mergeLegacyFolders();
  this.onChange();
 }

 // The web engine of an older build made the shared Chats/Public workspaces under
 // %USERPROFILE%\Prism V2 while the app made them under Documents\Prism V2, so the same
 // workspace could be listed twice. Fold the legacy record into the Documents one and move
 // its chats over; only a real pair of records is ever merged.
 mergeLegacyFolders() {
  let changed = false;
  for (let i = this.folders.length - 1; i >= 0; i--) {
   const folder = this.folders[i];
   const match = String(folder.path || '').match(/^(.*?)[\\/]Prism V2[\\/]([^\\/]+)[\\/]?$/i);
   if (!match || /[\\/]Documents[\\/]?$/i.test(match[1])) continue;
   const sep = match[1].includes('/') ? '/' : '\\';
   const candidate = `${match[1]}${sep}Documents${sep}Prism V2${sep}${match[2]}`;
   const target = this.folders.find(item => item !== folder && samePath(item.path, candidate));
   if (!target) continue;
   for (const chat of this.chats) if (samePath(chat.folder, folder.path)) chat.folder = target.path;
   if (folder.collapsed) target.collapsed = true;
   this.folders.splice(i, 1);
   changed = true;
  }
  return changed;
 }

 save() {
  clearTimeout(this.timer);
  this.timer = setTimeout(() => this.flush(), SAVE_DELAY);
 }

 flush() {
  if (this.timer) this.persist().catch(() => {});
 }

 // Writes the index at once, for a step that must be on disk before the next one starts.
 async persist() {
  clearTimeout(this.timer);
  this.timer = 0;
  // A failed read leaves the list empty; that must never wipe a healthy index on disk.
  if (!this.chats.length && !this.emptied) {
   const current = await this.store.read(INDEX).catch(() => null);
   if (Array.isArray(current?.chats) && current.chats.length) return;
  }
  this.emptied = false;
  return this.store.write(INDEX, { version: 1, folders: this.folders, chats: this.chats });
 }

 changed() {
  this.save();
  this.onChange();
 }

 folder({ path, name, temp }) {
  let folder = this.folders.find(item => samePath(item.path, path));
  if (!folder) {
   folder = { path, name: name || baseName(path), collapsed: false, added: Date.now() };
   this.folders.push(folder);
   this.folderTouched.set(key(path), Date.now());
   // A per-chat workspace (temp) is not remembered as a recent workspace.
   if (!temp) window.RecentFolders?.remember?.({ path: folder.path, name: folder.name });
   this.save();
  }
  return folder;
 }

 // The folder most recently worked in: the newest chat's folder, else the newest folder.
 // The Discord bridge's folder is skipped: a message there must not make every new chat on
 // the app (or web) start out filed under "-Discord".
 internalPath(path) {
  const folder = this.folders.find(item => samePath(item.path, path));
  return folder ? internalFolder(folder) : INTERNAL_PATH.test(String(path || ''));
 }

 lastFolder() {
  const recent = [...this.chats]
   .filter(chat => !this.internalPath(chat.folder))
   .sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
  const byChat = recent && this.folders.find(folder => samePath(folder.path, recent.folder));
  if (byChat) return byChat;
  return [...this.folders].filter(folder => !internalFolder(folder)).sort((a, b) => (b.added || 0) - (a.added || 0))[0] || null;
 }

 async pick(quick = false) {
  // A chat that just needs a folder takes the only user workspace there is.
  if (quick) {
   const mine = this.folders.filter(folder => !internalFolder(folder));
   if (mine.length === 1) {
    const only = mine[0];
    only.collapsed = false;
    only.added = Date.now();
    this.changed();
    return { path: only.path, name: only.name };
   }
  }
  const last = this.lastFolder();
  let picked = null;
  if (window.openghost?.pickFolder) {
   picked = await window.openghost.pickFolder(last ? last.path : undefined);
  } else if (window.showDirectoryPicker) {
   try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    picked = { path: handle.name, name: handle.name };
   } catch {}
  }
  if (!picked) return null;
  const folder = this.folder(picked);
  folder.collapsed = false;
  folder.added = Date.now();
  this.changed();
  return { path: folder.path, name: folder.name };
 }

 toggleFolder(path) {
  const folder = this.folders.find(item => samePath(item.path, path));
  if (!folder) return;
  folder.collapsed = !folder.collapsed;
  this.changed();
 }

 activity(folder) {
  return this.chats.reduce((last, chat) => samePath(chat.folder, folder.path) ? Math.max(last, chat.updated) : last, folder.added || 0);
 }

 chat(id) {
  return this.chats.find(chat => chat.id === id) || null;
 }

 // Another process (the desktop app, a second browser window) rewrote the index: fold in
 // the projects and chats it made, settle titles that changed there, and drop nothing that
 // is still being worked on locally. Unsaved local changes are kept: an entry the disk
 // knows is only adopted when it is newer than what this page has.
 async reload() {
  const index = await this.store.read(INDEX).catch(() => null);
  if (!index) return 0;
  const folders = (Array.isArray(index.folders) ? index.folders : []).filter(folder => typeof folder?.path === 'string');
  const chats = (Array.isArray(index.chats) ? index.chats : []).filter(chat => chat?.id && typeof chat.folder === 'string');
  let changes = 0;
  for (const folder of folders) {
   const mine = this.folders.find(item => samePath(item.path, folder.path));
   if (!mine) { this.folders.push(folder); changes++; }
   else if ((folder.added || 0) > (mine.added || 0) && !Number.isFinite(mine.order)) { Object.assign(mine, folder); changes++; }
  }
  const disk = new Map(chats.map(chat => [chat.id, chat]));
  for (const chat of this.chats) {
   const fresh = disk.get(chat.id);
   if (fresh && (fresh.updated || 0) > (chat.updated || 0)) { Object.assign(chat, fresh); changes++; }
  }
  for (const chat of chats) {
   if (this.chats.some(mine => mine.id === chat.id)) continue;
   this.chats.push(chat);
   changes++;
  }
  // A chat that is gone from the store was deleted elsewhere: drop it here too, unless this
  // window changed it a moment ago (its own save may still be on the way).
  const grace = 8000;
  for (let i = this.chats.length - 1; i >= 0; i--) {
   const chat = this.chats[i];
   if (disk.has(chat.id)) continue;
   if (Date.now() - (this.touched.get(chat.id) || 0) < grace) continue;
   this.chats.splice(i, 1);
   changes++;
  }
  for (let i = this.folders.length - 1; i >= 0; i--) {
   const folder = this.folders[i];
   if (folders.some(item => samePath(item.path, folder.path))) continue;
   if (this.chats.some(chat => samePath(chat.folder, folder.path))) continue;
   if (Date.now() - (this.folderTouched.get(key(folder.path)) || 0) < grace) continue;
   this.folders.splice(i, 1);
   changes++;
  }
  // A chat can arrive before its folder entry: make sure the folder exists for the list.
  for (const chat of this.chats) if (!folders.some(folder => samePath(folder.path, chat.folder))) this.folder({ path: chat.folder });
  if (this.mergeLegacyFolders()) changes++;
  if (changes) this.changed();
  return changes;
 }

 inFolder(folder) {
  return this.chats.filter(chat => samePath(chat.folder, folder.path));
 }

 create({ folder, text, attachments }) {
  const now = Date.now(), known = this.folder(folder);
  const chat = { id: uid(), title: titleFrom(text, attachments), folder: known.path, created: now, updated: now, pinned: false, named: false };
  this.chats.push(chat);
  this.touched.set(chat.id, now);
  this.folderTouched.set(key(known.path), now);
  this.changed();
  return chat;
 }

 update(id, changes) {
  const chat = this.chat(id);
  if (!chat) return null;
  if (chat.lock && 'title' in changes) {
   const { title, ...rest } = changes;
   this.retitle(chat, title);
   changes = rest;
  }
  Object.assign(chat, changes);
  this.touched.set(id, Date.now());
  this.changed();
  return chat;
 }

 // A protected chat's title is kept sealed. It can change only while the chat is open; locked, it keeps the old one.
 async retitle(chat, title) {
  const key = this.keys.get(chat.id);
  if (!key) return;
  this.titles.set(chat.id, title);
  chat.lock.title = await ChatLock.seal(key, { title });
  this.changed();
 }

 isProtected(id) {
  return !!this.chat(id)?.lock;
 }

 isLocked(id) {
  return this.isProtected(id) && !this.keys.has(id);
 }

 // What the list shows as a chat's title: a protected chat's is known only while it is open.
 titleOf(chat) {
  return chat.lock ? this.titles.get(chat.id) ?? null : chat.title;
 }

 remove(id) {
  const index = this.chats.findIndex(chat => chat.id === id);
  if (index < 0) return;
  this.chats.splice(index, 1);
  this.touched.delete(id);
  this.forget(id);
  this.emptied = true; // an explicit removal may legitimately leave no chats at all
  this.changed();
  this.store.remove(`chats/${id}`).catch(() => {});
 }

 // A folder's name is the app's own label for it; the directory on disk keeps its name.
 renameFolder(path, name) {
  const folder = this.folders.find(item => samePath(item.path, path));
  if (!folder) return false;
  folder.name = name;
  this.changed();
  return true;
 }

 removeFolder(path) {
  const gone = this.chats.filter(chat => samePath(chat.folder, path));
  this.chats = this.chats.filter(chat => !samePath(chat.folder, path));
  this.folders = this.folders.filter(folder => !samePath(folder.path, path));
  for (const chat of gone) { this.touched.delete(chat.id); this.forget(chat.id); }
  this.folderTouched.delete(key(path));
  this.changed();
  for (const chat of gone) this.store.remove(`chats/${chat.id}`).catch(() => {});
  return gone.map(chat => chat.id);
 }

 forget(id) {
  this.keys.delete(id);
  this.titles.delete(id);
 }

 // A sealed chat opens only with its key; without one this throws rather than hand back an empty chat that could overwrite it.
 async conversation(id) {
  const data = await this.store.read(`chats/${id}`).catch(() => null);
  const body = data?.sealed ? await ChatLock.open(this.keys.get(id), data.sealed) : data;
  return { messages: Array.isArray(body?.messages) ? body.messages : [], tokens: Number(body?.tokens) || 0, spend: body?.spend || null, todos: Array.isArray(body?.todos) ? body.todos : [] };
 }

 // A protected chat is sealed with the key it has when the save is asked for, so locking right after a reply loses nothing.
 // The todo list rides along; a call that does not pass one keeps whatever the file has.
 saveMessages(id, messages, tokens = 0, spend = null, todos = null) {
  const chat = this.chat(id), key = chat?.lock ? this.keys.get(id) : null;
  if (!chat || (chat.lock && !key)) return Promise.resolve();
  return this.queue(id, async () => {
   let kept = null;
   if (todos === null && !key) {
    const previous = await this.store.read(`chats/${id}`).catch(() => null);
    kept = Array.isArray(previous?.todos) ? previous.todos : null;
   }
   const body = { messages, tokens, ...(spend ? { spend } : {}), ...(todos ? { todos } : kept ? { todos: kept } : {}) };
   return this.store.write(`chats/${id}`, key ? { version: 1, sealed: await ChatLock.seal(key, body) } : { version: 1, ...body });
  });
 }

 // Writes of one chat's messages go out one after another, in the order they were asked for.
 queue(id, job) {
  const next = (this.writes.get(id) || Promise.resolve()).then(job).catch(() => {});
  this.writes.set(id, next);
  next.then(() => { if (this.writes.get(id) === next) this.writes.delete(id); });
  return next;
 }

 // Puts a password on a chat. The index takes the lock first and the messages are sealed after it,
 // so a crash in between leaves a protected chat whose messages are still readable, never sealed ones nothing can open.
 async protect(id, password, loaded = null) {
  const chat = this.chat(id);
  if (!chat || chat.lock) return false;
  const salt = ChatLock.salt(), key = await ChatLock.derive(password, salt);
  let done = false;
  await this.queue(id, async () => {
   const body = loaded || await this.conversation(id), title = chat.title;
   chat.lock = { version: 1, iterations: ChatLock.ITERATIONS, salt, title: await ChatLock.seal(key, { title }) };
   chat.title = '';
   try {
    await this.persist();
   } catch (error) {
    delete chat.lock;
    chat.title = title;
    throw error;
   }
   done = true;
   await this.store.write(`chats/${id}`, { version: 1, sealed: await ChatLock.seal(key, { messages: body.messages, tokens: body.tokens }) });
  });
  this.changed();
  return done;
 }

 // The password is checked against the sealed title, which only the right key opens.
 async unlock(id, password) {
  const chat = this.chat(id);
  if (!chat?.lock) return true;
  try {
   const key = await ChatLock.derive(password, chat.lock.salt, chat.lock.iterations);
   const { title } = await ChatLock.open(key, chat.lock.title);
   if (!this.keys.has(id)) this.keys.set(id, key);
   this.titles.set(id, title);
   this.onChange();
   return true;
  } catch {
   return false;
  }
 }

 relock(id) {
  if (!this.keys.has(id) && !this.titles.has(id)) return;
  this.forget(id);
  this.onChange();
 }

 // Takes the password off an open chat: the messages are written in the clear first, then the index lets go of the lock.
 async unprotect(id, loaded = null) {
  const chat = this.chat(id);
  if (!chat?.lock || !this.keys.has(id)) return false;
  let done = false;
  await this.queue(id, async () => {
   const body = loaded || await this.conversation(id);
   await this.store.write(`chats/${id}`, { version: 1, messages: body.messages, tokens: body.tokens });
   chat.title = this.titles.get(id) ?? '';
   delete chat.lock;
   this.forget(id);
   await this.persist();
   done = true;
  });
  this.changed();
  return done;
 }
}

window.Library = Library;
})();
