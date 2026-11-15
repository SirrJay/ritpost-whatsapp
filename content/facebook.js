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
      let v = fn();
      if (v && typeof v.then === 'function') v = await v.catch(() => null);
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
      if (!visible(b) || b.closest('#ritpost-fb')) return false;
      const label = boxLabel(b);
      if (NOT_POSTBOX_RE.test(label) && !POSTBOX_RE.test(label)) return false;
      const dlg = b.closest('[role="dialog"]');
      if (dlg) return b.getAttribute('role') === 'textbox' || b.hasAttribute('data-lexical-editor') || !!postButton(dlg);
      return (b.getAttribute('role') === 'textbox' || b.hasAttribute('data-lexical-editor')) && POSTBOX_RE.test(label);
    });
    return boxes.find((b) => b.closest('[role="dialog"]') && postButton(b.closest('[role="dialog"]'))) || boxes[0] || null;
  }

  /** The post dialog, also on Facebook's second step ("Next" → "Post settings") where the text box is hidden. */
  function postDialog() {
    const box = composerBox();
    if (box) return composerScope(box);
    return (
      $$('[role="dialog"]').find(
        (d) => visible(d) && !d.closest('#ritpost-fb') && postButton(d) && d.querySelector('[contenteditable], [data-lexical-editor]')
      ) || null
    );
  }
  /** A post dialog is on screen, even while Facebook re-renders its text box (e.g. building a link preview). */
  const composerOpen = () => !!postDialog();
  const dialogCount = () => $$('[role="dialog"]').filter((d) => visible(d) && !d.closest('#ritpost-fb')).length;

  /** Candidates for the "Write something…" / "What's on your mind?" prompt, best first. */
  const VISITOR_RE = /^write something to\b/i;
  function triggerCandidates(kind = currentKind) {
    const main = document.querySelector('[role="main"]') || document.body;
    const out = [];
    const okText = (t) => !(kind === 'page' && VISITOR_RE.test(t.trim()));
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (PROMPT_RE.test(n.nodeValue.trim()) && n.nodeValue.trim().length < 80 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const host = n.parentElement;
      if (!host || host.closest('#ritpost-fb') || host.closest('[contenteditable="true"]')) continue;
      const btn = host.closest('[role="button"], button, a[role="link"]') || host;
      if (!visible(btn) || out.includes(btn) || !okText(n.nodeValue)) continue;
      out.push(btn);
    }
    // Inputs that act as the prompt (older layouts).
    for (const el of $$('[aria-label], [placeholder]', main)) {
      const l = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
      if (PROMPT_RE.test(l.trim()) && okText(l) && visible(el) && !out.includes(el) && el.getAttribute('contenteditable') !== 'true') out.push(el);
    }
    const inView = (el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < innerHeight;
    };
    return out.sort((a, b) => Number(inView(b)) - Number(inView(a)) || a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }

  let currentKind = 'group';

  /** Try to open the post box. Returns true when it is open. */
  async function openComposer() {
    if (composerBox()) return true;
    const cands = await waitFor(() => {
      const c = triggerCandidates();
      return c.length ? c : null;
    }, 15000, 400);
    if (!cands) return false;
    const dialogsBefore = dialogCount();
    const appeared = () => composerBox() || dialogCount() > dialogsBefore;
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
        if (await waitFor(appeared, 3500, 200)) {
          // Something opened: give the text box time to appear (Pages take several seconds) instead of clicking again.
          return !!(await waitFor(composerBox, 15000, 250));
        }
      }
    }
    return !!composerBox();
  }

  // ─────────────── switching profiles (you <-> your Pages) ───────────────
  const cleanName = (s) =>
    String(s || '')
      .replace(/^(profile picture|profile photo|cover photo|picture|photo|avatar)\s+(for|of)\s+/i, '')
      .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
      .trim();
  function sameName(a, b) {
    // Exact match, ignoring spacing/case. A name Facebook cut short with "…" may match its beginning.
    const x = loose(cleanName(a));
    const y = loose(cleanName(b));
    if (!x || !y) return false;
    if (x === y) return true;
    const cut = (v) => v.endsWith('…') || v.endsWith('...');
    if (cut(x)) return y.startsWith(x.replace(/(…|\.\.\.)$/, ''));
    if (cut(y)) return x.startsWith(y.replace(/(…|\.\.\.)$/, ''));
    return false;
  }
  const clickableOf = (el) =>
    el.closest('[role="button"], [role="menuitem"], [role="menuitemradio"], [role="radio"], [role="option"], [role="link"], a, button, [tabindex="0"]') || el;
  const SWITCH_WORD_RE = /^(switch|switch now|switch profile|switch profiles|switch to page|switch into page)$/i;

  /** A switch button Facebook shows on a Page you manage ("Switch now", "Switch to <Page>", the sidebar switch icon). */
  function switchButton(name) {
    const found = $$('[role="button"], button, a, [role="link"]').filter((b) => {
      if (!visible(b) || b.closest('#ritpost-fb') || b.closest('[role="banner"]')) return false;
      const l = (b.getAttribute('aria-label') || textOf(b)).trim();
      if (SWITCH_WORD_RE.test(l)) return true;
      const m = l.match(/^switch (?:to|into) (.{2,90}?)(?:['’]s page| page)?$/i);
      return !!(m && name && sameName(m[1], name));
    });
    // Prefer the "Switch Now" banner on the Page itself, then any other switch button (e.g. the sidebar).
    const label = (b) => (b.getAttribute('aria-label') || textOf(b)).trim();
    return (
      found.find((b) => b.closest('[role="main"]') && /^switch now$/i.test(label(b))) ||
      found.find((b) => b.closest('[role="main"]')) ||
      found[0] ||
      null
    );
  }

  /** The account button at the top right (your profile picture). */
  function accountButton() {
    const bar = document.querySelector('[role="banner"]') || document.body;
    const labelled = $$('[role="button"], [role="link"], a, button', bar).filter(
      (b) => visible(b) && /(^account\b|your profile|^profile$|account controls)/i.test((b.getAttribute('aria-label') || '').trim())
    );
    if (labelled.length) return labelled.at(-1);
    const withPic = $$('image, img', bar)
      .map((i) => i.closest('[role="button"], [role="link"]'))
      .filter((b) => b && visible(b));
    return withPic.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0] || null;
  }
  const menuRoots = () => $$('[role="dialog"], [role="menu"], [role="listbox"]').filter((d) => visible(d) && !d.closest('#ritpost-fb'));
  function findInMenus(test) {
    for (const root of menuRoots()) {
      for (const el of $$('[role="button"], [role="menuitem"], [role="menuitemradio"], [role="radio"], [role="option"], [role="link"], a, span', root)) {
        if (!visible(el)) continue;
        const t = textOf(el);
        if (!t || t.length > 120) continue;
        if (test(t, el)) return clickableOf(el);
      }
    }
    return null;
  }
  const ACCOUNT_MENU_RE = /^(see all profiles|log ?out|settings (&|and) privacy|help (&|and) support|display (&|and) accessibility)$/i;
  async function openAccountMenu() {
    if (findInMenus((t) => ACCOUNT_MENU_RE.test(t))) return true;
    const btn = accountButton();
    if (!btn) return false;
    btn.click();
    if (await waitFor(() => findInMenus((t) => ACCOUNT_MENU_RE.test(t)), 4000, 250)) return true;
    fireClick(btn);
    return !!(await waitFor(() => findInMenus((t) => ACCOUNT_MENU_RE.test(t)), 4000, 250));
  }
  const closeMenus = () =>
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  async function confirmSwitch() {
    await sleep(1300);
    const ok = findInMenus((t) => SWITCH_WORD_RE.test(t));
    if (ok) ok.click();
  }

  /** "Switch to <name>" buttons in the open profile menu: [{ name, el }]. */
  function switchOptions() {
    const out = [];
    for (const root of menuRoots()) {
      for (const b of $$('[role="button"], [role="menuitem"], [role="radio"], [role="link"], a', root)) {
        if (!visible(b)) continue;
        const m = (b.getAttribute('aria-label') || '').trim().match(/^switch to\s+(.+)$/i);
        if (m && !/^a different profile/i.test(m[1])) out.push({ name: m[1].trim(), el: b });
      }
    }
    return out;
  }
  /** The profile you are currently using (top of the profile menu). */
  function currentProfileName() {
    const root = menuRoots().find((r) => /your profile/i.test(r.getAttribute('aria-label') || '')) || menuRoots()[0];
    const first = root && $$('[role="link"], a', root).find((a) => visible(a) && textOf(a));
    return first ? cleanName(textOf(first)) : '';
  }
  async function knownPageNames() {
    const { fbTargets, fbPageNames } = await chrome.storage.local.get(['fbTargets', 'fbPageNames']);
    return [...(fbTargets || []).filter((t) => t.kind === 'page').map((t) => cleanName(t.name)), ...(fbPageNames || [])].filter(Boolean);
  }
  /** Remember which profile is the user's own (anything that isn't one of their Pages). */
  async function rememberPersonal() {
    const cur = currentProfileName();
    if (!cur) return;
    // Needs the full list of your Pages (saved by "Import Pages I manage"); otherwise a Page that
    // wasn't imported could be mistaken for your own profile.
    const { fbPageNames } = await chrome.storage.local.get('fbPageNames');
    if (!fbPageNames?.length) return;
    const pages = await knownPageNames();
    if (!pages.some((n) => sameName(n, cur))) await chrome.storage.local.set({ fbPersonalName: cur });
  }

  /** Use Facebook's profile menu: pick the profile `test` matches (opening "See all profiles" if needed). */
  async function switchViaMenu(test) {
    if (!(await openAccountMenu())) return false;
    await rememberPersonal();
    const pick = () => {
      const opts = switchOptions();
      return (opts.find((o) => test(o.name, o.el, true)) || {}).el || null;
    };
    let item = pick();
    if (!item) {
      const seeAll = findInMenus((t) => /^see all profiles$/i.test(t));
      if (seeAll) {
        seeAll.click();
        item = await waitFor(pick, 5000, 250);
      }
    }
    if (!item) item = findInMenus(test);
    if (!item) {
      const seeAll = findInMenus((t) => /^see all profiles$/i.test(t));
      if (seeAll) {
        seeAll.click();
        item = await waitFor(() => findInMenus(test), 5000, 250);
      }
    }
    if (!item) {
      closeMenus();
      return false;
    }
    item.click();
    await confirmSwitch();
    return true;
  }

  /** Start switching to the Page called `name`. Facebook then reloads the page. */
  /** The Page's own "Switch Now" banner (shown when you view a Page you manage as yourself). */
  function switchNowButton(name) {
    const b = switchButton(name);
    if (!b || !b.closest('[role="main"]')) return null;
    const l = (b.getAttribute('aria-label') || textOf(b)).trim();
    return /^switch now$/i.test(l) || /^switch (to|into) /i.test(l) ? b : null;
  }

  /**
   * Switch methods for a Page, best first: the Page's "Switch Now" banner → profile menu
   * "Switch to <Page>" (works from your profile and from another Page) → any other switch button.
   */
  const SWITCH_METHODS = ['now', 'menu', 'other'];
  /** Try one method. Returns true when a switch was started (Facebook then reloads). */
  async function switchToPage(name, method) {
    if (method === 'now') {
      const now = switchNowButton(name);
      if (!now) return false;
      now.click();
      await confirmSwitch();
      return true;
    }
    if (method === 'menu') return switchViaMenu((t) => sameName(t.replace(/^switch to\s+/i, ''), name));
    const other = switchButton(name);
    if (!other) return false;
    other.scrollIntoView({ block: 'center' });
    other.click();
    await confirmSwitch();
    return true;
  }

  /** Name of the profile you're using right now (opens and closes the profile menu). */
  async function activeProfile() {
    if (!(await openAccountMenu())) return '';
    const cur = currentProfileName();
    await rememberPersonal();
    closeMenus();
    await sleep(400);
    return cur;
  }

  /** Scroll down the page bit by bit until the post prompt appears (Facebook loads it lazily). */
  async function findPrompt(timeout = 15000) {
    const end = Date.now() + timeout;
    let steps = 0;
    while (Date.now() < end) {
      if (composerBox() || triggerCandidates().length) {
        if (steps) window.scrollTo(0, 0);
        return true;
      }
      if (steps < 8 && Date.now() > end - timeout + 2500) {
        window.scrollBy(0, Math.round(innerHeight * 0.8));
        steps++;
      }
      await sleep(600);
    }
    if (steps) window.scrollTo(0, 0);
    return !!(composerBox() || triggerCandidates().length);
  }

  let personalAmbiguous = false;
  // Facebook's list of the Pages you manage (tests can point this at a mock page).
  const PAGES_LIST_URL = window.__ritpostPagesUrl || 'https://www.facebook.com/pages/?category=your_pages';
  /** Start switching back to your own profile (the remembered one, or the only profile that isn't one of your Pages). */
  async function switchToPersonal(pageNames) {
    personalAmbiguous = false;
    const { fbPersonalName } = await chrome.storage.local.get('fbPersonalName');
    const allPages = [...pageNames, ...(await knownPageNames())];
    const isPage = (n) => allPages.some((p) => sameName(n, p));
    if (fbPersonalName) {
      if (await switchViaMenu((t) => sameName(t.replace(/^switch to\s+/i, ''), fbPersonalName))) return true;
    }
    // On a group, Facebook may offer a plain "Switch" button to go back to your profile.
    const main = document.querySelector('[role="main"]');
    const direct = main && $$('[role="button"], button', main).find((b) => visible(b) && SWITCH_WORD_RE.test((b.getAttribute('aria-label') || textOf(b)).trim()));
    if (direct) {
      direct.click();
      await confirmSwitch();
      return true;
    }
    const SKIP = /(see all profiles|settings|privacy|help|support|display|accessibility|feedback|log ?out|create|business suite|ads manager|professional dashboard|page|switch$)/i;
    void SKIP;
    if (!(await openAccountMenu())) return false;
    let opts = switchOptions().filter((o) => !isPage(o.name));
    if (!opts.length) {
      const seeAll = findInMenus((t) => /^see all profiles$/i.test(t));
      if (seeAll) {
        seeAll.click();
        await waitFor(() => switchOptions().filter((o) => !isPage(o.name)).length, 5000, 250);
        opts = switchOptions().filter((o) => !isPage(o.name));
      }
    }
    if (opts.length !== 1) {
      closeMenus();
      personalAmbiguous = opts.length > 1;
      return false; // unsure which profile is yours: don't guess
    }
    await chrome.storage.local.set({ fbPersonalName: cleanName(opts[0].name) });
    opts[0].el.click();
    await confirmSwitch();
    return true;
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

  const noUrls = (s) => loose(String(s || '').replace(/https?:\/\/\S+/gi, ''));
  /** True when the box already holds the text (ignoring links, which Facebook may turn into a preview). */
  function hasText(box, text) {
    const want = loose(text).slice(0, 40);
    if (want && loose(textOf(box)).includes(want)) return true;
    const core = noUrls(text).slice(0, 40);
    return !!core && noUrls(textOf(box)).includes(core);
  }

  async function fillText(text) {
    if (!text) return true;
    let box = await waitFor(composerBox, 5000, 200);
    if (!box) return false;
    if (hasText(box, text)) return true;
    if (loose(textOf(box))) {
      // Facebook kept an old draft in the box: clear it so the post isn't mixed with old text.
      for (let i = 0; i < 3 && loose(textOf(composerBox() || box)); i++) {
        const b = composerBox() || box;
        b.focus();
        const sel = window.getSelection();
        const r = document.createRange();
        r.selectNodeContents(b);
        sel.removeAllRanges();
        sel.addRange(r);
        b.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true, composed: true }));
        await sleep(300);
      }
      box = composerBox() || box;
    }
    const before = loose(textOf(box)).length;
    insertText(box, text);
    // Facebook may re-render the box while it fetches a link preview: keep checking for a few seconds.
    const filled = () => {
      const b = composerBox();
      return b && hasText(b, text);
    };
    if (await waitFor(filled, 3000, 250)) return true;
    box = composerBox() || box;
    // Something was inserted (the link may have become a preview): don't type it a second time.
    if (loose(textOf(box)).length - before >= Math.min(20, noUrls(text).length * 0.5)) return true;
    // Fallback: type it, one line at a time.
    box.focus();
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (line) document.execCommand('insertText', false, line);
      if (i < lines.length - 1) document.execCommand('insertParagraph', false, null);
    });
    await sleep(600);
    return hasText(composerBox() || box, text);
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

  /** Blink the tab title so you notice it's your turn, until the post box closes. */
  let titleTimer = null;
  function flashTitle(text) {
    clearInterval(titleTimer);
    const original = document.title.replace(/^▶ Click Post · RitPost$/, '') || 'Facebook';
    let on = false;
    titleTimer = setInterval(() => {
      if (!composerOpen()) {
        clearInterval(titleTimer);
        document.title = original;
        return;
      }
      on = !on;
      document.title = on ? text : original;
    }, 1000);
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
      if (POST_RE.test(l) && b.closest('[role="dialog"]')?.querySelector('[contenteditable], [data-lexical-editor]')) lastPostClick = Date.now();
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

  let leaving = false; // this page has started navigating away; it must not act any more
  async function goToCurrent(run) {
    leaving = true;
    session++;
    clearTimers();
    run.status = 'running';
    run.navigatedFor = run.index;
    run.navAt = Date.now();
    run.nextAt = null;
    await setRun(run);
    location.assign(run.items[run.index].url);
  }

  /** Watches for the composer closing after a Post click, and for Facebook block messages. */
  let watchTimer = null;
  function watchForPost(base, my, onClosedWithoutPost) {
    clearInterval(watchTimer);
    timers.delete(watchTimer);
    let sawOpen = composerOpen();
    let misses = 0;
    let checking = false;
    watchTimer = every(async () => {
      if (my !== session || checking) return;
      const block = facebookMessage(BLOCK_RE);
      if (block) return stopRun(`Facebook limited posting: “${block}”. RitPost stopped so your account isn’t restricted further. Wait a day before posting again.`);
      if (composerOpen()) {
        sawOpen = true;
        misses = 0;
        return;
      }
      if (!sawOpen) return;
      // Only treat it as closed when it stays gone for about 3 s (Facebook briefly re-renders the box).
      if (++misses < 4) return;
      sawOpen = false;
      misses = 0;
      checking = true;
      clearInterval(watchTimer);
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

  const reopenCount = new Map(); // automatic re-opens per run item

  async function prepare(run) {
    const my = ++session;
    const alive = () => my === session;
    const item = run.items[run.index];
    const base = { meta: meta(run), mode: modeTag(run), name: cleanName(item.name), progress: progress(run) };
    const stopBtn = { label: 'Stop', kind: 'danger', run: () => stopRun() };
    const skipBtn = { label: 'Skip', run: () => record('skipped') };
    const retry = async () => {
      const r = await getRun();
      if (r?.pageSwitchMethods?.[r.index]) {
        delete r.pageSwitchMethods[r.index];
        await setRun(r);
      }
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

    currentKind = item.kind;
    const pageName = cleanName(item.name);

    /** Records the switch attempt, starts it, and reopens this group/Page once Facebook has switched. */
    const switchProfile = async (key, msg, start) => {
      const tries = run[key]?.[run.index] || 0;
      if (tries >= 2) return false;
      ui.update({ ...base, msg, buttons: [skipBtn, stopBtn] });
      run[key] = { ...(run[key] || {}), [run.index]: tries + 1 };
      if (key === 'pageSwitchTries') run.switchedToPage = true;
      run.navigatedFor = -1; // after Facebook's reload, come back to this group/Page
      run.navAt = Date.now();
      await setRun(run);
      if (!(await start())) return false;
      // Facebook reloads after switching and this script starts again there.
      await sleep(15000);
      if (alive()) await goToCurrent(await getRun()); // it switched without reloading
      return true;
    };

    // Pages: post as the Page. Switch to the Page's profile automatically when needed.
    if (item.kind === 'page' && !composerBox()) {
      ui.update({ ...base, msg: 'Looking for the Page’s post box…', buttons: [skipBtn, stopBtn] });
      await waitFor(() => triggerCandidates().length || switchButton(pageName), 8000, 400);
      if (!alive()) return;
      let ready = triggerCandidates().length > 0;
      if (!ready) {
        // Which profile are you using? If it's already this Page, the post box is just further down.
        const active = await activeProfile();
        if (!alive()) return;
        if (active && sameName(active, pageName)) ready = await findPrompt(20000);
      }
      if (!alive()) return;
      if (!ready) {
        const tried = [...(run.pageSwitchMethods?.[run.index] || [])];
        ui.update({ ...base, msg: `Switching to “${pageName}” so the post comes from your Page…`, buttons: [skipBtn, stopBtn] });
        for (const method of SWITCH_METHODS.filter((m) => !tried.includes(m))) {
          if (!alive()) return;
          // Save the attempt BEFORE clicking: Facebook reloads the page right after a switch.
          tried.push(method);
          run.pageSwitchMethods = { ...(run.pageSwitchMethods || {}), [run.index]: [...tried] };
          run.switchedToPage = true;
          run.navigatedFor = -1; // after Facebook's reload, come back to this Page
          run.navAt = Date.now();
          await setRun(run);
          if (await switchToPage(pageName, method)) {
            // Facebook reloads after switching and this script starts again there.
            await sleep(15000);
            if (alive()) await goToCurrent(await getRun()); // it switched without reloading
            return;
          }
        }
        if (!alive()) return;
        return fail(
          `RitPost couldn’t switch to “${pageName}”. Check that you manage this Page, then click Try again (or switch to it from your profile picture).`
        );
      }
    }

    // Groups: if there's no post box (e.g. you're still using Facebook as a Page), switch back to your profile once.
    if (item.kind === 'group' && !composerBox()) {
      await findPrompt(15000);
      if (!alive()) return;
      if (!triggerCandidates().length) {
        const { fbTargets } = await chrome.storage.local.get('fbTargets');
        const pageNames = [...run.items, ...(fbTargets || [])].filter((t) => t.kind === 'page').map((t) => cleanName(t.name));
        if (await switchProfile('personalSwitchTries', 'Switching back to your own profile to post in this group…', () => switchToPersonal(pageNames))) return;
        if (!alive()) return;
        const { fbPageNames } = await chrome.storage.local.get('fbPageNames');
        if (personalAmbiguous && !fbPageNames?.length && !run.pagesLearned) {
          // Learn the full list of your Pages once, then come back and try again.
          ui.update({ ...base, msg: 'Checking which profiles are your Pages…', buttons: [skipBtn, stopBtn] });
          run.pagesLearned = true;
          run.learningPages = true;
          run.personalSwitchTries = { ...(run.personalSwitchTries || {}), [run.index]: 0 };
          run.navAt = Date.now();
          await setRun(run);
          leaving = true;
          location.assign(PAGES_LIST_URL);
          return;
        }
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
    const closedWithoutPost = () => {
      const k = `${run.id}|${run.index}`;
      const n = reopenCount.get(k) || 0;
      if (run.mode === 'auto' && n < 2) {
        reopenCount.set(k, n + 1);
        ui.update({ ...base, msg: 'The post box closed before posting. Opening it again…', buttons: [skipBtn, stopBtn] });
        setTimeout(() => alive() && retry(), 1500);
        return;
      }
      ui.update({
        ...base,
        msg: 'The post box was closed without posting. Facebook usually keeps your text as a draft: click Fill again to reopen it.',
        error: true,
        buttons: [{ label: 'Fill again', kind: 'primary', run: retry }, skipBtn, stopBtn],
      });
    };

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
        msg: `Check the post now. RitPost continues in ${left} s; you then click Post to publish.${note}`,
        buttons: [{ label: 'Continue now', kind: 'primary', run: () => (left = 0) }, { label: 'Hold', run: hold }, skipBtn, stopBtn],
      });
    draw();
    watchForPost(base, my, closedWithoutPost); // the user may still post or close it themselves
    while (left > 0) {
      await sleep(1000);
      if (!alive() || held) return;
      if (!composerOpen()) {
        // Possibly a brief re-render; the watcher decides whether it was really closed.
        const back = await waitFor(() => !alive() || held || composerOpen(), 4000, 250);
        if (!alive() || held || !back) return;
      }
      left = Math.max(0, left - 1);
      draw();
    }
    if (!alive() || held) return;

    if ((await dailyCount()) >= run.dailyLimit) return stopRun(`Daily limit reached (${run.dailyLimit} posts today). Continue tomorrow with “Select unposted”.`);

    ui.update({ ...base, msg: 'Waiting for uploads to finish…', buttons: [skipBtn, stopBtn] });
    const ready = () => {
      const b = postButton(postDialog());
      return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled ? b : null;
    };
    const first = await waitFor(() => !alive() || ready(), 180000, 500);
    if (!alive()) return;
    if (!first || first === true) return manualWait('\nThe Post button didn’t become available. Post it yourself or Skip.');

    /** Hand the final Post click to the user: point at the button and wait (the watcher records the click). */
    const yourTurn = (btn, extra = '') => {
      if (btn?.isConnected) {
        btn.scrollIntoView({ block: 'center', inline: 'center' });
        btn.style.outline = '3px solid #25d366';
        btn.style.outlineOffset = '3px';
        btn.style.borderRadius = btn.style.borderRadius || '6px';
      }
      flashTitle('▶ Click Post · RitPost');
      ui.update({
        ...base,
        msg: `Your turn: click the blue Post button on Facebook to publish.${extra} RitPost then carries on with the next one by itself.${note}`,
        buttons: [skipBtn, stopBtn],
      });
      watchForPost(base, my, closedWithoutPost);
    };

    /** Click "Next" (Facebook accepts that) and, where possible, Post; otherwise leave Post to the user. */
    let btn = first;
    for (let step = 0; step < 3 && alive(); step++) {
      const label = (btn.getAttribute('aria-label') || textOf(btn)).trim();
      const isNext = NEXT_RE.test(label);
      // The Page "Post settings" step (text box hidden): Facebook only accepts your own click on Post.
      if (!isNext && !composerBox()) return yourTurn(btn);
      ui.update({ ...base, msg: isNext ? 'Clicking Next…' : 'Clicking Post…', buttons: [skipBtn, stopBtn] });
      if (!isNext) lastPostClick = Date.now();
      const clicked = btn;
      // Facebook's reaction: box closed, button gone/disabled, a new step, a message, or "Posting…".
      const reacted = () =>
        !composerOpen() ||
        !clicked.isConnected ||
        clicked.getAttribute('aria-disabled') === 'true' ||
        (ready() && ready() !== clicked) ||
        facebookMessage(BLOCK_RE) ||
        /\b(posting|publishing)…?$/im.test(textOf(postDialog()).slice(0, 3000));
      // One way of clicking at a time, the next only if Facebook showed no reaction, so nothing is sent twice.
      let moved = false;
      for (const click of CLICKS.slice(0, 3)) {
        if (await waitFor(reacted, 300, 100)) {
          moved = true;
          break;
        }
        click(clicked);
        if (await waitFor(reacted, 4000, 250)) {
          moved = true;
          break;
        }
      }
      if (!alive()) return;
      if (!moved) {
        if (!isNext) lastPostClick = 0;
        return yourTurn(clicked, isNext ? ' (Click Next first.)' : '');
      }
      if (!isNext) ui.update({ ...base, msg: 'Publishing…', buttons: [skipBtn, stopBtn] });
      // Wait for the result (uploads can take a while); the watcher records it.
      await waitFor(() => !alive() || !composerOpen() || facebookMessage(BLOCK_RE) || (isNext && ready() && ready() !== clicked), 60000, 400);
      if (!alive() || !composerOpen() || facebookMessage(BLOCK_RE)) return;
      if (!isNext) return yourTurn(ready() || clicked);
      // "Next" leads to the "Post settings" step with the Post button.
      btn = await waitFor(ready, 15000, 300);
      if (!btn) return manualWait('\nClick Post on Facebook yourself, or Skip.');
    }
    if (alive() && composerOpen()) yourTurn(ready());
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
    if (run.switchedToPage) msg += '\nYou may still be using Facebook as your Page.';
    const back = {
      label: 'Switch back to my profile',
      run: async () => {
        const { fbTargets } = await chrome.storage.local.get('fbTargets');
        const names = [...run.items, ...(fbTargets || [])].filter((t) => t.kind === 'page').map((t) => cleanName(t.name));
        ui.update({ mode: modeTag(run), name: 'Switching back to your profile…', msg: '', buttons: [] });
        const ok = await switchToPersonal(names);
        if (ok) {
          const r = await getRun();
          if (r) await setRun({ ...r, dismissed: true, switchedToPage: false });
          return ui.unmount();
        }
        ui.update({
          mode: modeTag(run),
          name: 'Couldn’t find your profile in Facebook’s menu.',
          msg: 'Click your profile picture (top right), then choose your name.',
          error: true,
          buttons: [{ label: 'Close', kind: 'primary', run: () => ui.unmount() }],
        });
      },
    };
    ui.update({
      mode: modeTag(run),
      name: head,
      msg,
      error: !!run.stopReason,
      progress: run.status === 'done' ? 1 : progress(run),
      buttons: [
        ...(run.switchedToPage ? [back] : []),
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

  // Only a real change of step (run, status, position, timer, dismissed) restarts the work on this page.
  const runKey = (r) => (r ? `${r.id}|${r.status}|${r.index}|${r.nextAt || 0}|${r.dismissed ? 1 : 0}` : '');
  let lastKey = null;

  async function tick(force = false) {
    if (leaving) return;
    const run = await getRun();
    lastKey = runKey(run);
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
    if (run.learningPages) {
      if (location.pathname !== new URL(PAGES_LIST_URL).pathname) return; // on the way to "Your Pages"
      busy = true;
      ui.update({ meta: meta(run), mode: modeTag(run), name: 'Checking which profiles are your Pages…', msg: '', buttons: [] });
      try {
        await scan('pages'); // saves the names of all your Pages
      } catch {
        /* carry on: the group step will ask you if it still can't tell */
      }
      const r = await getRun();
      r.learningPages = false;
      busy = false;
      return goToCurrent(r);
    }
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
      if (run.index === 0 && !run.learnedPersonal && run.items.some((i) => i.kind === 'page')) {
        run.learnedPersonal = true;
        await setRun(run);
        const { fbPersonalName } = await chrome.storage.local.get('fbPersonalName');
        if (!fbPersonalName && (await openAccountMenu())) {
          await rememberPersonal();
          closeMenus();
          await sleep(500);
        }
      }
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

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.fbRun) return;
    const key = runKey(changes.fbRun.newValue);
    if (key === lastKey) return; // e.g. RitPost noting a switch attempt: not a new step
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
      const text = cleanName(textOf(a));
      const name = text || cleanName(a.getAttribute('aria-label'));
      if (!name || name.length > 100 || NOT_A_NAME.test(name)) continue;
      const fromText = !!text;
      const prev = found.get(key);
      // Prefer a visible link text over a picture's label, then the longer (fuller) name.
      if (!prev || (fromText && !prev.fromText) || (fromText === prev.fromText && name.length > prev.name.length && name.length < 80))
        found.set(key, { name, url, fromText });
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
    const items = collect().map(({ name, url }) => ({ name, url }));
    if (kind === 'pages' && items.length) await chrome.storage.local.set({ fbPageNames: items.map((i) => i.name) });
    return items;
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
