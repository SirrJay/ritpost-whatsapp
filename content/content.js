/*
 * RitPost — content script (runs on web.whatsapp.com)
 *
 * Walks through the queued groups one by one: opens the chat, places the
 * message (and any attachments, with the message as caption) and then either
 * waits for you to press Enter / Send (Manual mode, the default) or presses
 * Send itself after a visible countdown (Automatic mode, opt-in).
 * As soon as the post is sent it advances to the next group.
 */
(() => {
  'use strict';
  if (window.__ritpostLoaded) return;
  window.__ritpostLoaded = true;

  // Remove UI left behind by a previous copy of the extension (after an update/reload).
  document.querySelectorAll('#ritpost-overlay, #ritpost-launcher').forEach((el) => el.remove());

  // ───────────────────────── helpers ─────────────────────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  const visible = (el) => !!(el && el.isConnected && el.getClientRects().length);

  // Invisible / formatting characters WhatsApp and emoji sequences sprinkle into names.
  const INVISIBLE = /[­​-‏‪-‮⁠-⁤﻿︎️]/g;
  // Emoji, pictographs and other symbols — split points when building search queries.
  const SYMBOLS = /[\p{Extended_Pictographic}\p{So}\p{Sk}‍⃣︎️]+/gu;

  /** Whitespace/invisible-insensitive form (keeps emoji). */
  const loose = (s) => String(s || '').normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/g, '').toLowerCase();
  /** Letters & digits only (drops emoji, punctuation, spacing). */
  const alnum = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

  /** 2 = exact (ignoring spacing), 1 = same letters/digits (emoji rendered as images), 0 = no match. */
  function matchLevel(candidate, name) {
    if (!candidate || !name) return 0;
    if (loose(candidate) === loose(name)) return 2;
    const a = alnum(name);
    if (a.length >= 2 && alnum(candidate) === a) return 1;
    return 0;
  }

  /** Text of an element including emoji rendered as <img alt="…">. */
  function textOf(el) {
    if (!el) return '';
    let out = '';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) out += n.nodeValue;
      else if (n.tagName === 'IMG') out += n.getAttribute('alt') || '';
    }
    return out;
  }

  async function waitFor(fn, timeout = 10000, interval = 200) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (run.action === 'stop') return null;
      const v = fn();
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  // ─────────────────────── WhatsApp DOM ───────────────────────
  const isAppReady = () => !!($('#pane-side') || $('#side'));

  function searchBox() {
    const selectors = [
      '#side [contenteditable="true"][data-tab="3"]',
      '#side [contenteditable="true"][role="textbox"]',
      '#side input[data-tab="3"]',
      '#side input[role="textbox"]',
      '#side input[type="text"]',
      '#side input[type="search"]',
      '[contenteditable="true"][data-tab="3"]',
      'input[data-tab="3"]',
      '[contenteditable="true"][aria-label*="search" i]',
      'input[aria-label*="search" i]',
      'input[placeholder*="search" i]',
    ];
    for (const sel of selectors) {
      const el = $$(sel).find((e) => visible(e) && !e.closest('#main'));
      if (el) return el;
    }
    return null;
  }

  function composeBox() {
    const main = $('#main');
    if (!main) return null;
    return (
      $('footer [contenteditable="true"][role="textbox"]', main) ||
      $('footer [contenteditable="true"]', main) ||
      $('[contenteditable="true"][data-tab="10"]', main) ||
      $('[contenteditable="true"][role="textbox"]', main)
    );
  }

  /** Editor text with line breaks (<br> and paragraphs) and emoji <img alt>. */
  function editorText(root) {
    if (!root) return '';
    let out = '';
    const walk = (node) => {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) out += n.nodeValue;
        else if (n.nodeType === 1) {
          const tag = n.tagName;
          if (tag === 'BR') out += '\n';
          else if (tag === 'IMG') out += n.getAttribute('alt') || '';
          else {
            const block = tag === 'P' || tag === 'DIV';
            if (block && out && !out.endsWith('\n')) out += '\n';
            walk(n);
            if (block && !out.endsWith('\n')) out += '\n';
          }
        }
      }
    };
    walk(root);
    return out;
  }

  const composeRaw = () => editorText(composeBox());
  const composeEmpty = () => loose(composeRaw()) === '';

  function headerTexts() {
    const header = $('#main header');
    if (!header) return [];
    const out = [];
    $$('span, div[title]', header).forEach((s) => {
      const t = s.getAttribute('title');
      if (t) out.push(t);
      if (s.tagName === 'SPAN') out.push(textOf(s));
    });
    return out;
  }
  const headerSignature = () => loose(textOf($('#main header'))).slice(0, 200);

  /** Strict: the open chat is exactly this group. */
  const chatIsOpen = (name) => headerTexts().some((t) => matchLevel(t, name) > 0);

  /** Lenient confirmation after we clicked the matching row ourselves. */
  function chatOpenedAfterClick(name, beforeSig) {
    if (chatIsOpen(name)) return true;
    if (headerSignature() === beforeSig) return false;
    const a = alnum(name);
    if (a.length < 4) return false;
    return headerTexts().some((t) => {
      const b = alnum(t);
      return b.length >= 4 && (b.startsWith(a) || a.startsWith(b));
    });
  }

  function listRoots() {
    return uniq([$('#pane-side'), $('#side'), ...$$('[aria-label*="search results" i]')]);
  }

  /** Candidate chat-name nodes currently rendered in the left column. */
  function nameNodes() {
    const out = [];
    const seen = new Set();
    for (const root of listRoots()) {
      let rows = $$('[role="listitem"]', root);
      if (!rows.length) rows = $$('[role="row"]', root);
      if (!rows.length) rows = $$('span[title]', root).map((s) => s.parentElement || s);
      for (const row of rows) {
        if (seen.has(row)) continue;
        seen.add(row);
        const t = $('span[title]', row);
        const d = $('span[dir="auto"]', row);
        if (t) out.push({ el: t, row, text: t.getAttribute('title') }, { el: t, row, text: textOf(t) });
        if (d && d !== t) out.push({ el: d, row, text: textOf(d) });
      }
    }
    return out;
  }

  // ── Group vs. contact detection ──
  // page-bridge.js (MAIN world) reads WhatsApp's own chat data and tags each row.
  const KIND_ATTR = 'data-ritpost-kind';

  function classifyRows() {
    try {
      document.dispatchEvent(new CustomEvent('ritpost:classify'));
    } catch {
      /* ignore */
    }
  }

  function rowKind(row) {
    const k = row.getAttribute(KIND_ATTR);
    if (k && k !== 'unknown') return k;
    // Fallback: default avatars (only present when the chat has no photo).
    if (row.querySelector('[data-icon*="default-group"]')) return 'group';
    if (row.querySelector('[data-icon*="default-user"], [data-icon*="default-contact"]')) return 'user';
    return 'unknown';
  }

  /** Best matching row for a group name; prefers rows known to be groups. */
  function findChatInList(name) {
    classifyRows();
    let best = null;
    let score = 0;
    for (const n of nameNodes()) {
      const l = matchLevel(n.text, name);
      if (!l) continue;
      const kind = rowKind(n.row);
      const s = l * 10 + (kind === 'group' ? 3 : kind === 'unknown' ? 2 : 0);
      if (s > score) {
        best = n;
        score = s;
      }
    }
    return best;
  }

  function fireClick(el) {
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, view: window, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', base));
    el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', base));
    el.dispatchEvent(new MouseEvent('click', base));
  }

  async function clickAndConfirm(node, name) {
    const before = headerSignature();
    const targets = uniq([
      node.el,
      node.row.querySelector('[role="gridcell"]'),
      node.row.querySelector('[tabindex]'),
      node.row,
    ]);
    for (const t of targets) {
      if (!t.isConnected) continue;
      fireClick(t);
      if (await waitFor(() => chatOpenedAfterClick(name, before), 2500, 150)) return true;
    }
    // Keyboard fallback
    const focusable = node.row.matches('[tabindex]') ? node.row : node.row.querySelector('[tabindex]');
    if (focusable?.isConnected) {
      focusable.focus();
      focusable.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      if (await waitFor(() => chatOpenedAfterClick(name, before), 2500, 150)) return true;
    }
    return false;
  }

  function fieldValue(el) {
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el.value : textOf(el);
  }

  function setFieldText(el, text) {
    el.focus();
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    document.execCommand('selectAll', false, null);
    if (text) document.execCommand('insertText', false, text);
    else document.execCommand('delete', false, null);
  }

  async function typeSearch(query) {
    const sb = searchBox();
    if (!sb) return false;
    setFieldText(sb, query);
    await sleep(200);
    const box = searchBox();
    if (box && loose(fieldValue(box)) !== loose(query)) {
      // Fallback: synthetic paste into the search field.
      box.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      const dt = new DataTransfer();
      dt.setData('text/plain', query);
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      await sleep(200);
    }
    return true;
  }

  function clearSearch() {
    const sb = searchBox();
    if (sb && loose(fieldValue(sb))) setFieldText(sb, '');
  }

  /** Search terms that WhatsApp's search handles well (no emoji). */
  function searchQueries(name) {
    const segments = name
      .normalize('NFKC')
      .replace(INVISIBLE, '')
      .split(SYMBOLS)
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => alnum(s).length >= 2)
      .sort((a, b) => b.length - a.length);
    const words = (name.normalize('NFKC').match(/[\p{L}\p{N}]{3,}/gu) || []).sort((a, b) => b.length - a.length);
    return uniq([segments[0], words[0], segments.length ? null : name.trim()]).slice(0, 3);
  }

  function scrollContainer(pane) {
    if (pane.scrollHeight > pane.clientHeight + 4) return pane;
    let el = pane.parentElement;
    while (el && el !== document.body) {
      if (el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el;
      el = el.parentElement;
    }
    const inner = $$('*', pane).find((e) => e.scrollHeight > e.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(e).overflowY));
    return inner || pane;
  }

  async function scrollFind(name) {
    clearSearch();
    await sleep(700);
    const pane = $('#pane-side');
    if (!pane) return null;
    const sc = scrollContainer(pane);
    sc.scrollTop = 0;
    await sleep(350);
    for (let i = 0; i < 400; i++) {
      if (run.action === 'stop') return null;
      const hit = findChatInList(name);
      if (hit) return hit;
      if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) break;
      sc.scrollTop += Math.max(240, sc.clientHeight * 0.7);
      await sleep(200);
    }
    return findChatInList(name);
  }

  async function openChat(name, report) {
    if (chatIsOpen(name)) return true;

    // 1. Already rendered in the chat list.
    let node = findChatInList(name);
    if (node && (await clickAndConfirm(node, name))) return true;

    // 2. WhatsApp search, using emoji-free terms.
    if (searchBox()) {
      for (const q of searchQueries(name)) {
        if (run.action === 'stop') return false;
        report(`Searching for “${q}”…`);
        await typeSearch(q);
        node = await waitFor(() => findChatInList(name), 5000, 200);
        if (node && (await clickAndConfirm(node, name))) return true;
      }
    }

    // 3. Scroll through the full chat list.
    if (run.action === 'stop') return false;
    report('Looking through your chat list…');
    node = await scrollFind(name);
    if (node && (await clickAndConfirm(node, name))) return true;
    return false;
  }

  function placeCaretAtEnd(el) {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /** Non-empty lines of a message, compared without emoji/spacing differences. */
  const lineKeys = (s) =>
    String(s || '')
      .split('\n')
      .map((l) => loose(l))
      .filter(Boolean);

  /**
   * 0 = message not in the box, 1 = text is there but line breaks were lost,
   * 2 = text and line breaks are intact.
   */
  function composeQuality(text) {
    return editorQuality(composeBox, text);
  }

  function editorQuality(getBox, text) {
    const got = editorText(getBox());
    const want = alnum(text);
    if (want.length < 3) return loose(got).length > 0 ? 2 : 0;
    const have = alnum(got);
    if (!(have.includes(want.slice(0, 24)) && have.length >= want.length * 0.9)) return 0;
    return lineKeys(got).length >= lineKeys(text).length ? 2 : 1;
  }

  function selectContents(el) {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /**
   * Empties one of WhatsApp's editors. Current WhatsApp (Lexical) ignores execCommand('delete'),
   * so a delete input event over the selected contents is used when that doesn't work.
   */
  async function clearEditor(getBox) {
    const b = getBox();
    if (!b) return null;
    const empty = () => loose(editorText(getBox() || b)) === '';
    if (empty()) return b;
    selectContents(b);
    document.execCommand('delete', false, null);
    await sleep(150);
    for (let i = 0; i < 3 && !empty(); i++) {
      const box = getBox() || b;
      selectContents(box);
      box.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true, composed: true }));
      await sleep(150);
    }
    return getBox() || b;
  }
  const clearCompose = () => clearEditor(composeBox);

  // Ways of putting text into one of WhatsApp's editors. None of them can send.
  const fillStrategies = [
    async (getBox, text) => {
      // Synthetic paste: keeps emoji intact and usually keeps line breaks.
      const b = await clearEditor(getBox);
      if (!b) return;
      await sleep(60);
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      b.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    async (getBox, text) => {
      // Line by line, with soft line breaks between lines.
      if (!(await clearEditor(getBox))) return;
      await sleep(60);
      text.split('\n').forEach((line, i) => {
        if (i) document.execCommand('insertLineBreak', false, null);
        if (line) document.execCommand('insertText', false, line);
      });
    },
    async (getBox, text) => {
      // Line by line, with paragraphs between lines.
      if (!(await clearEditor(getBox))) return;
      await sleep(60);
      text.split('\n').forEach((line, i) => {
        if (i) document.execCommand('insertParagraph', false, null);
        if (line) document.execCommand('insertText', false, line);
      });
    },
  ];

  async function fillEditor(getBox, text) {
    if (!(await waitFor(getBox, 6000))) return false;

    let bestIndex = -1;
    let bestQuality = 0;
    for (let i = 0; i < fillStrategies.length; i++) {
      await fillStrategies[i](getBox, text);
      await sleep(350);
      const q = editorQuality(getBox, text);
      if (q === 2) {
        placeCaretAtEnd(getBox());
        return true;
      }
      if (q > bestQuality) {
        bestQuality = q;
        bestIndex = i;
      }
    }

    // No method kept every line break: use the best one that got the text in.
    if (bestIndex < 0) return false;
    await fillStrategies[bestIndex](getBox, text);
    await sleep(350);
    if (!editorQuality(getBox, text)) return false;
    placeCaretAtEnd(getBox());
    return true;
  }
  const fillCompose = (text) => fillEditor(composeBox, text);

  // ── Attachments ──
  /** True when el is actually in front at its own position (not covered by another layer). RitPost's own UI is ignored. */
  function onTop(el) {
    if (!visible(el)) return false;
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1);
    const y = Math.min(Math.max(r.top + Math.min(r.height / 2, 20), 1), window.innerHeight - 1);
    for (const hit of document.elementsFromPoint(x, y)) {
      if (hit.id === 'ritpost-overlay' || hit.id === 'ritpost-launcher') continue;
      return hit === el || el.contains(hit) || hit.contains(el);
    }
    return false;
  }

  const clickable = (el) => el.closest('button, [role="button"]') || el;
  const iconLabel = (el) =>
    [el.getAttribute('data-icon'), el.getAttribute('aria-label'), el.getAttribute('title'), el.querySelector?.('title')?.textContent]
      .filter(Boolean)
      .join(' ');

  /** Buttons that look like a Send button (WhatsApp uses data-icon, aria-label or an SVG <title>). */
  function sendLikeButtons() {
    const found = new Set();
    $$('[data-icon*="send" i], [aria-label="Send" i], [title="Send" i]').forEach((e) => found.add(clickable(e)));
    $$('svg title').forEach((t) => {
      if (/send/i.test(t.textContent || '')) found.add(clickable(t.closest('svg')));
    });
    return [...found].filter((b) => !b.closest('#side'));
  }

  /** Buttons that close/discard the attachment editor. */
  function closeLikeButtons() {
    const found = new Set();
    $$('[data-icon="x"], [data-icon="x-alt"], [data-icon*="close" i], [aria-label="Close" i], [aria-label="Cancel" i], [aria-label="Discard" i]').forEach((e) =>
      found.add(clickable(e))
    );
    $$('svg title').forEach((t) => {
      if (/^(x|x-alt|close|.*-close.*|.*ic-close.*)$/i.test((t.textContent || '').trim())) found.add(clickable(t.closest('svg')));
    });
    return [...found].filter((b) => !b.closest('#side'));
  }

  const buttonWithText = (re) =>
    $$('button, [role="button"]').find((b) => visible(b) && re.test((b.textContent || '').trim()) && !b.closest('#side'));

  const distance = (a, b) => {
    const r1 = a.getBoundingClientRect();
    const r2 = b.getBoundingClientRect();
    return Math.hypot(r1.left + r1.width / 2 - (r2.left + r2.width / 2), r1.top + r1.height / 2 - (r2.top + r2.height / 2));
  };

  /**
   * WhatsApp's attachment preview / media editor, if it is open: its Send button and caption box.
   */
  function mediaPreview() {
    // Current WhatsApp Web: the editor opens in the "drawer-middle" panel, with a marked caption box
    // and a Send button labelled "Send 1 selected" (icon "ic-send-filled"). The header stays visible.
    const caption = $$('[data-testid="media-caption-input-container"], [data-testid*="caption-input" i]').find(visible) || null;
    const editorMark = $$('[data-testid^="media-editor"], [data-testid="media-caption-input-container"]').some(visible);
    const sendBtns = sendLikeButtons().filter((b) => visible(b) && !b.closest('#main footer'));
    const drawer = caption?.closest('[data-testid^="drawer"]') || $('[data-testid="drawer-middle"]');
    const btn =
      (drawer && sendBtns.find((b) => drawer.contains(b))) ||
      sendBtns.find((b) => /^send\b/i.test(b.getAttribute('aria-label') || '')) ||
      (editorMark ? sendBtns[0] : null) ||
      null;
    if (caption || editorMark || btn) return { btn, caption: caption || legacyCaption(btn) };
    return legacyPreview();
  }

  function legacyCaption(btn) {
    const caps = $$('[contenteditable="true"]').filter((c) => visible(c) && !c.closest('#side') && !c.closest('#main footer'));
    if (!caps.length) return null;
    return btn ? caps.sort((a, b) => distance(a, btn) - distance(b, btn))[0] : caps[0];
  }

  /** Older layouts: an editor that covers the chat header. */
  function legacyPreview() {
    const header = $('#main header');
    if (header && onTop(header)) return null; // the normal chat view is showing

    // With no header at all, the chat's own message bar isn't evidence of a preview.
    const notChatBar = (e) => header || !e.closest('#main footer');
    const btn = sendLikeButtons().find((b) => notChatBar(b) && onTop(b)) || null;
    const caps = $$('[contenteditable="true"]').filter((c) => !c.closest('#side') && notChatBar(c) && onTop(c));
    const labelled = caps.find((c) =>
      /caption/i.test(
        [c.getAttribute('aria-label'), c.getAttribute('aria-placeholder'), c.getAttribute('data-placeholder'), c.getAttribute('title')].join(' ')
      )
    );
    let caption = labelled || null;
    if (!caption && caps.length) caption = btn ? caps.slice().sort((a, b) => distance(a, btn) - distance(b, btn))[0] : caps[0];

    // Nothing recognisable and no chat at all: not a preview.
    if (!btn && !caption && !$('#main')) return null;
    return { btn, caption };
  }
  const captionBox = () => mediaPreview()?.caption || null;

  function filesTransfer(files) {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    return dt;
  }

  // Ways of handing files to WhatsApp. Each one only opens the preview; none of them sends.
  const attachStrategies = [
    async (files) => {
      // Paste the files into the message box, like Ctrl+V with copied files.
      const box = composeBox();
      if (!box) return;
      box.focus();
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: filesTransfer(files), bubbles: true, cancelable: true }));
    },
    async (files) => {
      // Drag and drop the files onto the open chat.
      const main = $('#main');
      if (!main) return;
      const r = main.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const fire = (el, type) =>
        el.dispatchEvent(new DragEvent(type, { dataTransfer: filesTransfer(files), bubbles: true, cancelable: true, clientX: x, clientY: y }));
      fire(main, 'dragenter');
      fire(main, 'dragover');
      await sleep(400);
      const zone = document.elementFromPoint(x, y) || main;
      fire(zone, 'dragenter');
      fire(zone, 'dragover');
      fire(zone, 'drop');
    },
    async (files) => {
      // WhatsApp's own Attach menu file input (the menu is opened; the file picker is not).
      const media = files.every((f) => /^(image|video)\//.test(f.type));
      const pick = () => {
        const inputs = $$('#main input[type="file"], #app input[type="file"]');
        return media
          ? inputs.find((i) => /image|video/.test(i.accept || ''))
          : inputs.find((i) => !i.accept || i.accept === '*' || !/image/.test(i.accept));
      };
      let input = pick();
      if (!input) {
        const icon = $(
          '#main footer [data-icon="plus-rounded"], #main footer [data-icon="plus"], #main footer [data-icon="attach-menu-plus"], #main footer [data-icon="clip"], #main footer [data-icon*="attach"]'
        );
        const titled = $$('#main footer svg title').find((t) => /attach|plus|clip/i.test(t.textContent || ''));
        const btn =
          $('#main footer button[aria-label="Attach" i], #main footer [role="button"][aria-label="Attach" i], #main footer [title="Attach" i]') ||
          icon?.closest('button, [role="button"]') ||
          (titled && clickable(titled.closest('svg')));
        if (!btn) return;
        fireClick(btn);
        input = await waitFor(pick, 2500, 150);
      }
      if (!input) return;
      input.files = filesTransfer(files).files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
  ];

  /**
   * Hands the files to WhatsApp. As soon as anything opens over the chat, RitPost stops:
   * it never presses Escape or stacks a second attempt on top of an open editor.
   */
  async function attachFiles(files) {
    for (const attempt of attachStrategies) {
      if (mediaPreview()) return true;
      try {
        await attempt(files);
      } catch {
        /* try the next way */
      }
      if (await waitFor(mediaPreview, 7000, 200)) return true;
      // The attach menu may still be open after the last way; a click on the chat closes it harmlessly.
    }
    return false;
  }

  /** Close an attachment preview without sending it (only used before re-attaching on Retry). */
  async function closePreview() {
    for (let i = 0; i < 4; i++) {
      if (!mediaPreview()) return true;
      const discard = buttonWithText(/^discard$/i);
      if (discard) {
        fireClick(discard);
      } else {
        const x = closeLikeButtons().find(onTop);
        if (x) fireClick(x);
        else document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      }
      await waitFor(() => !mediaPreview(), 1500, 150);
    }
    return !mediaPreview();
  }

  /** Presses Send in the attachment preview. True once the preview closes. */
  async function pressPreviewSend() {
    const p = mediaPreview();
    if (!p) return false;
    if (p.btn) {
      fireClick(p.btn);
      if (await waitFor(() => !mediaPreview(), 8000, 150)) return true;
    }
    const cap = captionBox();
    if (cap) {
      cap.focus();
      for (const type of ['keydown', 'keypress', 'keyup']) {
        cap.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      }
    }
    return !!(await waitFor(() => !mediaPreview(), 8000, 150));
  }

  /** Keeps the RitPost panel off the preview's caption box and Send button. */
  function previewAvoidRect() {
    const p = mediaPreview();
    if (!p) return null;
    const rects = [p.btn, p.caption].filter(Boolean).map((e) => e.getBoundingClientRect());
    if (!rects.length) {
      // Unrecognised editor: keep clear of the bottom of the conversation area, where its Send button sits.
      const m = ($('#main') || document.body).getBoundingClientRect();
      return { left: m.left, right: m.right, top: window.innerHeight - 110, bottom: window.innerHeight };
    }
    return {
      left: Math.min(...rects.map((r) => r.left)),
      right: Math.max(...rects.map((r) => r.right)),
      top: Math.min(...rects.map((r) => r.top)),
      bottom: Math.max(...rects.map((r) => r.bottom)),
    };
  }

  /** Rebuild File objects from what the side panel saved (data URLs in chrome.storage). */
  async function loadFiles(ids) {
    if (!ids?.length) return [];
    const { attachments } = await chrome.storage.local.get('attachments');
    const byId = new Map((attachments || []).map((a) => [a.id, a]));
    const files = [];
    for (const id of ids) {
      const a = byId.get(id);
      if (!a?.data) throw new Error('An attachment is missing. Attach the file again in RitPost.');
      const b64 = a.data.slice(a.data.indexOf(',') + 1);
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      files.push(new File([bytes], a.name, { type: a.type || 'application/octet-stream', lastModified: Date.now() }));
    }
    return files;
  }

  // ── Send detection ──
  // The user's own Enter key / Send-button click in the open chat.
  let lastSendIntent = 0;
  document.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted || e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      const t = e.target;
      if (!t?.closest || t.closest('#side')) return;
      // The chat's message box, or the caption box of an attachment preview.
      if (t.closest('#main footer, [contenteditable="true"]')) lastSendIntent = Date.now();
    },
    true
  );
  const onSendClick = (e) => {
    if (!e.isTrusted) return;
    const btn = e.target?.closest?.('button, [role="button"]');
    if (!btn || btn.closest('#side')) return;
    const label = `${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('title') || ''} ${btn.getAttribute('data-tab') || ''}`;
    const svgTitle = [...btn.querySelectorAll('svg title')].map((t) => t.textContent).join(' ');
    if (btn.querySelector('[data-icon*="send" i]') || /send/i.test(label) || /send/i.test(svgTitle)) lastSendIntent = Date.now();
  };
  document.addEventListener('pointerdown', onSendClick, true);
  document.addEventListener('click', onSendClick, true);

  /** Recent message bubbles in the open chat (newest last). */
  function recentMessages(limit = 8) {
    const main = $('#main');
    if (!main) return [];
    let rows = $$('[role="row"]', main);
    if (!rows.length) rows = $$('.message-out, .message-in, [data-id]', main);
    return rows.slice(-limit);
  }

  /** True when a just-sent bubble containing this message is visible in the chat. */
  function messageInChat(text) {
    const want = alnum(text).slice(0, 40);
    if (want.length < 6) return false;
    return recentMessages().some((row) => alnum(textOf(row)).includes(want));
  }

  /** Changes whenever a new message appears in the open chat. */
  function outgoingSignature() {
    const main = $('#main');
    if (!main) return '';
    const outs = $$('.message-out', main);
    const ids = $$('[data-id^="true_"]', main);
    const lastId = ids.length ? ids[ids.length - 1].getAttribute('data-id') : '';
    const rows = recentMessages(3);
    const lastRow = rows.length ? loose(textOf(rows[rows.length - 1])).slice(-80) : '';
    return `${outs.length}|${ids.length}|${lastId}|${lastRow}`;
  }

  // ─────────────────────── chat import ───────────────────────
  async function scanChats() {
    const pane = $('#pane-side');
    if (!pane) return { ok: false, error: 'WhatsApp Web is still loading or you are not signed in.' };
    clearSearch();
    await sleep(500);

    const chats = new Map();
    const collect = () => {
      classifyRows();
      let rows = $$('[role="listitem"]', pane);
      if (!rows.length) rows = $$('[role="row"]', pane);
      rows.forEach((row) => {
        const t = $('span[title]', row);
        const d = $('span[dir="auto"]', row);
        const name = (t?.getAttribute('title') || textOf(d) || '').replace(INVISIBLE, '').trim();
        if (!name) return;
        const kind = rowKind(row);
        const prev = chats.get(loose(name));
        if (!prev || (prev.kind === 'unknown' && kind !== 'unknown')) chats.set(loose(name), { name, kind });
      });
    };

    const sc = scrollContainer(pane);
    const original = sc.scrollTop;
    sc.scrollTop = 0;
    await sleep(300);
    for (let i = 0; i < 400; i++) {
      collect();
      if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) break;
      sc.scrollTop += Math.max(200, sc.clientHeight * 0.8);
      await sleep(220);
    }
    collect();
    sc.scrollTop = original;

    const list = [...chats.values()].sort((a, b) => a.name.localeCompare(b.name));
    const classified = list.filter((c) => c.kind !== 'unknown').length;
    return { ok: true, chats: list, classified };
  }

  // ─────────────────────── run controller ───────────────────────
  const run = {
    active: false,
    items: [],
    index: 0,
    results: [],
    paused: false,
    action: null,
    settings: { delayMs: 2000 },
    attachmentIds: [],
    files: [],
    startedAt: 0,
  };

  const takeAction = () => {
    const a = run.action;
    run.action = null;
    return a;
  };

  async function waitForAction(timeoutMs = Infinity) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (run.action) return takeAction();
      await sleep(150);
    }
    return 'timeout';
  }

  async function pausableDelay(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (run.action === 'stop') return;
      await sleep(100);
    }
  }

  async function waitWhilePaused() {
    if (!run.paused) return;
    ui.update({ phase: 'paused', status: 'Paused. Click Resume to continue with the next group.' });
    while (run.paused && run.action !== 'stop') await sleep(200);
  }

  // ── Automatic sending (opt-in) ──
  const isAuto = () => run.settings.mode === 'auto';

  /** Countdown length for this group, optionally varied by -15% to +25%. */
  function intervalMs() {
    const sec = Math.min(600, Math.max(5, Number(run.settings.intervalSec) || 6));
    const factor = run.settings.randomize === false ? 1 : 0.85 + Math.random() * 0.4;
    return Math.round(sec * 1000 * factor);
  }

  const LINK_RE = /(https?:\/\/|www\.)\S+/i;
  const linkPreviewEl = () => $('#main footer [data-testid="compose-box-link-preview"]');
  /** WhatsApp's link preview above the message box, once it has loaded (title or image). */
  const linkPreviewReady = () => {
    const el = linkPreviewEl();
    return el && (el.querySelector('img') || textOf(el).length > 3) ? el : null;
  };
  /** Wait for the link preview; if WhatsApp hasn't made one, nudge it like typing a space after the link. */
  async function waitLinkPreview() {
    ui.update({ phase: 'filling', status: 'Loading the link preview…' });
    if (await waitFor(linkPreviewReady, 5000, 250)) return true;
    const box = composeBox();
    if (box) {
      placeCaretAtEnd(box);
      document.execCommand('insertText', false, ' ');
    }
    return !!(await waitFor(linkPreviewReady, 5000, 250));
  }

  function sendButton() {
    const main = $('#main');
    if (!main) return null;
    const icon = $('footer [data-icon="send"], footer [data-icon="wds-ic-send-filled"], footer [data-icon*="send" i]', main);
    const titled = $$('footer svg title', main).find((t) => /send/i.test(t.textContent || ''));
    return (
      icon?.closest('button, [role="button"]') ||
      $('footer button[aria-label="Send" i], footer [role="button"][aria-label="Send" i]', main) ||
      (titled && clickable(titled.closest('svg'))) ||
      icon
    );
  }

  /** Presses WhatsApp's Send button (Enter key as fallback). True once the box empties. */
  async function pressSend() {
    const btn = sendButton();
    if (btn) {
      fireClick(btn);
      if (await waitFor(composeEmpty, 4000, 150)) return true;
    }
    const box = composeBox();
    if (!box || composeEmpty()) return composeEmpty();
    box.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) {
      box.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
    return !!(await waitFor(composeEmpty, 4000, 150));
  }

  /**
   * Visible countdown, then a safety check and a Send press.
   * Returns 'sent' | 'manual' | 'failed' | 'skip' | 'stop' | 'retry'.
   */
  /** How a group's pending post is checked and sent: a text message, or an attachment preview. */
  const textCtx = (item) => ({
    pending: () => !composeEmpty(),
    inChat: () => chatIsOpen(item.name),
    verify: () => chatIsOpen(item.name) && !!composeQuality(item.text),
    press: async () => {
      await waitFor(() => !linkPreviewEl() || linkPreviewReady(), 4000, 200);
      return pressSend();
    },
    sentExtra: () => messageInChat(item.text),
    ready: 'Review the message, then press Enter to send.',
    cleared: 'The message box is empty. Refill it, or mark this group as sent.',
  });
  const mediaCtx = (item) => ({
    pending: () => !!mediaPreview(),
    // While the preview is up the chat behind it is the one RitPost opened.
    inChat: () => !!mediaPreview() || chatIsOpen(item.name),
    verify: () => {
      const p = mediaPreview();
      if (!p) return false;
      if (!item.text.trim()) return true;
      return !!p.caption && !!editorQuality(() => p.caption, item.text);
    },
    press: pressPreviewSend,
    sentExtra: () => false,
    ready: 'Check the preview, then press Enter (or click Send) to send.',
    cleared: 'The attachment preview was closed. Click Refill to attach again, or mark this group as sent.',
  });

  async function autoSend(item, ctx, delayMs = null) {
    let remaining = delayMs ?? intervalMs();
    let last = Date.now();
    for (;;) {
      const a = run.action;
      if (a) {
        run.action = null;
        if (a === 'sendnow') break;
        if (a === 'hold') {
          run.held = true;
          return 'manual';
        }
        if (a === 'marksent') return 'sent';
        if (a === 'skip' || a === 'stop' || a === 'retry') return a;
      }
      // Switched to manual, left the chat, or sent/cleared it by hand: let the manual flow take over.
      if (!isAuto() || !ctx.inChat() || !ctx.pending()) return 'manual';

      const now = Date.now();
      if (!run.paused) remaining -= now - last;
      last = now;
      if (remaining <= 0) break;

      ui.update(
        run.paused
          ? { phase: 'paused', status: 'Countdown paused. Click Resume to continue.' }
          : { phase: 'countdown', status: `Sending automatically in ${Math.ceil(remaining / 1000)}s…`, remaining }
      );
      await sleep(200);
    }

    // Last safety check right before pressing Send.
    if (!ctx.verify()) return 'manual';
    ui.update({ phase: 'filling', status: 'Sending…' });
    return (await ctx.press()) ? 'sent' : 'failed';
  }

  async function waitForSend(item, baseline, readyMsg, ctx) {
    let emptySince = 0;
    lastSendIntent = 0;
    const startedAt = Date.now();
    // Any one of these, once nothing is left to send, means the user sent it.
    const wasSent = () => lastSendIntent > startedAt || outgoingSignature() !== baseline || ctx.sentExtra();
    for (;;) {
      await sleep(300);
      const a = run.action;
      if (a === 'skip' || a === 'stop' || a === 'retry' || a === 'marksent') {
        run.action = null;
        return a === 'marksent' ? 'sent' : a;
      }

      if (!ctx.inChat()) {
        emptySince = 0;
        ui.update({ phase: 'away', status: 'You switched to another chat. Click “Reopen” to return to this group.' });
        continue;
      }

      const empty = !ctx.pending();
      if (empty && wasSent()) return 'sent';

      // User switched (back) to automatic mode mid-group.
      if (!empty && isAuto() && !run.held) return 'auto';

      if (empty) {
        if (!emptySince) emptySince = Date.now();
        else if (Date.now() - emptySince > 4000)
          ui.update({ phase: 'cleared', status: ctx.cleared });
      } else {
        emptySince = 0;
        ui.update({ phase: 'ready', status: readyMsg });
      }
    }
  }

  async function processItem(item) {
    run.held = false;
    for (;;) {
      run.action = null;
      ui.update({ phase: 'opening', status: 'Opening chat…', current: item.name });

      const opened = await openChat(item.name, (s) => ui.update({ phase: 'opening', status: s })).catch(() => false);
      if (run.action === 'stop') return { status: 'cancelled' };
      if (!opened) {
        ui.update({ phase: 'error', status: 'Couldn’t find this group in your chats. Skipping in a moment…' });
        const a = await waitForAction(3500);
        if (a === 'retry') continue;
        if (a === 'stop') return { status: 'cancelled' };
        return { status: 'notfound', reason: 'Not found in your chat list (check the name, or unarchive it)' };
      }

      ui.update({ phase: 'filling', status: 'Adding your message…' });
      const hasBox = await waitFor(composeBox, 6000);
      if (!hasBox) {
        ui.update({ phase: 'error', status: 'You can’t post in this group (admin-only or you’ve left).' });
        const a = await waitForAction(4000);
        if (a === 'retry') continue;
        if (a === 'stop') return { status: 'cancelled' };
        return { status: 'readonly', reason: 'Posting is restricted in this group' };
      }

      // A preview left over from an earlier attempt would be sent by mistake.
      if (mediaPreview()) await closePreview();

      // WhatsApp never shows a link preview on a caption: with files and a link, send the files first and the
      // message as its own text right after, so the preview shows (unless the user turned that off).
      const text = item.text || '';
      const split = run.files.length > 0 && !!text.trim() && LINK_RE.test(text) && run.settings.linkSeparate !== false;

      if (run.files.length) {
        await clearCompose();
        const baseline = outgoingSignature();
        ui.update({ phase: 'filling', status: `Attaching ${run.files.length === 1 ? 'your file' : `${run.files.length} files`}…` });
        const attached = await attachFiles(run.files).catch(() => false);
        if (run.action === 'stop') return { status: 'cancelled' };
        if (!attached) {
          ui.update({ phase: 'error', status: 'Couldn’t attach the files in this chat. Click Retry or Skip.' });
          const a = await waitForAction();
          if (a === 'retry') continue;
          if (a === 'stop') return { status: 'cancelled' };
          return { status: 'failed', reason: 'Files could not be attached' };
        }
        const ctx = mediaCtx(split ? { ...item, text: '' } : item);
        let readyMsg = split
          ? 'Check the files, then press Enter (or click Send). Your message follows as its own text, so the link preview shows.'
          : ctx.ready;
        if (!split && text.trim()) {
          ui.update({ phase: 'filling', status: 'Adding your message as the caption…' });
          const captioned = await fillEditor(captionBox, text).catch(() => false);
          if (!captioned) {
            // Never auto-send media without the caption the user wrote.
            run.held = true;
            readyMsg = 'Couldn’t add the caption. Type it in the preview, then press Enter to send.';
          }
        }
        const r = await sendLoop(item, ctx, baseline, readyMsg);
        if (r === 'retry') {
          run.held = false;
          continue;
        }
        if (r === 'stop') return { status: 'cancelled' };
        if (r === 'skip') return { status: 'skipped' };
        if (split) {
          const r2 = await sendTextPart(item, true);
          if (r2 === 'stop') return { status: 'cancelled' };
          if (r2 !== 'sent') return { status: 'failed', reason: 'The files were sent, but not the message' };
        }
      } else {
        const r = await sendTextPart(item, false);
        if (r === 'retry') {
          run.held = false;
          continue;
        }
        if (r === 'unfilled') return { status: 'failed', reason: 'Message could not be inserted' };
        if (r === 'stop') return { status: 'cancelled' };
        if (r === 'skip') return { status: 'skipped' };
      }
      ui.update({ phase: 'sent', status: 'Sent ✓' });
      return { status: 'sent' };
    }
  }

  /** Countdown/auto-send or wait for the user, until this part is sent (or skipped, stopped, retried). */
  async function sendLoop(item, ctx, baseline, readyMsg, autoDelayMs = null) {
    for (;;) {
      if (isAuto() && !run.held) {
        const r = await autoSend(item, ctx, autoDelayMs);
        if (r === 'sent' || r === 'skip' || r === 'stop' || r === 'retry') return r;
        if (r === 'failed') {
          run.held = true;
          readyMsg = 'RitPost couldn’t press Send in this chat. Press Enter to send it yourself.';
        }
      }
      ui.update({ phase: 'ready', status: readyMsg });
      const m = await waitForSend(item, baseline, readyMsg, ctx);
      if (m !== 'auto') return m;
    }
  }

  /**
   * Put the message in the chat box (waiting for its link preview) and send it.
   * `followUp`: it comes right after the files, so a short countdown, and Retry only refills the text.
   * Returns 'sent' | 'skip' | 'stop' | 'retry' | 'unfilled'.
   */
  async function sendTextPart(item, followUp) {
    for (;;) {
      if (followUp) await waitFor(() => !mediaPreview() && composeBox(), 8000, 200);
      ui.update({ phase: 'filling', status: followUp ? 'Adding your message with the link…' : 'Adding your message…' });
      const filled = await fillCompose(item.text).catch(() => false);
      if (!filled) {
        ui.update({ phase: 'error', status: 'Couldn’t place the message in the chat box. Click Retry or Skip.' });
        const a = await waitForAction();
        if (a === 'retry') {
          if (followUp) continue;
          return 'retry';
        }
        if (a === 'stop') return 'stop';
        return followUp ? 'skip' : 'unfilled';
      }
      if (LINK_RE.test(item.text || '')) await waitLinkPreview();
      if (run.action === 'stop') return 'stop';
      const baseline = outgoingSignature();
      const ctx = textCtx(item);
      const r = await sendLoop(item, ctx, baseline, ctx.ready, followUp ? 3000 : null);
      if (r === 'retry' && followUp) {
        run.held = false;
        await clearCompose();
        continue;
      }
      return r;
    }
  }

  function summary() {
    const c = { sent: 0, skipped: 0, notfound: 0, failed: 0, readonly: 0, cancelled: 0 };
    run.results.forEach((r) => (c[r.status] = (c[r.status] || 0) + 1));
    return c;
  }

  function persist(done) {
    try {
      chrome.storage.local.set({
        lastRun: {
          startedAt: run.startedAt,
          finishedAt: done ? Date.now() : null,
          total: run.items.length,
          results: run.results,
          counts: summary(),
          done,
        },
      });
    } catch {
      /* extension was reloaded; ignore */
    }
  }

  async function loop() {
    ui.update({ phase: 'opening', status: 'Waiting for WhatsApp Web to load…', current: run.items[0]?.name || '' });
    const ready = await waitFor(isAppReady, 90000, 500);
    if (!ready) {
      run.items.forEach((it) => run.results.push({ name: it.name, status: 'failed', reason: 'WhatsApp Web did not load' }));
      return finish('WhatsApp Web didn’t load. Make sure you’re signed in, then try again.');
    }
    await sleep(800);

    if (run.attachmentIds.length) {
      ui.update({ phase: 'opening', status: 'Preparing your attachments…' });
      try {
        run.files = await loadFiles(run.attachmentIds);
      } catch (e) {
        run.items.forEach((it) => run.results.push({ name: it.name, status: 'failed', reason: 'Attachments could not be loaded' }));
        return finish(e?.message || 'Your attachments couldn’t be loaded. Attach them again and restart.');
      }
    }

    while (run.index < run.items.length) {
      await waitWhilePaused();
      if (run.action === 'stop') break;

      const item = run.items[run.index];
      const res = await processItem(item);
      run.results.push({ name: item.name, ...res });
      run.index++;
      persist(false);

      if (res.status === 'cancelled' || run.action === 'stop') break;
      // In automatic mode the countdown is the interval, so only a short settle time is needed here.
      const after = res.status !== 'sent' ? 400 : isAuto() ? 1200 : run.settings.delayMs;
      if (run.index < run.items.length) await pausableDelay(after);
    }

    for (let i = run.results.length; i < run.items.length; i++) {
      run.results.push({ name: run.items[i].name, status: 'cancelled' });
    }
    finish();
  }

  let avoidTimer = 0;

  function finish(error) {
    clearInterval(avoidTimer);
    ui.avoid(null);
    run.active = false;
    run.action = null;
    run.index = run.items.length;
    clearSearch();
    persist(true);
    ui.update({ phase: 'done', status: error || '' });
  }

  function startRun(payload) {
    if (run.active) return { ok: false, error: 'A send session is already running in WhatsApp Web.' };
    const attachmentIds = Array.isArray(payload?.attachments) ? payload.attachments.filter(Boolean) : [];
    const items = (payload?.items || [])
      .filter((i) => i && i.name && (i.text || attachmentIds.length))
      .map((i) => ({ ...i, text: String(i.text || '') }));
    if (!items.length) return { ok: false, error: 'Nothing to send.' };

    Object.assign(run, {
      active: true,
      items,
      index: 0,
      results: [],
      paused: false,
      action: null,
      settings: { delayMs: 2000, mode: 'manual', intervalSec: 6, randomize: true, autoAck: false, ...(payload.settings || {}) },
      held: false,
      attachmentIds,
      files: [],
      startedAt: Date.now(),
    });
    ui.mount();
    clearInterval(avoidTimer);
    avoidTimer = setInterval(() => {
      if (run.active && run.files.length) ui.avoid(previewAvoidRect());
    }, 400);
    persist(false);
    loop();
    return { ok: true };
  }

  function retryUnsent() {
    const byName = new Map(run.items.map((i) => [i.name, i]));
    const items = run.results.filter((r) => r.status !== 'sent').map((r) => byName.get(r.name)).filter(Boolean);
    if (items.length) startRun({ items, settings: run.settings, attachments: run.attachmentIds });
  }

  // ─────────────────────── overlay panel ───────────────────────
  const ui = (() => {
    let host = null;
    let root = null;
    let collapsed = false;
    let lastKey = '';
    const view = { phase: 'opening', status: '', current: '' };
    const POS_KEY = 'ritpost:panel-pos';

    const LABELS = {
      sent: 'Sent',
      skipped: 'Skipped',
      notfound: 'Not found',
      failed: 'Failed',
      readonly: 'Can’t post',
      cancelled: 'Not sent',
    };

    const FONT = `"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", "Segoe UI Symbol", sans-serif`;

    const CSS = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: ${FONT}; }
      .card {
        --bg: #ffffff; --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; --soft: #f1f5f9;
        --brand: #0e7c66; --brand2: #14b88a; --gold: #d4a64a;
        --warn: #b45309; --warnbg: #fef3c7; --err: #b91c1c; --errbg: #fee2e2;
        width: 348px; background: var(--bg); color: var(--ink); border-radius: 18px; overflow: hidden;
        box-shadow: 0 30px 70px -20px rgba(15,23,42,.5), 0 0 0 1px rgba(15,23,42,.08);
        font-size: 13px; line-height: 1.45; animation: in .25s cubic-bezier(.2,.8,.2,1);
      }
      @media (prefers-color-scheme: dark) {
        .card { --bg: #111b21; --ink: #e9edef; --muted: #8696a0; --line: #233138; --soft: #1b2930;
                --warnbg: #3a2e12; --warn: #fbbf24; --errbg: #3b1717; --err: #f87171; }
      }
      @keyframes in { from { opacity: 0; transform: translateY(10px) scale(.98); } to { opacity: 1; transform: none; } }
      .head { position: relative; display: flex; align-items: center; gap: 10px; padding: 13px 12px 13px 14px; cursor: grab; user-select: none;
              background: radial-gradient(120% 140% at 0% 0%, #17c896 0%, var(--brand) 55%, #0a5a4b 100%); color: #fff; }
      .head:active { cursor: grabbing; }
      .head img { width: 30px; height: 30px; border-radius: 9px; box-shadow: 0 0 0 1px rgba(255,255,255,.35), 0 4px 10px rgba(0,0,0,.18); }
      .head .t { flex: 1; min-width: 0; }
      .head .t b { display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 700; letter-spacing: .1px; }
      .head .t span { display: block; font-size: 11.5px; opacity: .9; }
      .pro { font-size: 9.5px; font-weight: 800; letter-spacing: .08em; padding: 1px 6px; border-radius: 999px;
             background: linear-gradient(135deg, #f6d68a, var(--gold)); color: #3d2a05; }
      .icon { width: 28px; height: 28px; border: 0; border-radius: 8px; background: rgba(255,255,255,.16);
              color: #fff; cursor: pointer; font-size: 15px; line-height: 1; display: grid; place-items: center; }
      .icon:hover { background: rgba(255,255,255,.3); }
      .bar { height: 4px; background: var(--soft); }
      .bar > div { height: 100%; background: linear-gradient(90deg, var(--brand2), #6ee7b7); transition: width .4s ease; }
      .body { padding: 14px; }
      .lbl { font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); font-weight: 700; }
      .group { font-size: 15.5px; font-weight: 700; margin: 3px 0 11px; word-break: break-word; }
      .status { display: flex; gap: 9px; align-items: flex-start; padding: 10px 11px; border-radius: 11px;
                background: var(--soft); color: var(--ink); }
      .status .dot { flex: none; width: 8px; height: 8px; margin-top: 5px; border-radius: 50%; background: var(--muted); }
      .p-ready { background: rgba(20,184,138,.12); }
      .p-ready .dot, .p-sent .dot { background: var(--brand2); box-shadow: 0 0 0 3px rgba(20,184,138,.2); }
      .p-opening .dot, .p-filling .dot { background: var(--brand2); animation: pulse 1s infinite ease-in-out; }
      .p-away, .p-cleared, .p-paused { background: var(--warnbg); color: var(--warn); }
      .p-away .dot, .p-cleared .dot, .p-paused .dot { background: var(--warn); }
      .p-error { background: var(--errbg); color: var(--err); }
      .p-error .dot { background: var(--err); }
      @keyframes pulse { 50% { opacity: .3; } }
      .hint { margin-top: 10px; color: var(--muted); font-size: 12px; }
      .next { margin-top: 10px; display: flex; align-items: baseline; gap: 6px; min-width: 0; color: var(--muted); font-size: 12px; white-space: nowrap; }
      .next b { min-width: 0; }
      .p-countdown { background: rgba(20,184,138,.12); }
      .p-countdown .dot { background: var(--brand2); animation: pulse 1s infinite ease-in-out; }
      .mode { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--line); display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--muted); }
      .mode span:nth-child(2) { flex: 1; min-width: 0; }
      .badge { flex: none; font-size: 9.5px; font-weight: 800; letter-spacing: .06em; padding: 1px 6px; border-radius: 999px; background: var(--soft); color: var(--muted); }
      .badge.auto { background: rgba(20,184,138,.16); color: var(--brand2); }
      .lnk { flex: none; border: 0; background: none; padding: 0; color: var(--brand2); font: 700 11.5px inherit; cursor: pointer; }
      .lnk:hover { text-decoration: underline; }
      .next b { color: var(--ink); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      kbd { display: inline-block; padding: 1px 6px; border-radius: 5px; border: 1px solid var(--line);
            border-bottom-width: 2px; background: var(--bg); color: var(--ink); font: 700 11px/1.5 inherit; }
      .actions { display: flex; gap: 8px; padding: 0 14px 14px; flex-wrap: wrap; }
      button.btn { flex: 1; min-width: 0; height: 34px; border-radius: 10px; border: 1px solid var(--line);
                   background: var(--bg); color: var(--ink); font: 600 12.5px inherit; cursor: pointer; white-space: nowrap; transition: background .15s, filter .15s; }
      button.btn:hover { background: var(--soft); }
      button.btn.primary { background: var(--brand); border-color: var(--brand); color: #fff; }
      button.btn.primary:hover { filter: brightness(1.1); }
      button.btn.danger { color: var(--err); }
      .chips { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px; }
      .chip { background: var(--soft); border-radius: 11px; padding: 9px 10px; }
      .chip b { display: block; font-size: 19px; font-weight: 800; }
      .chip span { font-size: 11px; color: var(--muted); }
      .chip.ok b { color: var(--brand2); }
      .chip.bad b { color: var(--err); }
      .list { max-height: 190px; overflow: auto; border: 1px solid var(--line); border-radius: 11px; }
      .row { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 7px 10px; border-top: 1px solid var(--line); }
      .row:first-child { border-top: 0; }
      .row .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tag { flex: none; font-size: 11px; font-weight: 700; padding: 1px 8px; border-radius: 999px; background: var(--soft); color: var(--muted); }
      .tag.sent { background: rgba(20,184,138,.14); color: var(--brand2); }
      .tag.notfound, .tag.failed, .tag.readonly { background: var(--errbg); color: var(--err); }
      .tag.skipped { background: var(--warnbg); color: var(--warn); }
      .err { margin-bottom: 10px; padding: 9px 10px; border-radius: 10px; background: var(--errbg); color: var(--err); }
      .mini { display: flex; align-items: center; gap: 10px; padding: 10px 12px; cursor: pointer; }
      .mini img { width: 24px; height: 24px; border-radius: 7px; }
      .mini .t { flex: 1; min-width: 0; font-weight: 700; }
      .mini .t span { display: block; font-weight: 400; color: var(--muted); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .card.collapsed { width: 270px; }
      .list::-webkit-scrollbar { width: 8px; }
      .list::-webkit-scrollbar-thumb { background: var(--line); border-radius: 8px; }
    `;

    function applySavedPosition() {
      try {
        const p = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
        if (p && typeof p.x === 'number') setPos(p.x, p.y);
      } catch {
        /* ignore */
      }
    }

    function setPos(x, y) {
      const w = host.offsetWidth || 348;
      const h = host.offsetHeight || 200;
      x = Math.max(8, Math.min(window.innerWidth - w - 8, x));
      y = Math.max(8, Math.min(window.innerHeight - h - 8, y));
      Object.assign(host.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto' });
    }

    function enableDrag() {
      root.addEventListener('mousedown', (e) => {
        const handle = e.target.closest('.head, .mini');
        if (!handle || e.target.closest('button') || e.button !== 0) return;
        const r = host.getBoundingClientRect();
        const dx = e.clientX - r.left;
        const dy = e.clientY - r.top;
        let moved = false;
        const onMove = (ev) => {
          moved = true;
          setPos(ev.clientX - dx, ev.clientY - dy);
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove, true);
          window.removeEventListener('mouseup', onUp, true);
          if (moved) {
            handle.dataset.dragged = '1';
            try {
              const b = host.getBoundingClientRect();
              localStorage.setItem(POS_KEY, JSON.stringify({ x: b.left, y: b.top }));
            } catch {
              /* ignore */
            }
          }
        };
        window.addEventListener('mousemove', onMove, true);
        window.addEventListener('mouseup', onUp, true);
      });
    }

    function mount() {
      collapsed = false;
      lastKey = '';
      if (host) return;
      host = document.createElement('div');
      host.id = 'ritpost-overlay';
      host.style.cssText = 'all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483646;';
      root = host.attachShadow({ mode: 'open' });
      root.addEventListener('click', onClick);
      document.documentElement.appendChild(host);
      enableDrag();
      requestAnimationFrame(applySavedPosition);
    }

    function unmount() {
      host?.remove();
      host = null;
      root = null;
    }

    function update(patch) {
      Object.assign(view, patch);
      const key = [view.phase, view.status, view.current, run.index, run.paused, collapsed, run.items.length, run.settings.mode, run.held].join('|');
      if (key === lastKey) return;
      lastKey = key;
      render();
    }

    function onClick(e) {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      if (btn.dataset.dragged) return delete btn.dataset.dragged;
      const act = btn.dataset.act;
      switch (act) {
        case 'collapse':
          collapsed = !collapsed;
          lastKey = '';
          return render();
        case 'close':
          return unmount();
        case 'retryunsent':
          return retryUnsent();
        case 'pause':
          run.paused = !run.paused;
          if (!run.paused && view.phase === 'paused') view.status = 'Resuming…';
          lastKey = '';
          return render();
        case 'stop':
          run.paused = false;
          run.action = 'stop';
          return;
        case 'togglemode': {
          run.settings.mode = isAuto() ? 'manual' : 'auto';
          if (isAuto()) run.held = false;
          try {
            chrome.storage.local.get('settings', (d) =>
              chrome.storage.local.set({ settings: { ...(d.settings || {}), mode: run.settings.mode } })
            );
          } catch {
            /* ignore */
          }
          lastKey = '';
          return render();
        }
        default: // skip | retry | marksent | sendnow | hold
          run.action = act; // skip | retry | marksent
      }
    }

    function iconUrl() {
      try {
        return chrome.runtime.getURL('icons/icon48.png');
      } catch {
        return '';
      }
    }

    function renderRunning() {
      const total = run.items.length;
      const pos = Math.min(run.index + 1, total);
      const pct = total ? Math.round((run.index / total) * 100) : 0;
      const ph = view.phase;
      const icon = iconUrl();
      const next = run.items[run.index + 1]?.name;

      if (collapsed) {
        return `
          <div class="card collapsed">
            <div class="mini" data-act="collapse" title="Expand">
              ${icon ? `<img src="${icon}" alt="">` : ''}
              <div class="t">RitPost · ${pos}/${total}<span>${esc(view.current)}</span></div>
              <span>▴</span>
            </div>
            <div class="bar"><div style="width:${pct}%"></div></div>
          </div>`;
      }

      let contextual = '';
      if (ph === 'away') contextual = `<button class="btn primary" data-act="retry">Reopen</button>`;
      if (ph === 'cleared')
        contextual = `<button class="btn primary" data-act="retry">Refill</button><button class="btn" data-act="marksent">Mark sent</button>`;
      if (ph === 'error') contextual = `<button class="btn primary" data-act="retry">Retry</button>`;
      if (ph === 'countdown')
        contextual = `<button class="btn primary" data-act="sendnow">Send now</button><button class="btn" data-act="hold" title="Stop the countdown and send this one yourself">Hold</button>`;

      const auto = isAuto();
      const sec = Math.min(600, Math.max(5, Number(run.settings.intervalSec) || 6));
      const modeText = auto ? `Auto · every ${sec}s` : 'Manual';
      const modeLine = auto
        ? `<div class="mode"><span class="badge auto">AUTO</span><span>RitPost presses Send after ${sec}s${run.held ? ' (held for this group)' : ''}.</span><button class="lnk" data-act="togglemode">Switch to manual</button></div>`
        : `<div class="mode"><span class="badge">MANUAL</span><span>You press Enter for each group.</span>${
            run.settings.autoAck ? '<button class="lnk" data-act="togglemode">Switch to auto</button>' : ''
          }</div>`;

      return `
        <div class="card">
          <div class="head" title="Drag to move">
            ${icon ? `<img src="${icon}" alt="">` : ''}
            <div class="t"><b>RitPost <span class="pro">PRO</span></b><span>Group ${pos} of ${total} · ${modeText}</span></div>
            <button class="icon" data-act="collapse" title="Minimize">–</button>
          </div>
          <div class="bar"><div style="width:${pct}%"></div></div>
          <div class="body">
            <div class="lbl">Current group</div>
            <div class="group">${esc(view.current || '—')}</div>
            <div class="status p-${ph}"><span class="dot"></span><span>${esc(view.status)}</span></div>
            ${
              ph === 'ready'
                ? `<div class="hint">Press <kbd>Enter</kbd> in WhatsApp to send. The next group opens automatically.</div>`
                : ph === 'countdown'
                  ? `<div class="hint">Check the message now. Click <b>Hold</b> to send this one yourself.</div>`
                  : ''
            }
            ${next ? `<div class="next">Up next: <b>${esc(next)}</b></div>` : ''}
            ${modeLine}
          </div>
          <div class="actions">
            ${contextual}
            <button class="btn" data-act="skip">Skip</button>
            <button class="btn" data-act="pause">${run.paused ? 'Resume' : 'Pause'}</button>
            <button class="btn danger" data-act="stop">Stop</button>
          </div>
        </div>`;
    }

    function renderDone() {
      const c = summary();
      const total = run.items.length;
      const unsent = total - c.sent;
      const icon = iconUrl();
      const rows = run.results
        .map(
          (r) =>
            `<div class="row" title="${esc(r.reason || '')}"><span class="n">${esc(r.name)}</span><span class="tag ${r.status}">${
              LABELS[r.status] || r.status
            }</span></div>`
        )
        .join('');
      return `
        <div class="card">
          <div class="head" title="Drag to move">
            ${icon ? `<img src="${icon}" alt="">` : ''}
            <div class="t"><b>Session complete</b><span>${c.sent} of ${total} groups sent</span></div>
            <button class="icon" data-act="close" title="Close">✕</button>
          </div>
          <div class="bar"><div style="width:100%"></div></div>
          <div class="body">
            ${view.status ? `<div class="err">${esc(view.status)}</div>` : ''}
            <div class="chips">
              <div class="chip ok"><b>${c.sent}</b><span>Sent</span></div>
              <div class="chip"><b>${c.skipped + c.cancelled}</b><span>Skipped</span></div>
              <div class="chip ${c.notfound + c.failed + c.readonly ? 'bad' : ''}"><b>${c.notfound + c.failed + c.readonly}</b><span>Failed</span></div>
            </div>
            <div class="list">${rows}</div>
          </div>
          <div class="actions">
            ${unsent ? `<button class="btn" data-act="retryunsent">Retry ${unsent} unsent</button>` : ''}
            <button class="btn primary" data-act="close">Done</button>
          </div>
        </div>`;
    }

    function render() {
      if (!root) return;
      root.innerHTML = `<style>${CSS}</style>${view.phase === 'done' ? renderDone() : renderRunning()}`;
    }

    /** Slide the panel up (or left) so it doesn't cover the given area; null puts it back. */
    let shift = '';
    function avoid(rect) {
      if (!host) return;
      let next = '';
      if (rect) {
        host.style.transform = '';
        const r = host.getBoundingClientRect();
        const gap = 12;
        const overlaps = r.left < rect.right + gap && r.right > rect.left - gap && r.top < rect.bottom + gap && r.bottom > rect.top - gap;
        if (overlaps) {
          const up = r.bottom - (rect.top - gap);
          const left = r.right - (rect.left - gap);
          if (r.top - up >= 8) next = `translateY(${-Math.ceil(up)}px)`;
          else if (r.left - left >= 8) next = `translateX(${-Math.ceil(left)}px)`;
          else next = `translateY(${-Math.ceil(Math.max(0, r.top - 8))}px)`;
        }
      }
      if (next !== shift || host.style.transform !== next) {
        shift = next;
        host.style.transform = next;
        host.style.transition = 'transform .18s ease';
      }
    }

    return { mount, update, unmount, avoid };
  })();

  // ─────────────────────── launcher button ───────────────────────
  // A small RitPost button inside WhatsApp Web that opens the side panel.
  const launcher = (() => {
    let host = null;
    let tipTimer = null;

    const CSS = `
      :host { all: initial; }
      .wrap { position: relative; font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, Arial, sans-serif; }
      button {
        display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 14px 0 6px; border: 0; border-radius: 999px; cursor: pointer;
        background: radial-gradient(120% 160% at 0% 0%, #17c896 0%, #0e7c66 60%, #0a5a4b 100%); color: #fff;
        font: 600 13px/1 inherit; box-shadow: 0 10px 28px -8px rgba(14,124,102,.6), 0 0 0 1px rgba(255,255,255,.15) inset;
        transition: transform .15s ease, box-shadow .15s ease;
      }
      button:hover { transform: translateY(-1px); box-shadow: 0 14px 32px -8px rgba(14,124,102,.7), 0 0 0 1px rgba(255,255,255,.2) inset; }
      img { width: 28px; height: 28px; border-radius: 50%; }
      .tip {
        position: absolute; left: 0; bottom: 50px; width: 230px; padding: 9px 11px; border-radius: 10px;
        background: #0f172a; color: #fff; font-size: 12px; line-height: 1.4; box-shadow: 0 10px 30px rgba(0,0,0,.3);
        opacity: 0; transform: translateY(4px); transition: opacity .2s, transform .2s; pointer-events: none;
      }
      .tip.show { opacity: 1; transform: none; }
    `;

    function mount() {
      if (host || !document.body) return;
      host = document.createElement('div');
      host.id = 'ritpost-launcher';
      host.style.cssText = 'all:initial;position:fixed;left:16px;bottom:16px;z-index:2147483645;';
      const root = host.attachShadow({ mode: 'open' });
      let icon = '';
      try {
        icon = chrome.runtime.getURL('icons/icon48.png');
      } catch {
        return;
      }
      root.innerHTML = `<style>${CSS}</style>
        <div class="wrap">
          <div class="tip">Click the RitPost icon in Chrome's toolbar to open the panel.</div>
          <button type="button" title="Open RitPost"><img src="${icon}" alt="">RitPost</button>
        </div>`;
      root.querySelector('button').addEventListener('click', async () => {
        let res;
        try {
          res = await chrome.runtime.sendMessage({ type: 'BG_OPEN_PANEL' });
        } catch {
          res = { ok: false };
        }
        if (!res?.ok) {
          const tip = root.querySelector('.tip');
          tip.classList.add('show');
          clearTimeout(tipTimer);
          tipTimer = setTimeout(() => tip.classList.remove('show'), 4000);
        }
      });
      document.documentElement.appendChild(host);
    }

    return { mount };
  })();

  waitFor(isAppReady, 120000, 1000).then((ok) => ok && launcher.mount());

  // ─────────────────────── messaging ───────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'RITPOST_PING':
        sendResponse({ ok: true, ready: isAppReady(), running: run.active, paused: run.paused });
        return false;
      case 'RITPOST_CONTROL':
        if (!run.active) {
          sendResponse({ ok: false, error: 'No send session is running.' });
          return false;
        }
        if (msg.action === 'stop') {
          run.paused = false;
          run.action = 'stop';
        } else if (msg.action === 'pause') {
          run.paused = !run.paused;
          ui.update({});
        }
        sendResponse({ ok: true, paused: run.paused });
        return false;
      case 'RITPOST_START':
        sendResponse(startRun(msg.payload));
        return false;
      case 'RITPOST_SCAN':
        if (run.active) {
          sendResponse({ ok: false, error: 'Finish or stop the current send session first.' });
          return false;
        }
        scanChats()
          .then(sendResponse)
          .catch((e) => sendResponse({ ok: false, error: e?.message || 'Scan failed.' }));
        return true;
      default:
        return false;
    }
  });
})();
