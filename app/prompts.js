// The user's own system-prompt instructions: one global prompt for every model, plus a
// prompt per model. They ride on top of Prism V2's built-in agent rules (the tools, modes
// and formatting still work), and the global one can be switched off.
//
// The prompts live in the shared store as well as localStorage, so a prompt written on the
// phone in Settings -> Prompt is the prompt the desktop app runs its delegated turns with.
(() => {
'use strict';

const KEY = 'openghost.prompts';
// The store only allows [a-z0-9_-] (and one slash) in a key; the local copy keeps the
// dotted name so nothing else that reads localStorage is surprised.
const STORE = 'prompts';
// What a server's turns are told when no Server prompt is written: the machine belongs to
// the user alone, how work should be run there, and how to keep the filesystem legible.
const SERVER_DEFAULT = [
 "- This is the user's own Debian server (debian-server), running 24/7 and reached over the network. Nobody else has an account or uses it — it exists for the user alone, so you may install, configure, change and run whatever the task needs without worrying about disturbing anyone.",
 '- Every command runs as the user `server` in `/home/server`. Long-running work belongs in `nohup … &` with a log file or a systemd unit; check that what you started actually stays up instead of waiting for it to finish.',
 '- The Prism stack lives in `~/prism-v2` and runs as the `prism-server` service (web UI on port 8787, plus the Discord bot). Restarting or changing it affects how the user reaches this machine — do that when the task calls for it, and say so in one line first.',
 '- When sudo is set up in Settings → Server, it answers its own prompt: run `sudo apt-get install -y …` directly and never ask for or print the password.',
 '- Be deliberate with anything irreversible or that could lock the user out — wiping data, changing SSH, firewall or the network config: state what you are about to do in one short line before you do it.',
 '- **Maintain a clean, self-documenting filesystem.** Never scatter files randomly across directories or leave temporary, generated, downloaded, backup, or project-related files in inappropriate locations. Decide on and maintain a logical directory structure that makes sense for the system, keeping related files together and separating projects, configuration, scripts, logs, temporary files, backups, and documentation where appropriate. You may create your own `.txt`, `.md`, `README`, index, or other documentation files whenever useful, explaining what directories contain, why files exist, how components work together, and what decisions or conventions you established. Use sensible, consistent filenames and avoid unnecessary duplication or clutter. You have the freedom to design and improve your own organizational system. Maintain a persistent memory of your filesystem conventions, important paths, and organizational decisions so you can navigate and maintain everything efficiently across future sessions. Use a recognizable prefix such as `PRISM-` or other names for your own notes and documentation when appropriate, and remember that files may be documents you previously created for yourself. However, never assume a file is solely yours because of its name: inspect its contents and purpose before modifying or deleting it. Before creating new files, check whether an appropriate location or existing document already exists. Update your Memory when you make meaningful structural changes and think its worth saving them, remove obsolete notes when safe, and always leave the filesystem organized, understandable, and easy for your future self to work with.',
].join('\n');
const DEFAULTS = { version: 1, enabled: true, global: '', models: {}, server: '' };

let cache = null;
let loading = null;

function local() {
 try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; }
}

function normalize(data) {
 return {
  version: 1,
  enabled: data?.enabled !== false,
  global: typeof data?.global === 'string' ? data.global : '',
  models: data?.models && typeof data.models === 'object' ? { ...data.models } : {},
  // The server-only text: used instead of the built-in lines when this machine is a server.
  server: typeof data?.server === 'string' ? data.server : '',
 };
}

async function load(force = false) {
 if (cache && !force) return cache;
 if (loading && !force) return loading;
 loading = (async () => {
  let data = null;
  try { data = await window.openghost?.store?.read?.(STORE); } catch {}
  if (!data?.version) data = local();
  cache = normalize(data || DEFAULTS);
  return cache;
 })().finally(() => { loading = null; });
 return loading;
}

function save(next) {
 const data = normalize(next);
 cache = data;
 try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {}
 try { Promise.resolve(window.openghost?.store?.write?.(STORE, data)).catch(() => {}); } catch {}
 return data;
}

// The extra system instructions for a model: the global prompt first, then the model's own.
async function textFor(modelId) {
 const data = await load();
 const parts = [];
 if (data.enabled && data.global.trim()) parts.push(`# User instructions (global)\nFollow the user's standing instructions below, in addition to all the rules above.\n\n${data.global.trim()}`);
 const own = data.models?.[modelId];
 if (own && own.trim()) parts.push(`# User instructions (this model)\nThese apply to every chat answered by ${modelId}.\n\n${own.trim()}`);
 return parts.join('\n\n');
}

window.Prompts = { load, save, textFor, normalize, defaultServer: SERVER_DEFAULT, get data() { return cache; } };
})();
