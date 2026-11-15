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
 * A real mouse click at (x, y) (CSS pixels in the tab's viewport). Facebook ignores script clicks on
 * its final Post button, so Automatic mode clicks through Chrome's debugger. Needs the optional
 * "debugger" permission; Chrome shows "RitPost started debugging this browser" while it is attached.
 */
async function trustedClick(tabId, x, y) {
  const granted = await chrome.permissions.contains({ permissions: ['debugger'] }).catch(() => false);
  if (!granted || !chrome.debugger) return { ok: false, error: 'no-permission' };
  const target = { tabId };
  let attachedHere = false;
  try {
    await chrome.debugger.attach(target, '1.3');
    attachedHere = true;
  } catch (e) {
    if (!/already attached/i.test(e?.message || '')) return { ok: false, error: e?.message || String(e) };
  }
  try {
    const send = (type, extra = {}) => chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type, x, y, ...extra });
    await send('mouseMoved');
    await send('mousePressed', { button: 'left', buttons: 1, clickCount: 1 });
    await sleep(60);
    await send('mouseReleased', { button: 'left', buttons: 0, clickCount: 1 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    if (attachedHere) {
      await sleep(300);
      chrome.debugger.detach(target).catch(() => {});
    }
  }
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
    BG_TRUSTED_CLICK: () => (sender.tab?.id ? trustedClick(sender.tab.id, p.x, p.y) : Promise.resolve({ ok: false })),
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
