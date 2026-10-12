// Turns started from a website (a phone, another computer) run HERE, in the engine that
// serves the page — not in the page itself. A page that is refreshed, switched away from or
// closed can no longer kill the work: the server keeps driving the loop (model rounds, tools,
// titles, Discord DMs), publishes live presence for every page, and writes the conversation
// to the shared store as it goes, so any page that opens it sees the text so far plus the
// live card. The renderer modules (i18n, agent tools, agent prompt) are loaded behind the
// same window shim the Discord bridge uses, so the tool knowledge is the very same code.
//
// The page sends the round-0 context (system prompt, config, schemas); everything after that
// — the tool loop — is built here.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CONTEXT = { reserve: 0.1, chars: 3.2, image: 1200 };
const COMPACT = {
 prompt: "You compress a long conversation between a user and Prism V2, an AI agent working on the user's computer, so the work can go on without the original messages. Write a dense summary in the language the user writes in, with these parts: the user's goals and preferences; key facts, decisions and constraints; what has been done, with file paths, commands and their results, commits; the current state and open problems; the exact next steps. Keep names, paths, numbers, versions and code identifiers exact. Leave out small talk and whatever no longer matters.",
 head: 'The earlier part of this conversation was compacted to save context. Your tools, formatting rules and browser instructions still apply; this summary does not replace them. Summary of it:',
 resume: 'Go on with the task from where you stopped, using the summary above.',
 output: 8000,
};
const APPROVAL_NOTE = 'This step needs the user\'s approval and a run the website started has no window to ask in. Say in your reply what you wanted to do and why, then continue with something that does not need approval — or the user can run this again from the desktop app.';
const CANCELLED = 'The user stopped this. Don\'t retry it; say what you were doing and stop if they asked you to.';
const IMAGES_NOTE = 'The pictures from the tools you just ran follow.';
const WATCHDOG_MS = 5 * 60 * 1000;
const SAVE_EVERY = 1500;
const PUBLISH_EVERY = 40;
const HEARTBEAT = 4000;
const DISCORD_BLOCK = /<send_discord_message>([\s\S]*?)<\/send_discord_message>/gi;
const DISCORD_SUMMARY = /<discord_summary>([\s\S]*?)<\/discord_summary>/gi;
const DISCORD_FILE = /^@(?:file|image|attach)\s*:\s*(.+)$/i;
const ABSOLUTE_PATH = /^([a-zA-Z]:[\\/]|\\\\|\/)/;

const uid = () => {
 let out = '';
 while (out.length < 14) out += Math.random().toString(36).slice(2);
 return out.slice(0, 14);
};

const withFolder = (file, folder) => (ABSOLUTE_PATH.test(String(file || '')) || !folder
 ? String(file || '')
 : `${String(folder).replace(/[\\/]+$/, '')}/${String(file).replace(/^[\\/]+/, '')}`);

function parseDiscordBlock(inner) {
 const files = [], kept = [];
 for (const line of String(inner || '').replace(/\r/g, '').split('\n')) {
  const file = line.trim().match(DISCORD_FILE);
  if (file) { files.push(file[1].trim()); continue; }
  if (line.trim()) kept.push(line.trim());
 }
 return { text: kept.join('\n').trim(), files };
}

function decodeEntities(text) {
 return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, code) => {
  if (code[0] === '#') {
   const value = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
   try { return Number.isFinite(value) ? String.fromCodePoint(value) : all; } catch { return all; }
  }
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»', copy: '©', reg: '®', times: '×', middot: '·', bull: '•' };
  return named[code.toLowerCase()] ?? all;
 });
}

// A DOM-free page reader for fetch_url on the server (the page version uses DOMParser, which
// Node does not have). Good enough for articles, docs and search results.
function htmlToText(html) {
 const text = String(html || '')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<(script|style|noscript|template|svg|canvas|iframe|object|embed|head|nav|footer|aside)[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article|\/table|\/blockquote|\/pre)\s*\/?>/gi, '\n')
  .replace(/<(p|div|li|tr|h[1-6]|section|article|blockquote|pre|ul|ol|table|figure)[^>]*>/gi, '\n')
  .replace(/<[^>]+>/g, ' ');
 return decodeEntities(text).replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const titleOfHtml = html => decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''))?.[1] || '').replace(/\s+/g, ' ').trim());

function estimate(messages) {
 let chars = 0, images = 0;
 const add = value => {
  if (typeof value === 'string') chars += value.length;
  else if (Array.isArray(value)) for (const part of value) part?.type === 'image_url' ? images++ : add(part?.text);
 };
 for (const message of messages) {
  add(message.content);
  add(message.reasoning_content);
  for (const call of message.tool_calls || []) add(call.function?.arguments);
 }
 return Math.ceil(chars / CONTEXT.chars) + images * CONTEXT.image;
}

const textOf = content => typeof content === 'string' ? content : (Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text).join('\n') : String(content || ''));
const tail = (text, max) => { const value = String(text || ''); return value.length > max ? `…${value.slice(-max)}` : value; };

function assistantStep({ content, reasoning, toolCalls = [], native }) {
 const message = { role: 'assistant', content: content || '' };
 if (reasoning) message.reasoning_content = reasoning;
 if (native) message.native = native;
 if (toolCalls.length) {
  message.tool_calls = toolCalls.map((call, k) => ({
   id: call.id || `call_${Date.now().toString(36)}_${k}`,
   type: 'function',
   function: { name: call.function?.name || '', arguments: call.function?.arguments || '{}' },
  }));
 }
 return message;
}

function imageStep(images) {
 const content = [{ type: 'text', text: IMAGES_NOTE }];
 for (const { label, url } of images) content.push({ type: 'text', text: label }, { type: 'image_url', image_url: { url } });
 return { role: 'user', content };
}

// ----------------------------------------------------------------- the keeper
export function createKeeper({ host, userData, root, log = () => {}, publish = () => {} }) {
 const runs = new Map();
 const storeDir = join(userData, 'store');

 // -------------------------------------------------- renderer modules on a window shim
 const window = {};
 globalThis.window = window;
 globalThis.document = { documentElement: { lang: 'en', classList: { add() {}, remove() {}, contains: () => false, toggle() {} } }, querySelector: () => null, querySelectorAll: () => [] };
 globalThis.navigator = { language: 'en' };
 globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
 window.document = globalThis.document;
 window.navigator = globalThis.navigator;
 window.localStorage = globalThis.localStorage;
 let currentRun = null;
 const rawTool = (id, name, args, cwd) => host.invoke('tool:run', id, name, args, cwd);
 window.openghost = {
  tools: {
   run: (id, name, args, cwd) => rawTool(id, name, args, cwd),
   cancel: id => host.invoke('tool:cancel', id),
   environment: () => host.invoke('tool:environment'),
  },
  mcp: { tools: () => host.invoke('mcp:tools'), call: (name, args) => host.invoke('mcp:call', name, args) },
  memory: {
   list: () => host.invoke('memory:list'),
   add: text => host.invoke('memory:add', text),
   update: (id, text) => host.invoke('memory:update', id, text),
   remove: id => host.invoke('memory:remove', id),
  },
  discord: {
   get: () => host.invoke('discord:get'),
   message: payload => host.invoke('discord:message', payload),
  },
  update: {
   run: args => host.invoke('update:run', args),
  },
 };
 for (const file of ['i18n.js', 'agent-prompt.js', 'agent-tools.js']) {
  try { new Function('window', readFileSync(join(root, 'app', file), 'utf8'))(window); } catch (error) { log(`could not load ${file}: ${error.message}`); }
 }
 const AgentTools = window.AgentTools || null;
 const AgentPrompt = window.AgentPrompt || null;
 const I18n = window.I18n || null;
 const t = (key, vars) => { try { return I18n ? I18n.t(key, vars) : key; } catch { return key; } };

 // -------------------------------------------------- store files
 const chatFile = id => join(storeDir, 'chats', `${id}.json`);
 const indexFile = () => join(storeDir, 'index.json');
 const writes = new Map();
 const readJson = (file, fallback = null) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
 const writeJson = (file, body) => {
  try {
   mkdirSync(join(storeDir, 'chats'), { recursive: true });
   const temp = `${file}.tmp`;
   writeFileSync(temp, JSON.stringify(body));
   renameSync(temp, file);
  } catch (error) { log(`store write failed: ${error.message}`); }
 };
 const queueWrite = (id, job) => {
  const chain = (writes.get(id) || Promise.resolve()).then(job).catch(error => log(`save failed: ${error.message}`));
  writes.set(id, chain);
  chain.finally(() => { if (writes.get(id) === chain) writes.delete(id); });
  return chain;
 };

 function flushSave(run) {
  if (!run.dirty) return Promise.resolve();
  run.dirty = false;
  run.savedAt = Date.now();
  return queueWrite(run.chatId, () => {
   const body = readJson(chatFile(run.chatId), null);
   if (body?.sealed) return;
   const next = body && typeof body === 'object' ? body : { version: 1 };
   next.version = next.version || 1;
   next.messages = run.entries;
   next.tokens = Math.round(run.tokens || 0);
   if (run.todos.length) next.todos = run.todos;
   writeJson(chatFile(run.chatId), next);
   touchIndex(run);
  });
 }

 function scheduleSave(run, force = false) {
  run.dirty = true;
  if (force) { clearTimeout(run.saveTimer); run.saveTimer = 0; return flushSave(run); }
  if (run.saveTimer) return Promise.resolve();
  run.saveTimer = setTimeout(() => { run.saveTimer = 0; flushSave(run); }, SAVE_EVERY);
  return Promise.resolve();
 }

 const indexTimers = new Map();
 function touchIndex(run) {
  clearTimeout(indexTimers.get(run.chatId));
  indexTimers.set(run.chatId, setTimeout(() => {
   indexTimers.delete(run.chatId);
   const index = readJson(indexFile(), null);
   if (!index || !Array.isArray(index.chats)) return;
   const record = index.chats.find(item => item?.id === run.chatId);
   if (!record) return;
   record.updated = Date.now();
   if (run.title) record.title = run.title;
   writeJson(indexFile(), index);
  }, 900));
 }

 function createChat({ folder, title, parent, task }) {
  const id = uid();
  const now = Date.now();
  const index = readJson(indexFile(), { version: 1, folders: [], chats: [] }) || {};
  index.version = index.version || 1;
  if (!Array.isArray(index.chats)) index.chats = [];
  if (!Array.isArray(index.folders)) index.folders = [];
  if (folder && !index.folders.some(item => item?.path === folder)) index.folders.push({ path: folder, name: String(folder).split(/[\\/]/).filter(Boolean).pop() || folder, collapsed: false, added: now });
  index.chats.push({ id, title: String(title || 'Sub-agent').slice(0, 120), folder, created: now, updated: now, pinned: false, named: true, ...(parent ? { parent, subagent: true, task: String(task || '').slice(0, 400) } : {}) });
  writeJson(indexFile(), index);
  writeJson(chatFile(id), { version: 1, messages: [], tokens: 0 });
  return id;
 }

 // -------------------------------------------------- presence
 function snapshot(run) {
  const kept = [];
  let budget = 20000;
  for (let i = run.parts.length - 1; i >= 0 && kept.length < 20; i--) {
   const part = run.parts[i];
   const copy = part.kind === 'text'
    ? { ...part, text: String(part.text || '').slice(0, 8000) }
    : { ...part, text: part.kind === 'thinking' ? tail(part.text, 2400) : part.text, output: tail(part.output, 1200) };
   const size = (copy.text || '').length + (copy.output || '').length + (copy.title || '').length + (copy.summary || '').length;
   if (budget - size < 0 && kept.length) break;
   budget -= size;
   kept.unshift(copy);
  }
  const last = run.parts[run.parts.length - 1] || null;
  const status = last?.kind === 'text' ? 'writing' : last?.kind === 'tool' && last.state === 'running' ? 'working' : 'thinking';
  return {
   id: run.chatId,
   origin: 'keeper',
   keeper: true,
   state: 'running',
   title: String(run.title || '').slice(0, 120),
   model: run.model,
   started: run.started,
   status,
   parallel: Boolean(run.parent),
   subagent: Boolean(run.parent),
   todos: run.todos.slice(0, 40).map(item => ({ text: String(item?.text || '').slice(0, 200), state: String(item?.state || 'idle') })),
   parts: kept,
   at: Date.now(),
  };
 }

 function publishNow(run) {
  run.publishAt = Date.now();
  try { publish(run.chatId, snapshot(run)); } catch (error) { log(`presence failed: ${error.message}`); }
  if (!run.beat) run.beat = setInterval(() => { if (runs.has(run.chatId)) publishNow(run); }, HEARTBEAT);
 }

 function publishSoon(run) {
  if (run.publishTimer) return;
  const wait = Math.max(0, PUBLISH_EVERY - (Date.now() - (run.publishAt || 0)));
  run.publishTimer = setTimeout(() => { run.publishTimer = 0; publishNow(run); }, wait);
 }

 function unpublish(run) {
  clearInterval(run.beat);
  run.beat = 0;
  clearTimeout(run.publishTimer);
  run.publishTimer = 0;
  try { publish(run.chatId, null); } catch {}
 }

 // -------------------------------------------------- live parts
 function openPart(run) {
  run.entry = { role: 'assistant', content: '', steps: [], turn: run.id };
  run.entries.push(run.entry);
  run.part = null; // parts are created lazily: a thinking box only when there is a thought
 }

 function partThinking(run) {
  if (!run.part?.thinking) {
   run.part ||= {};
   run.part.thinking = { kind: 'thinking', text: '', live: true };
   run.parts.push(run.part.thinking);
  }
  return run.part.thinking;
 }

 function partText(run) {
  if (!run.part?.text) {
   run.part ||= {};
   run.part.text = { kind: 'text', text: '' };
   run.parts.push(run.part.text);
  }
  return run.part.text;
 }

 function closePart(run) {
  if (run.part?.thinking) run.part.thinking.live = false;
  run.part = null;
 }

 // -------------------------------------------------- discord blocks in the reply
 function flushDiscordBlocks(run) {
  const content = String(run.entry.content || '');
  if (!content.includes('<send_discord_message>')) return;
  const blocks = [];
  DISCORD_BLOCK.lastIndex = 0;
  let match;
  while ((match = DISCORD_BLOCK.exec(content))) blocks.push(parseDiscordBlock(match[1]));
  if (!blocks.length) return;
  run.sentDiscord ||= new Set();
  for (const block of blocks) {
   const key = `${block.text}\u0000${block.files.join('\u0000')}`;
   if (run.sentDiscord.has(key)) continue;
   run.sentDiscord.add(key);
   try { host.invoke('discord:message', { text: block.text, files: block.files.map(file => withFolder(file, run.folder)), chatId: run.chatId }).catch(() => {}); } catch {}
  }
  DISCORD_BLOCK.lastIndex = 0;
  run.entry.content = content.replace(DISCORD_BLOCK, '').replace(/\n{3,}/g, '\n\n').trim();
  if (run.part?.text) run.part.text.text = run.entry.content;
 }

 function flushDiscordSummary(run) {
  const content = String(run.entry.content || '');
  if (!content.includes('<discord_summary>')) return;
  let match = null, last = '';
  DISCORD_SUMMARY.lastIndex = 0;
  while ((match = DISCORD_SUMMARY.exec(content))) last = String(match[1] || '').trim();
  if (!last) return;
  run.discordSummary = last.slice(0, 16000);
  DISCORD_SUMMARY.lastIndex = 0;
  run.entry.content = content.replace(DISCORD_SUMMARY, '').replace(/\n{3,}/g, '\n\n').trim();
  if (run.part?.text) run.part.text.text = run.entry.content;
 }

 // -------------------------------------------------- the todo tool (same list the page keeps)
 function keeperTodo(run, args = {}) {
  const action = String(args.action || 'view').toLowerCase();
  const items = () => run.todos;
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
   run.todos = (Array.isArray(args.items) ? args.items : []).map(text => ({ text: String(text).trim(), state: 'idle' })).filter(item => item.text);
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
  scheduleSave(run, true);
  publishNow(run);
  const list = items();
  if (!list.length) return 'The todo list is empty.';
  const sign = { idle: '[ ]', doing: '[~]', done: '[x]', failed: '[!]' };
  const done = list.filter(item => item.state === 'done').length;
  return `Todo (${done}/${list.length} done):\n${list.map(item => `${sign[item.state] || '[ ]'} ${item.text}`).join('\n')}`;
 }

 // -------------------------------------------------- the agents tool (list / read / wait)
 async function keeperAgents(run, args = {}) {
  const action = String(args.action || 'list').toLowerCase();
  const index = readJson(indexFile(), { chats: [] }) || {};
  const chats = Array.isArray(index.chats) ? index.chats : [];
  const children = chats.filter(record => record.parent === run.chatId);
  const busy = id => runs.has(id);
  if (action === 'read') {
   const record = chats.find(item => item.id === args.id);
   if (!record) return 'No such agent — call agents list first.';
   const body = readJson(chatFile(record.id), null);
   const answer = [...(body?.messages || [])].reverse().find(entry => entry.role === 'assistant' && String(entry.content || '').trim());
   return answer ? `Newest from ${record.title || record.id}:\n${String(answer.content).slice(0, 100000)}` : `${record.title || record.id} has not written an answer yet.`;
  }
  if (action === 'wait') {
   const watching = [...runs.values()].filter(child => child.parent === run.chatId && !child.ended);
   if (!watching.length) {
    const newest = [...children].sort((a, b) => (Number(b.updated) || 0) - (Number(a.updated) || 0))[0];
    return newest ? `No agent of yours is running. Newest finished: ${newest.title || newest.id} (id ${newest.id}) — read it with agents read ${newest.id}.` : 'You have no agents running or finished.';
   }
   const started = Date.now();
   while (Date.now() - started < 20 * 60 * 1000) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (run.stopped) return 'Stopped while waiting.';
    const finished = [...runs.values()].some(child => child.parent === run.chatId && child.ended) || !watching.some(child => !child.ended);
    if (!finished) continue;
    const record = [...children].sort((a, b) => (Number(b.updated) || 0) - (Number(a.updated) || 0))[0];
    const body = record ? readJson(chatFile(record.id), null) : null;
    const answer = [...(body?.messages || [])].reverse().find(entry => entry.role === 'assistant' && String(entry.content || '').trim());
    return `Agent finished: ${record?.title || 'a sub-agent'}.${answer ? ` Its report:\n${String(answer.content).slice(0, 100000)}` : ''}`;
   }
   return 'Still running after 20 minutes.';
  }
  if (action === 'ask') return 'Messaging another agent with agents ask is only available in the desktop app. Use subagent to launch one from here.';
  const list = [];
  for (const record of chats) {
   if (record.id === run.chatId) continue;
   if (!children.includes(record) && !busy(record.id)) continue;
   list.push(`- ${record.title || record.id} (id ${record.id})${busy(record.id) ? ' — working now' : ''}${record.parent === run.chatId ? ' — launched by this chat' : ''}`);
  }
  if (!list.length) return 'No other agents are running or were launched from this chat. subagent launches one.';
  return `Agents:\n${list.join('\n')}`;
 }

 // -------------------------------------------------- sub-agents (their own chat, their own run)
 async function startSubagent(run, { label, prompt, options = {} }) {
  if (run.depth >= 2) throw new Error('Sub-agents cannot start more sub-agents.');
  const task = String(prompt || '').trim();
  if (!task) return null;
  const id = createChat({ folder: run.folder, title: String(label || 'Sub-agent').slice(0, 100), parent: run.chatId, task });
  const config = { ...run.config };
  if (options.effort) config.effort = String(options.effort);
  if (options.model && String(options.model).includes(':')) config.model = String(options.model);
  const child = spawn({
   id: `s-${uid()}`,
   chatId: id,
   folder: run.folder,
   mode: run.mode,
   title: String(label || 'Sub-agent').slice(0, 100),
   system: await subagentSystem(run, label, task),
   config,
   tools: run.tools,
   parent: run.chatId,
   depth: run.depth + 1,
   seedEntries: [{ role: 'user', text: task, content: task, origin: 'agent', from: run.chatId }],
  });
  runs.set(id, child);
  log(`sub-agent ${id} started for ${run.chatId}`);
  return await child.done;
 }

 async function subagentSystem(run, label, task) {
  let env = null;
  try { env = await AgentTools.environment(); } catch {}
  let memory = '';
  try {
   const items = (await host.invoke('memory:list')) || [];
   if (items.length) memory = ['# Memory', ...items.map(item => `- ${item.text}`)].join('\n');
  } catch {}
  let mcp = '';
  try { await AgentTools.refreshMcp(); mcp = AgentTools.mcpSummary(); } catch {}
  const base = AgentPrompt?.build
   ? AgentPrompt.build({ folder: run.folder, mode: run.mode, env, browser: '', mcp, memory, plan: '', instructions: '', skills: '', now: new Date() })
   : 'You are Prism V2, an AI agent working on the user\'s computer.';
  return `${base}\n\n# Sub-agent\nYou are a sub-agent launched by Prism V2. You work alone, in your own conversation, on ONE task, and report back to the agent that launched you. The user does not see your messages — your final answer IS your report: complete, specific and self-contained (what you did, what you found, exact paths, commands, results, and whatever the caller still has to know). Never ask questions; if something is missing, say so in the report.\n\nYour task${label ? ` ("${label}")` : ''}: ${task}`;
 }

 // -------------------------------------------------- one model round
 function stream(run, messages) {
  return new Promise((resolve, reject) => {
   const id = `kr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
   run.llmId = id;
   let content = '', reasoning = '';
   let watchdog = 0;
   const bump = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
     try { host.emit('llm:abort', id); } catch {}
     reject(Object.assign(new Error('the model stopped responding'), { empty: !content && !reasoning }));
    }, WATCHDOG_MS);
   };
   const sender = {
    send: (channel, data) => {
     if (channel !== 'llm:event' || data?.id !== id) return;
     bump();
     if (data.type === 'content') {
      content += data.delta;
      const part = partText(run);
      part.text += data.delta;
      const thinking = run.part?.thinking;
      if (thinking) thinking.live = false;
      run.entry.content = (run.entry.content || '') + data.delta;
      flushDiscordBlocks(run);
      flushDiscordSummary(run);
      scheduleSave(run);
      publishSoon(run);
     } else if (data.type === 'reasoning') {
      reasoning += data.delta;
      const part = partThinking(run);
      part.text = tail(part.text + data.delta, 2400);
      part.live = true;
      run.entry.thinking = (run.entry.thinking || '') + data.delta;
      publishSoon(run);
     } else if (data.type === 'done') {
      clearTimeout(watchdog);
      resolve({
       content: data.result?.content ?? content,
       reasoning: data.result?.reasoning ?? reasoning,
       toolCalls: (data.result?.toolCalls || []).filter(call => call?.function?.name),
       finishReason: data.result?.finishReason || null,
       usage: data.result?.usage || null,
       native: data.result?.native || null,
      });
     } else if (data.type === 'error') {
      clearTimeout(watchdog);
      const error = Object.assign(new Error(data.aborted ? 'Aborted' : (data.message || 'the model stopped')), {
       name: data.aborted ? 'AbortError' : 'Error',
       aborted: Boolean(data.aborted),
       status: data.status || 0,
       empty: !content && !reasoning,
      });
      reject(error);
     }
    },
    isDestroyed: () => false,
   };
   bump();
   host.setSender(sender);
   const config = run.config || {};
   host.emit('llm:start', id, {
    provider: config.provider,
    key: config.key,
    model: config.model,
    effort: config.effort,
    vision: config.vision,
    thinking: config.thinking,
    output: config.output,
    messages,
    tools: run.tools || undefined,
    session: run.chatId,
   });
  });
 }

 // -------------------------------------------------- conversation history
 function addressOf(entry) {
  const content = entry.content ?? entry.text ?? '';
  const prefix = entry.origin === 'discord' ? '[sent from Discord] '
   : entry.device ? `[sent from ${entry.device} over the network — answer on this machine] `
   : entry.origin === 'web' ? '[sent from the website] '
   : entry.origin === 'agent' ? `[from agent "${entry.from || 'another agent'}" — this is its message, its chat is separate] `
   : '';
  if (Array.isArray(content)) return prefix ? [{ type: 'text', text: prefix.trimEnd() }, ...content] : content;
  const text = typeof content === 'string' ? content : String(content || '');
  return prefix ? `${prefix}${text}` : text;
 }

 function historyOf(run) {
  const out = [];
  const messages = run.entries;
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'compact') { start = i; break; }
  for (const entry of messages.slice(start)) {
   if (entry.role === 'compact') {
    out.push({ role: 'system', content: `${COMPACT.head}\n\n${entry.summary}` });
    if (entry.resume) out.push({ role: 'user', content: COMPACT.resume });
   } else if (entry.role === 'user') {
    out.push({ role: 'user', content: addressOf(entry) });
   } else if (entry.role === 'assistant') {
    if (entry.steps?.length) out.push(...entry.steps);
    else if (entry.content) out.push({ role: 'assistant', content: entry.content });
   }
  }
  return out;
 }

 // -------------------------------------------------- one model call, with calm retries
 async function request(run) {
  const messages = [{ role: 'system', content: run.system || '' }, ...historyOf(run)];
  const tries = 3, pause = 5000;
  let result = null;
  for (let attempt = 1; ; attempt++) {
   try {
    result = await stream(run, messages);
    break;
   } catch (error) {
    const aborted = error?.aborted || error?.name === 'AbortError' || run.stopped;
    // Once tokens have arrived a retry would double them: only empty failures are retried.
    if (aborted || attempt > tries || !error?.empty) throw error;
    log(`model call for ${run.chatId} failed (${error.message}); retrying in ${pause / 1000}s (${attempt}/${tries})`);
    await new Promise(resolve => setTimeout(resolve, pause));
    if (run.stopped) throw Object.assign(new Error('Aborted'), { aborted: true });
   }
  }
  run.tokens = estimate(messages) + estimate([assistantStep(result)]);
  return result;
 }

 function countUsage(run, step) {
  const usage = step.usage;
  if (!usage) return;
  run.spend ||= { input: 0, cached: 0, written: 0, output: 0, reasoning: 0, context: 0 };
  const details = usage.prompt_tokens_details || {};
  run.spend.input += Number(usage.prompt_tokens || 0) || 0;
  run.spend.output += Number(usage.completion_tokens || 0) || 0;
  run.spend.cached += Number(details.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0) || 0;
  run.spend.written += Number(details.cache_creation_input_tokens ?? details.cache_write_tokens ?? 0) || 0;
  run.spend.reasoning += Number(usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens ?? 0) || 0;
  run.spend.context = Math.max(run.spend.context || 0, Number(usage.prompt_tokens || 0) || 0);
 }

 // -------------------------------------------------- tools
 async function keeperTool(run, id, name, args, cwd) {
  if (name === 'fetch_url') {
   const result = await rawTool(id, 'fetch_url', args, cwd);
   if (result?.error) return `Error: ${result.error}`;
   const head = `${result.url}${result.status >= 400 ? ` (HTTP ${result.status})` : ''}`;
   if (result.text === null || result.text === undefined) return `${head}\nThis is ${result.type || 'binary content'} (${result.size}), it can't be read as text.`;
   let text = String(result.text);
   if (/html|xml/i.test(result.type || '') || /^\s*<(!doctype|html)/i.test(text)) {
    const title = titleOfHtml(text);
    text = htmlToText(text);
    if (title) text = `# ${title}\n\n${text}`;
   } else if (/json/i.test(result.type || '')) {
    try { text = JSON.stringify(JSON.parse(text), null, 1); } catch {}
   }
   const PAGE_CHARS = 40000;
   const from = Math.max(0, Math.floor(Number(args?.start) || 0)), part = text.slice(from, from + PAGE_CHARS), end = from + part.length;
   const tailNote = end < text.length ? `\n\n[Characters ${from}–${end} of ${text.length}. Call fetch_url with start=${end} to read further.]` : '';
   return `${head}\n\n${part || '(empty page)'}${tailNote}`;
  }
  if (name === 'web_search') {
   const query = String(args?.query || '').trim();
   if (!query) return 'Error: query is empty';
   const q = encodeURIComponent(query);
   let error = '';
   for (const url of [`https://html.duckduckgo.com/html/?q=${q}`, `https://www.bing.com/search?q=${q}&setlang=en`]) {
    const result = await rawTool(id, 'fetch_url', { url }, cwd);
    if (result?.error) { error = result.error; continue; }
    const found = parseResults(String(result.text || ''));
    if (found.length) return found.slice(0, 8).map((item, k) => `${k + 1}. ${item.title}\n${item.url}${item.snippet ? `\n${item.snippet}` : ''}`).join('\n\n');
   }
   return error ? `Error: ${error}` : `Nothing was found for ${query}`;
  }
  if (name === 'todo') return keeperTodo(run, args);
  if (name === 'agents') return await keeperAgents(run, args);
  if (name === 'subagent') {
   const report = await startSubagent(run, { label: String(args?.description ?? ''), prompt: String(args?.prompt ?? ''), options: args || {} });
   if (!report) return 'The subagent could not be started.';
   return `Subagent "${String(args?.description ?? 'task')}" finished. Its report:\n${report}`;
  }
  if (name === 'ask_user') return 'The question card cannot be shown for a run started from the website. Put the question in your reply and stop.';
  return await AgentTools.run(name, args, { id, cwd });
 }

 function parseResults(html) {
  const out = [];
  const content = String(html || '');
  let match;
  const ddg = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/gi;
  while ((match = ddg.exec(content))) {
   let url = decodeEntities(match[1]);
   try { const parsed = new URL(url, 'https://duckduckgo.com'); url = parsed.searchParams.get('uddg') || parsed.href; } catch {}
   if (!/^https?:/.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
   out.push({ title: htmlToText(match[2]).slice(0, 200), url, snippet: htmlToText(match[3] || '').slice(0, 300) });
   if (out.length >= 10) break;
  }
  if (out.length) return out;
  const bing = /<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi;
  while ((match = bing.exec(content))) {
   let url = decodeEntities(match[1]);
   try { const encoded = new URL(url).searchParams.get('u'); if (encoded?.startsWith('a1')) url = Buffer.from(encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch {}
   if (!/^https?:/.test(url)) continue;
   out.push({ title: htmlToText(match[2]).slice(0, 200), url, snippet: htmlToText(match[3]).slice(0, 300) });
   if (out.length >= 10) break;
  }
  return out;
 }

 async function useTool(run, call) {
  const name = call.function?.name || '';
  const id = `${run.chatId}-${run.toolCount = (run.toolCount || 0) + 1}`;
  let args = {};
  try { args = JSON.parse(call.function.arguments || '{}') || {}; } catch {
   return `Error: the arguments are not valid JSON: ${String(call.function.arguments).slice(0, 300)}. Call the tool again with valid JSON.`;
  }
  // Approval rules are the app's own (AgentTools.needsApproval); a server run has no window
  // to ask in, so a step that would need one is declined with a note instead of hanging.
  const approval = (() => { try { return AgentTools?.needsApproval?.(name, args, { mode: run.mode, cwd: run.folder }) === true; } catch { return false; } })();
  if (approval && run.mode !== 'full') return APPROVAL_NOTE;
  const described = (() => { try { return AgentTools?.describe?.(name, args, run.folder) || {}; } catch { return {}; } })();
  const card = {
   kind: 'tool',
   tool: name,
   toolKind: described.kind || 'command',
   title: described.reason || described.title || name,
   summary: String(described.code || described.text || described.url || described.path || '').slice(0, 300),
   state: 'running',
   ms: null,
   output: '',
  };
  run.parts.push(card);
  if (run.part) run.part.card = card;
  publishNow(run);
  run.toolId = id;
  run.toolName = name;
  const began = Date.now();
  let output;
  try {
   host.setSender({ send: () => {}, isDestroyed: () => false });
   output = await keeperTool(run, id, name, args, run.folder);
  } catch (error) {
   output = `Error: ${error.message}`;
  } finally {
   run.toolId = '';
   run.toolName = '';
  }
  const text = typeof output === 'string' ? output : String(output?.text ?? JSON.stringify(output ?? ''));
  card.state = /^Error/.test(text) ? 'error' : 'done';
  card.ms = Date.now() - began;
  card.output = tail(text, 1200);
  if (output && typeof output === 'object' && output.files?.length) {
   run.files ||= [];
   for (const file of output.files) run.files.push({ ...file, cwd: run.folder });
  }
  call.ms = card.ms;
  scheduleSave(run, true);
  publishNow(run);
  return output;
 }

 // -------------------------------------------------- compaction
 async function compactIfNeeded(run) {
  const windowSize = Number(run.config?.context) || 128000;
  const used = run.tokens || estimate([{ role: 'system', content: run.system || '' }, ...historyOf(run)]);
  if (used < windowSize * (1 - CONTEXT.reserve)) return;
  log(`compacting ${run.chatId} (about ${used} of ${windowSize} tokens)`);
  let summary = '';
  try {
   const transcript = historyOf(run)
    .map(message => {
     if (message.role === 'user') return `User: ${textOf(message.content)}`;
     if (message.role === 'assistant') return `${message.content || ''}${(message.tool_calls || []).map(call => `\n[Tool ${call.function?.name}] ${String(call.function?.arguments || '').slice(0, 2000)}`).join('')}`;
     if (message.role === 'tool') return `[Result] ${String(message.content || '').slice(0, 2000)}`;
     return '';
    })
    .filter(Boolean)
    .join('\n\n');
   summary = await simpleComplete(run, [{ role: 'system', content: COMPACT.prompt }, { role: 'user', content: transcript }], COMPACT.output);
  } catch (error) {
   log(`compaction failed: ${error.message}`);
   return;
  }
  if (!summary) return;
  // The notice sits before the newest assistant part, like the app's own compaction: the page
  // draws it as the "compacted" row and history() reads everything after it.
  const at = Math.max(0, run.entries.indexOf(run.entry));
  run.entries.splice(at, 0, { role: 'compact', summary, resume: true });
  run.dirty = true;
  await flushSave(run);
  publishNow(run);
 }

 // A short side call (compaction, naming) on the same config, without touching run state.
 function simpleComplete(run, messages, maxTokens) {
  return new Promise((resolve, reject) => {
   const id = `ks-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
   let content = '';
   const sender = {
    send: (channel, data) => {
     if (channel !== 'llm:event' || data?.id !== id) return;
     if (data.type === 'content') content += data.delta;
     else if (data.type === 'done') resolve(String(data.result?.content ?? content).trim());
     else if (data.type === 'error') reject(new Error(data.aborted ? 'Aborted' : (data.message || 'failed')));
    },
    isDestroyed: () => false,
   };
   host.setSender(sender);
   const config = run.config || {};
   const efforts = config.efforts || [];
   const effort = efforts.includes('none') ? 'none' : efforts.find(level => level !== 'default') || '';
   host.emit('llm:start', id, {
    provider: config.provider,
    key: config.key,
    model: config.model,
    effort,
    messages,
    maxTokens: config.provider === 'anthropic' ? Math.max(maxTokens, 2048) : maxTokens,
    session: run.chatId,
   });
  });
 }

 async function nameChat(run) {
  const user = run.entries.find(entry => entry.role === 'user');
  const reply = run.entries.find(entry => entry.role === 'assistant' && String(entry.content || '').trim());
  if (!user || !reply) return;
  const index = readJson(indexFile(), null);
  const record = index?.chats?.find(item => item.id === run.chatId);
  if (!record || record.named) return;
  const asked = user.text || (user.attachments || []).map(item => item.name).join(', ');
  const title = await simpleComplete(run, [
   { role: 'system', content: 'Name this conversation in 2 to 5 words in the language of the user message. Reply with the name only, without quotes, emoji or a final period.' },
   { role: 'user', content: `${String(asked || '').slice(0, 1500)}\n\n${String(reply.content || '').slice(0, 800)}` },
  ], 40).catch(() => '');
  const clean = String(title).replace(/^[\s"'«“„]+|[\s"'»”.!]+$/g, '').replace(/\s+/g, ' ').slice(0, 60);
  if (!clean) return;
  const fresh = readJson(indexFile(), null);
  const target = fresh?.chats?.find(item => item.id === run.chatId);
  if (!target) return;
  target.title = clean;
  target.named = true;
  run.title = clean;
  writeJson(indexFile(), fresh);
 }

 // -------------------------------------------------- the loop
 async function runLoop(run) {
  try {
   if (!run.config?.model) throw new Error('no model is set for this chat');
   for (;;) {
    throwIfStopped(run);
    await compactIfNeeded(run);
    throwIfStopped(run);
    const step = await request(run);
    const calls = step.toolCalls;
    run.entry.steps.push(assistantStep(step));
    if (String(step.content || '').length) run.entry.content = step.content;
    if (step.reasoning) run.entry.thinking = step.reasoning;
    const part = run.part?.text;
    if (part) part.text = run.entry.content;
    countUsage(run, step);
    await flushSave(run);
    publishNow(run);
    if (!calls.length) { finishRun(run, null); return; }
    const images = [];
    const outputs = new Array(calls.length);
    const runOne = async index => {
     const call = calls[index];
     const output = run.stopped ? CANCELLED : await useTool(run, call);
     outputs[index] = typeof output === 'string' ? output : output?.text;
     if (output?.images?.length) images.push(...output.images);
    };
    // Several subagents in one round work at the same time, like the app's parallel runs.
    const parallel = [];
    for (let index = 0; index < calls.length; index++) if (calls[index].function?.name === 'subagent') parallel.push(index);
    if (parallel.length > 1) await Promise.all(parallel.map(runOne));
    for (let index = 0; index < calls.length; index++) if (outputs[index] === undefined) await runOne(index);
    for (let index = 0; index < calls.length; index++) {
     run.entry.steps.push({ role: 'tool', tool_call_id: calls[index].id, content: outputs[index] ?? '' });
    }
    if (images.length) run.entry.steps.push(imageStep(images));
    await flushSave(run);
    throwIfStopped(run);
    closePart(run);
    openPart(run);
    publishNow(run);
   }
  } catch (error) {
   finishRun(run, error?.aborted || run.stopped ? null : error, Boolean(error?.aborted || run.stopped));
  }
 }

 function throwIfStopped(run) {
  if (run.stopped) throw Object.assign(new Error('Aborted'), { aborted: true });
 }

 // -------------------------------------------------- finish
 async function finishRun(run, error, aborted = false) {
  if (run.ended) return;
  run.ended = true;
  runs.delete(run.chatId);
  clearTimeout(run.saveTimer);
  run.saveTimer = 0;
  if (!run.entry?.steps?.length && !String(run.entry?.content || '').trim() && !String(run.entry?.thinking || '').trim()) {
   const at = run.entries.indexOf(run.entry);
   if (at >= 0) run.entries.splice(at, 1);
   run.entry = null;
  } else if (run.entry) {
   run.entry.duration = Math.max(1, Math.round((Date.now() - run.started) / 1000));
  }
  if (error && run.entry) {
   run.entry.error = String(error.message || error).slice(0, 2000);
  }
  if (run.parent) {
   const report = run.entry?.content ? String(run.entry.content) : (error ? `Error: ${error.message}` : '(the sub-agent wrote no report)');
   run.report = report;
  }
  run.dirty = true;
  await flushSave(run);
  unpublish(run);
  if (!run.parent && !run.named) nameChat(run).catch(() => {});
  try {
   const notify = readJson(join(storeDir, 'notify.json'), null);
   if (notify?.discord === true && !run.quiet && !run.parent) {
    const summary = error && !aborted ? `⚠️ ${String(error.message || error)}` : (run.discordSummary || String(run.entry?.content || '').trim().slice(0, 16000));
    const outcome = aborted ? 'failed' : error ? 'error' : 'completed';
    await host.invoke('discord:dm', { title: run.title || t('chat.new'), outcome, summary, files: (run.files || []).map(file => file.path), chatId: run.chatId });
   }
  } catch (dmError) { log(`finish DM failed: ${dmError.message}`); }
  log(`run ${run.id} for ${run.chatId} ended${error ? `: ${error.message}` : aborted ? ' (stopped)' : ' — done'}`);
 }

 // -------------------------------------------------- lifecycle
 function spawn(request) {
  const run = {
   id: String(request.id || `r-${uid()}`),
   chatId: request.chatId,
   folder: request.folder || '',
   mode: request.mode || 'full',
   config: request.config || {},
   model: `${request.config?.provider || ''}${request.config?.provider ? ':' : ''}${request.config?.model || ''}`,
   system: request.system || '',
   tools: Array.isArray(request.tools) && request.tools.length ? request.tools : null,
   title: String(request.title || ''),
   parent: request.parent || '',
   depth: Number(request.depth) || 0,
   started: Date.now(),
   entries: [],
   todos: [],
   parts: [],
   files: [],
   stopped: false,
   quiet: false,
   named: false,
   dirty: false,
   savedAt: 0,
   saveTimer: 0,
   publishTimer: 0,
   publishAt: 0,
   beat: 0,
   tokens: 0,
   toolCount: 0,
   llmId: '',
   toolId: '',
   toolName: '',
   ended: false,
  };
  const promise = (async () => {
   if (Array.isArray(request.seedEntries)) {
    run.entries = request.seedEntries;
   } else {
    const body = readJson(chatFile(run.chatId), null);
    run.entries = Array.isArray(body?.messages) ? body.messages : [];
    run.todos = Array.isArray(body?.todos) ? body.todos.map(item => ({ text: String(item?.text || ''), state: String(item?.state || 'idle') })) : [];
    if (run.todos.length === 0 && Array.isArray(body?.todos) === false) run.todos = [];
    // A save from the page that has not landed yet must not hide the user's message.
    if (request.prompt) {
     const last = [...run.entries].reverse().find(entry => entry.role === 'user');
     const wanted = String(request.prompt || '').trim();
     if (!last || String(last.text || '').trim() !== wanted) {
      run.entries.push({ role: 'user', text: wanted, content: wanted, origin: request.origin || 'web', attachments: [] });
     }
    }
   }
   run.tokens = estimate([{ role: 'system', content: run.system }, ...historyOf(run)]);
   openPart(run);
   publishNow(run);
   await runLoop(run);
   return String(run.report || '');
  })();
  run.done = promise.catch(error => { log(`run ${run.id} failed: ${error?.message || error}`); return ''; });
  return run;
 }

 function start(request) {
  const chatId = String(request?.chatId || '').replace(/[^a-z0-9_-]+/gi, '').slice(0, 60);
  if (!chatId) return { error: 'no chat was given' };
  if (!request?.system || !request?.config?.provider || !request?.config?.model) return { error: 'the run request is incomplete' };
  if (runs.has(chatId)) return { error: 'this conversation is already working' };
  const body = readJson(chatFile(chatId), null);
  if (body?.sealed) return { error: 'this chat is locked' };
  if (!body) return { error: 'this conversation is not in the store yet' };
  const run = spawn({ ...request, chatId });
  runs.set(chatId, run);
  log(`run ${run.id} started for ${chatId} (${run.model}, mode ${run.mode})`);
  return { ok: true, id: run.id };
 }

 function stop(chatId) {
  const run = runs.get(String(chatId || ''));
  if (!run) return { ok: false, error: 'nothing is running for this chat' };
  run.stopped = true;
  // A stop while the wait tool is ticking is a plain "hold on" — and the finish DM stays quiet.
  if (run.toolName === 'wait') run.quiet = true;
  try { if (run.llmId) host.emit('llm:abort', run.llmId); } catch {}
  try { if (run.toolId) host.invoke('tool:cancel', run.toolId); } catch {}
  try { publishNow(run); } catch {}
  log(`run for ${chatId} stopped by the user`);
  return { ok: true };
 }

 function state(chatId) {
  const run = runs.get(String(chatId || ''));
  return run ? snapshot(run) : null;
 }

 function stopAll() {
  for (const chatId of [...runs.keys()]) stop(chatId);
 }

 return {
  start,
  stop,
  state,
  stopAll,
  get running() { return [...runs.keys()]; },
 };
}
