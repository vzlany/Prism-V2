// The glass button, drawn by hand instead of an emoji: a pair of sunglasses in the same
// line style as the sidebar and globe buttons. It wears no resting background — the icon
// alone, like the hamburger — and the lenses fill in when the hidden mode is armed.
(() => {
'use strict';

class IncognitoToggle extends IconButton {
 static get observedAttributes(){return [...super.observedAttributes,'on']}
 constructor(){
  super(`
   <svg class="icon" xmlns="http://www.w3.org/2000/svg" viewBox="30 30 60 60" fill="none" aria-hidden="true">
    <g class="glyph">
     <rect class="lens-fill" x="33.5" y="47" width="24" height="19" rx="7" fill="currentColor" opacity="0"/>
     <rect class="lens-fill" x="62.5" y="47" width="24" height="19" rx="7" fill="currentColor" opacity="0"/>
     <rect x="33.5" y="47" width="24" height="19" rx="7" stroke="currentColor" stroke-width="5.5"/>
     <rect x="62.5" y="47" width="24" height="19" rx="7" stroke="currentColor" stroke-width="5.5"/>
     <path d="M57.5 52.5Q60 49 62.5 52.5" stroke="currentColor" stroke-width="5.5" stroke-linecap="round"/>
     <path d="M33.8 49.5 30.6 46.2" stroke="currentColor" stroke-width="5.5" stroke-linecap="round"/>
     <path d="M86.2 49.5 89.4 46.2" stroke="currentColor" stroke-width="5.5" stroke-linecap="round"/>
    </g>
   </svg>`,{on:[170,24]},`
   .lens-fill{transition:opacity .25s ease}
   :host([on]) .icon{opacity:1}
   @media (prefers-reduced-motion: reduce){.lens-fill{transition:none}}`);
  this.lenses=[...this.shadowRoot.querySelectorAll('.lens-fill')];
 }
 get on(){return this.hasAttribute('on')}
 defaultLabel(){return I18n.t(this.on?'incognito.on':'incognito.off')}
 activate(){this.dispatchEvent(new CustomEvent('incognito-toggle',{bubbles:true,composed:true}))}
 snap(){this.s.on=[this.on?1:0,0]}
 sync(){this.button.setAttribute('aria-pressed',String(this.on));this.button.setAttribute('aria-label',this.getAttribute('label')||this.defaultLabel())}
 targets(hover,reduced){return {on:reduced?0:(this.on?1:0)}}
 render(v){
  // The lenses drink the ink in when hidden mode is armed; a hint of life, no noise.
  for(const lens of this.lenses) lens.setAttribute('opacity',(v.on*.32).toFixed(3));
 }
}
if(!customElements.get('incognito-toggle'))customElements.define('incognito-toggle',IncognitoToggle);
})();
