/*
 * RitPost — background service worker
 * - Opens RitPost as a side panel docked beside WhatsApp Web.
 * - Locates / opens the WhatsApp Web tab and relays commands to the content script
 *   (injecting it if the tab was open before the extension was installed or reloaded).
 * - Starts Facebook posting runs (content/facebook.js does the work in the Facebook tab).
 * - Saves backup files through the downloads API.
 */

const WA_URL = 'https://web.whatsapp.com/';
const WA_MATCH = 'https://web.whatsapp.com/*';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Clicking the toolbar icon opens the side panel.
function configurePanel() {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
chrome.runtime.onStartup.addListener(configurePanel);
configurePanel();

async function findTab(preferWindowId) {
  const tabs = await chrome.tabs.query({ url: WA_MATCH });
  return (
    tabs.find((t) => t.active && t.windowId === preferWindowId) ||
    tabs.find((t) => t.windowId === preferWindowId) ||
    tabs.find((t) => t.active) ||
    tabs[0] ||
    null
  );
}

async function focusTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

async function trySend(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    return undefined;
  }
}

async function injectScripts(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/page-bridge.js'], world: 'MAIN' }).catch(() => {});
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
}

/** Send a message to the content script, injecting it once if it is missing. */
async function sendToContent(tabId, msg, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  let injected = false;
  for (;;) {
    const res = await trySend(tabId, msg);
    if (res !== undefined) return res;

    if (!injected) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') {
          await injectScripts(tabId);
          injected = true;
          await sleep(300);
          continue;
        }
      } catch {
        /* tab still loading or not scriptable yet */
      }
    }

    if (Date.now() > end) throw new Error('Could not connect to the WhatsApp Web tab. Reload it and try again.');
    await sleep(700);
  }
}

async function getStatus(windowId) {
  const tab = await findTab(windowId);
  if (!tab) return { ok: true, open: false };
  try {
    const res = await sendToContent(tab.id, { type: 'RITPOST_PING' }, 1500);
    return { ok: true, open: true, ready: !!res?.ready, running: !!res?.running, paused: !!res?.paused, active: tab.active };
  } catch {
    return { ok: true, open: true, ready: false, running: false, active: tab.active };
  }
}

/** Focus WhatsApp Web, opening it in the given window if it isn't open anywhere. */
async function openWhatsApp(windowId) {
  const tab = await findTab(windowId);
  if (tab) await focusTab(tab);
  else await chrome.tabs.create({ url: WA_URL, active: true, ...(windowId ? { windowId } : {}) });
  return { ok: true };
}

async function scanChats(windowId) {
  const tab = await findTab(windowId);
  if (!tab) return { ok: false, error: 'WhatsApp Web is not open. Open it and sign in first.' };
  return sendToContent(tab.id, { type: 'RITPOST_SCAN' }, 4000);
}

async function startRun(payload, windowId) {
  let tab = await findTab(windowId);
  if (tab) await focusTab(tab);
  else tab = await chrome.tabs.create({ url: WA_URL, active: true, ...(windowId ? { windowId } : {}) });
  return sendToContent(tab.id, { type: 'RITPOST_START', payload }, 30000);
}

async function controlRun(action, windowId) {
  const tab = await findTab(windowId);
  if (!tab) return { ok: false, error: 'WhatsApp Web is not open.' };
  return sendToContent(tab.id, { type: 'RITPOST_CONTROL', action }, 2000);
}

// ─────────────── Facebook ───────────────
const FB_MATCH = 'https://*.facebook.com/*';
const FB_GROUPS_URL = 'https://www.facebook.com/groups/joins/?nav_source=tab';

async function findFbTab(preferWindowId) {
  const tabs = await chrome.tabs.query({ url: FB_MATCH });
  return tabs.find((t) => t.active && t.windowId === preferWindowId) || tabs.find((t) => t.windowId === preferWindowId) || tabs[0] || null;
}

function waitTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const done = (ok) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(ok);
    };
    const listener = (id, info) => id === tabId && info.status === 'complete' && done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => t.status === 'complete' && !t.pendingUrl && done(true)).catch(() => done(false));
  });
}

async function sendToFb(tabId, msg, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  let injected = false;
  for (;;) {
    const res = await trySend(tabId, msg);
    if (res !== undefined) return res;
    if (!injected) {
      injected = true;
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/facebook.js'] }).catch(() => {});
      continue;
    }
    if (Date.now() > end) throw new Error('Could not connect to the Facebook tab. Reload it and try again.');
    await sleep(800);
  }
}

const FB_PAGES_URL = 'https://www.facebook.com/pages/?category=your_pages';

/** Open (or reuse) a Facebook tab on "Your groups" or "Your Pages" and read what is listed there. */
async function fbScan(windowId, kind = 'groups') {
  const url = kind === 'pages' ? FB_PAGES_URL : FB_GROUPS_URL;
  let tab = await findFbTab(windowId);
  if (tab) tab = await chrome.tabs.update(tab.id, { url, active: true });
  else tab = await chrome.tabs.create({ url, active: true, ...(windowId ? { windowId } : {}) });
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  await sleep(500);
  await waitTabComplete(tab.id);
  await sleep(1500);
  return sendToFb(tab.id, { type: 'FB_SCAN', kind }, 90000);
}

async function fbStart(run, windowId) {
  if (!run?.items?.length) return { ok: false, error: 'Pick at least one Facebook group or Page.' };
  const first = run.items[0].url;
  let tab = await findFbTab(windowId);
  const fbRun = {
    ...run,
    id: Date.now().toString(36),
    index: 0,
    results: [],
    status: 'running',
    navigatedFor: 0,
    navAt: Date.now(),
    startedAt: Date.now(),
  };
  if (tab) {
    fbRun.tabId = tab.id;
    await chrome.storage.local.set({ fbRun });
    await chrome.tabs.update(tab.id, { url: first, active: true });
  } else {
    tab = await chrome.tabs.create({ url: first, active: true, ...(windowId ? { windowId } : {}) });
    fbRun.tabId = tab.id;
    await chrome.storage.local.set({ fbRun });
  }
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return { ok: true };
}

async function fbStop() {
  const { fbRun } = await chrome.storage.local.get('fbRun');
  if (fbRun && (fbRun.status === 'running' || fbRun.status === 'waiting')) {
    await chrome.storage.local.set({ fbRun: { ...fbRun, status: 'stopped', finishedAt: Date.now() } });
  }
  return { ok: true };
}

async function fbFocus(windowId) {
  const { fbRun } = await chrome.storage.local.get('fbRun');
  let tab = null;
  if (fbRun?.tabId) tab = await chrome.tabs.get(fbRun.tabId).catch(() => null);
  tab = tab || (await findFbTab(windowId));
  if (tab) await focusTab(tab);
  else await chrome.tabs.create({ url: 'https://www.facebook.com/', active: true, ...(windowId ? { windowId } : {}) });
  return { ok: true };
}

/**
 * Real (trusted) clicks through Chrome's debugger. Facebook ignores script clicks on its final Post
 * button. Needs the optional "debugger" permission; Chrome shows "RitPost started debugging this
 * browser" while attached. That bar pushes the page down, so the button is measured only AFTER
 * attaching, inside the page, and the debugger stays attached for a short while (Next → Post) so the
 * page doesn't jump between clicks.
 */
const dbg = { tabId: null, timer: null, listening: false };

async function attachDebugger(tabId) {
  const target = { tabId };
  if (!dbg.listening && chrome.debugger?.onDetach) {
    dbg.listening = true;
    chrome.debugger.onDetach.addListener((src) => {
      if (src.tabId === dbg.tabId) dbg.tabId = null;
    });
  }
  if (dbg.tabId !== tabId) {
    try {
      await chrome.debugger.attach(target, '1.3');
    } catch (e) {
      if (!/already attached/i.test(e?.message || '')) throw e;
    }
    dbg.tabId = tabId;
    await sleep(900); // let the "started debugging" bar settle before measuring anything
  }
  clearTimeout(dbg.timer);
  dbg.timer = setTimeout(() => {
    chrome.debugger.detach(target).catch(() => {});
    if (dbg.tabId === tabId) dbg.tabId = null;
  }, 25000);
  return target;
}

async function evalInPage(target, expression) {
  const res = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression, returnByValue: true });
  return res?.result?.value ?? null;
}

/** Click (how = 'mouse') or press Enter on (how = 'key') the element marked data-ritpost-click="<token>". */
async function trustedClick(tabId, token, how = 'mouse') {
  const granted = await chrome.permissions.contains({ permissions: ['debugger'] }).catch(() => false);
  if (!granted || !chrome.debugger) return { ok: false, error: 'no-permission' };
  if (!/^[a-z0-9]+$/i.test(token || '')) return { ok: false, error: 'bad-token' };
  let target;
  try {
    target = await attachDebugger(tabId);
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
  const find = `document.querySelector('[data-ritpost-click="${token}"]')`;
  try {
    // Bring it into view and hide RitPost's own panel so it isn't under the pointer.
    const there = await evalInPage(
      target,
      `(() => { const el = ${find}; if (!el) return false; const h = document.getElementById('ritpost-fb'); if (h) h.style.visibility = 'hidden'; el.scrollIntoView({ block: 'center', inline: 'center' }); return true; })()`
    );
    if (!there) return { ok: false, error: 'gone' };
    await sleep(250);

    if (how === 'key') {
      await evalInPage(target, `(() => { const el = ${find}; if (el) { if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0'); el.focus(); } })()`);
      const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', unmodifiedText: '\r', ...key });
      await sleep(40);
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key });
      return { ok: true, how };
    }

    // Measure now (after the bar appeared) and pick a point where the button really is on top.
    const pt = await evalInPage(
      target,
      `(() => { const el = ${find}; if (!el) return null; const r = el.getBoundingClientRect();
        for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7]]) {
          const x = r.left + r.width * fx, y = r.top + r.height * fy;
          const t = document.elementFromPoint(x, y);
          if (t && (el === t || el.contains(t) || t.contains(el))) return { x, y, hit: true };
        }
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, hit: false }; })()`
    );
    if (!pt) return { ok: false, error: 'gone' };
    const x = Math.round(pt.x);
    const y = Math.round(pt.y);
    const send = (type, extra = {}) => chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type, x, y, ...extra });
    await send('mouseMoved');
    await sleep(40);
    await send('mousePressed', { button: 'left', buttons: 1, clickCount: 1 });
    await sleep(70);
    await send('mouseReleased', { button: 'left', buttons: 0, clickCount: 1 });
    return { ok: true, how, hit: pt.hit };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** A small RitPost window with one button that asks Chrome for the "debugger" permission (needs a click on an extension page). */
async function askForDebugger() {
  await chrome.windows.create({ url: chrome.runtime.getURL('grant.html'), type: 'popup', width: 440, height: 330, focused: true });
  return { ok: true };
}

// A closed Facebook tab ends its run.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { fbRun } = await chrome.storage.local.get('fbRun');
  if (fbRun?.tabId === tabId && (fbRun.status === 'running' || fbRun.status === 'waiting')) {
    await chrome.storage.local.set({ fbRun: { ...fbRun, status: 'stopped', finishedAt: Date.now(), dismissed: true } });
  }
});

async function downloadFile({ filename, json }) {
  const url = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
  try {
    await chrome.downloads.download({ url, filename, saveAs: true, conflictAction: 'uniquify' });
    return { ok: true };
  } catch (e) {
    const msg = e?.message || String(e);
    if (/cancel/i.test(msg)) return { ok: true, cancelled: true };
    return { ok: false, error: msg };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const p = msg?.payload || {};
  const windowId = p.windowId ?? sender.tab?.windowId;

  // Must run synchronously inside the user gesture (launcher button in WhatsApp Web).
  if (msg?.type === 'BG_OPEN_PANEL') {
    const wid = sender.tab?.windowId;
    if (!wid || !chrome.sidePanel?.open) {
      sendResponse({ ok: false });
      return false;
    }
    chrome.sidePanel
      .open({ windowId: wid })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e?.message }));
    return true;
  }

  const handlers = {
    BG_STATUS: () => getStatus(windowId),
    BG_OPEN: () => openWhatsApp(windowId),
    BG_SCAN: () => scanChats(windowId),
    BG_START: () => startRun(p.run, windowId),
    BG_CONTROL: () => controlRun(p.action, windowId),
    BG_DOWNLOAD: () => downloadFile(p),
    BG_FB_SCAN: () => fbScan(windowId, p.kind),
    BG_FB_START: () => fbStart(p.run, windowId),
    BG_FB_STOP: () => fbStop(),
    BG_FB_OPEN: () => fbFocus(windowId),
    BG_FB_TABID: async () => ({ ok: true, tabId: sender.tab?.id ?? null }),
    BG_HAS_DEBUGGER: async () => ({ ok: true, granted: await chrome.permissions.contains({ permissions: ['debugger'] }).catch(() => false) }),
    BG_TRUSTED_CLICK: () => (sender.tab?.id ? trustedClick(sender.tab.id, p.token, p.how) : Promise.resolve({ ok: false })),
    BG_ASK_DEBUGGER: () => askForDebugger(),
  };
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler()
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true;
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  configurePanel();
  if (reason === 'install') {
    const { settings } = await chrome.storage.local.get('settings');
    if (!settings) await chrome.storage.local.set({ settings: { delayMs: 2000, mode: 'manual', intervalSec: 6, randomize: true, autoAck: false } });
    chrome.tabs.create({ url: WA_URL, active: true });
  }
  // Make sure already-open WhatsApp tabs get the latest scripts.
  const tabs = await chrome.tabs.query({ url: WA_MATCH });
  for (const t of tabs) if (t.status === 'complete') injectScripts(t.id).catch(() => {});
  const fbTabs = await chrome.tabs.query({ url: FB_MATCH }).catch(() => []);
  for (const t of fbTabs)
    if (t.status === 'complete') chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content/facebook.js'] }).catch(() => {});
});
