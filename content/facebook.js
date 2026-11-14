/*
 * RitPost — Facebook content script (facebook.com)
 *
 * Posts the RitPost message to the Facebook groups and Pages the user picked, one at a time:
 * opens the group or Page, opens its post box, fills in the text and attaches photos/videos.
 *
 *  - Manual mode: the USER clicks Post. RitPost waits at least 30 s before the next one.
 *  - Automatic mode: after a short review countdown (which the user can hold or cancel) RitPost
 *    clicks Post, then waits a long, randomised interval (at least 2 minutes) and respects a
 *    daily limit. It stops at once if Facebook shows a "temporarily blocked"/limit message.
 *
 * The run lives in chrome.storage.local ("fbRun"), so it survives the full page load between
 * groups. Only the tab the run was started in (fbRun.tabId) acts on it.
 */
(() => {
  if (window.__ritpostFb) return;
  window.__ritpostFb = true;

  // ─────────────── helpers ───────────────
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function visible(el) {
    if (!el?.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
  }
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
  const loose = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  const today = () => new Date().toISOString().slice(0, 10);

  function fireClick(el) {
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const p = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerover', p));
    el.dispatchEvent(new PointerEvent('pointerenter', p));
    el.dispatchEvent(new MouseEvent('mouseover', base));
    el.dispatchEvent(new PointerEvent('pointerdown', p));
    el.dispatchEvent(new MouseEvent('mousedown', base));
    el.focus?.({ preventScroll: true });
    el.dispatchEvent(new PointerEvent('pointerup', { ...p, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0, detail: 1 }));
  }
  function pressKey(el, key) {
    el.focus?.({ preventScroll: true });
    const o = { key, code: key === ' ' ? 'Space' : key, keyCode: key === ' ' ? 32 : 13, which: key === ' ' ? 32 : 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', o));
    el.dispatchEvent(new KeyboardEvent('keypress', o));
    el.dispatchEvent(new KeyboardEvent('keyup', o));
  }
  /** Different ways of clicking; Facebook's buttons react to some and not others. */
  const CLICKS = [
    (el) => el.click(),
    (el) => fireClick(el),
    (el) => fireClick(el.querySelector('span, div') || el),
    (el) => pressKey(el, 'Enter'),
    (el) => pressKey(el, ' '),
  ];

  const bg = (type, payload = {}) => chrome.runtime.sendMessage({ type, payload }).catch(() => null);
  const getRun = async () => (await chrome.storage.local.get('fbRun')).fbRun || null;
  const setRun = (run) => chrome.storage.local.set({ fbRun: run });

  // ─────────────── Facebook page structure ───────────────
  const PROMPT_RE = /^(write something|what['’]s on your mind|create (a )?(public )?post|start (a )?discussion|write a post|post something|share something)/i;
  const POSTBOX_RE = /(write something|what['’]s on your mind|create (a )?(public |anonymous )?post|start (a )?discussion|share your thoughts|write a post)/i;
  const NOT_POSTBOX_RE = /(comment|reply|answer|message|search|chat)/i;
  const POST_RE = /^(post|post now|share|share now|publish|submit)$/i;
  const NEXT_RE = /^next$/i;

  const boxLabel = (b) =>
    [b.getAttribute('aria-label'), b.getAttribute('aria-placeholder'), b.getAttribute('data-placeholder'), b.getAttribute('placeholder')]
      .filter(Boolean)
      .join(' ');

  /** Nearest container around a post box that holds its buttons (the dialog, or the inline composer). */
  function composerScope(box) {
    if (!box) return null;
    const dlg = box.closest('[role="dialog"]');
    if (dlg) return dlg;
    let el = box;
    for (let i = 0; i < 14 && el.parentElement; i++) {
      el = el.parentElement;
      if (postButton(el, true)) return el;
    }
    return box.closest('form') || box.parentElement;
  }

  function postButton(scope, any = false) {
    if (!scope) return null;
    const btns = $$('[role="button"], button', scope).filter(visible);
    const label = (b) => (b.getAttribute('aria-label') || textOf(b)).trim();
    return btns.find((b) => POST_RE.test(label(b))) || (any ? null : btns.find((b) => NEXT_RE.test(label(b)))) || null;
  }

  /** The open post box (Facebook uses a Lexical editor), not a comment or chat box. */
  function composerBox() {
    const boxes = $$('[contenteditable="true"]').filter((b) => {
      if (!(b.getAttribute('role') === 'textbox' || b.hasAttribute('data-lexical-editor'))) return false;
      if (!visible(b) || b.closest('#ritpost-fb')) return false;
      const label = boxLabel(b);
      if (NOT_POSTBOX_RE.test(label) && !POSTBOX_RE.test(label)) return false;
      if (b.closest('[role="dialog"]')) return true;
      return POSTBOX_RE.test(label);
    });
    return boxes.find((b) => b.closest('[role="dialog"]') && postButton(b.closest('[role="dialog"]'))) || boxes[0] || null;
  }

  /** Candidates for the "Write something…" / "What's on your mind?" prompt, best first. */
  function triggerCandidates() {
    const main = document.querySelector('[role="main"]') || document.body;
    const out = [];
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (PROMPT_RE.test(n.nodeValue.trim()) && n.nodeValue.trim().length < 80 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const host = n.parentElement;
      if (!host || host.closest('#ritpost-fb') || host.closest('[contenteditable="true"]')) continue;
      const btn = host.closest('[role="button"], button, a[role="link"]') || host;
      if (!visible(btn) || out.includes(btn)) continue;
      out.push(btn);
    }
    // Inputs that act as the prompt (older layouts).
    for (const el of $$('[aria-label], [placeholder]', main)) {
      const l = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
      if (PROMPT_RE.test(l.trim()) && visible(el) && !out.includes(el) && el.getAttribute('contenteditable') !== 'true') out.push(el);
    }
    const inView = (el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < innerHeight;
    };
    return out.sort((a, b) => Number(inView(b)) - Number(inView(a)) || a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }

  /** Try to open the post box. Returns true when it is open. */
  async function openComposer() {
    if (composerBox()) return true;
    const cands = await waitFor(() => {
      const c = triggerCandidates();
      return c.length ? c : null;
    }, 15000, 400);
    if (!cands) return false;
    for (const el of cands.slice(0, 3)) {
      el.scrollIntoView({ block: 'center' });
      await sleep(300);
      for (const click of CLICKS) {
        if (!el.isConnected) break;
        try {
          click(el);
        } catch {
          /* try the next way */
        }
        if (await waitFor(composerBox, 3500, 200)) return true;
      }
    }
    return !!composerBox();
  }

  /** Admins viewing their Page get a "Switch now" prompt; clicking it switches to the Page's profile. */
  function switchButton() {
    const main = document.querySelector('[role="main"]') || document.body;
    return (
      $$('[role="button"], button, a', main).find((b) => {
        if (!visible(b)) return false;
        const l = (b.getAttribute('aria-label') || textOf(b)).trim();
        return /^(switch( now)?|switch to page|switch profile|switch into .{1,60})$/i.test(l);
      }) || null
    );
  }

  // Facebook messages that mean "stop posting now".
  const BLOCK_RE =
    /(temporarily blocked|you['’]re temporarily|you can['’]t (post|use this feature|do this|share)( right now)?|this feature is temporarily|we limit how often|action blocked|restricted from (posting|sharing)|your account (is|has been) (restricted|limited)|going too fast|misusing this feature|try again later)/i;
  const ERROR_RE = /(couldn['’]t (be )?(post|share)|could not (be )?(post|share)|post (failed|wasn['’]t shared)|something went wrong)/i;

  function facebookMessage(re) {
    const box = composerBox();
    for (const el of $$('[role="dialog"], [role="alertdialog"], [role="alert"], [role="status"]')) {
      if (!visible(el) || el.closest('#ritpost-fb') || (box && el.contains(box))) continue;
      const t = textOf(el);
      if (t.length < 500 && re.test(t)) return t.slice(0, 220);
    }
    return null;
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

  async function fillText(text) {
    if (!text) return true;
    const want = loose(text).slice(0, 40);
    let box = composerBox();
    if (!box) return false;
    if (loose(textOf(box)).includes(want)) return true;
    insertText(box, text);
    await sleep(500);
    box = composerBox() || box;
    if (loose(textOf(box)).includes(want)) return true;
    // Fallback: type it, one line at a time.
    box.focus();
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (line) document.execCommand('insertText', false, line);
      if (i < lines.length - 1) document.execCommand('insertParagraph', false, null);
    });
    await sleep(500);
    return loose(textOf(composerBox() || box)).includes(want);
  }

  /** Thumbnails of attached media in the composer. */
  const mediaCount = (scope) => (scope ? $$('img[src^="blob:"], video, img[src^="data:"]', scope).filter(visible).length : 0);

  async function attachMedia(files) {
    if (!files.length) return { ok: true };
    const scope = () => composerScope(composerBox());
    if (!scope()) return { ok: false };
    const before = mediaCount(scope());
    const done = () => mediaCount(scope()) > before;
    const mediaInput = () => $$('input[type="file"]', scope() || document).find((i) => /image|video/i.test(i.accept || '') || !i.accept);
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
    const photoBtn = $$('[role="button"], [aria-label]', scope() || document).find(
      (b) => visible(b) && /photo\s*\/\s*video|^photo|add photos/i.test(b.getAttribute('aria-label') || '')
    );
    if (photoBtn) {
      photoBtn.click();
      await sleep(800);
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

  // ─────────────── the Post click ───────────────
  let lastPostClick = 0;
  document.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted) return;
      const b = e.target.closest?.('[role="button"], button');
      if (!b) return;
      const l = (b.getAttribute('aria-label') || textOf(b)).trim();
      if (POST_RE.test(l) && composerScope(composerBox())?.contains(b)) lastPostClick = Date.now();
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
        .card{font:13px/1.45 "Segoe UI",Roboto,Helvetica,Arial,sans-serif;width:310px;background:#fff;color:#0f172a;border-radius:12px;
          box-shadow:0 10px 30px rgba(15,23,42,.25);border:1px solid #e2e8f0;overflow:hidden}
        .head{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#0e7c66;color:#fff;font-weight:600}
        .head .mode{font-weight:500;font-size:11px;background:rgba(255,255,255,.18);border-radius:999px;padding:1px 7px}
        .head .meta{margin-left:auto;font-weight:400;opacity:.85;font-size:12px}
        .body{padding:10px 12px}
        .name{font-weight:600;margin-bottom:4px;word-break:break-word}
        .msg{color:#334155;white-space:pre-line}
        .msg.err{color:#b91c1c}
        .row{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
        button{font:inherit;border:1px solid #cbd5e1;background:#f8fafc;color:#0f172a;border-radius:8px;padding:5px 10px;cursor:pointer}
        button.primary{background:#0e7c66;border-color:#0e7c66;color:#fff}
        button.danger{color:#b91c1c}
        .bar{height:4px;background:#e2e8f0}.bar>div{height:100%;background:#14b88a;width:0;transition:width .3s}
        @media (prefers-color-scheme:dark){.card{background:#111c2e;color:#e2e8f0;border-color:#243247}.msg{color:#cbd5e1}.msg.err{color:#f87171}
          button{background:#1e293b;border-color:#334155;color:#e2e8f0}.bar{background:#243247}}
      </style>
      <div class="card"><div class="head">RitPost · Facebook <span class="mode"></span><span class="meta"></span></div><div class="bar"><div></div></div>
      <div class="body"><div class="name"></div><div class="msg"></div><div class="row"></div></div></div>`;
      document.documentElement.append(host);
    }
    function update({ meta = '', mode = '', name = '', msg = '', error = false, progress = 0, buttons = [] }) {
      mount();
      root.querySelector('.meta').textContent = meta;
      const m0 = root.querySelector('.mode');
      m0.textContent = mode;
      m0.hidden = !mode;
      root.querySelector('.name').textContent = name;
      const m = root.querySelector('.msg');
      m.textContent = msg;
      m.classList.toggle('err', error);
      root.querySelector('.bar>div').style.width = `${Math.round(progress * 100)}%`;
      root.querySelector('.row').replaceChildren(
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
  let session = 0; // bumps whenever the current preparation should be abandoned
  const timers = new Set();
  const every = (fn, ms) => {
    const t = setInterval(fn, ms);
    timers.add(t);
    return t;
  };
  const clearTimers = () => {
    timers.forEach(clearInterval);
    timers.clear();
  };

  const normPath = (u) => {
    try {
      const x = new URL(u, location.href);
      const id = x.pathname.includes('profile.php') ? `?id=${x.searchParams.get('id')}` : '';
      return x.pathname.replace(/\/+$/, '').toLowerCase() + id;
    } catch {
      return '';
    }
  };

  const meta = (run) => `${Math.min(run.index + 1, run.items.length)} of ${run.items.length}`;
  const progress = (run) => run.index / run.items.length;
  const modeTag = (run) => (run.mode === 'auto' ? 'Automatic' : 'Manual');

  async function stopRun(reason = '') {
    session++;
    clearTimers();
    const run = await getRun();
    if (!run || !['running', 'waiting'].includes(run.status)) return;
    run.status = 'stopped';
    run.stopReason = reason;
    run.finishedAt = Date.now();
    await setRun(run);
  }

  async function bumpDaily() {
    const { fbDaily } = await chrome.storage.local.get('fbDaily');
    const d = fbDaily?.day === today() ? fbDaily : { day: today(), count: 0 };
    d.count++;
    await chrome.storage.local.set({ fbDaily: d });
    return d.count;
  }
  async function dailyCount() {
    const { fbDaily } = await chrome.storage.local.get('fbDaily');
    return fbDaily?.day === today() ? fbDaily.count : 0;
  }

  async function record(status, error = '') {
    session++;
    clearTimers();
    const run = await getRun();
    if (!run || run.status !== 'running') return;
    const item = run.items[run.index];
    run.results.push({ id: item.id, name: item.name, kind: item.kind, status, error });
    if (status === 'posted') await bumpDaily();
    run.index++;
    if (run.index >= run.items.length) {
      run.status = 'done';
      run.finishedAt = Date.now();
    } else if (run.mode === 'auto' && status === 'posted' && (await dailyCount()) >= run.dailyLimit) {
      run.status = 'stopped';
      run.stopReason = `Daily limit reached (${run.dailyLimit} posts today). Continue tomorrow with “Select unposted”.`;
      run.finishedAt = Date.now();
    } else {
      // The pause only matters after a real post; skipped/failed ones move on quickly.
      let gap = 3;
      if (status === 'posted') {
        gap = run.mode === 'auto' ? Math.max(120, Number(run.intervalSec) || 300) * (1 + Math.random() * 0.3) : Math.max(30, Number(run.gapSec) || 60) * (1 + Math.random() * 0.2);
      }
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

  /** Watches for the composer closing after a Post click, and for Facebook block messages. */
  function watchForPost(base, my, onClosedWithoutPost) {
    let sawOpen = !!composerBox();
    every(async () => {
      if (my !== session) return;
      const block = facebookMessage(BLOCK_RE);
      if (block) return stopRun(`Facebook limited posting: “${block}”. RitPost stopped so your account isn’t restricted further. Wait a day before posting again.`);
      const open = !!composerBox();
      if (open) {
        sawOpen = true;
        return;
      }
      if (!sawOpen) return;
      sawOpen = false;
      if (Date.now() - lastPostClick < 180000) {
        await sleep(1500);
        const block2 = facebookMessage(BLOCK_RE);
        if (block2) return stopRun(`Facebook limited posting: “${block2}”. RitPost stopped so your account isn’t restricted further.`);
        const err = facebookMessage(ERROR_RE);
        if (err) return record('failed', err);
        return record('posted');
      }
      onClosedWithoutPost();
    }, 700);
  }

  async function prepare(run) {
    const my = ++session;
    const alive = () => my === session;
    const item = run.items[run.index];
    const base = { meta: meta(run), mode: modeTag(run), name: item.name, progress: progress(run) };
    const stopBtn = { label: 'Stop', kind: 'danger', run: () => stopRun() };
    const skipBtn = { label: 'Skip', run: () => record('skipped') };
    const retry = () => {
      busy = false;
      tick(true);
    };
    const fail = (msg) => ui.update({ ...base, msg, error: true, buttons: [{ label: 'Try again', kind: 'primary', run: retry }, skipBtn, stopBtn] });

    ui.update({ ...base, msg: 'Opening the post box…', buttons: [skipBtn, stopBtn] });

    let files = [];
    try {
      files = await loadFiles(run.attachmentIds);
    } catch (e) {
      return fail(e.message);
    }
    const media = files.filter((f) => /^(image|video)\//.test(f.type));
    const skippedDocs = files.length - media.length;

    // Pages: switch into the Page's profile first when Facebook offers it.
    if (item.kind === 'page' && !composerBox()) {
      const sw = await waitFor(() => switchButton() || (triggerCandidates().length ? 'has-prompt' : null), 12000, 400);
      if (!alive()) return;
      if (sw && sw !== 'has-prompt' && run.switchedFor !== run.index) {
        ui.update({ ...base, msg: 'Switching to the Page’s profile so the post comes from your Page…', buttons: [skipBtn, stopBtn] });
        run.switchedFor = run.index;
        run.switchedToPage = true;
        run.navAt = Date.now();
        await setRun(run);
        sw.click();
        await sleep(1200);
        if (switchButton()) fireClick(switchButton());
        // Facebook reloads the page after switching; this script then starts again.
        await sleep(12000);
        if (!alive()) return;
        // No reload happened (e.g. Facebook switched in place): reload so the Page's post box shows.
        if (!composerBox() && !triggerCandidates().length) location.reload();
        else {
          busy = false;
          tick(true);
        }
        return;
      }
    }

    // Open the composer.
    if (!(await openComposer())) {
      if (!alive()) return;
      if (!triggerCandidates().length) {
        return fail(
          item.kind === 'page'
            ? 'No post box on this Page. Switch to the Page’s profile on Facebook (your profile picture → the Page), then click Try again.'
            : 'No “Write something…” box here. Make sure you’re a member of this group and it allows posts, then click Try again.'
        );
      }
      // Facebook ignored the automatic click: let the user open it; RitPost carries on by itself.
      ui.update({ ...base, msg: 'Click “Write something…” on the page. RitPost fills in your post as soon as it opens.', buttons: [skipBtn, stopBtn] });
      const opened = await waitFor(() => !alive() || composerBox(), 10 * 60 * 1000, 400);
      if (!alive() || !opened) return;
    }
    if (!alive()) return;
    await sleep(700);

    if (!(await fillText(item.text))) return fail('Couldn’t type the message into the post box. Click inside it and Try again.');
    if (!alive()) return;

    let note = '';
    if (media.length) {
      ui.update({ ...base, msg: `Attaching ${media.length} photo/video file(s)…`, buttons: [skipBtn, stopBtn] });
      const res = await attachMedia(media);
      if (!alive()) return;
      if (!res.ok) note += '\nAttachments couldn’t be added automatically; add them with Photo/video before posting.';
    }
    if (skippedDocs) note += `\n${skippedDocs} document(s) left out (Facebook gets photos and videos only).`;

    lastPostClick = 0;
    const closedWithoutPost = () =>
      ui.update({
        ...base,
        msg: 'The post box was closed without posting.',
        error: true,
        buttons: [{ label: 'Fill again', kind: 'primary', run: retry }, skipBtn, stopBtn],
      });

    const manualWait = (extra = '') => {
      ui.update({ ...base, msg: `Check the post, then click Post on Facebook.${extra}${note}`, buttons: [skipBtn, stopBtn] });
      watchForPost(base, my, closedWithoutPost);
    };

    if (run.mode !== 'auto') return manualWait();
    if (note.includes('couldn’t be added')) return manualWait('\n(Automatic posting paused for this one.)');

    // ── Automatic: review countdown, then RitPost clicks Post. ──
    let left = Math.max(5, Number(run.reviewSec) || 10);
    let held = false;
    const hold = () => {
      held = true;
      clearTimers();
      manualWait('\n(Held: you post this one yourself.)');
    };
    const draw = () =>
      ui.update({
        ...base,
        msg: `Posting automatically in ${left} s. Check the post now.${note}`,
        buttons: [{ label: 'Post now', kind: 'primary', run: () => (left = 0) }, { label: 'Hold', run: hold }, skipBtn, stopBtn],
      });
    draw();
    watchForPost(base, my, closedWithoutPost); // the user may still post or close it themselves
    while (left > 0) {
      await sleep(1000);
      if (!alive() || held) return;
      if (!composerBox()) return; // the user posted or closed it; the watcher handles it
      left = Math.max(0, left - 1);
      draw();
    }
    if (!alive() || held) return;

    if ((await dailyCount()) >= run.dailyLimit) return stopRun(`Daily limit reached (${run.dailyLimit} posts today). Continue tomorrow with “Select unposted”.`);

    ui.update({ ...base, msg: 'Waiting for uploads to finish, then posting…', buttons: [skipBtn, stopBtn] });
    const ready = () => {
      const b = postButton(composerScope(composerBox()));
      return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled ? b : null;
    };
    let btn = await waitFor(() => !alive() || ready(), 180000, 500);
    if (!alive()) return;
    if (!btn || btn === true) return manualWait('\nThe Post button didn’t become available. Post it yourself or Skip.');

    for (let step = 0; step < 3 && alive(); step++) {
      const label = (btn.getAttribute('aria-label') || textOf(btn)).trim();
      lastPostClick = POST_RE.test(label) ? Date.now() : lastPostClick;
      for (const click of CLICKS.slice(0, 3)) {
        click(btn);
        const moved = await waitFor(() => !composerBox() || (ready() && ready() !== btn) || facebookMessage(BLOCK_RE), 4000, 250);
        if (moved) break;
      }
      if (!composerBox() || facebookMessage(BLOCK_RE)) return; // the watcher records the result
      // "Next" leads to another step with the real Post button.
      if (NEXT_RE.test(label)) {
        btn = await waitFor(ready, 8000, 300);
        if (!btn) break;
        continue;
      }
      break;
    }
    if (alive() && composerBox()) manualWait('\nRitPost couldn’t click Post here. Click it yourself, or Skip.');
  }

  function showCountdown(run) {
    clearTimers();
    const next = run.items[run.index];
    const last = run.results.at(-1);
    const draw = () => {
      const left = Math.max(0, Math.ceil((run.nextAt - Date.now()) / 1000));
      const mm = left >= 60 ? `${Math.floor(left / 60)} min ${left % 60} s` : `${left} s`;
      ui.update({
        meta: meta(run),
        mode: modeTag(run),
        name: `Next: ${next.name}`,
        msg:
          last?.status === 'posted'
            ? `Posted to ${last.name}. Opening the next one in ${mm}. The pause keeps Facebook from treating your posts as spam.`
            : `${last?.status === 'failed' ? 'Failed' : 'Skipped'}: ${last?.name || ''}. Opening the next one in ${mm}.`,
        progress: progress(run),
        buttons: [{ label: 'Stop', kind: 'danger', run: () => stopRun() }],
      });
      if (left <= 0) {
        clearTimers();
        goToCurrent(run);
      }
    };
    draw();
    every(draw, 1000);
  }

  function showFinished(run) {
    const posted = run.results.filter((r) => r.status === 'posted').length;
    const head = run.status === 'done' ? `Finished: ${posted} of ${run.items.length} posted.` : `Stopped: ${posted} of ${run.items.length} posted.`;
    let msg = run.stopReason || 'You can close this.';
    if (run.switchedToPage) msg += '\nYou’re now using Facebook as your Page. To switch back: profile picture → your name.';
    ui.update({
      mode: modeTag(run),
      name: head,
      msg,
      error: !!run.stopReason,
      progress: run.status === 'done' ? 1 : progress(run),
      buttons: [
        {
          label: 'Close',
          kind: 'primary',
          run: async () => {
            ui.unmount();
            const r = await getRun();
            if (r) setRun({ ...r, dismissed: true });
          },
        },
      ],
    });
  }

  async function tick(force = false) {
    const run = await getRun();
    if (myTabId == null) myTabId = (await bg('BG_FB_TABID'))?.tabId ?? null;
    if (!run || run.tabId !== myTabId) {
      session++;
      clearTimers();
      ui.unmount();
      return;
    }
    if (run.status === 'done' || run.status === 'stopped') {
      session++;
      clearTimers();
      if (run.dismissed || Date.now() - (run.finishedAt || 0) > 30 * 60 * 1000) ui.unmount();
      else showFinished(run);
      return;
    }
    if (run.status === 'waiting') {
      session++;
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
      ui.update({
        meta: meta(run),
        mode: modeTag(run),
        name: item.name,
        msg: `Something went wrong: ${e?.message || e}`,
        error: true,
        buttons: [
          { label: 'Skip', run: () => record('failed', String(e?.message || e)) },
          { label: 'Stop', kind: 'danger', run: () => stopRun() },
        ],
      });
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

  // ─────────────── importing groups and Pages ───────────────
  const RESERVED_GROUP = new Set(['feed', 'discover', 'joins', 'create', 'notifications', 'search', 'explore', 'your_groups', 'manage', 'membership', 'learn']);
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
      if (!m || RESERVED_GROUP.has(m[1].toLowerCase())) continue;
      const name = textOf(a).split(/\s*(Last active|You last visited|Active)\b/)[0].trim();
      if (!name || name.length > 120 || /^(view group|see all|visit group)$/i.test(name)) continue;
      const prev = found.get(m[1]);
      if (!prev || name.length > prev.name.length) found.set(m[1], { name, url: `https://www.facebook.com/groups/${m[1]}/` });
    }
    return [...found.values()];
  }

  const RESERVED_PATH = new RegExp(
    '^(pages|groups|watch|marketplace|gaming|events|friends|messages|notifications|bookmarks|settings|help|policies|privacy|business|ads|adsmanager|' +
      'latest|reel|reels|stories|story\\.php|photo|photo\\.php|photos|saved|memories|fundraisers|home\\.php|login|me|search|hashtag|people|places|jobs|' +
      'l\\.php|sharer|dialog|plugins|about|careers|lite|mobile|legal|terms|cookies|permalink\\.php|video|videos|live|offers|weather|games|pg|' +
      'professional_dashboard|latest_activity|creatorstudio|commerce|business_help|composer|onthisday|media|profile\\.php)$',
    'i'
  );
  const NOT_A_NAME = /^(switch( now)?|see (more|all)|create( a)? post|view page|promote|boost( post)?|notifications?|messages?|insights|manage|more|edit|settings|create (new )?page|ad center|meta business suite|followers?|likes?|\d[\d.,]*\s*[km]?)$/i;

  function collectPages() {
    const main = document.querySelector('[role="main"]') || document.body;
    const found = new Map();
    for (const a of $$('a[href]', main)) {
      let u;
      try {
        u = new URL(a.href, location.href);
      } catch {
        continue;
      }
      if (!/(^|\.)facebook\.com$/i.test(u.hostname)) continue;
      let key, url;
      if (/^\/profile\.php\/?$/i.test(u.pathname) && u.searchParams.get('id')) {
        key = u.searchParams.get('id');
        url = `https://www.facebook.com/profile.php?id=${key}`;
      } else {
        const m = u.pathname.match(/^\/([A-Za-z0-9.\-_]{2,})\/?$/);
        if (!m || RESERVED_PATH.test(m[1])) continue;
        key = m[1].toLowerCase();
        url = `https://www.facebook.com/${m[1]}`;
      }
      const name = (textOf(a) || a.getAttribute('aria-label') || '').trim();
      if (!name || name.length > 100 || NOT_A_NAME.test(name)) continue;
      const prev = found.get(key);
      if (!prev || (name.length > prev.name.length && name.length < 80)) found.set(key, { name, url });
    }
    return [...found.values()];
  }

  async function scan(kind) {
    const collect = kind === 'pages' ? collectPages : collectGroups;
    await waitFor(() => collect().length, 15000, 500);
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 25 && stable < 3; i++) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(1200);
      const n = collect().length;
      stable = n === last ? stable + 1 : 0;
      last = n;
    }
    window.scrollTo(0, 0);
    return collect();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'FB_PING') {
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === 'FB_SCAN') {
      if (/\/login|checkpoint/.test(location.pathname) || document.querySelector('input[name="pass"]'))
        sendResponse({ ok: false, error: 'Sign in to Facebook in this tab first, then import again.' });
      else
        scan(msg.kind).then(
          (items) => sendResponse({ ok: true, items, groups: items }),
          (e) => sendResponse({ ok: false, error: e?.message || String(e) })
        );
      return true;
    }
    return false;
  });

  tick();
})();
