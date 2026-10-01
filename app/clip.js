// Copying to the clipboard, everywhere. navigator.clipboard only exists in a secure
// context: the phone reaching `prism web` over http://<lan-ip> has none, and the copy
// buttons would silently do nothing there. A hidden textarea with execCommand('copy')
// still works in that case, so both are tried.
(() => {
'use strict';

function fallback(text) {
 try {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.left = '-1000px';
  document.body.append(area);
  const picked = getSelection();
  const range = document.createRange();
  range.selectNodeContents(area);
  picked?.removeAllRanges();
  picked?.addRange(range);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  picked?.removeAllRanges();
  return ok;
 } catch {
  return false;
 }
}

async function text(value) {
 const plain = String(value ?? '');
 if (navigator.clipboard?.writeText) {
  try { await navigator.clipboard.writeText(plain); return true; } catch {}
 }
 return fallback(plain);
}

window.Clip = { text };
})();
