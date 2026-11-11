/* static-html-comments client
   Injected by static-html-comments.js into every HTML page it serves; the page's own files are never modified.
   Click anywhere on the page to pin a comment. Comments are anchored to the clicked element
   (CSS path + relative offset), stored by the local server in <root>/.page-comments/comments.json. */
(function () {
  if (window.__pageComments) return;
  const script = document.currentScript;
  const BASE = script && script.src ? new URL('.', script.src).pathname : '/__pc__/';
  const API = BASE + 'api/comments';
  const lang = ((script && script.dataset.lang) || navigator.language || 'en').toLowerCase();
  const ZH = lang.indexOf('zh') === 0;
  const T = ZH ? {
    fab: '批注', mode: '批注中 · 点哪批哪', here: '本页', all: '全部', open: '条未处理', page: '整页意见', list: '列表', copy: '复制全部', exit: '退出',
    saved: '已存盘', unsaved: '未连接', broken: '批注文件损坏', brokenTip: '.page-comments/comments.json 读不出来，服务没有动它。修好、用旁边的 .bak 恢复、或者把它挪走之后会自动恢复；这期间新写的批注暂存在这个浏览器里', savedTip: '每条批注都自动存进 .page-comments/comments.json', unsavedTip: '连不上本地服务。这期间新写的批注暂存在这个浏览器里，服务恢复后会自动补存',
    ph: '这里想怎么改？回车保存，Shift+回车换行', save: '保存', cancel: '取消', del: '删除', done: '标为已处理', reopen: '重新打开',
    listTitle: '全部批注', clear: '清掉已处理的', fold: '收起', empty: '还没有批注。点页面上想改的地方，写一句话，回车。',
    whole: '整页', blank: '空白处', at: '批在', lost: '原位置找不到了', copied: n => `已复制 ${n} 条，贴到对话里即可`, none: '没有未处理的批注',
    cleared: n => `清掉了 ${n} 条已处理的`, noDone: '没有已处理的批注', emptyText: '内容是空的；不要这条就点“删除”', reply: '回复', key: 'Alt+C',
    exportHead: n => `网页批注（未处理 ${n} 条）`, img: '[图]'
  } : {
    fab: 'Comment', mode: 'Commenting · click anywhere', here: 'This page', all: 'All', open: 'open', page: 'Page note', list: 'List', copy: 'Copy all', exit: 'Exit',
    saved: 'Saved', unsaved: 'Offline', broken: 'Comments file damaged', brokenTip: '.page-comments/comments.json cannot be parsed and was left untouched. Repair it, restore the .bak next to it, or move it aside; new comments are kept in this browser meanwhile', savedTip: 'Every comment is written to .page-comments/comments.json', unsavedTip: 'Local server unreachable. New comments are kept in this browser and synced when it is back',
    ph: 'What should change here? Enter to save, Shift+Enter for a new line', save: 'Save', cancel: 'Cancel', del: 'Delete', done: 'Resolve', reopen: 'Reopen',
    listTitle: 'All comments', clear: 'Clear resolved', fold: 'Close', empty: 'No comments yet. Click the spot you want changed, type a sentence, press Enter.',
    whole: 'Whole page', blank: 'blank area', at: 'On', lost: 'anchor not found', copied: n => `Copied ${n} comment(s). Paste them into the chat`, none: 'No open comments',
    cleared: n => `Cleared ${n} resolved`, noDone: 'Nothing resolved yet', emptyText: 'Empty text. Use Delete to remove this comment', reply: 'Reply', key: 'Alt+C',
    exportHead: n => `Page comments (${n} open)`, img: '[image]'
  };

  const LS = 'page-comments:' + location.host;
  const PATH = location.pathname.replace(/(^|\/)index\.html?$/i, '$1');   // "/" and "/index.html" are the same page
  let items = [], on = false, saved = true, listOpen = false, ed = null, pushT = 0, tickT = 0;
  const anchors = new Map();   // id -> element
  const pins = new Map();      // id -> pin button

  const now = () => new Date().toISOString();
  const uid = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const live = () => items.filter(c => !c.deleted);
  const opened = () => live().filter(c => c.status !== 'done');
  const nice = p => { try { return decodeURIComponent(p); } catch (e) { return p; } };

  /* ---------- storage ---------- */
  function merge(a, b) {   // same id: newer `updated` wins; on a tie the one in `a`
    const m = new Map();
    a.concat(b).forEach(c => { if (!c || !c.id) return; const o = m.get(c.id); if (!o || (c.updated || '') > (o.updated || '')) m.set(c.id, c); });
    return Array.from(m.values()).sort((x, y) => (x.created || '').localeCompare(y.created || ''));
  }
  // The file on disk is the source of truth. The page only owns changes the server has not acknowledged yet
  // (acked: id -> the "updated" value the server last confirmed). A comment that was acknowledged and later disappears
  // from the server (comments.json deleted or rewritten) is dropped here too, so a stale tab never brings old comments back.
  // Unacknowledged changes survive a server restart in localStorage; rootId keeps them from leaking into another site
  // served on the same port.
  let rootId = '', booted = false, broken = false;
  const acked = new Map();
  const pending = () => items.filter(c => acked.get(c.id) !== c.updated);
  function backup() { try { const p = pending(); if (!p.length) localStorage.removeItem(LS); else localStorage.setItem(LS, JSON.stringify({ root: rootId, items: p })); } catch (e) { } }
  function restore() { try { const b = JSON.parse(localStorage.getItem(LS) || 'null'); return b && b.root === rootId && Array.isArray(b.items) ? b.items : []; } catch (e) { return []; } }
  function accept(remote) {   // server state + whatever is still pending locally; returns true when something still has to be sent
    const mine = pending();
    acked.clear(); remote.forEach(c => acked.set(c.id, c.updated));
    items = merge(remote, mine);
    const need = pending().length > 0;
    saved = !need; backup(); render();
    return need;
  }
  async function pull() {
    try {
      const r = await fetch(API, { cache: 'no-store' }); broken = r.status === 500; if (!r.ok) throw 0;
      const j = await r.json();
      rootId = j.root || '';
      if (!booted) { booted = true; items = merge(items, restore()); }
      if (accept(j.comments || [])) push();
    } catch (e) { saved = false; render(); }
  }
  function push() {
    clearTimeout(pushT);
    pushT = setTimeout(async () => {
      try {
        const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ comments: pending() }) });
        broken = r.status === 500; if (!r.ok) throw 0;
        accept((await r.json()).comments || []);
      } catch (e) { saved = false; render(); }
    }, 150);
  }
  function commit() { saved = false; backup(); render(); push(); }

  /* ---------- UI (inside a shadow root, so page styles and ours never mix) ---------- */
  const host = document.createElement('div');
  host.id = 'page-comments-root';
  host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
  * { box-sizing: border-box; font-family: system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .pin { position: fixed; display: none; width: 28px; height: 28px; margin: -28px 0 0 0; padding: 0; border: 0; border-radius: 50% 50% 50% 3px; background: #E0457B; color: #fff;
    font-weight: 600; font-size: 13px; line-height: 28px; text-align: center; cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,.45), 0 0 0 2px rgba(255,255,255,.9); }
  .pin.done { background: #6B7683; }
  .pin.new { animation: pulse 1s ease infinite; } .pin.flash { animation: pulse .5s ease 4; }
  @keyframes pulse { 50% { box-shadow: 0 2px 10px rgba(0,0,0,.45), 0 0 0 10px rgba(224,69,123,.35); } }
  .panel { position: fixed; color: #ECEEF1; background: #171B21; border: 1px solid #3A4552; border-radius: 6px; box-shadow: 0 10px 36px rgba(0,0,0,.4); font-size: 13.5px; line-height: 1.5; }
  .fab { right: 0; top: 50%; transform: translateY(-50%); border-right: 0; border-radius: 6px 0 0 6px; padding: 8px 9px 8px 11px; cursor: pointer; display: flex; align-items: center; gap: 7px; white-space: nowrap; }
  .fab:hover { background: #222831; } .fab .dot, .bar .dot { width: 9px; height: 9px; border-radius: 50%; background: #E0457B; flex: none; }
  .fab b { font-weight: 600; } .fab small { color: #8A94A1; font-size: 11.5px; }
  .on .fab { display: none; }
  .bar { top: 8px; left: 50%; transform: translateX(-50%); display: none; align-items: center; gap: 10px; padding: 6px 8px 6px 14px; white-space: nowrap; max-width: calc(100vw - 16px); }
  .on .bar { display: flex; }
  .bar .cnt { color: #AEB5BF; } .bar .cnt b { color: #fff; font-weight: 600; }
  .bar .st { font-size: 12.5px; padding-right: 6px; cursor: help; color: #F0766A; } .bar .st.ok { color: #56C596; }
  button.b { all: unset; cursor: pointer; padding: 5px 11px; border: 1px solid #3A4552; border-radius: 4px; font-size: 13px; color: #C9CFD7; white-space: nowrap; }
  button.b:hover { color: #fff; background: #252C36; } button.b.pri { background: #E0457B; border-color: #E0457B; color: #fff; } button.b.pri:hover { background: #C93A6C; }
  button.b.act { border-color: #E0457B; color: #F58BB1; }
  .list { top: 56px; right: 12px; bottom: 16px; width: 380px; max-width: calc(100vw - 24px); display: none; flex-direction: column; overflow: hidden; }
  .on .list.open { display: flex; }
  .list .hd { padding: 11px 14px; border-bottom: 1px solid #2A323D; display: flex; gap: 8px; align-items: center; } .list .hd b { font-weight: 600; margin-right: auto; font-size: 14px; }
  .list .sc { overflow: auto; padding: 2px 0 12px; }
  .list h5 { margin: 14px 14px 4px; font-size: 12px; font-weight: 500; letter-spacing: .04em; color: #8A94A1; word-break: break-all; }
  .it { display: grid; grid-template-columns: 26px 1fr; gap: 10px; padding: 8px 14px; cursor: pointer; } .it:hover { background: #222831; }
  .it i { font-style: normal; font-weight: 600; font-size: 12.5px; line-height: 24px; width: 24px; height: 24px; border-radius: 50%; background: #E0457B; color: #fff; text-align: center; }
  .it.done i { background: #6B7683; } .it.done p { color: #8A94A1; text-decoration: line-through; }
  .it p { margin: 2px 0 0; font-size: 14px; white-space: pre-wrap; word-break: break-word; } .it small { display: block; margin-top: 3px; font-size: 12px; color: #8A94A1; word-break: break-word; }
  blockquote { margin: 6px 0 0; padding: 5px 10px; border-left: 2px solid #56C596; background: #222831; font-size: 13px; color: #C9CFD7; white-space: pre-wrap; word-break: break-word; }
  .none { padding: 24px 14px; color: #8A94A1; }
  .ed { width: 372px; max-width: calc(100vw - 20px); padding: 12px; display: none; } .ed.open { display: block; }
  .ed .hd { font-size: 12.5px; color: #8A94A1; margin-bottom: 8px; word-break: break-word; }
  textarea { display: block; width: 100%; height: 96px; resize: vertical; padding: 9px 10px; border: 1px solid #3A4552; border-radius: 4px; background: #0E1116; color: #ECEEF1; font-size: 14.5px; line-height: 1.55; outline: none; }
  textarea:focus { border-color: #E0457B; }
  .ed .ft { display: flex; gap: 6px; align-items: center; margin-top: 10px; } .ed .ft span { flex: 1; }
  .toast { left: 50%; bottom: 24px; transform: translateX(-50%); padding: 9px 16px; display: none; } .toast.open { display: block; }
  @media print { :host { display: none; } }
  </style>
  <div class="wrap">
    <div class="pins"></div>
    <div class="panel fab" title="${T.key}"><span class="dot"></span><b>${T.fab}</b><span class="n"></span><small>${T.key}</small></div>
    <div class="panel bar"><span class="dot"></span><span>${T.mode}</span><span class="cnt"></span>
      <button class="b" data-a="page">${T.page}</button><button class="b" data-a="list">${T.list}</button><button class="b" data-a="copy">${T.copy}</button><button class="b" data-a="off">${T.exit}</button><span class="st"></span></div>
    <div class="panel list"><div class="hd"><b>${T.listTitle}</b><button class="b" data-a="clear">${T.clear}</button><button class="b" data-a="list">${T.fold}</button></div><div class="sc"></div></div>
    <div class="panel ed"><div class="hd"></div><textarea placeholder="${T.ph}"></textarea><div class="rp"></div>
      <div class="ft"><button class="b" data-a="del">${T.del}</button><button class="b" data-a="done"></button><span></span><button class="b" data-a="cancel">${T.cancel}</button><button class="b pri" data-a="save">${T.save}</button></div></div>
    <div class="panel toast"></div>
  </div>`;
  const $ = s => root.querySelector(s);
  const wrap = $('.wrap'), pinBox = $('.pins'), fab = $('.fab'), bar = $('.bar'), list = $('.list'), edEl = $('.ed'), ta = $('textarea'), toastEl = $('.toast');
  const pageCss = document.createElement('style');
  pageCss.textContent = 'html.page-comments-on, html.page-comments-on * { cursor: crosshair !important; }';
  function mount() { (document.head || document.documentElement).appendChild(pageCss); document.documentElement.appendChild(host); }

  let toastT = 0;
  function toast(t) { toastEl.textContent = t; toastEl.classList.add('open'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('open'), 2600); }

  /* ---------- anchoring ---------- */
  function cssPath(el) {
    const seg = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n === document.body) { seg.unshift('body'); break; }
      if (n.id && /^[A-Za-z][\w-]*$/.test(n.id) && document.querySelectorAll('#' + n.id).length === 1) { seg.unshift('#' + n.id); break; }
      const tag = n.tagName.toLowerCase();
      const same = n.parentElement ? Array.from(n.parentElement.children).filter(x => x.tagName === n.tagName) : [n];
      seg.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(n) + 1})` : tag);
    }
    return seg.join(' > ');
  }
  function snippet(el) {
    let t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (el.children.length && t.length > 90) t = '';            // clicked the blank part of a big container
    if (!t) { const im = el.closest('img,svg,canvas,video,figure'); if (im) t = T.img + ' ' + (im.getAttribute('alt') || im.getAttribute('aria-label') || im.id || im.tagName.toLowerCase()); }
    return t.length > 48 ? t.slice(0, 48) + '…' : t;
  }
  function findAnchor(c) {
    if (!c.sel) return null;
    let el = anchors.get(c.id);
    if (el && el.isConnected) return el;
    el = null;
    try { el = document.querySelector(c.sel); } catch (e) { }
    if (!el && c.ctx && c.tag && c.ctx.indexOf(T.img) !== 0) {   // page structure changed: fall back to the text that was clicked
      const want = c.ctx.replace(/…$/, '');
      el = Array.from(document.getElementsByTagName(c.tag)).find(x => (x.innerText || x.textContent || '').replace(/\s+/g, ' ').trim().indexOf(want) === 0) || null;
    }
    if (el) anchors.set(c.id, el); else anchors.delete(c.id);
    return el;
  }
  function pointOf(el, rx, ry) {   // viewport point of the pin, or null when the anchor is hidden / scrolled away / clipped
    if (!el.isConnected) return null;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })) return null;
    const r = el.getBoundingClientRect(); if (!r.width && !r.height) return null;
    const x = r.left + rx * r.width, y = r.top + ry * r.height;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null;
    // Is the anchor really what you would see at that point? A hit test answers clipping, scrolled-away content and
    // things lying on top (an open drawer, a dialog, another slide) in one go. tick() makes our own UI transparent to it.
    const top = document.elementFromPoint(x, y);
    if (top && top !== el && !el.contains(top) && !top.contains(el)) return null;
    return { x, y };
  }
  function numbered() { const cnt = {}, out = new Map(); live().forEach(c => { cnt[c.path] = (cnt[c.path] || 0) + 1; out.set(c.id, cnt[c.path]); }); return out; }
  function tick() {   // keep pins glued to their elements
    if (!on) return;
    host.style.pointerEvents = 'none';   // so the hit test in pointOf() sees the page, not our pins and panels
    try { place(); } finally { host.style.pointerEvents = ''; }
  }
  function place() {
    pins.forEach((pin, id) => {
      const c = pin._c, el = findAnchor(c), pt = el ? pointOf(el, c.rx, c.ry) : null;
      if (pt) { pin.style.left = pt.x + 'px'; pin.style.top = pt.y + 'px'; pin.style.display = 'block'; } else pin.style.display = 'none';
    });
    if (ed && ed.ghost) { const pt = pointOf(ed.ghost._el, ed.c.rx, ed.c.ry); ed.ghost.style.display = pt ? 'block' : 'none'; if (pt) { ed.ghost.style.left = pt.x + 'px'; ed.ghost.style.top = pt.y + 'px'; } }
  }
  function schedule() { cancelAnimationFrame(tickT); tickT = requestAnimationFrame(tick); }

  /* ---------- render ---------- */
  function render() {
    const num = numbered(), mine = live().filter(c => c.path === PATH && c.sel);
    pins.forEach((pin, id) => { if (!mine.some(c => c.id === id)) { pin.remove(); pins.delete(id); } });
    mine.forEach(c => {
      let pin = pins.get(c.id);
      if (!pin) { pin = document.createElement('button'); pin.className = 'pin'; pin.dataset.id = c.id; pinBox.appendChild(pin); pins.set(c.id, pin); }
      pin._c = c; pin.textContent = num.get(c.id); pin.classList.toggle('done', c.status === 'done');
      pin.title = c.text + (c.reply ? `\n— ${T.reply}: ${c.reply}` : '');
    });
    const n = opened().length, here = opened().filter(c => c.path === PATH).length;
    fab.querySelector('.n').textContent = n ? String(n) : '';
    bar.querySelector('.cnt').innerHTML = `${T.here} <b>${here}</b> · ${T.all} <b>${n}</b> ${T.open}`;
    const st = bar.querySelector('.st'); st.className = 'st' + (saved ? ' ok' : ''); st.textContent = saved ? T.saved : broken ? T.broken : T.unsaved; st.title = saved ? T.savedTip : broken ? T.brokenTip : T.unsavedTip;
    bar.querySelector('[data-a=list]').classList.toggle('act', listOpen);
    list.classList.toggle('open', listOpen);
    if (listOpen) renderList(num);
    schedule();
  }
  function whereText(c) {
    if (!c.sel) return T.whole;
    return (c.ctx ? '“' + esc(c.ctx) + '”' : T.blank) + (c.path === PATH && !findAnchor(c) ? ` · ${T.lost}` : '');
  }
  function renderList(num) {
    const sc = list.querySelector('.sc'), all = live();
    if (!all.length) { sc.innerHTML = `<div class="none">${T.empty}</div>`; return; }
    const groups = new Map();
    all.forEach(c => { const k = c.path + (c.hash || ''); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); });
    let h = '';
    groups.forEach((cs, k) => {
      h += `<h5>${esc(nice(k))}${cs[0].title ? ' · ' + esc(cs[0].title) : ''}</h5>`;
      cs.forEach(c => { h += `<div class="it${c.status === 'done' ? ' done' : ''}" data-id="${esc(c.id)}"><i>${num.get(c.id)}</i><div><p>${esc(c.text)}</p><small>${whereText(c)}</small>${c.reply ? `<blockquote>${esc(c.reply)}</blockquote>` : ''}</div></div>`; });
    });
    sc.innerHTML = h;
  }

  /* ---------- editor ---------- */
  function openEditor(c, isNew, cx, cy, el) {
    closeEditor();
    ed = { c, isNew, ghost: null };
    edEl.querySelector('.hd').innerHTML = !c.sel ? T.whole : (c.ctx ? `${T.at} “${esc(c.ctx)}”` : `${T.at} ${T.blank}`);
    ta.value = c.text || '';
    edEl.querySelector('.rp').innerHTML = c.reply ? `<blockquote>${esc(c.reply)}</blockquote>` : '';
    edEl.querySelector('[data-a=del]').style.display = isNew ? 'none' : '';
    const dn = edEl.querySelector('[data-a=done]'); dn.style.display = isNew ? 'none' : ''; dn.textContent = c.status === 'done' ? T.reopen : T.done;
    if (isNew && el) { const g = document.createElement('button'); g.className = 'pin new'; g.textContent = '+'; g._el = el; pinBox.appendChild(g); ed.ghost = g; }
    edEl.classList.add('open');
    const w = edEl.offsetWidth, h = edEl.offsetHeight;
    if (cx == null) { cx = innerWidth / 2 - w / 2 - 18; cy = innerHeight / 2 - h / 2 - 18; }
    edEl.style.left = Math.max(10, Math.min(cx + 18, innerWidth - w - 12)) + 'px';
    edEl.style.top = Math.max(10, Math.min(cy + 18, innerHeight - h - 12)) + 'px';
    ta.focus(); schedule();
  }
  function closeEditor() { if (ed && ed.ghost) ed.ghost.remove(); ed = null; edEl.classList.remove('open'); }
  function save() {
    if (!ed) return;
    const t = ta.value.trim(), c = ed.isNew ? ed.c : liveOf(ed.c);
    if (!t) { if (ed.isNew) return closeEditor(); return toast(T.emptyText); }
    c.text = t; c.updated = now();
    if (ed.isNew) { items.push(c); if (ed.ghost) anchors.set(c.id, ed.ghost._el); }
    closeEditor(); commit();
  }
  // a sync may have replaced the objects in `items` while the editor was open: always edit the current one
  function liveOf(c) { return items.find(x => x.id === c.id) || c; }
  function blank(extra) {
    return Object.assign({ id: uid(), path: PATH, hash: location.hash || '', title: document.title || '', sel: null, tag: '', rx: 0, ry: 0, ctx: '', text: '',
      vw: innerWidth, vh: innerHeight, status: 'open', reply: '', created: now(), updated: now() }, extra);
  }
  function newAt(el, cx, cy) {
    if (!el || el === document.documentElement) el = document.body;
    const r = el.getBoundingClientRect();
    const c = blank({ sel: cssPath(el), tag: el.tagName.toLowerCase(), ctx: snippet(el),
      rx: r.width ? +((cx - r.left) / r.width).toFixed(4) : 0, ry: r.height ? +((cy - r.top) / r.height).toFixed(4) : 0 });
    openEditor(c, true, cx, cy, el);
  }
  function flash(c) {
    const el = findAnchor(c);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    setTimeout(() => { tick(); const pin = pins.get(c.id); if (pin) { pin.classList.add('flash'); setTimeout(() => pin.classList.remove('flash'), 2200); } }, 380);
  }
  function jump(c) {
    if (c.path !== PATH) { try { sessionStorage.setItem('page-comments-jump', c.id); sessionStorage.setItem('page-comments-on', '1'); } catch (e) { } location.href = c.path + (c.hash || ''); return; }
    if ((c.hash || '') !== (location.hash || '') && c.hash) location.hash = c.hash;
    setTimeout(() => flash(c), 120);
  }
  function exportText() {
    const num = numbered(), groups = new Map();
    opened().forEach(c => { const k = c.path + (c.hash || ''); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); });
    let t = T.exportHead(opened().length) + '\n';
    groups.forEach((cs, k) => {
      t += `\n## ${nice(k)}${cs[0].title ? '  (' + cs[0].title + ')' : ''}\n`;
      cs.forEach(c => { t += `${num.get(c.id)}. ${c.text.replace(/\n/g, ' / ')}\n   - ${c.sel ? (c.ctx ? '“' + c.ctx + '”  ' : '') + '`' + c.sel + '`' : T.whole}\n`; });
    });
    return t;
  }
  async function copyAll() {
    if (!opened().length) return toast(T.none);
    const t = exportText();
    try { await navigator.clipboard.writeText(t); }
    catch (e) { const x = document.createElement('textarea'); x.value = t; x.style.cssText = 'position:fixed;left:-9999px'; document.body.appendChild(x); x.select(); try { document.execCommand('copy'); } catch (e2) { } x.remove(); }
    toast(T.copied(opened().length));
  }
  function toggle(want) {
    on = want == null ? !on : want;
    wrap.classList.toggle('on', on); document.documentElement.classList.toggle('page-comments-on', on);
    try { sessionStorage.setItem('page-comments-on', on ? '1' : ''); } catch (e) { }
    if (!on) { closeEditor(); listOpen = false; pins.forEach(p => p.style.display = 'none'); } else pull();
    render();
  }

  /* ---------- events ---------- */
  const inUI = e => e.composedPath && e.composedPath().indexOf(host) >= 0;
  // while commenting, the page's own clicks and drags do nothing
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick'].forEach(type => addEventListener(type, e => {
    if (!on || inUI(e)) return;
    e.stopImmediatePropagation(); if (type !== 'pointerup' && type !== 'mouseup') e.preventDefault();
  }, true));
  addEventListener('click', e => {
    if (!on || inUI(e)) return;
    e.stopImmediatePropagation(); e.preventDefault();
    if (ed) { if (ed.isNew && !ta.value.trim()) closeEditor(); else return save(); }
    const el = e.target && e.target.nodeType === 1 ? e.target : (e.target && e.target.parentElement);
    newAt(el, e.clientX, e.clientY);
  }, true);
  addEventListener('keydown', e => { if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyC') { e.preventDefault(); e.stopImmediatePropagation(); toggle(); } }, true);
  // typing in our box must not trigger the page's keyboard shortcuts
  ['keydown', 'keyup', 'keypress'].forEach(t => host.addEventListener(t, e => e.stopPropagation()));
  fab.addEventListener('click', () => toggle(true));
  pinBox.addEventListener('click', e => {
    const pin = e.target.closest('.pin'); if (!pin || !pin._c) return;
    const r = pin.getBoundingClientRect(); openEditor(pin._c, false, r.left, r.bottom);   // the pin's sharp corner sits on the clicked point
  });
  bar.addEventListener('click', e => {
    const b = e.target.closest('[data-a]'); if (!b) return; const a = b.dataset.a;
    if (a === 'off') toggle(false);
    else if (a === 'list') { listOpen = !listOpen; render(); }
    else if (a === 'copy') copyAll();
    else if (a === 'page') openEditor(blank({}), true);
  });
  list.addEventListener('click', e => {
    const b = e.target.closest('[data-a]');
    if (b && b.dataset.a === 'list') { listOpen = false; return render(); }
    if (b && b.dataset.a === 'clear') {
      const n = live().filter(c => c.status === 'done').length; if (!n) return toast(T.noDone);
      live().forEach(c => { if (c.status === 'done') { c.deleted = true; c.updated = now(); } }); commit(); return toast(T.cleared(n));
    }
    const it = e.target.closest('.it'); if (!it) return;
    const c = items.find(x => x.id === it.dataset.id); if (c) jump(c);
  });
  edEl.addEventListener('click', e => {
    const b = e.target.closest('[data-a]'); if (!b || !ed) return; const a = b.dataset.a, c = liveOf(ed.c);
    if (a === 'save') save();
    else if (a === 'cancel') closeEditor();
    else if (a === 'del') { c.deleted = true; c.updated = now(); closeEditor(); commit(); }
    else if (a === 'done') { c.status = c.status === 'done' ? 'open' : 'done'; if (ta.value.trim()) c.text = ta.value.trim(); c.updated = now(); closeEditor(); commit(); }
  });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeEditor();
    else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); save(); }
  });
  addEventListener('scroll', schedule, true);
  addEventListener('resize', schedule);
  addEventListener('hashchange', () => { if (on) { closeEditor(); render(); } });
  addEventListener('focus', () => { if (on && !ed) pull(); });
  setInterval(() => { if (on) tick(); }, 250);                                              // layout can change without any event (transitions, tabs, slides)
  setInterval(() => { if (on && !ed && document.visibilityState === 'visible') pull(); }, 10000);   // picks up replies written by the agent
  setInterval(() => { if (pending().length) push(); else if (!saved && on) pull(); }, 5000);   // retry after the server comes back

  /* ---------- start ---------- */
  function start() {
    mount();
    render();
    let want = /[?&]pc=1\b/.test(location.search), jumpId = '';
    try { want = want || sessionStorage.getItem('page-comments-on') === '1'; jumpId = sessionStorage.getItem('page-comments-jump') || ''; sessionStorage.removeItem('page-comments-jump'); } catch (e) { }
    pull().then(() => {
      if (want) toggle(true);
      const c = jumpId && items.find(x => x.id === jumpId); if (c) setTimeout(() => flash(c), 300);
    });
  }
  if (document.body) start(); else addEventListener('DOMContentLoaded', start);
  window.__pageComments = { toggle, exportText, get items() { return items; }, get on() { return on; } };
})();
