/*
 * RitPost — background service worker
 * - Opens RitPost as a side panel docked beside WhatsApp Web.
 * - Locates / opens the WhatsApp Web tab and relays commands to the content script
 *   (injecting it if the tab was open before the extension was installed or reloaded).
 * - Starts Facebook posting runs (content/facebook.js does the work in the Facebook tab).
 * - Saves backup files through the downloads API.
 * - Runs scheduled posts (chrome.alarms) and shows notifications for them.
 */

importScripts('lib/schedule.js');

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

// A closed Facebook tab ends its run.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { fbRun } = await chrome.storage.local.get('fbRun');
  if (fbRun?.tabId === tabId && (fbRun.status === 'running' || fbRun.status === 'waiting')) {
    await chrome.storage.local.set({ fbRun: { ...fbRun, status: 'stopped', finishedAt: Date.now(), dismissed: true } });
  }
});

// ─────────────── Scheduled posts ───────────────
// The side panel saves schedules in chrome.storage ("schedules"); this worker turns them into
// chrome.alarms, starts the WhatsApp or Facebook run when one fires, and moves repeating ones on.
const SCHED_ALARM = 'sched:';
const REMIND_ALARM = 'remind:';
const REMIND_BEFORE_MS = 5 * 60 * 1000;
const ON_TIME_MS = 15 * 60 * 1000; // "Skip it" still runs if Chrome was only briefly away
const LATE_OK_MS = 6 * 60 * 60 * 1000; // "Post when Chrome opens" runs up to 6 hours late
const BUSY_RETRY_MS = 3 * 60 * 1000;
const BUSY_GIVE_UP_MS = 2 * 60 * 60 * 1000;

const getSchedules = async () => (await chrome.storage.local.get('schedules')).schedules || [];
const jobTitle = (j) => j.label || String(j.message || '').split('\n')[0].slice(0, 40) || (j.fileNames?.length ? `${j.fileNames.length} file(s)` : 'Scheduled post');
const platformName = (j) => (j.platform === 'facebook' ? 'Facebook' : 'WhatsApp');

/** Change one schedule (read–modify–write, so a panel edit made meanwhile isn't lost). */
async function updateJob(id, fn) {
  const jobs = await getSchedules();
  const i = jobs.findIndex((j) => j.id === id);
  if (i < 0) return null;
  jobs[i] = fn({ ...jobs[i] }) || jobs[i];
  await chrome.storage.local.set({ schedules: jobs });
  return jobs[i];
}

async function addHistory(job, outcome, detail) {
  const { schedHistory = [] } = await chrome.storage.local.get('schedHistory');
  schedHistory.unshift({ at: Date.now(), jobId: job.id, title: jobTitle(job), platform: job.platform, outcome, detail: detail || '' });
  await chrome.storage.local.set({ schedHistory: schedHistory.slice(0, 40) });
}

function notify(job, title, message) {
  if (!chrome.notifications) return;
  chrome.notifications
    .create(`ritpost|${job.platform}|${job.id}|${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
      priority: 2,
    })
    .catch(() => {});
}

chrome.notifications?.onClicked.addListener((nid) => {
  const [, platform] = String(nid).split('|');
  if (platform === 'facebook') fbFocus(null).catch(() => {});
  else if (platform === 'whatsapp') openWhatsApp(null).catch(() => {});
  chrome.notifications.clear(nid).catch(() => {});
});

/** Keep one alarm per active schedule (plus its reminder) in step with what's saved. */
async function syncAlarms() {
  if (!chrome.alarms) return;
  const jobs = await getSchedules();
  const now = Date.now();
  const want = new Map();
  for (const j of jobs) {
    if (j.status !== 'active' || !j.next) continue;
    const at = j.retryAt || j.next;
    want.set(SCHED_ALARM + j.id, Math.max(at, now + 1000));
    if (j.remind && !j.retryAt && j.next - REMIND_BEFORE_MS > now + 5000) want.set(REMIND_ALARM + j.id, j.next - REMIND_BEFORE_MS);
  }
  const existing = await chrome.alarms.getAll();
  for (const a of existing) {
    if (!a.name.startsWith(SCHED_ALARM) && !a.name.startsWith(REMIND_ALARM)) continue;
    const w = want.get(a.name);
    if (w === undefined || Math.abs(a.scheduledTime - w) > 1500) await chrome.alarms.clear(a.name);
    else want.delete(a.name); // already right
  }
  for (const [name, when] of want) await chrome.alarms.create(name, { when });
}

/** Why a new run can't start on this platform right now (or null). */
async function platformBusy(platform) {
  if (platform === 'facebook') {
    const { fbRun } = await chrome.storage.local.get('fbRun');
    return fbRun && (fbRun.status === 'running' || fbRun.status === 'waiting') ? 'Another Facebook posting run is still going.' : null;
  }
  const s = await getStatus(null).catch(() => null);
  return s?.running ? 'Another WhatsApp send session is still going.' : null;
}

async function targetWindow() {
  const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  if (w?.id !== undefined && w.id !== chrome.windows.WINDOW_ID_NONE) return w.id;
  const created = await chrome.windows.create({ focused: true, url: 'about:blank' });
  return created.id;
}

async function startJob(job) {
  const windowId = await targetWindow();
  if (job.platform === 'facebook') {
    const run = { ...job.fb, attachmentIds: job.fileIds || [], scheduleId: job.id, scheduleTitle: jobTitle(job) };
    return fbStart(run, windowId);
  }
  return startRun({ items: job.wa.items, settings: job.wa.settings, attachments: job.fileIds || [], scheduleId: job.id }, windowId);
}

/** After a run (or a miss), set the next time; once-only and finished schedules are marked done. */
async function advanceJob(id, due, ran) {
  return updateJob(id, (j) => {
    if (ran) j.runs = (j.runs || 0) + 1;
    j.retryAt = null;
    j.waiting = '';
    j.lastRunAt = Date.now();
    const next = RitSchedule.nextOccurrence(j.repeat, Math.max(due, Date.now()));
    if (!next || (j.endAfter && (j.runs || 0) >= j.endAfter)) {
      j.status = 'done';
      j.next = null;
    } else j.next = next;
    return j;
  });
}

async function fireJob(id, { manual = false } = {}) {
  const job = (await getSchedules()).find((j) => j.id === id);
  if (!job) return { ok: false, error: 'This scheduled post no longer exists.' };
  if (!manual && (job.status !== 'active' || !job.next)) return { ok: true };
  const now = Date.now();
  const due = job.next || now;
  const who = `${platformName(job)} · ${job.targetsLabel || ''}`.trim();

  if (!manual) {
    const late = now - due;
    const limit = job.missed === 'skip' ? ON_TIME_MS : LATE_OK_MS;
    if (late > limit) {
      const why = `Chrome was closed or your computer was asleep at ${RitSchedule.formatWhen(due)}.`;
      await addHistory(job, 'missed', why);
      notify(job, `Missed: ${jobTitle(job)}`, `${why} ${job.repeat?.type === 'once' ? 'Open RitPost to run it now.' : 'It will run again next time.'}`);
      await advanceJob(id, due, false);
      return { ok: true };
    }
  }

  const busy = await platformBusy(job.platform);
  if (busy) {
    if (manual) return { ok: false, error: busy };
    if (now - due > BUSY_GIVE_UP_MS) {
      await addHistory(job, 'missed', `${busy} RitPost waited 2 hours.`);
      notify(job, `Missed: ${jobTitle(job)}`, `${busy} RitPost waited 2 hours, then gave up.`);
      await advanceJob(id, due, false);
    } else {
      const first = !job.retryAt;
      await updateJob(id, (j) => ({ ...j, retryAt: now + BUSY_RETRY_MS, waiting: busy }));
      if (first) await addHistory(job, 'waiting', `${busy} RitPost will start as soon as it finishes.`);
    }
    return { ok: true };
  }

  let res;
  try {
    res = await startJob(job);
  } catch (e) {
    res = { ok: false, error: e?.message || String(e) };
  }
  if (res?.ok) {
    await addHistory(job, 'started', `${who}${manual ? ' (run now)' : ''}`);
    const needsYou = job.platform === 'facebook' ? ' Click Post on each one when RitPost asks.' : job.mode === 'manual' ? ' Press Enter in each group.' : '';
    notify(job, `Posting now: ${jobTitle(job)}`, `${who}.${needsYou}`);
  } else {
    await addHistory(job, 'failed', res?.error || 'Couldn’t start.');
    notify(job, `Couldn’t post: ${jobTitle(job)}`, res?.error || 'RitPost couldn’t start this scheduled post.');
  }
  if (!manual) await advanceJob(id, due, !!res?.ok);
  else if (res?.ok && job.repeat?.type === 'once' && job.status === 'active') await advanceJob(id, now, true);
  else if (res?.ok) await updateJob(id, (j) => ({ ...j, lastRunAt: Date.now() }));
  return res || { ok: false };
}

async function remindJob(id) {
  const job = (await getSchedules()).find((j) => j.id === id);
  if (!job || job.status !== 'active') return;
  const extra = job.platform === 'facebook' ? ' You’ll click Post on each one.' : job.mode === 'manual' ? ' You’ll press Enter in each group.' : '';
  notify(job, `In 5 minutes: ${jobTitle(job)}`, `${platformName(job)} · ${job.targetsLabel || ''}. Keep Chrome open.${extra}`);
}

chrome.alarms?.onAlarm.addListener((a) => {
  if (a.name.startsWith(SCHED_ALARM)) fireJob(a.name.slice(SCHED_ALARM.length)).catch(() => {});
  else if (a.name.startsWith(REMIND_ALARM)) remindJob(a.name.slice(REMIND_ALARM.length)).catch(() => {});
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.schedules) syncAlarms().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => syncAlarms().catch(() => {}));
syncAlarms().catch(() => {});

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
    BG_SCHED_RUN: () => fireJob(p.id, { manual: true }),
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
