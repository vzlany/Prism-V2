// prism discord — talks to Prism V2 from Discord DMs, so the phone can reach this computer
// from any network, with no port forwarding and no VPN. The bot only ever answers the
// user id in %APPDATA%\Prism V2\discord.json (the same file the finish-notifications use);
// the token lives there too. Tools run without asking, so keep the bot private.
//
//   prism discord                  start listening for DMs
//   prism discord --no-tools       chat only, no tools on this computer
//   prism discord --once "hello"   run one turn in the terminal and print the reply
//
// The bot connects to the Discord gateway, so it shows online with a working status; the
// REST poll below stays as a fallback if the gateway cannot be reached.
import { createEngineHost } from "./engine-host.mjs";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { WebSocket } from "ws";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
 const at = args.indexOf(name);
 return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const rawProfile = String(flag("--profile", "")).toLowerCase();
const PROFILE = /^[a-z0-9-]{1,24}$/.test(rawProfile) ? rawProfile : "";
const ONCE = flag("--once", "");
const NO_TOOLS = args.includes("--no-tools");

const host = createEngineHost({ profile: PROFILE });
const { ROOT, USER_DATA, engines } = host;
// Shared with the finish DM: Discord has no tables, so both convert them before posting.
const { plainTables } = createRequire(import.meta.url)(join(ROOT, "desktop", "discord-format.js"));

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...parts) => console.log(`[${stamp()}]`, ...parts);

// --------------------------------------------------------------- config + state
const configFile = join(USER_DATA, "discord.json");
const stateFile = join(USER_DATA, "discord-chat.json");
const readJson = (file, fallback = {}) => {
 try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
};
const writeJson = (file, value) => {
 try { writeFileSync(file, JSON.stringify(value, null, 2)); } catch (error) { log("could not save", file, String(error.message)); }
};

const config = readJson(configFile);
const state = Object.assign(
 { messages: [], folder: process.env.USERPROFILE || process.env.HOME || ".", model: "opencode-go:deepseek-v4.1-flash", lastId: "0", effort: "", seefull: false, chatId: "" },
 readJson(stateFile),
);
// How the bridge runs is decided here, not by what an earlier run saved.
state.tools = NO_TOOLS ? false : config.tools !== false;
if (flag("--folder")) state.folder = String(flag("--folder"));
if (flag("--model")) state.model = String(flag("--model"));

const savedState = () => writeJson(stateFile, { messages: state.messages, folder: state.folder, model: state.model, lastId: state.lastId, effort: state.effort, thinking: state.thinking, seefull: state.seefull, chatId: state.chatId });

// --------------------------------------------------------------- Prism conversations
// Each Discord conversation is a real Prism chat under a "-Discord" folder: the app and the
// web watch the same store, so everything the bot does can be read and continued there.
const DISCORD_FOLDER = join(process.env.USERPROFILE || process.env.HOME || ".", "Prism V2", "Discord");
const STORE_DIR = join(USER_DATA, "store");
const indexFile = join(STORE_DIR, "index.json");
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const chatFile = id => join(STORE_DIR, "chats", `${id}.json`);
const readIndex = () => {
 const index = readJson(indexFile, { folders: [], chats: [] });
 if (!Array.isArray(index.folders)) index.folders = [];
 if (!Array.isArray(index.chats)) index.chats = [];
 return index;
};
function writeIndex(index) {
 try { mkdirSync(STORE_DIR, { recursive: true }); } catch {}
 writeJson(indexFile, index);
}
function ensureDiscordFolder(index) {
 if (!index.folders.some(folder => String(folder.path || "").toLowerCase() === DISCORD_FOLDER.toLowerCase())) {
  index.folders.push({ path: DISCORD_FOLDER, name: "-Discord", collapsed: false, added: Date.now() });
 }
}
const discordChats = (index = readIndex()) => index.chats
 .filter(chat => String(chat.folder || "").toLowerCase() === DISCORD_FOLDER.toLowerCase())
 .sort((a, b) => (a.created || 0) - (b.created || 0));
function createChat(title) {
 const index = readIndex();
 ensureDiscordFolder(index);
 const now = Date.now();
 const record = { id: uid(), title: String(title || "New chat").slice(0, 60), folder: DISCORD_FOLDER, created: now, updated: now, pinned: false, named: false };
 index.chats.push(record);
 writeIndex(index);
 writeJson(chatFile(record.id), { version: 1, messages: [], tokens: 0 });
 return record;
}
function chatRecord(id) {
 if (!id) return null;
 return readIndex().chats.find(chat => chat.id === id && String(chat.folder || "").toLowerCase() === DISCORD_FOLDER.toLowerCase()) || null;
}
// The renderable messages (what the app draws) and the full model context (tools included)
// live in the same Prism chat file: botContext is the bridge's own history.
// The model context of a chat file. Empty parts (a step that only called tools) are dropped:
// they used to sit in the history as empty assistant messages and some models answered the
// whole turn with nothing. Only the newest stretch is replayed, so a long app chat stays sane.
function contextOf(body) {
 if (Array.isArray(body?.botContext) && body.botContext.length) return body.botContext.slice(-60);
 const out = [];
 for (const entry of body?.messages || []) {
  if (entry.role !== "user" && entry.role !== "assistant") continue;
  const text = typeof entry.content === "string" ? entry.content : entry.text;
  if (typeof text !== "string" || !text.trim()) continue;
  out.push({ role: entry.role, content: text });
 }
 return out.slice(-60);
}

// The agent can talk to the user on its own with a <send_discord_message> block. Inside it,
// a line like `@file: C:\path\shot.png` attaches that file or picture; everything else is text.
const DISCORD_BLOCK = /<send_discord_message>([\s\S]*?)<\/send_discord_message>/gi;
function blockParts(inner) {
 const files = [], kept = [];
 for (const line of String(inner || "").replace(/\r/g, "").split("\n")) {
  const file = line.trim().match(/^@(?:file|image|attach)\s*:\s*(.+)$/i);
  if (file) { files.push(file[1].trim()); continue; }
  if (line.trim()) kept.push(line.trim());
 }
 return { text: kept.join("\n").trim(), files };
}
function parseDiscordBlocks(text) {
 const blocks = [];
 const clean = String(text || "").replace(DISCORD_BLOCK, (match, inner) => {
  const block = blockParts(inner);
  if (block.text || block.files.length) blocks.push(block);
  return "";
 }).replace(/\n{3,}/g, "\n\n").trim();
 return { clean, blocks };
}
function inlineDiscordTags(text) {
 return String(text || "").replace(DISCORD_BLOCK, (match, inner) => blockParts(inner).text).replace(/\n{3,}/g, "\n\n").trim();
}
function loadContext(record) {
 const body = readJson(chatFile(record.id), {});
 state.messages = contextOf(body);
 state.chatId = record.id;
 savedState();
}
function saveConversation(record, userText, answer) {
 const body = readJson(chatFile(record.id), { version: 1 });
 const messages = Array.isArray(body.messages) ? body.messages : [];
 if (userText) messages.push({ role: "user", text: userText, content: userText, origin: "discord" });
 if (answer) messages.push({ role: "assistant", content: answer });
 const index = readIndex();
 const chat = index.chats.find(item => item.id === record.id);
 if (chat) {
  chat.updated = Date.now();
  if (!chat.named && userText) { chat.title = String(userText).split("\n")[0].slice(0, 60) || chat.title; chat.named = true; }
  writeIndex(index);
 }
 writeJson(chatFile(record.id), { ...body, version: 1, messages, botContext: state.messages, tokens: Number(body.tokens) || 0 });
}

// Pick the conversation this message belongs to: the chosen one, or a fresh chat.
function activeChat() {
 let record = chatRecord(state.chatId);
 if (!record) {
  record = createChat(state.pendingTitle || "Discord chat");
  state.pendingTitle = "";
  loadContext(record);
  log("new conversation", record.id);
 }
 return record;
}

// The app keeps provider keys in its own storage and mirrors the equipped ones into the
// shared store (store/keys.json); the bridge reads that first, then its own config, then
// OpenCode's auth file for the Go provider.
function keyOf(provider) {
 const shared = readJson(join(USER_DATA, "store", "keys.json"), null);
 const equipped = shared?.keys?.[provider];
 if (typeof equipped === "string" && equipped.trim()) return equipped.trim();
 if (typeof config.key === "string" && config.key.trim()) return config.key.trim();
 if (provider === "opencode-go") {
  const home = process.env.USERPROFILE || process.env.HOME || ".";
  const auth = readJson(join(home, ".local", "share", "opencode", "auth.json"), null);
  return auth?.["opencode-go"]?.key || Object.values(auth || {}).find(entry => entry?.key)?.key || "";
 }
 return "";
}

// --------------------------------------------------------------- renderer modules on a window shim
const window = {};
globalThis.window = window;
window.openghost = {
 tools: {
  run: (id, name, toolArgs, cwd) => host.invoke("tool:run", id, name, toolArgs, cwd),
  cancel: id => host.invoke("tool:cancel", id),
  environment: () => host.invoke("tool:environment"),
 },
 mcp: { tools: () => host.invoke("mcp:tools"), call: (name, toolArgs) => host.invoke("mcp:call", name, toolArgs) },
 memory: {
  list: () => host.invoke("memory:list"),
  add: text => host.invoke("memory:add", text),
  remove: id => host.invoke("memory:remove", id),
 },
};
for (const file of ["agent-tools.js", "agent-prompt.js"]) {
 try { new Function("window", readFileSync(join(ROOT, "app", file), "utf8"))(window); } catch (error) { log("could not load", file, String(error.message)); }
}
const AgentTools = window.AgentTools;
const AgentPrompt = window.AgentPrompt;

// --------------------------------------------------------------- one model call
let currentRun = "";
function stream(messages, { tools, onDelta, onThought }) {
 return new Promise((resolve, reject) => {
  const id = `dc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  let content = "", reasoning = "";
  // A model that goes quiet for minutes is not "writing" anymore: abort it so the status
  // and the DM do not stay stuck on a dead connection.
  let watchdog = 0;
  const bump = () => {
   clearTimeout(watchdog);
   watchdog = setTimeout(() => {
    try { host.emit("llm:abort", id); } catch {}
    reject(new Error("the model stopped responding"));
   }, 5 * 60 * 1000);
  };
  const sender = {
   send: (channel, data) => {
    if (channel !== "llm:event" || data?.id !== id) return;
    bump();
    if (data.type === "content") { content += data.delta; onDelta?.(data.delta); }
    else if (data.type === "reasoning") { reasoning += data.delta; onThought?.(data.delta); }
    else if (data.type === "done") { clearTimeout(watchdog); resolve({ ...data.result, content: data.result?.content ?? content, reasoning: data.result?.reasoning ?? reasoning }); }
    else if (data.type === "error") { clearTimeout(watchdog); reject(Object.assign(new Error(data.message || "the model stopped"), { status: data.status })); }
   },
   isDestroyed: () => false,
  };
  bump();
  host.setSender(sender);
  currentRun = id;
  const [provider, ...rest] = String(state.model).split(":");
  host.emit("llm:start", id, {
   provider,
   key: keyOf(provider),
   model: rest.join(":") || state.model,
   effort: state.effort || "default",
   vision: true,
   thinking: state.thinking,
   messages,
   tools,
   maxTokens: 8000,
  });
 });
}

async function modelDef() {
 try {
  const [provider] = String(state.model).split(":");
  const reply = await host.invoke("llm:models", provider, keyOf(provider));
  return (reply?.models || []).find(item => item.id === state.model) || null;
 } catch { return null; }
}

// --------------------------------------------------------------- a turn with tools
async function systemPrompt() {
 const def = await modelDef();
 state.thinking = def?.thinking;
 if (!state.effort && def?.defaultEffort) state.effort = def.defaultEffort;
 const env = await AgentTools.environment().catch(() => null);
 await AgentTools.refreshMcp();
 const mcp = AgentTools.mcpSummary();
 let memory = "";
 try {
  const items = (await window.openghost.memory.list()) || [];
  if (items.length) memory = ["# Memory", ...items.map(item => `- ${item.text}`)].join("\n");
 } catch {}
 // The instruction file chosen in the composer (mirrored into the store) and the skills
 // installed on this computer apply here too.
 let instructions = "";
 try {
  const pick = readJson(join(USER_DATA, "store", "instructions.json"), null);
  if (pick?.file && typeof pick.folder === "string") {
   const base = resolve(pick.folder), target = resolve(base, pick.file);
   if (target.startsWith(base)) {
    const text = readFileSync(target, "utf8").slice(0, 12000);
    if (text.trim()) instructions = `# Selected instructions (from ${pick.file})\nThese were chosen by the user in the app and apply to every chat; follow them like the user's words.\n\n${text}`;
   }
  }
 } catch {}
 let skills = "";
 try {
  const found = (await host.invoke("skills:list", state.folder)) || [];
  if (found.length) skills = ["# Skills (Claude skill folders)", "Reusable instructions saved as SKILL.md files on this computer. When a task matches one, read its file with read_file and follow it.", ...found.slice(0, 40).map(item => `- ${item.name}${item.description ? ` — ${item.description}` : ''} (${item.path})`)].join("\n");
 } catch {}
 // The user's own Prompt settings (store/prompts.json) apply here too.
 const prompts = readJson(join(USER_DATA, "store", "prompts.json"), null);
 let custom = "";
 if (prompts && prompts.enabled !== false && typeof prompts.global === "string" && prompts.global.trim()) custom += `\n\n# User instructions (global)\n${prompts.global.trim()}`;
 const own = prompts?.models?.[state.model];
 if (typeof own === "string" && own.trim()) custom += `\n\n# User instructions (this model)\n${own.trim()}`;
 return `${AgentPrompt.build({ folder: state.folder, mode: "full", env, browser: "", mcp, memory, plan: "", instructions, skills, now: new Date() })}${custom}\n\n# Remote control\nYou are answering over Discord, from the user's phone. Keep replies short and plain; Discord markdown works, but **never write markdown tables** — Discord does not render them and they arrive as a wall of pipes. Use short lists with bold labels instead, one line per item (for example \`- **Title:** what changed\`).\n\nWhile you work you can also message the user here on your own: write a block like \`<send_discord_message>Sure, let me decompile that client and check it for malware.</send_discord_message>\` and it is posted as its own DM as soon as that step ends (before the tools of the step run). A line inside the block like \`@file: C:\\\\path\\\\shot.png\` attaches that file or picture. Use it only when you actually want to say something before the final summary, which is sent automatically — never wrap your whole answer in it and never use it to repeat something you are about to say.${state.tools ? " Tools run without asking." : " Tools are unavailable in this session: never attempt a tool call, answer in plain text."}`;
}

async function turn(prompt, display = {}) {
 state.messages.push({ role: "user", content: prompt });
 const tools = state.tools ? AgentTools.schemas : undefined;
 const system = await systemPrompt();
 let lastStatus = "";
 const status = line => {
  if (line === lastStatus) return;
  lastStatus = line;
  display.status?.(line);
 };
 // A hard question can take many calls: 12 used to cut real work off mid-task. The loop still
 // ends on its own when the model answers without asking for another tool.
 const MAX_STEPS = 50;
 // DeepSeek's thinking mode insists its reasoning comes back with every assistant message
 // that made tool calls; without it the next step fails with invalid_request_error.
 const keepReasoning = /deepseek/i.test(String(state.model || ""));
 let retried = false;
 for (let step = 0; step < MAX_STEPS; step++) {
  if (state.stopped) return "⏹ stopped";
  let reasoning = "", result = null;
  // A failure gets three more tries, five seconds apart, with the attempt shown in the DM.
  for (let attempt = 1; ; attempt++) {
   try {
    result = await stream([{ role: "system", content: system }, ...state.messages], {
     tools,
     onDelta: () => status("✍️ writing…"),
     onThought: delta => { reasoning += delta; status("🤔 thinking…"); },
    });
    break;
   } catch (error) {
    if (state.stopped || error?.name === "AbortError" || attempt > 3) throw error;
    status(`⏳ retrying (${attempt}/3)…`);
    log(`model error, trying again ${attempt}/3:`, String(error?.message || error).slice(0, 160));
    await new Promise(resolve => setTimeout(resolve, 5000));
    if (state.stopped) throw error;
    reasoning = "";
   }
  }
  // The thinking is finished when the step's stream ends, so the whole thought goes out at
  // once — never a half sentence in the middle of it.
  const thought = String(result.reasoning || reasoning || "").trim();
  if (thought) await display.thought?.(thought);
  const calls = (result.toolCalls || []).filter(call => call?.function?.name);
  // A <send_discord_message> block is the agent talking to the user on its own. While work
  // continues it goes out right away and leaves the reply; on the final step a plain one
  // stays as the normal answer, so nothing is ever said twice.
  let content = result.content || "";
  let posted = false;
  if (content.includes("<send_discord_message>")) {
   const parsed = parseDiscordBlocks(content);
   if (parsed.blocks.length) {
    if (calls.length || parsed.blocks.some(block => block.files.length)) {
     for (const block of parsed.blocks) await display.message?.(block.text, block.files);
     content = parsed.clean;
     posted = true;
    } else {
     content = inlineDiscordTags(content);
    }
   }
  }
  if (!calls.length) {
   const answer = content.trim();
   // One silent retry when a model returns nothing at all: a hiccup, not a real answer.
   if (!answer && !posted && !retried) { retried = true; continue; }
   const assistant = { role: "assistant", content };
   if (keepReasoning && thought) assistant.reasoning_content = thought;
   state.messages.push(assistant);
   savedState();
   if (!answer) return posted ? "" : "(the model sent an empty reply)";
   return answer;
  }
  const assistant = { role: "assistant", content, tool_calls: calls };
  if (keepReasoning && thought) assistant.reasoning_content = thought;
  state.messages.push(assistant);
  const pictures = [];
  for (const call of calls) {
   if (state.stopped) return "⏹ stopped";
   let callArgs = {};
   try { callArgs = JSON.parse(call.function.arguments || "{}"); } catch {}
   status(`🔧 ${call.function.name}`);
   const item = { name: call.function.name, args: callArgs };
   const messageId = await display.running?.(item);
   let output = "", failed = false;
   try {
    const toolResult = await AgentTools.run(call.function.name, callArgs, { id: `dc-tool-${call.id}`, cwd: state.folder });
    // Tools can answer with text, or with text plus pictures (a screenshot, an image file).
    output = typeof toolResult === "string" ? toolResult : String(toolResult?.text ?? JSON.stringify(toolResult ?? ""));
    if (toolResult?.images?.length) pictures.push(...toolResult.images);
    // A finished file the agent attached (attach_file) is uploaded to the DM as it is made.
    if (toolResult?.files?.length) await display.files?.(toolResult.files);
   } catch (error) {
    output = `Error: ${error.message}`;
    failed = true;
   }
   state.messages.push({ role: "tool", tool_call_id: call.id, content: output });
   await display.event?.({ ...item, output, error: failed, messageId });
  }
  if (pictures.length) {
   const content = [{ type: "text", text: "The pictures from the tools you just ran follow." }];
   for (const picture of pictures) content.push({ type: "text", text: picture.label }, { type: "image_url", image_url: { url: picture.url } });
   state.messages.push({ role: "user", content });
  }
 }
 return `(stopped after ${MAX_STEPS} tool steps)`;
}

// --------------------------------------------------------------- full display formatting
// [running, done] — the same message starts in the present tense and is edited to the past
// tense when the tool finishes.
const TOOL_TITLES = {
 run_powershell: ["Running a command", "Ran a command"],
 git: ["Running git", "Ran git in the project"],
 write_file: ["Writing a file", "Wrote a file"],
 edit_file: ["Editing a file", "Edited a file"],
 patch: ["Patching a file", "Patched a file"],
 read_file: ["Reading a file", "Read a file"],
 list_files: ["Listing a folder", "Listed a folder"],
 web_search: ["Searching the web", "Searched the web"],
 fetch_url: ["Opening a link", "Opened a link"],
 http_request: ["Sending an HTTP request", "Sent an HTTP request"],
 screenshot: ["Taking a screenshot", "Took a screenshot"],
 clipboard: ["Using the clipboard", "Used the clipboard"],
 open_path: ["Opening a path", "Opened a path"],
 notify: ["Sending a notification", "Sent a notification"],
 wait: ["Waiting", "Waited"],
 attach_file: ["Attaching a file", "Attached a file"],
 video_frames: ["Looking at a video", "Looked at a video"],
 subagent: ["Starting a subagent", "Started a subagent"],
 ask_user: ["Asking the user", "Asked the user"],
 memory_save: ["Saving a memory", "Saved a memory"],
 memory_forget: ["Forgetting a memory", "Forgot a memory"],
};

function toolTitle(name, running) {
 const pair = TOOL_TITLES[name];
 if (pair) return running ? pair[0] : pair[1];
 if (String(name).startsWith("browser_")) return running ? "Using the browser" : "Used the browser";
 const plain = String(name || "tool").replace(/[_-]+/g, " ");
 return running ? `Running ${plain}` : `Ran ${plain}`;
}

function toolDetail(name, toolArgs = {}) {
 const first = (...keys) => keys.map(key => toolArgs?.[key]).find(value => typeof value === "string" && value.trim());
 if (name === "run_powershell") return first("command", "code");
 if (name === "git") return `git ${first("args", "command") || ""}`.trim();
 if (name === "http_request") return `${toolArgs?.method || "GET"} ${first("url") || ""}`.trim();
 if (name === "write_file" || name === "edit_file" || name === "patch" || name === "read_file" || name === "list_files" || name === "attach_file") return first("path", "file", "directory");
 if (name === "subagent") return first("label", "prompt");
 if (name === "notify") return first("title", "text");
 return first("query", "url", "path", "file", "directory", "command", "label", "text", "id") || "";
}

// One action on its own line, in a box: the command, the file, the search. The same message
// is edited from "Running…" to "Ran…" when the tool is done.
function toolBox({ name, args: toolArgs, output, error, running }) {
 const detail = String(toolDetail(name, toolArgs) || "").trim();
 const title = toolTitle(name, running);
 let line = `📦 **${title}:**`;
 if (detail) {
  const one = detail.replace(/\s+/g, " ").trim();
  if (one.length <= 220 && !one.includes("`")) line += ` \`${one}\``;
  else line += `\n\`\`\`\n${detail.slice(0, 1200).replace(/```/g, "'''")}\n\`\`\``;
 }
 if (error) line += `\n⚠️ ${String(output || "").replace(/\s+/g, " ").slice(0, 300)}`;
 return line.slice(0, 1990);
}

// A thought in Discord's small grey text; one -# per line keeps the whole block small.
function subtext(text) {
 const lines = String(text).replace(/\r/g, "").split("\n").map(line => line.trim()).filter(Boolean).slice(0, 30);
 return lines.map(line => `-# ${line.slice(0, 220)}`).join("\n").slice(0, 1990);
}

// --------------------------------------------------------------- Discord
const DISCORD = "https://discord.com/api/v10";
const api = (path, options = {}) => fetch(DISCORD + path, {
 ...options,
 headers: { authorization: `Bot ${config.token || ""}`, "content-type": "application/json", ...(options.headers || {}) },
});
const chunk = text => {
 const out = [];
 let rest = plainTables(String(text));
 while (rest.length > 1900) {
  let at = rest.lastIndexOf("\n", 1900);
  if (at < 400) at = 1900;
  out.push(rest.slice(0, at));
  rest = rest.slice(at).replace(/^\n+/, "");
 }
 if (rest) out.push(rest);
 return out.length ? out : ["(empty)"];
};

async function dmChannel() {
 const res = await api("/users/@me/channels", { method: "POST", body: JSON.stringify({ recipient_id: String(config.userId) }) });
 if (!res.ok) throw new Error(`could not open a DM (${res.status}) — check the bot token and user id`);
 return (await res.json()).id;
}

async function post(channel, text) {
 const parts = chunk(text);
 for (const part of parts) await api(`/channels/${channel}/messages`, { method: "POST", body: JSON.stringify({ content: part }) }).catch(() => {});
}

async function replyTo(channel, messageId, text) {
 const parts = chunk(text);
 await api(`/channels/${channel}/messages/${messageId}`, { method: "PATCH", body: JSON.stringify({ content: parts[0] }) });
 for (const part of parts.slice(1)) await api(`/channels/${channel}/messages`, { method: "POST", body: JSON.stringify({ content: part }) });
}

// Attachments: a file the agent produced (attach_file) is uploaded as a real Discord file.
// Anything missing or over the safe size is skipped, so the reply never fails over an upload.
const MAX_FILE = 9 * 1024 * 1024;
const absolutePath = value => /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(String(value || ""));
async function postFiles(channel, files, caption = "") {
 const list = (Array.isArray(files) ? files : [])
  .map(file => (typeof file === "string" ? { path: file } : file))
  .filter(file => file?.path)
  .slice(0, 10);
 let sent = 0;
 for (const file of list) {
  try {
   // A block can name a file relative to the folder the tools work in.
   const target = absolutePath(file.path) ? String(file.path) : join(state.folder || ".", String(file.path));
   const stat = statSync(target);
   if (!stat.isFile() || stat.size > MAX_FILE) continue;
   const form = new FormData();
   // The first file's message carries the caption, so words and picture arrive together.
   form.append("payload_json", JSON.stringify(!sent && caption ? { content: String(caption).slice(0, 1900) } : {}));
   form.append("files[0]", new Blob([readFileSync(target)]), basename(target));
   const res = await fetch(`${DISCORD}/channels/${channel}/messages`, {
    method: "POST",
    headers: { authorization: `Bot ${config.token || ""}` },
    body: form,
   }).catch(() => null);
   if (res?.ok) sent++;
  } catch {}
 }
 return sent;
}

// --------------------------------------------------------------- gateway (online status + DMs)
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15); // GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
const IDLE = "💤 ready";
let gateway = null, heartbeat = 0, seq = null, gatewayReady = false, shuttingDown = false, presenceLoop = 0;

// A custom status (type 4) shows the text itself, so the profile says what Prism is doing.
// While a reply is being produced the status is dnd, otherwise online.
let lastPresence = "";
function setPresence(name, status = "online") {
 if (!gatewayReady || !gateway || gateway.readyState !== WebSocket.OPEN) return;
 lastPresence = `${status}|${name}`;
 try {
  gateway.send(JSON.stringify({ op: 3, d: { since: 0, status, afk: false, activities: [{ name: "Prism V2", type: 4, state: String(name).slice(0, 128) }] } }));
 } catch {}
}

// The app keeps its running turns in presence.json: while anything works there (or a web
// turn delegated to it) the bot wears DND too; when nothing is working it goes back to ready.
function appBusy() {
 const runs = readJson(join(USER_DATA, "presence.json"), {})?.runs;
 return Array.isArray(runs) && runs.some(run => Date.now() - (Number(run.at) || 0) < 30000);
}

// The status is put back in line every few seconds unless a turn is really running, so a
// missed reset (a dropped gateway, a killed turn) can never leave "writing…" behind.
function startPresenceLoop() {
 clearInterval(presenceLoop);
 presenceLoop = setInterval(() => {
  if (!gatewayReady) return;
  // A bridge turn (this bot replying here) sets its own status while it works.
  if (busy || currentRun) return;
  const working = appBusy();
  const line = working ? "🤔 working in the app…" : IDLE;
  const status = working ? "dnd" : "online";
  if (`${status}|${line}` === lastPresence) return;
  setPresence(line, status);
 }, 5000);
}

function connectGateway() {
 if (shuttingDown || !config.token) return;
 gateway = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
 gateway.on("open", () => log("gateway connected"));
 gateway.on("message", raw => {
  let msg;
  try { msg = JSON.parse(String(raw)); } catch { return; }
  if (typeof msg.s === "number") seq = msg.s;
  if (msg.op === 10) {
   clearInterval(heartbeat);
   heartbeat = setInterval(() => { try { gateway.send(JSON.stringify({ op: 1, d: seq })); } catch {} }, msg.d.heartbeat_interval);
   gateway.send(JSON.stringify({
    op: 2,
    d: {
     token: config.token,
     intents: INTENTS,
     properties: { os: process.platform, browser: "Prism V2", device: "Prism V2" },
     presence: { since: 0, status: "online", afk: false, activities: [{ name: "Prism V2", type: 4, state: IDLE }] },
    },
   }));
  } else if (msg.op === 0) {
   if (msg.t === "READY") {
    gatewayReady = true;
    log(`online as ${msg.d?.user?.username || "the bot"}`);
    setPresence(IDLE, "online");
    startPresenceLoop();
   } else if (msg.t === "MESSAGE_CREATE") {
    const data = msg.d || {};
    if (data.author?.bot) return;
    if (String(data.author?.id) !== String(config.userId)) return;
    if (data.guild_id) return; // DMs only
    if (typeof data.id === "string" && data.id > state.lastId) state.lastId = data.id;
    enqueue({ channel: data.channel_id, message: data });
   }
  } else if (msg.op === 7 || msg.op === 9) {
   try { gateway.close(); } catch {}
  }
 });
 gateway.on("close", () => {
  gatewayReady = false;
  clearInterval(heartbeat);
  heartbeat = 0;
  if (!shuttingDown) setTimeout(connectGateway, 3000);
 });
 gateway.on("error", error => log("gateway error:", String(error?.message || error)));
}

// One turn at a time, whatever arrives from the gateway or the poll.
const queue = [];
let busy = false;
function enqueue(item) {
 queue.push(item);
 if (!busy) pumpQueue();
}
async function pumpQueue() {
 if (busy) return;
 busy = true;
 while (queue.length) {
  const item = queue.shift();
  try { await handle(item.channel, item.message); } catch (error) { log("handle failed:", String(error?.message || error)); }
 }
 busy = false;
}

// --------------------------------------------------------------- commands
const HELP = [
 "**Prism V2 bridge** — I run on your PC and answer here.",
 "",
 "`!new` — start a fresh conversation",
 "`!chat` — list conversations (`!chat 2` switches, `!chat new [title]` starts one)",
 "`!clear` — delete every message I sent in this DM",
 "`!stop` — stop the reply being written",
 "`!seefull` — toggle Full Display: every thought and every action is posted here",
 "`!effort <level>` — thinking effort (default, none, low, medium, high, xhigh, max)",
 "`!folder <path>` — the folder tools work in",
 "`!model <provider:id>` — switch model (e.g. `opencode-go:deepseek-v4.1-flash`)",
 "`!status` — what I am set to",
 "`!help` — this",
 "",
 "Conversations live in the app and on the web under **-Discord**. A `/` prefix works too.",
].join("\n");

// Delete the bot's own messages in this DM (Discord lets a bot remove what it sent).
async function clearBotMessages(channel) {
 let deleted = 0, before = null;
 for (let page = 0; page < 6; page++) {
  const query = `/channels/${channel}/messages?limit=100${before ? `&before=${before}` : ""}`;
  const res = await api(query);
  if (!res.ok) break;
  const list = await res.json();
  if (!Array.isArray(list) || !list.length) break;
  before = list[list.length - 1].id;
  for (const item of list) {
   if (!item.author?.bot) continue;
   const del = await api(`/channels/${channel}/messages/${item.id}`, { method: "DELETE" });
   if (del.ok || del.status === 404) deleted++;
  }
  if (list.length < 100) break;
 }
 return deleted;
}

async function handle(channel, message) {
 let text = String(message.content || "").trim();
 // If the gateway cannot see message content (Message Content Intent off in the developer
 // portal), fetch the message over REST before giving up on it.
 if (!text && gatewayReady && message.id) {
  try {
   const fresh = await api(`/channels/${channel}/messages/${message.id}`).then(res => (res.ok ? res.json() : null));
   text = String(fresh?.content || "").trim();
  } catch {}
 }
 if (!text) return;
 log("dm:", text.slice(0, 80));
 // Commands use "!" (a leading "/" is accepted too, so older muscle memory still works).
 const command = text.replace(/^\//, "!");
 if (command === "!help") return void await post(channel, HELP);
 if (command === "!new") {
  const record = createChat();
  loadContext(record);
  return void await post(channel, `✨ new conversation **${record.title}**\n-# \`${record.id}\` — it shows up in the app and web under "-Discord".`);
 }
 if (command === "!clear") {
  const notice = await api(`/channels/${channel}/messages`, { method: "POST", body: JSON.stringify({ content: "🧹 clearing my messages…" }) }).then(res => (res.ok ? res.json() : null)).catch(() => null);
  const deleted = await clearBotMessages(channel);
  if (notice?.id) {
   await api(`/channels/${channel}/messages/${notice.id}`, { method: "PATCH", body: JSON.stringify({ content: `🧹 cleared ${deleted} of my messages` }) }).catch(() => {});
   setTimeout(() => { api(`/channels/${channel}/messages/${notice.id}`, { method: "DELETE" }).catch(() => {}); }, 4000);
  }
  return;
 }
 if (command === "!stop") {
  state.stopped = true;
  if (currentRun) host.emit("llm:abort", currentRun);
  return void await post(channel, "⏹ stopping…");
 }
 if (command === "!seefull" || command === "!seefull on" || command === "!seefull off") {
  const on = command === "!seefull off" ? false : command === "!seefull on" ? true : !state.seefull;
  state.seefull = on;
  savedState();
  return void await post(channel, on
   ? "✅ Using Full Display — every finished thought and every action will be posted here while I work."
   : "💤 Full Display off.");
 }
 if (command === "!status") {
  const active = chatRecord(state.chatId);
  const lines = [`model: \`${state.model}\``, `effort: \`${state.effort || "default"}\``, `folder: \`${state.folder}\``, `tools: ${state.tools ? "on" : "off"}`, `full display: ${state.seefull ? "on" : "off"}`, `conversation: **${active?.title || "—"}** \`${active?.id || "none"}\``, `messages in context: ${state.messages.length}`];
  return void await post(channel, lines.join("\n"));
 }
 // !chat — list conversations; !chat 2 — switch by number; !chat <id> — switch by id;
 // !chat new — start one. A message with no chosen conversation starts a fresh one.
 if (command === "!chat" || command.startsWith("!chat ")) {
  const arg = command.slice(5).trim();
  if (!arg) {
   const chats = discordChats();
   if (!chats.length) return void await post(channel, "no conversations yet — just write a message and I start one.");
   const lines = chats.map((chat, index) => `${chat.id === state.chatId ? "**▶**" : `${index + 1}.`} **${chat.title}** — \`${chat.id}\``);
   return void await post(channel, [`**Discord conversations** (${chats.length})`, ...lines.slice(0, 25), "", "`!chat <number|id>` switches, `!chat new [title]` starts one."].join("\n"));
  }
  if (arg === "new" || arg.startsWith("new ")) {
   const title = arg.slice(3).trim();
   const record = createChat(title);
   loadContext(record);
   return void await post(channel, `💬 new conversation **${record.title}**\n-# \`${record.id}\``);
  }
  const record = chatRecord(arg) || discordChats()[Number(arg) - 1] || null;
  if (!record) return void await post(channel, `no conversation \`${arg}\` — \`!chat\` lists them.`);
  loadContext(record);
  return void await post(channel, `💬 now working on **${record.title}**\n-# \`${record.id}\``);
 }
 if (command === "!effort" || command.startsWith("!effort ")) {
  const def = await modelDef();
  const levels = def?.efforts || [];
  const value = command.slice(7).trim().toLowerCase();
  if (!value) {
   const available = levels.length ? ` — available: ${levels.map(level => `\`${level}\``).join(", ")}` : "";
   return void await post(channel, `⚙️ effort: \`${state.effort || "default"}\`${available}`);
  }
  if (levels.length && !levels.includes(value) && value !== "default") {
   return void await post(channel, `unknown effort \`${value}\` — available: ${levels.map(level => `\`${level}\``).join(", ")}`);
  }
  state.effort = value === "default" ? "" : value;
  savedState();
  return void await post(channel, `⚙️ effort: \`${value}\``);
 }
 if (command.startsWith("!folder ")) {
  const folder = command.slice(8).trim();
  if (!existsSync(folder)) return void await post(channel, `no such folder: \`${folder}\``);
  state.folder = folder;
  savedState();
  return void await post(channel, `📁 tools now work in \`${folder}\``);
 }
 if (command.startsWith("!model ")) {
  state.model = command.slice(7).trim();
  state.effort = "";
  savedState();
  return void await post(channel, `🧠 model: \`${state.model}\``);
 }

 // A reply to a finish DM continues the exact app conversation that notification came from.
 const target = replyTarget(message?.message_reference?.message_id || message?.referenced_message?.id);
 if (target) return void await replyInChat(channel, text, target);

 // The conversation this turn belongs to (a fresh one is made if none is chosen).
 const conversation = activeChat();
 await runTurn(channel, text, conversation, saveConversation);
}

// One turn's Discord face: a "working…" placeholder that follows the status, thoughts and
// actions (Full Display), then the answer edited into it. `save` decides where the turn is
// written: the active Discord conversation, or an app chat a notification reply pointed at.
async function runTurn(channel, text, conversation, save) {
 state.stopped = false;
 const placeholder = await api(`/channels/${channel}/messages`, { method: "POST", body: JSON.stringify({ content: "⏳ working…" }) });
 const placeholderId = (await placeholder.json().catch(() => ({})))?.id;
 let shown = "", shownAt = 0;
 const updatePlaceholder = line => {
  const now = Date.now();
  if (line === shown || now - shownAt < 1200 || !placeholderId) return;
  shown = line;
  shownAt = now;
  api(`/channels/${channel}/messages/${placeholderId}`, { method: "PATCH", body: JSON.stringify({ content: line }) }).catch(() => {});
 };
 const display = {
  // The gateway status changes with the work: DND while a reply is being produced, the
  // exact phrase the user sees, and back to online + "💤 ready" when the turn ends.
  status: line => {
   setPresence(line, "dnd");
   updatePlaceholder(line);
  },
  // Full Display: the finished thought in small grey text, each action as its own box.
  thought: async words => { if (state.seefull) await post(channel, subtext(words)); },
  // The action's message is posted while the tool runs ("Running…") and edited to the past
  // tense when it finishes ("Ran…").
  running: async item => {
   if (!state.seefull) return null;
   try {
    const res = await api(`/channels/${channel}/messages`, { method: "POST", body: JSON.stringify({ content: toolBox({ ...item, running: true }) }) });
    return (await res.json().catch(() => ({})))?.id || null;
   } catch { return null; }
  },
  event: async item => {
   if (!state.seefull) return;
   const content = toolBox(item);
   if (item.messageId) await api(`/channels/${channel}/messages/${item.messageId}`, { method: "PATCH", body: JSON.stringify({ content }) }).catch(() => {});
   else await post(channel, content);
  },
  // Files made during the turn arrive here right after the tool that made them.
  files: async list => { await postFiles(channel, list).catch(() => {}); },
  // The agent talking to the user on its own: its own DM with any files, not the summary.
  message: async (text, files) => {
   const list = Array.isArray(files) ? files : [];
   const sent = list.length ? await postFiles(channel, list, text) : 0;
   if (String(text || "").trim() && !sent) await post(channel, text);
  },
 };
 setPresence("🤔 thinking…", "dnd");
 try {
  const answer = await turn(text, display);
  setPresence(IDLE);
  if (!answer.trim()) {
   // Everything was said through the turn's own Discord messages: nothing to edit into.
   save(conversation, text, "");
   if (placeholderId) await api(`/channels/${channel}/messages/${placeholderId}`, { method: "DELETE" }).catch(() => {});
   log("answered with self-sent messages only");
   return;
  }
  save(conversation, text, answer);
  if (placeholderId) await replyTo(channel, placeholderId, answer);
  else await post(channel, answer);
  log("replied:", answer.replace(/\s+/g, " ").slice(0, 100));
 } catch (error) {
  setPresence(IDLE);
  save(conversation, text, "");
  const note = `⚠️ ${error.message}`;
  if (placeholderId) await replyTo(channel, placeholderId, note);
  else await post(channel, note);
  log("failed:", error.message);
 }
}

// Finish notifications record the app chat behind every message they post; a reply to one of
// them continues that conversation instead of the active Discord one.
const replyMapFile = join(USER_DATA, "discord-map.json");
function replyTarget(messageId) {
 if (!messageId) return "";
 try {
  const map = JSON.parse(readFileSync(replyMapFile, "utf8"))?.messages || {};
  return String(map[String(messageId)]?.chat || "");
 } catch {
  return "";
 }
}

// If the app is running a turn in that chat, the bridge must not start a second one.
function busyInApp(chatId) {
 const runs = readJson(join(USER_DATA, "presence.json"), {})?.runs;
 return Array.isArray(runs) && runs.some(run => run?.id === chatId && Date.now() - (Number(run.at) || 0) < 30000);
}

// The user replied to a finish DM: write the message into the app conversation (tagged as
// coming from Discord, so the app and the web show it) and run the turn with that chat's
// context. The answer comes back here, and the Discord conversation keeps its own state.
async function replyInChat(channel, text, chatId) {
 const record = readIndex().chats.find(chat => chat.id === chatId) || null;
 if (!record) return void await post(channel, "That conversation is gone — start a new one with `!new`.");
 if (busyInApp(chatId)) return void await post(channel, "Still working on that one — I'll answer here when it's done.");
 const saved = { messages: state.messages, chatId: state.chatId, folder: state.folder };
 state.messages = contextOf(readJson(chatFile(record.id), {}));
 state.chatId = record.id;
 state.folder = record.folder || saved.folder;
 try {
  await runTurn(channel, text, record, appendToChat);
 } finally {
  state.messages = saved.messages;
  state.chatId = saved.chatId;
  state.folder = saved.folder;
  // turn() saves the state it ran with; put the Discord conversation back on disk.
  savedState();
 }
}

// The reply turn, written the way the app writes a chat: renderable messages with the
// Discord origin on the user's line. No botContext here — the app's own history is the truth.
function appendToChat(record, userText, answer) {
 const body = readJson(chatFile(record.id), { version: 1 });
 const messages = Array.isArray(body.messages) ? body.messages : [];
 if (userText) messages.push({ role: "user", text: userText, content: userText, origin: "discord" });
 if (answer) messages.push({ role: "assistant", content: answer });
 const index = readIndex();
 const chat = index.chats.find(item => item.id === record.id);
 if (chat) {
  chat.updated = Date.now();
  writeIndex(index);
 }
 const { botContext, ...rest } = body;
 writeJson(chatFile(record.id), { ...rest, version: 1, messages, tokens: Number(body.tokens) || 0 });
}

// --------------------------------------------------------------- run
if (ONCE) {
 (async () => {
  log(`one turn — model ${state.model}, folder ${state.folder}, tools ${state.tools ? "on" : "off"}`);
  try {
   const answer = await turn(String(ONCE), { status: line => log(line) });
   console.log("\n" + answer + "\n");
   process.exit(0);
  } catch (error) {
   console.error("\nfailed:", error.message, "\n");
   process.exit(1);
  }
 })();
} else if (!config.token || !config.userId) {
 console.error(`\n  The Discord bot is not set up yet. Add a bot token and your user id in Prism V2:\n  Settings -> Interface -> Discord notifications (the same bot is used here),\n  or edit ${configFile} by hand:\n\n  { "token": "…", "userId": "…", "enabled": true }\n\n  Create the bot at https://discord.com/developers (New Application -> Bot), enable\n  "Message Content Intent" on the Bot page, invite it to a private server of yours\n  (OAuth2 -> URL Generator -> scope "bot") so Discord lets it DM you, then DM it.\n`);
 process.exit(1);
} else {
 (async () => {
  let channel = null;
  const ensureChannel = async () => {
   if (channel) return channel;
   try { channel = await dmChannel(); } catch (error) { log(String(error.message)); return null; }
   const recent = await api(`/channels/${channel}/messages?limit=1`).then(res => (res.ok ? res.json() : [])).catch(() => []);
   if (recent[0]?.id && state.lastId === "0") state.lastId = recent[0].id;
   return channel;
  };
  await ensureChannel();
  console.log(`\n  Prism V2 on Discord  ->  model ${state.model}`);
  console.log(`  folder            ->  ${state.folder}`);
  console.log(`  tools             ->  ${state.tools ? "on (full access to this computer)" : "off"}`);
  console.log("  DM the bot from any network; this terminal logs what it does. Ctrl+C stops it.\n");
  connectGateway();

  // The REST poll stays as a fallback: with the gateway connected, events arrive there.
  let running = false;
  setInterval(async () => {
   if (running || gatewayReady) return;
   running = true;
   try {
    const dm = await ensureChannel();
    if (!dm) return;
    const res = await api(`/channels/${dm}/messages?limit=10`);
    if (res.ok) {
     const list = await res.json();
     const fresh = list.filter(item => item.author?.id === String(config.userId) && item.id > state.lastId).reverse();
     for (const item of fresh) {
      state.lastId = item.id;
      enqueue({ channel: dm, message: item });
     }
    } else if (res.status === 401) {
     log("the bot token was rejected (401) — check it in Settings -> Discord");
    }
   } catch (error) {
    log("poll failed:", error.message);
   } finally {
    running = false;
   }
  }, 3000);

  const shutdown = () => {
   shuttingDown = true;
   clearInterval(heartbeat);
   try { gateway?.close(); } catch {}
   process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
 })();
}
