/*
 * RitPost — AI writing assistant client.
 *
 * Two ways to reach OpenAI:
 *  1. RitPost AI (included): the publisher's server (worker/, URL in lib/config.js) holds the
 *     OpenAI key. Free daily rewrites for everyone; more with a premium access code.
 *  2. The user's own OpenAI API key (Settings), sent straight to api.openai.com.
 *
 * Prompts come from lib/ai-prompt.js, which the server uses too.
 */
(() => {
  if (window.RitAI) return;
  const API = 'https://api.openai.com/v1';
  const P = () => window.RitAIPrompt;
  const server = () => String(window.RITPOST_CONFIG?.aiServer || '').replace(/\/+$/, '');

  class AIError extends Error {
    constructor(message, code = '', status = 0, extra = {}) {
      super(message);
      this.code = code;
      this.status = status;
      Object.assign(this, extra);
    }
  }

  async function fetchJson(url, init, label) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      if (e?.name === 'AbortError') throw new AIError('Stopped.', 'aborted');
      throw new AIError(`Couldn’t reach ${label}. Check your internet connection and try again.`, 'network');
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
    return { res, data };
  }

  // ─────────────── 1. RitPost AI server ───────────────
  async function serverCall(path, body, signal) {
    const base = server();
    if (!base) throw new AIError('RitPost AI isn’t set up in this version. Add your own OpenAI key in Settings.', 'noserver');
    const { res, data } = await fetchJson(`${base}${path}`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 'RitPost AI');
    if (!res.ok || data?.ok === false) {
      throw new AIError(data?.error || `RitPost AI returned an error (${res.status}).`, data?.code || '', res.status, { plan: data?.plan || null });
    }
    return data;
  }
  const status = ({ installId, code }) => serverCall('/v1/status', { installId, code: code || '' });
  const redeem = ({ installId, code }) => serverCall('/v1/redeem', { installId, code });

  // ─────────────── 2. The user's own key ───────────────
  async function call(path, key, { method = 'GET', body, signal } = {}) {
    const { res, data } = await fetchJson(`${API}${path}`, { method, signal, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }, 'OpenAI');
    if (!res.ok) {
      const err = data?.error || {};
      const code = err.code || err.type || '';
      let msg = err.message || `OpenAI returned an error (${res.status}).`;
      if (res.status === 401) msg = 'OpenAI didn’t accept this API key. Check it in Settings → AI writing assistant.';
      else if (code === 'insufficient_quota') msg = 'Your OpenAI account has no credit left. Add billing at platform.openai.com, then try again.';
      else if (res.status === 429) msg = 'OpenAI is limiting requests right now (rate limit). Wait a moment and try again.';
      else if (res.status === 404 || code === 'model_not_found') msg = 'That model isn’t available in your OpenAI account. Pick another in Settings → AI writing assistant.';
      else if (res.status >= 500) msg = 'OpenAI is having trouble right now. Try again in a minute.';
      throw new AIError(msg, code, res.status);
    }
    return data;
  }

  const NOT_CHAT = /(embed|whisper|tts|dall-e|image|audio|realtime|moderation|transcri|search|computer-use|babbage|davinci|instruct|sora|codex|vision-preview|-o?ss-)/i;
  /** Rank: newest GPT version first; plain names before dated snapshots; nano/mini after full models. */
  function rank(id) {
    const v = /^gpt-(\d+)(?:\.(\d+))?/i.exec(id);
    const o = /^o(\d+)/i.exec(id);
    let score = v ? Number(v[1]) * 100 + Number(v[2] || 0) * 10 : o ? 300 + Number(o[1]) : /^chatgpt/i.test(id) ? 50 : 0;
    if (/\d{4}-\d{2}-\d{2}|-\d{4}$/.test(id)) score -= 3;
    if (/preview/i.test(id)) score -= 4;
    if (/nano/i.test(id)) score -= 6;
    else if (/mini|luna/i.test(id)) score -= 2;
    if (/^o\d/i.test(id)) score -= 150;
    return score;
  }
  const chatModels = (ids) => [...new Set(ids.filter((id) => /^(gpt|o\d|chatgpt)/i.test(id) && !NOT_CHAT.test(id)))].sort((a, b) => rank(b) - rank(a) || a.localeCompare(b));
  async function listModels(key) {
    const data = await call('/models', key);
    return chatModels((data?.data || []).map((m) => m.id));
  }

  async function rewriteDirect({ key, model, text, opts, signal }) {
    const req = P().buildRequest(text, opts);
    const base = { model, messages: req.messages, max_completion_tokens: req.maxTokens };
    let data;
    try {
      data = await call('/chat/completions', key, { method: 'POST', signal, body: { ...base, response_format: req.responseFormat } });
    } catch (e) {
      // Older models don't do structured outputs: ask for plain JSON instead.
      if (!(e instanceof AIError) || e.status !== 400 || !/response_format|json_schema|schema/i.test(e.message)) throw e;
      data = await call('/chat/completions', key, { method: 'POST', signal, body: { ...base, messages: req.fallbackMessages, response_format: { type: 'json_object' } } });
    }
    const choice = data?.choices?.[0];
    if (choice?.message?.refusal) throw new AIError(`OpenAI declined: ${choice.message.refusal}`, 'refusal');
    if (choice?.finish_reason === 'length' && !choice?.message?.content) throw new AIError('The answer was cut off. Try fewer variations or a shorter length.', 'length');
    let variations;
    try {
      variations = P().parse(choice?.message?.content, req.opts);
    } catch (e) {
      throw new AIError(e.message, 'parse');
    }
    return { variations, usage: data?.usage || null, model: data?.model || model, via: 'key' };
  }

  /**
   * Rewrite with the user's own key if there is one, otherwise through RitPost AI.
   * Returns { variations, usage, model, via, plan? }.
   */
  async function rewrite({ key, model, text, opts = {}, signal, installId, code }) {
    if (!String(text || '').trim()) throw new AIError('Write something first; AI improves the text you give it.', 'notext');
    if (key) return rewriteDirect({ key, model, text, opts, signal });
    if (!server()) throw new AIError('Add your OpenAI API key in Settings → AI writing assistant first.', 'nokey');
    const data = await serverCall('/v1/rewrite', { installId, code: code || '', text, opts: P().sanitizeOpts(opts) }, signal);
    return { variations: data.variations, usage: data.usage || null, model: data.model, via: 'ritpost', plan: data.plan || null };
  }

  window.RitAI = { listModels, rewrite, status, redeem, rank, chatModels, hasServer: () => !!server(), AIError };
})();
