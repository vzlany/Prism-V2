'use strict';

// An automatic update takes the app away for a few seconds and comes back a newer version —
// and used to say nothing at all about it. This leaves the word behind: one note in a chat of
// its own, "Prism V2 updates", written just before the restart, so the first thing the user
// sees on the way back (in the app, on the phone, in Discord's chat list) is what happened.
//
// It writes the same files the chat library does — store/index.json and store/chats/<id>.json —
// atomically, so a reader on another device never catches half a note.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TITLE = 'Prism V2 updates';
const MARK = 'updates';

const readJson = (file, fallback = null) => {
 try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

// tmp + rename: the store is read by the web server and the bot at the same time.
const writeJson = (file, value) => {
 fs.mkdirSync(path.dirname(file), { recursive: true });
 const temp = `${file}.${process.pid}.tmp`;
 fs.writeFileSync(temp, JSON.stringify(value));
 fs.renameSync(temp, file);
};

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function note({ from = '', to = '', why = 'automatically', platform = process.platform, at = Date.now(), restart = true } = {}) {
 if (!to) return null;
 const when = new Date(at);
 const lines = [
  `**Prism V2 was updated ${why}** — now running **v${to}**.`,
  '',
  `- Version: ${from ? `v${from} → ` : ''}v${to}`,
  `- When: ${when.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`,
  `- This machine: ${platform}`,
  ...(restart ? ['- Everything came back on its own: chats, settings, memories and project folders are where they were.'] : []),
  '',
  'Nothing to do — this is only the record that it happened.',
 ].join('\n');
 return {
  entry: { role: 'assistant', content: lines, at, turn: `update-${at.toString(36)}`, update: String(to) },
  text: `Prism V2 was updated ${why} to v${to}${from ? ` (from v${from})` : ''}.`,
 };
}

// Appends the note to the updates chat, creating it the first time. Returns what was written,
// so a caller can also put the same line on Discord.
function write({ userData, from = '', to = '', why = 'automatically', platform = process.platform, at = Date.now() } = {}) {
 const made = note({ from, to, why, platform, at });
 if (!made || !userData) return null;
 const store = path.join(userData, 'store');
 const indexFile = path.join(store, 'index.json');
 const index = readJson(indexFile, null) || { version: 1, folders: [], chats: [] };
 if (!Array.isArray(index.chats)) index.chats = [];
 let chat = index.chats.find(item => item && item[MARK] === true);
 if (!chat) {
  chat = {
   id: newId(),
   title: TITLE,
   folder: process.env.HOME || os.homedir() || '',
   created: at,
   updated: at,
   pinned: true,
   named: true,
   model: '',
   mode: 'auto',
   order: -1,
   [MARK]: true,
  };
  index.chats.unshift(chat);
 }
 chat.updated = at;
 // The note is the newest line, and the chat is the newest chat: pinned, it sits at the top
 // of the list instead of being buried under the work it interrupted.
 writeJson(indexFile, index);
 const file = path.join(store, 'chats', `${chat.id}.json`);
 const body = readJson(file, null) || { version: 1, messages: [] };
 if (!Array.isArray(body.messages)) body.messages = [];
 // An update that restarts twice (a supervisor and the app, or a retried install) must not
 // write the same note twice: the version on the last line is what says it is the same one.
 const last = body.messages[body.messages.length - 1];
 if (last?.update === String(to)) return made;
 body.messages.push(made.entry);
 writeJson(file, body);
 return made;
}

module.exports = { write, note, TITLE };
