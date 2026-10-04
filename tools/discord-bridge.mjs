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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
 { messages: [], folder: process.env.USERPROFILE || process.env.HOME || ".", model: "opencode-go:deepseek-v4.1-flash", lastId: "0", effort: "", seefull: false },
 readJson(stateFile),
);
// How the bridge runs is decided here, not by what an earlier run saved.
state.tools = NO_TOOLS ? false : config.tools !== false;
if (flag("--folder")) state.folder = String(flag("--folder"));
if (flag("--model")) state.model = String(flag("--model"));

const savedState = () => writeJson(stateFile, { messages: state.messages, folder: state.folder, model: state.model, lastId: state.lastId, effort: state.effort, thinking: state.thinking, seefull: state.seefull });

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
  const sender = {
   send: (channel, data) => {
    if (channel !== "llm:event" || data?.id !== id) return;
    if (data.type === "content") { content += data.delta; onDelta?.(data.delta); }
    else if (data.type === "reasoning") { reasoning += data.delta; onThought?.(data.delta); }
    else if (data.type === "done") resolve({ ...data.result, content: data.result?.content ?? content, reasoning: data.result?.reasoning ?? reasoning });
    else if (data.type === "error") reject(Object.assign(new Error(data.message || "the model stopped"), { status: data.status }));
   },
   isDestroyed: () => false,
  };
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
 // The user's own Prompt settings (store/prompts.json) apply here too.
 const prompts = readJson(join(USER_DATA, "store", "prompts.json"), null);
 let custom = "";
 if (prompts && prompts.enabled !== false && typeof prompts.global === "string" && prompts.global.trim()) custom += `\n\n# User instructions (global)\n${prompts.global.trim()}`;
 const own = prompts?.models?.[state.model];
 if (typeof own === "string" && own.trim()) custom += `\n\n# User instructions (this model)\n${own.trim()}`;
 return `${AgentPrompt.build({ folder: state.folder, mode: "full", env, browser: "", mcp, memory, plan: "", instructions: "", skills: "", now: new Date() })}${custom}\n\n# Remote control\nYou are answering over Discord, from the user's phone. Keep replies short and plain; Discord markdown works.${state.tools ? " Tools run without asking." : " Tools are unavailable in this session: never attempt a tool call, answer in plain text."}`;
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
 for (let step = 0; step < 12; step++) {
  if (state.stopped) return "⏹ stopped";
  let reasoning = "";
  const result = await stream([{ role: "system", content: system }, ...state.messages], {
   tools,
   onDelta: () => status("✍️ writing…"),
   onThought: delta => { reasoning += delta; status("🤔 thinking…"); },
  });
  // The thinking is finished when the step's stream ends, so the whole thought goes out at
  // once — never a half sentence in the middle of it.
  const thought = String(result.reasoning || reasoning || "").trim();
  if (thought) await display.thought?.(thought);
  const calls = (result.toolCalls || []).filter(call => call?.function?.name);
  if (!calls.length) {
   state.messages.push({ role: "assistant", content: result.content || "" });
   savedState();
   return result.content?.trim() || "(the model sent an empty reply)";
  }
  state.messages.push({ role: "assistant", content: result.content || "", tool_calls: calls });
  const pictures = [];
  for (const call of calls) {
   if (state.stopped) return "⏹ stopped";
   let callArgs = {};
   try { callArgs = JSON.parse(call.function.arguments || "{}"); } catch {}
   status(`🔧 ${call.function.name}`);
   let output = "", failed = false;
   try {
    const toolResult = await AgentTools.run(call.function.name, callArgs, { id: `dc-tool-${call.id}`, cwd: state.folder });
    // Tools can answer with text, or with text plus pictures (a screenshot, an image file).
    output = typeof toolResult === "string" ? toolResult : String(toolResult?.text ?? JSON.stringify(toolResult ?? ""));
    if (toolResult?.images?.length) pictures.push(...toolResult.images);
   } catch (error) {
    output = `Error: ${error.message}`;
    failed = true;
   }
   state.messages.push({ role: "tool", tool_call_id: call.id, content: output });
   await display.event?.({ name: call.function.name, args: callArgs, output, error: failed });
  }
  if (pictures.length) {
   const content = [{ type: "text", text: "The pictures from the tools you just ran follow." }];
   for (const picture of pictures) content.push({ type: "text", text: picture.label }, { type: "image_url", image_url: { url: picture.url } });
   state.messages.push({ role: "user", content });
  }
 }
 return "(stopped after 12 tool steps)";
}

// --------------------------------------------------------------- full display formatting
const TOOL_TITLES = {
 run_powershell: "Ran a command",
 git: "Ran git in the project",
 write_file: "Wrote a file",
 edit_file: "Edited a file",
 patch: "Patched a file",
 read_file: "Read a file",
 list_files: "Listed a folder",
 web_search: "Searched the web",
 fetch_url: "Opened a link",
 http_request: "Sent an HTTP request",
 screenshot: "Took a screenshot",
 clipboard: "Used the clipboard",
 open_path: "Opened a path",
 notify: "Sent a notification",
 wait: "Waited",
 attach_file: "Attached a file",
 video_frames: "Looked at a video",
 subagent: "Started a subagent",
 ask_user: "Asked the user",
 memory_save: "Saved a memory",
 memory_forget: "Forgot a memory",
};

function toolTitle(name) {
 if (TOOL_TITLES[name]) return TOOL_TITLES[name];
 if (String(name).startsWith("browser_")) return "Used the browser";
 return String(name || "tool").replace(/[_-]+/g, " ");
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

// One action on its own line, in a box: the command, the file, the search.
function toolBox({ name, args: toolArgs, output, error }) {
 const detail = String(toolDetail(name, toolArgs) || "").trim();
 const title = toolTitle(name);
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
 let rest = String(text);
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

// --------------------------------------------------------------- gateway (online status + DMs)
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15); // GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
const IDLE = "💤 ready";
let gateway = null, heartbeat = 0, seq = null, gatewayReady = false, shuttingDown = false;

// A custom status (type 4) shows the text itself, so the profile says what Prism is doing.
function setPresence(name) {
 if (!gatewayReady || !gateway || gateway.readyState !== WebSocket.OPEN) return;
 try {
  gateway.send(JSON.stringify({ op: 3, d: { since: 0, status: "online", afk: false, activities: [{ name: "Prism V2", type: 4, state: String(name).slice(0, 128) }] } }));
 } catch {}
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
 "`/new` — start a fresh conversation",
 "`/stop` — stop the reply being written",
 "`/seefull` — toggle Full Display: every thought and every action is posted here",
 "`/effort <level>` — thinking effort (default, none, low, medium, high, xhigh, max)",
 "`/folder <path>` — the folder tools work in",
 "`/model <provider:id>` — switch model (e.g. `opencode-go:deepseek-v4.1-flash`)",
 "`/status` — what I am set to",
 "`/help` — this",
].join("\n");

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
 if (text === "/help") return void await post(channel, HELP);
 if (text === "/new") {
  state.messages = [];
  savedState();
  return void await post(channel, "✨ fresh conversation");
 }
 if (text === "/stop") {
  state.stopped = true;
  if (currentRun) host.emit("llm:abort", currentRun);
  return void await post(channel, "⏹ stopping…");
 }
 if (text === "/seefull" || text === "/seefull on" || text === "/seefull off") {
  const on = text === "/seefull off" ? false : text === "/seefull on" ? true : !state.seefull;
  state.seefull = on;
  savedState();
  return void await post(channel, on
   ? "✅ Using Full Display — every finished thought and every action will be posted here while I work."
   : "💤 Full Display off.");
 }
 if (text === "/status") {
  const lines = [`model: \`${state.model}\``, `effort: \`${state.effort || "default"}\``, `folder: \`${state.folder}\``, `tools: ${state.tools ? "on" : "off"}`, `full display: ${state.seefull ? "on" : "off"}`, `messages in context: ${state.messages.length}`];
  return void await post(channel, lines.join("\n"));
 }
 if (text === "/effort" || text.startsWith("/effort ")) {
  const def = await modelDef();
  const levels = def?.efforts || [];
  const value = text.slice(7).trim().toLowerCase();
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
 if (text.startsWith("/folder ")) {
  const folder = text.slice(8).trim();
  if (!existsSync(folder)) return void await post(channel, `no such folder: \`${folder}\``);
  state.folder = folder;
  savedState();
  return void await post(channel, `📁 tools now work in \`${folder}\``);
 }
 if (text.startsWith("/model ")) {
  state.model = text.slice(7).trim();
  state.effort = "";
  savedState();
  return void await post(channel, `🧠 model: \`${state.model}\``);
 }

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
  status: line => {
   setPresence(`⚙️ ${line.replace(/[^\p{L}\p{N} .,!?…-]/gu, "").trim() || "working…"}`);
   updatePlaceholder(line);
  },
  // Full Display: the finished thought in small grey text, each action as its own box.
  thought: async words => { if (state.seefull) await post(channel, subtext(words)); },
  event: async item => { if (state.seefull) await post(channel, toolBox(item)); },
 };
 setPresence("⚙️ working…");
 try {
  const answer = await turn(text, display);
  setPresence(IDLE);
  if (placeholderId) await replyTo(channel, placeholderId, answer);
  else await post(channel, answer);
  log("replied:", answer.replace(/\s+/g, " ").slice(0, 100));
 } catch (error) {
  setPresence(IDLE);
  const note = `⚠️ ${error.message}`;
  if (placeholderId) await replyTo(channel, placeholderId, note);
  else await post(channel, note);
  log("failed:", error.message);
 }
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
