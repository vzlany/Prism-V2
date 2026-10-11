'use strict';

// Discord does not render markdown tables: a table arrives as a wall of pipes. Anything the
// bot posts (or DMs) goes through here first, so a table becomes bold labels and short
// bullets. Fenced code blocks are left exactly as they are — except the app-only diagrams
// (mermaid, wireframes), which are not code the reader can use: they become one plain line.
function plainTables(text) {
 const lines = String(text || '').replace(/\r/g, '').split('\n');
 const out = [];
 let block = [];
 let fenced = false;
 let fenceLang = '';
 const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
 const isRow = line => /^\s*\|.*\|\s*$/.test(line);
 const isRule = row => row.length > 0 && row.every(cell => /^:?-{2,}:?$/.test(cell));
 const flush = () => {
  if (!block.length) return;
  const rows = block.map(cells);
  let head = null;
  let body = rows;
  // A header row is only a header when a |---| rule follows it.
  if (rows.length > 1 && isRule(rows[1])) { head = rows[0]; body = rows.slice(2); }
  if (head && head.some(Boolean)) out.push(`**${head.filter(Boolean).join(' · ')}**`);
  for (const row of body) {
   const first = row[0] || '';
   const rest = row.slice(1).filter(Boolean);
   if (!first && !rest.length) continue;
   if (!rest.length) out.push(`- ${first}`);
   else if (!first) out.push(`- ${rest.join(' — ')}`);
   else out.push(`- **${first}** — ${rest.join(' — ')}`);
  }
  block = [];
 };
 // The app draws these as pictures; Discord would show the raw source. One line stands in.
 const APP_ONLY = /^(mermaid|wireframe)\b/i;
 // Callout markers ([!TIP], [!WARNING], …) are the app's own formatting: Discord would show
 // the raw marker, so each becomes a bold label with an icon, the way the app draws it.
 const CALLOUTS = { note: '📝 NOTE', tip: 'ℹ️ TIP', important: '❗ IMPORTANT', warning: '⚠️ WARNING', caution: '🚨 CAUTION' };
 const CALLOUT_LINE = /^\s*(?:>\s*)?\[!(note|tip|important|warning|caution)\]\s*(.*)$/i;
 for (const line of lines) {
  if (/^\s*```/.test(line)) {
   flush();
   if (!fenced) { fenceLang = line.replace(/^\s*```/, '').trim(); out.push(line); fenced = true; continue; }
   fenced = false;
   if (APP_ONLY.test(fenceLang)) {
    // Replace the opening fence and the source lines with one plain line.
    let at = out.length - 1;
    while (at >= 0 && !/^\s*```/.test(out[at])) at--;
    out.splice(Math.max(0, at), out.length - Math.max(0, at), '`📊 A diagram — open Prism to see it.`');
   } else {
    out.push(line);
   }
   continue;
  }
  if (!fenced) {
   const callout = CALLOUT_LINE.exec(line);
   if (callout) {
    flush();
    const rest = callout[2].trim();
    out.push(`**${CALLOUTS[callout[1].toLowerCase()]}**${rest ? ` ${rest}` : ''}`);
    continue;
   }
  }
  if (!fenced && isRow(line)) { block.push(line); continue; }
  flush();
  out.push(line);
 }
 flush();
 return out.join('\n');
}

module.exports = { plainTables };
