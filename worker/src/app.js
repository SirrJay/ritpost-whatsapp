/*
 * RitPost server (Cloudflare Worker + D1): plans, access codes, AI rewrites, posting limits,
 * and the admin portal with team accounts.
 *
 * Public API (called by the RitPost extension):
 *   POST /v1/status         { installId, code? }                       → plan, limits, usage today, offers
 *   POST /v1/redeem         { installId, code }                        → activates an access code on this device
 *   POST /v1/rewrite        { installId, code?, text, opts }           → { variations, plan, model }
 *   POST /v1/posts/claim    { installId, code?, platform, count, auto?, scheduled? } → ok, or why the plan refuses
 *   POST /v1/posts/release  { installId, code?, platform, count }      → gives back posts a stopped run didn't make
 *
 * Admin portal: GET /admin (page), POST /admin/login, /admin/invite, /admin/magic, /admin/api/* (session).
 *
 * Secrets: OPENAI_API_KEY, ADMIN_TOKEN (optional owner password). Binding: DB (D1).
 * The OpenAI key never leaves the server.
 */

export const PLATFORMS = ['whatsapp', 'facebook', 'instagram', 'x'];
export const PLAT_NAME = { whatsapp: 'WhatsApp', facebook: 'Facebook', instagram: 'Instagram', x: 'X' };
const UNIT = { whatsapp: ['group', 'groups'], facebook: ['group or Page', 'groups or Pages'], instagram: ['post', 'posts'], x: ['post', 'posts'] };

export const DEFAULT_SETTINGS = {
  service_on: true, // master switch for AI
  free_on: true, // free AI rewrites for people without a code
  free_daily: 30, // (older versions) seeds the Free plan
  free_ip_daily: 120, // free rewrites per network (IP) per day — stops reinstall tricks
  premium_daily: 300, // (older versions) seeds the Premium plan
  premium_devices: 3, // (older versions) seeds the Premium plan
  global_daily: 5000, // AI rewrites for all users together per day (spend guard)
  model: '', // empty = pick the newest chat model in the OpenAI account
  max_chars: 3000, // longest post accepted for AI
  price_in: 0, // USD per 1M input tokens (for the cost estimate)
  price_out: 0, // USD per 1M output tokens
  announcement: '', // short message shown in RitPost
  upgrade_text: 'Want more? Get a premium access code from RitPost.',
  upgrade_url: '',
  currency: 'GHS', // your currency: prices, amounts paid and sales are in it
  business_name: 'RitPost', // used in customer messages
  pay_currencies: 'USD,EUR,GBP,NGN,KES,ZAR', // other currencies customers can pay in (ISO codes)
  fx_markup: 0, // % added to the exchange rate for customers paying in another currency (covers conversion fees)
  fx_manual: '', // your own fixed rates, e.g. "USD=0.065, NGN=105" (units per 1 of your currency); empty = live rates
  fx_show: true, // show plan prices in the customer's chosen currency in RitPost
};
const NUM_KEYS = ['free_daily', 'free_ip_daily', 'premium_daily', 'premium_devices', 'global_daily', 'max_chars', 'price_in', 'price_out', 'fx_markup'];
const BOOL_KEYS = ['service_on', 'free_on', 'fx_show'];

// ─────────────── currencies ───────────────
/** Widely used currencies offered in the portal (ISO 4217). */
export const CURRENCIES = {
  USD: 'US dollar', EUR: 'Euro', GBP: 'British pound', JPY: 'Japanese yen', CNY: 'Chinese yuan', CHF: 'Swiss franc', CAD: 'Canadian dollar', AUD: 'Australian dollar',
  INR: 'Indian rupee', AED: 'UAE dirham', SAR: 'Saudi riyal', BRL: 'Brazilian real', ZAR: 'South African rand', NGN: 'Nigerian naira', GHS: 'Ghanaian cedi',
  KES: 'Kenyan shilling', UGX: 'Ugandan shilling', TZS: 'Tanzanian shilling', RWF: 'Rwandan franc', XOF: 'West African CFA franc', XAF: 'Central African CFA franc',
  EGP: 'Egyptian pound', MAD: 'Moroccan dirham', ETB: 'Ethiopian birr', ZMW: 'Zambian kwacha', SLL: 'Sierra Leonean leone', LRD: 'Liberian dollar', GMD: 'Gambian dalasi',
};
const FX_TTL = 6 * 60 * 60 * 1000; // refresh live rates every 6 hours
const iso = (c) => (/^[A-Z]{3}$/.test(String(c || '').trim().toUpperCase()) ? String(c).trim().toUpperCase() : '');
const isoList = (v) => [...new Set(String(v || '').split(/[\s,;]+/).map(iso).filter(Boolean))].slice(0, 30);
/** "USD=0.065, NGN=105" → { USD: 0.065, NGN: 105 } */
function parseManual(v) {
  const out = {};
  for (const part of String(v || '').split(/[,;\n]+/)) {
    const m = /^\s*([A-Za-z]{3})\s*[=:]\s*([0-9]*\.?[0-9]+)\s*$/.exec(part);
    if (m && Number(m[2]) > 0) out[m[1].toUpperCase()] = Number(m[2]);
  }
  return out;
}

const allOn = (daily) => Object.fromEntries(PLATFORMS.map((p) => [p, { on: true, daily }]));
export const DEFAULT_PLANS = {
  free: {
    name: 'Free',
    description: 'Everyone with RitPost, no code needed.',
    price: '',
    sort: 0,
    public: false,
    features: { ai: 30, devices: 1, days: 0, perRun: 15, schedule: true, studio: true, auto: true, platforms: { whatsapp: { on: true, daily: 30 }, facebook: { on: true, daily: 10 }, instagram: { on: true, daily: 2 }, x: { on: true, daily: 2 } } },
  },
  premium: {
    name: 'Premium',
    description: 'Unlimited posting to WhatsApp, Facebook, Instagram and X, plus 300 AI rewrites a day.',
    price: '',
    sort: 10,
    public: true,
    features: { ai: 300, devices: 3, days: 30, perRun: null, schedule: true, studio: true, auto: true, platforms: allOn(null) },
  },
};

/** Team roles: what each one may do in the portal. */
export const ROLES = {
  owner: { name: 'Owner', perms: ['view', 'codes.create', 'codes.edit', 'codes.support', 'codes.delete', 'devices.block', 'plans.edit', 'settings.edit', 'audit', 'team'] },
  admin: { name: 'Admin', perms: ['view', 'codes.create', 'codes.edit', 'codes.support', 'codes.delete', 'devices.block', 'plans.edit', 'settings.edit', 'audit'] },
  sales: { name: 'Sales', perms: ['view', 'codes.create', 'codes.edit', 'codes.support'] },
  support: { name: 'Support', perms: ['view', 'codes.support', 'devices.block'] },
  viewer: { name: 'Viewer', perms: ['view'] },
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const MAX_BATCH = 2000; // codes in one bulk batch
const DAY_MS = 86400000;
const today = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const daysAgo = (n) => today(Date.now() - n * DAY_MS);
const normCode = (c) => {
  const s = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 14 && s.startsWith('RP') ? s.slice(2) : s; // a code may itself start with RP
};
const fmtCode = (raw) => `RP-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
const plural = (n, [one, many]) => `${n} ${n === 1 ? one : many}`;
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const randomHex = (n = 32) => hex(crypto.getRandomValues(new Uint8Array(n)));

/** A whole number within limits, or `dflt` when empty / not a number. */
function int(v, min, max, dflt) {
  if (v === '' || v === null || v === undefined) return dflt;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
}

/** Clean a plan's features. Missing values come from `base`. daily/perRun: null = unlimited. */
export function normFeatures(f = {}, base = DEFAULT_PLANS.premium.features) {
  f = f && typeof f === 'object' ? f : {};
  const bool = (k) => (f[k] === undefined ? !!base[k] : !!f[k]);
  const out = {
    ai: int(f.ai, 0, 100000, base.ai),
    devices: int(f.devices, 1, 1000, base.devices),
    days: int(f.days, 0, 3650, base.days || 0),
    perRun: f.perRun === undefined ? base.perRun ?? null : f.perRun === null || f.perRun === '' || Number(f.perRun) === 0 ? null : int(f.perRun, 1, 100000, base.perRun ?? null),
    schedule: bool('schedule'),
    studio: bool('studio'),
    auto: bool('auto'),
    platforms: {},
  };
  for (const p of PLATFORMS) {
    const src = (f.platforms && f.platforms[p]) || {};
    const b = base.platforms[p];
    out.platforms[p] = {
      on: src.on === undefined ? !!b.on : !!src.on,
      daily: src.daily === undefined ? b.daily : src.daily === null || src.daily === '' ? null : int(src.daily, 0, 1000000, b.daily),
    };
  }
  return out;
}

export function createApp({ adminHtml = '<!doctype html><title>RitPost Admin</title>', fetchImpl } = {}) {
  const doFetch = (...a) => (fetchImpl || fetch)(...a);
  let settingsCache = null;
  let fxMem = null;
  let settingsAt = 0;
  let plansCache = null;
  let plansAt = 0;
  let modelCache = null;
  let schemaReady = false;

  // ─────────────── helpers ───────────────
  const json = (data, status = 200, extra = {}) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });

  function cors(req) {
    const origin = req.headers.get('Origin') || '';
    // The extension (chrome-extension://…) and this server's own admin page.
    const ok = /^chrome-extension:\/\/[a-p]{32}$/.test(origin) || origin === new URL(req.url).origin;
    return ok ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400', Vary: 'Origin' } : {};
  }

  async function sha(text) {
    return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  }
  const ipHash = async (req, env) => (await sha(`${req.headers.get('CF-Connecting-IP') || 'unknown'}|${env.ADMIN_TOKEN || 'ritpost'}`)).slice(0, 16);

  function safeEqual(a, b) {
    a = String(a || '');
    b = String(b || '');
    let diff = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return diff === 0 && a.length > 0;
  }

  // Passwords: PBKDF2 (team members, and the owner when set in the portal); the older salted
  // SHA-256 written by set-admin-password.ps1 still works.
  async function pbkdf2(pw, saltHex, iterations) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
    const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
    return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
  }
  async function hashPassword(pw) {
    const salt = randomHex(16);
    return `pbkdf2:100000:${salt}:${await pbkdf2(pw, salt, 100000)}`;
  }
  async function verifyPassword(pw, stored) {
    stored = String(stored || '');
    let m = /^pbkdf2:(\d{1,7}):([0-9a-f]{16,64}):([0-9a-f]{64})$/.exec(stored);
    if (m) return safeEqual(await pbkdf2(pw, m[2], Math.min(Number(m[1]), 100000)), m[3]);
    m = /^sha256:([0-9a-f]{16,64}):([0-9a-f]{64})$/.exec(stored);
    if (m) return safeEqual(await sha(m[1] + pw), m[2]);
    return false;
  }

  /** Bring an older database up to date (new tables and columns). Safe to run many times. */
  async function ensureSchema(env) {
    if (schemaReady) return;
    const db = env.DB;
    const create = [
      'CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT \'\', price TEXT NOT NULL DEFAULT \'\', sort INTEGER NOT NULL DEFAULT 0, public INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0, features TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL, pw TEXT, status TEXT NOT NULL DEFAULT \'invited\', own_only INTEGER NOT NULL DEFAULT 0, invite_hash TEXT, invite_exp INTEGER, created_at INTEGER NOT NULL, created_by TEXT, last_login_at INTEGER)',
      'CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, actor_name TEXT NOT NULL DEFAULT \'\', action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT \'\')',
      'CREATE TABLE IF NOT EXISTS post_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, tier TEXT NOT NULL, plan_id TEXT, code TEXT, install_id TEXT, ip_hash TEXT, platform TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL DEFAULT \'claim\', status TEXT NOT NULL, reason TEXT)',
      'CREATE INDEX IF NOT EXISTS post_log_day ON post_log (day)',
      'CREATE TABLE IF NOT EXISTS admin_sessions (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, member_id TEXT NOT NULL DEFAULT \'owner\')',
      'CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, name TEXT NOT NULL, plan_id TEXT NOT NULL, quantity INTEGER NOT NULL, duration_days INTEGER NOT NULL DEFAULT 0, redeem_by INTEGER, channel TEXT NOT NULL DEFAULT \'\', price REAL NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT \'\', created_at INTEGER NOT NULL, created_by TEXT NOT NULL DEFAULT \'owner\')',
    ];
    for (const sql of create) await db.prepare(sql).run();
    const cols = async (t) => {
      try {
        return new Set(((await db.prepare(`PRAGMA table_info(${t})`).all()).results || []).map((c) => c.name));
      } catch {
        return null; // unknown: just try adding each column
      }
    };
    const add = async (table, have, name, def) => {
      if (have && have.has(name)) return false;
      try {
        await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`).run();
        return true;
      } catch {
        return false; /* another request added it first */
      }
    };
    const c = await cols('codes');
    await add('codes', c, 'plan_id', 'TEXT');
    await add('codes', c, 'created_by', "TEXT NOT NULL DEFAULT 'owner'");
    await add('codes', c, 'contact', "TEXT NOT NULL DEFAULT ''");
    await add('codes', c, 'amount', 'REAL NOT NULL DEFAULT 0');
    await add('codes', c, 'duration_days', 'INTEGER NOT NULL DEFAULT 0');
    await add('codes', c, 'batch_id', 'TEXT');
    await add('codes', c, 'redeem_by', 'INTEGER');
    await add('codes', c, 'issued_at', 'INTEGER');
    await add('codes', c, 'pay_currency', "TEXT NOT NULL DEFAULT ''");
    await add('codes', c, 'pay_amount', 'REAL NOT NULL DEFAULT 0');
    // Codes made before 2.4 were sold when created, and are active once a device uses them.
    if (await add('codes', c, 'sold_at', 'INTEGER')) await db.prepare('UPDATE codes SET sold_at = created_at WHERE sold_at IS NULL AND batch_id IS NULL').run();
    if (await add('codes', c, 'activated_at', 'INTEGER')) await db.prepare('UPDATE codes SET activated_at = COALESCE(last_used_at, created_at) WHERE activated_at IS NULL AND code IN (SELECT code FROM code_devices)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS codes_batch ON codes (batch_id)').run();
    await add('admin_sessions', await cols('admin_sessions'), 'member_id', "TEXT NOT NULL DEFAULT 'owner'");
    const n = (await db.prepare('SELECT COUNT(*) AS n FROM plans').first())?.n || 0;
    if (!n) {
      // First run: the Free and Premium plans start from the old settings.
      const s = await getSettings(env, true);
      const free = { ...DEFAULT_PLANS.free, features: normFeatures({ ai: s.free_daily }, DEFAULT_PLANS.free.features) };
      const prem = { ...DEFAULT_PLANS.premium, features: normFeatures({ ai: s.premium_daily, devices: s.premium_devices }, DEFAULT_PLANS.premium.features) };
      const now = Date.now();
      await db.batch(
        [['free', free], ['premium', prem]].map(([id, p]) =>
          db.prepare('INSERT OR IGNORE INTO plans (id, name, description, price, sort, public, archived, features, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)').bind(id, p.name, p.description, p.price, p.sort, p.public ? 1 : 0, JSON.stringify(p.features), now, now)
        )
      );
    }
    await db.prepare("UPDATE codes SET plan_id = 'premium' WHERE plan_id IS NULL OR plan_id = ''").run();
    schemaReady = true;
  }

  async function getSettings(env, fresh = false) {
    if (!fresh && settingsCache && Date.now() - settingsAt < 15000) return settingsCache;
    const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
    const s = { ...DEFAULT_SETTINGS };
    for (const r of results || []) {
      if (!(r.key in DEFAULT_SETTINGS)) continue; // e.g. admin_hash stays private
      try {
        s[r.key] = JSON.parse(r.value);
      } catch {
        /* ignore */
      }
    }
    settingsCache = s;
    settingsAt = Date.now();
    return s;
  }

  /** Live exchange rates for your currency (units of each currency per 1 of yours), cached for 6 hours. */
  async function getRates(env, s, force = false) {
    const base = iso(s.currency);
    if (!base) return null;
    if (!force && fxMem && fxMem.base === base && Date.now() - fxMem.at < FX_TTL) return fxMem;
    let cached = null;
    try {
      cached = JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = 'fx_cache'").first())?.value || 'null');
    } catch {
      cached = null;
    }
    if (cached && cached.base !== base) cached = null;
    if (!force && cached && Date.now() - cached.at < FX_TTL) return (fxMem = cached);
    const get = async (url) => {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 8000) : null;
      try {
        const r = await doFetch(url, { headers: { Accept: 'application/json' }, signal: ctrl?.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const sources = [
      async () => {
        const d = await get(`https://open.er-api.com/v6/latest/${base}`);
        if (d?.result !== 'success' || !d.rates) throw new Error(d?.['error-type'] || 'no rates');
        return { rates: d.rates, source: 'ExchangeRate-API', updated: (d.time_last_update_unix || 0) * 1000 || Date.now() };
      },
      async () => {
        const b = base.toLowerCase();
        const d = await get(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${b}.json`);
        if (!d?.[b]) throw new Error('no rates');
        return { rates: Object.fromEntries(Object.entries(d[b]).filter(([k, v]) => /^[a-z]{3}$/.test(k) && v > 0).map(([k, v]) => [k.toUpperCase(), v])), source: 'Currency API (fawazahmed0)', updated: Date.parse(d.date) || Date.now() };
      },
    ];
    for (const src of sources) {
      try {
        const r = await src();
        const rates = {};
        for (const [k, v] of Object.entries(r.rates)) if (/^[A-Z]{3}$/.test(k) && Number(v) > 0) rates[k] = Number(v);
        rates[base] = 1;
        const fresh = { base, at: Date.now(), updated: r.updated, source: r.source, rates };
        await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('fx_cache', ?)").bind(JSON.stringify(fresh)).run();
        return (fxMem = fresh);
      } catch {
        /* try the next source */
      }
    }
    return cached ? { ...cached, stale: true } : null; // keep using the last rates we had
  }
  /** Rates customers see: your fixed rates first, then live ones, plus your margin. */
  async function customerRates(env, s) {
    const base = iso(s.currency);
    if (!base) return null;
    const fx = await getRates(env, s);
    const manual = parseManual(s.fx_manual);
    const markup = 1 + Math.min(50, Math.max(0, Number(s.fx_markup) || 0)) / 100;
    const out = { [base]: 1 };
    for (const c of isoList(s.pay_currencies)) {
      if (c === base) continue;
      const r = manual[c] || fx?.rates?.[c];
      if (r) out[c] = +(r * markup).toPrecision(6);
    }
    return { base, rates: out, at: fx?.updated || null, source: fx?.source || (Object.keys(manual).length ? 'Your rates' : ''), stale: !!fx?.stale };
  }
  /** An amount paid in another currency → your currency (live/fixed rate, no margin). */
  async function toBase(env, s, amount, cur) {
    const base = iso(s.currency);
    cur = iso(cur);
    if (!cur || !base || cur === base || !(amount > 0)) return { amount, cur: '' };
    const r = parseManual(s.fx_manual)[cur] || (await getRates(env, s))?.rates?.[cur];
    if (!r) throw new Error(`No exchange rate for ${cur} yet. Try again in a moment, or add your own rate in Settings → Currencies.`);
    return { amount: Math.round((amount / r) * 100) / 100, cur, paid: amount };
  }

  const planFromRow = (r) => {
    let f = {};
    try {
      f = JSON.parse(r.features);
    } catch {
      /* default */
    }
    const base = r.id === 'free' ? DEFAULT_PLANS.free.features : DEFAULT_PLANS.premium.features;
    return { id: r.id, name: r.name, description: r.description, price: r.price, sort: r.sort, public: !!r.public, archived: !!r.archived, features: normFeatures(f, base), createdAt: r.created_at, updatedAt: r.updated_at };
  };
  async function getPlans(env, fresh = false) {
    if (!fresh && plansCache && Date.now() - plansAt < 15000) return plansCache;
    const { results } = await env.DB.prepare('SELECT * FROM plans ORDER BY sort, created_at').all();
    const map = {};
    for (const r of results || []) map[r.id] = planFromRow(r);
    if (!map.free) map.free = { id: 'free', ...DEFAULT_PLANS.free, archived: false };
    plansCache = map;
    plansAt = Date.now();
    return map;
  }
  const dropCaches = () => {
    plansCache = null;
    settingsCache = null;
  };

  async function count(env, day, subject) {
    const r = await env.DB.prepare('SELECT count FROM usage_daily WHERE day = ? AND subject = ?').bind(day, subject).first();
    return r?.count || 0;
  }
  async function counts(env, day, subjects) {
    const out = Object.fromEntries(subjects.map((s) => [s, 0]));
    if (!subjects.length) return out;
    const { results } = await env.DB.prepare(`SELECT subject, count FROM usage_daily WHERE day = ? AND subject IN (${subjects.map(() => '?').join(',')})`).bind(day, ...subjects).all();
    for (const r of results || []) out[r.subject] = r.count;
    return out;
  }
  const bump = (env, day, subject, n = 1, tin = 0, tout = 0) =>
    env.DB.prepare(
      'INSERT INTO usage_daily (day, subject, count, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?) ON CONFLICT(day, subject) DO UPDATE SET count = MAX(0, count + excluded.count), tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out'
    ).bind(day, subject, n, tin, tout);

  async function blocked(env, subjects) {
    const marks = subjects.map(() => '?').join(',');
    const r = await env.DB.prepare(`SELECT subject, reason FROM blocks WHERE subject IN (${marks})`).bind(...subjects).first();
    return r || null;
  }

  async function findCode(env, raw) {
    const c = normCode(raw);
    if (c.length !== 12) return null;
    return env.DB.prepare('SELECT * FROM codes WHERE code = ?').bind(c).first();
  }
  /** First use of a code: its time starts now (codes valid "N days from activation"); an unsold batch code becomes a sale. */
  async function activate(env, code) {
    const now = Date.now();
    const expires = code.duration_days > 0 ? now + code.duration_days * DAY_MS : code.expires_at;
    let price = 0;
    if (code.batch_id && !code.sold_at && !code.amount) price = (await env.DB.prepare('SELECT price FROM batches WHERE id = ?').bind(code.batch_id).first())?.price || 0;
    await env.DB.prepare('UPDATE codes SET activated_at = ?, expires_at = ?, sold_at = COALESCE(sold_at, ?), amount = CASE WHEN amount > 0 THEN amount ELSE ? END WHERE code = ? AND activated_at IS NULL')
      .bind(now, expires, now, price, code.code)
      .run();
    return (await env.DB.prepare('SELECT * FROM codes WHERE code = ?').bind(code.code).first()) || { ...code, activated_at: now, expires_at: expires };
  }
  const codeAi = (code, plan) => (code.daily_limit >= 0 ? code.daily_limit : plan.features.ai);
  const codeDevices = (code, plan) => (code.max_devices > 0 ? code.max_devices : plan.features.devices);

  /** Work out who is asking and what their plan allows; `register` adds this install to a code's devices. */
  async function resolve(env, s, installId, rawCode, { register = false } = {}) {
    const plans = await getPlans(env);
    const day = today();
    let p;
    if (rawCode) {
      const code = await findCode(env, rawCode);
      if (!code) return { error: 'That access code isn’t valid. Check it and try again.', code: 'invalid_code' };
      if (code.status !== 'active') return { error: 'This access code has been turned off. Contact the person who gave it to you.', code: 'code_disabled' };
      if (code.expires_at && code.expires_at < Date.now()) return { error: 'This access code has expired. Renew it to keep your premium plan.', code: 'code_expired' };
      if (!code.activated_at && code.redeem_by && code.redeem_by < Date.now())
        return { error: `This access code had to be activated by ${new Date(code.redeem_by).toISOString().slice(0, 10)}. Contact the person who sold it to you.`, code: 'code_lapsed' };
      const plan = plans[code.plan_id] || plans.premium || plans.free;
      const maxDev = codeDevices(code, plan);
      const dev = await env.DB.prepare('SELECT 1 AS x FROM code_devices WHERE code = ? AND install_id = ?').bind(code.code, installId).first();
      if (!dev) {
        const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM code_devices WHERE code = ?').bind(code.code).first())?.n || 0;
        if (n >= maxDev) return { error: `This access code is already used on ${maxDev} device${maxDev === 1 ? '' : 's'}, its limit.`, code: 'code_devices' };
        if (register) await env.DB.prepare('INSERT OR IGNORE INTO code_devices (code, install_id, added_at) VALUES (?, ?, ?)').bind(code.code, installId, Date.now()).run();
      }
      if (register && !code.activated_at) Object.assign(code, await activate(env, code));
      p = { tier: 'premium', plan, code: code.code, label: code.label, limit: codeAi(code, plan), expiresAt: code.expires_at || null, subject: `c:${code.code}` };
    } else {
      const plan = plans.free;
      p = { tier: 'free', plan, limit: s.free_on ? plan.features.ai : 0, subject: `i:${installId}` };
    }
    p.used = await count(env, day, p.subject);
    p.remaining = Math.max(0, p.limit - p.used);
    return p;
  }

  /** What RitPost shows: plan name, AI rewrites left, and posts left on each platform today. */
  async function publicPlan(env, p) {
    if (!p || p.error) return null;
    const f = p.plan.features;
    const used = await counts(env, today(), PLATFORMS.map((x) => `p:${x}:${p.subject}`));
    const platforms = {};
    for (const x of PLATFORMS) {
      const pf = f.platforms[x];
      const u = used[`p:${x}:${p.subject}`];
      platforms[x] = { on: pf.on, daily: pf.daily, used: u, remaining: pf.on ? (pf.daily === null ? null : Math.max(0, pf.daily - u)) : 0 };
    }
    return {
      tier: p.tier,
      planId: p.plan.id,
      planName: p.plan.name,
      label: p.label || '',
      limit: p.limit,
      used: p.used,
      remaining: p.remaining,
      expiresAt: p.expiresAt || null,
      resetsAt: Date.parse(`${today()}T00:00:00Z`) + DAY_MS,
      features: { schedule: f.schedule, studio: f.studio, auto: f.auto, perRun: f.perRun },
      platforms,
    };
  }

  async function offers(env) {
    const plans = await getPlans(env);
    return Object.values(plans)
      .filter((p) => p.id !== 'free' && p.public && !p.archived)
      .map((p) => ({ id: p.id, name: p.name, price: p.price, description: p.description, ai: p.features.ai, perRun: p.features.perRun, platforms: p.features.platforms, schedule: p.features.schedule, auto: p.features.auto, studio: p.features.studio, days: p.features.days }));
  }

  async function pickModel(env, s) {
    if (s.model) return s.model;
    if (modelCache && Date.now() - modelCache.at < 3600000) return modelCache.id;
    const ids = await listModels(env);
    const id = ids[0] || 'gpt-4o-mini';
    modelCache = { id, at: Date.now() };
    return id;
  }

  async function listModels(env) {
    const r = await doFetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } });
    if (!r.ok) throw new Error(`OpenAI ${r.status}`);
    const data = await r.json();
    const NOT_CHAT = /(embed|whisper|tts|dall-e|image|audio|realtime|moderation|transcri|search|computer-use|babbage|davinci|instruct|sora|codex|vision-preview|-o?ss-)/i;
    const rank = (id) => {
      const v = /^gpt-(\d+)(?:\.(\d+))?/i.exec(id);
      let sc = v ? Number(v[1]) * 100 + Number(v[2] || 0) * 10 : /^o(\d+)/i.test(id) ? 150 : 0;
      if (/\d{4}-\d{2}-\d{2}|-\d{4}$/.test(id)) sc -= 3;
      if (/preview/i.test(id)) sc -= 4;
      if (/nano/i.test(id)) sc -= 6;
      else if (/mini|luna/i.test(id)) sc -= 2;
      return sc;
    };
    return [...new Set((data.data || []).map((m) => m.id).filter((id) => /^(gpt|o\d|chatgpt)/i.test(id) && !NOT_CHAT.test(id)))].sort((a, b) => rank(b) - rank(a) || a.localeCompare(b));
  }

  async function openai(env, model, req) {
    const base = { model, messages: req.messages, max_completion_tokens: req.maxTokens };
    const post = (body) => doFetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let r = await post({ ...base, response_format: req.responseFormat });
    let data = await r.json().catch(() => null);
    if (r.status === 400 && /response_format|json_schema|schema/i.test(data?.error?.message || '')) {
      r = await post({ ...base, messages: req.fallbackMessages, response_format: { type: 'json_object' } });
      data = await r.json().catch(() => null);
    }
    if (!r.ok) {
      const code = data?.error?.code || '';
      const e = new Error(code === 'insufficient_quota' ? 'RitPost AI is out of credit right now. Please try again later.' : r.status === 429 ? 'RitPost AI is busy right now. Try again in a minute.' : 'RitPost AI couldn’t write right now. Try again in a minute.');
      e.detail = `${r.status} ${code} ${String(data?.error?.message || '').slice(0, 200)}`;
      throw e;
    }
    const choice = data?.choices?.[0];
    if (choice?.message?.refusal) {
      const e = new Error('The AI declined to rewrite this text.');
      e.detail = 'refusal';
      throw e;
    }
    return { content: choice?.message?.content, usage: data?.usage || {}, model: data?.model || model };
  }

  // ─────────────── public API ───────────────
  async function readBody(req) {
    try {
      return await req.json();
    } catch {
      return null;
    }
  }
  const validInstall = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(id);

  async function apiStatus(req, env, { register = false } = {}) {
    const b = await readBody(req);
    if (!b || !validInstall(b.installId)) return json({ ok: false, error: 'Bad request.', code: 'bad_request' }, 400);
    const s = await getSettings(env);
    const base = { announcement: s.announcement || '', upgradeText: s.upgrade_text || '', upgradeUrl: s.upgrade_url || '', serviceOn: !!s.service_on, freeOn: !!s.free_on, offers: await offers(env), currency: s.currency || '', fx: s.fx_show ? await customerRates(env, s).catch(() => null) : null };
    if (register && !b.code) return json({ ok: false, error: 'Enter an access code.', code: 'invalid_code', ...base }, 400);
    const p = await resolve(env, s, b.installId, b.code, { register });
    if (p.error) {
      // Fall back to showing the free plan when a stored code no longer works.
      const free = !register && b.code ? await resolve(env, s, b.installId, '') : null;
      return json({ ok: false, error: p.error, code: p.code, plan: await publicPlan(env, free), ...base }, register ? 400 : 200);
    }
    return json({ ok: true, plan: await publicPlan(env, p), ...base });
  }

  async function apiRewrite(req, env) {
    const b = await readBody(req);
    if (!b || !validInstall(b.installId)) return json({ ok: false, error: 'Bad request.', code: 'bad_request' }, 400);
    const s = await getSettings(env);
    if (!s.service_on) return json({ ok: false, error: 'RitPost AI is paused for maintenance. Please try again later.', code: 'service_off' }, 503);
    const text = String(b.text || '').trim();
    if (!text) return json({ ok: false, error: 'Write something first.', code: 'notext' }, 400);
    if (text.length > s.max_chars) return json({ ok: false, error: `That post is too long for RitPost AI (${text.length.toLocaleString('en')} characters; the limit is ${Number(s.max_chars).toLocaleString('en')}).`, code: 'too_long' }, 413);
    const ip = await ipHash(req, env);
    const blk = await blocked(env, [`i:${b.installId}`, `ip:${ip}`]);
    if (blk) return json({ ok: false, error: 'RitPost AI is not available on this device.', code: 'blocked' }, 403);

    const p = await resolve(env, s, b.installId, b.code, { register: true });
    if (p.error) return json({ ok: false, error: p.error, code: p.code }, 403);
    const day = today();
    if (p.tier === 'free' && !s.free_on) return json({ ok: false, code: 'free_off', plan: await publicPlan(env, p), error: `Free AI rewrites are paused right now. ${s.upgrade_text || ''}`.trim() }, 403);
    if (p.limit <= 0) return json({ ok: false, code: 'limit', plan: await publicPlan(env, p), error: `AI rewrites aren’t included in your ${p.plan.name} plan. ${s.upgrade_text || ''}`.trim() }, 403);
    if (p.remaining <= 0)
      return json(
        {
          ok: false,
          code: 'limit',
          plan: await publicPlan(env, p),
          error: p.tier === 'premium' ? `You’ve used all ${p.limit} rewrites for today on your ${p.plan.name} plan. They reset at midnight (UTC).` : `You’ve used your ${p.limit} free rewrite${p.limit === 1 ? '' : 's'} for today. They reset at midnight (UTC). ${s.upgrade_text || ''}`.trim(),
        },
        429
      );
    if (p.tier === 'free' && (await count(env, day, `ip:${ip}`)) >= s.free_ip_daily)
      return json({ ok: false, code: 'limit', plan: await publicPlan(env, p), error: `Free rewrites from your network are used up for today. ${s.upgrade_text || ''}`.trim() }, 429);
    if ((await count(env, day, 'all')) >= s.global_daily) return json({ ok: false, code: 'busy', error: 'RitPost AI has reached today’s limit for all users. Please try again tomorrow.' }, 429);

    // Reserve the use first (so parallel requests can't go over), give it back on failure.
    const subjects = [p.subject, 'all', p.tier, ...(p.tier === 'free' ? [`ip:${ip}`] : [])];
    await env.DB.batch(subjects.map((sub) => bump(env, day, sub)));
    const req2 = globalThis.RitAIPrompt.buildRequest(text, b.opts || {});
    const log = (status, extra = {}) =>
      env.DB.prepare('INSERT INTO requests (at, day, tier, code, install_id, ip_hash, model, platform, tokens_in, tokens_out, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(Date.now(), day, p.tier, p.code || null, b.installId, ip, extra.model || null, req2.opts.platform, extra.tin || 0, extra.tout || 0, status, extra.error || null)
        .run();
    let model = '';
    try {
      model = await pickModel(env, s);
      const out = await openai(env, model, req2);
      const variations = globalThis.RitAIPrompt.parse(out.content, req2.opts);
      const tin = out.usage.prompt_tokens || 0;
      const tout = out.usage.completion_tokens || 0;
      const writes = [bump(env, day, p.tier, 0, tin, tout), bump(env, day, 'all', 0, tin, tout)];
      if (p.code)
        writes.push(
          env.DB.prepare('UPDATE codes SET total_uses = total_uses + 1, last_used_at = ? WHERE code = ?').bind(Date.now(), p.code),
          env.DB.prepare('UPDATE code_devices SET last_used_at = ? WHERE code = ? AND install_id = ?').bind(Date.now(), p.code, b.installId)
        );
      await env.DB.batch(writes);
      await log('ok', { model: out.model, tin, tout });
      const after = { ...p, used: p.used + 1, remaining: Math.max(0, p.remaining - 1) };
      return json({ ok: true, variations, model: out.model, usage: { total_tokens: tin + tout }, plan: await publicPlan(env, after) });
    } catch (e) {
      await env.DB.batch(subjects.map((sub) => bump(env, day, sub, -1)));
      await log('error', { model, error: String(e.detail || e.message).slice(0, 300) });
      return json({ ok: false, code: 'ai_error', error: e.message || 'RitPost AI couldn’t write right now.', plan: await publicPlan(env, p) }, 502);
    }
  }

  /**
   * Posting limits. RitPost asks before each WhatsApp / Facebook / Instagram / X run;
   * `count` is the number of groups, Pages or posts in the run.
   */
  async function apiPosts(req, env, { release = false } = {}) {
    const b = await readBody(req);
    if (!b || !validInstall(b.installId) || !PLATFORMS.includes(b.platform)) return json({ ok: false, error: 'Bad request.', code: 'bad_request' }, 400);
    const n = int(b.count, 1, 10000, 1);
    const s = await getSettings(env);
    const ip = await ipHash(req, env);
    const day = today();
    let p = await resolve(env, s, b.installId, b.code, { register: !!b.code });
    let codeError = '';
    if (p.error) {
      codeError = p.error;
      p = await resolve(env, s, b.installId, '');
    }
    const subj = `p:${b.platform}:${p.subject}`;
    const log = (status, reason = '', kind = 'claim', cnt = n) =>
      env.DB.prepare('INSERT INTO post_log (at, day, tier, plan_id, code, install_id, ip_hash, platform, count, kind, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(Date.now(), day, p.tier, p.plan.id, p.code || null, b.installId, ip, b.platform, cnt, kind, status, reason ? String(reason).slice(0, 300) : null)
        .run();

    if (release) {
      const give = Math.min(await count(env, day, subj), n);
      if (give > 0) {
        await env.DB.batch([bump(env, day, subj, -give), bump(env, day, `posts:${b.platform}`, -give), bump(env, day, 'posts', -give), bump(env, day, `posts:${p.tier}`, -give)]);
        await log('ok', 'Not posted (run stopped)', 'release', give);
      }
      return json({ ok: true, released: give, plan: await publicPlan(env, p) });
    }

    const name = PLAT_NAME[b.platform];
    const f = p.plan.features;
    const pf = f.platforms[b.platform];
    const up = s.upgrade_text ? ` ${s.upgrade_text}` : '';
    const deny = async (code, error, status = 403) => {
      await log('denied', error);
      return json({ ok: false, code, error, codeError, upgradeUrl: s.upgrade_url || '', plan: await publicPlan(env, p) }, status);
    };
    if (await blocked(env, [`i:${b.installId}`, `ip:${ip}`])) return deny('blocked', 'RitPost isn’t available on this device. Contact RitPost support.');
    if (!pf.on) return deny('plan_locked', `Posting to ${name} isn’t included in your ${p.plan.name} plan.${up}`);
    if (b.scheduled && !f.schedule) return deny('plan_schedule', `Scheduled posting isn’t included in your ${p.plan.name} plan.${up}`);
    if (b.auto && !f.auto) return deny('plan_auto', `Automatic mode isn’t included in your ${p.plan.name} plan. Switch to Manual, or upgrade.${up}`);
    if (f.perRun && n > f.perRun) return deny('plan_run', `Your ${p.plan.name} plan posts to up to ${plural(f.perRun, UNIT[b.platform])} at a time, and you picked ${n}. Pick fewer, or upgrade.${up}`);
    if (pf.daily !== null) {
      const used = await count(env, day, subj);
      const left = Math.max(0, pf.daily - used);
      if (n > left)
        return deny(
          'plan_limit',
          left === 0
            ? `You’ve used all ${plural(pf.daily, ['post', 'posts'])} to ${name} for today on the ${p.plan.name} plan. They reset at midnight (UTC).${up}`
            : `You have ${left} of your ${pf.daily} ${name} posts left today (${p.plan.name} plan), and this needs ${n}. Pick ${left} or fewer, or upgrade.${up}`,
          429
        );
    }
    const writes = [bump(env, day, subj, n), bump(env, day, `posts:${b.platform}`, n), bump(env, day, 'posts', n), bump(env, day, `posts:${p.tier}`, n)];
    if (p.code) writes.push(env.DB.prepare('UPDATE codes SET last_used_at = ? WHERE code = ?').bind(Date.now(), p.code), env.DB.prepare('UPDATE code_devices SET last_used_at = ? WHERE code = ? AND install_id = ?').bind(Date.now(), p.code, b.installId));
    await env.DB.batch(writes);
    await log('ok', b.scheduled ? 'Scheduled' : '');
    return json({ ok: true, codeError, plan: await publicPlan(env, p) });
  }

  // ─────────────── admin: sign-in, team and sessions ───────────────
  const SESSION_MS = 12 * 60 * 60 * 1000;
  const INVITE_MS = 7 * DAY_MS;

  async function ownerHash(env) {
    try {
      return JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = 'admin_hash'").first())?.value || '""');
    } catch {
      return '';
    }
  }
  /** The owner's password: the hash in the database (preferred) or the ADMIN_TOKEN secret. */
  async function ownerCheck(env, pw) {
    pw = String(pw || '').trim();
    if (!pw) return false;
    const stored = await ownerHash(env);
    if (stored && (await verifyPassword(pw, stored))) return true;
    const secret = String(env.ADMIN_TOKEN || '').trim();
    return secret ? safeEqual(pw, secret) : false;
  }
  async function failKey(req, env) {
    // The lock is tied to the current owner password, so setting a new one unlocks you.
    return `adminfail:${await ipHash(req, env)}:${(await sha(`${String(env.ADMIN_TOKEN || '').trim()}|${await ownerHash(env)}`)).slice(0, 8)}`;
  }

  async function ownerMe(env) {
    const s = await getSettings(env);
    return { id: 'owner', name: s.business_name && s.business_name !== 'RitPost' ? `${s.business_name} (owner)` : 'Owner', email: '', role: 'owner', ownOnly: false };
  }
  const meOut = (me) => ({ id: me.id, name: me.name, email: me.email, role: me.role, roleName: ROLES[me.role]?.name || me.role, perms: ROLES[me.role]?.perms || [], ownOnly: !!me.ownOnly });

  async function newSession(env, memberId) {
    const token = randomHex();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').bind(Date.now()),
      env.DB.prepare('INSERT INTO admin_sessions (hash, expires_at, member_id) VALUES (?, ?, ?)').bind(await sha(token), Date.now() + SESSION_MS, memberId),
    ]);
    return token;
  }
  async function memberById(env, id) {
    const m = await env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(id).first();
    return m ? { ...m, ownOnly: !!m.own_only } : null;
  }
  async function sessionMe(env, token) {
    const r = await env.DB.prepare('SELECT expires_at, member_id FROM admin_sessions WHERE hash = ?').bind(await sha(token)).first();
    if (!r || r.expires_at <= Date.now()) return null;
    if (r.member_id === 'owner') return ownerMe(env);
    const m = await memberById(env, r.member_id);
    return m && m.status === 'active' && ROLES[m.role] && m.role !== 'owner' ? m : null;
  }

  async function audit(env, me, action, detail = '') {
    try {
      await env.DB.prepare('INSERT INTO audit (at, actor, actor_name, action, detail) VALUES (?, ?, ?, ?, ?)').bind(Date.now(), me?.id || 'system', me?.name || '', action, String(detail).slice(0, 400)).run();
    } catch {
      /* never block the action */
    }
  }

  /** Who is calling the admin API: a session token, or (older tools) the owner password itself. */
  async function adminAuth(req, env) {
    const secret = String(env.ADMIN_TOKEN || '').trim();
    if (!secret && !(await ownerHash(env))) return { res: json({ ok: false, error: 'No admin password is set yet. Run worker\\set-admin-password.ps1 (see worker/README.md).' }, 500) };
    const fk = await failKey(req, env);
    const day = today();
    if ((await count(env, day, fk)) >= 20) return { res: json({ ok: false, error: 'Too many wrong passwords today. Set a new admin password (worker\\set-admin-password.ps1) or try again tomorrow.' }, 429) };
    let token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    try {
      token = decodeURIComponent(token);
    } catch {
      /* sent as-is */
    }
    token = token.trim();
    let me = /^[0-9a-f]{64}$/.test(token) ? await sessionMe(env, token) : null;
    if (!me && (await ownerCheck(env, token))) me = await ownerMe(env);
    if (!me) {
      await bump(env, day, fk).run();
      return { res: json({ ok: false, error: 'Your sign-in has ended. Sign in again.' }, 401) };
    }
    return { me, token };
  }

  /** POST /admin/login { email, password } → a session. Leave email empty for the owner. */
  async function login(req, env) {
    const b = (await readBody(req)) || {};
    const fk = await failKey(req, env);
    const day = today();
    if ((await count(env, day, fk)) >= 20) return json({ ok: false, error: 'Too many wrong passwords today. Try again tomorrow, or the owner can run set-admin-password.ps1.' }, 429);
    const email = String(b.email || '').trim().toLowerCase();
    const pw = String(b.password || '').trim();
    let me = null;
    if (!email || email === 'owner') {
      if (await ownerCheck(env, pw)) me = await ownerMe(env);
    } else {
      const m = await env.DB.prepare('SELECT * FROM members WHERE email = ?').bind(email).first();
      if (m && m.status === 'active' && m.pw && (await verifyPassword(pw, m.pw))) {
        me = { ...m, ownOnly: !!m.own_only };
        await env.DB.prepare('UPDATE members SET last_login_at = ? WHERE id = ?').bind(Date.now(), m.id).run();
      } else if (m && m.status === 'disabled' && m.pw && (await verifyPassword(pw, m.pw))) {
        return json({ ok: false, error: 'Your account has been turned off. Ask the owner.' }, 403);
      }
    }
    if (!me) {
      await bump(env, day, fk).run();
      return json({ ok: false, error: email ? 'Wrong email or password.' : 'Wrong admin password.' }, 401);
    }
    await audit(env, me, 'Signed in');
    return json({ ok: true, session: await newSession(env, me.id), me: meOut(me) });
  }

  /** POST /admin/invite { token, password? } → check an invite link, or set the password and sign in. */
  async function acceptInvite(req, env) {
    const b = (await readBody(req)) || {};
    const ip = await ipHash(req, env);
    const day = today();
    if ((await count(env, day, `invitefail:${ip}`)) >= 20) return json({ ok: false, error: 'Too many tries. Ask the owner for a new link tomorrow.' }, 429);
    const tok = String(b.token || '');
    const m = /^[0-9a-f]{64}$/.test(tok) ? await env.DB.prepare('SELECT * FROM members WHERE invite_hash = ?').bind(await sha(tok)).first() : null;
    if (!m || !m.invite_exp || m.invite_exp < Date.now() || m.status === 'disabled') {
      await bump(env, day, `invitefail:${ip}`).run();
      return json({ ok: false, error: 'This invite link has expired or was already used. Ask the owner for a new one.' }, 401);
    }
    if (b.password === undefined) return json({ ok: true, name: m.name, email: m.email, role: ROLES[m.role]?.name || m.role });
    const pw = String(b.password || '').trim();
    if (pw.length < 8) return json({ ok: false, error: 'Use at least 8 characters.' }, 400);
    await env.DB.prepare("UPDATE members SET pw = ?, status = 'active', invite_hash = NULL, invite_exp = NULL, last_login_at = ? WHERE id = ?").bind(await hashPassword(pw), Date.now(), m.id).run();
    await env.DB.prepare('DELETE FROM admin_sessions WHERE member_id = ?').bind(m.id).run();
    const me = { ...m, ownOnly: !!m.own_only };
    await audit(env, me, 'Joined the team', `${m.email} set a password`);
    return json({ ok: true, session: await newSession(env, m.id), me: meOut(me) });
  }

  /** POST /admin/magic { token } → an owner session, if the one-time link from open-admin.ps1 is valid. */
  async function magicLogin(req, env) {
    const b = (await readBody(req)) || {};
    const ip = await ipHash(req, env);
    const day = today();
    if ((await count(env, day, `magicfail:${ip}`)) >= 20) return json({ ok: false, error: 'Too many tries. Run open-admin.ps1 again tomorrow.' }, 429);
    let stored = null;
    try {
      stored = JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = 'admin_magic'").first())?.value || 'null');
    } catch {
      stored = null;
    }
    const tok = String(b.token || '');
    const ok = stored && /^[0-9a-f]{64}$/.test(tok) && stored.exp > Date.now() && safeEqual(await sha(tok), stored.hash);
    if (!ok) {
      await bump(env, day, `magicfail:${ip}`).run();
      return json({ ok: false, error: 'This sign-in link has expired or was already used. Run open-admin.ps1 again.' }, 401);
    }
    await env.DB.prepare("DELETE FROM settings WHERE key = 'admin_magic'").run(); // single use
    const me = await ownerMe(env);
    await audit(env, me, 'Signed in', 'one-time link (open-admin.ps1)');
    return json({ ok: true, session: await newSession(env, 'owner'), me: meOut(me) });
  }

  function newCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  }

  // ─────────────── admin API ───────────────
  async function admin(req, env, path) {
    const auth = await adminAuth(req, env);
    if (auth.res) return auth.res;
    const { me } = auth;
    const can = (perm) => (ROLES[me.role]?.perms || []).includes(perm);
    const forbid = () => json({ ok: false, error: 'Your role can’t do this. Ask the owner or an admin.' }, 403);
    const method = req.method;
    const s = await getSettings(env, true);
    const plans = await getPlans(env, true);
    const day = today();
    const origin = new URL(req.url).origin;

    if (path === 'login' || path === 'me') return json({ ok: true, me: meOut(me) });

    if (path === 'logout' && method === 'POST') {
      if (/^[0-9a-f]{64}$/.test(auth.token)) await env.DB.prepare('DELETE FROM admin_sessions WHERE hash = ?').bind(await sha(auth.token)).run();
      return json({ ok: true });
    }

    // The owner's password (owner only).
    if (path === 'password' && method === 'PUT') {
      if (me.role !== 'owner') return forbid();
      const b = (await readBody(req)) || {};
      const pw = String(b.password || '').trim();
      if (pw.length < 8) return json({ ok: false, error: 'Use at least 8 characters.' }, 400);
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_hash', ?)").bind(JSON.stringify(await hashPassword(pw))).run();
      await audit(env, me, 'Changed the owner password');
      return json({ ok: true });
    }
    // A team member's own password.
    if (path === 'me/password' && method === 'PUT') {
      if (me.role === 'owner') return json({ ok: false, error: 'Use “Owner password” below.' }, 400);
      const b = (await readBody(req)) || {};
      const pw = String(b.password || '').trim();
      if (pw.length < 8) return json({ ok: false, error: 'Use at least 8 characters.' }, 400);
      if (!(await verifyPassword(String(b.current || '').trim(), me.pw))) return json({ ok: false, error: 'Your current password is wrong.' }, 400);
      await env.DB.prepare('UPDATE members SET pw = ? WHERE id = ?').bind(await hashPassword(pw), me.id).run();
      await env.DB.prepare('DELETE FROM admin_sessions WHERE member_id = ? AND hash != ?').bind(me.id, await sha(auth.token)).run();
      await audit(env, me, 'Changed their password');
      return json({ ok: true });
    }

    if (!can('view')) return forbid();

    // ── dashboard ──
    if (path === 'overview' && method === 'GET') {
      const since = daysAgo(13);
      const subs = ['all', 'free', 'premium', 'posts', ...PLATFORMS.map((p) => `posts:${p}`)];
      const { results: rows } = await env.DB.prepare(`SELECT day, subject, count, tokens_in, tokens_out FROM usage_daily WHERE day >= ? AND subject IN (${subs.map(() => '?').join(',')})`).bind(since, ...subs).all();
      const { results: errs } = await env.DB.prepare("SELECT day, COUNT(*) AS n FROM requests WHERE day >= ? AND status = 'error' GROUP BY day").bind(since).all();
      const { results: denied } = await env.DB.prepare("SELECT day, COUNT(*) AS n FROM post_log WHERE day >= ? AND status = 'denied' GROUP BY day").bind(since).all();
      const series = [];
      for (let i = 13; i >= 0; i--) {
        const d = daysAgo(i);
        const pick = (sub) => rows.find((r) => r.day === d && r.subject === sub) || {};
        const all = pick('all');
        const posts = Object.fromEntries(PLATFORMS.map((p) => [p, pick(`posts:${p}`).count || 0]));
        series.push({ day: d, requests: all.count || 0, free: pick('free').count || 0, premium: pick('premium').count || 0, tokensIn: all.tokens_in || 0, tokensOut: all.tokens_out || 0, errors: errs.find((e) => e.day === d)?.n || 0, posts: pick('posts').count || 0, byPlatform: posts, denied: denied.find((e) => e.day === d)?.n || 0 });
      }
      const devs = (d1, d2) => env.DB.prepare("SELECT COUNT(*) AS n FROM (SELECT install_id FROM requests WHERE day >= ? AND day <= ? AND status = 'ok' UNION SELECT install_id FROM post_log WHERE day >= ? AND day <= ? AND status = 'ok')").bind(d1, d2, d1, d2).first();
      const installsToday = (await devs(day, day))?.n || 0;
      const installs7 = (await devs(daysAgo(6), day))?.n || 0;
      const own = me.ownOnly ? ' AND created_by = ?' : '';
      const ownArgs = me.ownOnly ? [me.id] : [];
      const codes = await env.DB.prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'active' AND activated_at IS NOT NULL AND (expires_at IS NULL OR expires_at > ?) THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN status = 'active' AND expires_at > ? AND expires_at < ? THEN 1 ELSE 0 END) AS expiring, SUM(CASE WHEN status = 'active' AND activated_at IS NULL AND batch_id IS NOT NULL AND issued_at IS NULL AND (redeem_by IS NULL OR redeem_by > ?) THEN 1 ELSE 0 END) AS stock, SUM(CASE WHEN activated_at >= ? THEN 1 ELSE 0 END) AS activated7 FROM codes WHERE 1 = 1${own}`
      ).bind(Date.now(), Date.now(), Date.now() + 7 * DAY_MS, Date.now(), Date.now() - 7 * DAY_MS, ...ownArgs).first();
      const sales = async (from) => (await env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM codes WHERE sold_at >= ?${own}`).bind(from, ...ownArgs).first()) || { n: 0, amount: 0 };
      const monthStart = Date.parse(`${day.slice(0, 7)}-01T00:00:00Z`);
      const { results: byPlan } = await env.DB.prepare(`SELECT plan_id, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount, SUM(CASE WHEN status = 'active' AND activated_at IS NOT NULL AND (expires_at IS NULL OR expires_at > ?) THEN 1 ELSE 0 END) AS active FROM codes WHERE 1 = 1${own} GROUP BY plan_id`).bind(Date.now(), ...ownArgs).all();
      const cost = (tin, tout) => (tin * Number(s.price_in || 0) + tout * Number(s.price_out || 0)) / 1e6;
      const t = series.at(-1);
      const sum = (k, n) => series.slice(-n).reduce((a, x) => a + x[k], 0);
      return json({
        ok: true,
        today: { ...t, installs: installsToday, cost: cost(t.tokensIn, t.tokensOut) },
        week: { requests: sum('requests', 7), posts: sum('posts', 7), installs: installs7, cost: cost(sum('tokensIn', 7), sum('tokensOut', 7)) },
        month: { requests: sum('requests', 14), cost: cost(sum('tokensIn', 14), sum('tokensOut', 14)) },
        series,
        codes: { total: codes?.total || 0, active: codes?.active || 0, expiring: codes?.expiring || 0, stock: codes?.stock || 0, activated7: codes?.activated7 || 0 },
        sales: { today: await sales(Date.parse(`${day}T00:00:00Z`)), month: await sales(monthStart), days30: await sales(Date.now() - 30 * DAY_MS) },
        plans: Object.values(plans).map((p) => {
          const r = byPlan.find((x) => x.plan_id === p.id) || {};
          return { id: p.id, name: p.name, archived: p.archived, codes: r.n || 0, active: r.active || 0, amount: r.amount || 0 };
        }),
        settings: s,
        model: s.model || modelCache?.id || '(newest in your OpenAI account)',
        keySet: !!env.OPENAI_API_KEY,
      });
    }

    // ── plans ──
    if (path === 'plans' && method === 'GET') {
      const { results } = await env.DB.prepare("SELECT plan_id, COUNT(*) AS n, SUM(CASE WHEN status = 'active' AND activated_at IS NOT NULL AND (expires_at IS NULL OR expires_at > ?) THEN 1 ELSE 0 END) AS active FROM codes GROUP BY plan_id").bind(Date.now()).all();
      return json({ ok: true, plans: Object.values(plans).map((p) => ({ ...p, codes: results.find((r) => r.plan_id === p.id)?.n || 0, activeCodes: results.find((r) => r.plan_id === p.id)?.active || 0 })), platforms: PLATFORMS });
    }
    const planMatch = /^plans(?:\/([a-z0-9-]{1,32}))?$/.exec(path);
    if (planMatch && method !== 'GET') {
      if (!can('plans.edit')) return forbid();
      const b = (await readBody(req)) || {};
      const clean = (prev) => ({
        name: b.name !== undefined ? String(b.name).trim().slice(0, 40) : prev.name,
        description: b.description !== undefined ? String(b.description).trim().slice(0, 240) : prev.description,
        price: b.price !== undefined ? String(b.price).trim().slice(0, 40) : prev.price,
        sort: b.sort !== undefined ? int(b.sort, -1000, 1000, prev.sort) : prev.sort,
        public: b.public !== undefined ? !!b.public : prev.public,
        archived: b.archived !== undefined ? !!b.archived : prev.archived,
        features: b.features !== undefined ? normFeatures(b.features, prev.features) : prev.features,
      });
      if (!planMatch[1] && method === 'POST') {
        const base = b.copyFrom && plans[b.copyFrom] ? plans[b.copyFrom] : { ...DEFAULT_PLANS.premium, archived: false };
        const p = clean({ ...base, name: '', sort: Math.max(0, ...Object.values(plans).map((x) => x.sort)) + 10, archived: false });
        if (!p.name) return json({ ok: false, error: 'Give the plan a name.' }, 400);
        let id = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'plan';
        if (plans[id]) id = `${id}-${randomHex(2)}`;
        const now = Date.now();
        await env.DB.prepare('INSERT INTO plans (id, name, description, price, sort, public, archived, features, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)').bind(id, p.name, p.description, p.price, p.sort, p.public ? 1 : 0, JSON.stringify(p.features), now, now).run();
        dropCaches();
        await audit(env, me, 'Created a plan', p.name);
        return json({ ok: true, id });
      }
      const prev = planMatch[1] && plans[planMatch[1]];
      if (!prev) return json({ ok: false, error: 'No such plan.' }, 404);
      if (method === 'PATCH') {
        const p = clean(prev);
        if (!p.name) return json({ ok: false, error: 'Give the plan a name.' }, 400);
        if (prev.id === 'free') p.archived = false;
        await env.DB.prepare('UPDATE plans SET name = ?, description = ?, price = ?, sort = ?, public = ?, archived = ?, features = ?, updated_at = ? WHERE id = ?').bind(p.name, p.description, p.price, p.sort, p.public ? 1 : 0, p.archived ? 1 : 0, JSON.stringify(p.features), Date.now(), prev.id).run();
        dropCaches();
        await audit(env, me, 'Changed a plan', p.name + (p.archived !== prev.archived ? (p.archived ? ' (archived)' : ' (restored)') : ''));
        return json({ ok: true });
      }
      if (method === 'DELETE') {
        if (prev.id === 'free' || prev.id === 'premium') return json({ ok: false, error: `The ${prev.name} plan can’t be deleted. You can change it instead.` }, 400);
        const used = (await env.DB.prepare('SELECT COUNT(*) AS n FROM codes WHERE plan_id = ?').bind(prev.id).first())?.n || 0;
        if (used) return json({ ok: false, error: `${plural(used, ['access code uses', 'access codes use'])} this plan. Archive it instead (stops new sales, keeps customers working), or move those codes to another plan.` }, 400);
        await env.DB.prepare('DELETE FROM plans WHERE id = ?').bind(prev.id).run();
        dropCaches();
        await audit(env, me, 'Deleted a plan', prev.name);
        return json({ ok: true });
      }
    }

    // ── access codes ──
    const members = async () => {
      const { results } = await env.DB.prepare('SELECT id, name, email, role, status FROM members').all();
      return Object.fromEntries((results || []).map((m) => [m.id, m]));
    };
    const ownerName = (await ownerMe(env)).name;
    const codeStatus = (c, now = Date.now()) => {
      if (c.status !== 'active') return c.status;
      if (c.expires_at && c.expires_at < now) return 'expired';
      if (!c.activated_at) return c.redeem_by && c.redeem_by < now ? 'lapsed' : 'unused';
      return 'active';
    };
    const codeRow = (c, ctx) => {
      const plan = plans[c.plan_id] || plans.premium || plans.free;
      return {
        code: fmtCode(c.code),
        raw: c.code,
        label: c.label,
        contact: c.contact || '',
        note: c.note,
        planId: plan.id,
        planName: plan.name,
        dailyLimit: codeAi(c, plan),
        aiOverride: c.daily_limit >= 0,
        maxDevices: codeDevices(c, plan),
        devicesOverride: c.max_devices > 0,
        devices: ctx.devices,
        expiresAt: c.expires_at,
        status: codeStatus(c),
        durationDays: c.duration_days || 0,
        activatedAt: c.activated_at || null,
        redeemBy: c.redeem_by || null,
        batchId: c.batch_id || '',
        batchName: c.batch_id ? ctx.batches?.[c.batch_id]?.name || 'Batch' : '',
        issuedAt: c.issued_at || null,
        soldAt: c.sold_at || null,
        createdAt: c.created_at,
        createdBy: c.created_by || 'owner',
        createdByName: c.created_by === 'owner' || !c.created_by ? ownerName : ctx.members[c.created_by]?.name || 'Removed member',
        amount: c.amount || 0,
        payCurrency: c.pay_currency || '',
        payAmount: c.pay_amount || 0,
        lastUsedAt: c.last_used_at,
        totalUses: c.total_uses,
        usedToday: ctx.used,
        postsToday: ctx.posts,
      };
    };
    const mayTouch = (row) => !me.ownOnly || row.created_by === me.id;
    const batchNames = async () => Object.fromEntries(((await env.DB.prepare('SELECT id, name FROM batches').all()).results || []).map((b) => [b.id, b]));

    if (path === 'codes' && method === 'GET') {
      const { results } = me.ownOnly ? await env.DB.prepare('SELECT * FROM codes WHERE created_by = ? ORDER BY created_at DESC').bind(me.id).all() : await env.DB.prepare('SELECT * FROM codes ORDER BY created_at DESC').all();
      const { results: used } = await env.DB.prepare("SELECT subject, count FROM usage_daily WHERE day = ? AND (subject LIKE 'c:%' OR subject LIKE 'p:%:c:%')").bind(day).all();
      const { results: devs } = await env.DB.prepare('SELECT code, COUNT(*) AS n FROM code_devices GROUP BY code').all();
      const ai = {};
      const posts = {};
      for (const u of used) {
        const m = /^p:[a-z]+:c:([A-Z0-9]+)$/.exec(u.subject);
        if (m) posts[m[1]] = (posts[m[1]] || 0) + u.count;
        else ai[u.subject.slice(2)] = u.count;
      }
      const mem = await members();
      const bat = await batchNames();
      const devN = Object.fromEntries(devs.map((d) => [d.code, d.n]));
      return json({ ok: true, codes: results.map((c) => codeRow(c, { used: ai[c.code] || 0, posts: posts[c.code] || 0, devices: devN[c.code] || 0, members: mem, batches: bat })), currency: s.currency || '' });
    }

    if (path === 'codes' && method === 'POST') {
      if (!can('codes.create')) return forbid();
      const b = (await readBody(req)) || {};
      const plan = plans[b.planId] || plans.premium;
      if (!plan || plan.id === 'free') return json({ ok: false, error: 'Pick a paid plan for the code.' }, 400);
      const qty = int(b.quantity, 1, 200, 1);
      const daily = b.dailyLimit === '' || b.dailyLimit === null || b.dailyLimit === undefined ? -1 : int(b.dailyLimit, 0, 100000, -1);
      const devices = b.maxDevices === '' || b.maxDevices === null || b.maxDevices === undefined ? -1 : int(b.maxDevices, 1, 1000, -1);
      const onActivation = b.startOn === 'activation';
      const durationDays = onActivation ? int(b.durationDays, 0, 3650, plan.features.days || 0) : 0;
      const expires = onActivation ? null : b.expiresAt === undefined ? (plan.features.days ? Date.now() + plan.features.days * DAY_MS : null) : b.expiresAt ? Number(b.expiresAt) || null : null;
      const label = String(b.label || '').trim().slice(0, 80);
      const contact = String(b.contact || '').trim().slice(0, 120);
      const note = String(b.note || '').trim().slice(0, 300);
      let amount = Math.max(0, Math.min(1e9, Number(b.amount) || 0));
      let paid = { cur: '', paid: 0 };
      try {
        paid = await toBase(env, s, amount, b.payCurrency);
      } catch (e) {
        return json({ ok: false, error: e.message }, 400);
      }
      amount = paid.amount;
      const made = [];
      for (let i = 0; i < qty; i++) made.push(newCode());
      await env.DB.batch(
        made.map((c, i) =>
          env.DB.prepare('INSERT INTO codes (code, label, note, daily_limit, max_devices, expires_at, status, created_at, plan_id, created_by, contact, amount, duration_days, sold_at, pay_currency, pay_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(
            c,
            qty > 1 ? `${label}${label ? ' ' : ''}#${i + 1}` : label,
            note,
            daily,
            devices,
            expires,
            'active',
            Date.now(),
            plan.id,
            me.id,
            contact,
            qty > 1 ? amount / qty : amount,
            durationDays,
            Date.now(),
            paid.cur,
            paid.cur ? (qty > 1 ? paid.paid / qty : paid.paid) : 0
          )
        )
      );
      await audit(env, me, qty > 1 ? `Created ${qty} access codes` : 'Created an access code', `${plan.name}${label ? ` · ${label}` : ''}${amount ? ` · ${s.currency} ${amount}` : ''}${paid.cur ? ` (paid ${paid.cur} ${paid.paid})` : ''}`);
      return json({ ok: true, codes: made.map(fmtCode), plan: { id: plan.id, name: plan.name }, expiresAt: expires, durationDays });
    }

    const codeMatch = /^codes\/([A-Za-z0-9-]+)(\/reset-devices)?$/.exec(path);
    if (codeMatch) {
      const c = normCode(codeMatch[1]);
      const row = await env.DB.prepare('SELECT * FROM codes WHERE code = ?').bind(c).first();
      if (!row || !mayTouch(row)) return json({ ok: false, error: 'No such code.' }, 404);
      if (codeMatch[2] && method === 'POST') {
        if (!can('codes.support')) return forbid();
        await env.DB.prepare('DELETE FROM code_devices WHERE code = ?').bind(c).run();
        await audit(env, me, 'Reset devices', `${fmtCode(c)}${row.label ? ` · ${row.label}` : ''}`);
        return json({ ok: true });
      }
      if (method === 'GET') {
        const { results } = await env.DB.prepare('SELECT install_id, added_at, last_used_at FROM code_devices WHERE code = ? ORDER BY added_at').bind(c).all();
        return json({ ok: true, devices: results.map((d) => ({ install: d.install_id.slice(0, 8), addedAt: d.added_at, lastUsedAt: d.last_used_at })) });
      }
      if (method === 'PATCH') {
        const b = (await readBody(req)) || {};
        const onlyStatus = Object.keys(b).every((k) => k === 'status');
        if (!can(onlyStatus ? 'codes.support' : 'codes.edit')) return forbid();
        let expires = b.expiresAt !== undefined ? (b.expiresAt ? Number(b.expiresAt) : null) : row.expires_at;
        // Not activated yet and valid "N days from activation": renewing adds days, a fixed date replaces the countdown.
        const pending = !row.activated_at && row.duration_days > 0;
        let duration = row.duration_days || 0;
        if (b.durationDays !== undefined) duration = int(b.durationDays, 0, 3650, duration);
        if (pending && b.expiresAt !== undefined && b.expiresAt) duration = 0;
        if (b.extendDays && pending && !(b.expiresAt !== undefined && b.expiresAt)) duration += int(b.extendDays, 1, 3650, 30);
        else if (b.extendDays) expires = Math.max(expires || 0, Date.now()) + int(b.extendDays, 1, 3650, 30) * DAY_MS;
        if (pending && duration > 0 && !(b.expiresAt !== undefined && b.expiresAt)) expires = null;
        const plan = b.planId !== undefined ? plans[b.planId] : null;
        if (b.planId !== undefined && (!plan || plan.id === 'free')) return json({ ok: false, error: 'Pick a paid plan.' }, 400);
        const next = {
          label: b.label !== undefined ? String(b.label).trim().slice(0, 80) : row.label,
          contact: b.contact !== undefined ? String(b.contact).trim().slice(0, 120) : row.contact,
          note: b.note !== undefined ? String(b.note).trim().slice(0, 300) : row.note,
          daily_limit: b.dailyLimit !== undefined ? (b.dailyLimit === '' || b.dailyLimit === null ? -1 : int(b.dailyLimit, 0, 100000, -1)) : row.daily_limit,
          max_devices: b.maxDevices !== undefined ? (b.maxDevices === '' || b.maxDevices === null ? -1 : int(b.maxDevices, 1, 1000, -1)) : row.max_devices,
          expires_at: expires,
          status: b.status === 'disabled' || b.status === 'active' ? b.status : row.status,
          plan_id: plan ? plan.id : row.plan_id,
          amount: b.amount !== undefined ? Math.max(0, Math.min(1e9, Number(b.amount) || 0)) : row.amount,
          duration_days: duration,
          pay_currency: row.pay_currency || '',
          pay_amount: row.pay_amount || 0,
        };
        if (b.amount !== undefined) {
          try {
            const p = await toBase(env, s, next.amount, b.payCurrency);
            Object.assign(next, { amount: p.amount, pay_currency: p.cur, pay_amount: p.cur ? p.paid : 0 });
          } catch (e) {
            return json({ ok: false, error: e.message }, 400);
          }
        }
        await env.DB.prepare('UPDATE codes SET label = ?, contact = ?, note = ?, daily_limit = ?, max_devices = ?, expires_at = ?, status = ?, plan_id = ?, amount = ?, duration_days = ?, pay_currency = ?, pay_amount = ? WHERE code = ?')
          .bind(next.label, next.contact, next.note, next.daily_limit, next.max_devices, next.expires_at, next.status, next.plan_id, next.amount, next.duration_days, next.pay_currency, next.pay_amount, c)
          .run();
        const what = onlyStatus ? (next.status === 'disabled' ? 'Disabled an access code' : 'Enabled an access code') : b.extendDays ? `Extended an access code by ${int(b.extendDays, 1, 3650, 30)} days` : 'Edited an access code';
        await audit(env, me, what, `${fmtCode(c)}${next.label ? ` · ${next.label}` : ''}`);
        return json({ ok: true, expiresAt: next.expires_at, durationDays: next.duration_days, activated: !!row.activated_at });
      }
      if (method === 'DELETE') {
        if (!can('codes.delete')) return forbid();
        await env.DB.batch([env.DB.prepare('DELETE FROM codes WHERE code = ?').bind(c), env.DB.prepare('DELETE FROM code_devices WHERE code = ?').bind(c)]);
        await audit(env, me, 'Deleted an access code', `${fmtCode(c)}${row.label ? ` · ${row.label}` : ''}`);
        return json({ ok: true });
      }
    }

    // ── bulk batches ──
    const batchRow = (bt, st = {}) => {
      const plan = plans[bt.plan_id] || plans.premium || plans.free;
      return {
        id: bt.id,
        name: bt.name,
        planId: plan.id,
        planName: plan.name,
        quantity: bt.quantity,
        durationDays: bt.duration_days || 0,
        redeemBy: bt.redeem_by || null,
        channel: bt.channel || '',
        price: bt.price || 0,
        note: bt.note || '',
        createdAt: bt.created_at,
        createdBy: bt.created_by,
        total: st.total || 0,
        available: st.available || 0,
        issued: st.issued || 0,
        activated: st.activated || 0,
        active: st.active || 0,
        expired: st.expired || 0,
        disabled: st.disabled || 0,
        revenue: st.revenue || 0,
      };
    };
    const batchStats = async (id) => {
      const now = Date.now();
      const sql = `SELECT batch_id, COUNT(*) AS total,
        SUM(CASE WHEN status = 'active' AND activated_at IS NULL AND issued_at IS NULL AND (redeem_by IS NULL OR redeem_by > ?) THEN 1 ELSE 0 END) AS available,
        SUM(CASE WHEN activated_at IS NULL AND issued_at IS NOT NULL AND status = 'active' THEN 1 ELSE 0 END) AS issued,
        SUM(CASE WHEN activated_at IS NOT NULL THEN 1 ELSE 0 END) AS activated,
        SUM(CASE WHEN activated_at IS NOT NULL AND status = 'active' AND (expires_at IS NULL OR expires_at > ?) THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status = 'active' AND ((expires_at IS NOT NULL AND expires_at <= ?) OR (activated_at IS NULL AND redeem_by IS NOT NULL AND redeem_by <= ?)) THEN 1 ELSE 0 END) AS expired,
        SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled,
        COALESCE(SUM(CASE WHEN sold_at IS NOT NULL THEN amount ELSE 0 END), 0) AS revenue
        FROM codes WHERE batch_id ${id ? '= ?' : 'IS NOT NULL'} GROUP BY batch_id`;
      const { results } = await env.DB.prepare(sql).bind(now, now, now, now, ...(id ? [id] : [])).all();
      return Object.fromEntries((results || []).map((r) => [r.batch_id, r]));
    };
    if (path === 'batches' && method === 'GET') {
      const { results } = me.ownOnly ? await env.DB.prepare('SELECT * FROM batches WHERE created_by = ? ORDER BY created_at DESC').bind(me.id).all() : await env.DB.prepare('SELECT * FROM batches ORDER BY created_at DESC').all();
      const st = await batchStats();
      return json({ ok: true, batches: (results || []).map((bt) => batchRow(bt, st[bt.id])), currency: s.currency || '' });
    }
    if (path === 'batches' && method === 'POST') {
      if (!can('codes.create')) return forbid();
      const b = (await readBody(req)) || {};
      const plan = plans[b.planId];
      if (!plan || plan.id === 'free' || plan.archived) return json({ ok: false, error: 'Pick a paid plan for the codes.' }, 400);
      const qty = Number(b.quantity) >= 1 ? int(b.quantity, 1, MAX_BATCH, 0) : 0;
      if (!qty) return json({ ok: false, error: `Choose how many codes to make (1–${MAX_BATCH}).` }, 400);
      const name = String(b.name || '').trim().slice(0, 80) || `${plan.name} · ${today()}`;
      const durationDays = int(b.durationDays, 0, 3650, plan.features.days || 0);
      const redeemBy = b.redeemBy ? Number(b.redeemBy) || null : null;
      if (redeemBy && redeemBy < Date.now()) return json({ ok: false, error: 'The “activate by” date has already passed.' }, 400);
      const price = Math.max(0, Math.min(1e9, Number(b.price) || 0));
      const channel = String(b.channel || '').trim().slice(0, 80);
      const note = String(b.note || '').trim().slice(0, 300);
      const daily = b.dailyLimit === '' || b.dailyLimit === null || b.dailyLimit === undefined ? -1 : int(b.dailyLimit, 0, 100000, -1);
      const devices = b.maxDevices === '' || b.maxDevices === null || b.maxDevices === undefined ? -1 : int(b.maxDevices, 1, 1000, -1);
      const id = `b${Date.now().toString(36)}${randomHex(3)}`;
      const now = Date.now();
      const made = new Set();
      while (made.size < qty) made.add(newCode());
      const list = [...made];
      await env.DB.prepare('INSERT INTO batches (id, name, plan_id, quantity, duration_days, redeem_by, channel, price, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, name, plan.id, qty, durationDays, redeemBy, channel, price, note, now, me.id).run();
      for (let i = 0; i < list.length; i += 100) {
        await env.DB.batch(
          list.slice(i, i + 100).map((c) =>
            env.DB.prepare("INSERT INTO codes (code, label, note, daily_limit, max_devices, expires_at, status, created_at, plan_id, created_by, contact, amount, duration_days, batch_id, redeem_by) VALUES (?, '', ?, ?, ?, NULL, 'active', ?, ?, ?, '', 0, ?, ?, ?)").bind(c, '', daily, devices, now, plan.id, me.id, durationDays, id, redeemBy)
          )
        );
      }
      await audit(env, me, `Generated ${plural(qty, ['access code', 'access codes'])} in bulk`, `${name} · ${plan.name}${durationDays ? ` · ${durationDays} days from activation` : ' · no expiry'}${channel ? ` · ${channel}` : ''}`);
      const st = await batchStats(id);
      const bt = await env.DB.prepare('SELECT * FROM batches WHERE id = ?').bind(id).first();
      return json({ ok: true, batch: batchRow(bt, st[id]), codes: list.map(fmtCode) });
    }
    const batchMatch = /^batches\/([a-z0-9]{4,40})(?:\/(codes|issue))?$/.exec(path);
    if (batchMatch) {
      const bt = await env.DB.prepare('SELECT * FROM batches WHERE id = ?').bind(batchMatch[1]).first();
      if (!bt || !mayTouch(bt)) return json({ ok: false, error: 'No such batch.' }, 404);
      const sub = batchMatch[2];
      if (sub === 'codes' && method === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM codes WHERE batch_id = ? ORDER BY created_at, code').bind(bt.id).all();
        const mem = await members();
        return json({ ok: true, batch: batchRow(bt, (await batchStats(bt.id))[bt.id]), codes: (results || []).map((c) => codeRow(c, { used: 0, posts: 0, devices: 0, members: mem, batches: { [bt.id]: bt } })) });
      }
      // Hand out the next unused codes (to a customer, or for export to a shop), so no code is given twice.
      if (sub === 'issue' && method === 'POST') {
        if (!can('codes.create')) return forbid();
        const b = (await readBody(req)) || {};
        const n = int(b.count, 1, MAX_BATCH, 1);
        const { results } = await env.DB.prepare("SELECT code FROM codes WHERE batch_id = ? AND status = 'active' AND activated_at IS NULL AND issued_at IS NULL AND (redeem_by IS NULL OR redeem_by > ?) ORDER BY created_at, code LIMIT ?").bind(bt.id, Date.now(), n).all();
        const picked = (results || []).map((r) => r.code);
        if (!picked.length) return json({ ok: false, error: 'No unused codes left in this batch. Generate more.' }, 400);
        const label = String(b.label || '').trim().slice(0, 80);
        const contact = String(b.contact || '').trim().slice(0, 120);
        const sale = b.sale !== false; // exported for a shop: counts as a sale when activated instead
        let paid = { cur: '', paid: 0 };
        let total = bt.price * picked.length;
        if (!(b.amount === undefined || b.amount === '' || b.amount === null)) {
          try {
            paid = await toBase(env, s, Math.max(0, Math.min(1e9, Number(b.amount) || 0)), b.payCurrency);
          } catch (e) {
            return json({ ok: false, error: e.message }, 400);
          }
          total = paid.amount;
        }
        const each = picked.length ? total / picked.length : 0;
        const eachPaid = paid.cur && picked.length ? paid.paid / picked.length : 0;
        const now = Date.now();
        for (let i = 0; i < picked.length; i += 100) {
          await env.DB.batch(
            picked.slice(i, i + 100).map((c) =>
              sale
                ? env.DB.prepare('UPDATE codes SET issued_at = ?, label = ?, contact = ?, amount = ?, sold_at = ?, pay_currency = ?, pay_amount = ? WHERE code = ?').bind(now, label, contact, each, now, paid.cur, eachPaid, c)
                : env.DB.prepare('UPDATE codes SET issued_at = ? WHERE code = ?').bind(now, c)
            )
          );
        }
        await audit(env, me, sale ? `Gave out ${picked.length} code${picked.length === 1 ? '' : 's'} from a batch` : `Exported ${picked.length} code${picked.length === 1 ? '' : 's'} from a batch`, `${bt.name}${label ? ` · ${label}` : ''}`);
        return json({ ok: true, codes: picked.map(fmtCode), short: picked.length < n, plan: { id: bt.plan_id, name: (plans[bt.plan_id] || {}).name || '' }, durationDays: bt.duration_days || 0, redeemBy: bt.redeem_by || null });
      }
      if (!sub && method === 'PATCH') {
        const b = (await readBody(req)) || {};
        const writes = [];
        let what = 'Changed a batch';
        if (b.name !== undefined || b.channel !== undefined || b.note !== undefined || b.price !== undefined) {
          if (!can('codes.edit')) return forbid();
          writes.push(
            env.DB.prepare('UPDATE batches SET name = ?, channel = ?, note = ?, price = ? WHERE id = ?').bind(
              b.name !== undefined ? String(b.name).trim().slice(0, 80) || bt.name : bt.name,
              b.channel !== undefined ? String(b.channel).trim().slice(0, 80) : bt.channel,
              b.note !== undefined ? String(b.note).trim().slice(0, 300) : bt.note,
              b.price !== undefined ? Math.max(0, Math.min(1e9, Number(b.price) || 0)) : bt.price,
              bt.id
            )
          );
        }
        if (b.redeemBy !== undefined) {
          if (!can('codes.edit')) return forbid();
          const rb = b.redeemBy ? Number(b.redeemBy) || null : null;
          writes.push(env.DB.prepare('UPDATE batches SET redeem_by = ? WHERE id = ?').bind(rb, bt.id), env.DB.prepare('UPDATE codes SET redeem_by = ? WHERE batch_id = ? AND activated_at IS NULL').bind(rb, bt.id));
          what = 'Changed a batch’s activate-by date';
        }
        // Turn the codes nobody has activated yet off (e.g. stock withdrawn from a shop) or back on.
        if (b.unused === 'disabled' || b.unused === 'active') {
          if (!can('codes.support')) return forbid();
          writes.push(env.DB.prepare('UPDATE codes SET status = ? WHERE batch_id = ? AND activated_at IS NULL').bind(b.unused, bt.id));
          what = b.unused === 'disabled' ? 'Turned off a batch’s unused codes' : 'Turned on a batch’s unused codes';
        }
        if (b.all === 'disabled' || b.all === 'active') {
          if (!can('codes.support')) return forbid();
          writes.push(env.DB.prepare('UPDATE codes SET status = ? WHERE batch_id = ?').bind(b.all, bt.id));
          what = b.all === 'disabled' ? 'Turned off all codes in a batch' : 'Turned on all codes in a batch';
        }
        if (!writes.length) return json({ ok: false, error: 'Nothing to change.' }, 400);
        await env.DB.batch(writes);
        await audit(env, me, what, bt.name);
        return json({ ok: true });
      }
      if (!sub && method === 'DELETE') {
        if (!can('codes.delete')) return forbid();
        // Only codes nobody has activated are deleted; customers keep theirs.
        const left = (await env.DB.prepare('SELECT COUNT(*) AS n FROM codes WHERE batch_id = ? AND activated_at IS NOT NULL').bind(bt.id).first())?.n || 0;
        const gone = (await env.DB.prepare('SELECT COUNT(*) AS n FROM codes WHERE batch_id = ? AND activated_at IS NULL').bind(bt.id).first())?.n || 0;
        const writes = [env.DB.prepare('DELETE FROM codes WHERE batch_id = ? AND activated_at IS NULL').bind(bt.id)];
        if (!left) writes.push(env.DB.prepare('DELETE FROM batches WHERE id = ?').bind(bt.id));
        await env.DB.batch(writes);
        await audit(env, me, 'Deleted a batch’s unused codes', `${bt.name} · ${gone} deleted${left ? `, ${left} in use kept` : ''}`);
        return json({ ok: true, deleted: gone, kept: left });
      }
    }

    // ── activity ──
    if (path === 'requests' && method === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 300').all();
      return json({
        ok: true,
        requests: results.map((r) => ({ at: r.at, tier: r.tier, code: r.code ? fmtCode(r.code) : '', install: (r.install_id || '').slice(0, 8), installId: r.install_id, ip: r.ip_hash, model: r.model, platform: r.platform, tokens: r.tokens_in + r.tokens_out, status: r.status, error: r.error })),
      });
    }
    if (path === 'posts' && method === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM post_log ORDER BY id DESC LIMIT 400').all();
      return json({
        ok: true,
        posts: results.map((r) => ({ at: r.at, tier: r.tier, plan: plans[r.plan_id]?.name || r.plan_id || '', code: r.code ? fmtCode(r.code) : '', install: (r.install_id || '').slice(0, 8), platform: r.platform, count: r.count, kind: r.kind, status: r.status, reason: r.reason || '' })),
      });
    }

    if (path === 'devices' && method === 'GET') {
      const since = daysAgo(6);
      const { results: ai } = await env.DB.prepare(
        "SELECT install_id, MAX(ip_hash) AS ip, SUM(CASE WHEN day = ? THEN 1 ELSE 0 END) AS today, COUNT(*) AS week, MAX(at) AS last, MAX(code) AS code FROM requests WHERE day >= ? AND status = 'ok' GROUP BY install_id"
      )
        .bind(day, since)
        .all();
      const { results: po } = await env.DB.prepare(
        "SELECT install_id, MAX(ip_hash) AS ip, SUM(CASE WHEN day = ? AND kind = 'claim' THEN count WHEN day = ? THEN -count ELSE 0 END) AS today, SUM(CASE WHEN kind = 'claim' THEN count ELSE -count END) AS week, MAX(at) AS last, MAX(code) AS code FROM post_log WHERE day >= ? AND status = 'ok' GROUP BY install_id"
      )
        .bind(day, day, since)
        .all();
      const map = new Map();
      for (const r of ai) map.set(r.install_id, { installId: r.install_id, ip: r.ip, aiToday: r.today, aiWeek: r.week, postsToday: 0, postsWeek: 0, last: r.last, code: r.code });
      for (const r of po) {
        const d = map.get(r.install_id) || { installId: r.install_id, ip: r.ip, aiToday: 0, aiWeek: 0, last: 0, code: r.code };
        Object.assign(d, { postsToday: Math.max(0, r.today), postsWeek: Math.max(0, r.week), last: Math.max(d.last || 0, r.last), code: d.code || r.code, ip: d.ip || r.ip });
        map.set(r.install_id, d);
      }
      const list = [...map.values()].sort((a, b) => b.aiToday + b.postsToday - (a.aiToday + a.postsToday) || b.aiWeek + b.postsWeek - (a.aiWeek + a.postsWeek)).slice(0, 200);
      const { results: blocks } = await env.DB.prepare('SELECT * FROM blocks ORDER BY at DESC').all();
      const isBlocked = new Set(blocks.map((x) => x.subject));
      return json({
        ok: true,
        devices: list.map((d) => ({ ...d, install: d.installId.slice(0, 8), tier: d.code ? 'premium' : 'free', code: d.code ? fmtCode(d.code) : '', blocked: isBlocked.has(`i:${d.installId}`), ipBlocked: isBlocked.has(`ip:${d.ip}`) })),
        blocks: blocks.map((x) => ({ subject: x.subject, reason: x.reason, at: x.at })),
      });
    }

    if (path === 'blocks' && method === 'POST') {
      if (!can('devices.block')) return forbid();
      const b = (await readBody(req)) || {};
      if (!/^(i:[A-Za-z0-9_-]{16,64}|ip:[a-f0-9]{16})$/.test(b.subject || '')) return json({ ok: false, error: 'Bad subject.' }, 400);
      await env.DB.prepare('INSERT OR REPLACE INTO blocks (subject, reason, at) VALUES (?, ?, ?)').bind(b.subject, String(b.reason || '').slice(0, 200), Date.now()).run();
      await audit(env, me, b.subject.startsWith('ip:') ? 'Blocked a network' : 'Blocked a device', b.subject.slice(0, 12));
      return json({ ok: true });
    }
    const blockMatch = /^blocks\/(.+)$/.exec(path);
    if (blockMatch && method === 'DELETE') {
      if (!can('devices.block')) return forbid();
      const subject = decodeURIComponent(blockMatch[1]);
      await env.DB.prepare('DELETE FROM blocks WHERE subject = ?').bind(subject).run();
      await audit(env, me, 'Unblocked', subject.slice(0, 12));
      return json({ ok: true });
    }

    // ── settings ──
    // ── currency exchange ──
    if (path === 'fx' && (method === 'GET' || method === 'POST')) {
      const force = method === 'POST';
      if (force && !can('settings.edit')) return forbid();
      const fx = await getRates(env, s, force);
      if (force && fx && !fx.stale) await audit(env, me, 'Refreshed exchange rates', `${fx.base} · ${fx.source}`);
      const cust = await customerRates(env, s);
      return json({
        ok: true,
        base: iso(s.currency) || s.currency,
        live: !!fx,
        stale: !!fx?.stale,
        source: fx?.source || '',
        updated: fx?.updated || null,
        fetchedAt: fx?.at || null,
        rates: fx?.rates || {},
        customer: cust?.rates || {},
        manual: parseManual(s.fx_manual),
        markup: Number(s.fx_markup) || 0,
        payCurrencies: isoList(s.pay_currencies),
        currencies: CURRENCIES,
        error: fx ? '' : iso(s.currency) ? 'Couldn’t reach the exchange-rate service. Try again later, or add your own rates in Settings → Currencies.' : 'Set your currency to a 3-letter code (e.g. GHS) in Settings → Currencies.',
      });
    }

    if (path === 'settings' && method === 'GET') return json({ ok: true, settings: s, defaults: DEFAULT_SETTINGS, currencies: CURRENCIES });
    if (path === 'settings' && method === 'PUT') {
      if (!can('settings.edit')) return forbid();
      const b = (await readBody(req)) || {};
      const writes = [];
      const changed = [];
      for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
        if (!(k in b)) continue;
        let v = b[k];
        if (NUM_KEYS.includes(k)) v = Math.max(0, Number(v) || 0);
        else if (BOOL_KEYS.includes(k)) v = !!v;
        else v = String(v ?? def).slice(0, 400);
        if (k === 'fx_markup') v = Math.min(50, v);
        if (k === 'currency') {
          v = String(v).trim().toUpperCase().slice(0, 8);
          if (!v) return json({ ok: false, error: 'Choose your currency.' }, 400);
        }
        if (k === 'pay_currencies') v = isoList(v).join(',');
        if (k === 'fx_manual') v = Object.entries(parseManual(v)).map(([c, r]) => `${c}=${r}`).join(', ');
        if (JSON.stringify(v) !== JSON.stringify(s[k])) changed.push(k);
        writes.push(env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(k, JSON.stringify(v)));
      }
      if (writes.length) await env.DB.batch(writes);
      modelCache = null;
      if (changed.includes('currency')) fxMem = null;
      if (changed.length) await audit(env, me, 'Changed settings', changed.join(', '));
      return json({ ok: true, settings: await getSettings(env, true) });
    }

    if (path === 'models' && method === 'GET') {
      if (!can('settings.edit')) return forbid();
      try {
        return json({ ok: true, models: await listModels(env) });
      } catch (e) {
        return json({ ok: false, error: `Couldn’t list models with your OpenAI key (${e.message}). Check the OPENAI_API_KEY secret and your OpenAI billing.` }, 502);
      }
    }

    if (path === 'test' && method === 'POST') {
      if (!can('settings.edit')) return forbid();
      const b = (await readBody(req)) || {};
      const text = String(b.text || 'join us sunday 9am for service, all are welcome').slice(0, 1000);
      try {
        const model = await pickModel(env, s);
        const r = globalThis.RitAIPrompt.buildRequest(text, { action: 'Make it clearer, more engaging and polished', platform: 'whatsapp', count: 1 });
        const out = await openai(env, model, r);
        const v = globalThis.RitAIPrompt.parse(out.content, r.opts);
        return json({ ok: true, model: out.model, text: v[0].text, tokens: (out.usage.prompt_tokens || 0) + (out.usage.completion_tokens || 0) });
      } catch (e) {
        return json({ ok: false, error: `${e.message}${e.detail ? ` (${e.detail})` : ''}` }, 502);
      }
    }

    // ── team ──
    if (path === 'audit' && method === 'GET') {
      if (!can('audit')) return forbid();
      const { results } = await env.DB.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 300').all();
      return json({ ok: true, audit: results.map((a) => ({ at: a.at, actor: a.actor, actorName: a.actor_name, action: a.action, detail: a.detail })) });
    }

    if (path === 'team' && method === 'GET') {
      if (!can('team')) return forbid();
      const { results } = await env.DB.prepare('SELECT * FROM members ORDER BY created_at').all();
      const { results: sold } = await env.DB.prepare('SELECT created_by, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount, SUM(CASE WHEN sold_at >= ? THEN 1 ELSE 0 END) AS n30, COALESCE(SUM(CASE WHEN sold_at >= ? THEN amount ELSE 0 END), 0) AS amount30 FROM codes WHERE sold_at IS NOT NULL GROUP BY created_by').bind(Date.now() - 30 * DAY_MS, Date.now() - 30 * DAY_MS).all();
      const st = (id) => sold.find((x) => (x.created_by || 'owner') === id) || {};
      const row = (m) => ({ id: m.id, name: m.name, email: m.email, role: m.role, roleName: ROLES[m.role]?.name || m.role, status: m.status === 'invited' && m.invite_exp && m.invite_exp < Date.now() ? 'expired' : m.status, ownOnly: !!m.own_only, createdAt: m.created_at, lastLoginAt: m.last_login_at, codes: st(m.id).n || 0, amount: st(m.id).amount || 0, codes30: st(m.id).n30 || 0, amount30: st(m.id).amount30 || 0 });
      const owner = await ownerMe(env);
      return json({ ok: true, members: [{ ...row({ ...owner, status: 'active', created_at: null, last_login_at: null }), owner: true }, ...results.map(row)], roles: Object.fromEntries(Object.entries(ROLES).filter(([k]) => k !== 'owner').map(([k, v]) => [k, v.name])), currency: s.currency || '' });
    }
    const inviteLink = async (id) => {
      const tok = randomHex();
      await env.DB.prepare('UPDATE members SET invite_hash = ?, invite_exp = ? WHERE id = ?').bind(await sha(tok), Date.now() + INVITE_MS, id).run();
      return `${origin}/admin#invite=${tok}`;
    };
    if (path === 'team' && method === 'POST') {
      if (!can('team')) return forbid();
      const b = (await readBody(req)) || {};
      const name = String(b.name || '').trim().slice(0, 60);
      const email = String(b.email || '').trim().toLowerCase().slice(0, 120);
      const role = String(b.role || '');
      if (!name) return json({ ok: false, error: 'Enter their name.' }, 400);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: 'Enter a valid email address. They sign in with it.' }, 400);
      if (!ROLES[role] || role === 'owner') return json({ ok: false, error: 'Pick a role.' }, 400);
      if (await env.DB.prepare('SELECT 1 AS x FROM members WHERE email = ?').bind(email).first()) return json({ ok: false, error: 'Someone on the team already uses this email.' }, 400);
      const id = randomHex(8);
      await env.DB.prepare("INSERT INTO members (id, name, email, role, status, own_only, created_at, created_by) VALUES (?, ?, ?, ?, 'invited', ?, ?, ?)").bind(id, name, email, role, b.ownOnly ? 1 : 0, Date.now(), me.id).run();
      const link = await inviteLink(id);
      await audit(env, me, 'Invited a team member', `${name} (${email}) as ${ROLES[role].name}`);
      return json({ ok: true, id, link, expiresAt: Date.now() + INVITE_MS });
    }
    const teamMatch = /^team\/([0-9a-f]{16})(\/invite)?$/.exec(path);
    if (teamMatch) {
      if (!can('team')) return forbid();
      const m = await memberById(env, teamMatch[1]);
      if (!m) return json({ ok: false, error: 'No such team member.' }, 404);
      if (teamMatch[2] && method === 'POST') {
        const link = await inviteLink(m.id);
        if (m.status !== 'disabled') await env.DB.prepare("UPDATE members SET status = CASE WHEN pw IS NULL THEN 'invited' ELSE status END WHERE id = ?").bind(m.id).run();
        await audit(env, me, 'Made a new sign-in link', `${m.name} (${m.email})`);
        return json({ ok: true, link, expiresAt: Date.now() + INVITE_MS });
      }
      if (method === 'PATCH') {
        const b = (await readBody(req)) || {};
        const next = {
          name: b.name !== undefined ? String(b.name).trim().slice(0, 60) || m.name : m.name,
          role: b.role !== undefined && ROLES[b.role] && b.role !== 'owner' ? b.role : m.role,
          own_only: b.ownOnly !== undefined ? (b.ownOnly ? 1 : 0) : m.own_only,
          status: b.status === 'disabled' ? 'disabled' : b.status === 'active' ? (m.pw ? 'active' : 'invited') : m.status,
        };
        await env.DB.prepare('UPDATE members SET name = ?, role = ?, own_only = ?, status = ? WHERE id = ?').bind(next.name, next.role, next.own_only, next.status, m.id).run();
        if (next.status === 'disabled' || next.role !== m.role) await env.DB.prepare('DELETE FROM admin_sessions WHERE member_id = ?').bind(m.id).run();
        const what = next.status !== m.status ? (next.status === 'disabled' ? 'Turned off a team member' : 'Turned on a team member') : 'Changed a team member';
        await audit(env, me, what, `${next.name} (${m.email})${next.role !== m.role ? `: ${ROLES[m.role]?.name} → ${ROLES[next.role].name}` : ''}`);
        return json({ ok: true });
      }
      if (method === 'DELETE') {
        await env.DB.batch([env.DB.prepare('DELETE FROM members WHERE id = ?').bind(m.id), env.DB.prepare('DELETE FROM admin_sessions WHERE member_id = ?').bind(m.id)]);
        await audit(env, me, 'Removed a team member', `${m.name} (${m.email})`);
        return json({ ok: true });
      }
    }

    return json({ ok: false, error: 'Not found.' }, 404);
  }

  // ─────────────── router ───────────────
  async function handle(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const c = cors(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: c });
    const withCors = (res) => {
      for (const [k, v] of Object.entries(c)) res.headers.set(k, v);
      return res;
    };
    try {
      if (path === '/admin') return new Response(adminHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" } });
      if (path === '/') return new Response('RitPost server is running. Admin: /admin', { headers: { 'Content-Type': 'text/plain' } });
      await ensureSchema(env);
      if (path === '/admin/login' && req.method === 'POST') return withCors(await login(req, env));
      if (path === '/admin/invite' && req.method === 'POST') return withCors(await acceptInvite(req, env));
      if (path === '/admin/magic' && req.method === 'POST') return withCors(await magicLogin(req, env));
      if (path.startsWith('/admin/api/')) return withCors(await admin(req, env, path.slice('/admin/api/'.length)));
      if (req.method === 'POST' && path === '/v1/status') return withCors(await apiStatus(req, env));
      if (req.method === 'POST' && path === '/v1/redeem') return withCors(await apiStatus(req, env, { register: true }));
      if (req.method === 'POST' && path === '/v1/rewrite') return withCors(await apiRewrite(req, env, ctx));
      if (req.method === 'POST' && path === '/v1/posts/claim') return withCors(await apiPosts(req, env));
      if (req.method === 'POST' && path === '/v1/posts/release') return withCors(await apiPosts(req, env, { release: true }));
      return withCors(json({ ok: false, error: 'Not found.' }, 404));
    } catch (e) {
      return withCors(json({ ok: false, error: 'Server error. Please try again.', detail: String(e?.message || e).slice(0, 200) }, 500));
    }
  }

  async function scheduled(_event, env) {
    await ensureSchema(env);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM requests WHERE at < ?').bind(Date.now() - 90 * DAY_MS),
      env.DB.prepare('DELETE FROM post_log WHERE at < ?').bind(Date.now() - 90 * DAY_MS),
      env.DB.prepare('DELETE FROM audit WHERE at < ?').bind(Date.now() - 365 * DAY_MS),
      env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').bind(Date.now()),
      env.DB.prepare('DELETE FROM usage_daily WHERE day < ?').bind(daysAgo(120)),
    ]);
  }

  return { fetch: handle, scheduled };
}
