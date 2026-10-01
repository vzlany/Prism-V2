// Notification sounds, taken from OpenCode's sound set (MIT): alert-, bip-bop-, staplebops-,
// nope- and yup- families. The finish / question / error chimes are picked in
// Settings -> Interface; the files live in app/sounds.
(() => {
'use strict';

const KEY = 'openghost.sounds';
const FAMILIES = [['alert', 10], ['bip-bop', 10], ['staplebops', 7], ['nope', 12], ['yup', 6]];
const OPTIONS = FAMILIES.flatMap(([name, count]) => Array.from({ length: count }, (_, index) => `${name}-${String(index + 1).padStart(2, '0')}`));
// What OpenCode ships as its defaults, so the app sounds familiar.
const DEFAULTS = { on: true, finishOn: true, finish: 'staplebops-01', questionOn: true, question: 'staplebops-02', errorOn: true, error: 'nope-03' };

function read() {
 try {
  const stored = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  return { ...DEFAULTS, ...stored };
 } catch {
  return { ...DEFAULTS };
 }
}

const cache = new Map();
function play(id) {
 if (!id || !OPTIONS.includes(id)) return;
 try {
  let audio = cache.get(id);
  if (!audio) {
   audio = new Audio(`sounds/${id}.mp3`);
   audio.preload = 'auto';
   cache.set(id, audio);
  }
  audio.currentTime = 0;
  audio.play().catch(() => {});
 } catch {}
}

window.Sounds = {
 options: OPTIONS.slice(),
 families: FAMILIES.map(([name]) => name),
 get settings() {
  return read();
 },
 set(patch) {
  const next = { ...read(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
 },
 play,
 preview(id) {
  play(id);
 },
 // A turn finished; a question (or approval) is waiting; something failed.
 finish() {
  const settings = read();
  if (settings.on && settings.finishOn) play(settings.finish);
 },
 question() {
  const settings = read();
  if (settings.on && settings.questionOn) play(settings.question);
 },
 error() {
  const settings = read();
  if (settings.on && settings.errorOn) play(settings.error);
 },
};
})();
