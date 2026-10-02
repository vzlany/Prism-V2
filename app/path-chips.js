// A local path written in a reply becomes a small link with an icon: a folder opens in the
// file manager, a file opens with its program, an image wears a picture icon. Only paths
// that really exist are linked; the rest stay plain text. GitHub links get their own mark.
(() => {
'use strict';

// Local Windows paths: a drive or a relative run of names, with backslashes. Forward-slash
// text (URLs, prose) is left alone, so nothing that is not a path is turned into one.
const CANDIDATE = /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/])?[\w.\-]+(?:[\\/][\w.\-]+)+[\\/]?/;
const CANDIDATE_ALL = new RegExp(CANDIDATE.source, 'g');
const MIN = 5;
const MAX = 240;
const cache = new Map();
const isImage = value => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(value);
const key = (cwd, path) => `${cwd || ''}|${path}`;

function candidates(text) {
 const out = [];
 let match;
 CANDIDATE_ALL.lastIndex = 0;
 while ((match = CANDIDATE_ALL.exec(text))) {
  let raw = match[0], lead = 0;
  while (raw && /[\s.,;:!?)\]}>"'`]/.test(raw[0])) { raw = raw.slice(1); lead++; }
  raw = raw.replace(/[\s.,;:!?)\]}>"'`]+$/, '');
  if (raw.length < MIN || raw.length > MAX || !raw.includes('\\')) continue;
  out.push({ raw, at: match.index + lead });
 }
 return out;
}

function infoFor(raw, cwd) {
 const at = key(cwd, raw);
 if (cache.has(at)) return cache.get(at);
 const task = Promise.resolve(window.openghost?.path?.info?.(raw, cwd)).catch(() => null);
 cache.set(at, task);
 return task;
}

function chip(raw, info, cwd) {
 const button = document.createElement('button');
 button.type = 'button';
 button.className = `path-chip${info.dir ? ' is-dir' : info.image ? ' is-image' : ' is-file'}`;
 button.title = info.path || raw;
 const mark = document.createElement('span');
 mark.className = 'path-chip-icon';
 mark.innerHTML = info.dir ? Glyphs.folder : (info.image ? Glyphs.image : Glyphs.file) || '';
 const label = document.createElement('span');
 label.className = 'path-chip-text';
 label.textContent = raw;
 button.append(mark, label);
 button.addEventListener('click', event => {
  event.preventDefault();
  event.stopPropagation();
  window.openghost?.path?.open?.(info.path || raw, cwd);
 });
 return button;
}

const SKIP = 'pre, code, a, .md-code, .md-calc, .md-diagram, .path-chip, .artifact, .md-copy';

async function enhance(root, cwd) {
 if (!root || !window.openghost?.path?.info || root.dataset?.chips === 'on') return;
 if (root.dataset) root.dataset.chips = 'on';
 const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
  acceptNode(node) {
   const parent = node.parentElement;
   if (!parent || !node.nodeValue || node.nodeValue.length < MIN) return NodeFilter.FILTER_REJECT;
   if (parent.closest(SKIP)) return NodeFilter.FILTER_REJECT;
   return CANDIDATE.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
  },
 });
 const nodes = [];
 while (walker.nextNode()) nodes.push(walker.currentNode);
 for (const node of nodes) {
  const found = candidates(node.nodeValue || '');
  if (!found.length) continue;
  const checked = await Promise.all(found.map(item => infoFor(item.raw, cwd)));
  if (!checked.some(info => info?.exists)) continue;
  const frag = document.createDocumentFragment();
  let cursor = 0;
  found.forEach((item, index) => {
   if (!checked[index]?.exists) return;
   frag.append(document.createTextNode(node.nodeValue.slice(cursor, item.at)));
   frag.append(chip(item.raw, checked[index], cwd));
   cursor = item.at + item.raw.length;
  });
  frag.append(document.createTextNode(node.nodeValue.slice(cursor)));
  node.parentNode?.replaceChild(frag, node);
 }
}

window.PathChips = { enhance };
})();
