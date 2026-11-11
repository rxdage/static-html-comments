// Self-test for the server and the agent-side commands. No browser needed.
//   node test/selftest.js
// Copies the demo into a temp folder, starts the server there, and checks injection, the comments API,
// merge rules, origin / path guards, and that `resolve` survives a stale browser tab.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync, execFile } = require('child_process');

const tool = path.join(__dirname, '..', 'static-html-comments.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'static-html-comments-test-'));
const PORT = 8799 + Math.floor(Math.random() * 100);
let failed = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : '  -> ' + extra}`); if (!cond) failed++; };

function req(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: Object.assign(body ? { 'Content-Type': 'application/json' } : {}, headers || {}) }, res => {
      const chunks = []; res.on('data', d => chunks.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}
const json = r => JSON.parse(r.buf.toString('utf8'));
const cli = (...a) => spawnSync(process.execPath, [tool, ...a], { encoding: 'utf8' });

(async () => {
  // fixture: demo pages + an HTML fragment + a GBK-encoded page
  fs.cpSync(path.join(__dirname, '..', 'demo'), tmp, { recursive: true, filter: s => !s.includes('.page-comments') });
  fs.writeFileSync(path.join(tmp, 'fragment.html'), '<div class="card">partial loaded by the page itself</div>');
  const gbk = Buffer.concat([Buffer.from('<!doctype html><html><head><meta charset="gbk"><title>'), Buffer.from([0xD6, 0xD0, 0xCE, 0xC4]), Buffer.from('</title></head><body><p>'), Buffer.from([0xB2, 0xE2, 0xCA, 0xD4]), Buffer.from('</p></body></html>')]);
  fs.writeFileSync(path.join(tmp, 'gbk.html'), gbk);
  fs.mkdirSync(path.join(tmp, 'sub')); fs.writeFileSync(path.join(tmp, 'sub', 'a.html'), '<!doctype html><title>a</title><body>a</body>');
  fs.writeFileSync(path.join(tmp, '..', 'shc-outside.txt'), 'outside the served root');

  const srv = spawn(process.execPath, [tool, tmp, '--port', String(PORT), '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  for (let i = 0; i < 50 && !/static-html-comments\s+http/.test(log); i++) await new Promise(r => setTimeout(r, 100));
  ok('server starts and prints its URL', /static-html-comments\s+http:\/\/127\.0\.0\.1:/.test(log), log);

  try {
    let r = await req('GET', '/');
    const html = r.buf.toString('utf8');
    ok('index.html is served', r.status === 200 && html.includes('<h1>'));
    ok('comment layer injected exactly once, before </body>', html.split('/__pc__/client.js').length === 2 && /<script src="\/__pc__\/client\.js"><\/script>\s*<\/body>/.test(html));
    ok('file on disk is untouched', !fs.readFileSync(path.join(tmp, 'index.html'), 'utf8').includes('__pc__'));
    ok('responses are not cached', r.headers['cache-control'] === 'no-store');

    r = await req('GET', '/fragment.html');
    ok('HTML fragment is left alone', r.buf.toString('utf8') === '<div class="card">partial loaded by the page itself</div>');

    r = await req('GET', '/gbk.html');
    ok('non-UTF-8 page keeps its bytes and gets no charset forced', r.buf.includes(Buffer.from([0xB2, 0xE2, 0xCA, 0xD4])) && r.buf.includes(Buffer.from('__pc__/client.js')) && !/charset/i.test(r.headers['content-type']));

    r = await req('GET', '/__pc__/client.js');
    ok('client script is served', r.status === 200 && r.buf.toString('utf8').includes('__pageComments'));

    r = await req('GET', '/sub/');
    ok('folder without index.html gets a listing', r.status === 200 && r.buf.toString('utf8').includes('a.html') && !r.buf.toString('utf8').includes('__pc__'));

    r = await req('GET', '/..%2Fshc-outside.txt');
    ok('path traversal is refused', r.status === 403 || r.status === 404, 'status ' + r.status);

    r = await req('GET', '/__pc__/api/comments');
    ok('API starts empty', r.status === 200 && json(r).comments.length === 0);

    const t0 = '2026-01-01T00:00:00.000Z', t1 = '2026-01-01T00:00:01.000Z';
    const c1 = { id: 'caaa111', path: '/', hash: '', title: 'demo', sel: 'body > main > h1', tag: 'h1', rx: 0.1, ry: 0.5, ctx: 'heading', text: 'make this shorter', vw: 1280, vh: 800, status: 'open', reply: '', created: t0, updated: t0 };
    const c2 = Object.assign({}, c1, { id: 'cbbb222', sel: null, text: 'whole-page note', created: t1, updated: t1 });
    r = await req('POST', '/__pc__/api/comments', JSON.stringify({ comments: [c1, c2] }));
    ok('POST stores comments', r.status === 200 && json(r).comments.length === 2);
    const store = path.join(tmp, '.page-comments');
    ok('comments.json and comments.md are written', fs.existsSync(path.join(store, 'comments.json')) && fs.readFileSync(path.join(store, 'comments.md'), 'utf8').includes('make this shorter'));

    r = await req('POST', '/__pc__/api/comments', JSON.stringify({ comments: [] }), { Origin: 'http://evil.example' });
    ok('POST from another origin is refused', r.status === 403);
    r = await req('POST', '/__pc__/api/comments', JSON.stringify({ comments: [] }), { Origin: 'https://127.0.0.1:' + PORT });
    ok('...and so is the same address over https, or on another port', r.status === 403 && (await req('POST', '/__pc__/api/comments', JSON.stringify({ comments: [] }), { Origin: 'http://127.0.0.1:' + (PORT + 1) })).status === 403);
    r = await req('POST', '/__pc__/api/comments', JSON.stringify({ comments: [] }), { Origin: 'http://localhost:' + PORT });
    ok('POST from this server\'s own origin is accepted', r.status === 200, 'status ' + r.status);
    r = await req('POST', '/__pc__/api/comments', '{not json');
    ok('bad JSON is refused', r.status === 400);

    let out = cli('list', tmp);
    ok('`list` prints open comments with ids and selectors', out.status === 0 && out.stdout.includes('`caaa111`') && out.stdout.includes('body > main > h1'));
    out = cli('resolve', tmp, 'caaa', 'shortened to one line');
    ok('`resolve` accepts an id prefix', out.status === 0 && /resolved caaa111/.test(out.stdout), out.stderr);
    const disk = JSON.parse(fs.readFileSync(path.join(store, 'comments.json'), 'utf8')).comments.find(c => c.id === 'caaa111');
    ok('`resolve` sets status, reply and a newer timestamp', disk.status === 'done' && disk.reply === 'shortened to one line' && disk.updated > t0);

    // a browser tab that still holds the old copy posts it back: the reply must survive
    r = await req('POST', '/__pc__/api/comments', JSON.stringify({ comments: [c1, c2] }));
    const back = json(r).comments.find(c => c.id === 'caaa111');
    ok('a stale browser copy cannot overwrite the reply', back.status === 'done' && back.reply === 'shortened to one line');

    // the user edits a comment later: the newer timestamp wins
    const c2b = Object.assign({}, c2, { text: 'whole-page note, edited', updated: new Date(Date.now() + 1000).toISOString() });
    r = await req('POST', '/__pc__/api/comments', JSON.stringify({ comments: [c2b] }));
    ok('a newer edit from the browser wins', json(r).comments.find(c => c.id === 'cbbb222').text === 'whole-page note, edited');

    const del = Object.assign({}, c2b, { deleted: true, updated: new Date(Date.now() + 2000).toISOString() });
    await req('POST', '/__pc__/api/comments', JSON.stringify({ comments: [del] }));
    out = cli('list', tmp, '--all');
    ok('deleted comments disappear from `list`', !out.stdout.includes('cbbb222') && out.stdout.includes('[x] `caaa111`'));

    out = cli('reopen', tmp, 'caaa111');
    ok('`reopen` works', out.status === 0 && cli('list', tmp).stdout.includes('[ ] `caaa111`'));
    out = cli('resolve', tmp, 'nope', 'x');
    ok('unknown id fails with a non-zero exit code', out.status !== 0);

    // --- things a local file server must not do ---
    fs.writeFileSync(path.join(tmp, '.env'), 'API_KEY=super-secret');
    fs.mkdirSync(path.join(tmp, '.git')); fs.writeFileSync(path.join(tmp, '.git', 'config'), '[core]');
    r = await req('GET', '/.env');
    ok('dotfiles are not served (/.env)', r.status === 404 && !r.buf.includes(Buffer.from('super-secret')), 'status ' + r.status);
    r = await req('GET', '/.git/config');
    ok('dot-directories are not served (/.git/config)', r.status === 404, 'status ' + r.status);
    r = await req('GET', '/.page-comments/comments.json');
    ok('the comments folder itself is not served as a static file', r.status === 404, 'status ' + r.status);
    fs.mkdirSync(path.join(tmp, '.secrets')); fs.writeFileSync(path.join(tmp, '.secrets', 'secret.txt'), 'deep-secret');
    fs.mkdirSync(path.join(tmp, 'pub')); fs.writeFileSync(path.join(tmp, 'pub', 'ok.txt'), 'public');
    const leaked = x => x.buf.includes(Buffer.from('super-secret')) || x.buf.includes(Buffer.from('deep-secret')) || x.buf.includes(Buffer.from('[core]')) || x.buf.includes(Buffer.from('outside the served root'));
    const spellings = ['/x%5C..%5C.env', '/x%5c..%5c.env', '/x%5C..%5C.git%5Cconfig', '/x%5C..%5C.secrets%5Csecret.txt', '/pub%5C..%5C.env', '/%5C.env', '/pub/..%5C.env', '/pub/%2e%2e/.env',
      '/.ENV', '/.env.', '/.env%20', '/.env::$DATA', '/%2Eenv', '/pub/..%5C..%5Cshc-outside.txt', '/x%5C..%5C..%5Cshc-outside.txt'];
    const got = []; for (const sp of spellings) { const x = await req('GET', sp); if (x.status === 200 || leaked(x)) got.push(sp + ' -> ' + x.status); }
    ok(`${spellings.length} ways of spelling a hidden or outside path (backslashes, case, trailing dot, data stream) all fail`, got.length === 0, got.join('; '));
    r = await req('GET', '/index.html::$DATA');
    ok('a colon in the path (Windows alternate data stream) is refused', r.status === 404, 'status ' + r.status);
    r = await req('GET', '/pub%5Cok.txt');
    ok('a backslash is never treated as a path separator', r.status === 404, 'status ' + r.status);
    r = await req('GET', '/pub/ok.txt');
    ok('an ordinary file in a subfolder is still served', r.status === 200 && r.buf.toString() === 'public');
    // links: a harmless-looking name that leads into a hidden folder, or out of the served folder
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shc-linkout-')); fs.writeFileSync(path.join(outsideDir, 'o.txt'), 'outside the served root');
    let linksOk = true;
    try { fs.symlinkSync(path.join(tmp, '.secrets'), path.join(tmp, 'leakdir'), 'junction'); fs.symlinkSync(outsideDir, path.join(tmp, 'outlink'), 'junction'); } catch (e) { linksOk = false; }
    if (linksOk) {
      r = await req('GET', '/leakdir/secret.txt');
      ok('a link to a hidden folder does not expose it', r.status === 404 && !leaked(r), 'status ' + r.status);
      r = await req('GET', '/leakdir/');
      ok('...nor does its folder listing', r.status === 404, 'status ' + r.status);
      r = await req('GET', '/outlink/o.txt');
      ok('a link out of the served folder is refused', r.status === 403 && !leaked(r), 'status ' + r.status);
      r = await req('GET', '/sub/');
      fs.symlinkSync(path.join(tmp, '.secrets'), path.join(tmp, 'sub', 'peek'), 'junction');
      r = await req('GET', '/sub/');
      ok('folder listings do not advertise such links', r.status === 200 && !r.buf.toString().includes('peek'));
    } else console.log('SKIP  link tests: this system would not create a directory link');
    try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch (e) { }
    r = await req('GET', '/', null, { Host: 'evil.example' });
    ok('requests for another host name are refused (DNS rebinding)', r.status === 403, 'status ' + r.status);
    r = await req('GET', '/__pc__/api/comments', null, { Host: 'evil.example:' + PORT });
    ok('...including the comments API', r.status === 403, 'status ' + r.status);
    r = await req('GET', '/', null, { Host: '127.0.0.1:' + PORT + '.evil.example' });
    ok('...and a look-alike host name', r.status === 403, 'status ' + r.status);
    r = await req('GET', '/', null, { Host: 'localhost:' + PORT });
    ok('localhost is accepted as well as 127.0.0.1', r.status === 200, 'status ' + r.status);
    r = await req('GET', '/favicon.ico');
    ok('a missing favicon is answered quietly', r.status === 204, 'status ' + r.status);
    ok('the comments folder ignores itself in git', fs.readFileSync(path.join(store, '.gitignore'), 'utf8').trim() === '*');
    ok('no temp files are left behind', fs.readdirSync(store).filter(n => n.endsWith('.tmp')).length === 0, fs.readdirSync(store).join(' '));
    out = cli('list', tmp, '--out', 'elsewhere');
    ok('the removed --out option is rejected instead of silently reading nothing', out.status !== 0 && /unknown option --out/.test(out.stderr));
    out = cli('--help');
    ok('--help prints usage only', out.status === 0 && out.stdout.includes('resolve <dir>') && !out.stdout.includes('use strict'));

    // --- two writers at once: the agent resolving while the browser saves ---
    const stamp = () => new Date().toISOString();
    const batch = Array.from({ length: 8 }, (_, i) => Object.assign({}, c1, { id: 'cpar' + i + 'xx', text: 'parallel ' + i, status: 'open', reply: '', created: stamp(), updated: stamp() }));
    await req('POST', '/__pc__/api/comments', JSON.stringify({ comments: batch }));
    const runs = batch.map((b, i) => new Promise(res => execFile(process.execPath, [tool, 'resolve', tmp, b.id, 'reply ' + i], (err, so, se) => res({ code: err ? err.code : 0, se }))));
    const posts = Array.from({ length: 8 }, (_, i) => req('POST', '/__pc__/api/comments', JSON.stringify({ comments: [Object.assign({}, c1, { id: 'cweb' + i + 'xx', text: 'from browser ' + i, status: 'open', reply: '', created: stamp(), updated: stamp() })] })));
    const done = await Promise.all(runs); const posted = await Promise.all(posts);
    const final = JSON.parse(fs.readFileSync(path.join(store, 'comments.json'), 'utf8')).comments;
    ok('8 resolves and 8 browser saves at the same time: every command succeeded', done.every(d => d.code === 0) && posted.every(p => p.status === 200), JSON.stringify(done.filter(d => d.code)) + posted.map(p => p.status).join(','));
    ok('...and none of the 16 changes was lost', batch.every((b, i) => { const c = final.find(x => x.id === b.id); return c && c.status === 'done' && c.reply === 'reply ' + i; }) && Array.from({ length: 8 }, (_, i) => final.some(x => x.id === 'cweb' + i + 'xx')).every(Boolean));
    const lock = path.join(store, 'comments.lock');
    ok('the lock file is gone afterwards', !fs.existsSync(lock));
    fs.writeFileSync(lock, '');
    const tLock = Date.now(); out = cli('resolve', tmp, 'cpar0', 'while locked');
    ok('a held lock makes `resolve` wait, then fail cleanly instead of writing', out.status === 1 && /busy/.test(out.stderr) && Date.now() - tLock >= 2500, 'exit ' + out.status + ' after ' + (Date.now() - tLock) + ' ms');
    r = await req('POST', '/__pc__/api/comments', JSON.stringify({ comments: [Object.assign({}, c1, { id: 'cbusy1x', updated: stamp() })] }));
    ok('...and the server answers 503 (the page retries) rather than calling the file damaged', r.status === 503 && json(r).error === 'busy', 'status ' + r.status);
    const old = new Date(Date.now() - 60000); fs.utimesSync(lock, old, old);
    out = cli('resolve', tmp, 'cpar0', 'after stale lock');
    ok('a lock left behind by a crashed writer is taken over', out.status === 0 && !fs.existsSync(lock), out.stderr);
    fs.writeFileSync(lock, process.pid + ':live'); fs.utimesSync(lock, old, old);   // 60 s old, but its holder (this test) is alive
    out = cli('resolve', tmp, 'cpar1', 'holder still alive');
    ok('an old lock whose holder is still running is NOT taken over', out.status === 1 && /busy/.test(out.stderr) && fs.readFileSync(lock, 'utf8') === process.pid + ':live', 'exit ' + out.status);
    const veryOld = new Date(Date.now() - 200000); fs.utimesSync(lock, veryOld, veryOld);
    out = cli('resolve', tmp, 'cpar1', 'after two minutes');
    ok('...unless it is over two minutes old (the pid may have been reused)', out.status === 0 && !fs.existsSync(lock), out.stderr);
    fs.writeFileSync(lock, '999999:dead'); fs.utimesSync(lock, old, old);
    out = cli('resolve', tmp, 'cpar2', 'holder gone');
    ok('an old lock whose holder is gone is taken over', out.status === 0 && !fs.existsSync(lock), out.stderr);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'shc-empty-')); fs.writeFileSync(path.join(empty, 'index.html'), '<!doctype html><body>x</body>');
    out = cli('resolve', empty, 'c1', 'x');
    ok('`resolve` on a folder with no comments fails without creating anything', out.status === 1 && !fs.existsSync(path.join(empty, '.page-comments')));
    fs.rmSync(empty, { recursive: true, force: true });

    // --- a damaged comments file must stay exactly as it is ---
    const jsonFile = path.join(store, 'comments.json');
    const good = fs.readFileSync(jsonFile);
    ok('the previous good copy is kept as comments.json.bak', fs.existsSync(jsonFile + '.bak') && JSON.parse(fs.readFileSync(jsonFile + '.bak', 'utf8')).comments.length > 0);
    const damaged = good.subarray(0, Math.floor(good.length * 0.6));   // truncated mid-file, as after a crash or a bad manual edit
    fs.writeFileSync(jsonFile, damaged);
    r = await req('GET', '/__pc__/api/comments');
    ok('damaged file: the API reports an error instead of "no comments"', r.status === 500 && json(r).error === 'corrupt', 'status ' + r.status);
    r = await req('POST', '/__pc__/api/comments', JSON.stringify({ comments: [Object.assign({}, c1, { id: 'cnew999', updated: new Date().toISOString() })] }));
    ok('damaged file: saving is refused', r.status === 500, 'status ' + r.status);
    ok('damaged file: not a single byte was changed by the server', fs.readFileSync(jsonFile).equals(damaged));
    out = cli('list', tmp);
    ok('damaged file: `list` fails loudly (exit 2) instead of printing "open: 0"', out.status === 2 && /damaged/.test(out.stderr) && !/open: 0/.test(out.stdout), 'exit ' + out.status);
    out = cli('resolve', tmp, 'caaa111', 'x');
    ok('damaged file: `resolve` fails and leaves the file alone', out.status === 2 && fs.readFileSync(jsonFile).equals(damaged));
    r = await req('GET', '/');
    ok('damaged file: the page itself still opens', r.status === 200);
    fs.copyFileSync(jsonFile + '.bak', jsonFile);
    r = await req('GET', '/__pc__/api/comments');
    ok('restoring the .bak brings the comments back', r.status === 200 && json(r).comments.some(c => c.id === 'caaa111'));
    // an empty file is damage too: the tool never writes one, so it can only come from a crash or a bad edit
    const bakGood = fs.readFileSync(jsonFile + '.bak');
    for (const [label, content] of [['0 bytes', ''], ['whitespace only', ' \n\t\n'], ['a lone BOM', '\uFEFF']]) {
      fs.writeFileSync(jsonFile, content);
      const snapshot = fs.readFileSync(jsonFile);
      r = await req('POST', '/__pc__/api/comments', JSON.stringify({ comments: [Object.assign({}, c1, { id: 'cempty1', updated: new Date().toISOString() })] }));
      out = cli('list', tmp);
      ok(`empty file (${label}): saving is refused, \`list\` exits 2, file and .bak are untouched`,
        r.status === 500 && out.status === 2 && fs.readFileSync(jsonFile).equals(snapshot) && fs.readFileSync(jsonFile + '.bak').equals(bakGood), `POST ${r.status}, list exit ${out.status}, .bak ${fs.statSync(jsonFile + '.bak').size} bytes`);
    }
    fs.copyFileSync(jsonFile + '.bak', jsonFile);
    fs.rmSync(jsonFile);
    r = await req('GET', '/__pc__/api/comments');
    ok('a missing file (not an empty one) is what "no comments yet" looks like', r.status === 200 && json(r).comments.length === 0);
    fs.copyFileSync(jsonFile + '.bak', jsonFile);
  } catch (e) { ok('no exception', false, e.stack); }
  finally {
    srv.kill();
    try { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(path.join(tmp, '..', 'shc-outside.txt'), { force: true }); } catch (e) { }
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})();
