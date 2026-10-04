// Real little logos for the model menus, next to the letter badge that shows until the
// mark arrives: a transparent brand logo when one can be found, the app's favicon after
// that, a coloured monogram otherwise. No plate is drawn behind them.
//
// The brand marks ship with the app (app/brands, the same set ElysianAI uses), so the
// menus are instant and identical offline; the remote sources are only a fallback for a
// family the local set does not know.
(() => {
'use strict';

const local = name => `brands/${name}.png`;
const lobe = name => `https://unpkg.com/@lobehub/icons-static-svg/icons/${name}.svg`;
const simple = slug => `https://cdn.simpleicons.org/${slug}/e8edf5`;
// Favicons come with their own background baked in: they are clipped like app icons, and
// only used when no clean logo exists.
const favicons = domain => [
 { url: `https://www.google.com/s2/favicons?domain=${domain}&sz=64`, app: true },
 { url: `https://icons.duckduckgo.com/ip3/${domain}.ico`, app: true },
 { url: `https://${domain}/favicon.ico`, app: true },
];
// [rule, initials, colour, key, sources best first]
const FAMILIES = [
 [/deepseek/i, 'DS', '#5b74ff', 'deepseek', [{ url: local('deepseek') }, { url: lobe('deepseek-color') }, { url: simple('deepseek') }, ...favicons('deepseek.com')]],
 [/kimi|moonshot/i, 'KM', '#8aa2c8', 'moonshot', [{ url: local('kimi') }, { url: simple('moonshotai') }, ...favicons('moonshot.ai')]],
 [/glm|zhipu/i, 'GLM', '#0ea5a4', 'zhipu', [{ url: local('glm') }, { url: lobe('zhipu-color') }, ...favicons('zhipuai.cn')]],
 [/qwen/i, 'QW', '#7c5cff', 'qwen', [{ url: local('qwen') }, { url: lobe('qwen-color') }, { url: simple('qwen') }, ...favicons('qwen.ai')]],
 [/minimax/i, 'MM', '#f59e0b', 'minimax', [{ url: local('minimax') }, { url: lobe('minimax-color') }, ...favicons('minimax.io')]],
 [/longcat/i, 'LC', '#eab308', 'longcat', [{ url: local('longcat') }, { url: lobe('longcat-color') }, ...favicons('longcat.ai')]],
 [/mimo|xiaomi/i, 'MI', '#ec4899', 'xiaomi', [{ url: local('xiaomi') }, { url: simple('xiaomi') }, ...favicons('xiaomi.com')]],
 [/grok|xai/i, 'X', '#a8b3c4', 'xai', [{ url: local('grok') }, { url: simple('x') }, ...favicons('x.ai')]],
 [/gpt|openai/i, 'GPT', '#10b981', 'openai', [{ url: local('gpt') }, { url: lobe('openai'), dark: true }, ...favicons('openai.com')]],
 [/muse|llama|(^|[^a-z])meta([^a-z]|$)/i, 'MS', '#8b5cf6', 'meta', [{ url: local('muse-llama') }, { url: lobe('meta-color') }, ...favicons('meta.com')]],
 [/hunyuan|(^|[^a-z])hy\d*([^a-z]|$)/i, 'HY', '#3b82f6', 'hunyuan', [{ url: local('hy') }, { url: lobe('hunyuan-color') }, ...favicons('tencent.com')]],
 [/claude|anthropic/i, 'AN', '#d97757', 'claude', [{ url: local('anthropic') }, { url: lobe('claude-color') }, ...favicons('anthropic.com')]],
 [/opencode/i, 'OC', '#9a9a9a', 'opencode', [{ url: local('opencode') }, { url: simple('opencode') }, ...favicons('opencode.ai')]],
 [/gemma/i, 'GE', '#4285f4', 'gemma', [{ url: local('gemma') }, { url: lobe('gemma-color') }, ...favicons('ai.google.dev')]],
 [/google|gemini|gemma/i, 'GO', '#4285f4', 'google', [{ url: local('google') }, { url: lobe('google-color') }, ...favicons('google.com')]],
 [/nvidia/i, 'NV', '#76b900', 'nvidia', [{ url: local('nvidia') }, { url: simple('nvidia') }, ...favicons('nvidia.com')]],
 [/ollama/i, 'OL', '#c4c4c4', 'ollama', [{ url: local('ollama') }, { url: simple('ollama') }, ...favicons('ollama.com')]],
];

const cache = new Map();
// A family that could not be fetched is remembered only for a while: the network may come
// back, and a menu opened offline should still get its logos later.
const FAIL_TTL = 10 * 60 * 1000;

const fallback = model => {
 const id = String(model?.api || model?.id || ''), name = String(model?.name || '');
 for (const [rule, text, color, key, sources] of FAMILIES) if (rule.test(id) || rule.test(name)) return { text, color, key, sources };
 const initials = (name || id).replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase();
 return { text: initials || 'AI', color: '#94a3b8', key: '', sources: [] };
};

function probe(src) {
 return new Promise(resolve => {
  const img = new Image();
  const timer = setTimeout(() => resolve(false), 2500);
  img.onload = () => { clearTimeout(timer); resolve(img.naturalWidth > 1); };
  img.onerror = () => { clearTimeout(timer); resolve(false); };
  img.src = src;
 });
}

function load(key, sources) {
 const entry = cache.get(key);
 if (entry && (entry.source || Date.now() - entry.at < FAIL_TTL)) return entry;
 const next = { source: null, at: Date.now(), waiters: [] };
 cache.set(key, next);
 Promise.all(sources.map(source => probe(source.url).then(ok => (ok ? source : null), () => null)))
  .then(results => {
   next.source = results.find(Boolean) || null;
   for (const waiter of next.waiters) waiter(next.source);
   next.waiters.length = 0;
  });
 return next;
}

// The badge element a menu row shows: the family's own mark, or its initials in the family's
// colour while the mark is on its way (and for families with no mark at all).
function icon(model) {
 const info = fallback(model);
 const wrap = document.createElement('span');
 wrap.className = 'model-icon';
 const letter = document.createElement('span');
 letter.className = 'model-icon-letter';
 letter.textContent = info.text;
 letter.style.setProperty('--badge', info.color);
 wrap.append(letter);
 if (info.sources.length) {
  const show = source => {
   if (!source) return;
   const img = document.createElement('img');
   img.className = `model-icon-img${source.dark ? ' is-dark' : ''}${source.app ? ' is-app' : ''}`;
   img.alt = '';
   img.src = source.url;
   wrap.append(img);
   wrap.classList.add('has-image');
  };
  const entry = load(info.key, info.sources);
  // The element is inserted into the menu a moment after it is built, so a cached logo is
  // attached right away rather than waiting for a connection that will never be checked.
  if (entry.source) show(entry.source);
  else entry.waiters.push(show);
 }
 return wrap;
}

window.ModelIcons = { icon, fallback };
})();
