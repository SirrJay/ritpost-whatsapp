/*
 * RitPost — AI writing assistant (OpenAI API, with the user's own key)
 *
 *   RitAI.listModels(key)            → chat model ids in the user's account, best first
 *   RitAI.rewrite({ key, model, text, opts, signal }) → { variations, usage, model }
 *
 * The key is kept in chrome.storage.local on this computer and sent only to api.openai.com,
 * only when the user clicks Generate (or "Check key").
 */
(() => {
  if (window.RitAI) return;
  const API = 'https://api.openai.com/v1';

  class AIError extends Error {
    constructor(message, code = '', status = 0) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }

  async function call(path, key, { method = 'GET', body, signal } = {}) {
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (e?.name === 'AbortError') throw new AIError('Stopped.', 'aborted');
      throw new AIError('Couldn’t reach OpenAI. Check your internet connection and try again.', 'network');
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
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

  // ─────────────── models ───────────────
  const NOT_CHAT = /(embed|whisper|tts|dall-e|image|audio|realtime|moderation|transcri|search|computer-use|babbage|davinci|instruct|sora|codex|vision-preview|-o?ss-)/i;
  /** Rank: newest GPT version first; plain names before dated snapshots; nano/mini after full models. */
  function rank(id) {
    const v = /^gpt-(\d+)(?:\.(\d+))?/i.exec(id);
    const o = /^o(\d+)/i.exec(id);
    let score = v ? Number(v[1]) * 100 + Number(v[2] || 0) * 10 : o ? 300 + Number(o[1]) : /^chatgpt/i.test(id) ? 50 : 0;
    if (/\d{4}-\d{2}-\d{2}|-\d{4}$/.test(id)) score -= 3; // dated snapshot
    if (/preview/i.test(id)) score -= 4;
    if (/nano/i.test(id)) score -= 6;
    else if (/mini|luna/i.test(id)) score -= 2;
    if (/^o\d/i.test(id)) score -= 150; // reasoning-only models: slower for short rewrites
    return score;
  }
  async function listModels(key) {
    const data = await call('/models', key);
    const ids = (data?.data || []).map((m) => m.id).filter((id) => /^(gpt|o\d|chatgpt)/i.test(id) && !NOT_CHAT.test(id));
    return [...new Set(ids)].sort((a, b) => rank(b) - rank(a) || a.localeCompare(b));
  }

  // ─────────────── prompt ───────────────
  const PLATFORM_RULES = {
    whatsapp: 'WhatsApp group message: warm and direct, short paragraphs; WhatsApp formatting allowed (*bold*, _italic_); no hashtags unless asked.',
    facebook: 'Facebook post: engaging first line, readable paragraphs, 0–3 hashtags at most; no WhatsApp *marks*.',
    instagram: 'Instagram caption: strong first line (it shows before "more"), line breaks, emojis welcome, then a block of 5–15 relevant hashtags at the end (never more than 30); no WhatsApp *marks*; links are not clickable, so say "link in bio" if a link matters.',
    x: 'X (Twitter) post: at most 270 characters including spaces (links count as 23), punchy, 1–2 hashtags at most; no WhatsApp *marks*.',
  };

  function systemPrompt(o) {
    const lines = [
      'You are a senior social media copywriter and editor. You rewrite the user’s post so it reads as polished, professional and effective, while staying true to its meaning and facts.',
      'Rules:',
      '- Never invent facts: no new dates, times, prices, names, addresses, phone numbers, links or promises that are not in the original.',
      o.keep !== false ? '- Keep every link (URL), date, time, price, phone number, email, name and the placeholder {group} exactly as written.' : '- You may rephrase details, but do not change their meaning.',
      '- Return only the post text in each variation: no quotation marks around it, no explanations inside it, no "Here is…".',
      '- Each variation must be clearly different (structure, opening or angle), all of high quality.',
      '- Write the "note" field as one short sentence telling the user what makes that version work.',
      o.language && o.language !== 'same' ? `- Write in ${o.language}.` : '- Write in the same language as the original.',
    ];
    if (o.brand) lines.push(`- About the sender / brand voice (follow it): ${o.brand}`);
    return lines.join('\n');
  }

  function userPrompt(text, o) {
    const want = [];
    if (o.action) want.push(`Task: ${o.action}.`);
    if (o.tone) want.push(`Tone: ${o.tone}.`);
    if (o.purpose) want.push(`This post is: ${o.purpose}.`);
    if (o.audience) want.push(`Audience: ${o.audience}.`);
    if (o.length) want.push(`Length: ${o.length}.`);
    if (o.format) want.push(`Format: ${o.format}.`);
    if (o.emoji) want.push(`Emojis: ${o.emoji}.`);
    if (o.hook) want.push('Open with a strong hook that makes people stop scrolling.');
    if (o.cta) want.push(`End with a clear call to action${o.ctaText ? ` (${o.ctaText})` : ''}.`);
    if (o.hashtags) want.push(`Add ${o.hashtags} relevant hashtags at the end.`);
    if (o.waFormat) want.push('Use WhatsApp formatting where it helps: *bold* for the key line, _italic_ sparingly.');
    if (o.platform && o.platform !== 'all' && PLATFORM_RULES[o.platform]) want.push(`Write it for ${PLATFORM_RULES[o.platform]}`);
    if (o.platform === 'all')
      want.push(
        'For each variation write four versions of the same idea, one per platform:',
        ...Object.entries(PLATFORM_RULES).map(([k, r]) => `  • ${k}: ${r}`)
      );
    if (o.custom) want.push(`Extra instructions from the user: ${o.custom}`);
    want.push(`Write ${o.count || 3} variations.`);
    return `${want.join('\n')}\n\nOriginal post:\n"""\n${text}\n"""`;
  }

  function schema(o) {
    const item =
      o.platform === 'all'
        ? {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'note', 'whatsapp', 'facebook', 'instagram', 'x'],
            properties: { title: { type: 'string' }, note: { type: 'string' }, whatsapp: { type: 'string' }, facebook: { type: 'string' }, instagram: { type: 'string' }, x: { type: 'string' } },
          }
        : { type: 'object', additionalProperties: false, required: ['title', 'note', 'text'], properties: { title: { type: 'string' }, note: { type: 'string' }, text: { type: 'string' } } };
    return { type: 'object', additionalProperties: false, required: ['variations'], properties: { variations: { type: 'array', items: item } } };
  }

  function parse(content, o) {
    let raw = String(content || '').trim();
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) throw new AIError('OpenAI sent an answer RitPost couldn’t read. Try again.', 'parse');
      data = JSON.parse(m[0]);
    }
    const list = Array.isArray(data?.variations) ? data.variations : [];
    const clean = (s) => String(s || '').replace(/^\s*["“]|["”]\s*$/g, '').trim();
    const out = list
      .map((v, i) =>
        o.platform === 'all'
          ? { title: clean(v.title) || `Option ${i + 1}`, note: clean(v.note), whatsapp: clean(v.whatsapp), facebook: clean(v.facebook), instagram: clean(v.instagram), x: clean(v.x) }
          : { title: clean(v.title) || `Option ${i + 1}`, note: clean(v.note), text: clean(v.text) }
      )
      .filter((v) => (o.platform === 'all' ? v.whatsapp || v.instagram : v.text));
    if (!out.length) throw new AIError('OpenAI didn’t return any versions. Try again, or change the options.', 'empty');
    return out;
  }

  async function rewrite({ key, model, text, opts = {}, signal }) {
    if (!key) throw new AIError('Add your OpenAI API key in Settings → AI writing assistant first.', 'nokey');
    if (!String(text || '').trim()) throw new AIError('Write something first; AI improves the text you give it.', 'notext');
    const messages = [
      { role: 'system', content: systemPrompt(opts) },
      { role: 'user', content: userPrompt(text, opts) },
    ];
    const base = { model, messages, max_completion_tokens: opts.platform === 'all' ? 6000 : 3500 };
    let data;
    try {
      data = await call('/chat/completions', key, {
        method: 'POST',
        signal,
        body: { ...base, response_format: { type: 'json_schema', json_schema: { name: 'ritpost_rewrites', strict: true, schema: schema(opts) } } },
      });
    } catch (e) {
      // Older models don't do structured outputs: ask for plain JSON instead.
      if (!(e instanceof AIError) || e.status !== 400 || !/response_format|json_schema|schema/i.test(e.message)) throw e;
      const shape = opts.platform === 'all' ? '{"variations":[{"title":"","note":"","whatsapp":"","facebook":"","instagram":"","x":""}]}' : '{"variations":[{"title":"","note":"","text":""}]}';
      messages[0] = { role: 'system', content: `${systemPrompt(opts)}\n- Answer only with JSON shaped like ${shape}.` };
      data = await call('/chat/completions', key, { method: 'POST', signal, body: { ...base, messages, response_format: { type: 'json_object' } } });
    }
    const choice = data?.choices?.[0];
    if (choice?.message?.refusal) throw new AIError(`OpenAI declined: ${choice.message.refusal}`, 'refusal');
    if (choice?.finish_reason === 'length' && !choice?.message?.content) throw new AIError('The answer was cut off. Try fewer variations or a shorter length.', 'length');
    return { variations: parse(choice?.message?.content, opts), usage: data?.usage || null, model: data?.model || model };
  }

  window.RitAI = { listModels, rewrite, rank, AIError, _prompt: { systemPrompt, userPrompt, schema, parse } };
})();
