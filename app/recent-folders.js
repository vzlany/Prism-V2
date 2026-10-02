// The folders a workspace was picked from before, newest first. The New Folder menu shows
// them (and lets one be forgotten); the native picker stays the last entry of the menu.
(() => {
'use strict';

const KEY = 'openghost.recentFolders';
const MAX = 8;
const key = path => String(path || '').toLowerCase();

const read = () => {
 try {
  const list = JSON.parse(localStorage.getItem(KEY) || '[]');
  return Array.isArray(list) ? list.filter(item => item?.path) : [];
 } catch {
  return [];
 }
};

const save = list => {
 try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch {}
};

window.RecentFolders = {
 list(limit = 5) {
  return read().slice(0, limit);
 },
 remember(folder) {
  if (!folder?.path) return;
  const name = folder.name || folder.path.split(/[\\/]/).pop() || folder.path;
  const rest = read().filter(item => key(item.path) !== key(folder.path));
  save([{ path: folder.path, name, at: Date.now() }, ...rest]);
 },
 forget(path) {
  save(read().filter(item => key(item.path) !== key(path)));
 },
};
})();
