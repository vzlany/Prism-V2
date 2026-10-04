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
const DEFAULTS = { version: 1, enabled: true, global: '', models: {} };

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

window.Prompts = { load, save, textFor, normalize, get data() { return cache; } };
})();
