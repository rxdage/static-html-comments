#!/usr/bin/env node
// static-html-comments: comment on a local web page while you look at it; the comments land in a file an agent can read.
// No dependencies. Node 16+.
//
//   node static-html-comments.js <dir | file.html> [--port 8790] [--no-open] [--lang zh|en] [--key alt+c]
//   node static-html-comments.js list    <dir> [--all] [--json]
//   node static-html-comments.js resolve <dir> <id> "<reply>"
//   node static-html-comments.js reopen  <dir> <id>
//
// The served pages are never modified: the comment layer is injected into the HTML response on the fly.
// Comments are stored in <dir>/.page-comments/comments.json (+ comments.md, a readable digest).
// The server listens on 127.0.0.1 only and never serves dotfiles.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const argv = process.argv.slice(2);
const flags = {}, pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--no-open') flags.noOpen = true;
  else if (a === '--all') flags.all = true;
  else if (a === '--json') flags.json = true;
  else if (a === '--port' || a === '--lang' || a === '--key') flags[a.slice(2)] = argv[++i];
  else if (a === '-h' || a === '--help') flags.help = true;
  else if (a.startsWith('--')) { console.error('unknown option ' + a + ' (see --help)'); process.exit(1); }
  else pos.push(a);
}
const CMDS = ['serve', 'list', 'resolve', 'reopen'];
const cmd = CMDS.includes(pos[0]) ? pos.shift() : 'serve';
if (flags.help) {
  const lines = fs.readFileSync(__filename, 'utf8').split('\n').slice(1);
  console.log(lines.slice(0, lines.findIndex(l => !l.startsWith('//'))).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

let target = path.resolve(pos[0] || '.');
let entry = '';
if (!fs.existsSync(target)) { console.error('not found: ' + target); process.exit(1); }
if (fs.statSync(target).isFile()) { entry = path.basename(target); target = path.dirname(target); }
const root = target;
const store = path.join(root, '.page-comments');
const file = path.join(store, 'comments.json');
const digest = path.join(store, 'comments.md');
const nowIso = () => new Date().toISOString();

/* ---------- storage ---------- */
// A missing file means "no comments yet". A file that exists but is empty or cannot be parsed is an error: we stop and say so,
// and nothing is written until a human has looked at it. (Treating it as empty would let the next save wipe it.)
function read() {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  let list;
  try { if (!raw.trim()) throw new Error('the file is empty'); const j = JSON.parse(raw); list = Array.isArray(j) ? j : j && j.comments; if (!Array.isArray(list)) throw new Error('no "comments" array'); }
  catch (e) {
    const err = new Error(`comments file is damaged and was left untouched: ${file}\n  ${e.message}\n  Repair it, restore ${path.basename(file)}.bak, or move it aside to start fresh.`);
    err.code = 'ECORRUPT'; throw err;
  }
  return list;
}
function readOrExit() { try { return read(); } catch (e) { console.error(e.message); process.exit(e.code === 'ECORRUPT' ? 2 : 1); } }
// Same id: the newer `updated` wins; on a tie the copy already on disk stays.
function merge(base, incoming) {
  const m = new Map();
  base.concat(incoming).forEach(c => { if (!c || typeof c.id !== 'string') return; const o = m.get(c.id); if (!o || (c.updated || '') > (o.updated || '')) m.set(c.id, c); });
  return Array.from(m.values()).sort((a, b) => (a.created || '').localeCompare(b.created || ''));
}
const dec = s => { try { return decodeURIComponent(s); } catch (e) { return s; } };
function groups(list) {
  const g = new Map();
  list.forEach(c => { const k = (c.path || '/') + (c.hash || ''); if (!g.has(k)) g.set(k, []); g.get(k).push(c); });
  return g;
}
function toMarkdown(list, withIds) {
  const liveAll = list.filter(c => !c.deleted), open = liveAll.filter(c => c.status !== 'done');
  let t = `# Page comments\n\nroot: ${root}\nopen: ${open.length}, resolved: ${liveAll.length - open.length}\n`;
  if (!withIds) t += `generated from comments.json on ${nowIso()} - do not edit; use \`static-html-comments.js resolve\` to reply\n`;
  groups(withIds ? (flags.all ? liveAll : open) : liveAll).forEach((cs, k) => {
    t += `\n## ${dec(k)}${cs[0].title ? '  (' + cs[0].title + ')' : ''}\n\n`;
    cs.forEach(c => {
      t += `- [${c.status === 'done' ? 'x' : ' '}] ${withIds ? '`' + c.id + '` ' : ''}${String(c.text || '').replace(/\n/g, ' / ')}\n`;
      t += c.sel ? `  - on: ${c.ctx ? '"' + c.ctx + '"  ' : ''}\`${c.sel}\`  (at ${Math.round((c.rx || 0) * 100)}%, ${Math.round((c.ry || 0) * 100)}% of the element; viewport ${c.vw}x${c.vh})\n` : '  - on: whole page\n';
      if (c.reply) t += `  - reply: ${String(c.reply).replace(/\n/g, ' / ')}\n`;
    });
  });
  return t;
}
// One writer at a time. The browser's save and the agent's `resolve` both do read -> change -> write; without a lock,
// two of them overlapping would silently drop one change. The lock is a file created exclusively that names its holder.
// It is taken over only if it is older than 10 s AND that process is gone (or older than 2 min whatever the pid says,
// in case the pid was reused). A writer only ever removes its own lock.
const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function withLock(fn) {
  fs.mkdirSync(store, { recursive: true });
  const lock = path.join(store, 'comments.lock');
  const me = process.pid + ':' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const giveUp = Date.now() + 3000;
  for (;;) {
    try { fs.writeFileSync(lock, me, { flag: 'wx' }); break; }
    catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM') throw e;   // EPERM: Windows, while another process is deleting it
      let age = 0, holder = '';
      try { age = Date.now() - fs.statSync(lock).mtimeMs; holder = fs.readFileSync(lock, 'utf8'); } catch (e2) { continue; }   // gone already: try again
      if (age > 120000 || (age > 10000 && !alive(parseInt(holder, 10)))) { try { fs.unlinkSync(lock); } catch (e2) { } continue; }
      if (Date.now() > giveUp) { const err = new Error('comments file is busy, try again: ' + lock); err.code = 'EBUSY'; throw err; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return fn(); } finally { try { if (fs.readFileSync(lock, 'utf8') === me) fs.unlinkSync(lock); } catch (e) { } }
}
function write(list) {
  fs.mkdirSync(store, { recursive: true });
  const ignore = path.join(store, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');   // comments stay out of version control unless you remove this file
  try { if (fs.statSync(file).size > 0) fs.copyFileSync(file, file + '.bak'); } catch (e) { }   // previous good copy: callers have just read and parsed it
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;   // unique, so two writers never share a temp file
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, comments: list }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  fs.writeFileSync(digest, toMarkdown(list, false), 'utf8');
}
function pick(list, id) {
  const hit = list.filter(c => !c.deleted && c.id.indexOf(id) === 0);
  if (hit.length !== 1) throw new Error(hit.length ? `id "${id}" matches ${hit.length} comments, give more characters` : `no comment with id "${id}"`);
  return hit[0];
}

/* ---------- agent-side commands ---------- */
if (cmd === 'list') {
  const list = readOrExit();
  if (flags.json) console.log(JSON.stringify(list.filter(c => !c.deleted && (flags.all || c.status !== 'done')), null, 2));
  else console.log(toMarkdown(list, true));
  process.exit(0);
}
if (cmd === 'resolve' || cmd === 'reopen') {
  if (!fs.existsSync(file)) { console.error('no comments yet: ' + file + ' does not exist'); process.exit(1); }
  let c;
  try {
    withLock(() => {
      const list = read(); c = pick(list, pos[1] || '');
      if (cmd === 'resolve') { c.status = 'done'; if (pos[2] != null) c.reply = String(pos[2]); } else c.status = 'open';
      c.updated = nowIso();   // must move forward, or an open browser tab would overwrite this change with its older copy
      write(list);
    });
  } catch (e) { console.error(e.message); process.exit(e.code === 'ECORRUPT' ? 2 : 1); }
  console.log(`${cmd === 'resolve' ? 'resolved' : 'reopened'} ${c.id}: ${String(c.text).replace(/\n/g, ' / ').slice(0, 60)}`);
  process.exit(0);
}

/* ---------- server ---------- */
const MIME = { '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.xml': 'application/xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.map': 'application/json' };
const PREFIX = '/__pc__/';
const realNative = fs.realpathSync.native || fs.realpathSync;   // native: also expands Windows 8.3 short names
const REAL_ROOT = realNative(root);
// Where a path really leads once links, junctions and short names are resolved.
// null = missing or inside a hidden file / folder; { outside: true } = leads out of the served folder.
function resolveInside(abs) {
  let real; try { real = realNative(abs); } catch (e) { return null; }
  const rel = path.relative(REAL_ROOT, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { outside: true };
  if (rel.split(/[\\/]+/).some(seg => seg.startsWith('.'))) return null;
  return { real };
}
const ROOT_ID = require('crypto').createHash('sha1').update(store).digest('hex').slice(0, 12);   // lets the page tell two sites on the same port apart
const lang = flags.lang ? ` data-lang="${String(flags.lang).replace(/[^a-zA-Z-]/g, '')}"` : '';
// --key alt+a: which letter toggles comment mode together with Alt (default c), for pages or browsers where Alt+C is taken
const keyArg = String(flags.key == null ? 'alt+c' : flags.key).toLowerCase().replace(/\s+/g, '');
const keyMatch = /^(?:alt\+)?([a-z])$/.exec(keyArg);
if (!keyMatch) { console.error('--key takes Alt plus one letter, for example: --key alt+a'); process.exit(1); }
const KEY = keyMatch[1];
const TAG = Buffer.from(`<script src="${PREFIX}client.js"${lang}${KEY === 'c' ? '' : ` data-key="${KEY}"`}></script>`);
let port = +(flags.port || 8790);

function send(res, code, body, type) { res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); }
// Only answer requests addressed to this machine by its loopback name. Without this, a web page on another site could
// point a hostname of its own at 127.0.0.1 (DNS rebinding) and read the served folder through the visitor's browser.
function localHost(req) {
  const h = String(req.headers.host || '').toLowerCase();
  return h === '127.0.0.1:' + port || h === 'localhost:' + port || (port === 80 && (h === '127.0.0.1' || h === 'localhost'));
}
const hidden = p => p.split(/[\\/]+/).some(seg => seg.startsWith('.') && seg !== '.' && seg !== '..');   // .env, .git/, .page-comments/ ...
function sameOrigin(req) {
  const o = req.headers.origin; if (!o) return true;
  try {
    const u = new URL(o);
    const oport = u.port ? +u.port : (u.protocol === 'https:' ? 443 : 80);   // browsers omit a default port
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && oport === port;
  } catch (e) { return false; }
}
// Insert the script tag before </body>. Works on bytes, so the page keeps whatever encoding it declares.
function inject(buf) {
  const s = buf.toString('latin1').toLowerCase();
  const i = s.lastIndexOf('</body>');
  if (i >= 0) return Buffer.concat([buf.subarray(0, i), TAG, buf.subarray(i)]);
  if (s.indexOf('<html') >= 0 || s.indexOf('<!doctype') >= 0) return Buffer.concat([buf, TAG]);
  return buf;   // an HTML fragment loaded by the page itself: leave it alone
}
function listing(dirAbs, urlPath) {
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ents = fs.readdirSync(dirAbs, { withFileTypes: true }).filter(e => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink() || /\.html?$/i.test(e.name)))
    .filter(e => { const at = resolveInside(path.join(dirAbs, e.name)); return at && !at.outside; })   // do not advertise links we will not follow
    .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
  const isDir = e => { try { return fs.statSync(path.join(dirAbs, e.name)).isDirectory(); } catch (x) { return false; } };
  const li = ents.filter(e => isDir(e) || /\.html?$/i.test(e.name)).map(e => `<li><a href="${encodeURIComponent(e.name)}${isDir(e) ? '/' : ''}">${esc(e.name)}${isDir(e) ? '/' : ''}</a></li>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>${esc(urlPath)}</title><body style="font:15px/1.9 system-ui,sans-serif;margin:40px;max-width:720px">` +
    `<h3 style="font-weight:600">${esc(dec(urlPath))}</h3><ul>${urlPath !== '/' ? '<li><a href="../">../</a></li>' : ''}${li || '<li>(no .html files here)</li>'}</ul></body>`;
}

const server = http.createServer((req, res) => {
  if (!localHost(req)) return send(res, 403, 'forbidden');
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { return send(res, 400, 'bad request'); }
  if (p === PREFIX + 'client.js') return fs.readFile(path.join(__dirname, 'client.js'), (e, b) => e ? send(res, 500, 'client.js missing') : send(res, 200, b, MIME['.js']));
  if (p === PREFIX + 'api/comments') {
    const broken = e => send(res, e.code === 'ECORRUPT' ? 500 : 503, JSON.stringify({ error: e.code === 'ECORRUPT' ? 'corrupt' : 'busy', message: e.message }), MIME['.json']);
    if (req.method === 'GET') { try { return send(res, 200, JSON.stringify({ root: ROOT_ID, comments: read() }), MIME['.json']); } catch (e) { return broken(e); } }
    if (req.method !== 'POST') return send(res, 405, 'method not allowed');
    if (!sameOrigin(req)) return send(res, 403, 'forbidden');
    let body = '', big = false;
    req.on('data', d => { body += d; if (body.length > 8e6) { big = true; send(res, 413, 'too large'); req.destroy(); } });
    req.on('end', () => {
      if (big) return;
      let inc, merged;
      try { inc = JSON.parse(body).comments; if (!Array.isArray(inc)) throw new Error('comments'); } catch (e) { return send(res, 400, 'bad json'); }
      try { merged = withLock(() => { const m = merge(read(), inc); write(m); return m; }); } catch (e) { return broken(e); }   // damaged file: report it, write nothing
      send(res, 200, JSON.stringify({ root: ROOT_ID, comments: merged }), MIME['.json']);
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
  // A backslash is a path separator on Windows and a colon opens alternate data streams there; a static site's URLs need neither.
  if (/[\\:\0]/.test(p) || hidden(p)) return send(res, 404, 'not found');
  let f = path.normalize(path.join(root, p));
  if (f !== root && !f.startsWith(root + path.sep)) return send(res, 403, 'forbidden');
  fs.stat(f, (err, st) => {
    if (err) { if (p === '/favicon.ico') { res.writeHead(204); return res.end(); } return send(res, 404, 'not found'); }
    const deny = at => send(res, at ? 403 : 404, at ? 'forbidden' : 'not found');
    let at = resolveInside(f);
    if (!at || at.outside) return deny(at);
    if (st.isDirectory()) {
      if (!p.endsWith('/')) { res.writeHead(302, { Location: encodeURI(p) + '/' }); return res.end(); }
      const idx = ['index.html', 'index.htm'].map(n => path.join(f, n)).find(x => fs.existsSync(x));
      if (!idx) return send(res, 200, listing(f, p), 'text/html; charset=utf-8');
      at = resolveInside(idx);   // the index file may itself be a link
      if (!at || at.outside) return deny(at);
      f = idx;
    }
    fs.readFile(at.real, (e2, buf) => {
      if (e2) return send(res, 404, 'not found');
      const ext = path.extname(f).toLowerCase();
      if (ext === '.html' || ext === '.htm') buf = inject(buf);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  });
});

let tries = 0;
server.on('error', e => {
  if (e.code === 'EADDRINUSE' && !flags.port && tries++ < 20) { port++; return server.listen(port, '127.0.0.1'); }
  console.error(e.code === 'EADDRINUSE' ? `port ${port} is in use` : e.message); process.exit(1);
});
server.on('listening', () => {
  const url = `http://127.0.0.1:${port}/${entry ? encodeURIComponent(entry) : ''}?pc=1`;
  console.log(`static-html-comments  ${url}`);
  console.log(`serving               ${root}`);
  console.log(`comments file         ${file}`);
  try { read(); } catch (e) { console.error('\nWARNING: ' + e.message + '\nThe page will open, but comments cannot be loaded or saved until this is fixed.\n'); }
  console.log(`Alt+${KEY.toUpperCase()} toggles comment mode. Ctrl+C here (or close this window) to stop.`);
  if (!flags.noOpen) exec(process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`, () => { });
});
server.listen(port, '127.0.0.1');
