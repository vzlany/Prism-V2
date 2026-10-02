'use strict';

I18n.apply();

const app = document.querySelector('.app');
const sidebar = document.querySelector('.sidebar');
const sidebarToggle = document.querySelector('.sidebar-toggle');
const search = document.querySelector('.sidebar-search');
const searchButton = document.querySelector('.sidebar-search-button');
const searchInput = document.querySelector('.sidebar-search-input');
const main = document.querySelector('.main');
const thread = document.querySelector('.thread');
const composer = document.querySelector('.composer');
const composerField = document.querySelector('.composer-field');
const composerInput = document.querySelector('.composer-input');
const composerSend = document.querySelector('.composer-send');
const planButton = document.querySelector('.composer-plan');

let chatList = null;
let folderPill = null;
let modelStage = null;
let instructionsPill = null;
let effortSlider = null;
let liveView = null;

new SmoothHeight(composerField, composerInput);
// Keeps the room above the composer and the composer's own top edge in two custom properties,
// so anything that hangs from the composer (the pills, the welcome ghost) follows it everywhere.
const measureComposer = () => {
  const gap = parseFloat(getComputedStyle(main).getPropertyValue('--composer-bottom-gap')) || 0;
  main.style.setProperty('--composer-space', `${Math.ceil(composer.offsetHeight + gap)}px`);
  const box = composer.getBoundingClientRect(), frame = main.getBoundingClientRect();
  main.style.setProperty('--composer-top', `${Math.ceil(frame.bottom - box.top)}px`);
};
// The composer slides up and down between the empty and chat states over half a second;
// while that runs the top has to be read every frame or it stays where the slide began.
const settleComposer = () => {
  const until = performance.now() + 800;
  const step = () => {
    measureComposer();
    if (performance.now() < until) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};
new ResizeObserver(measureComposer).observe(composer);
new MutationObserver(settleComposer).observe(main, { attributes: true, attributeFilter: ['class'] });
window.addEventListener('resize', measureComposer);
new Scrollbar(composerInput, document.querySelector('.composer-scrollbar'));
const threadScrollbar = new Scrollbar(thread, document.querySelector('.thread-scrollbar'));
new Scrollbar(document.querySelector('.chats-scroll'), document.querySelector('.chats-scrollbar'));
const composerText = new ComposerText(composerInput, document.querySelector('.composer-mirror'));
LinkChip.watch(document.querySelector('.composer-mirror'));
LinkChip.watch(thread);
const settings = new Settings(document.querySelector('.settings'));
new SidebarResizer({ app, sidebar, handle: sidebar.querySelector('.sidebar-resizer') });
new Scrollbar(document.querySelector('.settings-page'), document.querySelector('.settings-scrollbar')).observe(document.querySelector('.settings-providers'));
const threadBottom = document.querySelector('.thread-bottom');
new LiquidGlass(threadBottom, { width: 36, height: 36 });
const library = new Library(ChatStore, syncAll);
window.addEventListener('pagehide', () => library.flush());
// The app's model catalog arrives (or leaves) with its heartbeat: the picker follows.
window.openghost?.app?.onStatus?.(() => { settings.loadShared?.().catch(() => {}); });
const chat = new Chat({ main, thread, bottom: threadBottom, settings, library, onChange: syncAll, onList: list => threadScrollbar.observe(list) });
const lockScreen = new LockScreen({ main, chat, composer, onOpen: () => composerInput.focus({ preventScroll: true }) });
// The store folder is shared with the desktop app and any other `prism web` window: when
// one of them makes a project or a chat, this window folds it into the list right away.
window.openghost?.store?.onChange?.(() => {
 library.reload().then(() => chat.rebind()).catch(() => {});
});
const lockCard = new LockCard({ chat, library, scroller: document.querySelector('.chats-scroll') });
new WelcomeGhost({ main, root: document.querySelector('.welcome'), input: composerInput });
folderPill = new FolderPill({ button: document.querySelector('.composer-folder'), library, chat, menu: document.querySelector('.folder-menu') });
instructionsPill = new InstructionsPill({ button: document.querySelector('.composer-instructions'), menu: document.querySelector('.instructions-menu'), chat });
planButton.addEventListener('click', () => chat.setAgentMode(chat.agentMode === 'plan' ? 'build' : 'plan'));
window.PrismPlan = { approve: () => chat.setAgentMode('build') };
window.__prismSubagent = (label, prompt, toolId) => chat.deploySubagent(prompt, label, toolId);
window.__prismChat = chat;
new ParallelPanel({
 button: document.querySelector('.composer-parallel'),
 panel: document.querySelector('.parallel-panel'),
 chat,
 settings,
 composerText,
 pickFolder: () => folderPill.pick(true),
 consume: () => {
  composerInput.value = '';
  composerText.refresh();
  clearDrafts();
  syncComposer();
 },
});
const parallelMeter = new ParallelMeter({ button: document.querySelector('.composer-parallels') });
// A conversation running on another page (the phone, a second window) shows the same busy
// ghost here: the list has to be repainted when presence arrives, not only on local changes.
// When such a run finishes, the chat is read again so its answer appears without a reload.
let presenceBusy = new Set();
// The chat on screen running on another device: its live card sits at the end of the thread
// and is rebuilt from the presence updates. When it ends the real conversation is read.
function syncLive() {
 const conv = chat.active;
 const info = conv && !conv.turn ? window.Presence?.info?.(conv.id) : null;
 if (conv && info?.parts?.length) {
  if (!liveView) liveView = new LiveView();
  if (liveView.el.parentElement !== conv.list) conv.list.append(liveView.el);
  liveView.update(info);
  if (chat.follow) chat.followBottom();
 } else if (liveView) {
  liveView.el.remove();
  liveView = null;
 }
}
window.Presence?.on?.(() => {
 const now = new Set(window.Presence.list().map(entry => entry.id));
 // A run this page started is not "elsewhere": its conversation is already live on screen,
 // and re-reading it from disk would rebuild the whole thread for nothing.
 for (const id of presenceBusy) {
  if (now.has(id)) continue;
  // A parallel run that was busy and now is not has finished in the app: mark it so.
  const run = (window.ParallelRuns?.runs || []).find(item => item.id === id);
  if (run && run.status === 'running') window.ParallelRuns.update(id, { status: 'completed' });
  if (window.Presence.ours(id)) continue;
  // A short beat: the app tells "over" the moment the chat is written, and the file is read
  // here through the server — this covers the tail of that write.
  setTimeout(() => chat.refresh(id).catch(() => {}), 350);
 }
 presenceBusy = now;
 // The app picked up a delegated turn: the wait is over and its run is being mirrored.
 for (const [id, conv] of chat.conversations) {
  if (!conv.waiting || !window.Presence.isBusy(id)) continue;
  clearTimeout(conv.waitingTimer);
  conv.waiting = 0;
 }
 if (chatList) chatList.render();
 syncLive();
});

// The shared store changed on its own (the app, or another window, saved a conversation):
// the open chat is read again at once, unless this page wrote it itself a moment ago.
const chatSync = new Map();
window.openghost?.store?.onChatChange?.(id => {
 const conv = chat.conversations.get(id);
 if (!conv || conv.turn || conv.waiting) return;
 clearTimeout(chatSync.get(id));
 chatSync.set(id, setTimeout(() => {
  chatSync.delete(id);
  const current = chat.conversations.get(id);
  if (!current || current.turn || current.waiting || window.Presence?.isBusy?.(id)) return;
  if (Date.now() - (current.savedAt || 0) < 1500) return;
  chat.refresh(id).catch(() => {});
 }, 200));
});

// A turn started on the website, handed to this app: the page wrote the user's message into
// the shared store first, so the chat is read again and then run here — it streams in this
// window and back to the phone like any other run of the app.
async function runDelegated(request) {
 const id = String(request?.chatId || '');
 console.log('[delegate] request', id);
 if (!id) return;
 // The website saves the index with a short debounce, so the chat record can land here a
 // moment after the request does: wait for it instead of giving up.
 for (let i = 0; i < 24 && !library.chat(id); i++) {
  await library.reload();
  if (library.chat(id)) break;
  await new Promise(resolve => setTimeout(resolve, 250));
 }
 if (!library.chat(id)) { console.log('[delegate] chat not in the store', id); return; }
 await chat.open(id);
 const conv = chat.conversations.get(id);
 if (!conv || conv.turn || conv.waiting) { console.log('[delegate] chat busy or missing', id); return; }
 for (let i = 0; i < 15; i++) {
  await chat.refresh(id);
  const last = conv.messages[conv.messages.length - 1];
  if (last?.role === 'user') break;
  await new Promise(resolve => setTimeout(resolve, 200));
 }
 if (conv.turn) { console.log('[delegate] the chat started running on its own', id); return; }
 const record = library.chat(id);
 // The model the website asked for, or the app's own when that one cannot run here.
 let config = settings.configFor(settings.resolve(request.model || record?.model || settings.model));
 if (!config.ready) config = settings.configFor(settings.model);
 if (!config.ready) {
  console.log('[delegate] no usable model for', request.model || record?.model || '');
  return;
 }
 console.log(`[delegate] running ${id} with ${config.provider}:${config.model}`);
 chat.resume(conv, config);
 if (conv === chat.active) chat.followBottom();
}
window.openghost?.delegate?.onRequest?.(request => { runDelegated(request).catch(() => {}); });
chatList = new ChatList({
  root: document.querySelector('.chats'),
  library,
  chat,
  onNewFolder: async () => {
    const folder = await library.pick();
    if (!folder) return;
    chat.newChat(folder);
    composerInput.focus();
  },
  onNewChat: (folder) => {
    chat.newChat(folder);
    composerInput.focus();
  },
  onLock: (id, row) => lockCard.open(id, row),
});
document.querySelector('.titlebar-name').innerHTML = `${Glyphs.ghost}<span>Prism V2</span>`;

// The conversation's size, context window and price live in the circle left of the composer.
new ContextCircle({
 button: document.querySelector('.context-circle'),
 panel: document.querySelector('.context-panel'),
 chat,
 settings,
});
const modeButton = document.querySelector('.composer-mode');
const browserToggle = document.querySelector('.browser-toggle');
let browserPanel = null;
if (AgentTools.available) {
  modeButton.hidden = false;
  new ModePicker({ button: modeButton, menu: document.querySelector('.mode-menu'), settings, onChange: () => chat.onModeChange() });
  if (window.openghost?.web) {
   browserToggle.hidden = true;
  } else {
   browserToggle.hidden = false;
   browserPanel = window.browserPanel = new BrowserPanel({ app, main, toggle: browserToggle });
   browserPanel.addRunsView(new RunsView({ chat }).el);
  }
}
const attachments = new Attachments({
  tray: document.querySelector('.composer-attachments'),
  picker: document.querySelector('.composer-picker'),
  panel: document.querySelector('.note-panel'),
  main,
  zone: document.querySelector('.drop-zone'),
  input: composerInput,
  onChange: syncComposer,
  isActive: () => !MiniChat.current && !chat.active?.locked,
});
// Steer: rewind the chat to that message and put its words back into the composer.
function steerMessage(message) {
  const conv = message?.closest('.thread-list')?.__conversation;
  if (!conv || conv !== chat.active) return;
  const entry = chat.entryOf(conv, message);
  if (!entry) return;
  const prompt = chat.rewind(conv, entry);
  if (prompt == null) return;
  composerInput.value = prompt;
  composerText.refresh();
  syncComposer();
  composerInput.focus({ preventScroll: true });
}

new SelectionMenu({
  onAsk: (text, box) => {
    const mini = box.closest('.mini')?.__mini;
    if (mini) { mini.quote(text); return; }
    composerText.insertQuote(text);
    syncComposer();
  },
  onMini: text => MiniChat.open({ settings, source: chat, quote: text }),
  onSteer: (text, box) => steerMessage(box.closest('.message')),
});
// The hover actions under a message speak the same way the selection menu does.
window.addEventListener('prism-steer-message', event => steerMessage(event.detail?.message));
window.addEventListener('prism-quote-message', event => {
  const { text, message } = event.detail || {};
  if (!text) return;
  const mini = message?.closest('.mini')?.__mini;
  if (mini) { mini.quote(text); return; }
  composerText.insertQuote(text);
  syncComposer();
  composerInput.focus({ preventScroll: true });
});
document.querySelector('.composer-add').addEventListener('add', () => attachments.pick());
settings.show(chat.model);
modelStage = new ModelStage({
  button: document.querySelector('.composer-model'),
  root: document.querySelector('.model-stage'),
  chat,
  settings,
  input: composerInput,
});
effortSlider = new EffortSlider({
  button: document.querySelector('.composer-effort'),
  panel: document.querySelector('.effort-panel'),
  settings,
});
effortSlider.lock(chat.busy);

document.querySelector('.sidebar-settings').addEventListener('settings-open', () => settings.open());

document.querySelector('.sidebar-new-chat').addEventListener('add', () => {
  chat.newChat();
  composerInput.focus();
});

function setSidebarCollapsed(collapsed) {
  app.classList.toggle('is-sidebar-collapsed', collapsed);
  sidebarToggle.toggleAttribute('collapsed', collapsed);
  sidebar.inert = collapsed;
  browserPanel?.fit();
}

// On a phone — the web mode or a narrow window — the sidebar starts closed and slides over the chat.
const narrowScreen = () => window.matchMedia('(max-width: 820px)').matches;
if (narrowScreen()) setSidebarCollapsed(true);
app.addEventListener('click', event => {
  if (event.target === app && narrowScreen()) setSidebarCollapsed(true);
});
sidebar.addEventListener('click', event => {
  if (!narrowScreen()) return;
  // A row's own buttons and the rename field act in place; only opening a chat puts the sidebar away.
  if (event.target.closest('[data-action], .rename-input')) return;
  if (event.target.closest('.chat-row, .sidebar-new-chat')) setSidebarCollapsed(true);
});

sidebarToggle.addEventListener('sidebar-toggle', () => {
  setSidebarCollapsed(!app.classList.contains('is-sidebar-collapsed'));
});

const searchField = new SearchField({
  root: search,
  button: searchButton,
  input: searchInput,
  clear: document.querySelector('.sidebar-search-clear'),
});
searchInput.addEventListener('input', () => chatList.setQuery(searchInput.value));

document.addEventListener('keydown', (event) => {
  if (event.code !== 'KeyK' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
  if (document.querySelector('dialog[open]')) return;
  event.preventDefault();
  if (app.classList.contains('is-sidebar-collapsed')) setSidebarCollapsed(false);
  searchField.focus();
});

composer.addEventListener('mousedown', (event) => {
  if (event.target === composer || event.target.classList.contains('composer-toolbar')) {
    event.preventDefault();
    composerInput.focus();
  }
});

function syncComposer() {
  const hasContent = Boolean(composerText.text().trim()) || Boolean(attachments.count);
  // While a reply is running the button stops it (empty composer) or steers it (words written).
  composerSend.mode = chat.busy ? (hasContent ? 'steer' : 'stop') : 'send';
  composerSend.toggleAttribute('disabled', !hasContent && !chat.busy);
  composerField.classList.toggle('has-value', composerInput.value !== '');
}

const DRAFT = 'openghost.draft.';
const draftKey = () => DRAFT + (chat.active?.id || 'new');
let draftTimer = 0;
function saveDraft(key = draftKey()) {
 const text = composerText.text();
 if (text.trim()) localStorage.setItem(key, text);
 else localStorage.removeItem(key);
}
function restoreDraft() {
 const text = localStorage.getItem(draftKey());
 if (!text || composerText.text().trim()) return;
 composerInput.value = text;
 composerText.refresh();
 syncComposer();
}
function clearDrafts() {
 localStorage.removeItem(DRAFT + 'new');
 if (chat.active?.id) localStorage.removeItem(DRAFT + chat.active.id);
}

// A draft belongs to the conversation it was typed in. Switching chats saves it under that
// chat's key and starts the new one empty (or with its own draft) — it used to stay in the
// box and be copied into whatever conversation was opened next.
let draftChat = null;
function switchDraft() {
 const key = draftKey();
 if (key === draftChat) return;
 if (draftChat !== null && composerText.text().trim()) saveDraft(draftChat);
 draftChat = key;
 composerInput.value = '';
 composerText.refresh();
 syncComposer();
 restoreDraft();
}

function syncAll() {
  if (!chatList) return;
  switchDraft();
  syncComposer();
  folderPill.sync();
  chatList.render();
  lockScreen.sync();
  settings.show(chat.model);
  if (planButton) {
   planButton.hidden = !AgentTools.available;
   const plan = chat.agentMode === 'plan';
   planButton.textContent = I18n.t(plan ? 'plan.on' : 'plan.off');
   planButton.classList.toggle('is-on', plan);
   planButton.title = I18n.t(plan ? 'plan.hintOn' : 'plan.hintOff');
  }
  modelStage?.sync();
  instructionsPill?.sync();
  effortSlider?.lock(chat.busy);
  syncLive();
}

async function send() {
  if (!composerText.text().trim() && !attachments.count) return;
  if (chat.needsFolder && !(await folderPill.pick(true))) {
    folderPill.nudge();
    return;
  }
  const text = composerText.text().trim();
  if ((!text && !attachments.count) || !chat.send(text, attachments.items)) return;
  attachments.take();
  composerInput.value = '';
  composerText.refresh();
  clearDrafts();
  syncComposer();
}

composerInput.addEventListener('input', syncComposer);

composerInput.addEventListener('input', () => {
 clearTimeout(draftTimer);
 // The key is taken now: a chat switched before the timer fires still gets its own draft.
 const key = draftKey();
 draftTimer = setTimeout(() => saveDraft(key), 500);
});
window.addEventListener('pagehide', () => saveDraft());
document.addEventListener('visibilitychange', () => { if (document.hidden) saveDraft(); });
setInterval(() => {
 if (composerText.text().trim()) saveDraft();
}, 3000);

composerInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && chat.busy && !event.isComposing && !document.querySelector(':popover-open, dialog[open]')) {
    event.preventDefault();
    chat.stop();
    return;
  }
  if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
  event.preventDefault();
  send();
});

composerSend.addEventListener('composer-send', () => send());
composerSend.addEventListener('composer-stop', () => chat.stop());

syncComposer();
