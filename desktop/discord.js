'use strict';

// Discord notifications: when a chat finishes, a bot sends the user a DM with the chat's
// name, the outcome and a one-line summary. Off by default; needs a bot token and the
// user's Discord id, both kept on this machine.
const { app, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { plainTables } = require('./discord-format');

const file = () => path.join(app.getPath('userData'), 'discord.json');
let prefs = null;

function load() {
 if (prefs) return prefs;
 try { prefs = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { prefs = {}; }
 return prefs || {};
}

function save() {
 try {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(load(), null, 2));
 } catch {}
}

function state() {
 const p = load();
 return { enabled: Boolean(p.enabled), userId: String(p.userId || ''), hasToken: Boolean(p.token) };
}

// A message body over Discord's 2000-char limit is split on its own line breaks (then on
// spaces, then hard) instead of being cut off — the finished reply arrives whole, markdown
// and all, in as many messages as it takes.
function chunks(text) {
 const out = [];
 let rest = plainTables(String(text || '')).trim();
 while (rest.length > 1900) {
  let at = rest.lastIndexOf('\n', 1900);
  if (at < 400) at = rest.lastIndexOf(' ', 1900);
  if (at < 400) at = 1900;
  out.push(rest.slice(0, at));
  rest = rest.slice(at).replace(/^[\s\n]+/, '');
 }
 if (rest) out.push(rest);
 return out;
}

const MAX_FILE = 9 * 1024 * 1024;

// Which app conversation each posted finish message belongs to: replying to that message in
// Discord continues the same chat. The bridge reads this file.
const MAP_MAX = 400;
const mapFile = () => path.join(app.getPath('userData'), 'discord-map.json');
function loadMap() {
 try { return JSON.parse(fs.readFileSync(mapFile(), 'utf8'))?.messages || {}; } catch { return {}; }
}
function remember(ids, chatId) {
 try {
  const map = loadMap();
  const now = Date.now();
  for (const id of ids) map[id] = { chat: chatId, at: now };
  const kept = Object.entries(map)
   .filter(([, entry]) => now - (Number(entry?.at) || 0) < 30 * 24 * 60 * 60 * 1000)
   .sort((a, b) => (Number(b[1]?.at) || 0) - (Number(a[1]?.at) || 0))
   .slice(0, MAP_MAX);
  fs.mkdirSync(path.dirname(mapFile()), { recursive: true });
  fs.writeFileSync(mapFile(), JSON.stringify({ version: 1, messages: Object.fromEntries(kept) }));
 } catch {}
}

// Files the run produced (attach_file) ride along as real Discord attachments. Anything that
// is missing or bigger than the safe upload size is skipped rather than failing the send.
// `caption` rides on the first file's message, so text and picture arrive together.
async function upload(token, channel, files, caption = '') {
 const attached = [];
 for (const file of (Array.isArray(files) ? files : []).slice(0, 10)) {
  const target = typeof file === 'string' ? file : file?.path;
  if (!target) continue;
  try {
   const stat = fs.statSync(target);
   if (!stat.isFile() || stat.size > MAX_FILE) continue;
   const form = new FormData();
   form.append('payload_json', JSON.stringify(!attached.length && caption ? { content: caption.slice(0, 1900) } : {}));
   form.append('files[0]', new Blob([fs.readFileSync(target)]), path.basename(target));
   const res = await fetch(`https://discord.com/api/v10/channels/${channel}/messages`, {
    method: 'POST',
    headers: { authorization: `Bot ${token}` },
    body: form,
   });
   if (res.ok) attached.push(path.basename(target));
  } catch {}
 }
 return attached;
}

// A message the agent sends on its own (the <send_discord_message> block in its reply): plain
// text with any files or pictures attached, no "finished" header, straight into the DM.
async function note(text, files = []) {
 const p = load();
 if (!p.enabled || !p.token || !p.userId) return { ok: false, error: 'not configured' };
 const body = String(text || '').trim();
 const list = (Array.isArray(files) ? files : []).map(file => String(file || '').trim()).filter(Boolean);
 if (!body && !list.length) return { ok: false, error: 'nothing to send' };
 try {
  const headers = { authorization: `Bot ${p.token}`, 'content-type': 'application/json' };
  const dm = await fetch('https://discord.com/api/v10/users/@me/channels', {
   method: 'POST',
   headers,
   body: JSON.stringify({ recipient_id: String(p.userId) }),
  });
  if (!dm.ok) return { ok: false, error: `dm channel ${dm.status}` };
  const channel = (await dm.json()).id;
  const attached = await upload(p.token, channel, list, body);
  let ok = true;
  // The caption only fits 1900 chars: a longer note goes as its own messages first.
  if (body && (!attached.length || body.length > 1900)) {
   for (const part of chunks(body)) {
    const res = await fetch(`https://discord.com/api/v10/channels/${channel}/messages`, {
     method: 'POST',
     headers,
     body: JSON.stringify({ content: part }),
    });
    ok = res.ok && ok;
   }
  }
  return { ok, ...(attached.length ? { attached } : {}) };
 } catch (error) {
  return { ok: false, error: String(error?.message || error).slice(0, 200) };
 }
}

async function send(title, outcome, summary, files = [], chatId = '') {
 const p = load();
 if (!p.enabled || !p.token || !p.userId) return { ok: false, error: 'not configured' };
 try {
  const headers = { authorization: `Bot ${p.token}`, 'content-type': 'application/json' };
  const dm = await fetch('https://discord.com/api/v10/users/@me/channels', {
   method: 'POST',
   headers,
   body: JSON.stringify({ recipient_id: String(p.userId) }),
  });
  if (!dm.ok) return { ok: false, error: `dm channel ${dm.status}` };
  const channel = (await dm.json()).id;
  // Each posted message answers with its id: remembered so a reply to it can continue the
  // app conversation it came from.
  const post = content => fetch(`https://discord.com/api/v10/channels/${channel}/messages`, {
   method: 'POST',
   headers,
   body: JSON.stringify({ content }),
  }).then(async res => {
   if (!res.ok) return '';
   try { return (await res.json())?.id || ''; } catch { return ''; }
  }, () => '');
  // The header and the first piece of the reply share a message when they fit together.
  const header = `**${String(title).slice(0, 120)}** — ${String(outcome || 'completed')}`;
  const parts = chunks(summary);
  let first = header;
  if (parts.length && first.length + 2 + parts[0].length <= 2000) first += `\n${parts.shift()}`;
  const ids = [];
  const firstId = await post(first);
  if (firstId) ids.push(firstId);
  for (const part of parts) {
   const id = await post(part);
   if (id) ids.push(id);
  }
  const ok = ids.length > 0;
  if (chatId && ids.length) remember(ids, chatId);
  const attached = await upload(p.token, channel, files);
  return { ok, ...(attached.length ? { attached } : {}) };
 } catch (error) {
  return { ok: false, error: String(error?.message || error).slice(0, 200) };
 }
}

function register(fromApp) {
 ipcMain.handle('discord:get', event => (fromApp(event) ? state() : { enabled: false, userId: '', hasToken: false }));
 ipcMain.handle('discord:set', (event, patch) => {
  if (!fromApp(event)) return state();
  const p = load();
  if (typeof patch?.token === 'string') p.token = patch.token.trim();
  if (typeof patch?.userId === 'string') p.userId = patch.userId.trim();
  if (typeof patch?.enabled === 'boolean') p.enabled = patch.enabled;
  prefs = p;
  save();
  return state();
 });
 ipcMain.handle('discord:test', event => (fromApp(event) ? send('Prism V2', 'test', 'Discord notifications are wired up.') : { ok: false }));
}

module.exports = { register, send, note, state };
