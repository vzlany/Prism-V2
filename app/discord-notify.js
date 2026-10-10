// "DM me on Discord when the reply finishes": a small switch that lives at the end of the
// agent-mode menu (and is the whole mode button on a server). It is shared through the store,
// so the app and the phone see the same setting; on until the user turns it off.
(() => {
'use strict';

const KEY = 'openghost.discordNotify';
const STORE = 'notify';
let cache = null;
let loading = null;

const local = () => {
 try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
};
// No stored choice yet means ON: a finished reply reaching the phone is the point of the bot.
const normalize = data => ({ version: 1, discord: data ? data.discord === true : true });

async function load(force = false) {
 if (cache && !force) return cache;
 if (loading && !force) return loading;
 loading = (async () => {
  let data = null;
  try { data = await window.openghost?.store?.read?.(STORE); } catch {}
  if (!data?.version) data = local();
  cache = normalize(data || {});
  return cache;
 })().finally(() => { loading = null; });
 return loading;
}

function save(patch) {
 const data = normalize({ ...(cache || {}), ...patch });
 cache = data;
 try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {}
 try { Promise.resolve(window.openghost?.store?.write?.(STORE, data)).catch(() => {}); } catch {}
 return data;
}

window.DiscordNotify = {
 get on() { return cache?.discord === true; },
 load,
 save,
 toggle() { return save({ discord: !this.on }).discord; },
};
})();
