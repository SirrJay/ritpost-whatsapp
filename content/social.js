/*
 * RitPost — Instagram and X content script (instagram.com, x.com)
 *
 * Posts one prepared post from RitPost ("socialRun" in chrome.storage.local):
 *  - Instagram feed post / carousel / Reel: opens Create → Post, adds the photos/videos,
 *    picks the crop, steps through to the caption, fills it in.
 *  - Instagram Story (beta): in RitPost's phone-sized window, adds the photo to your story.
 *  - X: fills the composer (text, up to 4 photos or 1 video, or a thread).
 *
 *  Manual mode: the USER clicks Share / Post. Automatic: RitPost clicks it after a review
 *  countdown the user can hold or cancel. Only the tab the run belongs to acts on it.
 */
(() => {
  if (window.__ritpostSocial) return;
  window.__ritpostSocial = true;

  const HOST = location.hostname.replace(/^www\./, '');
  const PLATFORM = /instagram\.com$/.test(HOST) ? 'instagram' : /(^|\.)x\.com$|twitter\.com$/.test(HOST) ? 'x' : null;
  if (!PLATFORM) return;

  // ─────────────── helpers ───────────────
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
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
      if (!alive()) return null;
      let v;
      try {
        v = fn();
      } catch {
        v = null;
      }
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }
  function fireClick(el) {
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const p = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerover', p));
    el.dispatchEvent(new PointerEvent('pointerdown', p));
    el.dispatchEvent(new MouseEvent('mousedown', base));
    el.dispatchEvent(new PointerEvent('pointerup', { ...p, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0, detail: 1 }));
  }
  const clickable = (el) => el?.closest('a, button, [role="button"], [role="link"], [role="menuitem"]') || el;
  const buttonsIn = (root) => $$('button, [role="button"]', root || document).filter(visible);
  const byText = (root, re) => buttonsIn(root).find((b) => re.test(textOf(b)) || re.test(b.getAttribute('aria-label') || ''));
  const isDisabled = (b) => !b || b.disabled || b.getAttribute('aria-disabled') === 'true';

  const getRun = async () => (await chrome.storage.local.get('socialRun')).socialRun || null;
  const setRun = (run) => chrome.storage.local.set({ socialRun: run });
  const bg = (type, payload = {}) => chrome.runtime.sendMessage({ type, payload }).catch(() => null);

  async function loadFiles(ids) {
    if (!ids?.length) return [];
    const { attachments, schedFiles } = await chrome.storage.local.get(['attachments', 'schedFiles']);
    const byId = new Map([...(attachments || []), ...Object.values(schedFiles || {})].map((a) => [a.id, a]));
    return ids.map((id) => {
      const a = byId.get(id);
      if (!a?.data) throw new Error('An attachment is missing. Attach the file again in RitPost.');
      const bin = atob(a.data.slice(a.data.indexOf(',') + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new File([bytes], a.name, { type: a.type || 'application/octet-stream', lastModified: Date.now() });
    });
  }

  function setFiles(input, files) {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Paste text into a rich text box (Lexical on Instagram, Draft.js on X); falls back to typing. */
  async function fillBox(box, text) {
    if (box.tagName === 'TEXTAREA' || box.tagName === 'INPUT') {
      // React-controlled field: set the value through the native setter, then tell React.
      box.focus();
      const proto = box.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(300);
      if (box.value === text) return true;
      box.select();
      document.execCommand('insertText', false, text);
      await sleep(300);
      return box.value === text;
    }
    box.focus();
    await sleep(150);
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(500);
    const probe = text.replace(/\s+/g, ' ').trim().slice(0, 24);
    if (textOf(box).includes(probe)) return true;
    box.focus();
    document.execCommand('insertText', false, text);
    await sleep(400);
    return textOf(box).includes(probe);
  }

  // ─────────────── overlay ───────────────
  const ui = (() => {
    let host, root;
    const THEME = PLATFORM === 'instagram' ? 'linear-gradient(90deg,#f58529,#dd2a7b 50%,#8134af)' : '#0f1419';
    function mount() {
      if (host?.isConnected) return;
      host = document.createElement('div');
      host.id = 'ritpost-social';
      host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;';
      root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>
        .card{font:13px/1.45 "Segoe UI",Roboto,Helvetica,Arial,sans-serif;width:320px;max-width:calc(100vw - 32px);background:#fff;color:#0f172a;border-radius:14px;
          box-shadow:0 12px 34px rgba(15,23,42,.3);border:1px solid #e2e8f0;overflow:hidden}
        .head{display:flex;align-items:center;gap:8px;padding:10px 12px;background:${THEME};color:#fff;font-weight:700}
        .head .mode{font-weight:600;font-size:11px;background:rgba(255,255,255,.22);border-radius:999px;padding:1px 8px}
        .head .x{margin-left:auto;background:none;border:0;color:#fff;cursor:pointer;font-size:14px;padding:0 4px}
        .body{padding:10px 12px}
        .name{font-weight:700;margin-bottom:4px}
        .msg{color:#334155;white-space:pre-line}
        .msg.err{color:#b91c1c}.msg.ok{color:#047857;font-weight:600}
        .count{font:700 26px/1 "Segoe UI",sans-serif;margin:6px 0 2px;color:#0f172a}
        .row{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
        button.b{font:inherit;border:1px solid #cbd5e1;background:#f8fafc;color:#0f172a;border-radius:8px;padding:5px 11px;cursor:pointer;font-weight:600}
        button.primary{background:#0e7c66;border-color:#0e7c66;color:#fff}
        button.danger{color:#b91c1c}
        .bar{height:4px;background:#e2e8f0}.bar>div{height:100%;background:#14b88a;width:0;transition:width .3s}
        @media (prefers-color-scheme:dark){.card{background:#111c2e;color:#e2e8f0;border-color:#243247}.msg{color:#cbd5e1}.count{color:#fff}.msg.err{color:#f87171}.msg.ok{color:#34d399}
          button.b{background:#1e293b;border-color:#334155;color:#e2e8f0}.bar{background:#243247}}
      </style>
      <div class="card"><div class="head"><span class="ttl"></span><span class="mode"></span><button class="x" title="Hide" aria-label="Hide">✕</button></div><div class="bar"><div></div></div>
      <div class="body"><div class="name"></div><div class="count" hidden></div><div class="msg"></div><div class="row"></div></div></div>`;
      root.querySelector('.x').addEventListener('click', () => (host.style.display = 'none'));
      document.documentElement.append(host);
    }
    function update({ title = '', mode = '', name = '', msg = '', tone = '', progress = 0, count = null, buttons = [] }) {
      mount();
      host.style.display = '';
      root.querySelector('.ttl').textContent = title || `RitPost · ${PLATFORM === 'instagram' ? 'Instagram' : 'X'}`;
      const m0 = root.querySelector('.mode');
      m0.textContent = mode;
      m0.hidden = !mode;
      root.querySelector('.name').textContent = name;
      const c = root.querySelector('.count');
      c.hidden = count === null;
      c.textContent = count === null ? '' : `${count}s`;
      const m = root.querySelector('.msg');
      m.textContent = msg;
      m.className = `msg ${tone}`;
      root.querySelector('.bar>div').style.width = `${Math.round(progress * 100)}%`;
      root.querySelector('.row').replaceChildren(
        ...buttons.map((b) => {
          const el = document.createElement('button');
          el.className = `b ${b.kind || ''}`;
          el.textContent = b.label;
          el.addEventListener('click', b.run);
          return el;
        })
      );
    }
    const unmount = () => host?.remove();
    return { update, unmount };
  })();

  let ringed = null;
  function ring(el) {
    unring();
    if (!el) return;
    ringed = { el, outline: el.style.outline, offset: el.style.outlineOffset, shadow: el.style.boxShadow };
    el.style.outline = '3px solid #14b88a';
    el.style.outlineOffset = '3px';
    el.style.boxShadow = '0 0 0 8px rgba(20,184,138,.25)';
    el.scrollIntoView?.({ block: 'nearest' });
  }
  function unring() {
    if (!ringed) return;
    Object.assign(ringed.el.style, { outline: ringed.outline, outlineOffset: ringed.offset, boxShadow: ringed.shadow });
    ringed = null;
  }

  let titleTimer = null;
  function flashTitle(text) {
    clearInterval(titleTimer);
    const original = document.title;
    let on = false;
    titleTimer = setInterval(() => {
      on = !on;
      document.title = on ? text : original;
    }, 1000);
    return () => {
      clearInterval(titleTimer);
      document.title = original;
    };
  }

  // ─────────────── run control ───────────────
  let myTabId = null;
  let session = 0;
  let current = 0;
  const alive = () => current === session;
  const kindLabel = (run) =>
    PLATFORM === 'x' ? (run.thread?.length > 1 ? `Thread · ${run.thread.length} posts` : 'Post') : run.kind === 'story' ? 'Story' : run.attachmentIds?.length > 1 ? `Carousel · ${run.attachmentIds.length}` : run.isVideo ? 'Reel' : 'Post';
  const modeTag = (run) => (run.mode === 'auto' ? 'Automatic' : 'Manual');

  async function finish(status, extra = {}) {
    session++;
    unring();
    const run = await getRun();
    if (!run || run.status !== 'running') return;
    await setRun({ ...run, ...extra, status, finishedAt: Date.now() });
  }
  const fail = (error) => finish('failed', { error });

  /** The user clicked Share/Post themselves (a real click). */
  let lastUserPost = 0;
  const POST_WORD = PLATFORM === 'instagram' ? /^(share|add to your story|your story|share to story)$/i : /^(post|post all|reply|tweet|tweet all)$/i;
  document.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted) return;
      const b = e.target.closest?.('button, [role="button"]');
      if (!b) return;
      // X's side menu also has a "Post" button: it only opens a new composer.
      if (PLATFORM === 'x' && b.closest('nav, header, [role="navigation"], [role="banner"]')) return;
      const label = textOf(b) || b.getAttribute('aria-label') || '';
      if (POST_WORD.test(label) || /tweetButton/.test(b.getAttribute('data-testid') || '')) lastUserPost = Date.now();
    },
    true
  );

  /** Countdown before an automatic click; resolves 'go' | 'cancel' | 'stale'. */
  function countdown(run, base, seconds, what) {
    return new Promise((resolve) => {
      let left = Math.max(3, seconds);
      let held = false;
      const my = session;
      const paint = () =>
        ui.update({
          ...base,
          count: held ? null : left,
          msg: held ? `Held. Check the post, then click “${what} now”, or click ${what} on ${PLATFORM === 'x' ? 'X' : 'Instagram'} yourself.` : `Check the post. RitPost clicks ${what} when the countdown ends.`,
          buttons: [
            { label: `${what} now`, kind: 'primary', run: () => done('go') },
            held ? { label: 'Resume', run: () => ((held = false), paint()) } : { label: 'Hold', run: () => ((held = true), paint()) },
            { label: 'Cancel', kind: 'danger', run: () => done('cancel') },
          ],
        });
      const t = setInterval(() => {
        if (my !== session) return done('stale');
        if (Date.now() - lastUserPost < 5000) return done('user');
        if (held) return;
        left--;
        if (left <= 0) return done('go');
        paint();
      }, 1000);
      function done(v) {
        clearInterval(t);
        resolve(v);
      }
      paint();
    });
  }

  // ─────────────── Instagram ───────────────
  const igDialogs = () => $$('[role="dialog"]').filter(visible);
  const igCreateDialog = () => igDialogs().find((d) => /create new post|crop|edit|new reel|create new reel|discard/i.test(textOf(d).slice(0, 120)) || d.querySelector('input[type="file"]'));
  const igNext = (d) => byText(d, /^next$/i);
  const igShare = (d) => byText(d, /^share$/i);
  const igCaption = (d) => (d || document).querySelector('[aria-label^="Write a caption" i], [aria-label^="Add a caption" i], [role="dialog"] [contenteditable="true"][role="textbox"]');
  const IG_ERROR = /(couldn['’]t|could not|can['’]t|something went wrong|try again|not supported|isn['’]t supported|too (long|large|short)|failed)/i;
  const igSignedOut = () => /\/accounts\/login|\/challenge/.test(location.pathname) || !!document.querySelector('input[name="username"][type="text"], form#loginForm');

  async function igOpenCreate() {
    if (igCreateDialog()?.querySelector('input[type="file"]')) return true;
    const navIcon = await waitFor(() => $$('svg[aria-label="New post"], svg[aria-label="Create"], svg[aria-label="New Post"]').find((s) => visible(clickable(s))), 20000);
    if (!navIcon) return false;
    clickable(navIcon).click();
    // Newer layouts open a small menu: Post / Live video / Ad.
    const sub = await waitFor(() => $$('svg[aria-label="Post"]').find((s) => visible(clickable(s)) && !s.closest('article')) || igCreateDialog()?.querySelector('input[type="file"]'), 4000);
    if (sub && sub.tagName?.toLowerCase() === 'svg') clickable(sub).click();
    return !!(await waitFor(() => igCreateDialog()?.querySelector('input[type="file"]'), 10000));
  }

  async function igChooseCrop(d, ratio) {
    const want = { original: /^original$/i, '1:1': /^1:1$/, '4:5': /^4:5$/, '16:9': /^16:9$/ }[ratio];
    if (!want) return;
    const icon = d.querySelector('svg[aria-label="Select crop"]');
    if (!icon) return;
    const optionBtn = () => byText(d, want);
    if (!optionBtn()) {
      fireClick(icon);
      await waitFor(optionBtn, 2500);
    }
    const opt = optionBtn();
    if (opt) {
      opt.click();
      await sleep(400);
      // Close the little menu again.
      if (byText(d, /^original$/i)) fireClick(icon);
      await sleep(300);
    }
  }

  async function igPost(run, base) {
    if (igSignedOut()) return fail('Sign in to Instagram in this tab first, then try again.');
    ui.update({ ...base, msg: 'Opening Create → Post…', progress: 0.1, buttons: [stopBtn()] });
    let files;
    try {
      files = await loadFiles(run.attachmentIds);
    } catch (e) {
      return fail(e.message);
    }
    if (!files.length) return fail('Instagram posts need at least one photo or video.');
    if (!(await igOpenCreate())) return alive() && fail('Couldn’t open Instagram’s Create window. Make sure you’re signed in, then try again.');
    if (!alive()) return;
    const input = igCreateDialog().querySelector('input[type="file"]');
    ui.update({ ...base, msg: `Adding ${files.length > 1 ? `${files.length} files` : 'your file'}…`, progress: 0.25, buttons: [stopBtn()] });
    setFiles(input, files);

    // Wait for the crop step (or an error / the "shared as reels" notice).
    const step = await waitFor(() => {
      const d = igCreateDialog();
      const all = igDialogs();
      const ok = all.map((x) => byText(x, /^ok$/i)).find(Boolean);
      if (ok && /reel/i.test(textOf(ok.closest('[role="dialog"]')))) {
        ok.click();
        return null;
      }
      const errD = all.find((x) => IG_ERROR.test(textOf(x).slice(0, 200)) && !igNext(x));
      if (errD) return { error: textOf(errD).slice(0, 160) };
      if (d && igNext(d)) return { d };
      return null;
    }, 30000);
    if (!alive()) return;
    if (!step) return fail('Instagram didn’t accept the files. Use JPG/PNG photos or MP4/MOV videos.');
    if (step.error) return fail(`Instagram: ${step.error}`);

    if (run.crop) {
      ui.update({ ...base, msg: `Setting the crop to ${run.crop === 'original' ? 'Original' : run.crop}…`, progress: 0.35, buttons: [stopBtn()] });
      await igChooseCrop(step.d, run.crop);
    }

    // Next → (Edit) → Next → caption.
    const curDialog = () => igCreateDialog() || igDialogs()[0];
    for (let i = 0; i < 4 && alive() && !igCaption(curDialog()); i++) {
      const d = curDialog();
      const next = d && igNext(d);
      if (!next) {
        await sleep(800);
        continue;
      }
      const title = textOf(d).slice(0, 40);
      next.click();
      ui.update({ ...base, msg: 'Going to the caption…', progress: 0.45 + i * 0.1, buttons: [stopBtn()] });
      await waitFor(() => igCaption(curDialog()) || (curDialog() && textOf(curDialog()).slice(0, 40) !== title), 12000);
    }
    const box = igCaption(curDialog());
    if (!alive()) return;
    if (!box) return fail('Couldn’t reach the caption step on Instagram.');

    if (run.caption) {
      ui.update({ ...base, msg: 'Writing the caption…', progress: 0.7, buttons: [stopBtn()] });
      const ok = await fillBox(box, run.caption);
      if (!ok && alive()) return fail('Couldn’t write the caption on Instagram.');
    }
    if (!alive()) return;
    const dialog = box.closest('[role="dialog"]') || igCreateDialog();
    const share = await waitFor(() => igShare(dialog), 8000);
    if (!share) return fail('Couldn’t find the Share button on Instagram.');
    await confirmAndPublish(run, base, share, 'Share', () => igOutcome(dialog));
  }

  /** After Share: wait for "Your post has been shared" (or an error). */
  async function igOutcome(dialog) {
    const res = await waitFor(() => {
      const all = igDialogs();
      const t = all.map((d) => textOf(d).slice(0, 300)).join(' | ');
      if (/(post|reel|story) (has been |was )?shared|your (post|reel) has been shared|added to your story/i.test(t)) return { ok: true };
      const errD = all.find((d) => IG_ERROR.test(textOf(d).slice(0, 200)) && !igShare(d) && !/sharing/i.test(textOf(d).slice(0, 60)));
      if (errD) return { error: textOf(errD).slice(0, 160) };
      if (!dialog.isConnected && !all.length) return { ok: true, closed: true };
      return null;
    }, 5 * 60 * 1000, 600);
    return res || { error: 'Instagram didn’t confirm the post within 5 minutes. Check your profile.' };
  }

  // ─────────────── Instagram Story (beta, phone-sized window) ───────────────
  async function igStory(run, base) {
    if (igSignedOut()) return fail('Sign in to Instagram in this window first, then try again.');
    let files;
    try {
      files = await loadFiles(run.attachmentIds.slice(0, 1));
    } catch (e) {
      return fail(e.message);
    }
    if (!files.length) return fail('A Story needs a photo or video.');
    ui.update({ ...base, msg: 'Opening “Your story”…', progress: 0.2, buttons: [saveFileBtn(files[0]), stopBtn()] });
    const storyInput = () => $$('input[type="file"]').find((i) => /image|video/.test(i.accept || '') && !i.closest('[role="dialog"]'));
    let input = await waitFor(storyInput, 6000);
    if (!input && alive()) {
      // Tap "Your story" / the camera to make the story picker appear.
      const tap = $$('[aria-label], a, button, [role="button"]').find((el) => visible(el) && /^(your story|add to story|new story|camera|story)$/i.test((el.getAttribute('aria-label') || textOf(el)).trim()));
      if (tap) clickable(tap).click();
      input = await waitFor(storyInput, 8000);
    }
    if (!alive()) return;
    if (!input) return storyByHand(run, base, files[0]);
    setFiles(input, files);
    ui.update({ ...base, msg: 'Preparing your story…', progress: 0.5, buttons: [saveFileBtn(files[0]), stopBtn()] });
    const addBtn = await waitFor(() => byText(document, /^(add to your story|your story|share to story)$/i), 20000);
    if (!alive()) return;
    if (!addBtn) return storyByHand(run, base, files[0]);
    await confirmAndPublish(run, base, addBtn, 'Add to story', async () => {
      const r = await waitFor(() => (!addBtn.isConnected || /added to your story|story (was )?shared/i.test(textOf(document.body).slice(0, 4000)) ? { ok: true } : null), 3 * 60 * 1000, 600);
      return r || { error: 'Instagram didn’t confirm the story. Check your profile.' };
    });
  }

  function saveFileBtn(file) {
    return {
      label: 'Save photo',
      run: () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(file);
        a.download = file.name;
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      },
    };
  }

  function storyByHand(run, base, file) {
    ui.update({
      ...base,
      progress: 0.5,
      msg: 'Instagram didn’t open its story picker here. Click “Save photo”, then tap “Your story” (+) on Instagram and choose the saved photo. Click “Done” when it’s posted.',
      tone: '',
      buttons: [saveFileBtn(file), { label: 'Done', kind: 'primary', run: () => finish('done', { note: 'Posted by you' }) }, stopBtn()],
    });
  }

  // ─────────────── X ───────────────
  // X's composer (checked live, Nov 2026): a <textarea> labelled "What's happening?" in a dialog at /compose/post
  // (the home page has a second, inline one), a multiple file input, a "Post" / "Post all" button, "Add another post"
  // for threads, previews as img[alt^="Preview of"] with "Remove <file>" / hidden "Retry <file>" buttons, and almost no
  // data-testid attributes. The older Draft.js composer (data-testid="tweetTextarea_N", tweetButton…) is still supported.
  const X_BOX = 'textarea, [data-testid^="tweetTextarea_"][contenteditable="true"], [data-testid^="tweetTextarea_"] [contenteditable="true"], [role="textbox"][contenteditable="true"]';
  const xDialog = () => $$('[role="dialog"]').find((d) => visible(d) && d.querySelector(X_BOX));
  const xRoot = () => xDialog() || document.querySelector('[data-testid="primaryColumn"]') || document.querySelector('main') || document;
  function xBoxes() {
    const all = $$(X_BOX, xRoot()).filter((el) => visible(el) && !el.closest('#ritpost-social') && !el.closest('form[role="search"]'));
    return all.filter((el) => !all.some((o) => o !== el && el.contains(o))); // innermost editable only
  }
  const xBox = (n = 0) => xBoxes()[n] || null;
  const boxText = (el) => (!el ? '' : el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : textOf(el));
  /** The smallest container around the first text box that also holds `pick(container)` (Post button, file input…). */
  function nearBox(pick) {
    let el = xBox(0);
    for (let i = 0; el && i < 25; i++, el = el.parentElement) {
      const hit = pick(el);
      if (hit) return hit;
      if (el.getAttribute?.('role') === 'dialog') break;
    }
    return null;
  }
  const X_POST = /^(post|post all|tweet|tweet all)$/i;
  const xPostIn = (root) =>
    root.querySelector?.('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]') || $$('button, [role="button"]', root).find((b) => visible(b) && X_POST.test(textOf(b)));
  const xPostBtn = () => nearBox(xPostIn) || (xDialog() ? xPostIn(xDialog()) : null);
  const xScope = () => nearBox((el) => (xPostIn(el) ? el : null)) || xRoot();
  const xFileInput = () =>
    nearBox((el) => el.querySelector('input[type="file"]')) ||
    xRoot().querySelector('input[data-testid="fileInput"], input[type="file"][accept*="image"], input[type="file"][accept*="video"]');
  const xSignedOut = () =>
    /\/login|\/i\/flow\/login|\/i\/flow\/signup/.test(location.pathname) ||
    (!xBox(0) && !!(document.querySelector('[data-testid="loginButton"]') || $$('a[href="/login"], a[href^="/i/flow/login"]').find(visible)));
  const xToast = () => [...new Set($$('[data-testid="toast"], [role="alert"], [role="status"]').map(textOf).filter(Boolean))].join(' ').slice(0, 300);
  const X_ERROR = /(something went wrong|already said that|duplicate|limit|couldn['’]t|failed|not allowed|try again)/i;
  const xMediaCount = () => $$('img[alt^="Preview of"], [data-testid="attachments"] img, [data-testid="attachments"] video, [data-testid="attachments"] [role="link"], video', xScope()).filter((m) => !m.closest('article')).length;
  const xUploadFailed = () => $$('button[aria-label^="Retry "]', xScope()).find(visible);

  async function xPost(run, base) {
    if (xSignedOut()) return fail('Sign in to X in this tab first, then try again.');
    ui.update({ ...base, msg: 'Opening the X composer…', progress: 0.1, buttons: [stopBtn()] });
    const box = await waitFor(() => xBox(0), 20000);
    if (!alive()) return;
    if (!box) return fail(xSignedOut() ? 'Sign in to X first, then try again.' : 'Couldn’t open the X composer.');
    let files;
    try {
      files = await loadFiles(run.attachmentIds);
    } catch (e) {
      return fail(e.message);
    }
    const parts = run.thread?.length ? run.thread : [run.caption || ''];
    if (files.length) {
      ui.update({ ...base, msg: `Adding ${files.length > 1 ? `${files.length} files` : 'your file'}…`, progress: 0.3, buttons: [stopBtn()] });
      const input = await waitFor(xFileInput, 6000);
      if (!input) return fail('Couldn’t find X’s “Add photos or video” box.');
      const before = xMediaCount();
      setFiles(input, files);
      const added = await waitFor(() => xMediaCount() > before || X_ERROR.test(xToast()), 20000);
      if (!alive()) return;
      if (!added) return fail('X didn’t accept the files. X takes up to 4 photos, or 1 video or GIF.');
      if (X_ERROR.test(xToast())) return fail(`X: ${xToast()}`);
    }
    for (let i = 0; i < parts.length && alive(); i++) {
      ui.update({ ...base, msg: parts.length > 1 ? `Writing post ${i + 1} of ${parts.length}…` : 'Writing your post…', progress: 0.5 + (i / parts.length) * 0.2, buttons: [stopBtn()] });
      let b = xBox(i);
      if (!b && i > 0) {
        const add = xScope().querySelector('[data-testid="addButton"]') || byText(xScope(), /^add (another )?(post|tweet)$/i);
        if (!add) return fail('Couldn’t add the next post of the thread on X.');
        add.click();
        b = await waitFor(() => xBox(i), 6000);
      }
      if (!b) return fail('Couldn’t find the X text box.');
      if (parts[i] && !(await fillBox(b, parts[i]))) return fail('Couldn’t write your text on X.');
    }
    if (!alive()) return;
    // Wait until uploads finish and the Post button is enabled.
    ui.update({ ...base, msg: 'Waiting for X to finish uploading…', progress: 0.75, buttons: [stopBtn()] });
    const btn = await waitFor(() => (xUploadFailed() ? 'failed' : xPostBtn() && !isDisabled(xPostBtn()) ? xPostBtn() : null), 5 * 60 * 1000, 500);
    if (!alive()) return;
    if (btn === 'failed') return fail('X couldn’t upload a file. Check its size and type (photos up to 5 MB, videos up to 512 MB), then try again.');
    if (!btn) {
      const over = textOf(xScope()).match(/-\d+/);
      return fail(over ? 'Your text is longer than X allows. Shorten it or post it as a thread.' : 'X’s Post button stayed disabled.');
    }
    await confirmAndPublish(run, base, btn, parts.length > 1 ? 'Post all' : 'Post', () => xOutcome());
  }

  async function xOutcome() {
    const res = await waitFor(() => {
      const t = xToast();
      if (/sent|posted|your post was/i.test(t)) return { ok: true };
      if (X_ERROR.test(t)) return { error: t.slice(0, 160) };
      if (!xBox(0) || (location.pathname !== '/compose/post' && !xDialog() && !boxText(xBox(0)))) return { ok: true };
      return null;
    }, 3 * 60 * 1000, 500);
    return res || { error: 'X didn’t confirm the post within 3 minutes. Check your profile.' };
  }

  // ─────────────── shared: review, click (or let the user click), confirm ───────────────
  async function confirmAndPublish(run, base, button, what, outcome) {
    if (!alive()) return;
    const fresh = await getRun();
    if (!fresh || fresh.status !== 'running') return;
    ring(button);
    const stopFlash = flashTitle(`▶ ${what} · RitPost`);
    let how = 'user';
    try {
      if (run.mode === 'auto') {
        const v = await countdown(run, { ...base, progress: 0.85 }, Number(run.reviewSec) || 15, what);
        if (v === 'stale') return;
        if (v === 'cancel') {
          unring();
          ui.update({ ...base, progress: 0.85, msg: `Cancelled. Your post is still open: click ${what} yourself, or close it.`, buttons: [{ label: 'Close RitPost', run: () => finish('stopped', { stopReason: 'Cancelled before posting' }).then(() => ui.unmount()) }] });
          const clicked = await waitFor(() => Date.now() - lastUserPost < 3000, 30 * 60 * 1000, 500);
          if (!alive()) return;
          if (!clicked) return finish('stopped', { stopReason: 'Cancelled before posting' });
        } else if (v === 'go') {
          how = 'auto';
          const b = button.isConnected ? button : null;
          if (!b || isDisabled(b)) return fail(`The ${what} button isn’t available any more.`);
          const now = await getRun();
          if (now?.status !== 'running') return;
          await setRun({ ...now, step: 'publishing' });
          b.click();
          await sleep(1200);
          // Some buttons need a full pointer sequence.
          if (b.isConnected && !isDisabled(b) && Date.now() - lastUserPost > 5000 && PLATFORM === 'x' && xBox(0) && boxText(xBox(0))) fireClick(b);
        }
      } else {
        ui.update({
          ...base,
          progress: 0.85,
          msg: `All set. Check your post, then click ${what} (highlighted) on ${PLATFORM === 'x' ? 'X' : 'Instagram'}. RitPost confirms when it’s posted.`,
          buttons: [stopBtn('Stop')],
        });
        const clicked = await waitFor(() => Date.now() - lastUserPost < 4000, 60 * 60 * 1000, 400);
        if (!clicked || !alive()) return;
      }
      if (how === 'user') {
        const now = await getRun();
        if (now?.status !== 'running') return;
        await setRun({ ...now, step: 'publishing' });
      }
      unring();
      ui.update({ ...base, progress: 0.92, msg: `Posting… keep this tab open until ${PLATFORM === 'x' ? 'X' : 'Instagram'} confirms.`, buttons: [] });
      const res = await outcome();
      if (!alive()) return;
      if (res.ok) {
        await finish('done', { postedBy: how });
        ui.update({ ...base, progress: 1, tone: 'ok', msg: `Posted to ${PLATFORM === 'x' ? 'X' : 'Instagram'} ✓`, buttons: [{ label: 'Close', run: () => ui.unmount() }] });
        setTimeout(() => ui.unmount(), 15000);
      } else await fail(res.error);
    } finally {
      stopFlash();
      unring();
    }
  }

  function stopBtn(label = 'Stop') {
    return { label, kind: 'danger', run: () => finish('stopped', { stopReason: 'Stopped by you' }).then(() => ui.unmount()) };
  }

  // ─────────────── entry ───────────────
  let running = false;
  async function check() {
    const run = await getRun();
    if (!run || run.platform !== PLATFORM) return;
    if (myTabId === null) myTabId = (await bg('BG_SOCIAL_TABID'))?.tabId ?? -1;
    if (run.tabId !== myTabId) return;
    if (run.status !== 'running') {
      if (running) {
        session++;
        running = false;
        unring();
      }
      if (run.status === 'failed' && run.error && !run.errorShown) {
        await setRun({ ...run, errorShown: true });
        ui.update({ title: '', mode: modeTag(run), name: kindLabel(run), tone: 'err', msg: run.error, buttons: [{ label: 'Close', run: () => ui.unmount() }] });
      }
      return;
    }
    if (running) return;
    // RitPost reloads the tab for each run; the page that was open before must not start it.
    if (performance.timeOrigin < (run.startedAt || 0) - 1500) return;
    // The page reloaded right after publishing: don't post twice.
    if (run.step === 'publishing') return finish('done', { note: 'The page reloaded after posting. Check your profile to be sure.' });
    running = true;
    current = ++session;
    const base = { mode: modeTag(run), name: kindLabel(run) };
    try {
      await sleep(1200);
      if (PLATFORM === 'x') await xPost(run, base);
      else if (run.kind === 'story') await igStory(run, base);
      else await igPost(run, base);
    } catch (e) {
      if (alive()) await fail(e?.message || String(e));
    } finally {
      running = false;
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.socialRun) check();
  });
  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg?.type === 'SOCIAL_PING') {
      reply({ ok: true, platform: PLATFORM });
      return false;
    }
    if (msg?.type === 'SOCIAL_GO') {
      check();
      reply({ ok: true });
      return false;
    }
    return false;
  });
  check();

  // For tests.
  window.__ritpostSocialTest = { fillBox, setFiles };
})();
