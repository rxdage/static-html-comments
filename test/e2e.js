// Browser end-to-end test: drives a real Chrome / Edge with real mouse and keyboard input (Chrome DevTools Protocol).
//   node test/e2e.js
// No dependencies. Needs Node 22+ (built-in WebSocket) and Chrome, Edge or Chromium; set CHROME_PATH to pick one.
// If either is missing the test says so and exits 0 without running: it is optional, test/selftest.js is the required one.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const tool = path.join(__dirname, '..', 'static-html-comments.js');
// A skipped run proves nothing. Pass --require-browser (CI) to make a missing browser or an old Node a failure instead.
const skip = why => { const must = process.argv.includes('--require-browser'); console.log((must ? 'CANNOT RUN  ' : 'SKIPPED (nothing was tested)  ') + why); process.exit(must ? 2 : 0); };
if (typeof WebSocket !== 'function') skip('this Node has no built-in WebSocket (need Node 22+)');
const candidates = [process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].filter(Boolean);
const browserPath = candidates.find(p => fs.existsSync(p));
if (!browserPath) skip('no Chrome / Edge / Chromium found (set CHROME_PATH)');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shc-e2e-'));
const site = path.join(tmp, 'site'), profile = path.join(tmp, 'profile');
const PORT = 8900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let failed = 0, passed = 0;
const ok = (name, cond, extra) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || extra == null ? '' : '  -> ' + extra}`); cond ? passed++ : failed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const get = url => new Promise((res, rej) => http.get(url, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(b)); }).on('error', rej));
const cli = (...a) => spawnSync(process.execPath, [tool, ...a], { encoding: 'utf8' });
const store = path.join(site, '.page-comments', 'comments.json');
const comments = () => { let raw; try { raw = fs.readFileSync(store, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } return JSON.parse(raw).comments.filter(c => !c.deleted); };   // a file that exists must parse

let srv, chrome, ws;
async function main() {
  fs.cpSync(path.join(__dirname, '..', 'demo'), site, { recursive: true, filter: s => !s.includes('.page-comments') });
  const before = { index: sha(path.join(site, 'index.html')), notes: sha(path.join(site, 'notes.html')) };

  srv = spawn(process.execPath, [tool, site, '--port', String(PORT), '--no-open', '--lang', 'zh'], { stdio: 'ignore' });
  chrome = spawn(browserPath, ['--headless=new', '--remote-debugging-port=0', '--remote-allow-origins=*', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--disable-gpu', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  let dport = 0;
  for (let i = 0; i < 100 && !dport; i++) { await sleep(100); try { dport = +fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch (e) { } }
  if (!dport) throw new Error('browser did not open its debugging port');
  const target = JSON.parse(await get(`http://127.0.0.1:${dport}/json/list`)).find(t => t.type === 'page');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cannot connect to the browser')); });
  let seq = 0; const waiting = new Map();
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { const [res, rej] = waiting.get(d.id); waiting.delete(d.id); d.error ? rej(new Error(d.error.message)) : res(d.result); } };
  const cdp = (method, params) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, [res, rej]); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  const ev = async expr => { const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text); return r.result.value; };
  const until = async (expr, ms) => { const end = Date.now() + (ms || 5000); for (;;) { const v = await ev(expr); if (v) return v; if (Date.now() > end) return v; await sleep(120); } };
  const click = async (x, y) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 }); };
  const key = async (k, code, vk, modifiers) => { for (const type of ['rawKeyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, modifiers: modifiers || 0 }); };
  const altC = () => key('c', 'KeyC', 67, 1);
  const enter = () => key('Enter', 'Enter', 13);
  const UI = "document.getElementById('page-comments-root').shadowRoot";
  const center = sel => ev(`(() => { const e = ${sel}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`);
  const clickEl = async sel => {
    let c = await center(sel); if (!c) throw new Error('element not found: ' + sel);
    if (c.y < 4 || c.y > 860) { await ev(`(${sel}).scrollIntoView({ block: 'center' })`); await sleep(350); c = await center(sel); }   // real clicks only land inside the window
    if (c.right - c.left < 1) throw new Error('element has no size (hidden?): ' + sel);
    await click(c.x, c.y); return c;
  };
  const goto = async url => { await cdp('Page.navigate', { url }); await until("document.readyState === 'complete' && !!window.__pageComments", 8000); await sleep(400); };
  const write = async text => { await until(`${UI}.querySelector('.ed').classList.contains('open')`, 3000); await cdp('Input.insertText', { text }); await enter(); await sleep(700); };
  const visiblePins = () => ev(`[...${UI}.querySelectorAll('.pin')].filter(p => p.style.display === 'block' && p.dataset.id).map(p => ({ id: p.dataset.id, done: p.classList.contains('done'), title: p.title, left: parseFloat(p.style.left), top: parseFloat(p.style.top) }))`);
  await cdp('Page.enable'); await cdp('Runtime.enable');

  // 1. open in comment mode
  await goto(BASE + '/?pc=1');
  ok('the page opens already in comment mode', await ev('__pageComments.on') === true);
  ok('the status shows "saved"', await ev(`${UI}.querySelector('.st').classList.contains('ok')`));

  // 2. click a number, write, Enter -> file
  const KPI = "document.querySelector('.kpis .kpi:nth-of-type(2) b')";
  const at = await clickEl(KPI);
  ok('clicking the page opens the comment box', await until(`${UI}.querySelector('.ed').classList.contains('open')`, 3000));
  await write('要带上周对比');
  let list = comments();
  ok('comments.json appears with one comment', list.length === 1, JSON.stringify(list).slice(0, 200));
  const first = list[0] || {};
  ok('it records the clicked text, the element and the wording', first.ctx === '11.8%' && /b$/.test(first.sel || '') && first.text === '要带上周对比' && first.status === 'open', JSON.stringify(first).slice(0, 240));
  let pins = await visiblePins();
  ok('a numbered pin sits on the clicked spot', pins.length === 1 && Math.abs(pins[0].left - at.x) < 2 && Math.abs(pins[0].top - at.y) < 2, JSON.stringify(pins));

  // 3. the pin follows the element when the page scrolls
  await ev('window.scrollTo(0, 220)'); await sleep(500);
  const moved = await center(KPI); pins = await visiblePins();
  ok('after scrolling, the pin is still on the element', pins.length === 1 && Math.abs(pins[0].left - moved.x) < 2 && Math.abs(pins[0].top - moved.y) < 2, JSON.stringify({ pins, moved }));
  await ev('window.scrollTo(0, 0)'); await sleep(300);

  // 4. the agent side: list, resolve, reply shows up on the page without a reload
  let out = cli('list', site);
  ok('`list` shows the comment with its id', out.status === 0 && out.stdout.includes(first.id) && out.stdout.includes('要带上周对比'));
  out = cli('resolve', site, String(first.id).slice(0, 8), '已加上周对比');
  ok('`resolve` succeeds', out.status === 0, out.stderr);
  const replied = await until(`(() => { const p = ${UI}.querySelector('.pin[data-id="${first.id}"]'); return !!p && p.classList.contains('done') && p.title.includes('已加上周对比'); })()`, 16000);
  ok('within 16 s the pin turns grey and carries the reply, no reload', replied === true);

  // 5. whole-page note
  await clickEl(`${UI}.querySelector('.bar [data-a=page]')`);
  await write('整体再短一点');
  ok('a whole-page note is stored without an element', comments().some(c => c.text === '整体再短一点' && c.sel === null));

  // 6. in comment mode the page's own links do nothing
  await clickEl("document.querySelector('a[href=\"notes.html\"]')");
  await sleep(500);
  ok('clicking a link in comment mode does not navigate', await ev('location.pathname') === '/');
  await key('Escape', 'Escape', 27); await sleep(200);
  ok('Escape closes the comment box without saving', await ev(`!${UI}.querySelector('.ed').classList.contains('open')`) && comments().length === 2);

  // 7. Alt+C toggles; hidden tab content hides its pin
  await altC(); await sleep(200);
  ok('Alt+C leaves comment mode', await ev('__pageComments.on') === false);
  await clickEl("document.querySelector('.tabs button[data-t=b]')"); await sleep(200);
  ok('outside comment mode the page works normally (tab switched)', await ev("document.querySelector('.pane[data-p=b]').classList.contains('on')"));
  await altC(); await sleep(300);
  await clickEl("document.querySelector('.pane[data-p=b] p')");
  await write('这条在第二个标签里');
  const tabC = comments().find(c => c.text === '这条在第二个标签里') || {};
  const pinShown = id => ev(`(() => { const p = ${UI}.querySelector('.pin[data-id="${id}"]'); return !!p && p.style.display === 'block'; })()`);
  ok('the comment on the second tab is anchored to the text of that tab and has a visible pin', /W12-04/.test(tabC.ctx || '') && await pinShown(tabC.id), tabC.ctx);
  await altC(); await sleep(150); await clickEl("document.querySelector('.tabs button[data-t=a]')"); await sleep(150); await altC(); await sleep(600);
  ok('switching to the first tab hides that pin', await pinShown(tabC.id) === false);
  await altC(); await sleep(150); await clickEl("document.querySelector('.tabs button[data-t=b]')"); await sleep(150); await altC(); await sleep(600);
  ok('switching back shows it again', await pinShown(tabC.id) === true);

  // 8. a second page, and jumping to it from the list
  await goto(BASE + '/notes.html?pc=1');
  await clickEl("document.querySelector('.card:nth-of-type(2) h3')");
  await write('第二页上的一条');
  const other = comments().find(c => c.text === '第二页上的一条') || {};
  ok('a comment on another page records that page', other.path === '/notes.html', other.path);
  await goto(BASE + '/?pc=1');
  ok('pins of the other page are not shown here', (await visiblePins()).every(p => p.id !== other.id));
  await clickEl(`${UI}.querySelector('.bar [data-a=list]')`); await sleep(300);
  ok('the list shows all four comments', await ev(`${UI}.querySelectorAll('.list .it').length`) === 4);
  await clickEl(`${UI}.querySelector('.list .it[data-id="${other.id}"]')`);
  await until("location.pathname === '/notes.html' && !!window.__pageComments && __pageComments.on", 8000); await sleep(900);
  ok('clicking it in the list jumps to that page, still in comment mode', await ev('location.pathname') === '/notes.html' && await ev('__pageComments.on') === true);
  ok('...and its pin is visible there', await pinShown(other.id) === true);

  // 9. a damaged comments file is reported, not overwritten
  const good = fs.readFileSync(store), bad = good.subarray(0, Math.floor(good.length / 2));
  fs.writeFileSync(store, bad);
  await altC(); await sleep(150); await altC();   // re-entering comment mode reloads from the server
  const sawDamage = await until(`${UI}.querySelector('.st').textContent === '批注文件损坏'`, 6000);
  ok('the page says the comments file is damaged', sawDamage === true, await ev(`${UI}.querySelector('.st').textContent`));
  await clickEl("document.querySelector('h1')"); await write('文件坏着的时候写的'); await sleep(600);
  ok('...and saving in that state does not touch the file', fs.readFileSync(store).equals(bad));
  fs.writeFileSync(store, good);
  const healed = await until(`${UI}.querySelector('.st').classList.contains('ok')`, 12000);
  ok('once the file is restored the held comment is saved by itself', healed === true && comments().some(c => c.text === '文件坏着的时候写的'));

  // 9b. a different shortcut letter (--key alt+a)
  const KP = PORT + 100;
  const keySrv = spawn(process.execPath, [tool, site, '--port', String(KP), '--no-open', '--lang', 'zh', '--key', 'alt+a'], { stdio: 'ignore' });
  await sleep(900);
  await cdp('Page.navigate', { url: `http://127.0.0.1:${KP}/` }); await until("document.readyState === 'complete' && !!window.__pageComments", 8000); await sleep(400);
  const before2 = await ev('__pageComments.on');
  await altC(); await sleep(250); const afterC = await ev('__pageComments.on');
  await key('a', 'KeyA', 65, 1); await sleep(250); const afterA = await ev('__pageComments.on');
  ok('with --key alt+a, Alt+A toggles comment mode and Alt+C no longer does', afterC === before2 && afterA === !before2, `start ${before2}, after Alt+C ${afterC}, after Alt+A ${afterA}`);
  ok('...and the button on the page shows the new shortcut', await ev(`${UI}.querySelector('.fab small').textContent`) === 'Alt+A');
  if (afterA) { await key('a', 'KeyA', 65, 1); await sleep(150); }
  keySrv.kill();

  // 10. another web site open in the same browser cannot write comments
  const evil = http.createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'text/html' }); s.end('<!doctype html><title>other site</title><body>other</body>'); });
  await new Promise(r => evil.listen(0, '127.0.0.1', r));
  const sizeBefore = comments().length;
  await cdp('Page.navigate', { url: `http://127.0.0.1:${evil.address().port}/` }); await until("document.readyState === 'complete' && document.title === 'other site'", 8000);
  const attack = body => `fetch('${BASE}/__pc__/api/comments', ${body}).then(r => 'status ' + r.status).catch(e => 'blocked: ' + e.message)`;
  const forged = JSON.stringify({ comments: [{ id: 'cforged1', path: '/', text: 'forged from another site', created: '2026-01-01T00:00:00.000Z', updated: '2099-01-01T00:00:00.000Z', status: 'open' }] });
  const a1 = await ev(attack(`{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(forged)} }`));
  const a2 = await ev(attack(`{ method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: ${JSON.stringify(forged)} }`));   // a "simple" request: no preflight, it does reach the server
  const a3 = await ev(attack('{}'));   // and it cannot read the comments either
  await sleep(400);
  ok('a page on another origin cannot write a comment (JSON POST, and a no-preflight text/plain POST)', comments().length === sizeBefore && !comments().some(c => c.id === 'cforged1'), `${a1} | ${a2}`);
  ok('...and cannot read them', /^blocked/.test(a3), a3);
  evil.close();

  // 11. nothing on disk was modified
  ok('index.html and notes.html are byte-for-byte unchanged', sha(path.join(site, 'index.html')) === before.index && sha(path.join(site, 'notes.html')) === before.notes);
  await cdp('Browser.close').catch(() => { });
}

main().catch(e => { ok('no exception', false, e.stack); }).finally(async () => {
  try { ws && ws.close(); } catch (e) { }
  try { srv && srv.kill(); } catch (e) { }
  try { chrome && chrome.kill(); } catch (e) { }
  await sleep(600);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { }
  console.log(failed ? `\n${failed} of ${passed + failed} check(s) failed` : `\nall ${passed} checks passed  (${path.basename(browserPath)})`);
  process.exit(failed ? 1 : 0);
});
