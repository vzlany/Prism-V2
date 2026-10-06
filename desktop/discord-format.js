'use strict';

// Discord does not render markdown tables: a table arrives as a wall of pipes. Anything the
// bot posts (or DMs) goes through here first, so a table becomes bold labels and short
// bullets. Fenced code blocks are left exactly as they are.
function plainTables(text) {
 const lines = String(text || '').replace(/\r/g, '').split('\n');
 const out = [];
 let block = [];
 let fenced = false;
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
 for (const line of lines) {
  if (/^\s*```/.test(line)) { flush(); fenced = !fenced; out.push(line); continue; }
  if (!fenced && isRow(line)) { block.push(line); continue; }
  flush();
  out.push(line);
 }
 flush();
 return out.join('\n');
}

module.exports = { plainTables };
