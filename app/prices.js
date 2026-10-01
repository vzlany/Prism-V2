// Prices: USD per million tokens for the ~$ readout under the composer.
// The rates come from the same catalog OpenCode prices with (models.opencode.ai/api.json),
// cached locally and refreshed in the background; the small built-in table is the offline
// fallback. The math is OpenCode's: fresh input, output, reasoning tokens at the output
// rate, cache reads and cache writes, with the tier that matches the context size.
// Anyone can still override an entry from the console:
//   localStorage["openghost.prices"] = { "deepseek-chat": { "in": 0.27, "cached": 0.07, "out": 1.1 } }
(() => {
'use strict';

const CATALOG_URL = 'https://models.opencode.ai/api.json';
const CACHE_KEY = 'openghost.prices.catalog';
const OVERRIDE_KEY = 'openghost.prices';
const TTL = 6 * 60 * 60 * 1000;
// The providers this app can talk to; the catalog is trimmed to them when it is cached.
const USED = ['opencode-go', 'chatgpt', 'openai', 'anthropic', 'deepseek'];

const TABLE = {
 'deepseek-flash': { in: 0.27, cached: 0.07, out: 1.1 },
 'deepseek-v4.1-flash': { in: 0.27, cached: 0.07, out: 1.1 },
 'deepseek-v4-flash': { in: 0.27, cached: 0.07, out: 1.1 },
 'deepseek-v4-flash-vision-exp': { in: 0.27, cached: 0.07, out: 1.1 },
 'deepseek-v4-pro': { in: 0.55, cached: 0.14, out: 2.19 },
};

const readCache = () => {
 try {
  const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
  return raw && raw.models ? raw : null;
 } catch {
  return null;
 }
};

let catalog = readCache();
let fetching = null;

const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);
const rate = tier => ({
 input: num(tier.input),
 output: num(tier.output),
 cacheRead: num(tier.cache_read ?? tier.cacheRead),
 cacheWrite: num(tier.cache_write ?? tier.cacheWrite),
});

// Only what the readout needs: a rate per model, trimmed to the providers in use.
function slim(api) {
 const models = {};
 for (const provider of USED) {
  const entry = api?.[provider];
  if (!entry?.models) continue;
  for (const [id, model] of Object.entries(entry.models)) {
   const cost = model?.cost;
   if (!cost) continue;
   models[`${provider}:${id}`] = {
    ...rate(cost),
    tiers: (cost.tiers || []).map(tier => ({ size: num(tier.tier?.size), ...rate(tier) })).filter(tier => tier.size > 0),
    over200k: cost.context_over_200k ? rate(cost.context_over_200k) : null,
   };
  }
 }
 return models;
}

// One background read of the catalog; the local cache keeps the readout instant and offline.
function refresh(force = false) {
 if (fetching) return fetching;
 const fresh = catalog && Date.now() - catalog.at < TTL;
 if (fresh && !force) return Promise.resolve();
 fetching = fetch(CATALOG_URL, { cache: 'no-store' })
  .then(response => (response.ok ? response.json() : null))
  .then(api => {
   if (!api) return;
   const models = slim(api);
   if (!Object.keys(models).length) return;
   catalog = { at: Date.now(), models };
   try { localStorage.setItem(CACHE_KEY, JSON.stringify(catalog)); } catch {}
   window.dispatchEvent(new CustomEvent('prices-changed'));
  })
  .catch(() => {})
  .finally(() => { fetching = null; });
 return fetching;
}
refresh();

const readOverrides = () => {
 try { return JSON.parse(localStorage.getItem(OVERRIDE_KEY)) || {}; } catch { return {}; }
};

// The bare model name without its provider prefix (opencode-go:deepseek-flash -> deepseek-flash).
const bare = id => String(id || '').replace(/^[a-z0-9-]+:/i, '');

function lookup(id) {
 const key = String(id || '');
 const name = bare(key);
 const models = catalog?.models;
 if (models) {
  if (models[key]) return models[key];
  if (key.includes(':') && models[`${key.split(':')[0]}:${name}`]) return models[`${key.split(':')[0]}:${name}`];
  const suffix = `:${name}`;
  for (const [id, entry] of Object.entries(models)) if (id.endsWith(suffix)) return entry;
 }
 const table = { ...TABLE, ...readOverrides() };
 const legacy = table[key] || table[name];
 return legacy && Number.isFinite(legacy.in) && Number.isFinite(legacy.out)
  ? { input: num(legacy.in), output: num(legacy.out), cacheRead: num(legacy.cached ?? legacy.in), cacheWrite: 0, tiers: [], over200k: null }
  : null;
}

// The tier that applies at this context size: the largest matching one, OpenCode's rule.
function tierFor(price, context) {
 if (price.tiers?.length) {
  const match = price.tiers.filter(tier => context > tier.size).sort((a, b) => b.size - a.size)[0];
  if (match) return match;
 }
 if (price.over200k && context > 200000) return price.over200k;
 return price;
}

window.Prices = {
 refresh,
 of(id) {
  const entry = lookup(id);
  return entry && Number.isFinite(entry.input) && Number.isFinite(entry.output) ? entry : null;
 },
 // What a chat's collected usage costs at those rates, or null when the model has no prices.
 cost(model, spend) {
  const price = window.Prices.of(model);
  if (!price || !spend) return null;
  const input = num(spend.input), output = num(spend.output);
  const read = Math.min(num(spend.cached), input);
  const write = Math.min(num(spend.written), Math.max(0, input - read));
  const reasoning = num(spend.reasoning);
  const context = num(spend.context) || input;
  const rates = tierFor(price, context);
  const fresh = Math.max(0, input - read - write);
  const words = Math.max(0, output - reasoning);
  return fresh / 1e6 * rates.input
   + words / 1e6 * rates.output
   + reasoning / 1e6 * rates.output
   + read / 1e6 * rates.cacheRead
   + write / 1e6 * rates.cacheWrite;
 },
 // Small amounts need more decimals than large ones.
 format(value) {
  if (value == null || !Number.isFinite(value)) return '';
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
 },
};
})();
