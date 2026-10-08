// Files the agent writes become small attachments under its message, with a preview
// (markdown renders, code shows as code) and a download that keeps the same filename.
(() => {
'use strict';

const escapeHtml = text => String(text ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const nameOf = path => String(path || '').split(/[\\/]/).pop() || 'file';
// A tool call may name the file relative to the project folder; previews and downloads need
// the real path, whatever the current working directory of the app happens to be.
const isAbsolute = path => /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(String(path || ''));
const full = (path, cwd) => (path && cwd && !isAbsolute(path) ? `${String(cwd).replace(/[\\/]+$/, '')}\\${String(path).replace(/^[\\/]+/, '')}` : path);

async function read(path, cwd) {
 try {
  const out = await window.openghost?.tools?.run?.(`art-${Date.now().toString(36)}`, 'read_file', { path: full(path, cwd) }, cwd);
  if (typeof out === 'string') return out;
  if (out && typeof out.text === 'string') return out.text;
  return null;
 } catch {
  return null;
 }
}

function previewModal(name, text) {
 const overlay = document.createElement('div');
 overlay.className = 'artifact-overlay';
 const card = document.createElement('div');
 card.className = 'artifact-modal';
 card.innerHTML = `<div class="artifact-head"><span class="artifact-title">${escapeHtml(name)}</span><button type="button" class="artifact-close" aria-label="Close">×</button></div><div class="artifact-viewport"></div>`;
 const view = card.querySelector('.artifact-viewport');
 if (/\.(md|markdown)$/i.test(name)) {
  const body = document.createElement('div');
  body.className = 'message-content markdown';
  view.append(body);
  StreamView.render(body, text);
 } else {
  const pre = document.createElement('pre');
  pre.className = 'artifact-pre';
  pre.textContent = text;
  view.append(pre);
 }
 const close = () => overlay.remove();
 card.querySelector('.artifact-close').addEventListener('click', close);
 overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
 const onKey = event => {
  if (event.key !== 'Escape') return;
  close();
  document.removeEventListener('keydown', onKey);
 };
 document.addEventListener('keydown', onKey);
 overlay.append(card);
 document.body.append(overlay);
}

// The button answers at once: a spinner while the save dialog is open and the bytes are
// written, then a short green "Downloaded" flourish. A cancelled save just restores the label.
async function runDownload(button, run) {
 if (!button || button.classList.contains('is-downloading')) return null;
 const label = button.dataset.label || button.textContent || I18n.t('artifact.download');
 button.dataset.label = label;
 button.classList.remove('is-downloaded');
 button.classList.add('is-downloading');
 button.setAttribute('aria-busy', 'true');
 button.textContent = I18n.t('artifact.downloading');
 const saved = await Promise.resolve(run()).catch(() => null);
 button.classList.remove('is-downloading');
 button.removeAttribute('aria-busy');
 if (!saved) {
  button.textContent = label;
  return null;
 }
 button.classList.add('is-downloaded');
 button.textContent = I18n.t('artifact.downloaded');
 clearTimeout(button.downloadTimer);
 button.downloadTimer = setTimeout(() => {
  button.classList.remove('is-downloaded');
  if (button.isConnected) button.textContent = label;
 }, 1800);
 return saved;
}

window.Artifacts = {
 // Preview and Download live inside the write/edit card itself, so a file the agent touched
 // is one box, not a card plus a second file chip saying the same name.
 actions(card, { path, cwd }) {
  if (!card?.addAction || !path || !window.openghost?.tools) return;
  const name = nameOf(path), real = full(path, cwd);
  card.addAction(I18n.t('artifact.preview'), async () => {
   const text = await read(real, cwd);
   previewModal(name, text == null ? I18n.t('artifact.binary') : text);
  });
  let action = null;
  action = card.addAction(I18n.t('artifact.download'), () => runDownload(action, () => download(real, name)));
 },

 // A finished file the agent attached with attach_file: a small chip under the card with the
 // name, its size, a Preview when it is text, and a Download that copies the real bytes.
 attach(container, { path, name, size, cwd }) {
  if (!container || !path) return;
  const label = name || nameOf(path), real = full(path, cwd);
  const chip = document.createElement('div');
  chip.className = 'artifact';
  chip.innerHTML = `<span class="artifact-icon">${Glyphs.file}</span><span class="artifact-name" title="${escapeHtml(real)}">${escapeHtml(label)}</span>${size ? `<span class="artifact-size">${escapeHtml(size)}</span>` : ''}<button type="button" class="artifact-btn" data-act="preview">${escapeHtml(I18n.t('artifact.preview'))}</button><button type="button" class="artifact-btn" data-act="download">${escapeHtml(I18n.t('artifact.download'))}</button>`;
  chip.querySelector('[data-act="preview"]').addEventListener('click', async () => {
   const text = await read(real, cwd);
   previewModal(label, text == null ? I18n.t('artifact.binary') : text);
  });
  const downloadButton = chip.querySelector('[data-act="download"]');
  downloadButton.addEventListener('click', () => runDownload(downloadButton, () => download(real, label)));
  container.append(chip);
 },
};

// A download that keeps the file's bytes: the desktop asks where to save it, the web streams
// it from the server with its own name.
function download(path, name) {
 return Promise.resolve(window.openghost?.saveFile?.(path, name)).then(saved => saved || null);
}
})();
