/*
 * RitPost — background service worker
 * - Opens RitPost as a side panel docked beside WhatsApp Web.
 * - Locates / opens the WhatsApp Web tab and relays commands to the content script
 *   (injecting it if the tab was open before the extension was installed or reloaded).
 * - Starts Facebook posting runs (content/facebook.js does the work in the Facebook tab).
 * - Saves backup files through the downloads API.
 * - Runs scheduled posts (chrome.alarms) and shows notifications for them.
 * - Checks each posting run against the user's RitPost plan (posting limits set in the admin portal).
 */

importScripts('lib/schedule.js', 'lib/config.js');

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
  const denied = await planGate('whatsapp', payload?.items?.length || 1, { auto: payload?.settings?.mode === 'auto', scheduled: !!payload?.scheduleId });
  if (denied) return denied;
  try {
    let tab = await findTab(windowId);
    if (tab) await focusTab(tab);
    else tab = await chrome.tabs.create({ url: WA_URL, active: true, ...(windowId ? { windowId } : {}) });
    const res = await sendToContent(tab.id, { type: 'RITPOST_START', payload }, 30000);
    if (!res?.ok) settleClaim('whatsapp', 0).catch(() => {});
    return res;
  } catch (e) {
    settleClaim('whatsapp', 0).catch(() => {});
    throw e;
  }
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
  const denied = await planGate('facebook', run.items.length, { auto: run.mode === 'auto', scheduled: !!run.scheduleId });
  if (denied) return denied;
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

// ─────────────── Instagram and X ───────────────
// One post at a time ("socialRun"); content/social.js does the work in the Instagram or X tab.
const IG_URL = 'https://www.instagram.com/';
const IG_MATCH = ['https://www.instagram.com/*', 'https://instagram.com/*'];
const X_COMPOSE = 'https://x.com/compose/post';
const X_MATCH = ['https://x.com/*', 'https://twitter.com/*'];
const STORY_RULE = 7101;
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const SOCIAL_STALE_MS = 2 * 60 * 60 * 1000;

const socialName = (p) => (p === 'x' ? 'X' : 'Instagram');
const getSocialRun = async () => (await chrome.storage.local.get('socialRun')).socialRun || null;
const socialActive = (r) => r && r.status === 'running' && Date.now() - (r.startedAt || 0) < SOCIAL_STALE_MS;

async function findSocialTab(platform, preferWindowId) {
  const tabs = await chrome.tabs.query({ url: platform === 'x' ? X_MATCH : IG_MATCH, windowType: 'normal' }).catch(() => []);
  return tabs.find((t) => t.active && t.windowId === preferWindowId) || tabs.find((t) => t.windowId === preferWindowId) || tabs[0] || null;
}

/** Instagram only offers Stories in its phone layout: the Story window asks for it. */
async function setStoryRule(tabId) {
  if (!chrome.declarativeNetRequest) return;
  const set = (header, value) => ({ header, operation: 'set', value });
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [STORY_RULE],
    addRules:
      tabId === null
        ? []
        : [
            {
              id: STORY_RULE,
              priority: 1,
              action: { type: 'modifyHeaders', requestHeaders: [set('user-agent', MOBILE_UA), set('sec-ch-ua-mobile', '?1'), set('sec-ch-ua-platform', '"Android"')] },
              condition: {
                tabIds: [tabId],
                requestDomains: ['instagram.com', 'cdninstagram.com'],
                resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'script', 'stylesheet', 'image', 'media', 'font', 'websocket', 'other'],
              },
            },
          ],
  });
}

async function socialStart(run, windowId) {
  if (!run || !['instagram', 'x'].includes(run.platform)) return { ok: false, error: 'Unknown platform.' };
  const files = run.attachmentIds || [];
  if (run.platform === 'instagram' && !files.length) return { ok: false, error: 'Instagram needs at least one photo or video.' };
  if (run.platform === 'x' && !files.length && !(run.caption || run.thread?.some(Boolean))) return { ok: false, error: 'Write something or attach a photo first.' };
  const cur = await getSocialRun();
  if (socialActive(cur)) return { ok: false, error: `Another ${socialName(cur.platform)} post is still open. Finish or stop it first.` };
  const denied = await planGate(run.platform, 1, { auto: run.mode === 'auto', scheduled: !!run.scheduleId });
  if (denied) return denied;

  const fresh = { ...run, id: Date.now().toString(36), status: 'running', step: 'start', startedAt: Date.now(), error: '', errorShown: false };
  if (run.platform === 'instagram' && run.kind === 'story') {
    const win = await chrome.windows.create({ url: 'about:blank', type: 'popup', width: 430, height: 880, focused: true });
    const tabId = win.tabs?.[0]?.id;
    if (tabId === undefined) {
      settleClaim(run.platform, 0).catch(() => {});
      return { ok: false, error: 'Couldn’t open the Story window.' };
    }
    await setStoryRule(tabId).catch(() => {});
    await chrome.storage.local.set({ socialRun: { ...fresh, tabId, windowId: win.id } });
    await chrome.tabs.update(tabId, { url: `${IG_URL}#ritpost-story` });
    return { ok: true };
  }
  const url = run.platform === 'x' ? X_COMPOSE : IG_URL;
  let tab = await findSocialTab(run.platform, windowId);
  if (tab) {
    await chrome.storage.local.set({ socialRun: { ...fresh, tabId: tab.id } });
    await chrome.tabs.update(tab.id, { url, active: true });
  } else {
    tab = await chrome.tabs.create({ url: 'about:blank', active: true, ...(windowId ? { windowId } : {}) });
    await chrome.storage.local.set({ socialRun: { ...fresh, tabId: tab.id } });
    await chrome.tabs.update(tab.id, { url });
  }
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return { ok: true };
}

async function socialStop() {
  const r = await getSocialRun();
  if (r?.status === 'running') await chrome.storage.local.set({ socialRun: { ...r, status: 'stopped', stopReason: 'Stopped by you', finishedAt: Date.now() } });
  return { ok: true };
}

async function socialFocus(windowId, platform) {
  const r = await getSocialRun();
  let tab = r?.tabId ? await chrome.tabs.get(r.tabId).catch(() => null) : null;
  const p = platform || r?.platform || 'instagram';
  tab = tab || (await findSocialTab(p, windowId));
  if (tab) await focusTab(tab);
  else await chrome.tabs.create({ url: p === 'x' ? 'https://x.com/home' : IG_URL, active: true, ...(windowId ? { windowId } : {}) });
  return { ok: true };
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const r = await getSocialRun();
  if (r?.tabId !== tabId) return;
  if (r.kind === 'story') setStoryRule(null).catch(() => {});
  if (r.status === 'running') await chrome.storage.local.set({ socialRun: { ...r, status: 'stopped', stopReason: 'The tab was closed', finishedAt: Date.now() } });
});
chrome.storage.onChanged.addListener((changes, area) => {
  const r = area === 'local' && changes.socialRun?.newValue;
  // A finished Story run no longer needs the phone layout.
  if (r && r.kind === 'story' && r.status !== 'running') setStoryRule(null).catch(() => {});
});

// ─────────────── Plan limits (RitPost server) ───────────────
// Before each run RitPost asks the server whether it fits the user's plan (platforms included,
// posts per day, groups per run, Automatic mode, scheduling). Posts a stopped run didn't make
// are given back. If the server can't be reached, the last known plan is used.
const planServer = () => String(self.RITPOST_CONFIG?.aiServer || '').replace(/\/+$/, '');
const PLAN_NAMES = { whatsapp: 'WhatsApp', facebook: 'Facebook', instagram: 'Instagram', x: 'X' };
const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

async function planIdentity() {
  const d = await chrome.storage.local.get(['aiInstallId', 'aiSettings']);
  let installId = d.aiInstallId;
  if (typeof installId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(installId)) {
    installId = (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}rp`).replace(/[^A-Za-z0-9-]/g, '');
    await chrome.storage.local.set({ aiInstallId: installId });
  }
  return { installId, code: typeof d.aiSettings?.code === 'string' ? d.aiSettings.code : '' };
}

/** POST to the RitPost server; null when it can't be reached or has trouble (never blocks posting). */
async function planFetch(path, body) {
  const base = planServer();
  if (!base || typeof fetch !== 'function') return null;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl?.abort(), 12000);
  try {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl?.signal });
    const data = await res.json().catch(() => null);
    // 404: a server from before plans existed; 5xx: trouble. Neither may block posting.
    return data && res.status < 500 && res.status !== 404 ? data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const planRefusal = (code, error, upgradeUrl = '') => ({ ok: false, code, error, upgradeUrl });

/** Without the server: the same checks against the last plan RitPost saw (up to a week old). */
async function offlineGate(platform, count, { auto, scheduled }) {
  const { planCache } = await chrome.storage.local.get('planCache');
  const p = planCache?.plan;
  if (!p || Date.now() - (planCache.at || 0) > 7 * 86400000) return null;
  const name = PLAN_NAMES[platform];
  const pf = p.platforms?.[platform];
  const f = p.features || {};
  if (pf && !pf.on) return planRefusal('plan_locked', `Posting to ${name} isn’t included in your ${p.planName} plan.`);
  if (scheduled && f.schedule === false) return planRefusal('plan_schedule', `Scheduled posting isn’t included in your ${p.planName} plan.`);
  if (auto && f.auto === false) return planRefusal('plan_auto', `Automatic mode isn’t included in your ${p.planName} plan. Switch to Manual, or upgrade.`);
  if (f.perRun && count > f.perRun) return planRefusal('plan_run', `Your ${p.planName} plan posts to up to ${f.perRun} at a time, and you picked ${count}. Pick fewer, or upgrade.`);
  if (pf && pf.remaining !== null && pf.remaining !== undefined && utcDay(planCache.at) === utcDay()) {
    if (count > pf.remaining) return planRefusal('plan_limit', pf.remaining ? `You have ${pf.remaining} ${name} post${pf.remaining === 1 ? '' : 's'} left today (${p.planName} plan). Pick ${pf.remaining} or fewer, or upgrade.` : `You’ve used today’s ${name} posts on the ${p.planName} plan. They reset at midnight (UTC).`);
    pf.remaining -= count;
    pf.used = (pf.used || 0) + count;
    await chrome.storage.local.set({ planCache: { ...planCache, plan: p } });
  }
  return null;
}

/** null = go ahead; otherwise a refusal to show (code plan_locked / plan_limit / plan_run / plan_auto / plan_schedule). */
async function planGate(platform, count, { auto = false, scheduled = false } = {}) {
  if (!planServer()) return null;
  const who = await planIdentity();
  const data = await planFetch('/v1/posts/claim', { ...who, platform, count, auto, scheduled });
  if (data?.plan) await chrome.storage.local.set({ planCache: { plan: data.plan, at: Date.now() } });
  if (data?.ok) {
    await chrome.storage.local.set({ [`planClaim_${platform}`]: { count, at: Date.now() } });
    return null;
  }
  if (data) return planRefusal(data.code || 'plan', data.error || 'Your plan doesn’t allow this post.', data.upgradeUrl || '');
  return offlineGate(platform, count, { auto, scheduled });
}

/** A run ended: give back the posts it didn't make. */
async function settleClaim(platform, used, startedAt = 0) {
  const key = `planClaim_${platform}`;
  const claim = (await chrome.storage.local.get(key))[key];
  if (!claim) return;
  await chrome.storage.local.remove(key);
  if (startedAt && claim.at > startedAt + 60000) return; // belongs to a later run
  const back = claim.count - Math.max(0, used || 0);
  if (back <= 0) return;
  const data = await planFetch('/v1/posts/release', { ...(await planIdentity()), platform, count: back });
  if (data?.plan) await chrome.storage.local.set({ planCache: { plan: data.plan, at: Date.now() } });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const wa = changes.lastRun?.newValue;
  if (wa?.done && !changes.lastRun.oldValue?.done) settleClaim('whatsapp', wa.counts?.sent || 0, wa.startedAt).catch(() => {});
  const fr = changes.fbRun?.newValue;
  const fo = changes.fbRun?.oldValue;
  if (fr && fo && (fo.status === 'running' || fo.status === 'waiting') && (fr.status === 'done' || fr.status === 'stopped'))
    settleClaim('facebook', (fr.results || []).filter((r) => r.status === 'posted').length, fr.startedAt).catch(() => {});
  const sr = changes.socialRun?.newValue;
  if (sr && changes.socialRun.oldValue?.status === 'running' && sr.status !== 'running') settleClaim(sr.platform, sr.status === 'done' ? 1 : 0, sr.startedAt).catch(() => {});
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
const platformName = (j) => ({ facebook: 'Facebook', instagram: 'Instagram', x: 'X' })[j.platform] || 'WhatsApp';
const isSocial = (p) => p === 'instagram' || p === 'x';

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
  else if (isSocial(platform)) socialFocus(null, platform).catch(() => {});
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
  if (isSocial(platform)) {
    const r = await getSocialRun();
    return socialActive(r) ? `Another ${socialName(r.platform)} post is still open.` : null;
  }
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
  if (isSocial(job.platform)) return socialStart({ ...job.social, platform: job.platform, mode: job.mode, attachmentIds: job.fileIds || [], scheduleId: job.id, scheduleTitle: jobTitle(job) }, windowId);
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
  const who = isSocial(job.platform) ? job.targetsLabel || platformName(job) : `${platformName(job)} · ${job.targetsLabel || ''}`.trim();

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
    const needsYou = isSocial(job.platform)
      ? job.mode === 'manual'
        ? ` Check it and click ${job.platform === 'x' ? 'Post' : 'Share'}.`
        : ' RitPost posts it after a short review countdown.'
      : job.platform === 'facebook'
        ? ' Click Post on each one when RitPost asks.'
        : job.mode === 'manual'
          ? ' Press Enter in each group.'
          : '';
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
  const extra = isSocial(job.platform)
    ? job.mode === 'manual'
      ? ` You’ll click ${job.platform === 'x' ? 'Post' : 'Share'}.`
      : ''
    : job.platform === 'facebook'
      ? ' You’ll click Post on each one.'
      : job.mode === 'manual'
        ? ' You’ll press Enter in each group.'
        : '';
  notify(job, `In 5 minutes: ${jobTitle(job)}`, `${isSocial(job.platform) ? job.targetsLabel || platformName(job) : `${platformName(job)} · ${job.targetsLabel || ''}`}. Keep Chrome open.${extra}`);
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
    BG_SOCIAL_START: () => socialStart(p.run, windowId),
    BG_SOCIAL_STOP: () => socialStop(),
    BG_SOCIAL_OPEN: () => socialFocus(windowId, p.platform),
    BG_SOCIAL_TABID: async () => ({ ok: true, tabId: sender.tab?.id ?? null }),
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
  // RitPost AI is included now; older versions could store a personal OpenAI key: remove it.
  const { aiSettings } = await chrome.storage.local.get('aiSettings');
  if (aiSettings && ('key' in aiSettings || 'models' in aiSettings || 'model' in aiSettings)) {
    const { key, model, models, ...rest } = aiSettings;
    await chrome.storage.local.set({ aiSettings: rest });
  }
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
  const socialTabs = await chrome.tabs.query({ url: [...IG_MATCH, ...X_MATCH] }).catch(() => []);
  for (const t of socialTabs)
    if (t.status === 'complete') chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content/social.js'] }).catch(() => {});
});
