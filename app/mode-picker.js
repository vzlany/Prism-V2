(() => {
'use strict';

const MODES = [
 { id: 'ask', icon: 'lock' },
 { id: 'auto', icon: 'shield' },
 { id: 'full', icon: 'shieldAlert' },
];
const RESIZE = { duration: 380, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' };
const LABEL = { duration: 340, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' };

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const icon = mode => `<span class="mode-icon" data-mode="${mode.id}">${Glyphs[mode.icon]}</span>`;
const pickers = new Set();

class ModePicker {
 constructor({ button, menu, settings, onChange }) {
  pickers.add(this);
  this.button = button;
  this.menu = menu;
  this.settings = settings;
  this.onChange = onChange;
  this.shown = null;
  button.innerHTML = `<span class="composer-mode-icons">${MODES.map(icon).join('')}</span><span class="composer-mode-label"></span>`;
  this.label = button.querySelector('.composer-mode-label');
  this.glide = document.createElement('div');
  this.glide.className = 'mode-glide';
  this.options = MODES.map(mode => {
   const option = document.createElement('button');
   option.type = 'button';
   option.className = 'mode-option';
   option.dataset.mode = mode.id;
   option.setAttribute('role', 'menuitemradio');
   option.innerHTML = `${icon(mode)}<span class="mode-option-text"><span class="mode-option-title">${I18n.t(`mode.${mode.id}`)}</span><span class="mode-option-hint">${I18n.t(`mode.${mode.id}.hint`)}</span></span><span class="mode-option-check">${Glyphs.check}</span>`;
   return option;
  });
  // At the end of the menu, a switch: DM me on Discord when this reply finishes.
  this.discord = document.createElement('button');
  this.discord.type = 'button';
  this.discord.className = 'mode-option mode-discord';
  this.discord.setAttribute('role', 'menuitemcheckbox');
  this.discord.setAttribute('aria-checked', 'false');
  this.discord.innerHTML = `<span class="mode-icon is-discord">${Glyphs.discord}</span><span class="mode-option-text"><span class="mode-option-title">${I18n.t('mode.discord')}</span><span class="mode-option-hint">${I18n.t('mode.discord.hint')}</span></span><span class="mode-option-check">${Glyphs.check}</span>`;
  this.separator = document.createElement('div');
  this.separator.className = 'mode-sep';
  this.separator.setAttribute('aria-hidden', 'true');
  menu.append(this.glide, ...this.options, this.separator, this.discord);
  menu.addEventListener('click', event => {
   const option = event.target.closest('.mode-option:not(.mode-discord)');
   if (!option) return;
   this.set(option.dataset.mode);
   menu.hidePopover();
   button.focus({ preventScroll: true });
  });
  this.discord.addEventListener('click', event => {
   event.stopPropagation();
   this.syncDiscord(window.DiscordNotify?.toggle?.() === true);
  });
  // The switch is shared through the store, so it loads a beat after the menu is built.
  Promise.resolve(window.DiscordNotify?.load?.()).then(() => this.syncDiscord(window.DiscordNotify?.on === true), () => {});
  menu.addEventListener('pointerover', event => this.hover(event.target.closest('.mode-option')));
  menu.addEventListener('pointerleave', () => this.hover(null));
  menu.addEventListener('focusin', event => this.hover(event.target.closest('.mode-option')));
  menu.addEventListener('keydown', event => this.onKey(event));
  menu.addEventListener('toggle', event => {
   const open = event.newState === 'open';
   button.setAttribute('aria-expanded', String(open));
   button.classList.toggle('is-open', open);
   if (open) this.options.find(option => option.dataset.mode === this.settings.mode)?.focus({ preventScroll: true });
   else this.hover(null);
  });
  this.sync();
 }

 set(mode) {
  if (mode === this.settings.mode) return;
  this.settings.setMode(mode);
  for (const picker of pickers) picker.sync();
  for (const picker of pickers) picker.onChange?.(mode);
 }

 destroy() {
  pickers.delete(this);
 }

 sync() {
  this.syncDiscord(window.DiscordNotify?.on === true);
  if (this.serverOnly) return;
  const mode = this.settings.mode;
  if (mode === this.shown) return;
  const first = this.shown === null, from = this.button.offsetWidth;
  this.shown = mode;
  this.button.dataset.mode = mode;
  this.label.textContent = I18n.t(`mode.${mode}`);
  this.button.setAttribute('aria-label', I18n.t('mode.current', { name: I18n.t(`mode.${mode}`) }));
  this.button.title = I18n.t(`mode.${mode}.hint`);
  for (const option of this.options) option.setAttribute('aria-checked', String(option.dataset.mode === mode));
  if (first || reducedMotion()) return;
  const to = this.button.offsetWidth;
  if (from && to && from !== to) this.button.animate([{ width: `${from}px` }, { width: `${to}px` }], RESIZE);
  this.label.animate([{ opacity: 0, filter: 'blur(4px)', transform: 'translateY(3px)' }, { opacity: 1, filter: 'blur(0)', transform: 'none' }], LABEL);
 }

 // The Discord switch at the bottom of the menu: checked while the setting is on.
 syncDiscord(on) {
  if (!this.discord) return;
  this.discord.setAttribute('aria-checked', String(on));
  this.discord.classList.toggle('is-on', on);
  this.discord.title = I18n.t(on ? 'mode.discord.on' : 'mode.discord.off');
 }

 // On a server device the menu carries only the Discord switch: the permission mode belongs
 // to the machine's owner, not to whoever happens to be looking at it.
 setServerOnly(on) {
  this.serverOnly = Boolean(on);
  for (const option of this.options) option.hidden = this.serverOnly;
  this.separator.hidden = this.serverOnly;
  this.button.dataset.serverOnly = this.serverOnly ? '1' : '';
  if (this.serverOnly) {
   this.button.dataset.mode = 'discord';
   this.label.textContent = I18n.t('mode.discord');
   this.button.title = I18n.t('mode.discord.hint');
   this.button.setAttribute('aria-label', I18n.t('mode.discord'));
  } else {
   this.shown = null;
   this.sync();
  }
 }

 hover(option) {
  const style = this.glide.style;
  if (!option) { style.opacity = '0'; this.glide.classList.remove('is-shown'); return; }
  const jump = !this.glide.classList.contains('is-shown');
  if (jump) style.transition = 'none';
  style.transform = `translateY(${option.offsetTop}px)`;
  style.height = `${option.offsetHeight}px`;
  if (jump) {
   void this.glide.offsetHeight;
   style.transition = '';
  }
  style.opacity = '1';
  this.glide.classList.add('is-shown');
 }

 onKey(event) {
  const k = this.options.indexOf(document.activeElement);
  const to = { ArrowDown: k + 1, ArrowUp: k - 1, Home: 0, End: this.options.length - 1 }[event.key];
  if (to === undefined) return;
  event.preventDefault();
  this.options[(to + this.options.length) % this.options.length].focus();
 }
}

window.ModePicker = ModePicker;
})();
