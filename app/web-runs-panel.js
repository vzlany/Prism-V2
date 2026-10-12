// The globe on a web page (a phone, another computer) opens this: a light side panel with
// the Runs tab — the agent's parallel runs and sub-agents, live. There is no webview here
// (that is an Electron thing), so this small panel borrows the desktop panel's look and
// behavior (open state, the toggle's `open` attribute, X to close) without its tabs and
// address bar, and it answers the same window.browserPanel calls other modules make.
(() => {
'use strict';

const svg = body => `<svg viewBox="30 30 60 60" fill="none" stroke="currentColor" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const CLOSE = svg('<path d="M50 50l20 20M70 50 50 70"/>');

class WebRunsPanel {
 constructor({ app, toggle }) {
  this.app = app;
  this.toggle = toggle;
  this.open = false;
  const root = this.root = document.createElement('aside');
  root.className = 'browser is-web-runs';
  root.setAttribute('aria-label', I18n.t('runs.title'));
  root.inert = true;
  root.innerHTML = `
   <div class="browser-card">
    <div class="browser-tabs">
     <div class="browser-tab-list" role="tablist">
      <div class="browser-tab is-active" role="tab" aria-selected="true"><span class="browser-tab-icon" data-key="globe"></span><span class="browser-tab-title"></span></div>
     </div>
     <button type="button" class="browser-icon browser-close" aria-label="${I18n.t('browser.hide')}">${CLOSE}</button>
    </div>
    <div class="browser-stage"></div>
   </div>`;
  app.append(root);
  this.stage = root.querySelector('.browser-stage');
  this.tabTitle = root.querySelector('.browser-tab-title');
  this.tabIcon = root.querySelector('.browser-tab-icon');
  this.tabIcon.innerHTML = window.Glyphs?.globe || '';
  const close = root.querySelector('.browser-close');
  close.title = I18n.t('browser.hide');
  close.addEventListener('click', () => this.setOpen(false));
  toggle.addEventListener('browser-toggle', () => this.setOpen(!this.open));
 }
 // The Runs view, exactly as the desktop panel hosts it.
 addRunsView(view) {
  view.classList.add('is-active');
  this.stage.append(view);
  this.tabTitle.textContent = I18n.t('runs.title');
 }
 showRuns() {
  this.setOpen(true);
  return true;
 }
 hide() {
  this.setOpen(false);
 }
 // The desktop panel resizes its webviews on window changes; this one is pure CSS, so the
 // calls other modules make (the sidebar resizer, the collapse switch) are simply answered.
 fit() {}
 report() {}
 setOpen(open) {
  if (this.open === open) return;
  this.open = open;
  this.root.inert = !open;
  this.app.classList.toggle('is-browser-open', open);
  this.toggle.toggleAttribute('open', open);
  // The desktop panel is remembered open; the web panel starts closed again on every page
  // (a phone reload should not leave a panel over the chat).
 }
}
window.WebRunsPanel = WebRunsPanel;
})();
