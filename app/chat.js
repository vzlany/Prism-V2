(() => {
'use strict';

const FOLLOW_DISTANCE = 48;
const FOLLOW_SPRING = [130, 23];
const BOTTOM_SHOW = 120;
const JUMP = { base: 420, perPixel: 0.05, max: 950 };
// A chat opens with only its newest part drawn; older messages load in batches as you scroll up.
const WINDOW_MIN = 45;
// Bigger batches, a taller pre-render and an earlier trigger: on a phone a 45-message batch
// arrived slowly enough to read as a stall, so scrolling up now finds whole messages sooner.
const WINDOW_BATCH = 80;
// How many extra entries are quietly drawn ahead of a scroll, and how close to the top a
// scroll has to get before the next batch is asked for.
const PRERENDER = 4000;
const LOAD_AHEAD = 1400;
const COPIED_TIME = 1600;
const FINISH_NOTES = ['length', 'content_filter', 'insufficient_system_resource'];
const LEAVE = { duration: 260, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'forwards' };
const SWITCH = { duration: 280, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' };
const PIN_TIME = 2000;
// The chat on screen keeps its messages under the lock screen while it fades in, then lets them go.
const LOCK_FADE = 520;
const TITLE_PROMPT = 'Name this conversation in 2 to 5 words in the language of the user message. Reply with the name only, without quotes, emoji or a final period.';
const TITLE_INPUT = { user: 1500, reply: 800, max: 60 };
// How much of another agent's report is handed back to the one that asked. The old 6000
// characters left the caller with half a list ("your report was cut off after OPT-2") while
// the agent's own chat held the rest; a report longer than this is a runaway, and even then
// the cut says so and where to read the rest.
const AGENT_REPORT = 100000;
const agentReport = text => {
 const value = String(text ?? '').trim();
 if (value.length <= AGENT_REPORT) return value;
 return `${value.slice(0, AGENT_REPORT)}\n\n[… the report is ${value.length} characters and was cut here; read the rest in the agent's own chat with agents read]`;
};
const CONTEXT = { reserve: 0.1, chars: 3.2, image: 1200 };
// How long the world around the agent (MCP tools, instruction files, skills) is kept before
// it is read again: long enough to keep long chats quick, short enough to follow edits.
const WORLD_TTL = 10000;
// A finished turn's length, spelled short: 47s · 2m 05s · 1h 04m 12s.
const spell = seconds => {
 if (seconds < 60) return `${seconds}s`;
 const pad = value => String(value).padStart(2, '0');
 const minutes = Math.floor(seconds / 60), rest = seconds % 60;
 if (minutes < 60) return `${minutes}m ${pad(rest)}s`;
 return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m ${pad(rest)}s`;
};
// The same clock the Thought row shows beside its name: 840ms · 4.2s · 47s · 2m 05s.
const thinkClock = ms => {
 if (ms < 1000) return `${Math.round(ms)}ms`;
 if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
 const total = Math.round(ms / 1000), pad = value => String(value).padStart(2, '0');
 const seconds = total % 60, minutes = Math.floor(total / 60) % 60, hours = Math.floor(total / 3600);
 if (hours) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
 if (minutes) return `${minutes}m ${pad(seconds)}s`;
 return `${total}s`;
};
const COMPACT = {
 prompt: 'You compress a long conversation between a user and Prism V2, an AI agent working on the user\'s computer, so the work can go on without the original messages. Write a dense summary in the language the user writes in, with these parts: the user\'s goals and preferences; key facts, decisions and constraints; what has been done, with file paths, commands and their results, commits; the current state and open problems; the exact next steps. Keep names, paths, numbers, versions and code identifiers exact. Leave out small talk and whatever no longer matters.',
 head: 'The earlier part of this conversation was compacted to save context. Your tools, formatting rules and browser instructions still apply; this summary does not replace them. Summary of it:',
 resume: 'Go on with the task from where you stopped, using the summary above.',
 output: 8000,
 tool: 2000,
 text: 12000,
 total: 2400000,
};
const REMOVE = { duration: 240, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'forwards' };
const TOOL_NOTES = {
 declined: 'The user declined this action. Don\'t try it again another way: say what you wanted to do and why, or choose a different approach.',
 message: 'The user didn\'t approve this and sent a new message instead, read it next.',
 cancelled: 'Cancelled: the user stopped the agent.',
 images: 'This message comes from the app, not from the user: the pictures your last tool calls returned, in order.',
 browserMessage: 'The user has taken control of the browser and sent you a message instead, read it next. The browser stays theirs until they press Hand back.',
 handedBack: 'The user took control of the browser for a while and has handed it back. The page may have changed, so this action was not done. This is the page now:',
};
const FORMAT_GUIDE = window.FormatGuide || [];

// Settings -> Prompt shows the formatting rules read-only too: they are appended to every
// answer's system prompt and are part of what Prism V2 sends by itself.
window.PrismFormat = { guide: FORMAT_GUIDE };

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// Where this window runs from: a message written on the phone shows on the desktop as
// "Website", one written in Discord shows everywhere as "Discord", and so on. A message is
// never labelled in the place it was written.
const PLATFORM = window.openghost?.desktop || window.openghostRemote ? 'app' : (window.openghost?.web ? 'web' : 'app');
// When another device's app opens this page it says who it is (?from=…) — the turns run
// here, on this machine, and the label tells the model the user is elsewhere.
const FROM_DEVICE = (() => { try { return new URLSearchParams(location.search).get('from') || ''; } catch { return ''; } })();
const attr = text => text.replace(/[&"<\n]/g, c => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '\n': ' ' })[c]);
const samePath = (a, b) => a.toLowerCase() === b.toLowerCase();

function fileBlock(item, payload) {
 let head = `<file name="${attr(item.name)}"`;
 if (item.note) head += ` note="${attr(item.note)}"`;
 // A file sent from a browser lives on the server now: its path goes to the model so a tool
 // can open the real bytes (a .jar to scan, a binary, an archive) instead of guessing.
 if (item.path) head += ` path="${attr(item.path)}"`;
 if (payload.type === 'text') return `${head}${payload.truncated ? ' truncated="true"' : ''}>\n${payload.text}\n</file>`;
 if (item.path) return `${head} size="${FileKinds.formatSize(item.size)}">The file is on this machine at the path above; its bytes were not inlined. Open it with your tools.</file>`;
 return `${head} size="${FileKinds.formatSize(item.size)}">The app could not read this file, only its name is known.</file>`;
}

async function userContent({ text, attachments }) {
 if (!attachments.length) return text;
 // A file sent from a browser is also on its way to the server; the path it answers with
 // rides in the message so the tools can open the real thing.
 const payloads = await Promise.all(attachments.map(item => item.saved
  ? Promise.all([item.ready, item.saved]).then(([payload]) => payload)
  : item.ready));
 const parts = [], files = [];
 attachments.forEach((item, k) => {
  const payload = payloads[k];
  if (payload.type !== 'image') { files.push(fileBlock(item, payload)); return; }
  const where = item.path ? ` (the original file is at ${item.path})` : '';
  const label = `Image ${item.name}${where}${item.note ? `. The user's note: ${item.note}` : ''}`;
  parts.push({ type: 'text', text: label }, { type: 'image_url', image_url: { url: payload.url } });
 });
 const body = [...files, text].filter(Boolean).join('\n\n');
 if (!parts.length) return body;
 if (body) parts.push({ type: 'text', text: body });
 return parts;
}

const slim = ({ name, size, image, width, height, note }) => ({ name, size, image: !!image, width, height, note });
const join = (base, text) => [base.trimEnd(), text.trim()].filter(Boolean).join('\n\n');
// A <send_discord_message> block: the agent talking to the user on Discord on its own.
// `@file: C:\path\shot.png` lines inside it become attachments, the rest is the message.
const DISCORD_BLOCK = /<send_discord_message>([\s\S]*?)<\/send_discord_message>/gi;
const DISCORD_SUMMARY = /<discord_summary>([\s\S]*?)<\/discord_summary>/gi;
const DISCORD_FILE = /^@(?:file|image|attach)\s*:\s*(.+)$/i;
// The agent can write to another agent from its text: <write-message_ID>…</write-message_ID>.
const AGENT_BLOCK = /<write-message[_-]([a-z0-9-]+)>([\s\S]*?)<\/write-message[_-]\1>/gi;
function parseDiscordBlock(inner) {
 const files = [], kept = [];
 for (const line of String(inner || '').replace(/\r/g, '').split('\n')) {
  const file = line.trim().match(DISCORD_FILE);
  if (file) { files.push(file[1].trim()); continue; }
  if (line.trim()) kept.push(line.trim());
 }
 return { text: kept.join('\n').trim(), files };
}
const ABSOLUTE_PATH = /^([a-zA-Z]:[\\/]|\\\\|\/)/;
const withFolder = (file, folder) => (ABSOLUTE_PATH.test(String(file || '')) || !folder
 ? String(file || '')
 : `${String(folder).replace(/[\\/]+$/, '')}\\${String(file).replace(/^[\\/]+/, '')}`);

// Simple visuals merges the tool calls of a part into one timeline line ("Explored 2 files,
// Ran 13 commands") that expands to the single steps. Each tool falls in a bucket; the
// bucket speaks in the progressive form while it works and the past form once it is done.
const SIMPLE_BUCKET = {
 read_file: 'explore', list_files: 'explore', video_frames: 'explore',
 write_file: 'write', edit_file: 'write', patch: 'write',
 run_powershell: 'run', git: 'run', http_request: 'run',
 attach_file: 'attach',
 memory_save: 'memory', memory_forget: 'memory',
 web_search: 'search', fetch_url: 'search',
 screenshot: 'shot',
};
const SIMPLE_LABEL = {
 running: { explore: 'Exploring {n} files', write: 'Editing {n} files', run: 'Running {n} commands', attach: 'Attaching {n} files', memory: 'Updating memory', search: 'Searching the web', shot: 'Taking {n} screenshots' },
 done: { explore: 'Explored {n} files', write: 'Wrote {n} files', run: 'Ran {n} commands', attach: 'Attached {n} files', memory: 'Memory updated', search: 'Searched the web', shot: 'Took {n} screenshots' },
};
const SIMPLE_ORDER = ['explore', 'write', 'run', 'attach', 'memory', 'search', 'shot'];
// The ⚡ before a tool line, gray like the 🧠 of a Thought row.
const SIMPLE_ICON = '\u26A1';
function splitQuotes(text) {
 const quotes = [];
 let rest = text || '', m;
 while ((m = rest.match(/^\s*((?:>[^\n]*(?:\n|$))+)/))) {
  quotes.push(m[1].replace(/^> ?/gm, '').trim());
  rest = rest.slice(m[0].length);
 }
 return { quotes: quotes.filter(Boolean), rest: rest.trim() };
}

function snapshot(messages) {
 const out = [];
 for (const entry of messages) {
  if (entry.role !== 'assistant' || !entry.steps) { out.push(entry); continue; }
  const steps = [];
  for (let k = 0; k < entry.steps.length; k++) {
   const step = entry.steps[k], calls = step.tool_calls?.length || 0;
   if (calls && entry.steps.slice(k + 1, k + 1 + calls).filter(next => next.role === 'tool').length < calls) break;
   steps.push(step);
  }
  if (steps.length) out.push({ ...entry, steps });
  else if (entry.content) out.push({ role: 'assistant', content: entry.content });
 }
 return out;
}

const LAST_CHAT = 'openghost.lastChat';
const PLAN_SECTION = [
 '# Plan mode',
 'You are in Plan mode: research, read and search as much as you need, but you cannot change files — writes and edits are refused by the app. When you know enough, present a short, concrete plan (numbered steps, the files to touch, the commands to run) and end with ask_user offering: "Build it" (value build), "Adjust the plan" (value adjust), "Cancel" (value cancel). If the user picks Build it, the app turns Plan mode off, so start implementing immediately without asking again. If they pick Adjust, revise the plan and ask once more.',
].join('\n');

const drop = (list, item) => {
 const at = list.indexOf(item);
 if (at >= 0) list.splice(at, 1);
};
const cut = (text, max) => text.length > max ? `${text.slice(0, max)}\n[… ${text.length - max} more characters]` : text;

// Tool messages carry text only, so pictures from tools reach the model as a user message right after the results.
function imageStep(images) {
 const content = [{ type: 'text', text: TOOL_NOTES.images }];
 for (const { label, url } of images) content.push({ type: 'text', text: label }, { type: 'image_url', image_url: { url } });
 return { role: 'user', content };
}

// A provider's own blocks (signed thinking, encrypted reasoning) ride along, so the next step can hand them back unchanged.
function assistantStep({ content, reasoning, toolCalls = [], native }) {
 const message = { role: 'assistant', content: content || '' };
 if (reasoning) message.reasoning_content = reasoning;
 if (native) message.native = native;
 if (toolCalls.length) {
  message.tool_calls = toolCalls.map((call, k) => ({
   id: call.id || `call_${Date.now().toString(36)}_${k}`,
   type: 'function',
   function: { name: call.function.name, arguments: call.function.arguments || '{}' },
  }));
 }
 return message;
}

function estimate(messages) {
 let chars = 0, images = 0;
 const add = value => {
  if (typeof value === 'string') chars += value.length;
  else if (Array.isArray(value)) for (const part of value) part.type === 'image_url' ? images++ : add(part.text);
 };
 for (const message of messages) {
  add(message.content);
  add(message.reasoning_content);
  for (const call of message.tool_calls || []) add(call.function.arguments);
 }
 return Math.ceil(chars / CONTEXT.chars) + images * CONTEXT.image;
}

const textOf = content => typeof content === 'string' ? content : (content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');

// A tool's own report of the checklist ("Todo (1/2 done):\n[x] Boil water …") reads back into
// box items: how a chat written before per-call snapshots still gets its boxes in place.
const TODO_SIGN = { x: 'done', '~': 'doing', '!': 'failed' };
function todoFromOutput(text) {
 const items = [];
 for (const line of String(text || '').split('\n')) {
  const match = /^\[([ x~!])\]\s+(.*)$/.exec(line.trim());
  if (match) items.push({ text: match[2].trim(), state: TODO_SIGN[match[1]] || 'idle' });
 }
 return items.length ? items : null;
}
const todoCallOf = messages => {
 let found = null;
 for (const entry of messages || []) for (const step of entry.steps || []) for (const call of step.tool_calls || []) if (call.function?.name === 'todo') found = call;
 return found;
};

function transcript(entries) {
 const out = [];
 for (const entry of entries) {
  if (entry.role === 'compact') out.push(`[Summary of what came before]\n${entry.summary}`);
  else if (entry.role === 'user') out.push(`User: ${cut(textOf(entry.content) || entry.text || '', COMPACT.text)}`);
  else if (entry.role === 'assistant' && !entry.steps) out.push(`Prism V2: ${cut(entry.content || '', COMPACT.text)}`);
  else if (entry.role === 'assistant') {
   for (const step of entry.steps) {
    if (step.role === 'tool') { out.push(`[Result] ${cut(step.content, COMPACT.tool)}`); continue; }
    if (step.role === 'user') { out.push(`[${step.content.filter(part => part.type === 'image_url').length} pictures from the tools were shown]`); continue; }
    if (step.content) out.push(`Prism V2: ${cut(step.content, COMPACT.text)}`);
    for (const call of step.tool_calls || []) out.push(`[Tool ${call.function.name}] ${cut(call.function.arguments, COMPACT.tool)}`);
   }
  }
 }
 const text = out.join('\n\n');
 return text.length > COMPACT.total ? `${text.slice(0, COMPACT.total / 4)}\n\n[… middle of the conversation left out …]\n\n${text.slice(-COMPACT.total * 3 / 4)}` : text;
}

function settle(root) {
 for (const animation of root.getAnimations({ subtree: true })) {
  if (animation.effect?.getComputedTiming().iterations === Infinity) continue;
  try { animation.finish(); } catch {}
 }
}

function collapse(el) {
 if (!el.isConnected) return;
 if (reducedMotion()) { el.remove(); return; }
 el.style.overflow = 'hidden';
 el.animate([{ height: `${el.offsetHeight}px`, opacity: 1 }, { height: '0px', marginTop: '0px', paddingTop: '0px', opacity: 0 }], REMOVE)
  .finished.then(() => el.remove(), () => el.remove());
}

class Conversation {
 constructor(record, list = document.createElement('div')) {
  this.record = record;
  this.folder = null;
  this.model = '';
  this.messages = [];
  this.tokens = 0;
  this.list = list;
  this.list.className = 'thread-list';
  this.list.__conversation = this;
  this.turn = null;
  this.follow = true;
  this.scrollTop = 0;
  this.unread = false;
  this.ready = null;
 }

 get id() {
  return this.record?.id || '';
 }
}

class Chat {
 constructor({ main, thread, bottom, settings, library, onChange, onList, note = '' }) {
  this.note = note;
  this.main = main;
  this.thread = thread;
  this.bottom = bottom;
  this.settings = settings;
  this.library = library;
  this.onChange = onChange;
  this.onList = onList;
  this.conversations = new Map();
  this.nodes = new WeakMap();
  this.active = null;
  this.draft = null;
  this.opening = 0;
  this.tools = 0;
  this.follow = true;
  this.lastTop = 0;
  // The scroll height at the moment following last settled. A gap that is fully explained by
  // content growth since then is the spring lagging behind, not the reader leaving.
  this.grewHeight = 0;
  // When the thread last grew (the observer sees it before the spring runs): a gap right
  // after a growth is not the reader leaving either.
  this.grewAt = 0;
  this.listHeights = new WeakMap();
  // A turn this page handed to the app or the server engine stops being "waiting" the moment
  // presence shows it working somewhere — from then on the run speaks for itself.
  window.Presence?.on?.(() => {
   for (const conv of this.conversations.values()) {
    if (conv.waiting && window.Presence?.isBusy?.(conv.id)) { clearTimeout(conv.waitingTimer); conv.waiting = 0; }
   }
  });
  // When the user last scrolled by hand (wheel, finger, keyboard, scrollbar): only then may
  // following switch off. Content-driven scroll events must not count as leaving the bottom.
  this.scrollIntent = 0;
  this.intentUp = false;
  // Set while refresh() swaps the thread: the scroll events a rebuild fires are ours, not
  // the reader's, and must neither end nor re-arm the follow.
  this.rebuilding = false;
  this.scrollFrame = 0;
  this.followFrame = 0;
  this.followLast = 0;
  this.followPos = 0;
  this.followVel = 0;
  this.followMoving = false;
  this.jumpFrame = 0;
  this.followStep = this.followStep.bind(this);
  this.pinUntil = 0;
  // When the last follow frame was scheduled: a frame that never ran (a hidden window, a
  // phone locked mid-reply) must not block every later one.
  this.followAt = 0;
  // The spinner that covers the thread while a conversation is read from disk.
  this.loadingEl = main.querySelector('.thread-loading');
  this.loadingTimer = 0;
  this.resize = new ResizeObserver(entries => {
   // Whatever changed height — a thought box unfolding, text arriving, a card appearing, and
   // just as much a box folding or a tool line collapsing: note it. A gap opening right now
   // is the spring lagging, not the reader leaving the bottom; a shrink is a fold above the
   // viewport, and the spring simply catches up with it instead of giving up.
   for (const entry of entries) {
    const height = entry.target.scrollHeight || entry.contentRect?.height || 0;
    if (Math.abs(height - (this.listHeights.get(entry.target) || 0)) > 0.5) this.grewAt = performance.now();
    this.listHeights.set(entry.target, height);
   }
   if (this.follow) {
    if (this.busy || performance.now() >= this.pinUntil) this.followBottom();
    else this.pin();
   }
   this.syncBottom();
  });
  // Coming back from a hidden page (the phone was locked, the window in the tray) leaves the
  // scroll where it stopped: a chat that was following the bottom jumps back to it.
  document.addEventListener('visibilitychange', () => {
   if (document.hidden || !this.follow) return;
   this.pin();
   this.syncBottom();
  });
  // Passive, and coalesced to one frame: a fast scroll fires far more often than the list
  // needs, and onScroll reads heights and can insert older messages.
  thread.addEventListener('scroll', () => {
   if (this.scrollFrame) return;
   this.scrollFrame = requestAnimationFrame(() => { this.scrollFrame = 0; this.onScroll(); });
  }, { passive: true });
  // Real scrolling turns following off; a Thought folding or a tool card closing above the
  // viewport fires a scroll event too, and those must not be mistaken for the reader leaving
  // the bottom (that made the page "teleport up" when a tool started or a thought ended).
  // An upward scroll must leave the bottom at once: while a reply streams, the follow spring
  // writes scrollTop every frame, and waiting for the (frame-coalesced) scroll handler lets
  // it drag the reader back down before following is switched off.
  const intent = event => {
   this.scrollIntent = performance.now();
   // A touchmove's coordinates live on its Touch objects — `event.clientY` is undefined on
   // every TouchEvent, and comparing with it meant the phone could NEVER tell an upward
   // swipe from a downward one: the follow spring kept dragging the reader back down.
   const touchY = event.touches?.[0]?.clientY ?? event.changedTouches?.[0]?.clientY;
   const up = event.type === 'wheel' ? event.deltaY < 0
    : event.type === 'scroll-intent' ? event.detail?.up === true
    : event.type === 'touchmove' ? (typeof touchY === 'number' && this.touchY != null && touchY > this.touchY)
    : event.type === 'keydown' ? ['ArrowUp', 'PageUp', 'Home'].includes(event.key)
    : false;
   // The direction of the last real gesture: onScroll only unfollows on an upward one, and
   // only ever re-arms following after a gesture that was NOT upward.
   this.intentUp = up;
   if (event.type === 'touchmove' && typeof touchY === 'number') this.touchY = touchY;
   if (up) this.leaveBottom();
  };
  thread.addEventListener('wheel', intent, { passive: true });
  thread.addEventListener('touchmove', intent, { passive: true });
  thread.addEventListener('touchstart', event => { this.touchY = event.touches?.[0]?.clientY ?? null; }, { passive: true });
  thread.addEventListener('scroll-intent', intent);
  thread.addEventListener('keydown', event => {
   if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) intent(event);
  });
  thread.addEventListener('click', event => this.onClick(event));
  // A card or Thought row opening or closing: hold the reader's place through the animation.
  // A card inside a timeline line opens it too — a line the user opened by hand must not fold
  // itself away when another line takes the stage.
  thread.addEventListener('tool-toggle', event => {
   this.holdToggle();
   const group = event.target?.closest?.('.tool-group');
   if (group) group.__touched = true;
  });
  thread.addEventListener('diagram-edit', event => this.onDiagramEdit(event));
  bottom.addEventListener('scroll-bottom', () => this.scrollToBottom());
  new RowGlide(thread);
  this.activate(this.newDraft(thread.querySelector('.thread-list') || undefined));
  this.restoreLast();
 }

 get agentMode() {
  const conv = this.active;
  return (conv?.record?.mode || conv?.mode) === 'plan' ? 'plan' : 'build';
 }

 setAgentMode(mode) {
  const conv = this.active;
  if (!conv) return;
  conv.mode = mode;
  if (conv.record) this.library.update(conv.id, { mode });
  this.onChange();
 }

 get busy() {
  return !!this.active?.turn;
 }

 get model() {
  return this.modelOf(this.active);
 }

 modelOf(conv) {
  return this.settings.resolve(conv?.record?.model || conv?.model);
 }

 config(conv) {
  return this.settings.configFor(this.modelOf(conv));
 }

 // Whether the chat has turns no summary covers yet: a new model would need them compacted first.
 hasHistory(conv = this.active) {
  const messages = conv?.messages || [], last = messages.findLastIndex(entry => entry.role === 'compact');
  return messages.slice(last + 1).some(entry => entry.role === 'user' || entry.role === 'assistant');
 }

 setModel(id) {
  const conv = this.active;
  if (!conv || conv.turn || id === this.modelOf(conv)) return;
  if (conv.record) this.library.update(conv.id, { model: id });
  else conv.model = id;
  this.settings.setModel(id);
  this.onChange();
 }

 // The model the chat worked with summarizes it first, so the new one starts from a history that fits its own window.
 switchModel(id) {
  const conv = this.active;
  if (!conv?.record || conv.turn || id === this.modelOf(conv)) return;
  if (!this.hasHistory(conv)) { this.setModel(id); return; }
  const turn = this.begin(conv, this.config(conv));
  turn.switch = this.modelOf(conv);
  turn.quiet = true;
  this.library.update(conv.id, { model: id });
  this.settings.setModel(id);
  this.openPart(conv, turn);
  const view = turn.part.view;
  view.status.remove();
  view.el.hidden = true;
  this.follow = true;
  this.onChange();
  this.drive(conv, turn);
  this.followBottom();
 }

 get activeId() {
  return this.active?.id || '';
 }

 get folder() {
  return this.active && !this.active.record ? this.active.folder : null;
 }

 get needsFolder() {
  return !!this.active && !this.active.record && !this.active.folder;
 }

 isBusy(id) {
  return !!this.conversations.get(id)?.turn || !!this.conversations.get(id)?.waiting || !!window.Presence?.isBusy?.(id);
 }

 isUnread(id) {
  return !!this.conversations.get(id)?.unread;
 }

 setFolder(folder) {
  if (!this.active || this.active.record) return;
  this.active.folder = folder;
  this.onChange();
 }

 // Reopens the chat that was on screen when the app closed; an untouched draft stays as it is.
 restoreLast() {
  const id = localStorage.getItem(LAST_CHAT);
  if (!id) return;
  this.library.ready.then(() => {
   if (localStorage.getItem(LAST_CHAT) !== id) return;
   if (this.active?.record || this.draft?.messages?.length) return;
   if (!this.library.chat(id)) {
    localStorage.removeItem(LAST_CHAT);
    return;
   }
   this.open(id).catch(() => {});
  });
 }

 // Deploy a subagent on one focused task. By default it works in the background and the call
 // returns at once — the caller keeps going and checks it with the agents tool; with wait it
 // blocks until this one's report (only for when the caller has nothing else to do).
 async deploySubagent(promptText, label = '', toolId = '', wait = false, options = {}) {
  // The parent is the run that asked for it, looked up by tool-call id, not whichever chat
  // happens to be on screen: a subagent a parallel run deploys belongs under that run.
  const caller = toolId && this.toolConvs?.get(toolId);
  const parent = (caller && this.conversations.get(caller)) || this.active;
  if (!parent?.record) return null;
  const path = parent.record.folder;
  const folder = this.library.folders.find(item => samePath(item.path, path)) || { path, name: path.split(/[\\/]/).pop() || path };
  // A subagent may run on a model of its own (a fast one for mechanical, non-coding work)
  // with its own thinking effort — chosen by the main agent when it deploys the task.
  const wanted = options && typeof options.model === 'string' && options.model.trim() ? this.settings.resolve(options.model.trim()) : '';
  const subModel = wanted && this.settings.find(wanted) ? wanted : this.modelOf(parent);
  const record = this.library.create({ folder, text: label || promptText, attachments: [] });
  // The card that started it can open it: the tool run's id leads back to this conversation.
  if (toolId) (this.subagents ||= new Map()).set(toolId, record.id);
  this.library.update(record.id, { model: subModel, subagent: true, named: true, title: String(label || 'Subagent task').slice(0, 80), parent: parent.record.id, task: String(promptText || '').replace(/\s+/g, ' ').trim().slice(0, 300) });
  const conv = new Conversation(record);
  conv.subagent = true;
  conv.folder = { path: folder.path, name: folder.name };
  conv.extraSystem = 'You are a subagent: the main agent handed you one task to complete autonomously. Work with your tools until it is done or you are certain it cannot be, then reply with a short, factual report of what you did, what you found and anything the main agent must know. You cannot ask the user questions; if something would need approval it is refused, so work around it and say so in the report. If only the agent that launched you can answer something, ask it with the agents tool (action ask) or a <write-message_ID>…</write-message_ID> block in your reply, and keep the question short.';
  this.conversations.set(record.id, conv);
  this.attach(conv);
  // Subagents are hidden from the chat list, so the Runs tab is where they are watched. The
  // prompt is shown there from the first moment, not only when the run ends.
  window.ParallelRuns?.add({ id: record.id, title: String(label || promptText).slice(0, 80), model: I18n.t('runs.subagent'), status: 'running', snippet: String(promptText).slice(0, 140), subagent: true });
  const done = wait ? new Promise(resolve => { conv.awaitDone = resolve; }) : null;
  // The task rides in the subagent's conversation like any message, tagged as coming from
  // an agent (and prefixed for the model with "[from main agent]"). Without it, a caller
  // opening a working subagent saw only its answers and wondered what it had been asked.
  const prompt = { text: promptText, attachments: [], origin: 'agent', from: parent.record.id };
  const bubble = this.userMessage(prompt);
  conv.list.append(bubble);
  const subConfig = this.settings.configFor(subModel);
  // A thinking effort the main agent asked for, when the model offers that level.
  const effort = options && typeof options.effort === 'string' ? options.effort.trim() : '';
  if (effort && Array.isArray(subConfig.efforts) && subConfig.efforts.includes(effort)) subConfig.effort = effort;
  this.run(conv, prompt, subConfig, bubble);
  this.onChange();
  // Background by default: the caller is told the id and keeps working, then checks with
  // agents list/read. Only wait:true blocks here (this one's report, 20 minutes at most).
  if (!wait) {
   return `Subagent "${String(label || promptText).slice(0, 80)}" started in the background (id ${record.id}). Keep working yourself; check it with agents list and agents read ${record.id}, ask it something with agents ask ${record.id} "…", or run agents wait to block until any of your agents finishes.`;
  }
  const report = await Promise.race([
   done,
   new Promise(resolve => setTimeout(() => resolve('(the subagent is still working; its chat holds the progress)'), 20 * 60 * 1000)),
  ]);
  // The report goes back whole; it used to be cut at 6000 characters, which is how the
  // caller ended up with a list that stopped at OPT-2.
  return agentReport(report);
 }

 // ---- Other agents: the 'agents' tool ----------------------------------------------------
 // Lets any agent (main, subagent, or a subagent's subagent) see the other runs on this
 // computer, read what one has answered — including runs that finished while nobody was
 // looking — and send one a message, optionally waiting for the answer.
 agentTarget(id, selfId) {
  const wanted = String(id || '').trim();
  const self = this.conversations.get(selfId);
  const parentId = self?.record?.parent || '';
  if (!wanted || wanted === 'main') {
   if (parentId) return this.library.chat(parentId);
   return self?.record || null;
  }
  return this.library.chat(wanted) || (selfId === wanted ? self?.record : null);
 }

 // One agent writing to another: the message lands in the target chat (tagged Agent, with
 // the sender remembered), queued when the target is mid-work, otherwise it starts a turn.
 async sendAgentMessage(targetId, text, selfId, { wait = true } = {}) {
  const record = this.library.chat(targetId);
  if (!record) return 'No such agent — call agents list first.';
  const conv = await this.ensureConversation(targetId);
  if (!conv) return 'That conversation cannot be opened (it may be locked).';
  const title = record.title || record.id;
  const prompt = { text, attachments: [], origin: 'agent', from: selfId || '' };
  if (conv.turn) this.interject(conv, prompt);
  else {
   const bubble = this.userMessage(prompt);
   conv.list.append(bubble);
   this.run(conv, prompt, this.config(conv), bubble);
  }
  if (!wait) return `Message sent to ${title}.`;
  const before = conv.messages.length, started = Date.now();
  while (Date.now() - started < 120000) {
   await new Promise(resolve => setTimeout(resolve, 1500));
   // The asker being stopped stops the wait too.
   if (this.conversations.get(selfId)?.turn?.controller?.signal?.aborted) return 'Stopped while waiting for the answer.';
   const fresh = conv.messages.slice(before).filter(message => message.role === 'assistant' && typeof message.content === 'string' && message.content.trim());
   const last = fresh[fresh.length - 1];
   if (last) return `Answer from ${title}:\n${agentReport(last.content)}`;
   if (!conv.turn && !conv.waiting) break;
  }
  const latest = [...conv.messages].reverse().find(message => message.role === 'assistant' && typeof message.content === 'string' && message.content.trim());
  return `${title} is still working — your message is delivered.${latest ? ` Newest words so far:\n${String(latest.content).trim().slice(0, 2000)}` : ''}`;
 }

 // The newest written answers of an agent, from memory when it is open, from disk otherwise.
 async agentAnswer(record, max = 2) {
  const conv = this.conversations.get(record.id);
  let messages = conv?.messages;
  if (!messages) messages = (await this.library.conversation(record.id).catch(() => ({ messages: [] }))).messages || [];
  const written = messages.filter(message => message.role === 'assistant' && typeof message.content === 'string' && message.content.trim());
  return agentReport(written.slice(-max).map(message => String(message.content).trim()).join('\n\n— — —\n\n'));
 }

 // Opens (or loads) a conversation without bringing it on screen.
 async ensureConversation(id) {
  let conv = this.conversations.get(id);
  if (conv) return conv.locked ? null : conv;
  const record = this.library.chat(id);
  if (!record || this.library.isLocked(id)) return null;
  conv = new Conversation(record);
  this.conversations.set(id, conv);
  conv.ready = this.load(conv);
  await conv.ready.catch(() => {});
  return conv.locked ? null : conv;
 }

 async agents(args = {}, toolId = '') {
  const action = String(args.action || 'list').toLowerCase();
  const selfId = this.toolConvs?.get(toolId) || this.active?.id || '';
  if (action === 'read') {
   const record = this.agentTarget(args.id, selfId);
   if (!record) return 'No such agent — call agents list first.';
   const answer = await this.agentAnswer(record);
   return answer ? `Newest from ${record.title || record.id}:\n${answer}` : `${record.title || record.id} has not written an answer yet.`;
  }
  if (action === 'wait') {
   // Block until any agent launched from this conversation finishes — for when the caller
   // truly has nothing else to do until a report lands.
   const children = this.library.chats.filter(record => record.parent === selfId);
   const isRunning = record => Boolean(this.conversations.get(record.id)?.turn) || Boolean(window.Presence?.isBusy?.(record.id));
   const running = children.filter(isRunning);
   if (!running.length) {
    const newest = [...children].sort((a, b) => (Number(b.updated) || 0) - (Number(a.updated) || 0))[0];
    return newest
     ? `No agent of yours is running. Newest finished: ${newest.title || newest.id} (id ${newest.id}) — read it with agents read ${newest.id}.`
     : 'You have no agents running or finished.';
   }
   const watched = new Set(running.map(record => record.id));
   const started = Date.now();
   while (Date.now() - started < 20 * 60 * 1000) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    // The caller being stopped stops the wait too.
    if (this.conversations.get(selfId)?.turn?.controller?.signal?.aborted) return 'Stopped while waiting.';
    const finishedId = [...watched].find(id => !isRunning(this.library.chat(id) || { id }));
    if (!finishedId) continue;
    const record = this.library.chat(finishedId) || { id: finishedId, title: finishedId };
    const answer = await this.agentAnswer(record);
    return `Agent finished: ${record.title || record.id} (id ${record.id}).${answer ? ` Its report:\n${answer}` : ' It wrote no report.'}`;
   }
   return `Still running after 20 minutes: ${[...watched].map(id => this.library.chat(id)?.title || id).join(', ')}.`;
  }
  if (action === 'ask') {
   const text = String(args.text || '').trim();
   if (!text) return 'Put the message in text.';
   const record = this.agentTarget(args.id, selfId);
   if (!record) return 'No such agent — call agents list first.';
   return this.sendAgentMessage(record.id, text, selfId, { wait: args.wait !== false });
  }
  // list
  const self = this.conversations.get(selfId);
  const parentId = self?.record?.parent || '';
  const entries = new Map();
  const add = record => {
   if (!record || entries.has(record.id) || record.id === selfId) return;
   const conv = this.conversations.get(record.id);
   entries.set(record.id, {
    id: record.id,
    title: String(this.library.titleOf?.(record) || record.title || record.id).slice(0, 60),
    model: conv ? this.modelOf(conv) : String(record.model || ''),
    running: Boolean(conv?.turn) || Boolean(window.Presence?.isBusy?.(record.id)),
    awaited: Boolean(conv?.awaitDone),
    parent: record.parent || '',
    updated: Number(record.updated) || 0,
   });
  };
  if (parentId) add(this.library.chat(parentId));
  for (const record of this.library.chats) if (record.parent || record.subagent) add(record);
  const list = [...entries.values()].sort((a, b) => (Number(b.running) - Number(a.running)) || (b.updated - a.updated)).slice(0, 30);
  if (!list.length) return 'No other agents exist in this workspace yet.';
  const ago = ms => { const s = Math.max(1, Math.round(ms / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };
  const lines = list.map(entry => {
   const flags = [];
   if (entry.id === parentId) flags.push('the conversation that started you (main)');
   if (entry.awaited) flags.push('someone is waiting for it to finish');
   if (entry.parent && entry.id !== parentId) flags.push(`child of ${this.library.chat(entry.parent)?.title || entry.parent}`);
   return `- ${entry.running ? 'RUNNING' : 'finished'} · ${entry.title} · ${entry.model || '—'} · ${ago(Date.now() - entry.updated)}${flags.length ? ` · ${flags.join('; ')}` : ''} · id ${entry.id}`;
  });
  return [`Agents in this workspace (${list.length}):`, ...lines, '', 'agents read <id> shows what one has written; agents ask <id> "…" sends it a message and waits for the answer (wait: false returns at once); "main" is the conversation that started you.'].join('\n');
 }

 // ---- The todo tool ----------------------------------------------------------------------
 // One live list per conversation, drawn as a single box that follows the work: every update
 // moves it to the newest point of the thread (where the todo tool was just called) instead
 // of leaving it behind where it first appeared. A step is idle (gray circle), doing
 // (spinning white circle), done (green check) or failed (red cross).
 async todo(args = {}, toolId = '') {
  const selfId = this.toolConvs?.get(toolId) || this.active?.id || '';
  const conv = this.conversations.get(selfId) || this.active;
  if (!conv) return 'There is no conversation to keep a todo list in.';
  const action = String(args.action || 'view').toLowerCase();
  const items = () => (conv.todos ||= []);
  const locate = text => {
   const wanted = String(text || '').trim().toLowerCase();
   if (!wanted) return -1;
   const exact = items().findIndex(item => item.text.trim().toLowerCase() === wanted);
   if (exact >= 0) return exact;
   const part = items().findIndex(item => item.text.trim().toLowerCase().includes(wanted));
   if (part >= 0) return part;
   return items().findIndex(item => wanted.includes(item.text.trim().toLowerCase()));
  };
  if (action === 'create') {
   conv.todos = (Array.isArray(args.items) ? args.items : []).map(text => ({ text: String(text).trim(), state: 'idle' })).filter(item => item.text);
  } else if (action === 'edit') {
   for (const text of Array.isArray(args.remove) ? args.remove : []) { const at = locate(text); if (at >= 0) items().splice(at, 1); }
   for (const pair of Array.isArray(args.update) ? args.update : []) { const at = locate(pair?.from); if (at >= 0 && String(pair?.to || '').trim()) items()[at].text = String(pair.to).trim(); }
   for (const text of Array.isArray(args.items) ? args.items : []) { const value = String(text).trim(); if (value && locate(value) < 0) items().push({ text: value, state: 'idle' }); }
  } else if (action === 'done') {
   const mark = (list, state) => { for (const text of Array.isArray(list) ? list : []) { const at = locate(text); if (at >= 0) items()[at].state = state; } };
   if (Array.isArray(args.doing)) for (const item of items()) if (item.state === 'doing') item.state = 'idle';
   mark(args.doing, 'doing');
   mark(args.done, 'done');
   mark(args.failed, 'failed');
  }
  if (conv.record) this.save(conv);
  const list = items();
  if (!list.length) return 'The todo list is empty.';
  const sign = { idle: '[ ]', doing: '[~]', done: '[x]', failed: '[!]' };
  const done = list.filter(item => item.state === 'done').length;
  const open = list.filter(item => item.state === 'doing' || item.state === 'idle').length;
  // The list is what the user reads when the answer feels vague — and a step left "doing"
  // after the work ended reads as if the agent were still busy. One quiet reminder closes it.
  const reminder = open ? `\n\n${open} of ${list.length} step(s) are still open. Before your final summary, mark every finished step done and every step you gave up on failed — nothing should be left as doing.` : '';
  return `Todo (${done}/${list.length} done):\n${list.map(item => `${sign[item.state] || '[ ]'} ${item.text}`).join('\n')}${reminder}`;
 }

 // The checklist lives where the work is: every todo call draws its own box right under the
 // tool line that made it (attached in place, in useTool), and it stays there — a later
 // message, tool call or answer never moves or replaces it. Continuing the conversation
 // makes a NEW box; it does not delete the last one.
 renderTodos(conv) {
  if (!conv) return;
  // Boxes drawn by an older build (a single box that used to follow the work) are cleaned up
  // once; from now on the boxes ride with their calls in the transcript.
  for (const stale of conv.list.querySelectorAll(':scope > .todo-card')) {
   if (!stale.classList.contains('is-snapshot')) stale.remove();
  }
 }

 // Boxes are static now: the "one box that steps aside for the live card" dance is gone.
 todoStandalone() {}

 // While a run works elsewhere, the states the server engine publishes land in the newest box
 // the thread already has — it stays glued under the todo call that made it, nothing jumps
 // under the "Thinking…" head, and the checklist still ticks live.
 hasTodoBoxes(conv) {
  return Boolean(conv?.list?.querySelector('.todo-card'));
 }

 // A checklist box wears the live class while the chat actually works: the "doing" spinner
 // rides on it, so a run that ended can never leave a row spinning forever.
 markTodosLive(conv, live) {
  if (!conv?.list) return;
  for (const card of conv.list.querySelectorAll('.todo-card')) card.classList.toggle('is-live', Boolean(live));
 }

 syncTodoStates(conv, todos) {
  const list = (Array.isArray(todos) ? todos : []).filter(item => item?.text);
  if (!list.length || !window.TodoCard) return;
  const old = conv?.list?.querySelector('.todo-card:last-of-type');
  if (!old) return;
  const key = JSON.stringify(list.map(item => [item.text, item.state]));
  if (old.__todoKey === key) return;
  const fresh = new window.TodoCard(list);
  fresh.el.__todoKey = key;
  fresh.el.classList.add('is-snapshot');
  fresh.el.classList.toggle('is-live', old.classList.contains('is-live'));
  old.replaceWith(fresh.el);
 }

 // What a reloaded thread already shows, for the live mirror: a call whose card is on screen
 // must not be drawn a second time, and neither is text or reasoning the saved copy holds.
 // Cached — the file copy only changes when the thread is read or rebuilt again.
 liveShown(conv) {
  if (!conv) return null;
  if (conv.shown) return conv.shown;
  const calls = new Set();
  const thinking = [];
  const content = [];
  for (const entry of conv.messages || []) {
   if (entry.role !== 'assistant') continue;
   if (entry.thinking) thinking.push(String(entry.thinking));
   if (entry.content) content.push(String(entry.content));
   for (const step of entry.steps || []) for (const call of step.tool_calls || []) if (call.id) calls.add(call.id);
  }
  conv.shown = { calls, thinking, content };
  return conv.shown;
 }

 // The thread's own cards learn what the mirror knows: a call that was still running when the
 // page read the file gets its answer — or at least its "running" look back — instead of the
 // "cut off" note, the moment the live parts carry it.
 applyLiveParts(conv, parts) {
  if (!conv?.callCards?.size) return;
  for (const part of parts || []) {
   if (part.kind !== 'tool' || !part.callId) continue;
   const card = conv.callCards.get(part.callId);
   if (!card?.el?.isConnected) continue;
   if (part.state === 'running') card.resume?.();
   else {
    card.setResult(part.output || '', part.state === 'error');
    if (part.ms) card.setDuration(part.ms);
   }
  }
 }

 // Sends the same prompt to several models at once: one chat per model, all running together.
 // With the desktop app running, every one of them is handed to the app instead.
 async runParallel(folder, models, text) {
  const ids = [];
  const delegating = Boolean(window.openghost?.delegate && window.openghost.app?.connected?.());
  for (const entry of models) {
   const record = this.library.create({ folder, text, attachments: [] });
   this.library.update(record.id, { model: `${entry.providerID}:${entry.id}`, parent: this.active?.record ? this.active.id : '' });
   const conv = new Conversation(record);
   conv.folder = { path: folder.path, name: folder.name };
   this.conversations.set(record.id, conv);
   this.attach(conv);
   if (delegating) this.delegate(conv, { text, attachments: [] });
   else this.run(conv, { text, attachments: [] }, this.config(conv), null);
   window.ParallelRuns?.add({ id: record.id, title: record.title, model: entry.name || entry.id, status: 'running', snippet: String(text).slice(0, 140) });
   ids.push(record.id);
  }
  this.onChange();
  return ids;
 }

 newDraft(list) {
  const draft = this.draft = new Conversation(null, list);
  draft.incognito = false;
  const last = this.library.lastFolder?.();
  if (last) draft.folder = { path: last.path, name: last.name };
  return draft;
 }

 newChat(folder = null) {
  const draft = this.draft || this.newDraft();
  draft.folder = folder || this.library.lastFolder?.() || null;
  draft.model = '';
  // A fresh conversation starts normal; the glass button turns the next one incognito.
  draft.incognito = false;
  this.opening++;
  localStorage.removeItem(LAST_CHAT);
  this.activate(draft);
  this.onChange();
 }

 // The glass button: incognito on or off for the conversation on screen. A draft carries the
 // flag into its record when it is first sent; a real conversation flips it on the record,
 // which hides it from the chat list and keeps the model from saving memories about it.
 toggleIncognito() {
  const conv = this.active;
  if (!conv) return false;
  conv.incognito = !conv.incognito;
  if (conv.record) this.library.update(conv.id, { incognito: conv.incognito });
  this.onChange();
  return conv.incognito;
 }

 open(id) {
  if (this.active?.id === id) return Promise.resolve();
  const token = ++this.opening;
  let conv = this.conversations.get(id), waiting = false;
  if (!conv) {
   const record = this.library.chat(id);
   if (!record) return Promise.resolve();
   conv = new Conversation(record);
   conv.incognito = Boolean(record.incognito);
   this.conversations.set(id, conv);
   // A locked chat opens onto its lock screen; its messages are read only once the password is in.
   if (this.library.isLocked(id)) conv.locked = true;
   else {
    conv.ready = this.load(conv);
    waiting = true;
   }
  }
  if (waiting) this.loading(true);
  return Promise.resolve(conv.ready).then(() => {
   if (token !== this.opening) return;
   this.loading(false);
   this.activate(conv);
   localStorage.setItem(LAST_CHAT, id);
   this.onChange();
  }).catch(error => {
   if (token === this.opening) {
    this.loading(false);
    this.loadError(conv, error);
   }
   // The reason is on screen now; callers continue instead of dying on an unhandled rejection.
   return null;
  });
 }

 // A conversation that fails to load says why, instead of a spinner that never ends. The
 // thread stays usable (the sidebar toggle is still there) and a later click tries the disk
 // again — the half-loaded conversation is forgotten here.
 loadError(conv, error) {
  if (conv?.list) {
   const reason = String(error?.message || error || 'unknown error');
   const note = document.createElement('div');
   note.className = 'message-note is-error';
   note.textContent = I18n.t('chat.loadFailed', { reason });
   conv.list.replaceChildren(note);
  }
  if (conv?.id) this.conversations.delete(conv.id);
 }

 // A conversation read from disk can take a moment. The spinner waits a beat before covering
 // the thread, so switching between small chats never flashes it.
 loading(show) {
  clearTimeout(this.loadingTimer);
  this.loadingTimer = 0;
  if (!this.loadingEl) return;
  this.main.classList.toggle('is-loading-thread', Boolean(show));
  if (!show) {
   this.loadingEl.classList.remove('is-shown');
   return;
  }
  this.loadingTimer = setTimeout(() => {
   this.loadingTimer = 0;
   this.loadingEl.classList.add('is-shown');
  }, 180);
 }

 load(conv) {
  return this.library.conversation(conv.id).then(({ messages, tokens, spend, todos, detached }) => {
   conv.messages = messages;
   conv.tokens = tokens;
   conv.spend = spend || null;
   conv.todos = Array.isArray(todos) ? todos : [];
   conv.detached = Array.isArray(detached) ? detached : [];
   conv.loadFailed = false;
   this.restore(conv);
   this.renderTodos(conv);
   window.TaskFiles?.refresh?.();
  });
 }

 isLocked(id) {
  const conv = this.conversations.get(id);
  return conv ? !!conv.locked : this.library.isLocked(id);
 }

 // Locks a protected chat: its view closes at once, and its messages leave memory as soon as no reply is being written into them.
 seal(conv, delay = 0) {
  conv.locked = true;
  const drop = () => {
   if (!conv.locked || conv.turn) return;
   this.library.relock(conv.id);
   conv.messages = [];
   conv.tokens = 0;
   conv.ready = null;
   conv.list.replaceChildren();
  };
  if (delay && !reducedMotion()) setTimeout(drop, delay);
  else drop();
 }

 lock(id) {
  const conv = this.conversations.get(id);
  if (!conv || conv.locked || !this.library.isProtected(id)) return;
  this.seal(conv, conv === this.active ? LOCK_FADE : 0);
  this.onChange();
 }

 // The password opens the chat; its messages are read again unless a reply still running kept them in memory.
 async unlock(id, password) {
  const conv = this.conversations.get(id);
  if (!conv?.locked) return true;
  if (!(await this.library.unlock(id, password))) return false;
  if (!conv.ready) {
   try {
    await (conv.ready = this.load(conv));
   } catch (error) {
    // Messages that would not open must never pass for an empty chat: a reply saved into it would overwrite them.
    conv.ready = null;
    this.library.relock(id);
    throw error;
   }
  }
  conv.locked = false;
  if (conv === this.active) {
   this.main.classList.toggle('is-empty', !conv.list.childElementCount);
   this.follow = true;
   this.pin();
   this.pinUntil = performance.now() + PIN_TIME;
  }
  this.onChange();
  return true;
 }

 // Setting a password locks the chat straight away, so the first thing its owner does is open it with the new password.
 async protect(id, password) {
  const conv = this.conversations.get(id);
  if (conv?.turn || conv?.locked) return false;
  const loaded = conv?.ready ? { messages: conv.messages, tokens: conv.tokens } : null;
  if (!(await this.library.protect(id, password, loaded))) return false;
  if (conv) this.seal(conv, conv === this.active ? LOCK_FADE : 0);
  this.onChange();
  return true;
 }

 async unprotect(id) {
  const conv = this.conversations.get(id);
  if (!conv || conv.locked) return false;
  const done = await this.library.unprotect(id, conv.ready ? { messages: conv.messages, tokens: conv.tokens } : null);
  this.onChange();
  return done;
 }

 remove(id) {
  if (localStorage.getItem(LAST_CHAT) === id) localStorage.removeItem(LAST_CHAT);
  const conv = this.conversations.get(id), record = this.library.chat(id);
  if (conv) {
   this.abort(conv);
   this.conversations.delete(id);
  }
  if (this.active?.id === id) {
   const folder = record && this.library.folders.find(item => samePath(item.path, record.folder));
   this.newChat(folder ? { path: folder.path, name: folder.name } : null);
  }
  conv?.list.remove();
 }

 removeFolder(path, ids) {
  for (const id of ids) this.remove(id);
  const gone = folder => folder && samePath(folder.path, path);
  if (this.active && !this.active.record && gone(this.active.folder)) this.newChat(null);
  if (this.draft && gone(this.draft.folder)) this.draft.folder = null;
 }

 attach(conv) {
  if (conv.list.isConnected) return;
  conv.list.classList.add('is-parked');
  this.loops(conv, true);
  this.thread.append(conv.list);
  this.onList?.(conv.list);
 }

 // Pause or resume the frames and tickers of a conversation's running turn. Parked chats
 // (parallel runs, subagents) keep streaming text into their models, but repaint nothing.
 loops(conv, parked) {
  for (const part of conv.turn?.parts || []) {
   part.view.stream?.[parked ? 'pause' : 'resume']?.();
   part.view.thinking?.[parked ? 'pause' : 'resume']?.();
  }
 }

 activate(conv) {
  const prev = this.active;
  if (prev === conv) return;
  this.stopFollow();
  if (prev) {
   prev.follow = this.follow;
   prev.scrollTop = this.thread.scrollTop;
   prev.list.classList.add('is-parked');
   this.loops(prev, true);
   this.resize.unobserve(prev.list);
   // A protected chat locks again as soon as it is left.
   if (prev.record && !prev.locked && this.library.isProtected(prev.id)) this.seal(prev);
  }
  this.attach(conv);
  this.active = conv;
  conv.unread = false;
  conv.list.classList.remove('is-parked');
  this.loops(conv, false);
  this.resize.observe(conv.list);
  const empty = !conv.list.childElementCount;
  this.main.classList.toggle('is-empty', empty && !conv.locked);
  this.follow = conv.follow;
  if (conv.follow) this.pin();
  else this.thread.scrollTop = conv.scrollTop;
  this.lastTop = this.thread.scrollTop;
  this.pinUntil = performance.now() + PIN_TIME;
  // A long conversation switching in is already a heavy paint; the fade is skipped there so
  // the switch itself stays instant.
  if (prev?.list.childElementCount && !empty && !reducedMotion() && conv.list.childElementCount < 60) conv.list.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], SWITCH);
  this.syncBottom();
 }

 pin() {
  this.thread.scrollTop = this.thread.scrollHeight;
  this.lastTop = this.thread.scrollTop;
  this.grewHeight = this.thread.scrollHeight;
 }

 stopFollow() {
  cancelAnimationFrame(this.followFrame);
  cancelAnimationFrame(this.jumpFrame);
  this.followFrame = 0;
  this.jumpFrame = 0;
  this.followAt = 0;
  this.followMoving = false;
 }

 send(text, attachments = []) {
  const conv = this.active, config = this.config(conv);
  if (conv.locked) return false;
  // The same chat cannot answer in two places at once — but pressing send must never look
  // dead. A message written while a run owns the chat somewhere else (the server engine, the
  // app, another page) is shown at once, saved with the conversation, and answered the
  // moment that run ends (the outbox below is drained by drainOutbox()).
  const busyElsewhere = (window.Presence?.isBusy?.(conv.id) || conv.waiting) && !conv.turn;
  // With the desktop app running, the turn goes there: it has the tools, the browser and its
  // own keys, so this page does not need a key of its own to send.
  const delegating = Boolean(window.openghost?.delegate && window.openghost.app?.connected?.());
  if (!config.ready && !delegating) {
   this.settings.open(I18n.t('settings.key.needed'), config.provider);
   return false;
  }
  if (!conv.record) {
   if (busyElsewhere) return false;
   if (!conv.folder) return false;
   conv.record = this.library.create({ folder: conv.folder, text, attachments, incognito: Boolean(conv.incognito) });
   this.library.update(conv.id, { model: this.modelOf(conv), ...(conv.mode === 'plan' ? { mode: 'plan' } : {}) });
   this.conversations.set(conv.id, conv);
   this.draft = null;
   localStorage.setItem(LAST_CHAT, conv.id);
  } else {
   this.library.update(conv.id, { updated: Date.now() });
  }
  for (const actions of conv.list.querySelectorAll('.message-actions')) actions.remove();
  // A send that carries ?from= comes from another device's app window: it wears the App
  // badge (with the device's name), not the Website one, and the model is told the device.
  const prompt = { text, attachments, origin: FROM_DEVICE ? 'app' : PLATFORM, ...(FROM_DEVICE ? { device: FROM_DEVICE } : {}) };
  this.follow = true;
  if (conv.turn) {
   this.interject(conv, prompt);
  } else if (busyElsewhere) {
   // A turn is running here but belongs to the server engine (a keeper run): the message is
   // handed to that run and joins it at the next step, exactly like typing during a turn in
   // the app. Anything else (the app's run, another page) keeps the outbox path.
   const info = window.Presence?.info?.(conv.id);
   if (info?.keeper && window.openghost?.run?.message) {
    const bubble = this.userMessage(prompt);
    conv.list.append(bubble);
    this.main.classList.remove('is-empty');
    const entry = { role: 'user', text: prompt.text, attachments: prompt.attachments.map(slim), content: prompt.text, origin: prompt.origin || PLATFORM, ...(prompt.device || FROM_DEVICE ? { device: prompt.device || FROM_DEVICE } : {}) };
    conv.messages.push(entry);
    this.nodes.set(entry, bubble);
    this.library.update(conv.id, { updated: Date.now() });
    this.follow = true;
    window.openghost.run.message(conv.id, prompt.text).then(result => {
     if (!result?.ok) this.queueWhileBusy(conv, prompt);
    }).catch(() => this.queueWhileBusy(conv, prompt));
    if (conv === this.active) this.followBottom();
    this.onChange();
    return true;
   }
   this.queueWhileBusy(conv, prompt);
  } else if (delegating) {
   // The desktop app is running: the turn goes there, with its tools and keys, and this page
   // watches it like any other run happening elsewhere (live card, then the saved answer).
   this.delegate(conv, prompt);
  } else if (this.serverRuns) {
   // No desktop app in reach: the turn runs in the engine serving this page (the keeper), so
   // a refresh, a switch to another conversation or a closed tab cannot stop the work.
   this.runOnServer(conv, prompt, config);
  } else {
   const bubble = this.userMessage(prompt);
   conv.list.append(bubble);
   this.main.classList.remove('is-empty');
   this.run(conv, prompt, config, bubble);
  }
  // Sending is an explicit move: show the message that was just sent, even from further up.
  this.scrollToBottom();
  return true;
 }

 // A message typed while another run owns the chat: it appears in the thread immediately (a
 // send that renders nothing reads as a broken button), is written with the conversation —
 // the server engine's next save keeps foreign user lines too — and is handed to the model
 // by drainOutbox() the moment the busy run ends.
 queueWhileBusy(conv, prompt) {
  const bubble = this.userMessage(prompt);
  conv.list.append(bubble);
  this.main.classList.remove('is-empty');
  const entry = { role: 'user', text: prompt.text, attachments: prompt.attachments.map(slim), content: prompt.text, origin: prompt.origin || PLATFORM, ...(prompt.device || FROM_DEVICE ? { device: prompt.device || FROM_DEVICE } : {}) };
  conv.messages.push(entry);
  this.nodes.set(entry, bubble);
  const note = document.createElement('div');
  note.className = 'message-note is-queued';
  note.textContent = I18n.t('chat.queued');
  bubble.append(note);
  (conv.outbox ||= []).push(prompt);
  userContent(prompt).then(content => {
   entry.content = content;
   this.save(conv).catch(() => {});
  }).catch(() => {});
  this.onChange();
  return true;
 }

 // The busy run is over: everything typed during it goes out now, as one turn on the stored
 // history (the lines are already in the conversation, so nothing is written twice). If the
 // run that ended already picked the queued line up (the model saw it in a later round and
 // answered), nothing more is owed — resuming would answer it a second time.
 drainOutbox(id) {
  const conv = this.conversations.get(id);
  if (!conv?.outbox?.length || conv.turn || conv.locked) return;
  if (window.Presence?.isBusy?.(id) || conv.waiting) return;
  conv.outbox.length = 0;
  for (const note of conv.list.querySelectorAll('.message-note.is-queued')) note.remove();
  if (conv.record) this.save(conv).catch(() => {});
  const messages = conv.messages || [];
  const lastUser = messages.map(entry => entry.role).lastIndexOf('user');
  const answered = lastUser >= 0 && messages.slice(lastUser + 1).some(entry => entry.role === 'assistant' && (String(entry.content || '').trim() || (entry.steps || []).length));
  if (answered) { this.onChange(); return; }
  this.resume(conv, this.config(conv));
  if (conv === this.active) this.followBottom();
 }

 // Whether turns from this page can run in the server engine itself: every page a build with
 // the keeper serves has the channel; the app's own window and older engines do not.
 get serverRuns() {
  return Boolean(window.openghost?.run?.start);
 }

 // The config safely shipped to the server engine: plain data only (the same fields a model
 // call needs), plus the context window for compaction decisions.
 serverConfig(config) {
  const windowOf = () => { try { return Number(this.settings.windowOf(config?.model)) || 128000; } catch { return 128000; } };
  return {
   provider: config?.provider, key: config?.key, model: config?.model,
   effort: config?.effort, vision: config?.vision, thinking: config?.thinking, output: config?.output,
   efforts: config?.efforts, context: windowOf(),
  };
 }

 // Hand a prompt to the server engine: the user's message reaches the shared store first (so
 // the keeper opens the chat with it already there), then the turn starts there. This page
 // watches it like a run on another device — live card, ghost in the list, the stop button —
 // and the conversation is saved as it goes, so a refresh loses nothing.
 async runOnServer(conv, prompt, config) {
  const bubble = this.userMessage(prompt);
  conv.list.append(bubble);
  this.main.classList.remove('is-empty');
  const entry = { role: 'user', text: prompt.text, attachments: prompt.attachments.map(slim), content: prompt.text, origin: prompt.origin || PLATFORM, ...(prompt.device || FROM_DEVICE ? { device: prompt.device || FROM_DEVICE } : {}) };
  conv.messages.push(entry);
  this.nodes.set(entry, bubble);
  conv.waiting = Date.now();
  // A hand-off whose presence never arrives must not freeze the page: after fifteen seconds
  // without a word, the chat stops looking "waiting" and the next write is handled normally.
  clearTimeout(conv.waitingTimer);
  conv.waitingTimer = setTimeout(() => {
   if (conv.waiting && !window.Presence?.isBusy?.(conv.id)) { conv.waiting = 0; this.onChange(); }
  }, 15000);
  this.onChange();
  try {
   entry.content = await userContent(prompt);
   // Saved before the run starts: the keeper reads the conversation from this very file.
   await this.library.saveMessages(conv.id, conv.messages, conv.tokens, conv.spend || null, conv.todos?.length ? conv.todos : null);
   this.library.update(conv.id, { updated: Date.now() });
   const reply = await window.openghost.run.start({
    id: `k-${Date.now().toString(36)}`,
    chatId: conv.id,
    folder: conv.record?.folder || conv.folder,
    mode: this.settings.mode,
    title: conv.record?.title || '',
    prompt: prompt.text,
    origin: prompt.origin || PLATFORM,
    config: this.serverConfig(config),
    system: await this.system(conv),
    tools: this.agent(conv) ? AgentTools.schemas : null,
   });
   if (!reply?.ok) throw new Error(reply?.error || 'the server refused the run');
   conv.keeperId = reply.id || '';
  } catch (error) {
   // The server would not take it (a locked chat, a missing store record): the turn runs
   // here instead, so the reply still comes.
   conv.waiting = 0;
   const note = document.createElement('div');
   note.className = 'message-note';
   note.textContent = I18n.t('chat.serverFallback');
   conv.list.append(note);
   this.resume(conv, config);
   if (conv === this.active) this.followBottom();
  }
 }

 // Resume an existing conversation in the server engine (a retry, a delayed pickup on this
 // page): no new user message is written, the stored history is what the model sees.
 async resumeOnServer(conv, config) {
  conv.waiting = Date.now();
  this.onChange();
  try {
   const reply = await window.openghost.run.start({
    id: `k-${Date.now().toString(36)}`,
    chatId: conv.id,
    folder: conv.record?.folder || conv.folder,
    mode: this.settings.mode,
    title: conv.record?.title || '',
    config: this.serverConfig(config),
    system: await this.system(conv),
    tools: this.agent(conv) ? AgentTools.schemas : null,
   });
   if (!reply?.ok) throw new Error(reply?.error || 'the server refused the run');
   conv.keeperId = reply.id || '';
   return true;
  } catch (error) {
   conv.waiting = 0;
   // The server would not take it after all: drive the loop on this page.
   this.resumeLocally(conv, config);
   return false;
  }
 }

 // Hand a prompt to the desktop app: the user's message is written to the shared store (so
 // the app opens the chat with it already there) and a request is dropped for it to run.
 delegate(conv, prompt) {
  const bubble = this.userMessage(prompt);
  conv.list.append(bubble);
  this.main.classList.remove('is-empty');
  const entry = { role: 'user', text: prompt.text, attachments: prompt.attachments.map(slim), content: prompt.text, origin: prompt.origin || PLATFORM, ...(prompt.device || FROM_DEVICE ? { device: prompt.device || FROM_DEVICE } : {}) };
  conv.messages.push(entry);
  this.nodes.set(entry, bubble);
  conv.waiting = Date.now();
  const requestId = `d-${Date.now().toString(36)}`;
  // The handoff can fail — the app is not running after all, or it died before reading the
  // request. Rather than leaving the message hanging, the turn falls back to this page: the
  // engine behind it is right here, so the reply still comes.
  let settled = false;
  const runHere = refused => {
   if (settled) return;
   settled = true;
   clearTimeout(conv.waitingTimer);
   conv.waiting = 0;
   if (window.Presence?.isBusy?.(conv.id)) return;
   const config = this.config(conv);
   if (!config.ready) {
    this.settings.open(I18n.t('settings.key.needed'), config.provider);
    this.onChange();
    return;
   }
   if (refused) {
    const note = document.createElement('div');
    note.className = 'message-note';
    note.textContent = I18n.t(this.serverRuns ? 'chat.serverFallback' : 'chat.delegateFallback');
    conv.list.append(note);
   }
   this.resume(conv, config);
   if (conv === this.active) this.followBottom();
  };
  clearTimeout(conv.waitingTimer);
  conv.waitingTimer = setTimeout(async () => {
   // The wait may already be over: a refusal ran it here, or the app's run arrived and the
   // presence handler cleared conv.waiting. Either way there is nothing left to decide.
   if (settled || !conv.waiting) return;
   // Presence says it is running somewhere (the app picked it up): it is not ours to run —
   // the earlier code used to fire anyway once the run ended, stamping "did not pick it up"
   // onto a turn that had actually worked.
   if (window.Presence?.isBusy?.(conv.id)) {
    clearTimeout(conv.waitingTimer);
    conv.waiting = 0;
    return;
   }
   // Ask the server whether the app ever took the request: a file already gone means it was
   // picked up and this page keeps its hands off; a file still waiting means nobody did, and
   // the turn runs here instead.
   const state = await window.openghost?.delegate?.check?.(requestId).catch(() => null);
   if (state && state.exists === false) return;
   runHere(true);
  // A quiet wait used to last 25 s before this page took over: the hand-off now falls to the
  // server engine (which keeps the run alive through anything) after a much shorter beat.
  }, 12000);
  this.onChange();
  userContent(prompt).then(content => {
   entry.content = content;
   this.library.saveMessages(conv.id, conv.messages, conv.tokens, conv.spend || null);
   window.openghost.delegate.send({ id: requestId, chatId: conv.id, at: Date.now(), model: conv.record?.model || this.modelOf(conv) });
  }).catch(() => {});
  // The server answers whether the app actually took it: a refusal falls back right away.
  try { window.openghost.delegate.onStatus?.(status => { if (status?.id === requestId && !status.ok) runHere(true); }); } catch {}
 }

 // Whether this chat is working anywhere: here, waiting for the app to pick it up, or on
 // another device. The send button becomes stop for all of them.
 get working() {
  const conv = this.active;
  return Boolean(conv && (conv.turn || conv.waiting || window.Presence?.isBusy?.(conv.id)));
 }

 // Stops the run wherever it is: a local turn is aborted here, one running in the app (or
 // another page) is asked to stop through the same bridge that started it.

 // A turn that was running on another page has finished: read the conversation again so its
 // answer shows up here without a manual reload.
 // Whether two stored entries are the same as far as the screen cares: role, turn and the
 // sizes of what they carry. The overlap check of the tail refresh rides on it.
 sameEntry(a, b) {
  if (!a || !b || a.role !== b.role) return false;
  const size = entry => [String(entry.content || '').length, String(entry.thinking || '').length, (entry.steps || []).length, String(entry.turn || '')].join('|');
  return size(a) === size(b);
 }

 async refresh(id) {
  const conv = this.conversations.get(id);
  if (!conv?.record || conv.turn || conv.locked) return;
  // A hand-off that visibly ended (or never started) is over: the stop button may return.
  if (conv.waiting && !window.Presence?.isBusy?.(id)) { clearTimeout(conv.waitingTimer); conv.waiting = 0; }
  // The thread is rebuilt from the file: a reader who was following the bottom stays on it,
  // and one who was up in the conversation is put back on the message they were reading.
  const active = conv === this.active;
  const following = this.follow;
  const anchor = active && !following ? this.anchor() : null;
  // Fast path: ask only for what arrived since an overlap of the entries already held. A long
  // conversation is megabytes; reading it whole, sending it whole and parsing it whole on
  // every refresh was the lag — and emptying the list was the jump at the end of a run.
  if (active && conv.messages.length && this.library.conversationTail) {
   const overlap = Math.min(3, conv.messages.length);
   const tail = await this.library.conversationTail(id, conv.messages.length - overlap).catch(() => null);
   if (tail && tail.from === conv.messages.length - overlap && tail.total >= conv.messages.length) {
    const known = conv.messages.slice(tail.from);
    const same = tail.messages.slice(0, overlap).length === overlap
     && tail.messages.slice(0, overlap).every((entry, k) => this.sameEntry(entry, known[k]));
    if (same) {
     const first = this.nodes.get(known[0]);
     for (const entry of known) this.nodes.get(entry)?.remove();
     conv.messages = [...conv.messages.slice(0, tail.from), ...tail.messages];
     if (tail.tokens) conv.tokens = tail.tokens;
     if (tail.spend) conv.spend = tail.spend;
     if (tail.todos?.length) conv.todos = tail.todos;
     conv.window = conv.window || { entries: [], ends: new Map(), from: 0 };
     conv.window.entries = conv.window.entries.filter(entry => !known.includes(entry));
     const frag = document.createDocumentFragment();
     for (let index = tail.from; index < conv.messages.length; index++) {
      const entry = conv.messages[index];
      if (!this.drawable(entry)) continue;
      conv.window.entries.push(entry);
      this.renderEntry(conv, entry, frag);
     }
     if (first?.isConnected) first.before(frag);
     else conv.list.append(frag);
     settle(conv.list);
     // Following stays on the bottom — pinned, not sprung (the spring moving a long list is
     // what read as "scrolls down fast"). A reader up in the conversation keeps their place.
     if (following) { this.follow = true; this.pin(); this.followPos = this.thread.scrollTop; }
     else if (anchor) this.anchorRestore(anchor);
     this.renderTodos(conv);
     window.PathChips?.enhance(conv.list, conv.record?.folder);
     this.onChange();
     return;
    }
   }
  }
  // The swap below empties the list for a moment and the browser clamps the scroll to the
  // top: a long conversation flashed its top for the length of the reload. The list is
  // hidden for exactly that moment and shown again once the reader's place is back.
  if (active) conv.list.style.visibility = 'hidden';
  this.rebuilding = true;
  try {
   conv.list.replaceChildren();
   await this.load(conv);
   if (active) {
    this.main.classList.toggle('is-empty', !conv.list.childElementCount);
    if (following) { this.follow = true; this.pin(); this.followPos = this.thread.scrollTop; }
    else if (anchor) this.anchorRestore(anchor);
   }
  } catch (error) {
   // A reload that fails (a dropped connection, a chat sealed elsewhere) must say so instead
   // of leaving an invisible, empty thread behind.
   conv.loadFailed = true;
   const note = document.createElement('div');
   note.className = 'message-note is-error';
   note.textContent = I18n.t('chat.loadFailed', { reason: String(error?.message || error) });
   conv.list.replaceChildren(note);
  } finally {
   this.rebuilding = false;
   if (active) {
    this.lastTop = this.thread.scrollTop;
    requestAnimationFrame(() => { conv.list.style.visibility = ''; });
   }
  }
  this.onChange();
 }

 // Another process (the desktop app, a second window) rewrote the index: the conversations
 // already loaded take the fresh records, so titles and flags changed there are used here.
 rebind() {
  for (const [id, conv] of this.conversations) {
   const fresh = this.library.chat(id);
   if (fresh) conv.record = fresh;
  }
 }

 // A line written by another surface while this conversation works somewhere else (a photo
 // attached in Discord, a message typed on the phone): only the user's own lines are drawn,
 // one by one. A full rebuild on every such write was why a busy conversation lagged — and
 // the parts of a running answer are covered live by the live card anyway, then arrive whole
 // with the rebuild that follows the run.
 async appendNew(id) {
  const conv = this.conversations.get(id);
  if (!conv?.record || conv.turn || conv.locked || !conv.window) return;
  const { messages } = await this.library.conversation(id).catch(() => ({ messages: null }));
  if (!Array.isArray(messages) || messages.length <= conv.messages.length) return;
  const count = list => (list || []).filter(entry => entry?.role === 'user').length;
  if (count(messages) <= count(conv.messages)) return this.refresh(id);
  const fresh = messages.slice(conv.messages.length).filter(entry => entry.role === 'user' && this.drawable(entry));
  // Nothing to draw (the run wrote assistant parts only): the file copy is NOT committed, so
  // the comparisons keep telling the truth and the end-of-run refresh catches up.
  if (!fresh.length) return;
  conv.messages = messages;
  for (const entry of fresh) {
   if (!conv.window.entries.includes(entry)) conv.window.entries.push(entry);
   this.renderEntry(conv, entry);
  }
  if (conv === this.active) {
   if (this.follow) this.followBottom();
   else this.syncBottom();
  }
  this.onChange();
 }

 stop() {
  const conv = this.active;
  if (!conv) return;
  if (conv.turn) { this.abort(conv); return; }
  // A run the server engine keeps (the keeper): the stop goes straight to it.
  const info = window.Presence?.info?.(conv.id);
  if (info?.keeper) {
   try { window.openghost?.run?.stop?.(conv.id)?.catch?.(() => {}); } catch {}
   clearTimeout(conv.waitingTimer);
   conv.waiting = 0;
   this.onChange();
   return;
  }
  if (!window.Presence?.isBusy?.(conv.id) && !conv.waiting) return;
  clearTimeout(conv.waitingTimer);
  conv.waiting = 0;
  // A request this page just handed out may live in either place: the keeper channel is told
  // (a no-op when nothing runs there), and the app gets the abort it knows (a no-op too when
  // the run never reached it).
  try { window.openghost?.run?.stop?.(conv.id)?.catch?.(() => {}); } catch {}
  window.openghost?.delegate?.send?.({ id: `s-${Date.now().toString(36)}`, type: 'abort', chatId: conv.id, at: Date.now() });
  this.onChange();
 }

 abort(conv) {
  const turn = conv.turn;
  if (!turn) return;
  // A stop pressed while the agent sits in a `wait` is the user cutting a pause short: the
  // turn still ends here, but the end-of-turn toast and Discord DM ("done" or "failed") are
  // silenced — the user just said stop, nothing finished and nothing broke.
  if (turn.toolName === 'wait') turn.stoppedWait = true;
  turn.controller.abort();
  turn.release?.('abort');
  if (turn.tool) AgentTools.cancel(turn.tool);
  for (const pending of turn.approvals) pending.card.settle('deny');
 }

 // The record a message element belongs to, the other way round: element → entry.
 entryOf(conv, el) {
  if (!conv || !el) return null;
  for (const item of conv.messages) if (this.nodes.get(item) === el) return item;
  return null;
 }

 // Steer an own prompt: the chat rewinds to just before it — the message and everything after
 // it go — and its words are handed back so they can be edited and sent again.
 async rewind(conv, entry) {
  if (!conv || !entry || conv.locked) return null;
  // A run on the server engine (or the app, or another page) may own this conversation right
  // now: editing the file under a live run was silently undone by its next save, so the run
  // is stopped first and the wait is for it to be really gone.
  if (!conv.turn && (window.Presence?.isBusy?.(conv.id) || conv.waiting)) {
   this.stop();
   const until = Date.now() + 8000;
   while (Date.now() < until && (window.Presence?.isBusy?.(conv.id) || conv.waiting)) {
    await new Promise(resolve => setTimeout(resolve, 250));
   }
   if (window.Presence?.isBusy?.(conv.id) || conv.waiting) return null;
  }
  const at = conv.messages.indexOf(entry);
  if (at < 0) return null;
  if (conv.turn) {
   const turn = conv.turn;
   this.abort(conv);
   turn.queue.length = 0; // nothing typed during the run comes back to life
  }
  const dropped = conv.messages.splice(at);
  for (const item of dropped) {
   const el = this.nodes.get(item);
   if (el && el.isConnected) el.remove();
   this.nodes.delete(item);
   conv.tokens = Math.max(0, conv.tokens - estimate([item]));
  }
  this.save(conv);
  if (conv === this.active) {
   this.follow = true;
   this.followBottom();
  }
  this.onChange();
  return entry.text || entry.content || '';
 }

 onModeChange() {
  const mode = this.settings.mode;
  for (const conv of this.conversations.values()) {
   for (const pending of conv.turn?.approvals || []) {
    if (!AgentTools.needsApproval(pending.name, pending.args, { mode, cwd: pending.cwd })) pending.card.settle('allow');
   }
  }
 }

 onScroll() {
  const top = this.thread.scrollTop, distance = this.thread.scrollHeight - top - this.thread.clientHeight;
  const now = performance.now();
  if (this.rebuilding) { this.lastTop = top; return; }
  // Any real upward scroll leaves the bottom, however small; coming back near the bottom
  // starts following again. Content-driven scroll events (cards folding, older messages
  // loading) carry no scroll intent, so they never count as the reader scrolling away — and
  // a gesture that was itself downward (a wheel nudge at the bottom) must not either, or a
  // thought box folding above the viewport would read as the reader leaving.
  if (top < this.lastTop - 1 && this.intentUp === true && now - this.scrollIntent < 900) {
   // Momentum after a flick keeps moving upwards long after the last touchmove: refreshing
   // the intent here is what makes the guards below (and the scroll anchor) back off while
   // the finger's inertia is still carrying the view.
   this.scrollIntent = now;
   this.follow = false;
   this.followHold = Math.max(this.followHold || 0, now + 1200);
  } else if (distance <= FOLLOW_DISTANCE
   && !this.followMoving && now - (this.followAt || 0) > 250 && now > (this.followHold || 0)
   && !(this.intentUp === true && now - this.scrollIntent < 2500)) {
   // Following comes back when the reader brings the view to the bottom themselves (or the
   // "scroll down" button does) — never because the follow spring just happened to be there,
   // which was the loop that made the end of a conversation impossible to leave. And never
   // while the last real gesture was an upward one: a reader slowly scrolling up used to be
   // re-armed the moment they came near the bottom and yanked back down every time.
   this.follow = true;
  }
  this.lastTop = top;
  this.syncBottom();
  this.loadOlder();
 }

 // The reader is scrolling up: stop following now and freeze the follow spring where it is.
 leaveBottom() {
  // The hold keeps the follow spring from pulling the view back while the reader is up in
  // the conversation; it also survives the programmatic scroll events a fold or a rebuild
  // fires, which used to re-arm "following" within the same second.
  this.followHold = performance.now() + 1400;
  if (!this.follow) { this.stopFollow(); this.syncBottom(); return; }
  this.follow = false;
  this.stopFollow();
  this.syncBottom();
 }

 syncBottom() {
  const thread = this.thread, distance = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
  this.bottom.classList.toggle('is-shown', !this.follow && distance > BOTTOM_SHOW);
 }

 scrollToBottom() {
  const thread = this.thread, start = thread.scrollTop;
  this.follow = true;
  this.syncBottom();
  cancelAnimationFrame(this.followFrame);
  cancelAnimationFrame(this.jumpFrame);
  this.followFrame = 0;
  this.followMoving = false;
  const gap = thread.scrollHeight - thread.clientHeight - start;
  if (reducedMotion() || gap < 2) { thread.scrollTop = thread.scrollHeight; return; }
  const duration = Math.min(JUMP.max, JUMP.base + gap * JUMP.perPixel), begin = performance.now();
  const step = now => {
   this.jumpFrame = 0;
   if (!this.follow) return;
   const p = Math.min(1, Math.max(0, (now - begin) / duration)), max = thread.scrollHeight - thread.clientHeight;
   thread.scrollTop = start + (max - start) * (1 - (1 - p) ** 4);
   this.lastTop = thread.scrollTop;
   if (p < 1) { this.jumpFrame = requestAnimationFrame(step); return; }
   this.followPos = thread.scrollTop;
   this.followBottom();
  };
  this.jumpFrame = requestAnimationFrame(step);
 }

 onDiagramEdit(event) {
  const entry = event.target.closest('.message')?.__entry, { from, to } = event.detail;
  if (!entry || !from || !entry.content.includes(from)) return;
  entry.content = entry.content.replace(from, to);
  const conv = event.target.closest('.thread-list')?.__conversation;
  if (conv?.record && conv.messages.includes(entry)) this.library.saveMessages(conv.id, conv.messages, conv.tokens);
 }

 
 // The message the reader is looking at right now: the first top-level element that reaches
 // into the viewport, with its offset from the top of it. A rebuilt thread can put the view
 // back on the same message with it (an element that survived the change is preferred, a
 // position in the conversation is the fallback).
 anchor() {
  const conv = this.active, list = conv?.list;
  if (!conv || !list?.childElementCount) return null;
  const top = this.thread.getBoundingClientRect().top;
  for (const node of list.children) {
   const rect = node.getBoundingClientRect();
   if (rect.bottom > top + 1) {
    const entry = node.__entry || null;
    return { node, index: entry ? conv.messages.indexOf(entry) : -1, offset: rect.top - top };
   }
  }
  return null;
 }

 anchorRestore(anchor) {
  const conv = this.active, list = conv?.list;
  if (!anchor || !list) return;
  // The reader's own scroll outranks any anchoring: during a gesture (or its momentum, which
  // keeps firing scroll events after the finger left) the view is not ours to adjust. A
  // rebuild that hid the list to swap it is the exception — putting the reader's place back
  // is the whole point of that anchor.
  if (!this.rebuilding && performance.now() - (this.scrollIntent || 0) < 400) return;
  let el = anchor.node?.isConnected ? anchor.node : null;
  if (!el && Number.isInteger(anchor.index) && anchor.index >= 0) {
   const entry = conv.messages[anchor.index];
   if (entry) for (const node of list.children) if (node.__entry === entry) { el = node; break; }
  }
  if (!el) return;
  const top = this.thread.getBoundingClientRect().top;
  const offset = el.getBoundingClientRect().top - top;
  if (Math.abs(offset - anchor.offset) > 0.5) {
   this.thread.scrollTop += offset - anchor.offset;
   this.lastTop = this.thread.scrollTop;
  }
 }

 // A box folding, a card collapsing, a rebuilt thread: content above the viewport changes
 // height under the reader's eyes. When the bottom is not being followed, the message they
 // were reading is pinned to its place for the length of the animation (following the bottom
 // is the spring's own job, and a real scroll gesture cancels the hold at once).
 // A tap on a tool card, a step line or a Thought row expands or collapses it — and the part
 // of the conversation the reader is looking at stays exactly where it is. The follow stops
 // chasing the bottom for the length of the animation, and the first visible message is
 // pinned back to its place while the content above or below it changes height.
 holdToggle() {
  const anchor = this.anchor();
  const until = performance.now() + 700;
  this.followHold = Math.max(this.followHold || 0, until);
  if (!anchor) return;
  const step = () => {
   if (this.intentUp && performance.now() - this.scrollIntent < 400) return;
   this.anchorRestore(anchor);
   if (performance.now() < until) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
 }

 holdView(work) {
  if (this.follow) return typeof work === 'function' ? work() : undefined;
  if (performance.now() - (this.scrollIntent || 0) < 400) return typeof work === 'function' ? work() : undefined;
  const anchor = this.anchor();
  const out = typeof work === 'function' ? work() : undefined;
  if (!anchor) return out;
  const until = performance.now() + 600;
  const step = () => {
   if (performance.now() - this.scrollIntent < 400) return;
   this.anchorRestore(anchor);
   if (performance.now() < until) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return out;
 }

 followBottom() {
  if (!this.follow || this.jumpFrame) return;
  if (performance.now() < (this.followHold || 0)) return;
  // Content that just grew — a thought box unfolding, a tool card appearing, a batch of text
  // arriving — opens a gap the spring has not closed yet. That is not the reader leaving the
  // bottom, and treating it as one was why the "scroll down" hint flashed on while the page
  // sat at the bottom. Only a gap that is NOT explained by growth (or a scroll position
  // pulled away from our own writes) really ends the follow.
  const distance = this.thread.scrollHeight - this.thread.scrollTop - this.thread.clientHeight;
  if (distance > FOLLOW_DISTANCE) {
   const now = performance.now();
   const changed = this.thread.scrollHeight > this.grewHeight + 0.5 || now - this.grewAt < 600;
   const userLeft = this.intentUp === true && now - this.scrollIntent < 900;
   const pulledUp = this.thread.scrollTop < this.followPos - 8;
   if (userLeft || (pulledUp && !changed)) { this.leaveBottom(); return; }
  }
  // A frame that was scheduled but never ran (the window went hidden before it fired) is
  // stale: it is replaced instead of blocking the follow forever.
  if (this.followFrame && performance.now() - this.followAt < 250) return;
  if (!this.followMoving) {
   this.followPos = this.thread.scrollTop;
   this.followVel = 0;
  }
  this.followLast = performance.now();
  this.scheduleFollow();
 }

 scheduleFollow() {
  cancelAnimationFrame(this.followFrame);
  this.followAt = performance.now();
  this.followFrame = requestAnimationFrame(this.followStep);
 }

 followStep(now) {
  this.followFrame = 0;
  const thread = this.thread, max = thread.scrollHeight - thread.clientHeight;
  // The spring itself is the settling point: from here on, the current height is the basis
  // the next gap is measured against.
  this.grewHeight = thread.scrollHeight;
  if (!this.follow || reducedMotion()) {
   if (this.follow) thread.scrollTop = max;
   this.followMoving = false;
   return;
  }
  if (Math.abs(thread.scrollTop - this.followPos) > 1.5) {
   this.followPos = thread.scrollTop;
   this.followVel = 0;
  }
  const dt = Math.min(Math.max((now - this.followLast) / 1000, 0), 0.05), [k, c] = FOLLOW_SPRING;
  this.followLast = now;
  const steps = Math.max(1, Math.ceil(dt / 0.004)), h = dt / steps;
  for (let i = 0; i < steps; i++) {
   this.followVel += ((max - this.followPos) * k - this.followVel * c) * h;
   this.followPos += this.followVel * h;
  }
  if (this.followPos >= max) {
   this.followPos = max;
   this.followVel = Math.min(0, this.followVel);
  }
  if (max - this.followPos < 0.5 && Math.abs(this.followVel) < 4) {
   thread.scrollTop = max;
   this.followPos = thread.scrollTop;
   this.lastTop = thread.scrollTop;
   this.followMoving = false;
   return;
  }
  thread.scrollTop = this.followPos;
  this.lastTop = thread.scrollTop;
  this.followMoving = true;
  this.scheduleFollow();
 }

 async onClick(event) {
  const button = event.target.closest('.md-copy');
  if (!button) return;
  const own = button.classList.contains('message-copy');
  const text = own ? this.copyText(button.closest('.message')) : button.closest('.md-code, .md-calc').querySelector('pre').textContent;
  const ok = await (window.Clip?.text ? window.Clip.text(text) : navigator.clipboard.writeText(text).then(() => true, () => false));
  if (!ok) return;
  button.classList.add('is-copied');
  button.setAttribute('aria-label', I18n.t('code.copied'));
  clearTimeout(button.copiedTimer);
  button.copiedTimer = setTimeout(() => {
   button.classList.remove('is-copied');
   button.setAttribute('aria-label', I18n.t(own ? 'message.copy' : 'code.copy'));
  }, COPIED_TIME);
 }

 copyText(el) {
  const entry = el.__entry;
  if (!entry?.turn) return entry?.content ?? '';
  const messages = el.closest('.thread-list')?.__conversation?.messages || [];
  const parts = messages.filter(item => item.role === 'assistant' && item.turn === entry.turn && item.content?.trim());
  return parts.length ? parts.map(item => item.content.trim()).join('\n\n') : entry.content;
 }

 agent(conv) {
  return AgentTools.available && /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(conv.record?.folder || '');
 }

 begin(conv, config) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const turn = conv.turn = { id, controller: new AbortController(), config, started: Date.now(), part: null, parts: [], next: null, queue: [], approvals: new Set(), tool: '', text: false, liveAt: 0, liveTimer: 0, liveBeat: 0 };
  // A slow beat keeps the mirror fresh while the turn lives, so a reader can tell a live run
  // from one left behind by a closed app.
  turn.liveBeat = setInterval(() => this.publishLive(conv, turn), 4000);
  // The first running turn keeps the hidden window un-throttled; the last one to end gives
  // the throttle back (see end()).
  if (this.activeTurns() === 1) window.openghost?.setActiveTurn?.(true);
  return turn;
 }

 // How many conversations are running a turn right now (parallel runs and subagents included).
 activeTurns() {
  let count = 0;
  for (const conv of this.conversations.values()) if (conv.turn) count++;
  return count;
 }

 // A finished <send_discord_message> block: sent to the user's Discord DM (with any files and
 // pictures) and removed from the reply, so the chat shows only the real answer. A block that
 // is still being written stays in the text until its closing tag arrives.
 flushDiscord(conv, part) {
  const content = String(part.entry.content || '');
  if (!content.includes('<send_discord_message>')) return;
  const pending = [];
  let match;
  DISCORD_BLOCK.lastIndex = 0;
  while ((match = DISCORD_BLOCK.exec(content))) pending.push(parseDiscordBlock(match[1]));
  if (!pending.length) return;
  // The stream rebuilds the entry text on every delta, so a finished block reappears in it:
  // remembering what was sent keeps one block from going out again and again while the reply
  // is still being written (a screenshot used to arrive seven times for this reason).
  part.sentDiscord ||= new Set();
  const folder = conv.record?.folder || '';
  for (const block of pending) {
   const key = `${block.text}\u0000${block.files.join('\u0000')}`;
   if (part.sentDiscord.has(key)) continue;
   part.sentDiscord.add(key);
   // The result is checked: a block that could not be sent stays visible as a note instead of
   // disappearing (the agent "used the tool" and the user saw nothing arrive).
   Promise.resolve(window.openghost?.discord?.message?.({
    text: block.text,
    files: block.files.map(file => withFolder(file, folder)),
    chatId: conv.record?.id || conv.id,
   })).then(result => {
    if (result && result.ok === false) {
     const note = document.createElement('div');
     note.className = 'message-note';
     note.textContent = I18n.t('chat.discordFailed', { reason: result.error || 'unknown' });
     part.view?.el?.append(note);
    }
   }).catch(() => {});
  }
  part.entry.content = content.replace(DISCORD_BLOCK, '').replace(/\n{3,}/g, '\n\n').trim();
 }

 // A <discord_summary> block: the agent's own text for the finish DM. A complete block leaves
 // the reply; one that is still arriving is hidden at once, so the user never watches raw
 // tags stream by (the raw text stays stored until the closing tag, or it could never be found).
 flushDiscordSummary(turn, part) {
  const content = String(part.entry.content || '');
  const at = content.indexOf('<discord_summary>');
  if (at < 0) return;
  const rest = content.slice(at + '<discord_summary>'.length);
  const close = rest.indexOf('</discord_summary>');
  const body = (close >= 0 ? rest.slice(0, close) : rest).trim();
  if (body) turn.discordSummary = body.slice(0, 16000);
  const shown = (close >= 0
   ? content.slice(0, at) + rest.slice(close + '</discord_summary>'.length)
   : content.slice(0, at)).replace(/\n{3,}/g, '\n\n').trim();
  part.pendingSummary = close >= 0 ? null : shown;
  if (close >= 0) part.entry.content = shown;
 }

 // A finished <write-message_ID> block: delivered to that agent as its own chat message and
 // removed from the reply. The sender does not wait here — use the agents tool when you want
 // the answer back.
 flushAgentMessages(conv, part) {
  const content = String(part.entry.content || '');
  if (!/<write-message[_-]/i.test(content)) return;
  const pending = [];
  let match;
  AGENT_BLOCK.lastIndex = 0;
  while ((match = AGENT_BLOCK.exec(content))) pending.push({ id: match[1], text: String(match[2] || '').trim() });
  if (!pending.length) return;
  // Same guard as the Discord blocks: the rebuilt stream text must not deliver twice.
  part.sentAgents ||= new Set();
  for (const message of pending) {
   if (!message.text || !this.library.chat(message.id)) continue;
   const key = `${message.id}\u0000${message.text}`;
   if (part.sentAgents.has(key)) continue;
   part.sentAgents.add(key);
   this.sendAgentMessage(message.id, message.text, conv.record?.id || conv.id, { wait: false }).catch(() => {});
  }
  part.entry.content = content.replace(AGENT_BLOCK, '').replace(/\n{3,}/g, '\n\n').trim();
 }

 // The Runs tab follows a working run, not only its ending: the newest words of the reply go
 // into the run's snippet, throttled so the panel is not rebuilt for every token.
 // ---- Simple visuals: one timeline line per stretch of tool calls ------------------------
 // Every ordinary call joins the line above it, so consecutive steps read as one summarized
 // row ("Explored 2 files, Ran 13 commands") that expands to the individual cards. A subagent
 // box or anything else in between breaks the line, and a fresh one starts after it. The
 // steps of one turn are separate messages, so the line MOVES into the step that now owns the
 // work: "Explored 1 files" keeps collecting until the stretch really ends.
 groupElement() {
  const group = document.createElement('div');
  group.className = 'tool-group';
  group.innerHTML = '<button type="button" class="tool-group-head" aria-expanded="false">'
   + `<span class="tool-group-icon" aria-hidden="true">${SIMPLE_ICON}</span>`
   + '<span class="tool-group-label"></span>'
   + '<span class="tool-dots" aria-hidden="true"><i></i><i></i><i></i></span>'
   + '<span class="tool-chevron"></span>'
   + '<span class="tool-group-time" hidden></span>'
   + '</button><div class="tool-group-body"></div>';
  group.__items = [];
  const head = group.querySelector('.tool-group-head');
  head.addEventListener('click', () => {
   this.holdToggle();
   group.__touched = true;
   group.classList.toggle('is-open');
   head.setAttribute('aria-expanded', String(group.classList.contains('is-open')));
  });
  return group;
 }

 // The line a new step continues: the message above may hold the very stretch this call
 // belongs to (each step of a turn is its own message). Only a message of the same turn with
 // nothing but text, reasoning and the line itself is walked past — a subagent box, a
 // picture, a note or a finished turn ends the stretch.
 previousGroup(view) {
  const entry = view.el.__entry;
  let prev = view.el.previousElementSibling;
  while (prev) {
   if (!prev.classList?.contains('message') || !prev.classList?.contains('is-assistant')) return null;
   const prevEntry = prev.__entry;
   if (!entry?.turn || !prevEntry?.turn || entry.turn !== prevEntry.turn) return null;
   // The line may sit above the working dots at the end of the message. A line only absorbs
   // more calls while nothing happened between them: written text or a real Thought closes
   // the stretch (the older line stays as it is), and the next call starts a fresh one.
   let found = null;
   for (const child of prev.children) {
    if (child.classList.contains('tool-group')) { found = child; continue; }
    if (child.classList.contains('message-status')) continue;
    if (child.classList.contains('message-thinking')) {
     // What matters is whether a thought was really written — the box can be visible but
     // empty (extended thinking mode), which must not break the stretch.
     const inner = child.querySelector('.message-thinking-inner');
     if (!inner || !inner.textContent.trim()) continue;
     return null;
    }
    if (child.classList.contains('message-content')) { if (child.childElementCount || child.textContent.trim()) return null; continue; }
    return null;
   }
   if (found) return found;
   prev = prev.previousElementSibling;
  }
  return null;
 }

 // The conversation a sub-agent call belongs to: the live one from the tool id map, and for
 // a restored line the child chat created at the same position among this chat's children.
 subagentTarget(conv, toolId = '', callId = '') {
  const live = toolId && this.subagents?.get(toolId);
  if (live) return live;
  const children = this.library.chats.filter(chat => !chat.incognito && chat.parent === conv?.id).sort((a, b) => (a.created || 0) - (b.created || 0));
  if (!children.length) return '';
  if (!callId) return children[children.length - 1].id;
  const calls = [];
  for (const entry of conv?.messages || []) {
   for (const step of entry.steps || []) {
    for (const call of step.tool_calls || []) if (call.function?.name === 'subagent') calls.push(call.id);
   }
  }
  const at = calls.indexOf(callId);
  return (children[Math.max(0, Math.min(at, children.length - 1))] || {}).id || '';
 }

 // A sub-agent gets a line of its own (the user's rule: sub-agents never merge with the
 // ordinary stretch): blue spinner while it works, the past tense when done, and an Open
 // button into its conversation.
 subagentLine(view, args, toolId) {
  const line = this.groupElement();
  line.classList.add('is-subagent');
  line.__begun = performance.now();
  const icon = line.querySelector('.tool-group-icon');
  if (icon) {
   const spinner = document.createElement('span');
   spinner.className = 'tool-spinner';
   spinner.setAttribute('aria-hidden', 'true');
   icon.replaceWith(spinner);
  }
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'tool-open';
  open.textContent = I18n.t('subagent.open');
  open.addEventListener('click', event => {
   event.stopPropagation();
   const target = this.subagentTarget(this.active, toolId, String(args.callId || ''));
   if (target) this.open(target);
  });
  const time = line.querySelector('.tool-group-time');
  if (time) time.before(open); else line.querySelector('.tool-group-head')?.append(open);
  view.content.after(line);
  const item = {
   name: 'subagent',
   state: 'running',
   started: performance.now(),
   bucket: null,
   label: { running: I18n.t('subagent.started'), done: I18n.t('subagent.finished') },
  };
  line.__items = [item];
  this.simpleLabel(line);
  return { group: line, item };
 }

 simpleGroup(view, name, args = {}) {
  // A todo call never joins the summarized line: its own checklist box belongs right under
  // the call that made it, so the line would separate the two.
  if (!window.Effects?.simple || name === 'todo') return null;
  if (name === 'subagent') return this.subagentLine(view, args, arguments[3] || '');
  let group = view.__simpleGroup;
  if (group && (!group.isConnected || group.parentElement !== view.el)) group = null;
  // Anything that landed after the line breaks it: a subagent box, a picture, a note.
  if (group && group.nextElementSibling) {
   for (let node = group.nextElementSibling; node; node = node.nextElementSibling) {
    if (node.classList.contains('message-status') || node.classList.contains('message-content')) continue;
    group = null;
    break;
   }
  }
  if (!group) {
   group = this.previousGroup(view);
   if (group) {
    // The newest step owns the line now, and its clock runs on without a hiccup.
    group.remove();
    group.__begun ||= performance.now();
   } else {
    group = this.groupElement();
    group.__begun = performance.now();
    // A newer line takes the stage: every older one folds away, unless the user opened it.
    const list = view.el.closest('.thread-list');
    for (const other of list?.querySelectorAll('.tool-group.is-open') || []) {
     if (!other.__touched) other.classList.remove('is-open');
    }
   }
   view.content.after(group);
   view.__simpleGroup = group;
  }
  group.__items ||= [];
  group.__ended = 0;
  // The agents tool speaks for itself: "Reading Sub-agent's (id) answer" / "Messaging
  // Sub-agent (id)" instead of counting it as a command.
  const label = name === 'agents'
   ? { running: AgentTools.agentActionLabel(args.action, args.id, true), done: AgentTools.agentActionLabel(args.action, args.id, false) }
   : null;
  const item = { name, state: 'running', started: performance.now(), bucket: label ? null : (SIMPLE_BUCKET[name] || 'run'), label };
  group.__items.push(item);
  this.simpleLabel(group);
  return { group, item };
 }

 // The clock beside the line, the same the Thought row shows: it counts while the stretch
 // works and stays at the total once the last step is done.
 tickGroupClock(group) {
  const time = group.querySelector('.tool-group-time');
  if (!time || !group.__begun) return;
  const end = group.__ended || performance.now();
  time.textContent = thinkClock(Math.max(1, end - group.__begun));
 }

 startGroupClock(group) {
  if (group.__timer || !group.__begun) return;
  group.__timer = setInterval(() => {
   if (!group.isConnected) { clearInterval(group.__timer); group.__timer = 0; return; }
   this.tickGroupClock(group);
   if (group.__ended) { clearInterval(group.__timer); group.__timer = 0; }
  }, 100);
 }

 simpleLabel(group) {
  const items = group.__items || [];
  const counts = new Map();
  for (const item of items) if (item.bucket) counts.set(item.bucket, (counts.get(item.bucket) || 0) + 1);
  const working = items.some(item => item.state === 'running');
  const form = working ? SIMPLE_LABEL.running : SIMPLE_LABEL.done;
  const parts = [];
  for (const bucket of SIMPLE_ORDER) {
   const n = counts.get(bucket);
   const template = n && form[bucket];
   if (template) parts.push(template.replace('{n}', String(n)));
  }
  // The newest self-describing call (the agents tool) names what it is doing right now.
  const said = items.filter(item => item.label);
  if (said.length) {
   const latest = said[said.length - 1];
   parts.push(latest.state === 'running' ? latest.label.running : latest.label.done);
  }
  const failed = items.filter(item => item.state === 'error').length;
  // "Ran 1 commands" reads wrong: a count of one takes the singular noun.
  const text = (parts.join(', ') || (working ? 'Working' : 'Done'))
   .replace(/\b1 (files|commands|screenshots|steps|folders|messages|searches|images|links|pages)\b/gi, (_, word) => `1 ${word.replace(/s$/i, '')}`);
  const label = group.querySelector('.tool-group-label');
  if (label) label.textContent = failed ? `${text} · ${failed} failed` : text;
  group.classList.toggle('is-working', working);
  group.classList.toggle('has-error', failed > 0);
  // The line that is working stays open; once it is done — or a newer line starts — it folds,
  // unless the user opened it by hand. The fold is a collapse above the reader's place: hold it.
  this.holdView(() => { if (!group.__touched) group.classList.toggle('is-open', working); });
  const time = group.querySelector('.tool-group-time');
  if (time && group.__begun) {
   time.hidden = false;
   if (working) {
    group.__ended = 0;
    this.tickGroupClock(group);
    this.startGroupClock(group);
   } else {
    group.__ended ||= performance.now();
    this.tickGroupClock(group);
   }
  } else if (time) {
   time.hidden = true;
  }
  const body = group.querySelector('.tool-group-body');
  const chevron = group.querySelector('.tool-chevron');
  if (chevron) chevron.hidden = !body?.childElementCount;
 }

 simpleDone(handle, ms, failed = false) {
  const { group, item } = handle;
  item.state = failed ? 'error' : 'done';
  item.card?.setDuration(Math.max(1, Math.round(ms)));
  this.simpleLabel(group);
 }

 runSnippet(conv, text) {
  const run = window.ParallelRuns?.runs?.find(item => item.id === conv.id);
  if (!run || run.status !== 'running') return;
  const turn = conv.turn;
  const now = performance.now();
  if (turn?.snippetAt && now - turn.snippetAt < 700) return;
  if (turn) turn.snippetAt = now;
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return;
  window.ParallelRuns.update(conv.id, { snippet: value.length > 160 ? `…${value.slice(-160)}` : value });
 }

 // What the running turn looks like right now, small enough to mirror to the web: its last
 // thoughts, its tool cards with their state, and the answer being written. A device
 // watching the same chat (the phone on `prism web`) draws this as a live card.
 liveSnapshot(conv, turn) {
  const clip = (text, max) => String(text || '').slice(0, max);
  const head = (text, max) => {
 const value = String(text || '');
 return value.length > max ? `${value.slice(0, max)}\n… (${value.length - max} more characters — the full text stays in the saved conversation)` : value;
};
const tail = (text, max) => {
   const value = String(text || '');
   return value.length > max ? `…${value.slice(-max)}` : value;
  };
  const parts = [];
  for (const [at, part] of turn.parts.entries()) {
   const { entry, view } = part;
   // Stable ids: a watching page keys its mirrored boxes by them, so a fold survives the
   // parts list shifting, and each card carries its call id so a step already in the thread
   // is not drawn a second time.
   if (entry.thinking) parts.push({ id: `t${at}th`, kind: 'thinking', text: tail(entry.thinking, 2400), live: Boolean(view.thinking?.live) });
   let cardAt = 0;
   for (const card of view.el.querySelectorAll(':scope > .tool, :scope > .tool-group .tool-group-body > .tool')) {
    const state = card.classList.contains('is-error') ? 'error' : card.classList.contains('is-done') ? 'done' : 'running';
    parts.push({
     id: `t${at}c${cardAt++}`,
     callId: card.dataset.callId || '',
     kind: 'tool',
     // The real tool, so the mirror draws the very same card (icon, title, kind).
     tool: card.dataset.toolName || '',
     toolKind: card.dataset.toolKind || 'command',
     title: card.querySelector('.tool-title')?.textContent || card.querySelector('.tool-reason')?.textContent || '',
     summary: card.querySelector('.tool-summary')?.textContent || '',
     state,
     // How long the step took, so the watching device shows the same "(1.3s)".
     ms: Number(card.dataset.ms) || null,
     output: tail(card.querySelector('.tool-output')?.textContent || '', 1200),
    });
   }
   if (entry.content && entry.content.trim()) parts.push({ id: `t${at}x`, kind: 'text', text: clip(entry.content, 8000) });
  }
  const last = parts[parts.length - 1] || null;
  const status = last?.kind === 'text' ? 'writing' : last?.kind === 'tool' && last.state === 'running' ? 'working' : 'thinking';
  const title = this.library.chat(conv.id)?.title || conv.record?.title || I18n.t('chat.new');
  const kept = [];
  // A watching device gets the whole turn: with the old budget a run of twenty-odd tool
  // calls started dropping its earliest parts from the live mirror ("old tools and texts
  // unrender").
  let budget = 60000;
  for (let i = parts.length - 1; i >= 0 && kept.length < 80; i--) {
   const size = (parts[i].text || '').length + (parts[i].output || '').length + (parts[i].title || '').length + (parts[i].summary || '').length;
   if (budget - size < 0 && kept.length) break;
   budget -= size;
   kept.unshift(parts[i]);
  }
  // The todo list rides along — the checklist is the best "where is it now" a watching device
  // can get, so it must update live, not only when the conversation is saved.
  const todos = Array.isArray(conv.todos) ? conv.todos.slice(0, 40).map(item => ({ text: String(item?.text || '').slice(0, 200), state: String(item?.state || 'idle') })) : [];
  return { state: 'running', title: String(title).slice(0, 120), model: this.modelOf(conv), started: turn.started, status, parallel: Boolean(conv.subagent || conv.record?.parent), subagent: Boolean(conv.subagent || conv.record?.parent), todos, parts: kept };
 }

 // At most one publish every ~700ms; the tail timer keeps the last change from being lost.
 publishLive(conv, turn) {
  if (!window.Presence?.publish || !turn) return;
  clearTimeout(turn.liveTimer);
  const wait = 120 - (performance.now() - (turn.liveAt || 0));
  if (wait > 0) {
   turn.liveTimer = setTimeout(() => this.publishLive(conv, turn), wait);
   return;
  }
  if (conv.turn !== turn) return;
  turn.liveAt = performance.now();
  try { window.Presence.publish(conv.id, this.liveSnapshot(conv, turn)); } catch {}
 }

 run(conv, prompt, config, bubble) {
  const turn = this.begin(conv, config);
  window.Presence?.publish(conv.id, { state: 'running', title: String(prompt.text || '').slice(0, 80), model: this.modelOf(conv), started: Date.now() });
  this.publishLive(conv, turn);
  const entry = { role: 'user', text: prompt.text, attachments: prompt.attachments.map(slim), content: prompt.text, origin: prompt.origin || PLATFORM, ...(prompt.from ? { from: prompt.from } : {}), ...(prompt.device || FROM_DEVICE ? { device: prompt.device || FROM_DEVICE } : {}) };
  conv.messages.push(entry);
  if (bubble) this.nodes.set(entry, bubble);
  this.openPart(conv, turn);
  this.onChange();
  // The user's line reaches the disk at once: a page refreshed (or another device looking)
  // mid-turn sees the message and what has been written so far, not an empty conversation.
  if (conv.record) this.save(conv).catch(() => {});
  return this.drive(conv, turn, async () => {
   entry.content = await userContent(prompt);
   // The full content (photos and file blocks) is on disk too, as soon as it is built.
   if (conv.record) this.save(conv).catch(() => {});
  });
 }

 resume(conv, config) {
  // On a page the run goes to the server engine, so a resumed turn survives a refresh the
  // same way a sent one does. Sub-agent conversations keep their own on-page runs.
  if (this.serverRuns && !conv.subagent && !conv.record?.parent) {
   this.resumeOnServer(conv, config);
   return null;
  }
  return this.resumeLocally(conv, config);
 }

 // The old path: the whole loop runs on this page (the app's own window, or an engine that
 // predates the keeper).
 resumeLocally(conv, config) {
  const turn = this.begin(conv, config);
  window.Presence?.publish(conv.id, { state: 'running', title: String(conv.record?.title || '').slice(0, 80), model: this.modelOf(conv), started: Date.now() });
  this.publishLive(conv, turn);
  this.openPart(conv, turn);
  this.onChange();
  return this.drive(conv, turn);
 }

 interject(conv, prompt) {
  const turn = conv.turn, bubble = this.userMessage(prompt);
  if (turn.next) {
   turn.next.el.before(bubble);
  } else {
   turn.next = this.assistantMessage(conv);
   conv.list.append(bubble, turn.next.el);
  }
  turn.queue.push({ prompt, bubble });
  this.dismissGhost(turn.part.view);
  for (const pending of turn.approvals) pending.card.settle(TOOL_NOTES.message);
  turn.release?.('message');
 }

 async drive(conv, turn, prepare) {
  let error = null, finish = null;
  try {
   if (prepare) await prepare();
   turn.controller.signal.throwIfAborted();
   finish = await this.loop(conv, turn);
  } catch (e) {
   error = e;
  }
  await this.end(conv, turn, error, finish);
 }

 async loop(conv, turn) {
  if (turn.switch) {
   if (!(await this.compact(conv, turn, this.switchLabels(turn.switch, this.modelOf(conv))))) return null;
   turn.switch = '';
   turn.config = this.config(conv);
   if (!turn.queue.length) return null;
   turn.quiet = false;
   await this.takeQueue(conv, turn);
  }
  for (;;) {
   await this.compactIfNeeded(conv, turn);
   const { part, calls, finish } = await this.request(conv, turn);
   const images = [];
   const outputs = new Array(calls.length);
   // Each answer is written the moment its tool finishes, not at the end of the round: a stop
   // or a reload right after a tool ran used to lose its answer, and the card came back from
   // the file reading "cut off" although the step had succeeded. Parallel runs push in
   // whatever order they finish; they are put back in call order before the next round.
   const answered = new Array(calls.length);
   const runOne = async index => {
    const call = calls[index];
    const result = turn.controller.signal.aborted ? TOOL_NOTES.cancelled : await this.useTool(conv, turn, part.view, call);
    outputs[index] = typeof result === 'string' ? result : result.text;
    if (result.images?.length) images.push(...result.images);
    const step = { role: 'tool', tool_call_id: call.id, content: outputs[index] ?? '', ...(Number.isFinite(call.ms) ? { ms: call.ms } : {}) };
    answered[index] = step;
    part.entry.steps.push(step);
    this.save(conv);
   };
   const parallel = [];
   for (let index = 0; index < calls.length; index++) if (calls[index].function?.name === 'subagent') parallel.push(index);
   if (parallel.length > 1) await Promise.all(parallel.map(runOne));
   for (let index = 0; index < calls.length; index++) if (outputs[index] === undefined) await runOne(index);
   const written = answered.filter(Boolean);
   if (written.length) {
    for (const step of written) drop(part.entry.steps, step);
    part.entry.steps.push(...written);
   }
   for (let index = 0; index < calls.length; index++) conv.tokens += Math.ceil((outputs[index] ?? '').length / CONTEXT.chars);
   if (images.length) {
    const step = imageStep(images);
    part.entry.steps.push(step);
    conv.tokens += estimate([step]);
   }
   this.save(conv);
   turn.controller.signal.throwIfAborted();
   if (turn.queue.length) { await this.takeQueue(conv, turn); continue; }
   if (!calls.length) {
    // Nothing said and nothing asked for: a hiccup, not an answer — ask once, plainly.
    const said = String(part.entry.content || '').trim();
    if (!said && !entry.steps.some(stepEntry => stepEntry.role === 'tool') && !turn.emptyNudge) {
     turn.emptyNudge = true;
     entry.steps.pop();
     conv.messages.push({ role: 'user', text: 'You ended without any text. Answer now, in plain words.', content: 'You ended without any text. Answer now, in plain words.' });
     this.closePart(conv, part);
     this.openPart(conv, turn);
     continue;
    }
    return finish;
   }
   // A fresh message for the next step, so its thinking sits after these command cards
   // instead of piling into one block at the top of the turn.
   this.closePart(conv, part);
   this.openPart(conv, turn);
  }
 }

 // The world around the agent — MCP tools, instruction files, skills — changes rarely, and
 // gathering it takes longer than it should: every request used to re-ask every MCP server
 // and rescan folders before the first token could leave. One read is kept for a moment.
 async world(conv) {
  const now = Date.now(), cached = this.worldCache;
  if (cached && cached.folder === conv.record.folder && now - cached.at < WORLD_TTL) return cached;
  const next = { at: now, folder: conv.record.folder, mcp: '', instructions: '', skills: '' };
  try {
   await AgentTools.refreshMcp();
   next.mcp = AgentTools.mcpSummary();
  } catch {}
  try {
   // One instruction file for every chat: the global choice first, then an older per-folder
   // choice for this folder.
   let chosen = null;
   try { const global = JSON.parse(localStorage.getItem('openghost.instructionGlobal') || 'null'); if (global?.file) chosen = global; } catch {}
   if (!chosen) {
    const picked = JSON.parse(localStorage.getItem('openghost.instructions') || '{}')[conv.record.folder];
    if (picked) chosen = { folder: conv.record.folder, file: picked };
   }
   if (chosen) {
    const text = await window.openghost?.instructions?.read?.(chosen.folder, chosen.file);
    if (text && text.trim()) next.instructions = `# Selected instructions (from ${chosen.file})\nThese were chosen by the user in the composer's instruction menu and apply to every chat; follow them like the user's words.\n\n${String(text).slice(0, 12000)}`;
   }
  } catch {}
  try {
   const found = (await window.openghost?.skills?.list?.(conv.record.folder)) || [];
   if (found.length) {
    next.skills = ['# Skills (Claude skill folders)', 'Reusable instructions saved as SKILL.md files on this computer. When a task matches one, read its file with read_file and follow it.', ...found.slice(0, 40).map(item => `- ${item.name}${item.description ? ` — ${item.description}` : ''} (${item.path})`)].join('\n');
   }
  } catch {}
  this.worldCache = next;
  return next;
 }

 async system(conv) {
  const note = this.note ? `\n\n${this.note}` : '';
  let custom = '';
  try { custom = (await window.Prompts?.textFor?.(this.modelOf(conv))) || ''; } catch {}
  const extra = conv.extraSystem ? `\n\n${conv.extraSystem}` : '';
  // Incognito: the conversation stays out of the chat list and out of memory, unless the
  // user explicitly asks for something to be remembered.
  const incognito = conv.incognito ? '\n\n# Incognito conversation\nThis conversation is incognito: it does not appear in the chat list. Do not save anything about it with memory_save unless the user explicitly asks you to remember something — then save exactly what they asked for, nothing more.' : '';
  if (!this.agent(conv)) return [FORMAT_GUIDE, custom, note].filter(Boolean).join('\n\n');
  const env = await AgentTools.environment();
  const browser = window.browserPanel?.context() || '';
  const world = await this.world(conv);
  const mcp = world.mcp, instructions = world.instructions, skills = world.skills;
  let memory = '';
  try {
   const items = (await window.openghost?.memory?.list?.()) || [];
   if (items.length) memory = ['# Memory', 'Short facts you saved earlier (with memory_save). They are meant for every chat, not just the one they were written in: keep only durable things another conversation would need, and never save details that belong to one task.', ...items.map(item => `- [${item.id}] ${item.text}`)].join('\n');
  } catch {}
  return `${AgentPrompt.build({ folder: conv.record.folder, mode: this.settings.mode, env, browser, mcp, memory, plan: this.agentMode === 'plan' ? PLAN_SECTION : '', instructions, skills, serverNote: await this.serverNote(conv) })}${custom ? `\n\n${custom}` : ''}${extra}${incognito}\n\n# Formatting\n${FORMAT_GUIDE}${note}`;
 }

 // When this install is the home server, the prompt says so — and who is writing right now:
 // the tools act on the server's files and programs, not on the user's own computer.
 async serverNote(conv) {
  let server = false, name = '';
  try {
   const engine = await window.openghost?.engine?.info?.();
   if (engine) { server = Boolean(engine.server); name = String(engine.name || ''); }
   else {
    const auto = await window.openghost?.auto?.get?.();
    if (auto) server = Boolean(auto.server);
   }
  } catch {}
  if (!server) return '';
  const latest = [...(conv.messages || [])].reverse().find(entry => entry.role === 'user' && entry.device);
  const from = latest?.device || 'another device';
  // The server section: what Settings -> Prompt writes, else the built-in default (which the
  // field shows too, so it can be edited from there). The machine belongs to the user alone.
  let custom = '';
  try { custom = String(window.Prompts?.data?.server || '').trim(); } catch {}
  const fallback = String(window.Prompts?.defaultServer || '').trim();
  const lines = custom ? custom.split('\n') : fallback ? fallback.split('\n') : [
   `- This Prism runs on the user's server${name ? ` (${name})` : ''}; the user is talking to you from ${from}, over the network.`,
   '- Every tool acts on THIS server — files, commands, installs, long-running jobs — never on the user\'s personal computer. Say which machine a path or program lives on when it could be ambiguous.',
   '- This server belongs to the user alone — nobody else uses it. You may create, install, change and run whatever the task needs.',
  ];
  return ['# This machine is a server', ...lines, `- The user is talking to you from ${from}, over the network.`].join('\n');
 }

 context() {
  const conv = this.active, record = conv?.record;
  const folder = record ? this.library.folders.find(item => samePath(item.path, record.folder)) || { path: record.folder, name: '' } : conv?.folder || null;
  return { messages: conv ? snapshot(conv.messages) : [], tokens: conv?.tokens || 0, cache: conv?.cache || null, spend: conv?.spend || null, folder, model: this.modelOf(conv) };
 }

 // How a user message is addressed to the model when another surface wrote it: a Discord
 // message, a message from another device over the network, the website, a subagent asking
 // its main agent, the main answering one of its own runs, or an unrelated agent.
 addressOf(conv, entry) {
  const content = entry.content ?? entry.text ?? '';
  const prefix = this.addressPrefix(conv, entry);
  // A message with photos carries structured parts (image_url blocks), not a string: the
  // address becomes its own text part so the pictures survive instead of turning into
  // "[object Object]" on the way to the model.
  if (Array.isArray(content)) return prefix ? [{ type: 'text', text: prefix.trimEnd() }, ...content] : content;
  const text = typeof content === 'string' ? content : String(content || '');
  return prefix ? `${prefix}${text}` : text;
 }

 addressPrefix(conv, entry) {
  if (entry.origin === 'discord') return '[sent from Discord] ';
  if (entry.device) return `[sent from ${entry.device} over the network — answer on this machine] `;
  if (entry.origin === 'web') return '[sent from the website] ';
  if (entry.origin !== 'agent') return '';
  const source = entry.from ? this.library.chat(entry.from) : null;
  const name = source ? String(source.title || source.id) : 'another agent';
  if (source && source.parent === conv.id) {
   const task = source.task ? `, its task was: ${source.task}` : '';
   return `[from your launched sub-agent "${name}"${task}] `;
  }
  if (source && conv.record?.parent === source.id) return '[from main agent] ';
  return `[from agent "${name}"] `;
 }
 history(conv) {
  const out = [], messages = conv.messages;
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'compact') { start = i; break; }
  for (const entry of messages.slice(start)) {
   if (entry.role === 'compact') {
    out.push({ role: 'system', content: `${COMPACT.head}\n\n${entry.summary}` });
    if (entry.resume) out.push({ role: 'user', content: COMPACT.resume });
   } else if (entry.role === 'user') {
    out.push({ role: 'user', content: this.addressOf(conv, entry) });
   } else if (entry.role === 'assistant') {
    if (entry.steps) out.push(...entry.steps);
    else if (entry.content) out.push({ role: 'assistant', content: entry.content });
   }
  }
  return out;
 }

 // A pause between retries that an abort cuts short at once.
 nap(ms, turn) {
  return new Promise((resolve, reject) => {
   const signal = turn.controller.signal;
   const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
   const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
   if (signal.aborted) abort();
   else signal.addEventListener('abort', abort, { once: true });
  });
 }

 async request(conv, turn) {
  const part = turn.part, view = part.view, base = part.entry.content;
  // The ghost may already be on screen from the previous step: it starts its doze timer the
  // moment the model is asked again, so a long wait reads as a nap.
  this.pokeGhost(view);
  const messages = [{ role: 'system', content: await this.system(conv) }, ...this.history(conv)];
  let result;
  const clearReconnect = () => {
   turn.reconnect?.remove();
   turn.reconnect = null;
  };
  const showReconnect = ({ attempt, total, wait, error, key = 'chat.reconnecting' }) => {
   clearReconnect();
   const note = document.createElement('div');
   note.className = 'message-note is-reconnect';
   note.textContent = I18n.t(key, { error: error.message, attempt, total, seconds: Math.round(wait / 1000) });
   view.el.append(note);
   turn.reconnect = note;
   if (conv === this.active) this.followBottom();
  };
  try {
   // Any failure gets three more tries, five seconds apart, with the attempt spelled out in
   // the chat. The model call itself is unchanged between tries.
   const tries = 3, pause = 5000;
   for (let attempt = 1; ; attempt++) {
    try {
     result = await Providers.resilient(turn.config, {
      messages,
      tools: this.agent(conv) ? AgentTools.schemas : null,
      signal: turn.controller.signal,
      session: conv.id,
      onRetry: showReconnect,
      onContent: (delta, stream) => {
       clearReconnect();
       if (!stream.content.trim()) return;
       turn.text = true;
       part.entry.content = join(base, stream.content);
       // The server's quiet dots stay pinned at the end of the message while words stream;
       // the app's ghost keeps its behavior and steps aside once the reply starts.
       if (document.documentElement.classList.contains('is-server-mode')) this.showGhost(view);
       else this.dismissGhost(view);
       // A completed <send_discord_message> block goes to the user's Discord right away and
       // leaves the reply; only its own DMs carry it, never the chat text.
       this.flushDiscord(conv, part);
       // The same for a <write-message_ID> block addressed to another agent.
       this.flushAgentMessages(conv, part);
       // A <discord_summary> block is kept for the finish DM and removed from the reply.
       this.flushDiscordSummary(turn, part);
       // A pending <discord_summary> block is hidden from the stream, not only from the file.
       view.stream.push(part.pendingSummary ?? part.entry.content);
       this.runSnippet(conv, part.entry.content);
       this.publishLive(conv, turn);
      },
      onReasoning: delta => {
       if (!delta) return;
       clearReconnect();
       part.entry.thinking = (part.entry.thinking || '') + delta;
       view.thinking?.write(part.entry.thinking, true);
       // Thinking is work: the ghost stays awake while words are arriving.
       this.pokeGhost(view);
       if (conv === this.active) this.followBottom();
       this.publishLive(conv, turn);
      },
     });
     break;
    } catch (error) {
     const aborted = error?.name === 'AbortError' || turn.controller.signal.aborted;
     if (aborted || attempt > tries) throw error;
     showReconnect({ attempt, total: tries, wait: pause, error, key: 'chat.retrying' });
     await this.nap(pause, turn);
     clearReconnect();
    }
   }
  } catch (error) {
   clearReconnect();
   if (error.partial?.content) part.entry.steps.push(assistantStep({ ...error.partial, toolCalls: [] }));
   throw error;
  }
  clearReconnect();
  part.entry.steps.push(assistantStep(result));
  const usage = result.usage;
  conv.tokens = usage ? usage.total_tokens || usage.prompt_tokens + usage.completion_tokens : estimate(messages) + estimate([part.entry.steps.at(-1)]);
  // Prompt caching: providers report how much of the re-sent history came from their cache.
  if (usage) {
   const details = usage.prompt_tokens_details || {};
   const read = Number(details.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0) || 0;
   const write = Number(details.cache_creation_input_tokens ?? details.cache_write_tokens ?? 0) || 0;
   if (read || write) conv.cache = { read: (conv.cache?.read || 0) + read, write: (conv.cache?.write || 0) + write };
   // What the chat has spent so far, for the ~$ readout under the composer. The same
   // numbers OpenCode bills on: fresh input, output, reasoning (at the output rate),
   // cache reads and cache writes, priced per context size.
   const reasoning = Number(usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens ?? 0) || 0;
   conv.spend ||= { input: 0, cached: 0, written: 0, output: 0, reasoning: 0, context: 0 };
   conv.spend.input += Number(usage.prompt_tokens || 0) || 0;
   conv.spend.output += Number(usage.completion_tokens || 0) || 0;
   conv.spend.cached += read;
   conv.spend.written += write;
   conv.spend.reasoning += reasoning;
   conv.spend.context = Math.max(conv.spend.context || 0, Number(usage.prompt_tokens || 0) || 0);
  }
  const calls = part.entry.steps.at(-1).tool_calls || [];
  if (calls.length) this.showGhost(turn.next || view);
  return { part, calls, finish: result.finishReason };
 }

 async useTool(conv, turn, view, call) {
  const name = call.function.name, cwd = conv.record.folder;
  // The thinking that led here is done: its row folds away as the tool starts working.
  view.thinking?.fold?.();
  let args;
  try {
   args = JSON.parse(call.function.arguments || '{}') || {};
  } catch {
   return `Error: the arguments are not valid JSON: ${call.function.arguments.slice(0, 300)}. Call the tool again with valid JSON.`;
  }
  if (AgentTools.needsApproval(name, args, { mode: this.settings.mode, cwd })) {
   if (turn.queue.length) return TOOL_NOTES.message;
   if (conv.subagent) return 'Refused inside a subagent: this step needs the user\'s approval and a subagent cannot ask for it. Continue without it, or report to the main agent that it is needed.';
   const answer = await this.approve(conv, turn, view, { name, args, cwd });
   if (answer !== 'allow') return answer === 'deny' ? TOOL_NOTES.declined : answer;
  }
  if (turn.controller.signal.aborted) return TOOL_NOTES.cancelled;
  if (this.agentMode === 'plan' && (name === 'write_file' || name === 'edit_file' || name === 'patch')) {
   return 'Plan mode is on: file changes are refused right now. Put this change into your plan and ask the user with ask_user instead.';
  }
  this.showGhost(turn.next || view);
  const panel = name.startsWith('browser_') ? window.browserPanel : null;
  let handed = false;
  if (panel) {
   panel.drive(conv, true);
   if (panel.userHas) {
    const why = await new Promise(resolve => {
     turn.release = resolve;
     panel.waitForAgent().then(() => resolve('back'));
    });
    turn.release = null;
    if (why === 'abort' || turn.controller.signal.aborted) return TOOL_NOTES.cancelled;
    if (why === 'message') return TOOL_NOTES.browserMessage;
    handed = true;
   }
  }
  const id = turn.tool = `${conv.id}-${++this.tools}`;
  const described = name === 'ask_user' ? null : AgentTools.describe(name, args, cwd);
  // The raw arguments ride along: a card can be opened while the call still runs, and what
  // the model actually sent is part of what it shows.
  const card = described ? new ToolCard({ ...described, tool: name, args }) : null;
  // Simple visuals: ordinary calls join the timeline line above them; subagent boxes stay
  // whole and a fresh line starts after them.
  const simple = card ? this.simpleGroup(view, name, args, id) : null;
  if (card) {
   (simple ? simple.group.querySelector('.tool-group-body') : view.el).append(card.el);
   // The live mirror reads these back, so a card on another device wears the same icon, and
   // the call's own id lets a page that reloaded mid-run pair the two copies of the step.
   card.el.dataset.toolKind = described.kind || 'command';
   card.el.dataset.toolName = name;
   card.el.dataset.callId = call.id;
   if (simple) {
    simple.item.card = card;
    // The chevron only shows once the line has a step to open.
    this.simpleLabel(simple.group);
   }
  }
  if (conv === this.active) this.followBottom();
  this.publishLive(conv, turn);
  // The name is kept beside the id: a stop pressed while this call runs can then tell a
  // quiet wait from real work (see abort()).
  turn.toolName = name;
  // Which conversation started this tool call: the subagent tool reads this back, so a run
  // in the background parents its own subagents instead of the chat on screen.
  (this.toolConvs ||= new Map()).set(id, conv.id);
  // A subagent card carries a way into the conversation the subagent works in, and a live
  // clock beside it so the main chat shows how long it has been working.
  if (card && name === 'subagent') {
   card.addOpen(I18n.t('subagent.open'), () => {
    const subId = this.subagents?.get(id);
    if (subId) this.open(subId);
   });
   const timer = document.createElement('span');
   timer.className = 'tool-timer';
   timer.title = I18n.t('subagent.running');
   card.head.insertBefore(timer, card.chevron);
   const begun = Date.now();
   const step = () => {
    timer.textContent = spell(Math.max(1, Math.round((Date.now() - begun) / 1000)));
    if (card.el.classList.contains('is-running')) timer.timerId = setTimeout(step, 1000);
   };
   step();
  }
  const began = performance.now();
  try {
   if (handed) {
    const now = await AgentTools.run('browser_snapshot', {}, { id, cwd });
    card?.setResult(now);
    if (simple) this.simpleDone(simple, performance.now() - began);
    return `${TOOL_NOTES.handedBack}\n\n${now}`;
   }
   // "Unattach" for the file panel: the agent takes a file back out of this conversation's
   // file list. The file itself stays on disk; the list stays the way the AI left it, after
   // a reload too.
   if (name === 'attach_file' && args?.detach === true) {
    const target = String(args.path || '').trim();
    if (!target) return 'Nothing to detach: pass the file path.';
    conv.detached = [...new Set([...(conv.detached || []), target])];
    if (card) card.setResult(`Detached ${target} — it is out of this conversation's file list now.`);
    if (simple) this.simpleDone(simple, performance.now() - began);
    window.TaskFiles?.refresh?.();
    return `Detached ${target} — it is out of this conversation's file list now.`;
   }
   const output = await AgentTools.run(name, args, { id, cwd });
   card?.setResult(typeof output === 'string' ? output : output?.text);
   if (simple) this.simpleDone(simple, performance.now() - began);
   this.publishLive(conv, turn);
   // Pictures a tool brought back belong in the chat too, not only in the model's context:
   // a screenshot or a look at a file should simply appear, with no link to copy.
   if (output && typeof output === 'object' && output.images?.length) {
    const pictures = output.images.map((picture, n) => ({
     url: picture.url,
     name: picture.label || `Picture ${n + 1}`,
     note: '',
    }));
    if (name === 'read_file' && card) {
     // A photo the agent read stays visible right under its box — no expanding needed —
     // and a press opens it with pinch, wheel or double-tap zoom.
     card.showPhotos(pictures);
    } else {
     const slider = new MediaSlider(pictures);
     if (simple && card) {
      // The picture belongs to the step: opening its line shows the image itself.
      card.inner.append(slider.el);
      if (!card.touched) { card.open = true; card.sync(); }
     } else {
      view.el.append(slider.el);
     }
    }
    if (conv === this.active) this.followBottom();
   }
   // A finished file the agent attached (attach_file) is kept for the end of the turn: the
   // downloads belong after the wrap-up, not in the middle of the work. The conversation's
   // own file panel picks it up as well and keeps it until the agent detaches it.
   if (output && typeof output === 'object' && output.files?.length) {
    turn.files ||= [];
    for (const file of output.files) turn.files.push({ ...file, cwd });
    if (name === 'attach_file') window.TaskFiles?.refresh?.();
   }
   // The checklist as it stands right after this call: one box per todo call, sitting under
   // the very line that made it, never moved by anything that comes later.
   if (name === 'todo' && Array.isArray(conv.todos)) {
    const snapshot = conv.todos.map(item => ({ text: item.text, state: item.state }));
    call.todo = snapshot;
    if (card && snapshot.length) {
     const box = new TodoCard(snapshot);
     box.el.classList.add('is-snapshot');
     if (call.id) box.el.dataset.callId = call.id;
     const holder = card.el.closest('.tool-group') || card.el;
     // Inserting a box mid-thread must not move what the reader is looking at.
     this.holdView(() => holder.after(box.el));
     if (conv === this.active) this.followBottom();
    }
   }
   // A written or edited file gets Preview and Download on the card itself: the file is one
   // box, not a card plus a second chip repeating its name.
   if (!conv.subagent && (name === 'write_file' || name === 'edit_file') && String(typeof output === 'string' ? output : output?.text).slice(0, 6) !== 'Error:') {
    try { window.Artifacts?.actions?.(card, { path: args.path, cwd }); } catch {}
   }
   return output;
  } catch (error) {
   card?.setResult(error.message, true);
   if (simple) this.simpleDone(simple, performance.now() - began, true);
   call.ms = Math.round(performance.now() - began);
   this.publishLive(conv, turn);
   return `Error: ${error.message}`;
  } finally {
   if (card && !Number.isFinite(call.ms)) call.ms = Math.round(performance.now() - began);
   turn.tool = '';
   turn.toolName = '';
   this.toolConvs?.delete(id);
  }
 }

 async approve(conv, turn, view, request) {
  this.dismissGhost(view);
  const card = new ApprovalCard(AgentTools.describe(request.name, request.args, request.cwd));
  window.Sounds?.question?.();
  const pending = { ...request, card };
  view.el.append(card.el);
  turn.approvals.add(pending);
  if (conv === this.active) this.followBottom();
  const answer = await card.answer;
  turn.approvals.delete(pending);
  card.dismiss();
  return answer;
 }

 async takeQueue(conv, turn) {
  const queued = turn.queue.splice(0);
  this.closePart(conv, turn.part);
  for (const { prompt, bubble } of queued) {
   const entry = { role: 'user', text: prompt.text, attachments: prompt.attachments.map(slim), content: await userContent(prompt), origin: prompt.origin || PLATFORM, ...(prompt.from ? { from: prompt.from } : {}), ...(prompt.device || FROM_DEVICE ? { device: prompt.device || FROM_DEVICE } : {}) };
   conv.messages.push(entry);
   this.nodes.set(entry, bubble);
   conv.tokens += estimate([entry]);
  }
  this.openPart(conv, turn, turn.next);
  turn.next = null;
 }

 openPart(conv, turn, view = null) {
  view ||= this.assistantMessage(conv);
  if (!view.el.isConnected) conv.list.append(view.el);
  const entry = { role: 'assistant', content: '', steps: [], turn: turn.id };
  conv.messages.push(entry);
  view.el.__entry = entry;
  turn.part = { view, entry };
  turn.parts.push(turn.part);
  // A turn that starts while its conversation is parked stays parked: no frames until shown.
  if (conv !== this.active) this.loops(conv, true);
  this.publishLive(conv, turn);
 }

 closePart(conv, { view, entry }) {
  this.dismissGhost(view);
  const hasText = !!entry.content?.trim();
  const hasThinking = !!entry.thinking?.trim();
  // A step that only thought or only called tools used to fold the whole message away,
  // taking its Thought row and its command cards with it. Keep whatever is worth reading:
  // the thinking box stays above the cards, and the cards stay where they ran.
  const hasBody = Boolean(view.el.querySelector('.tool, .media-slider, .file-card, .message-error, .message-note'));
  if (!entry.steps.length && !hasText && !hasThinking) drop(conv.messages, entry);
  // The thought box folding is the biggest collapse of a step: hold the reader's place.
  this.holdView(() => { view.thinking?.finish(); });
  if (view.thinking?.elapsed && !entry.thinkingMs) entry.thinkingMs = Math.round(view.thinking.elapsed);
  view.stream.finish().then(() => {
   view.el.classList.remove('is-streaming');
   if (!hasText && !hasThinking && !hasBody) this.holdView(() => collapse(view.el));
   // Paths written in the finished step become links with icons.
   window.PathChips?.enhance(view.el, conv.record?.folder);
  });
  if (conv.turn) this.publishLive(conv, conv.turn);
 }

 async end(conv, turn, error, finish) {
  if (conv.turn !== turn) return;
  const { view, entry } = turn.part, aborted = error?.name === 'AbortError';
  // How long the whole turn took, kept on the entry so the row can show it again after a reload.
  if (turn.started) entry.duration = Math.max(1, Math.round((Date.now() - turn.started) / 1000));
  for (const pending of turn.approvals) pending.card.settle('deny');
  conv.turn = null;
  // No turn is left: the window may throttle again while it sits hidden in the tray.
  if (this.activeTurns() === 0) window.openghost?.setActiveTurn?.(false);
  // The mirror's heartbeat stops at once, but "the turn is over" is only told after the chat
  // has been written: a device watching would otherwise reload the conversation before the
  // last thoughts and tool cards were saved, and they would never appear.
  clearTimeout(turn.liveTimer);
  clearInterval(turn.liveBeat);
  turn.liveTimer = 0;
  turn.liveBeat = 0;
  if (turn.switch && this.library.chat(conv.id)) {
   this.library.update(conv.id, { model: turn.switch });
   this.settings.setModel(turn.switch);
  }
  window.browserPanel?.drive(conv, false);
  if (!entry.steps.length && !entry.content?.trim() && !entry.thinking?.trim()) drop(conv.messages, entry);
  // A <discord_summary> or <send_discord_message> block whose closing tag never arrived (a
  // reply cut off mid-block) must not reach the chat as raw text: its words are kept for the
  // finish DM and the raw tags are dropped here, for every part of the turn.
  for (const part of turn.parts) {
   const text = part.entry?.content;
   if (typeof text === 'string' && /<discord_summary|<send_discord_message/i.test(text)) {
    const open = /<discord_summary>([\s\S]*?)(?:<\/discord_summary>|$)/i.exec(text);
    if (open && !turn.discordSummary) turn.discordSummary = String(open[1]).trim().slice(0, 16000);
    part.entry.content = text
     .replace(/<discord_summary>[\s\S]*?<\/discord_summary>/gi, '')
     .replace(/<send_discord_message>[\s\S]*?<\/send_discord_message>/gi, '')
     .replace(/<discord_summary>[\s\S]*$/i, '')
     .replace(/<send_discord_message>[\s\S]*$/i, '')
     .replace(/\n{3,}/g, '\n\n')
     .trim();
    if (part.view?.stream) part.view.stream.push(part.entry.content);
   }
  }
  if (turn.next) collapse(turn.next.el);
  const queued = turn.queue.splice(0).map(({ prompt, bubble }) => {
   const item = { role: 'user', text: prompt.text, attachments: prompt.attachments.map(slim), content: prompt.text, origin: prompt.origin || PLATFORM, ...(prompt.device || FROM_DEVICE ? { device: prompt.device || FROM_DEVICE } : {}) };
   conv.messages.push(item);
   this.nodes.set(item, bubble);
   return userContent(prompt).then(content => { item.content = content; }, () => {});
  });
  await Promise.all(queued);
  if (conv.record && this.library.chat(conv.id)) {
   await this.save(conv);
   if (turn.text && !conv.record.named) this.name(conv, turn.config);
  }
  // The chat is on disk now: other devices may read it and see the finished turn whole.
  window.Presence?.publish(conv.id, null);
  if (conv !== this.active) conv.unread = true;
  this.dismissGhost(view);
  this.onChange();
  await view.stream.finish();
  // Every part of the turn stops its clock, not only the newest one: a step left behind by a
  // tool call must never keep ticking after the turn is over. Its duration is kept too, so a
  // reloaded chat shows how long each thought took.
  for (const part of turn.parts) {
   part.view.thinking?.finish();
   if (part.view.thinking?.elapsed && !part.entry.thinkingMs) part.entry.thinkingMs = Math.round(part.view.thinking.elapsed);
  }
  view.el.classList.remove('is-streaming');
  const text = !!entry.content.trim();
  let noted = true;
  if (error && !aborted) {
   this.fail(conv, view, error);
   // The failure is kept on the entry, so the chat still shows why it stopped after a
   // reload — and a device watching this conversation from elsewhere sees it too.
   entry.error = String(error.message || error).slice(0, 2000);
  }
  if (conv.record) {
   // A notification with the chat's name when the app is in the background: completed, failed or error.
   const title = this.library.chat(conv.id)?.title || conv.record.title || I18n.t('chat.new');
   const outcome = aborted ? 'failed' : error ? 'error' : 'completed';
   // When something went wrong the reason is what the user needs: it rides in the toast and,
   // if the voice is on, in the Discord DM, instead of an empty summary.
   const reason = error && !aborted ? String(error.message || error).replace(/\s+/g, ' ').trim().slice(0, 600) : '';
   const summary = reason || String(entry.content || '').replace(/\s+/g, ' ').trim().slice(0, 300);
   // Subagents stay silent: no Windows toast, no taskbar badge. Only real conversations ring.
   // A turn stopped during a `wait` stays silent too: the user ended a pause, that is all.
   if (!conv.subagent && !turn.quiet && !turn.stoppedWait) window.openghost?.notify?.(title, outcome, summary);
   // The Discord switch at the end of the mode menu: a DM with the fuller summary, sent
   // whether or not the toast was shown.
   if (window.DiscordNotify?.on && !conv.subagent && !turn.quiet && !turn.stoppedWait) {
    // The reply goes over as the model wrote it (line breaks and markdown kept, split into
    // Discord-sized messages), with the files the run attached. Never flattened to one line.
    window.openghost?.discord?.dm?.({
     title,
     outcome,
     summary: reason ? `⚠️ ${reason}` : (turn.discordSummary || String(entry.content || '').trim().slice(0, 16000) || (aborted ? I18n.t('chat.stoppedShort') : I18n.t('chat.emptyReply'))),
     files: (turn.files || []).map(file => file.path).filter(Boolean),
     // Replying to that DM continues this exact conversation.
     chatId: conv.record?.id || conv.id,
    });
   }
   window.ParallelRuns?.update(conv.id, { status: outcome, snippet: summary.slice(0, 140) });
   // A chime when a task ends, an approval card or question waits, or something breaks.
   // Subagents stay silent (several run at once) and so do the quiet internal turns a model
   // switch makes.
   if (!conv.subagent && !turn.quiet) {
    if (error && !aborted) window.Sounds?.error?.();
    else if (!aborted) window.Sounds?.finish?.();
   }
   if (conv.awaitDone) {
    const resolve = conv.awaitDone;
    conv.awaitDone = null;
    resolve(aborted ? 'The subagent was stopped before it finished.' : error ? `The subagent failed: ${error.message}` : String(entry.content || '').trim() || 'The subagent finished without a written report.');
   }
  }
  else if (turn.quiet) noted = false;
  else if (aborted) this.note(view, I18n.t('chat.stopped'));
  else if (FINISH_NOTES.includes(finish)) this.note(view, I18n.t(`finish.${finish}`));
  else if (!turn.text) this.note(view, I18n.t('chat.empty'));
  else noted = false;
  const last = text ? view : turn.parts.findLast(item => item.entry.content.trim() && item.view.el.isConnected)?.view;
  if (last) {
   const tools = this.toolbar('assistant', entry.duration || 0), box = last === view && view.el.querySelector('.message-error, .message-note');
   if (box) box.before(tools);
   else last.el.append(tools);
   // Files the agent attached are shown after the finished answer, so they are what is left
   // at the bottom of the conversation.
   if (turn.files?.length) {
    for (const file of turn.files) {
     try { window.Artifacts?.attach(last.el, file); } catch {}
    }
   }
   window.PathChips?.enhance(last.el, conv.record?.folder);
  }
  if (!text && !noted) collapse(view.el);
  if (conv === this.active) this.followBottom();
  // A protected chat left while it was replying locks fully once the reply is saved.
  if (conv.locked && !conv.turn) this.seal(conv);
 }

 async compactIfNeeded(conv, turn) {
  const used = conv.tokens || estimate(this.history(conv));
  if (used < this.settings.windowOf(turn.config.model) * (1 - CONTEXT.reserve)) return;
  await this.compact(conv, turn);
 }

 switchLabels(from, to) {
  const name = id => this.settings.find(id)?.name || id;
  return {
   running: I18n.t('compact.switch.running', { name: name(to) }),
   done: I18n.t('compact.switch.done', { name: name(to) }),
   failed: I18n.t('compact.switch.failed', { name: name(from) }),
  };
 }

 async compact(conv, turn, labels = null) {
  const messages = conv.messages;
  let at = messages.length;
  while (at > 0 && (messages[at - 1].role === 'user' || (messages[at - 1].steps && !messages[at - 1].steps.length))) at--;
  if (!at) return true;
  const middle = at === messages.length;
  const notice = this.compactNotice(true, labels);
  if (middle) {
   this.closePart(conv, turn.part);
   conv.list.append(notice);
  } else {
   const first = this.nodes.get(messages[at]);
   if (first?.isConnected) first.before(notice);
   else turn.part.view.el.before(notice);
  }
  if (conv === this.active) this.followBottom();
  let summary = '';
  try {
   summary = await Providers.complete(turn.config, {
    messages: [{ role: 'system', content: COMPACT.prompt }, { role: 'user', content: transcript(messages.slice(0, at)) }],
    maxTokens: COMPACT.output,
    signal: turn.controller.signal,
   });
  } catch (error) {
   if (error.name === 'AbortError') { this.finishNotice(notice, false); throw error; }
  }
  if (middle) this.openPart(conv, turn);
  if (!summary) {
   this.finishNotice(notice, false);
   return false;
  }
  const entry = { role: 'compact', summary, resume: middle };
  messages.splice(at, 0, entry);
  this.nodes.set(entry, notice);
  if (conv.window) this.windowSync(conv);
  conv.tokens = estimate([{ content: await this.system(conv) }, ...this.history(conv)]);
  this.finishNotice(notice, true);
  this.save(conv);
  return true;
 }

 compactNotice(live, labels = null) {
  const el = document.createElement('div');
  el.className = `thread-compact${live ? ' is-live' : ''}`;
  el.labels = labels;
  const text = document.createElement('span');
  text.className = 'thread-compact-text';
  text.textContent = live ? labels?.running || I18n.t('compact.running') : I18n.t('compact.done');
  el.append(text);
  return el;
 }

 finishNotice(el, ok) {
  const text = el.querySelector('.thread-compact-text');
  el.classList.remove('is-live');
  text.textContent = ok ? el.labels?.done || I18n.t('compact.done') : el.labels?.failed || I18n.t('compact.failed');
  if (!reducedMotion()) text.animate([{ opacity: 0, filter: 'blur(3px)' }, { opacity: 1, filter: 'blur(0)' }], { duration: 360, easing: 'ease-out' });
 }

 save(conv) {
  if (!this.library.chat(conv.id)) return Promise.resolve();
  // A conversation whose messages never loaded must never be written: an empty list would
  // overwrite the real chat on disk (the read may have failed, not the chat).
  if (conv.loadFailed) return Promise.resolve();
  conv.savedAt = Date.now();
  const write = this.library.saveMessages(conv.id, conv.messages, conv.tokens, conv.spend || null, conv.todos?.length ? conv.todos : null, { detached: conv.detached || [] });
  this.library.update(conv.id, { updated: Date.now() });
  return write;
 }

 async name(conv, config) {
  const id = conv.id, user = conv.messages.find(entry => entry.role === 'user'), reply = conv.messages.find(entry => entry.role === 'assistant' && entry.content?.trim());
  if (!user || !reply) return;
  this.library.update(id, { named: true });
  const asked = user.text || (user.attachments || []).map(item => item.name).join(', ');
  try {
   const title = await Providers.complete(config, {
    messages: [
     { role: 'system', content: TITLE_PROMPT },
     { role: 'user', content: `${asked.slice(0, TITLE_INPUT.user)}\n\n${reply.content.slice(0, TITLE_INPUT.reply)}` },
    ],
   });
   const clean = title.replace(/^[\s"'«“„]+|[\s"'»”.!]+$/g, '').replace(/\s+/g, ' ').slice(0, TITLE_INPUT.max);
   if (clean && this.library.chat(id)) this.library.update(id, { title: clean });
  } catch {}
 }

 restore(conv) {
  this.attach(conv);
  // The newest todo call of the chat: the single box a reopened old thread still gets from
  // the conversation's stored list when its own snapshot never reached the file (see
  // restoredMessage), and the cards the live mirror looks up by call id.
  conv.lastTodoCall = todoCallOf(conv.messages);
  conv.callCards = new Map();
  conv.shown = null;
  const ends = new Map();
  for (const entry of conv.messages) if (entry.role === 'assistant' && entry.content?.trim()) ends.set(entry.turn || entry, entry);
  // Files attached during a turn are drawn under its last message, not where the tool ran,
  // so a reloaded chat keeps them at the end of the conversation too.
  conv.filesByTurn = new Map();
  for (const entry of conv.messages) {
   if (entry.role !== 'assistant') continue;
   for (const step of entry.steps || []) {
    if (step.role !== 'assistant') continue;
    for (const call of step.tool_calls || []) {
     if (call.function?.name !== 'attach_file') continue;
     try {
      const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      if (!args.path) continue;
      const turn = entry.turn || entry;
      conv.filesByTurn.set(turn, [...(conv.filesByTurn.get(turn) || []), args.path]);
     } catch {}
    }
   }
  }
  // Long chats draw their tail only: the newest messages, everything older on demand.
  const entries = conv.messages.filter(entry => this.drawable(entry));
  // A rebuild must never un-draw what was already on screen: the messages only ever grow at
  // the end, so the previous window's first index still points at the same message — keeping
  // it means a refresh (or the end-of-run reload) leaves the whole conversation the reader
  // could see on screen, plus whatever arrived since. The old behaviour re-windowed to the
  // last WINDOW_MIN entries only, which is why a busy conversation seemed to lose half of
  // itself while it worked.
  const previous = Number.isInteger(conv.window?.from) ? conv.window.from : Number.MAX_SAFE_INTEGER;
  const from = Math.max(0, Math.min(previous, entries.length - WINDOW_MIN));
  conv.window = { entries, ends, from };
  for (let index = from; index < entries.length; index++) this.renderEntry(conv, entries[index]);
  settle(conv.list);
  this.prerender(conv);
 }

 // While the reader sits near the bottom, older batches are drawn quietly in the background,
 // so scrolling up finds whole messages ready instead of waiting for them to render under
 // the finger. Rendering stops as soon as the reader scrolls away or the budget is spent.
 prerender(conv) {
  if (!conv?.window) return;
  conv.prerenderLeft = PRERENDER;
  const step = () => {
   if (conv !== this.active || !conv.window || conv.window.from <= 0 || conv.prerenderLeft <= 0) return;
   if (this.thread.scrollTop > LOAD_AHEAD) return;
   const start = Math.max(0, conv.window.from - WINDOW_BATCH);
   const count = conv.window.from - start;
   const height = this.thread.scrollHeight;
   const frag = document.createDocumentFragment();
   for (let index = start; index < conv.window.from; index++) this.renderEntry(conv, conv.window.entries[index], frag);
   conv.list.insertBefore(frag, conv.list.firstElementChild);
   conv.window.from = start;
   conv.prerenderLeft -= count;
   settle(conv.list);
   if (this.follow) this.pin();
   else { this.thread.scrollTop += this.thread.scrollHeight - height; this.lastTop = this.thread.scrollTop; }
   if (conv.window.from > 0) this.idle(step);
  };
  this.idle(step);
 }

 idle(fn) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 250 });
  else setTimeout(fn, 80);
 }

 // Whether an entry is worth drawing on the screen: words, reasoning, or a tool it called.
 drawable(entry) {
  // A system line (the carry-on note after an update restart) is for the model, not for the
  // screen: it stays in the stored history and is never drawn.
  if (entry.system) return false;
  if (entry.role === 'user' || entry.role === 'compact') return true;
  if (entry.error) return true;
  if ((entry.content || '').trim() || (entry.thinking || '').trim()) return true;
  return (entry.steps || []).some(step => step.role === 'assistant' && step.tool_calls?.length);
 }

 renderEntry(conv, entry, target = conv.list) {
  let el = null;
  try {
   const last = entry.role === 'assistant' && (entry.content || '').trim() && conv.window.ends.get(entry.turn || entry) === entry;
   if (entry.role === 'user') el = this.userMessage(this.promptOf(entry));
   else if (entry.role === 'compact') el = this.compactNotice(false);
   else if (this.drawable(entry)) el = this.restoredMessage(entry, last, conv);
  } catch (error) {
   el = null;
  }
  if (!el) return null;
  target.append(el);
  this.nodes.set(entry, el);
  return el;
 }

 // One batch of older messages above the viewport, keeping the reading position steady.
 loadOlder() {
  const conv = this.active;
  if (!conv?.window || conv.window.from <= 0 || this.thread.scrollTop > LOAD_AHEAD) return;
  const start = Math.max(0, conv.window.from - WINDOW_BATCH);
  const height = this.thread.scrollHeight, top = this.thread.scrollTop;
  const frag = document.createDocumentFragment();
  for (let index = start; index < conv.window.from; index++) this.renderEntry(conv, conv.window.entries[index], frag);
  conv.list.insertBefore(frag, conv.list.firstElementChild);
  conv.window.from = start;
  settle(conv.list);
  this.thread.scrollTop = top + (this.thread.scrollHeight - height);
  this.lastTop = this.thread.scrollTop;
 }

 // After a compaction the list of drawable entries is rebuilt around the notice.
 windowSync(conv) {
  if (!conv.window) return;
  const entries = conv.messages.filter(entry => this.drawable(entry));
  conv.window.entries = entries;
  conv.window.from = Math.min(conv.window.from, entries.length);
 }

 promptOf(entry) {
  const urls = Array.isArray(entry.content) ? entry.content.filter(part => part.type === 'image_url').map(part => part.image_url.url) : [];
  // A browser upload's saved path rides in the message's own <file …> block: the stored
  // attachment itself may have been written before the upload answered, so the path is
  // recovered from the content — without it a phone-attached file could never be opened.
  const paths = new Map();
  if (typeof entry.content === 'string') {
   for (const match of entry.content.matchAll(/<file name="([^"]+)"[^>]*\bpath="([^"]+)"/g)) paths.set(match[1].replace(/&quot;/g, '"'), match[2]);
  }
  let k = 0;
  const attachments = (entry.attachments || []).map(item => ({
   ...item,
   path: item.path || paths.get(String(item.name || '')) || '',
   info: FileKinds.describe(item.name),
   url: item.image ? urls[k++] || '' : '',
  }));
  return { text: entry.text || '', attachments, origin: entry.origin || '', device: entry.device || '' };
 }

 restoredMessage(entry, last = true, conv = null) {
  const el = document.createElement('div');
  el.className = 'message is-assistant';
  const content = document.createElement('div');
  content.className = 'message-content markdown';
  el.append(content);
  StreamView.render(content, entry.content);
  if (entry.thinking) {
   const thinking = new ThinkingView();
   thinking.write(entry.thinking, false);
   thinking.setTime(entry.thinkingMs);
   // A thought read from the file is finished work: it comes back folded whatever the live
   // rules left behind, and a tap opens or closes it like any other.
   thinking.setOpen(false);
   el.insertBefore(thinking.el, content);
  }
  const cwd = conv?.record?.folder || '';
  const calls = [];
  for (const step of entry.steps || []) {
   if (step.role === 'assistant' && Array.isArray(step.tool_calls)) calls.push(...step.tool_calls);
   else if (step.role === 'tool') {
    const call = calls.find(item => item.id === step.tool_call_id);
    if (call) call.__output = step.content;
    const ms = Number.isFinite(step.ms) ? step.ms : (call && Number.isFinite(call.ms) ? call.ms : null);
    if (call && Number.isFinite(ms)) call.__ms = ms;
   }
  }
  // Simple visuals draws a reloaded step as the same timeline line the live one wore: one
  // summarized row per stretch of ordinary calls, expanding to the cards, with subagent boxes
  // left whole and any box breaking the stretch.
  const simple = Boolean(window.Effects?.simple);
  let group = null;
  for (const call of calls) {
   let args = {};
   let card;
   try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    card = new ToolCard({ ...AgentTools.describe(call.function.name, args, cwd), tool: call.function.name, args });
   } catch {
    card = new ToolCard({ kind: 'command', title: call.function?.name || '', code: call.function?.arguments || '' });
   }
   // A call whose tool step never reached the file (the turn was stopped mid-step — an
   // update restart, a stop, a crash) used to come back as a card with no result, which read
   // as "Running" forever. Say what happened instead — and say it as unfinished, not failed:
   // the step ran, only its answer never made it to disk, and a live mirror may still fill it
   // in (data-call-id is how the mirror finds this very card).
   const answered = call.__output !== undefined && call.__output !== null;
   if (answered) {
    // A real failure answers with "Error: …" (the same rule the keeper stamps its cards
    // with) — that one keeps its red; everything else is an ordinary result.
    card.setResult(call.__output, /^Error[: ]/.test(String(call.__output)));
   } else {
    card.setResult(I18n.t('tool.unfinished'));
    card.el.classList.add('is-unfinished');
    card.inner.querySelector('.tool-output')?.classList.add('is-unfinished');
    if (!card.touched && card.hasBody()) { card.open = true; card.sync(); }
   }
   if (call.id && conv) {
    card.el.dataset.callId = call.id;
    (conv.callCards ||= new Map()).set(call.id, card);
   }
   // How long the step took: read from the tool step or from the call itself, so a run
   // nobody watched (the server engine) still shows its "(3.4s)" after a reload.
   const ms = Number.isFinite(call.__ms) ? call.__ms : (Number.isFinite(call.ms) ? call.ms : 0);
   if (ms) card.setDuration(ms);
   const isTodo = call.function?.name === 'todo';
   if (simple && !card.parallel && !isTodo) {
    if (!group) {
     group = this.groupElement();
     el.append(group);
    }
    group.querySelector('.tool-group-body').append(card.el);
    let label = null;
    if (call.function?.name === 'agents') {
     try {
      const args2 = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      label = { running: AgentTools.agentActionLabel(args2.action, args2.id, true), done: AgentTools.agentActionLabel(args2.action, args2.id, false) };
     } catch {}
    }
    group.__items.push({ name: call.function?.name || '', state: 'done', started: 0, ms, bucket: label ? null : (SIMPLE_BUCKET[call.function?.name] || 'run'), label });
   } else {
    group = null;
    el.append(card.el);
   }
   // The checklist a todo call left behind: one box per call, right under it, kept exactly
   // where it was — a reload must not move it to the newest position or replace it. Data from
   // before the per-call snapshots still gets its box: from the tool's own report, and for the
   // newest call of the chat from the stored list, so a reopened thread never loses the box.
   if (isTodo) {
    const items = (Array.isArray(call.todo) && call.todo.length ? call.todo : null)
     || todoFromOutput(call.__output)
     || (conv && call === conv.lastTodoCall && conv.todos?.length ? conv.todos : null);
    if (items?.length) {
     const box = new TodoCard(items);
     box.el.classList.add('is-snapshot');
     if (call.id) box.el.dataset.callId = call.id;
     const holder = card.el.closest('.tool-group') || card.el;
     let ref = holder;
     while (ref.nextElementSibling?.classList?.contains('todo-card')) ref = ref.nextElementSibling;
     ref.after(box.el);
    }
   }
   if (call.function?.name === 'write_file' || call.function?.name === 'edit_file') {
    if (args.path) {
     try { window.Artifacts?.actions?.(card, { path: args.path, cwd }); } catch {}
    }
   }
  }
  // Every line carries the total of its steps' clocks — the same figure the live line showed
  // while it worked.
  for (const line of el.querySelectorAll('.tool-group')) {
   const total = (line.__items || []).reduce((sum, entry) => sum + (Number(entry.ms) || 0), 0);
   if (total > 0) { line.__begun = performance.now() - total; line.__ended = performance.now(); }
  }
  // A fresh entry of the same turn continues the line above it when nothing but the calls
  // sits between them (one line per stretch, not one per round) — the same rule simpleGroup
  // applies live. A sub-agent line, a thought or written text stays a boundary.
  if (simple) {
   for (const group of el.querySelectorAll(':scope > .tool-group')) {
    if (group.classList.contains('is-subagent')) continue;
    const host = this.previousGroup({ el });
    if (!host || host.classList.contains('is-subagent')) continue;
    const body = host.querySelector('.tool-group-body');
    if (!body) continue;
    for (const item of group.__items || []) host.__items.push(item);
    for (const card of group.querySelectorAll('.tool-group-body > .tool')) body.append(card);
    group.remove();
   }
  }
  // The summaries last, once every line has its steps.
  for (const item of el.querySelectorAll('.tool-group')) this.simpleLabel(item);
  // Pictures from tools ride in their own user step, so a chat reloaded from disk has to put
  // them back under the cards instead of losing them the moment the page refreshes.
  const pictures = [];
  for (const step of entry.steps || []) {
   if (!Array.isArray(step.content)) continue;
   let label = '';
   for (const part of step.content) {
    if (part.type === 'image_url' && part.image_url?.url) {
     pictures.push({ url: part.image_url.url, name: label, note: '' });
     label = '';
    } else if (part.type === 'text' && part.text && part.text !== TOOL_NOTES.images) label = part.text;
   }
  }
  if (pictures.length) el.append(new MediaSlider(pictures).el);
  // A turn that failed keeps its reason: a device reading this conversation from elsewhere
  // (or the same chat after a reload) still sees why the work stopped.
  if (entry.error) {
   const box = document.createElement('div');
   box.className = 'message-error';
   box.textContent = entry.error;
   el.append(box);
  }
  el.__entry = entry;
  // A conversation still working elsewhere is NOT finished: the Copy / Quote / Mini chat row
  // under a random message used to read as "the AI stopped" while it was in fact still
  // working — the row waits until the run really ends.
  const working = Boolean(conv?.turn) || Boolean(conv && window.Presence?.isBusy?.(conv.id));
  if (last && !working) {
   el.append(this.toolbar('assistant', entry.duration || 0));
   // Files attached during the turn wait at its end (collected in restore).
   for (const path of conv?.filesByTurn?.get(entry.turn || entry) || []) {
    try { window.Artifacts?.attach(el, { path, cwd }); } catch {}
   }
  }
  // Paths written in the reply become links with icons (folder, file, image).
  window.PathChips?.enhance(el, cwd);
  return el;
 }

 // The row under a message: Copy everywhere, Steer on your own words (rewind and edit the
 // prompt), Ask / Mini chat under replies, and how long the turn took beside them.
 toolbar(kind = 'assistant', seconds = 0) {
  const tools = document.createElement('div');
  tools.className = 'message-tools';
  const copy = document.createElement('button');
  copy.className = 'md-copy message-copy';
  copy.type = 'button';
  copy.setAttribute('aria-label', I18n.t('message.copy'));
  copy.innerHTML = Markdown.COPY_ICON;
  tools.append(copy);
  if (kind === 'user') {
   tools.append(this.toolButton('steer', Glyphs.pencil, I18n.t('select.steer'), I18n.t('select.steerHint'), button => {
    const message = button.closest('.message');
    if (message) window.dispatchEvent(new CustomEvent('prism-steer-message', { detail: { message } }));
   }));
  } else {
   tools.append(this.toolButton('ask', Glyphs.quote, I18n.t('select.ask'), I18n.t('message.askHint'), button => {
    const message = button.closest('.message');
    if (message) window.dispatchEvent(new CustomEvent('prism-quote-message', { detail: { text: this.copyText(message), message } }));
   }));
   tools.append(this.toolButton('mini', Glyphs.bubble, I18n.t('select.mini'), I18n.t('message.miniHint'), button => {
    const message = button.closest('.message');
    if (message) MiniChat.open({ settings: this.settings, source: this, quote: this.copyText(message) });
   }));
   if (seconds > 0) {
    const time = document.createElement('span');
    time.className = 'message-when';
    time.title = I18n.t('message.durationHint');
    time.textContent = spell(seconds);
    tools.append(time);
   }
  }
  return tools;
 }

 toolButton(name, glyph, label, title, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `message-tool message-tool-${name}`;
  button.innerHTML = glyph;
  button.setAttribute('aria-label', label);
  if (title) button.title = title;
  button.addEventListener('click', () => onClick(button));
  return button;
 }

 showGhost(view) {
  const current = view.status;
  if (current?.isConnected && !current.classList.contains('is-leaving')) {
   if (current !== view.el.lastElementChild && view.content.hasChildNodes()) view.el.append(current);
   this.pokeGhost(view);
   return;
  }
  const status = document.createElement('div');
  status.className = 'message-status is-working';
  // The app's ghost for everyone connected (a phone, a remote window, another computer); the
  // server's own screen keeps the quiet dots it always had.
  const own = document.documentElement.classList.contains('is-server-screen');
  status.innerHTML = own
   ? '<span class="working-dots" aria-hidden="true"><i></i><i></i><i></i></span>'
   : '<ghost-thinking></ghost-thinking>';
  view.el.append(status);
  view.status = status;
  this.pokeGhost(view);
  if (view.el.closest('.thread-list') === this.active?.list) this.followBottom();
 }

 // The working ghost stays awake while something is happening; after five seconds of waiting
 // (the model is thinking, a tool is running, the next step has not started) it dozes off
 // with Zzz. Any new activity pokes it awake, with a smooth droop-and-lift.
 pokeGhost(view) {
  const status = view.status;
  if (!status?.isConnected || status.classList.contains('is-leaving')) return;
  const ghost = status.querySelector('ghost-thinking');
  if (!ghost) return;
  ghost.removeAttribute('sleepy');
  clearTimeout(view.ghostTimer);
  view.ghostTimer = setTimeout(() => {
   if (status.isConnected && !status.classList.contains('is-leaving')) ghost.setAttribute('sleepy', '');
  }, 5000);
 }

 dismissGhost(view) {
  const status = view.status;
  if (!status?.isConnected || status.classList.contains('is-leaving')) return;
  clearTimeout(view.ghostTimer);
  view.ghostTimer = 0;
  status.classList.add('is-leaving');
  if (reducedMotion()) { status.remove(); return; }
  const style = getComputedStyle(status);
  status.animate([
   { height: `${status.offsetHeight}px`, paddingTop: style.paddingTop, opacity: 1, transform: 'none' },
   { height: '0px', paddingTop: '0px', opacity: 0, transform: 'scale(0.7)' },
  ], LEAVE).finished.then(() => status.remove());
 }

 fail(conv, view, error) {
  const box = document.createElement('div');
  box.className = 'message-error';
  box.textContent = error.message;
  const actions = document.createElement('div');
  actions.className = 'message-actions';
  if (error.status === 401) actions.append(this.action(I18n.t('chat.open-settings'), () => this.settings.open()));
  actions.append(this.action(I18n.t('chat.retry'), () => this.retry(conv, view)));
  view.el.append(box, actions);
 }

 retry(conv, view) {
  if (conv.turn) return;
  const config = this.config(conv);
  if (!config.ready) {
   this.settings.open(I18n.t('settings.key.needed'), config.provider);
   return;
  }
  for (const node of view.el.querySelectorAll('.message-error, .message-actions')) node.remove();
  if (!conv.messages.includes(view.el.__entry)) view.el.remove();
  if (conv === this.active) this.follow = true;
  this.resume(conv, config);
  if (conv === this.active) this.followBottom();
 }

 note(view, text) {
  const note = document.createElement('div');
  note.className = 'message-note';
  note.textContent = text;
  view.el.append(note);
 }

 action(label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'message-action';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
 }

 userMessage({ text, attachments, origin = '', device = '' }) {
  const el = document.createElement('div');
  el.className = 'message is-user';
  // A message written somewhere else is labelled with where it came from; one written here
  // wears no label, so the app never tells you a message you just typed came from the app.
  if (origin && origin !== PLATFORM) {
   const badge = document.createElement('div');
   badge.className = `message-origin is-${origin}`;
   const label = I18n.t(`origin.${origin}`);
   badge.textContent = origin === 'app' && device ? `${label} · ${device}` : label;
   el.append(badge);
  }
  // A file that only has a path (a Discord attachment, a browser upload) gets a URL the
  // browser can open: the server streams it inline, the app reads it from disk. An image
  // becomes a real preview the user can press to open full size.
  const urlOf = item => item.url || (item.path ? FileUrl.of(item.path) : '');
  const images = attachments.filter(item => item.image && urlOf(item)), files = attachments.filter(item => !item.image);
  if (images.length) el.append(new MediaSlider(images.map(({ url, path, width, height, name, note }) => ({ url: url || FileUrl.of(path), width, height, name, note }))).el);
  if (files.length) {
   const box = document.createElement('div');
   box.className = 'message-files';
   for (const item of files) box.append(this.fileCard(item, origin));
   el.append(box);
  }
  const { quotes, rest } = splitQuotes(text);
  for (const quote of quotes) {
   const box = document.createElement('div');
   box.className = 'message-quote';
   box.innerHTML = Glyphs.quote;
   const body = document.createElement('span');
   body.className = 'message-quote-text';
   body.textContent = quote;
   box.title = quote;
   box.append(body);
   el.append(box);
  }
  if (rest) {
   const bubble = document.createElement('div');
   bubble.className = 'message-bubble';
   LinkChip.fill(bubble, rest);
   el.append(bubble);
  }
  if (text) {
   el.append(this.toolbar('user'));
   el.__entry = { content: text };
  }
  return el;
 }

 fileCard(item, origin = '') {
  const card = document.createElement('div');
  card.className = 'file-card';
  card.title = item.name;
  card.innerHTML = FileKinds.icon(item.info);
  const text = document.createElement('div');
  text.className = 'file-card-text';
  const name = document.createElement('div');
  name.className = 'file-card-name';
  name.textContent = item.name;
  const meta = document.createElement('div');
  meta.className = 'file-card-meta';
  // A file sent from Discord keeps its name and size only: the kind label ("Text · …") is
  // noise there, the panel already tells the story.
  meta.textContent = origin === 'discord' ? FileKinds.formatSize(item.size) : `${item.info.name} · ${FileKinds.formatSize(item.size)}`;
  text.append(name, meta);
  if (item.note) {
   const note = document.createElement('div');
   note.className = 'file-card-note';
   note.textContent = item.note;
   text.append(note);
  }
  card.append(text);
  // A press opens the file: text through the preview card the cards already use, a picture
  // in the lightbox. Files that cannot be read here say so instead of doing nothing.
  if (item.path) {
   card.classList.add('is-openable');
   card.tabIndex = 0;
   card.setAttribute('role', 'button');
   const open = async () => {
    const url = FileUrl.of(item.path);
    if (item.image) { window.Lightbox?.open([{ url, name: item.name }], 0); return; }
    try { await window.Artifacts?.preview?.({ path: item.path, name: item.name }); } catch {}
   };
   card.addEventListener('click', open);
   card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
  }
  return card;
 }

 assistantMessage(conv) {
  const el = document.createElement('div');
  el.className = 'message is-assistant is-streaming';
  // The same working ghost the local turn uses — the server's own screen keeps its dots.
  const own = document.documentElement.classList.contains('is-server-screen');
  const working = own
   ? '<span class="working-dots" aria-hidden="true"><i></i><i></i><i></i></span>'
   : '<ghost-thinking></ghost-thinking>';
  el.innerHTML = `<div class="message-status">${working}</div><div class="message-content markdown"></div>`;
  const content = el.querySelector('.message-content');
  const thinking = new ThinkingView();
  el.insertBefore(thinking.el, content);
  return { el, status: el.querySelector('.message-status'), content, thinking, stream: new StreamView(content, { onChange: () => { if (conv === this.active) this.followBottom(); } }) };
 }
}

window.Chat = Chat;
})();
