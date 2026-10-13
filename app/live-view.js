// A chat running on another device (the desktop app, a second browser) shows up here as a
// live card at the end of the thread: the same thoughts, tool cards and answer being
// written. It is fed by the presence updates the running device publishes; when the turn
// ends the card goes away and the saved conversation is read again.
(() => {
'use strict';

const STATUS = { thinking: 'live.thinking', working: 'live.working', writing: 'live.writing' };

class LiveView {
 constructor() {
  this.el = document.createElement('div');
  this.el.className = 'message is-assistant live-card';
  const head = document.createElement('div');
  head.className = 'live-head';
  const ghost = document.createElement('span');
  ghost.className = 'live-ghost';
  ghost.innerHTML = '<ghost-thinking></ghost-thinking>';
  this.label = document.createElement('span');
  this.label.className = 'live-label';
  head.append(ghost, this.label);
  this.body = document.createElement('div');
  this.body.className = 'live-body';
  this.el.append(head, this.body);
  this.byKey = new Map();
  this.order = [];
  // Set by the page: when the thread already carries checklist boxes, they are updated in
  // place and the mirror must not draw a second one that jumps under the live head.
  this.showTodos = true;
 }

 update(info) {
  // No words next to the ghost while it is thinking: the row is just the ghost, exactly like
  // the app's own working indicator. "Working"/"Writing" still name what is happening.
  this.label.textContent = info.status === 'thinking' ? '' : I18n.t(STATUS[info.status] || 'live.working');
  // A new run on the same chat starts a fresh card: nothing from the previous run may be
  // patched with this one's data (the ids are only unique inside a run).
  if (info.started !== this.started) {
   this.started = info.started;
   for (const node of (this.byKey || new Map()).values()) node.el.remove();
   this.byKey = new Map();
   this.order = [];
   this.todoKey = '';
  }
  const parts = (Array.isArray(info.parts) ? info.parts : []).filter(part => !this.already(part));
  // Keyed by the part's own id: a long run drops its oldest lines, and a box keyed to the
  // part it belongs to keeps the fold the reader made instead of being rebuilt open.
  const byKey = this.byKey ||= new Map();
  const order = [];
  for (const [index, part] of parts.entries()) {
   const key = String(part.id || `i${index}`);
   let node = byKey.get(key);
   if (node && node.kind !== part.kind) {
    node.el.remove();
    byKey.delete(key);
    node = null;
   }
   if (!node) {
    node = this.build(part);
    byKey.set(key, node);
    this.body.append(node.el);
   }
   this.paint(node, part);
   order.push(node);
  }
  const alive = new Set(order);
  for (const [key, node] of [...byKey]) {
   if (alive.has(node)) continue;
   node.el.remove();
   byKey.delete(key);
  }
  // The lines only ever grow, so a mismatch means the oldest ones just dropped: put the rest
  // back in their order instead of rebuilding the whole card every publish.
  if (order.length !== (this.order?.length || 0) || order.some((node, at) => node !== this.order[at])) {
   for (const node of order) this.body.append(node.el);
  }
  this.order = order;
  this.todos(info.todos);
  // The checklist is the "where is it now" line and stays the LAST thing in the card: new
  // tool cards and text used to land under it and bury it mid-card.
  if (this.todoCard?.el?.parentElement === this.body && this.body.lastElementChild !== this.todoCard.el) this.body.append(this.todoCard.el);
 }

 // What the thread on screen already carries (set by the page): a call whose card is already
 // there is not drawn a second time, and neither is text or reasoning the saved copy holds —
 // a page that reloaded mid-run used to show every step twice, subagent boxes included.
 already(part) {
  const shown = this.shown;
  if (!shown) return false;
  if (part.kind === 'tool') return Boolean(part.callId) && shown.calls?.has(part.callId);
  const text = String(part.text || '');
  if (!text) return false;
  const saved = part.kind === 'thinking' ? shown.thinking : shown.content;
  return (saved || []).some(full => full === text || full.endsWith(text) || text.startsWith(full));
 }

 // The device's todo checklist, drawn from the live mirror: checkmarks move while it works,
 // instead of freezing at whatever the last saved conversation happened to hold.
 todos(items) {
  if (!this.showTodos) return;
  const list = Array.isArray(items) ? items.filter(item => item?.text) : [];
  if (!list.length) {
   this.todoCard?.el.remove();
   this.todoCard = null;
   this.todoKey = '';
   return;
  }
  const key = JSON.stringify(list);
  if (key === this.todoKey) return;
  this.todoKey = key;
  if (!window.TodoCard) return;
  const fresh = new window.TodoCard(list);
  if (this.todoCard?.el?.parentElement === this.body) this.todoCard.el.replaceWith(fresh.el);
  else this.body.append(fresh.el);
  this.todoCard = fresh;
 }

 build(part) {
  if (part.kind === 'thinking') {
   const view = new ThinkingView();
   view.setOpen(true);
   return { kind: 'thinking', el: view.el, view };
  }
  if (part.kind === 'tool') {
   // Same card the app draws: the tool name and kind ride in the mirror.
   const card = new ToolCard({ kind: part.toolKind || 'command', tool: part.tool || '', title: part.title || I18n.t('live.tool'), text: part.summary || '' });
   return { kind: 'tool', el: card.el, card, done: false };
  }
  const content = document.createElement('div');
  content.className = 'message-content markdown';
  // Rendered whole on every update rather than typed in: a mirror has to draw even when its
  // tab is in the background, where the typewriter's animation frames never run.
  return { kind: 'text', el: content, text: '' };
 }

 paint(node, part) {
  if (node.kind === 'thinking') {
   const live = Boolean(part.live);
   node.view.write(part.text || '', live);
   // The mirror used to leave the Thought box open forever: when the reasoning ends, the
   // same finish the app runs locally must run here, or Auto collapses only after a reload.
   if (!live) node.view.finish?.();
   return;
  }
  if (node.kind === 'tool') {
   if (part.state !== 'running' && !node.done) {
    node.done = true;
    node.card.setResult(part.output || '', part.state === 'error');
    if (part.ms) node.card.setDuration(part.ms);
   }
   return;
  }
  const text = String(part.text || '');
  if (text !== node.text) {
   node.text = text;
   node.cache ||= new Map();
   // The patch keeps finished blocks in place, so a code block does not blink on every update.
   if (window.StreamView?.patch) StreamView.patch(node.el, text, { cache: node.cache });
   else StreamView.render(node.el, text);
  }
 }
}

window.LiveView = LiveView;
})();
