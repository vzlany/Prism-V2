'use strict';

// An automatic update takes the app away for a few seconds and comes back a newer version —
// and used to say nothing at all about it. This leaves the word behind: one note in a chat of
// its own, "Prism V2 updates", written just before the restart, so the first thing the user
// sees on the way back (in the app, on the phone, in Discord's chat list) is what happened.
//
// It writes the same files the chat library does — store/index.json and store/chats/<id>.json —
// atomically, so a reader on another device never catches half a note.

const fs = require('node:fs');
const path = require('node:path');

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

// Appends the note to the conversation the user was in (or the newest one), the way a normal
// message reads there — the request was a message in the chat, not a separate log.
function write({ userData, chatId = '', from = '', to = '', why = 'automatically', platform = process.platform, at = Date.now() } = {}) {
 const made = note({ from, to, why, platform, at });
 if (!made || !userData) return null;
 const store = path.join(userData, 'store');
 const indexFile = path.join(store, 'index.json');
 const index = readJson(indexFile, null);
 if (!index) return null;
 const chats = Array.isArray(index.chats) ? index.chats : [];
 // Where the user is: the chat the update was started from, else the newest one they used.
 let chat = chats.find(item => item && chatId && item.id === chatId);
 if (!chat) {
  chat = chats
   .filter(item => item && !item.incognito && !item.subagent && !item.archived && !item.parent)
   .sort((a, b) => (Number(b.updated) || 0) - (Number(a.updated) || 0))[0];
 }
 if (!chat?.id) return null;
 const file = path.join(store, 'chats', `${chat.id}.json`);
 const body = readJson(file, null);
 if (!body || body.sealed || !Array.isArray(body.messages)) return null;
 // An update that restarts twice (a supervisor and the app, or a retried install) must not
 // write the same note twice: the version on the last line is what says it is the same one.
 const last = body.messages[body.messages.length - 1];
 if (last?.update === String(to)) return made;
 body.messages.push(made.entry);
 writeJson(file, body);
 // The conversation jumps back to the top of the list, where the user will look for it.
 chat.updated = at;
 writeJson(indexFile, index);
 return { ...made, chatId: chat.id };
}

module.exports = { write, note };
