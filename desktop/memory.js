'use strict';

// Long-term memory: short facts the agent saves for later turns and other chats
// (the user's name, preferences, projects, things about itself). Lives in memory.json
// next to the rest of the app's data and stays on this computer.
const { app, ipcMain } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const file = () => path.join(app.getPath('userData'), 'memory.json');
let items = null;

function load() {
 if (items) return items;
 try {
  const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
  items = Array.isArray(data?.items) ? data.items.filter(item => item?.id && typeof item.text === 'string') : [];
 } catch {
  items = [];
 }
 return items;
}

// One write queue for the whole file: memory_save can arrive from several parallel runs, and
// a synchronous write blocked the main process for every one of them.
let writes = Promise.resolve();
function save() {
 const data = JSON.stringify({ version: 1, items: load() }, null, 2);
 writes = writes.catch(() => {}).then(async () => {
  await fs.promises.mkdir(path.dirname(file()), { recursive: true });
  const temp = `${file()}.tmp`;
  await fs.promises.writeFile(temp, data, 'utf8');
  await fs.promises.rename(temp, file());
 }).catch(() => {});
 return writes;
}

const list = () => load().map(({ id, text, created, updated }) => ({ id, text, created, updated }));

// Facts settle into memory; they don't multiply. The same fact said twice updates the
// first entry (and the app's screen reader shows it only once), and a fact that merely
// adds a detail to one already there keeps the fuller sentence. This is what stops every
// conversation from adding its own near-copy of "the user prefers X".
const clean = text => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const words = text => new Set(clean(text).split(' ').filter(word => word.length > 2));
function overlap(a, b) {
 const left = words(a), right = words(b);
 if (!left.size || !right.size) return 0;
 let shared = 0;
 for (const word of left) if (right.has(word)) shared++;
 return shared / Math.max(left.size, right.size);
}
function add(text) {
 const value = String(text || '').trim();
 if (!value) return null;
 const now = Date.now();
 const items = load();
 const wanted = clean(value);
 // The same memory, whatever the punctuation: refresh it in place.
 const same = items.find(item => clean(item.text) === wanted);
 if (same) {
  same.updated = now;
  if (value.length > same.text.length) same.text = value.slice(0, 2000);
  save();
  return { ...same, merged: true };
 }
 // A close cousin: keep the longer wording and mark it fresh rather than adding a second.
 const near = items.find(item => {
  const score = overlap(item.text, value);
  const cleanItem = clean(item.text);
  const shorter = Math.min(cleanItem.length, wanted.length);
  return score >= 0.72 || (shorter > 24 && (cleanItem.includes(wanted) || wanted.includes(cleanItem)));
 });
 if (near) {
  near.text = value.length > near.text.length ? value.slice(0, 2000) : near.text;
  near.updated = now;
  save();
  return { ...near, merged: true };
 }
 const item = { id: `mem_${crypto.randomBytes(4).toString('hex')}`, text: value.slice(0, 2000), created: now, updated: now };
 items.push(item);
 save();
 return item;
}

function update(id, text) {
 const item = load().find(entry => entry.id === id);
 if (!item) return null;
 item.text = String(text || '').slice(0, 2000);
 item.updated = Date.now();
 save();
 return item;
}

function remove(id) {
 const all = load();
 const at = all.findIndex(entry => entry.id === id);
 if (at >= 0) {
  all.splice(at, 1);
  save();
 }
 return list();
}

function register(fromApp) {
 ipcMain.handle('memory:list', event => (fromApp(event) ? list() : []));
 ipcMain.handle('memory:add', (event, text) => (fromApp(event) ? add(text) : null));
 ipcMain.handle('memory:update', (event, id, text) => (fromApp(event) ? update(id, text) : null));
 ipcMain.handle('memory:remove', (event, id) => (fromApp(event) ? remove(id) : []));
}

module.exports = { register, list, add, update, remove };
