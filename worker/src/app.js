/*
 * RitPost AI server (Cloudflare Worker + D1).
 *
 * Public API (called by the RitPost extension):
 *   POST /v1/status   { installId, code? }          → plan, remaining today, announcement
 *   POST /v1/redeem   { installId, code }           → checks a premium access code
 *   POST /v1/rewrite  { installId, code?, text, opts } → { variations, plan, usage, model }
 *
 * Admin portal: GET /admin (page), /admin/api/* (Bearer ADMIN_TOKEN).
 *
 * Secrets: OPENAI_API_KEY, ADMIN_TOKEN. Binding: DB (D1). The OpenAI key never leaves the server.
 */

export const DEFAULT_SETTINGS = {
  service_on: true, // master switch
  free_on: true, // free tier for everyone
  free_daily: 30, // free rewrites per install per day
  free_ip_daily: 120, // free rewrites per network (IP) per day — stops reinstall tricks
  premium_daily: 300, // default for new access codes
  premium_devices: 3, // default devices per access code
  global_daily: 5000, // all users together per day (spend guard)
  model: '', // empty = pick the newest chat model in the OpenAI account
  max_chars: 3000, // longest post accepted
  price_in: 0, // USD per 1M input tokens (for the cost estimate)
  price_out: 0, // USD per 1M output tokens
  announcement: '', // short message shown in RitPost's AI settings
  upgrade_text: 'Need more rewrites? Get a premium access code from RitPost.',
  upgrade_url: '',
};
const NUM_KEYS = ['free_daily', 'free_ip_daily', 'premium_daily', 'premium_devices', 'global_daily', 'max_chars', 'price_in', 'price_out'];
const BOOL_KEYS = ['service_on', 'free_on'];

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const today = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const daysAgo = (n) => today(Date.now() - n * 86400000);
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^RP/, '');
const fmtCode = (raw) => `RP-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;

export function createApp({ adminHtml = '<!doctype html><title>RitPost AI</title>', fetchImpl } = {}) {
  const doFetch = (...a) => (fetchImpl || fetch)(...a);
  let settingsCache = null;
  let settingsAt = 0;
  let modelCache = null;

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
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const ipHash = async (req, env) => (await sha(`${req.headers.get('CF-Connecting-IP') || 'unknown'}|${env.ADMIN_TOKEN || 'ritpost'}`)).slice(0, 16);

  function safeEqual(a, b) {
    a = String(a || '');
    b = String(b || '');
    let diff = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return diff === 0 && a.length > 0;
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

  async function count(env, day, subject) {
    const r = await env.DB.prepare('SELECT count FROM usage_daily WHERE day = ? AND subject = ?').bind(day, subject).first();
    return r?.count || 0;
  }
  const bump = (env, day, subject, n = 1, tin = 0, tout = 0) =>
    env.DB.prepare(
      'INSERT INTO usage_daily (day, subject, count, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?) ON CONFLICT(day, subject) DO UPDATE SET count = count + excluded.count, tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out'
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

  /** Work out a request's plan; `register` adds this install to a code's devices. */
  async function plan(env, s, installId, rawCode, { register = false } = {}) {
    const day = today();
    if (rawCode) {
      const code = await findCode(env, rawCode);
      if (!code) return { error: 'That access code isn’t valid. Check it and try again.', code: 'invalid_code' };
      if (code.status !== 'active') return { error: 'This access code has been turned off. Contact the person who gave it to you.', code: 'code_disabled' };
      if (code.expires_at && code.expires_at < Date.now()) return { error: 'This access code has expired. Ask for a new one to keep using premium.', code: 'code_expired' };
      const dev = await env.DB.prepare('SELECT 1 AS x FROM code_devices WHERE code = ? AND install_id = ?').bind(code.code, installId).first();
      if (!dev) {
        const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM code_devices WHERE code = ?').bind(code.code).first())?.n || 0;
        if (n >= code.max_devices) return { error: `This access code is already used on ${code.max_devices} device${code.max_devices === 1 ? '' : 's'}, its limit.`, code: 'code_devices' };
        if (register) await env.DB.prepare('INSERT OR IGNORE INTO code_devices (code, install_id, added_at) VALUES (?, ?, ?)').bind(code.code, installId, Date.now()).run();
      }
      const used = await count(env, day, `c:${code.code}`);
      return { tier: 'premium', code: code.code, label: code.label, limit: code.daily_limit, used, remaining: Math.max(0, code.daily_limit - used), expiresAt: code.expires_at || null, subject: `c:${code.code}` };
    }
    if (!s.free_on) return { error: 'Free AI rewrites are paused right now. Enter a premium access code, or use your own OpenAI key.', code: 'free_off' };
    const used = await count(env, day, `i:${installId}`);
    return { tier: 'free', limit: s.free_daily, used, remaining: Math.max(0, s.free_daily - used), subject: `i:${installId}` };
  }
  const publicPlan = (p) => (p && !p.error ? { tier: p.tier, label: p.label || '', limit: p.limit, used: p.used, remaining: p.remaining, expiresAt: p.expiresAt || null, resetsAt: Date.parse(`${today()}T00:00:00Z`) + 86400000 } : null);

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
    const base = { announcement: s.announcement || '', upgradeText: s.upgrade_text || '', upgradeUrl: s.upgrade_url || '', serviceOn: !!s.service_on, freeOn: !!s.free_on, freeDaily: s.free_daily };
    if (register && !b.code) return json({ ok: false, error: 'Enter an access code.', code: 'invalid_code', ...base }, 400);
    const p = await plan(env, s, b.installId, b.code, { register });
    if (p.error) {
      // Fall back to showing the free plan when a stored code no longer works.
      const free = !register && b.code ? await plan(env, s, b.installId, '') : null;
      return json({ ok: false, error: p.error, code: p.code, plan: publicPlan(free), ...base }, register ? 400 : 200);
    }
    return json({ ok: true, plan: publicPlan(p), ...base });
  }

  async function apiRewrite(req, env, ctx) {
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

    const p = await plan(env, s, b.installId, b.code, { register: true });
    if (p.error) return json({ ok: false, error: p.error, code: p.code }, 403);
    const day = today();
    if (p.remaining <= 0)
      return json(
        {
          ok: false,
          code: 'limit',
          plan: publicPlan(p),
          error: p.tier === 'premium' ? `You’ve used all ${p.limit} premium rewrites for today. They reset at midnight (UTC).` : `You’ve used your ${p.limit} free rewrite${p.limit === 1 ? '' : 's'} for today. They reset at midnight (UTC). ${s.upgrade_text || ''}`.trim(),
        },
        429
      );
    if (p.tier === 'free' && (await count(env, day, `ip:${ip}`)) >= s.free_ip_daily)
      return json({ ok: false, code: 'limit', plan: publicPlan(p), error: `Free rewrites from your network are used up for today. ${s.upgrade_text || ''}`.trim() }, 429);
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
      return json({ ok: true, variations, model: out.model, usage: { total_tokens: tin + tout }, plan: publicPlan(after) });
    } catch (e) {
      await env.DB.batch(subjects.map((sub) => bump(env, day, sub, -1)));
      await log('error', { model, error: String(e.detail || e.message).slice(0, 300) });
      return json({ ok: false, code: 'ai_error', error: e.message || 'RitPost AI couldn’t write right now.', plan: publicPlan(p) }, 502);
    }
  }

  // ─────────────── admin API ───────────────
  async function adminAuth(req, env) {
    // Two ways to hold the password: a salted hash in the database (set by
    // worker\set-admin-password.ps1, preferred) or the ADMIN_TOKEN secret.
    // Stray spaces / line breaks don't count.
    const secret = String(env.ADMIN_TOKEN || '').trim();
    let stored = '';
    try {
      stored = JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = 'admin_hash'").first())?.value || '""');
    } catch {
      stored = '';
    }
    const m = /^sha256:([0-9a-f]{16,64}):([0-9a-f]{64})$/.exec(String(stored));
    if (!secret && !m) return json({ ok: false, error: 'No admin password is set yet. Run worker\\set-admin-password.ps1 (see worker/README.md).' }, 500);
    const ip = await ipHash(req, env);
    const day = today();
    // The lock is tied to the current password, so setting a new one unlocks you.
    const failKey = `adminfail:${ip}:${(await sha(`${secret}|${stored}`)).slice(0, 8)}`;
    if ((await count(env, day, failKey)) >= 20) return json({ ok: false, error: 'Too many wrong passwords today. Set a new admin password (worker\\set-admin-password.ps1) or try again tomorrow.' }, 429);
    let token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    try {
      token = decodeURIComponent(token);
    } catch {
      /* sent as-is */
    }
    token = token.trim();
    const okHash = m && token ? safeEqual(await sha(m[1] + token), m[2]) : false;
    const okSecret = secret ? safeEqual(token, secret) : false;
    if (!okHash && !okSecret) {
      await bump(env, day, failKey).run();
      return json({ ok: false, error: 'Wrong admin password.' }, 401);
    }
    return null;
  }

  function newCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  }

  const codeRow = (c, usedToday, devices) => ({
    code: fmtCode(c.code),
    raw: c.code,
    label: c.label,
    note: c.note,
    dailyLimit: c.daily_limit,
    maxDevices: c.max_devices,
    devices,
    expiresAt: c.expires_at,
    status: c.status === 'active' && c.expires_at && c.expires_at < Date.now() ? 'expired' : c.status,
    createdAt: c.created_at,
    lastUsedAt: c.last_used_at,
    totalUses: c.total_uses,
    usedToday,
  });

  async function admin(req, env, path) {
    const denied = await adminAuth(req, env);
    if (denied) return denied;
    const method = req.method;
    const s = await getSettings(env, true);
    const day = today();

    if (path === 'login') return json({ ok: true });

    if (path === 'overview' && method === 'GET') {
      const since = daysAgo(13);
      const { results: rows } = await env.DB.prepare("SELECT day, subject, count, tokens_in, tokens_out FROM usage_daily WHERE day >= ? AND subject IN ('all','free','premium')").bind(since).all();
      const { results: errs } = await env.DB.prepare("SELECT day, COUNT(*) AS n FROM requests WHERE day >= ? AND status = 'error' GROUP BY day").bind(since).all();
      const series = [];
      for (let i = 13; i >= 0; i--) {
        const d = daysAgo(i);
        const pick = (sub) => rows.find((r) => r.day === d && r.subject === sub) || {};
        const all = pick('all');
        series.push({ day: d, requests: all.count || 0, free: pick('free').count || 0, premium: pick('premium').count || 0, tokensIn: all.tokens_in || 0, tokensOut: all.tokens_out || 0, errors: errs.find((e) => e.day === d)?.n || 0 });
      }
      const installsToday = (await env.DB.prepare("SELECT COUNT(DISTINCT install_id) AS n FROM requests WHERE day = ? AND status = 'ok'").bind(day).first())?.n || 0;
      const installs7 = (await env.DB.prepare("SELECT COUNT(DISTINCT install_id) AS n FROM requests WHERE day >= ? AND status = 'ok'").bind(daysAgo(6)).first())?.n || 0;
      const codes = await env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'active' AND (expires_at IS NULL OR expires_at > ?) THEN 1 ELSE 0 END) AS active FROM codes").bind(Date.now()).first();
      const cost = (tin, tout) => (tin * Number(s.price_in || 0) + tout * Number(s.price_out || 0)) / 1e6;
      const t = series.at(-1);
      const sum = (k, n) => series.slice(-n).reduce((a, x) => a + x[k], 0);
      return json({
        ok: true,
        today: { ...t, installs: installsToday, cost: cost(t.tokensIn, t.tokensOut) },
        week: { requests: sum('requests', 7), installs: installs7, cost: cost(sum('tokensIn', 7), sum('tokensOut', 7)) },
        month: { requests: sum('requests', 14), cost: cost(sum('tokensIn', 14), sum('tokensOut', 14)) },
        series,
        codes: { total: codes?.total || 0, active: codes?.active || 0 },
        settings: s,
        model: s.model || modelCache?.id || '(newest in your OpenAI account)',
        keySet: !!env.OPENAI_API_KEY,
      });
    }

    if (path === 'codes' && method === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM codes ORDER BY created_at DESC').all();
      const { results: used } = await env.DB.prepare("SELECT subject, count FROM usage_daily WHERE day = ? AND subject LIKE 'c:%'").bind(day).all();
      const { results: devs } = await env.DB.prepare('SELECT code, COUNT(*) AS n FROM code_devices GROUP BY code').all();
      return json({ ok: true, codes: results.map((c) => codeRow(c, used.find((u) => u.subject === `c:${c.code}`)?.count || 0, devs.find((d) => d.code === c.code)?.n || 0)) });
    }

    if (path === 'codes' && method === 'POST') {
      const b = (await readBody(req)) || {};
      const qty = Math.max(1, Math.min(200, Math.round(Number(b.quantity) || 1)));
      const daily = Math.max(1, Math.min(100000, Math.round(Number(b.dailyLimit) || s.premium_daily)));
      const devices = Math.max(1, Math.min(1000, Math.round(Number(b.maxDevices) || s.premium_devices)));
      const expires = b.expiresAt ? Number(b.expiresAt) || null : null;
      const label = String(b.label || '').slice(0, 80);
      const note = String(b.note || '').slice(0, 300);
      const made = [];
      for (let i = 0; i < qty; i++) {
        const c = newCode();
        made.push(c);
      }
      await env.DB.batch(made.map((c, i) => env.DB.prepare('INSERT INTO codes (code, label, note, daily_limit, max_devices, expires_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(c, qty > 1 ? `${label}${label ? ' ' : ''}#${i + 1}` : label, note, daily, devices, expires, 'active', Date.now())));
      return json({ ok: true, codes: made.map(fmtCode) });
    }

    const codeMatch = /^codes\/([A-Za-z0-9-]+)(\/reset-devices)?$/.exec(path);
    if (codeMatch) {
      const c = normCode(codeMatch[1]);
      const row = await env.DB.prepare('SELECT * FROM codes WHERE code = ?').bind(c).first();
      if (!row) return json({ ok: false, error: 'No such code.' }, 404);
      if (codeMatch[2] && method === 'POST') {
        await env.DB.prepare('DELETE FROM code_devices WHERE code = ?').bind(c).run();
        return json({ ok: true });
      }
      if (method === 'GET') {
        const { results } = await env.DB.prepare('SELECT install_id, added_at, last_used_at FROM code_devices WHERE code = ? ORDER BY added_at').bind(c).all();
        return json({ ok: true, devices: results.map((d) => ({ install: d.install_id.slice(0, 8), addedAt: d.added_at, lastUsedAt: d.last_used_at })) });
      }
      if (method === 'PATCH') {
        const b = (await readBody(req)) || {};
        const next = {
          label: b.label !== undefined ? String(b.label).slice(0, 80) : row.label,
          note: b.note !== undefined ? String(b.note).slice(0, 300) : row.note,
          daily_limit: b.dailyLimit !== undefined ? Math.max(1, Math.round(Number(b.dailyLimit) || 1)) : row.daily_limit,
          max_devices: b.maxDevices !== undefined ? Math.max(1, Math.round(Number(b.maxDevices) || 1)) : row.max_devices,
          expires_at: b.expiresAt !== undefined ? (b.expiresAt ? Number(b.expiresAt) : null) : row.expires_at,
          status: b.status === 'disabled' || b.status === 'active' ? b.status : row.status,
        };
        await env.DB.prepare('UPDATE codes SET label = ?, note = ?, daily_limit = ?, max_devices = ?, expires_at = ?, status = ? WHERE code = ?').bind(next.label, next.note, next.daily_limit, next.max_devices, next.expires_at, next.status, c).run();
        return json({ ok: true });
      }
      if (method === 'DELETE') {
        await env.DB.batch([env.DB.prepare('DELETE FROM codes WHERE code = ?').bind(c), env.DB.prepare('DELETE FROM code_devices WHERE code = ?').bind(c)]);
        return json({ ok: true });
      }
    }

    if (path === 'requests' && method === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 300').all();
      return json({
        ok: true,
        requests: results.map((r) => ({ at: r.at, tier: r.tier, code: r.code ? fmtCode(r.code) : '', install: (r.install_id || '').slice(0, 8), installId: r.install_id, ip: r.ip_hash, model: r.model, platform: r.platform, tokens: r.tokens_in + r.tokens_out, status: r.status, error: r.error })),
      });
    }

    if (path === 'devices' && method === 'GET') {
      const { results } = await env.DB.prepare(
        "SELECT install_id, MAX(ip_hash) AS ip, SUM(CASE WHEN day = ? THEN 1 ELSE 0 END) AS today, COUNT(*) AS week, MAX(at) AS last, MAX(tier) AS tier, MAX(code) AS code FROM requests WHERE day >= ? AND status = 'ok' GROUP BY install_id ORDER BY today DESC, week DESC LIMIT 200"
      )
        .bind(day, daysAgo(6))
        .all();
      const { results: blocks } = await env.DB.prepare('SELECT * FROM blocks ORDER BY at DESC').all();
      const isBlocked = new Set(blocks.map((x) => x.subject));
      return json({
        ok: true,
        devices: results.map((d) => ({ installId: d.install_id, install: d.install_id.slice(0, 8), ip: d.ip, today: d.today, week: d.week, last: d.last, tier: d.code ? 'premium' : 'free', code: d.code ? fmtCode(d.code) : '', blocked: isBlocked.has(`i:${d.install_id}`), ipBlocked: isBlocked.has(`ip:${d.ip}`) })),
        blocks: blocks.map((x) => ({ subject: x.subject, reason: x.reason, at: x.at })),
      });
    }

    if (path === 'blocks' && method === 'POST') {
      const b = (await readBody(req)) || {};
      if (!/^(i:[A-Za-z0-9_-]{16,64}|ip:[a-f0-9]{16})$/.test(b.subject || '')) return json({ ok: false, error: 'Bad subject.' }, 400);
      await env.DB.prepare('INSERT OR REPLACE INTO blocks (subject, reason, at) VALUES (?, ?, ?)').bind(b.subject, String(b.reason || '').slice(0, 200), Date.now()).run();
      return json({ ok: true });
    }
    const blockMatch = /^blocks\/(.+)$/.exec(path);
    if (blockMatch && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM blocks WHERE subject = ?').bind(decodeURIComponent(blockMatch[1])).run();
      return json({ ok: true });
    }

    if (path === 'settings' && method === 'GET') return json({ ok: true, settings: s, defaults: DEFAULT_SETTINGS });
    if (path === 'settings' && method === 'PUT') {
      const b = (await readBody(req)) || {};
      const writes = [];
      for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
        if (!(k in b)) continue;
        let v = b[k];
        if (NUM_KEYS.includes(k)) v = Math.max(0, Number(v) || 0);
        else if (BOOL_KEYS.includes(k)) v = !!v;
        else v = String(v ?? def).slice(0, 400);
        writes.push(env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(k, JSON.stringify(v)));
      }
      if (writes.length) await env.DB.batch(writes);
      modelCache = null;
      return json({ ok: true, settings: await getSettings(env, true) });
    }

    if (path === 'models' && method === 'GET') {
      try {
        return json({ ok: true, models: await listModels(env) });
      } catch (e) {
        return json({ ok: false, error: `Couldn’t list models with your OpenAI key (${e.message}). Check the OPENAI_API_KEY secret and your OpenAI billing.` }, 502);
      }
    }

    if (path === 'test' && method === 'POST') {
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
      if (path.startsWith('/admin/api/')) return withCors(await admin(req, env, path.slice('/admin/api/'.length)));
      if (req.method === 'POST' && path === '/v1/status') return withCors(await apiStatus(req, env));
      if (req.method === 'POST' && path === '/v1/redeem') return withCors(await apiStatus(req, env, { register: true }));
      if (req.method === 'POST' && path === '/v1/rewrite') return withCors(await apiRewrite(req, env, ctx));
      if (path === '/') return new Response('RitPost AI server is running. Admin: /admin', { headers: { 'Content-Type': 'text/plain' } });
      return withCors(json({ ok: false, error: 'Not found.' }, 404));
    } catch (e) {
      return withCors(json({ ok: false, error: 'Server error. Please try again.', detail: String(e?.message || e).slice(0, 200) }, 500));
    }
  }

  async function scheduled(_event, env) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM requests WHERE at < ?').bind(Date.now() - 90 * 86400000),
      env.DB.prepare('DELETE FROM usage_daily WHERE day < ?').bind(daysAgo(120)),
    ]);
  }

  return { fetch: handle, scheduled };
}
