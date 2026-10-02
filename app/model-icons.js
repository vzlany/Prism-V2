// Real little logos for the model menus, next to the letter badge that shows until the
// image arrives: the family's own mark when it can be found, a coloured monogram otherwise.
(() => {
'use strict';

const FAMILIES = [
 [/deepseek/i, 'DS', '#5b74ff', 'deepseek.com'],
 [/kimi|moonshot/i, 'KM', '#2b3444', 'moonshot.ai'],
 [/glm|zhipu/i, 'GLM', '#0ea5a4', 'zhipuai.cn'],
 [/qwen/i, 'QW', '#7c5cff', 'qwen.ai'],
 [/minimax/i, 'MM', '#f59e0b', 'minimax.io'],
 [/longcat/i, 'LC', '#eab308', 'longcat.ai'],
 [/mimo/i, 'MI', '#ec4899', 'xiaomi.com'],
 [/grok|xai/i, 'X', '#64748b', 'x.ai'],
 [/gpt|openai/i, 'GPT', '#10b981', 'openai.com'],
 [/muse/i, 'MS', '#8b5cf6', 'meta.com'],
 [/hunyuan|(^|[^a-z])hy\d*([^a-z]|$)/i, 'HY', '#3b82f6', 'tencent.com'],
 [/claude|anthropic/i, 'AN', '#d97757', 'anthropic.com'],
 [/opencode/i, 'OC', '#8b8b8b', 'opencode.ai'],
];

const cache = new Map();
// A family that could not be fetched is remembered only for a while: the network may come
// back, and a menu opened offline should still get its logos later.
const FAIL_TTL = 10 * 60 * 1000;
const fallback = model => {
 const id = String(model?.api || model?.id || ''), name = String(model?.name || '');
 for (const [rule, text, color, domain] of FAMILIES) if (rule.test(id) || rule.test(name)) return { text, color, domain };
 const initials = (name || id).replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase();
 return { text: initials || 'AI', color: '#64748b', domain: '' };
};

const sources = domain => [
 `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`,
 `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`,
 `https://${domain}/favicon.ico`,
];

function probe(src) {
 return new Promise(resolve => {
  const img = new Image();
  const timer = setTimeout(() => resolve(false), 2500);
  img.onload = () => { clearTimeout(timer); resolve(img.naturalWidth > 1); };
  img.onerror = () => { clearTimeout(timer); resolve(false); };
  img.src = src;
 });
}

function load(domain) {
 const entry = cache.get(domain);
 if (entry && (entry.src || Date.now() - entry.at < FAIL_TTL)) return entry;
 const next = { src: '', at: Date.now(), waiters: [] };
 cache.set(domain, next);
 // All sources are tried at once: the first mark that loads wins, so a slow service never
 // holds the others back.
 Promise.all(sources(domain).map(src => probe(src).then(ok => (ok ? src : ''), () => '')))
  .then(results => {
   next.src = results.find(Boolean) || '';
   for (const waiter of next.waiters) waiter(next.src);
   next.waiters.length = 0;
  });
 return next;
}

// The badge element a menu row shows: the family's own mark, or its initials in the family's
// colour while the mark is on its way (and for families with no mark at all). No plate
// behind it, so the logo sits on the menu itself.
function icon(model) {
 const info = fallback(model);
 const wrap = document.createElement('span');
 wrap.className = 'model-icon';
 const letter = document.createElement('span');
 letter.className = 'model-icon-letter';
 letter.textContent = info.text;
 letter.style.setProperty('--badge', info.color);
 wrap.append(letter);
 if (info.domain) {
  const show = src => {
   if (!src) return;
   const img = document.createElement('img');
   img.className = 'model-icon-img';
   img.alt = '';
   img.src = src;
   wrap.append(img);
   wrap.classList.add('has-image');
  };
  const entry = load(info.domain);
  // The element is inserted into the menu a moment after it is built, so a cached logo is
  // attached right away rather than waiting for a connection that will never be checked.
  if (entry.src) show(entry.src);
  else entry.waiters.push(show);
 }
 return wrap;
}

window.ModelIcons = { icon, fallback };
})();
