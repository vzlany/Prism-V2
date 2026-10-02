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
const fallback = model => {
 const id = String(model?.api || model?.id || ''), name = String(model?.name || '');
 for (const [rule, text, color, domain] of FAMILIES) if (rule.test(id) || rule.test(name)) return { text, color, domain };
 const initials = (name || id).replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase();
 return { text: initials || 'AI', color: '#64748b', domain: '' };
};

const sources = domain => [
 `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`,
 `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`,
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
 if (cache.has(domain)) return cache.get(domain);
 const entry = { src: '', waiters: [] };
 cache.set(domain, entry);
 (async () => {
  for (const candidate of sources(domain)) {
   if (await probe(candidate)) { entry.src = candidate; break; }
  }
  for (const waiter of entry.waiters) waiter(entry.src);
  entry.waiters.length = 0;
 })();
 return entry;
}

// The badge element a menu row shows: a coloured monogram, replaced by the real logo as soon
// as it loads (once per family, then instant everywhere).
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
   if (!src || !wrap.isConnected) return;
   const img = document.createElement('img');
   img.className = 'model-icon-img';
   img.alt = '';
   img.src = src;
   wrap.append(img);
   wrap.classList.add('has-image');
  };
  const entry = load(info.domain);
  if (entry.src) show(entry.src);
  else entry.waiters.push(show);
 }
 return wrap;
}

window.ModelIcons = { icon, fallback };
})();
