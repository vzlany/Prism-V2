// Popover menus grow out of the composer and fold back into it instead of blinking open and
// shut. Reduced motion keeps the plain show/hide.
(() => {
'use strict';

const ENTER = { duration: 280, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' };
const LEAVE = { duration: 180, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' };
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function show(el) {
 if (!el) return;
 clearTimeout(el.__motionShow);
 clearTimeout(el.__motionHide);
 el.showPopover?.();
 if (reduced()) return;
 const enter = el.animate([
  { opacity: 0, transform: 'translateY(14px) scale(0.965)' },
  { opacity: 1, transform: 'none' },
 ], ENTER);
 // A hidden window freezes the animation clock: the menu would stay at the first keyframe —
 // open but invisible. Once it should have ended, the animation is dropped, so the menu is
 // simply there.
 el.__motionShow = setTimeout(() => {
  el.__motionShow = 0;
  try { enter.cancel(); } catch {}
 }, ENTER.duration + 140);
}

function hide(el) {
 if (!el) return;
 clearTimeout(el.__motionHide);
 clearTimeout(el.__motionShow);
 el.__motionShow = 0;
 if (reduced() || !el.matches(':popover-open')) { close(el); return; }
 // A hidden window can freeze the animation clock: whatever happens, the popover goes away.
 let done = false;
 const finish = () => {
  if (done) return;
  done = true;
  clearTimeout(el.__motionHide);
  close(el);
 };
 const gone = el.animate([
  { opacity: 1, transform: 'none' },
  { opacity: 0, transform: 'translateY(10px) scale(0.975)' },
 ], LEAVE);
 gone.finished.then(finish, finish);
 el.__motionHide = setTimeout(finish, LEAVE.duration + 140);
}

function close(el) {
 try { el.hidePopover?.(); } catch {}
 for (const animation of el.getAnimations()) animation.cancel();
}

window.PopoverMotion = { show, hide };
})();
