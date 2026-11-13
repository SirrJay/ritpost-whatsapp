/*
 * RitPost — background service worker
 * - Opens RitPost as a side panel docked beside WhatsApp Web.
 * - Locates / opens the WhatsApp Web tab and relays commands to the content script
 *   (injecting it if the tab was open before the extension was installed or reloaded).
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
});
