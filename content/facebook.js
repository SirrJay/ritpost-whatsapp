/*
 * RitPost — Facebook content script (facebook.com)
 *
 * Posts the RitPost message to the Facebook groups and Pages the user picked, one at a time:
 * opens the group, opens its "Write something…" box, fills in the text, attaches photos/videos,
 * then waits for the USER to click Post. RitPost never clicks Post on Facebook.
 *
 * The run lives in chrome.storage.local ("fbRun"), so it survives the full page load between
 * groups. Only the tab the run was started in (fbRun.tabId) acts on it.
 */
(() => {
  if (window.__ritpostFb) return;
  window.__ritpostFb = true;

  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => !!(el && el.isConnected && el.getClientRects().length);
  async function waitFor(fn, timeout = 10000, interval = 250) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }
  const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  const labelOf = (el) => [el.getAttribute('aria-label'), textOf(el)].filter(Boolean).join(' ').trim();

  function fireClick(el) {
    el.scrollIntoView?.({ block: 'center' });
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, view: window, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', base));
    el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', base));
    el.dispatchEvent(new MouseEvent('click', base));
  }

  const bg = (type, payload = {}) => chrome.runtime.sendMessage({ type, payload }).catch(() => null);
  const getRun = async () => (await chrome.storage.local.get('fbRun')).fbRun || null;
  const setRun = (run) => chrome.storage.local.set({ fbRun: run });

  // ─────────────── Facebook page structure ───────────────

  /** The open "Create post" dialog's text box (Facebook uses a Lexical editor). */
  function composerBox() {
    const boxes = $$('[role="dialog"] [contenteditable="true"][role="textbox"], [role="dialog"] [contenteditable="true"][data-lexical-editor]').filter(visible);
    // Prefer the dialog that looks like the post composer (has a Post/Next button).
    return boxes.find((b) => postButton(b.closest('[role="dialog"]'))) || boxes[0] || null;
  }
  const composerDialog = () => composerBox()?.closest('[role="dialog"]') || null;

  const POST_RE = /^(post|post now|share|share now|publish|next|submit)$/i;
  function postButton(dialog) {
    if (!dialog) return null;
    const btns = $$('[role="button"], button', dialog).filter(visible);
    return (
      btns.find((b) => POST_RE.test((b.getAttribute('aria-label') || '').trim())) ||
      btns.find((b) => POST_RE.test(textOf(b))) ||
      null
    );
  }

  /** The "Write something…" / "What's on your mind?" button that opens the composer. */
  const TRIGGER_RE = /(write something|what['’]s on your mind|create (a )?(public )?post|start (a )?discussion|write a post|create post)/i;
  function composerTrigger() {
    const main = document.querySelector('[role="main"]') || document.body;
    const btns = $$('[role="button"]', main).filter(visible);
    let hit = btns.find((b) => TRIGGER_RE.test(textOf(b)) && textOf(b).length < 80);
    if (hit) return hit;
    // Some layouts put the prompt in a span inside a clickable area.
    const span = $$('span', main).find((s) => visible(s) && TRIGGER_RE.test(textOf(s)) && textOf(s).length < 80);
    return span ? span.closest('[role="button"]') || span : null;
  }

  function insertText(box, text) {
    box.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(box);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }
  const loose = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();

  async function fillText(text) {
    if (!text) return true;
    const want = loose(text).slice(0, 40);
    let box = composerBox();
    if (!box) return false;
    if (loose(textOf(box)).includes(want)) return true;
    insertText(box, text);
    await sleep(400);
    box = composerBox() || box;
    if (loose(textOf(box)).includes(want)) return true;
    // Fallback: type it with insertText, one line at a time.
    box.focus();
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (line) document.execCommand('insertText', false, line);
      if (i < lines.length - 1) document.execCommand('insertParagraph', false, null);
    });
    await sleep(400);
    return loose(textOf(composerBox() || box)).includes(want);
  }

  /** Thumbnails of attached media in the composer. */
  const mediaCount = (dialog) => (dialog ? $$('img[src^="blob:"], video, img[src^="data:"]', dialog).filter(visible).length : 0);

  async function attachMedia(files) {
    if (!files.length) return { ok: true };
    let dialog = composerDialog();
    if (!dialog) return { ok: false };
    const before = mediaCount(dialog);
    const done = () => mediaCount(composerDialog()) > before;
    const mediaInput = () =>
      $$('input[type="file"]', composerDialog() || document).find((i) => /image|video/i.test(i.accept || '') || !i.accept);
    const setInput = (input) => {
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };

    // 1) A file input already inside the composer.
    let input = mediaInput();
    if (input) {
      setInput(input);
      if (await waitFor(done, 8000)) return { ok: true };
    }
    // 2) Click "Photo/video", then use its file input.
    const photoBtn = $$('[role="button"], [aria-label]', composerDialog() || document).find(
      (b) => visible(b) && /photo\s*\/\s*video|photo|add photos/i.test(b.getAttribute('aria-label') || '')
    );
    if (photoBtn) {
      fireClick(photoBtn);
      await sleep(700);
      input = mediaInput();
      if (input) {
        setInput(input);
        if (await waitFor(done, 8000)) return { ok: true };
      }
    }
    // 3) Paste the files into the text box.
    const box = composerBox();
    if (box) {
      box.focus();
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      if (await waitFor(done, 8000)) return { ok: true };
    }
    return { ok: false };
  }

  async function loadFiles(ids) {
    if (!ids?.length) return [];
    const { attachments } = await chrome.storage.local.get('attachments');
    const byId = new Map((attachments || []).map((a) => [a.id, a]));
    const files = [];
    for (const id of ids) {
      const a = byId.get(id);
      if (!a?.data) throw new Error('An attachment is missing. Attach the file again in RitPost.');
      const bin = atob(a.data.slice(a.data.indexOf(',') + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      files.push(new File([bytes], a.name, { type: a.type || 'application/octet-stream', lastModified: Date.now() }));
    }
    return files;
  }

  // ─────────────── the user's own Post click ───────────────
  let lastPostClick = 0;
  document.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted) return;
      const b = e.target.closest?.('[role="button"], button');
      if (!b || !b.closest('[role="dialog"]')) return;
      const l = (b.getAttribute('aria-label') || textOf(b)).trim();
      if (/^(post|post now|share|share now|publish|submit)$/i.test(l)) lastPostClick = Date.now();
    },
    true
  );

  // ─────────────── overlay ───────────────
  const ui = (() => {
    let host, root;
    function mount() {
      if (host?.isConnected) return;
      host = document.createElement('div');
      host.id = 'ritpost-fb';
      host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;';
      root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>
        .card{font:13px/1.45 "Segoe UI",Roboto,Helvetica,Arial,sans-serif;width:300px;background:#fff;color:#0f172a;border-radius:12px;
          box-shadow:0 10px 30px rgba(15,23,42,.25);border:1px solid #e2e8f0;overflow:hidden}
        .head{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#0e7c66;color:#fff;font-weight:600}
        .head .meta{margin-left:auto;font-weight:400;opacity:.85;font-size:12px}
        .body{padding:10px 12px}
        .name{font-weight:600;margin-bottom:4px;word-break:break-word}
        .msg{color:#334155}
        .msg.err{color:#b91c1c}
        .row{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
        button{font:inherit;border:1px solid #cbd5e1;background:#f8fafc;color:#0f172a;border-radius:8px;padding:5px 10px;cursor:pointer}
        button.primary{background:#0e7c66;border-color:#0e7c66;color:#fff}
        button.danger{color:#b91c1c}
        .bar{height:4px;background:#e2e8f0}.bar>div{height:100%;background:#14b88a;width:0;transition:width .3s}
        @media (prefers-color-scheme:dark){.card{background:#111c2e;color:#e2e8f0;border-color:#243247}.msg{color:#cbd5e1}
          button{background:#1e293b;border-color:#334155;color:#e2e8f0}.bar{background:#243247}}
      </style>
      <div class="card"><div class="head">RitPost · Facebook<span class="meta"></span></div><div class="bar"><div></div></div>
      <div class="body"><div class="name"></div><div class="msg"></div><div class="row"></div></div></div>`;
      document.documentElement.append(host);
    }
    function update({ meta = '', name = '', msg = '', error = false, progress = 0, buttons = [] }) {
      mount();
      root.querySelector('.meta').textContent = meta;
      root.querySelector('.name').textContent = name;
      const m = root.querySelector('.msg');
      m.textContent = msg;
      m.classList.toggle('err', error);
      root.querySelector('.bar>div').style.width = `${Math.round(progress * 100)}%`;
      const row = root.querySelector('.row');
      row.replaceChildren(
        ...buttons.map((b) => {
          const el = document.createElement('button');
          el.textContent = b.label;
          if (b.kind) el.className = b.kind;
          el.addEventListener('click', b.run);
          return el;
        })
      );
    }
    const unmount = () => host?.remove();
    return { update, unmount };
  })();

  // ─────────────── run logic ───────────────
  const LOADED_AT = Date.now();
  let myTabId = null;
  let busy = false;
  let watchTimer = null;
  let countdownTimer = null;

  const normPath = (u) => {
    try {
      const x = new URL(u, location.href);
      return x.pathname.replace(/\/+$/, '').toLowerCase() + (x.pathname.includes('profile.php') ? x.search : '');
    } catch {
      return '';
    }
  };

  const meta = (run) => `${Math.min(run.index + 1, run.items.length)} of ${run.items.length}`;
  const progress = (run) => run.index / run.items.length;

  async function stopRun() {
    const run = await getRun();
    if (!run) return;
    run.status = 'stopped';
    run.finishedAt = Date.now();
    await setRun(run);
  }

  async function record(status, error = '') {
    const run = await getRun();
    if (!run || !['running'].includes(run.status)) return;
    const item = run.items[run.index];
    run.results.push({ id: item.id, name: item.name, status, error });
    run.index++;
    if (run.index >= run.items.length) {
      run.status = 'done';
      run.finishedAt = Date.now();
    } else {
      // The anti-spam pause only matters after a real post; skipped/failed groups move on quickly.
      const gap = status === 'posted' ? Math.max(30, Number(run.gapSec) || 60) * (1 + Math.random() * 0.2) : 3;
      run.status = 'waiting';
      run.nextAt = Date.now() + Math.round(gap) * 1000;
    }
    await setRun(run);
  }

  async function goToCurrent(run) {
    run.status = 'running';
    run.navigatedFor = run.index;
    run.navAt = Date.now();
    run.nextAt = null;
    await setRun(run);
    location.assign(run.items[run.index].url);
  }

  function clearTimers() {
    clearInterval(watchTimer);
    clearInterval(countdownTimer);
    watchTimer = countdownTimer = null;
  }

  async function prepare(run) {
    const item = run.items[run.index];
    const base = { meta: meta(run), name: item.name, progress: progress(run) };
    const stopBtn = { label: 'Stop', kind: 'danger', run: stopRun };
    const skipBtn = { label: 'Skip', run: () => record('skipped') };
    const fail = (msg) =>
      ui.update({ ...base, msg, error: true, buttons: [{ label: 'Try again', kind: 'primary', run: () => { busy = false; tick(true); } }, skipBtn, stopBtn] });

    ui.update({ ...base, msg: 'Opening the post box…', buttons: [skipBtn, stopBtn] });

    let files = [];
    try {
      files = await loadFiles(run.attachmentIds);
    } catch (e) {
      return fail(e.message);
    }
    const media = files.filter((f) => /^(image|video)\//.test(f.type));
    const skippedDocs = files.length - media.length;

    // Open the composer.
    if (!composerBox()) {
      const trigger = await waitFor(composerTrigger, 20000, 400);
      if (!trigger) {
        return fail(
          item.kind === 'page'
            ? 'No post box on this Page. To post as your Page, switch to the Page’s profile on Facebook (your profile picture → the Page), then click Try again.'
            : 'No “Write something…” box here. Make sure you’re a member of this group and it allows posts, then click Try again.'
        );
      }
      fireClick(trigger);
      if (!(await waitFor(composerBox, 10000))) {
        trigger.click?.();
        if (!(await waitFor(composerBox, 6000))) return fail('The post box didn’t open. Click “Write something…” yourself, then Try again.');
      }
    }
    await sleep(600);

    if (!(await fillText(item.text))) return fail('Couldn’t type the message into the post box. Click inside it and Try again.');

    let note = '';
    if (media.length) {
      ui.update({ ...base, msg: `Attaching ${media.length} photo/video file(s)…`, buttons: [skipBtn, stopBtn] });
      const res = await attachMedia(media);
      if (!res.ok) note = ' Attachments couldn’t be added automatically; add them with Photo/video before posting.';
    }
    if (skippedDocs) note += ` ${skippedDocs} document(s) skipped (RitPost attaches only photos and videos on Facebook).`;

    lastPostClick = 0;
    ui.update({ ...base, msg: `Check the post, then click Post on Facebook.${note}`, buttons: [skipBtn, stopBtn] });

    // Wait for the user to post (or close the box).
    let sawDialog = true;
    clearInterval(watchTimer);
    watchTimer = setInterval(async () => {
      const open = !!composerBox();
      if (open) {
        sawDialog = true;
        return;
      }
      if (!sawDialog) return;
      sawDialog = false;
      if (Date.now() - lastPostClick < 120000) {
        clearInterval(watchTimer);
        await record('posted');
      } else {
        ui.update({
          ...base,
          msg: 'The post box was closed without posting.',
          error: true,
          buttons: [{ label: 'Fill again', kind: 'primary', run: () => { clearInterval(watchTimer); busy = false; tick(true); } }, skipBtn, stopBtn],
        });
      }
    }, 700);
  }

  function showCountdown(run) {
    clearInterval(countdownTimer);
    const next = run.items[run.index];
    const draw = () => {
      const left = Math.max(0, Math.ceil((run.nextAt - Date.now()) / 1000));
      ui.update({
        meta: meta(run),
        name: `Next: ${next.name}`,
        msg: `${run.results.at(-1)?.status === 'posted' ? 'Posted.' : 'Skipped.'} Opening the next one in ${left} s${run.results.at(-1)?.status === 'posted' ? ' (a pause keeps Facebook from flagging the posts)' : ''}.`,
        progress: progress(run),
        buttons: [{ label: 'Stop', kind: 'danger', run: stopRun }],
      });
      if (left <= 0) {
        clearInterval(countdownTimer);
        goToCurrent(run);
      }
    };
    draw();
    countdownTimer = setInterval(draw, 1000);
  }

  function showFinished(run) {
    const posted = run.results.filter((r) => r.status === 'posted').length;
    const msg =
      run.status === 'done'
        ? `Finished: ${posted} of ${run.items.length} posted.`
        : `Stopped: ${posted} of ${run.items.length} posted.`;
    ui.update({
      meta: '',
      name: msg,
      msg: 'You can close this.',
      progress: run.status === 'done' ? 1 : progress(run),
      buttons: [{ label: 'Close', kind: 'primary', run: async () => { ui.unmount(); const r = await getRun(); if (r) { r.dismissed = true; setRun(r); } } }],
    });
  }

  async function tick(force = false) {
    const run = await getRun();
    if (myTabId == null) myTabId = (await bg('BG_FB_TABID'))?.tabId ?? null;
    if (!run || run.tabId !== myTabId) {
      clearTimers();
      ui.unmount();
      return;
    }
    if (run.status === 'done' || run.status === 'stopped') {
      clearTimers();
      if (run.dismissed || Date.now() - (run.finishedAt || 0) > 10 * 60 * 1000) ui.unmount();
      else showFinished(run);
      return;
    }
    if (run.status === 'waiting') {
      clearInterval(watchTimer);
      showCountdown(run);
      return;
    }
    // running
    if (busy && !force) return;
    const item = run.items[run.index];
    if (!item) return;
    if (normPath(item.url) !== normPath(location.href)) {
      if (run.navigatedFor !== run.index) return goToCurrent(run);
      // Facebook may redirect /groups/123 to /groups/name; accept the page that loaded after we navigated.
      if (LOADED_AT < (run.navAt || 0)) return;
    }
    busy = true;
    clearTimers();
    try {
      await prepare(run);
    } catch (e) {
      ui.update({ meta: meta(run), name: item.name, msg: `Something went wrong: ${e?.message || e}`, error: true, buttons: [{ label: 'Skip', run: () => record('failed', String(e?.message || e)) }, { label: 'Stop', kind: 'danger', run: stopRun }] });
    }
  }

  let lastKey = '';
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.fbRun) return;
    const r = changes.fbRun.newValue;
    const key = r ? `${r.id}|${r.status}|${r.index}|${r.nextAt || 0}|${r.dismissed ? 1 : 0}` : '';
    if (key === lastKey) return;
    lastKey = key;
    busy = false;
    tick();
  });

  // ─────────────── importing joined groups ───────────────
  const RESERVED = new Set(['feed', 'discover', 'joins', 'create', 'notifications', 'search', 'explore', 'your_groups', 'manage', 'membership', 'learn']);
  function collectGroups() {
    const found = new Map();
    for (const a of $$('a[href*="/groups/"]')) {
      let u;
      try {
        u = new URL(a.href, location.href);
      } catch {
        continue;
      }
      const m = u.pathname.match(/^\/groups\/([^/?#]+)\/?$/);
      if (!m || RESERVED.has(m[1].toLowerCase())) continue;
      const name = textOf(a).split(/\s*(Last active|You last visited|Active)\b/)[0].trim();
      if (!name || name.length > 120 || /^(view group|see all|visit group)$/i.test(name)) continue;
      const prev = found.get(m[1]);
      if (!prev || name.length > prev.name.length) found.set(m[1], { name, url: `https://www.facebook.com/groups/${m[1]}/` });
    }
    return [...found.values()];
  }
  async function scanGroups() {
    await waitFor(() => collectGroups().length, 15000, 500);
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 25 && stable < 3; i++) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(1200);
      const n = collectGroups().length;
      stable = n === last ? stable + 1 : 0;
      last = n;
    }
    window.scrollTo(0, 0);
    return collectGroups();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'FB_PING') {
      sendResponse({ ok: true, signedIn: !!document.querySelector('[role="banner"], [role="navigation"]') && !location.pathname.startsWith('/login') });
      return false;
    }
    if (msg?.type === 'FB_SCAN') {
      if (/\/login|checkpoint/.test(location.pathname) || document.querySelector('input[name="pass"]'))
        sendResponse({ ok: false, error: 'Sign in to Facebook in this tab first, then import again.' });
      else scanGroups().then((groups) => sendResponse({ ok: true, groups }), (e) => sendResponse({ ok: false, error: e?.message || String(e) }));
      return true;
    }
    return false;
  });

  tick();
})();
