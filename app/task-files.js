// The files of this task, in one panel above the message box: everything the user attached
// (kept after sending) and everything the agent attached with attach_file, newest first.
// Nothing is ever dropped by itself — the agent can take a file back out ("detach") and the
// list is derived from the conversation plus that detach list, so a reload (and any other
// device) shows the very same files.
(() => {
'use strict';

const COLLAPSED = 3;
const key = value => String(value || '').replace(/\\/g, '/').toLowerCase();

class TaskFiles {
 constructor({ root, list, count, more, chat }) {
  this.root = root;
  this.list = list;
  this.count = count;
  this.more = more;
  this.chat = chat;
  this.expanded = false;
  this.signature = '';
  more.addEventListener('click', () => {
   this.expanded = !this.expanded;
   this.paint();
  });
  this.refresh = this.refresh.bind(this);
 }

 // Reads the task's files out of the conversation on screen. Everything is derived, so two
 // surfaces (the desktop app and the phone) always agree without syncing anything.
 current() {
  const conv = this.chat?.active;
  if (!conv || !conv.record) return { conv, files: [] };
  const detached = new Set((conv.detached || []).map(key));
  const files = [];
  const seen = new Set();
  const add = (path, name, size, image) => {
   const id = key(path) || key(name);
   if (!id || seen.has(id) || detached.has(id)) return;
   seen.add(id);
   files.push({
    path: String(path || ''),
    name: String(name || String(path).split(/[\\/]/).filter(Boolean).pop() || 'file'),
    size: Number(size) || 0,
    image: Boolean(image),
   });
  };
  for (const entry of conv.messages || []) {
   if (entry.role !== 'user') continue;
   for (const item of entry.attachments || []) add(item.path, item.name, item.size, item.image);
  }
  for (const entry of conv.messages || []) {
   if (entry.role !== 'assistant') continue;
   for (const step of entry.steps || []) {
    for (const call of step.tool_calls || []) {
     if (call.function?.name !== 'attach_file') continue;
     try {
      const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      if (args?.path && args.detach !== true) add(args.path, args.name, args.size, false);
     } catch {}
    }
   }
  }
  return { conv, files: files.reverse() };
 }

 refresh() {
  const { conv, files } = this.current();
  const signature = `${conv?.id || ''}|${this.expanded ? 1 : 0}|${files.map(file => `${file.path}\u0000${file.name}\u0000${file.size}`).join('\u0001')}`;
  if (signature === this.signature) return;
  this.signature = signature;
  this.files = files;
  this.conv = conv;
  this.paint();
 }

 paint() {
  const files = this.files || [];
  this.root.hidden = !files.length;
  if (!files.length) {
   this.list.replaceChildren();
   return;
  }
  this.count.textContent = String(files.length);
  const shown = this.expanded ? files : files.slice(0, COLLAPSED);
  const rows = shown.map(file => this.row(file));
  this.list.replaceChildren(...rows);
  const extra = files.length - COLLAPSED;
  this.more.hidden = extra <= 0;
  if (!this.more.hidden) {
   const text = I18n.t(this.expanded ? 'taskfiles.collapse' : 'taskfiles.expand');
   this.more.querySelector('.task-files-more-text').textContent = text;
   this.more.setAttribute('aria-expanded', String(this.expanded));
  }
 }

 row(file) {
  const row = document.createElement('div');
  row.className = 'task-file';
  row.title = file.path || file.name;
  const icon = document.createElement('span');
  icon.className = 'task-file-icon';
  icon.innerHTML = FileKinds.icon(FileKinds.describe(file.name));
  const name = document.createElement('span');
  name.className = 'task-file-name';
  name.textContent = file.name;
  row.append(icon, name);
  if (file.size) {
   const size = document.createElement('span');
   size.className = 'task-file-size';
   size.textContent = FileKinds.formatSize(file.size);
   row.append(size);
  }
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'task-file-x';
  remove.textContent = '×';
  remove.setAttribute('aria-label', I18n.t('taskfiles.unattach', { name: file.name }));
  remove.title = I18n.t('taskfiles.unattach', { name: file.name });
  remove.addEventListener('click', event => {
   event.stopPropagation();
   const conv = this.conv;
   if (!conv) return;
   // The same detach list the agent writes: the file stays on disk, the panel forgets it,
   // and a reload keeps it that way.
   conv.detached = [...new Set([...(conv.detached || []), file.path || file.name])];
   if (conv.record) this.chat.library.saveMessages(conv.id, conv.messages, conv.tokens, conv.spend || null, conv.todos?.length ? conv.todos : null, { detached: conv.detached });
   this.signature = '';
   this.refresh();
  });
  row.append(remove);
  if (file.path) {
   row.classList.add('is-openable');
   row.setAttribute('role', 'button');
   row.tabIndex = 0;
   const open = () => {
    const url = FileUrl.of(file.path);
    if (file.image) { window.Lightbox?.open([{ url, name: file.name }], 0); return; }
    window.Artifacts?.preview?.({ path: file.path, name: file.name })?.catch?.(() => {});
   };
   row.addEventListener('click', open);
   row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
  }
  return row;
 }
}

window.TaskFiles = {
 instance: null,
 create(options) {
  this.instance = new TaskFiles(options);
  this.instance.refresh();
  return this.instance;
 },
 refresh() {
  this.instance?.refresh();
 },
};
})();
