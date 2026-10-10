// A small in-page prompt for a folder path: the desktop app uses its native picker, but a
// browser — and the Electron remote window, where window.prompt does not exist — has no
// folder dialog, so the server asks for the path as text instead.
(() => {
'use strict';

window.PathPrompt = {
 ask({ title = '', hint = '', value = '', placeholder = '' } = {}) {
  return new Promise(resolve => {
   const overlay = document.createElement('div');
   overlay.className = 'path-overlay';
   overlay.innerHTML = `
    <div class="path-sheet" role="dialog" aria-modal="true">
     <div class="path-title">${escapeHtml(title || I18n.t('path.title'))}</div>
     <p class="path-hint">${escapeHtml(hint || I18n.t('path.hint'))}</p>
     <input class="settings-key path-input" type="text" spellcheck="false" autocomplete="off" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}">
     <div class="path-foot">
      <button type="button" class="settings-button" data-path-cancel>${escapeHtml(I18n.t('path.cancel'))}</button>
      <button type="button" class="settings-button is-primary" data-path-ok>${escapeHtml(I18n.t('path.ok'))}</button>
     </div>
    </div>`;
   document.body.append(overlay);
   const input = overlay.querySelector('.path-input');
   const done = answer => { overlay.remove(); resolve(answer); };
   overlay.querySelector('[data-path-ok]').addEventListener('click', () => {
    const text = String(input.value || '').trim().replace(/[\\/]+$/, '');
    done(text || null);
   });
   overlay.querySelector('[data-path-cancel]').addEventListener('click', () => done(null));
   input.addEventListener('keydown', event => {
    if (event.key === 'Enter') overlay.querySelector('[data-path-ok]').click();
    else if (event.key === 'Escape') done(null);
   });
   overlay.addEventListener('pointerdown', event => { if (event.target === overlay) done(null); });
   setTimeout(() => { input.focus(); input.select(); }, 30);
  });
 },
};

function escapeHtml(text) {
 return String(text ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
}
})();
