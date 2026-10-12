// The files the agent attached to this task, in one panel right below the newest message of
// the conversation — under the answer, or under the last tool call when the run stopped.
// Only what the AGENT attached (attach_file) lives here: files the user sent are the user's,
// and the agent decides whether they belong to the task by attaching them. Nothing is ever
// dropped by itself — the agent can take a file back out ("detach") and the list is derived
// from the conversation plus that detach list, so a reload shows the very same files.
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
   this.signature = '';
   this.refresh();
  });
  this.refresh = this.refresh.bind(this);
 }

 // Reads the task's files out of the conversation on screen: every attach_file call, minus
 // what the agent detached. Everything is derived, so two surfaces (the desktop app and the
 // phone) always agree without syncing anything.
 current() {
  const conv = this.chat?.active;
  if (!conv || !conv.record) return { conv, files: [] };
  const detached = new Set((conv.detached || []).map(key));
  const files = [];
  const seen = new Set();
  const add = (path, name, size) => {
   const id = key(path) || key(name);
   if (!id || seen.has(id) || detached.has(id)) return;
   seen.add(id);
   files.push({
    path: String(path || ''),
    name: String(name || String(path).split(/[\\/]/).filter(Boolean).pop() || 'file'),
    size: Number(size) || 0,
   });
  };
  for (const entry of conv.messages || []) {
   if (entry.role !== 'assistant') continue;
   for (const step of entry.steps || []) {
    for (const call of step.tool_calls || []) {
     if (call.function?.name !== 'attach_file') continue;
     try {
      const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      if (args?.path && args.detach !== true) add(args.path, args.name, args.size);
     } catch {}
    }
   }
  }
  return { conv, files: files.reverse() };
 }

 refresh() {
  const { conv, files } = this.current();
  const list = conv?.list || null;
  // The panel lives at the very end of the conversation it belongs to — under the newest
  // message, tool line or live card — so it is moved back every time, before anything is
  // compared: a thread that grew would otherwise leave it buried above the newest message.
  if (list && files.length) list.append(this.root);
  const signature = `${conv?.id || ''}|${this.expanded ? 1 : 0}|${files.map(file => `${file.path}\u0000${file.name}\u0000${file.size}`).join('\u0001')}`;
  if (signature === this.signature) return;
  this.signature = signature;
  this.files = files;
  this.conv = conv;
  this.listNode = list;
  this.paint();
 }

 paint() {
  const files = this.files || [];
  this.root.hidden = !files.length;
  if (!files.length) {
   this.list.replaceChildren();
   return;
  }
  this.root.classList.add('is-in-thread');
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
  const actions = document.createElement('span');
  actions.className = 'task-file-actions';
  if (file.path) {
   const image = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(file.name);
   actions.append(
    this.action('taskfiles.preview', 'Preview', () => {
     if (image) { window.Lightbox?.open([{ url: FileUrl.of(file.path), name: file.name }], 0); return; }
     window.Artifacts?.preview?.({ path: file.path, name: file.name })?.catch?.(() => {});
    }),
    this.action('taskfiles.download', 'Download', () => {
     window.Artifacts?.save?.({ path: file.path, name: file.name });
    }),
   );
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
  actions.append(remove);
  row.append(actions);
  return row;
 }

 action(labelKey, fallback, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'task-file-action';
  button.textContent = I18n.has(labelKey) ? I18n.t(labelKey) : fallback;
  button.addEventListener('click', event => { event.stopPropagation(); onClick(); });
  return button;
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
