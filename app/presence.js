// Cross-device presence: which conversations are working right now on another page.
// In web mode (`prism web`) a chat runs inside the browser tab that started it, so a phone
// opening the same server would otherwise see nothing but a quiet list. Each page publishes
// its running turns to the server, the server keeps them and broadcasts the whole picture to
// every open page — the same way the desktop app shows a ghost on a busy chat.
(() => {
'use strict';

const bridge = window.openghost?.presence || null;
const PAGE = Math.random().toString(36).slice(2, 10);
let runs = new Map();
let lastSnapshot = [];
const own = new Set();
const listeners = new Set();
// Desktop mirrors carry their own timestamp; one that stopped being refreshed (the app was
// closed mid-turn) expires here so no phantom busy ghost is left behind.
const STALE = 25000;
const fresh = entry => !entry.at || Date.now() - Number(entry.at) < STALE;

const emit = () => {
 for (const callback of [...listeners]) {
  try { callback(); } catch {}
 }
};

const read = snapshot => {
 lastSnapshot = Array.isArray(snapshot) ? snapshot : [];
 const next = new Map();
 for (const entry of lastSnapshot) {
  if (!entry || !entry.id || !fresh(entry)) continue;
  next.set(entry.id, entry);
  // A run published by this very page is ours: it must not be treated as "elsewhere".
  if (entry.origin === PAGE) own.add(entry.id);
 }
 runs = next;
 emit();
};

bridge?.onEvent?.(read);
setInterval(() => { if (runs.size) read(lastSnapshot); }, 10000);

window.Presence = {
 on(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
 },
 // This page's own turns: tell the server so other devices see them too. The origin tag
 // lets the page tell its own runs from the ones happening elsewhere.
 publish(id, info) {
  if (!bridge || !id) return;
  try { bridge.set(id, info ? { id, origin: PAGE, ...info } : null); } catch {}
  if (!info) setTimeout(() => own.delete(id), 3000);
 },
 // Conversations running on another page; the local ones are already known to Chat.
 isBusy(id) {
  return runs.has(id);
 },
 // Whether the run for this chat was started by this page rather than another device.
 ours(id) {
  return own.has(id) || runs.get(id)?.origin === PAGE;
 },
 get count() {
  let count = 0;
  for (const entry of runs.values()) if (entry.state !== 'done') count++;
  return count;
 },
 list() {
  return [...runs.values()].filter(entry => entry.state !== 'done');
 },
 info(id) {
  return runs.get(id) || null;
 },
};
})();
