// Collapsible panel that shows the model's reasoning, with a clock beside it: how long the
// thinking has been going, and once it stops, how long it took.
(() => {
'use strict';

// Milliseconds under a second, seconds with a decimal under ten, then whole seconds,
// minutes, and hours — 840ms · 4.2s · 47s · 2m 05s · 1h 04m 12s.
const clock = ms => {
 if (ms < 1000) return `${Math.round(ms)}ms`;
 if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
 const total = Math.round(ms / 1000), pad = value => String(value).padStart(2, '0');
 const seconds = total % 60, minutes = Math.floor(total / 60) % 60, hours = Math.floor(total / 3600);
 if (hours) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
 if (minutes) return `${minutes}m ${pad(seconds)}s`;
 return `${total}s`;
};

class ThinkingView {
 constructor() {
  this.el = document.createElement('div');
  this.el.className = 'message-thinking';
  this.el.hidden = true;
  this.head = document.createElement('button');
  this.head.type = 'button';
  this.head.className = 'message-thinking-head';
  this.icon = document.createElement('span');
  this.icon.className = 'message-thinking-icon';
  this.icon.setAttribute('aria-hidden', 'true');
  this.icon.textContent = '\u{1F9E0}';
  this.name = document.createElement('span');
  this.name.className = 'message-thinking-name';
  const chevron = document.createElement('span');
  chevron.className = 'message-thinking-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  this.head.append(this.icon, this.name, chevron);
  this.body = document.createElement('div');
  this.body.className = 'message-thinking-body';
  this.inner = document.createElement('div');
  this.inner.className = 'message-thinking-inner';
  this.body.append(this.inner);
  this.time = document.createElement('span');
  this.time.className = 'message-thinking-time';
  this.time.hidden = true;
  this.head.append(this.time);
  this.el.append(this.head, this.body);
  this.open = false;
  this.touched = false;
  this.live = false;
  this.begun = 0;
  this.ticker = 0;
  // While the model is still writing, the box follows the newest words — but only while the
  // reader stays at the bottom. Scroll up and it holds still until they come back down.
  this.stick = true;
  this.inner.addEventListener('scroll', () => {
   const gap = this.inner.scrollHeight - this.inner.scrollTop - this.inner.clientHeight;
   this.stick = gap < 24;
  });
  this.head.addEventListener('click', () => {
   this.touched = true;
   this.setOpen(!this.open);
  });
  window.addEventListener('effects-changed', event => {
   if (event.detail?.group === 'thinking' && this.el.isConnected) this.sync();
  });
  this.sync();
 }

 // The clock lives in the header while it can be folded, and at the end of the text when the
 // box is extended and the header is gone.
 place() {
  if (this.extended) this.inner.after(this.time);
  else this.head.append(this.time);
 }

 start() {
  this.begun = performance.now();
  this.stick = true;
  this.time.hidden = false;
  const tick = () => {
   if (!this.begun) return;
   // A box that left the page must not keep a timer alive for the rest of the session.
   if (!this.el.isConnected) { this.stop(); return; }
   this.time.textContent = clock(performance.now() - this.begun);
  };
  tick();
  clearInterval(this.ticker);
  this.ticker = setInterval(tick, 100);
 }

 stop() {
  clearInterval(this.ticker);
  this.ticker = 0;
  if (!this.begun) return;
  this.elapsed = performance.now() - this.begun;
  this.time.textContent = clock(this.elapsed);
  this.begun = 0;
  this.time.hidden = this.time.textContent === '';
 }

 // A restored message brings its own duration back.
 setTime(ms) {
  if (!ms) return;
  this.elapsed = ms;
  this.begun = 0;
  this.time.textContent = clock(ms);
  this.time.hidden = false;
  this.place();
 }

 setOpen(open) {
  this.open = open;
  if (open) { this.stick = true; this.scroll(); }
  this.sync();
 }

 get extended() {
  return window.Effects?.thinkingMode === 'extended';
 }

 sync() {
  const extended = this.extended;
  // Extended: no header, no folding — the reasoning just stays on screen, as in a terminal.
  this.el.classList.toggle('is-extended', extended);
  this.el.classList.toggle('is-live', !!this.live);
  this.head.hidden = extended;
  this.place();
  this.el.classList.toggle('is-open', extended || this.open);
  this.head.setAttribute('aria-expanded', String(this.open));
  this.name.textContent = I18n.t(this.live ? 'thinking.live' : 'thinking.done');
 }

 write(text, live) {
  const was = this.live;
  this.live = Boolean(live);
  this.el.hidden = !text;
  this.text = text || '';
  if (live && !was) this.start();
  else if (!live && was) this.stop();
  if (live && !this.touched) this.open = this.extended || window.Effects?.thinkingMode !== 'closed';
  this.sync();
  this.paint();
 }

 // Reasoning is markdown too (OpenCode shows it that way): **bold**, `code`, * lists and
 // fenced blocks read as written. At most one render per ~60ms, then one when it ends; a
 // timer rather than a frame, so a hidden or throttled tab still draws it.
 paint() {
  if (this.painted === this.text || this.frame) return;
  this.frame = setTimeout(() => { this.frame = 0; this.flush(); }, 60);
 }

 flush() {
  clearTimeout(this.frame);
  this.frame = 0;
  if (this.painted === this.text) return;
  this.painted = this.text;
  if (window.StreamView?.render) StreamView.render(this.inner, this.text);
  else this.inner.textContent = this.text;
  this.scroll();
 }

 scroll() {
  if (this.open && this.stick) this.inner.scrollTop = this.inner.scrollHeight;
 }

 // The reasoning is done and a tool is about to run: the row folds back to its "Thought"
 // header so the work itself is what the eye lands on. A box the user opened by hand
 // (touched) or the always-open extended style is left alone.
 fold() {
  this.live = false;
  this.stop();
  if (this.extended || this.touched) { this.sync(); return; }
  this.open = false;
  this.sync();
 }

 finish() {
  this.live = false;
  // The clock stops even if the box never showed a word: a hidden box with a live timer was
  // how a Thought row could keep counting after the answer had already arrived.
  this.stop();
  this.flush();
  if (this.el.hidden) { this.sync(); return; }
  if (!this.touched) this.open = this.extended || window.Effects?.thinkingMode === 'open';
  this.sync();
 }
}

window.ThinkingView = ThinkingView;
})();
