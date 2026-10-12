// A path on the machine as a URL this window can show: a browser page gets the server's
// inline stream (/preview), the desktop window reads it straight from disk (file://).
(() => {
'use strict';

window.FileUrl = {
 of(path) {
  const value = String(path || '');
  if (!value) return '';
  if (/^(https?:|data:|blob:)/i.test(value)) return value;
  const server = !window.openghost?.desktop || /^https?:/.test(location.protocol);
  if (server) return `/preview?path=${encodeURIComponent(value)}`;
  const clean = value.replace(/\\/g, '/');
  return /^[a-zA-Z]:\//.test(clean) ? `file:///${clean}` : `file://${clean}`;
 },
};
})();
