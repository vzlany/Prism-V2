'use strict';

// Installs Claude-style skills from GitHub: a repository (or a subfolder of one) is fetched
// as a tarball, every folder holding a SKILL.md becomes a skill under ~/.claude/skills, and
// from there the agent already lists and follows it like any other skill.
const { ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const readString = (buffer, start, length) => {
 const end = buffer.indexOf(0, start);
 return buffer.subarray(start, end >= 0 && end < start + length ? end : start + length).toString('utf8');
};

// A minimal tar reader: enough for GitHub's tarballs (ustar, regular files, one-level prefix).
function untar(buffer) {
 const files = [];
 let offset = 0;
 while (offset + 512 <= buffer.length && files.length < 5000) {
  const header = buffer.subarray(offset, offset + 512);
  if (header.every(byte => byte === 0)) break;
  const name = readString(header, 0, 100);
  const size = parseInt(readString(header, 124, 12).trim() || '0', 8) || 0;
  const type = String.fromCharCode(header[156] || 48);
  const prefix = readString(header, 345, 155);
  const full = prefix ? `${prefix}/${name}` : name;
  offset += 512;
  if (type === '0' || type === '\0') files.push({ name: full, data: buffer.subarray(offset, offset + size) });
  offset += Math.ceil(size / 512) * 512;
 }
 return files;
}

// github.com/owner/repo, .../tree/branch/sub/folder, or just owner/repo.
function parseRepo(input) {
 const text = String(input || '').trim();
 const match = text.match(/github\.com\/([^/\s#?]+)\/([^/\s#?]+)(?:\/tree\/([^/\s#?]+)(?:\/([^\s#?]+))?)?/i);
 if (match) return { owner: match[1], repo: match[2].replace(/\.git$/i, ''), branch: match[3] || '', sub: (match[4] || '').replace(/\/+$/, '') };
 const short = text.match(/^([\w.-]+)\/([\w.-]+)$/);
 if (short) return { owner: short[1], repo: short[2].replace(/\.git$/i, ''), branch: '', sub: '' };
 return null;
}

async function download(owner, repo, branch) {
 const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${branch}`;
 const res = await fetch(url, { redirect: 'follow' });
 if (!res.ok) return { error: `${res.status} from ${url}` };
 return { buffer: Buffer.from(await res.arrayBuffer()) };
}

function safeName(name) {
 return String(name).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'skill';
}

async function install(url, onProgress = () => {}) {
 const repo = parseRepo(url);
 if (!repo) return { ok: false, error: 'not a GitHub repository address' };
 const branches = repo.branch ? [repo.branch] : ['main', 'master'];
 let lastError = 'could not download the repository';
 for (const branch of branches) {
  const result = await download(repo.owner, repo.repo, branch);
  if (result.error) { lastError = result.error; continue; }
  let files;
  try { files = untar(zlib.gunzipSync(result.buffer)); } catch (error) { return { ok: false, error: `could not read the tarball: ${error.message}` }; }
  const roots = new Map();
  for (const file of files) {
   const normalized = file.name.replace(/\\/g, '/');
   const marker = normalized.lastIndexOf('/SKILL.md');
   if (marker < 0) continue;
   const dir = normalized.slice(0, marker);
   if (repo.sub && !dir.includes(repo.sub)) continue;
   roots.set(dir, true);
  }
  if (!roots.size) return { ok: false, error: `no SKILL.md found in ${repo.owner}/${repo.repo}` };
  const base = path.join(os.homedir(), '.claude', 'skills');
  const installed = [];
  for (const dir of roots.keys()) {
   const raw = dir.split('/').pop() || 'skill';
   const name = safeName(raw);
   onProgress('loading', name);
   const target = path.join(base, name);
   try {
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    for (const file of files) {
     const normalized = file.name.replace(/\\/g, '/');
     if (!normalized.startsWith(`${dir}/`)) continue;
     const relative = normalized.slice(dir.length + 1);
     if (!relative || relative.includes('..')) continue;
     const destination = path.join(target, relative);
     fs.mkdirSync(path.dirname(destination), { recursive: true });
     fs.writeFileSync(destination, file.data);
    }
    installed.push(name);
    onProgress('loaded', name);
   } catch (error) {
    onProgress('failed', `${name} (${error.message})`);
   }
  }
  return { ok: true, installed, repo: `${repo.owner}/${repo.repo}`, branch };
 }
 return { ok: false, error: lastError };
}

function register(fromApp) {
 ipcMain.handle('skills:install', async (event, url) => {
  if (!fromApp(event) || typeof url !== 'string' || !url.trim()) return { ok: false, error: 'no address' };
  const send = (stage, name) => { try { event.sender.send('skills:progress', { stage, name }); } catch {} };
  try {
   return await install(url.trim(), send);
  } catch (error) {
   return { ok: false, error: String(error?.message || error) };
  }
 });
}

module.exports = { register, install, parseRepo, untar };
