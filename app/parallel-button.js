// The parallel button wears OpenCode's working dots: three dots breathing in turn, the
// same rhythm the runs themselves are watched with.
(() => {
'use strict';

const GLYPH = '<svg class="icon" viewBox="30 30 60 60" fill="currentColor" aria-hidden="true"><circle class="dot d1" cx="40" cy="60" r="7"/><circle class="dot d2" cx="60" cy="60" r="7"/><circle class="dot d3" cx="80" cy="60" r="7"/></svg>';

const STYLE = `
:host{width:auto}
.dot{animation:parallel-dot 1.15s ease-in-out infinite}
.dot.d2{animation-delay:.16s}
.dot.d3{animation-delay:.32s}
@keyframes parallel-dot{
  0%,100%{opacity:.32;transform:translateY(0)}
  38%{opacity:1;transform:translateY(-5px)}
}
@media (prefers-reduced-motion: reduce){.dot{animation:none;opacity:.85}}
`;

class ParallelButton extends IconButton {
 constructor() {
  super(GLYPH, {}, STYLE);
 }
 defaultLabel() {
  return I18n.t('parallel.title');
 }
 activate() {
  this.dispatchEvent(new CustomEvent('parallel-toggle', { bubbles: true, composed: true }));
 }
}

if (!customElements.get('parallel-button')) customElements.define('parallel-button', ParallelButton);
})();
