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
  this.who = document.createElement('span');
  this.who.className = 'live-who';
  this.who.textContent = I18n.t('live.elsewhere');
  head.append(ghost, this.label, this.who);
  this.body = document.createElement('div');
  this.body.className = 'live-body';
  this.el.append(head, this.body);
  this.nodes = [];
 }

 update(info) {
  this.label.textContent = I18n.t(STATUS[info.status] || 'live.working');
  const parts = Array.isArray(info.parts) ? info.parts : [];
  for (let i = 0; i < parts.length; i++) {
   const part = parts[i];
   let node = this.nodes[i];
   if (!node || node.kind !== part.kind) {
    for (let k = i; k < this.nodes.length; k++) this.nodes[k].el.remove();
    this.nodes.length = i;
    node = this.build(part);
    this.nodes.push(node);
    this.body.append(node.el);
   }
   this.paint(node, part);
  }
  for (let k = parts.length; k < this.nodes.length; k++) this.nodes[k].el.remove();
  if (this.nodes.length > parts.length) this.nodes.length = parts.length;
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
   node.view.write(part.text || '', Boolean(part.live));
   return;
  }
  if (node.kind === 'tool') {
   if (part.state !== 'running' && !node.done) {
    node.done = true;
    node.card.setResult(part.output || '', part.state === 'error');
   }
   return;
  }
  const text = String(part.text || '');
  if (text !== node.text) {
   node.text = text;
   StreamView.render(node.el, text);
  }
 }
}

window.LiveView = LiveView;
})();
