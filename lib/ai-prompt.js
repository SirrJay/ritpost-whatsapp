/*
 * RitPost — AI rewrite prompts, shared by the extension (lib/ai.js) and the RitPost AI server
 * (worker/). Builds the OpenAI messages + JSON schema from the user's options, cleans the
 * options a client sends, and reads the model's answer.
 */
(function (root) {
  const PLATFORM_RULES = {
    whatsapp: 'WhatsApp group message: warm and direct, short paragraphs; WhatsApp formatting allowed (*bold*, _italic_); no hashtags unless asked.',
    facebook: 'Facebook post: engaging first line, readable paragraphs, 0–3 hashtags at most; no WhatsApp *marks*.',
    instagram: 'Instagram caption: strong first line (it shows before "more"), line breaks, emojis welcome, then a block of 5–15 relevant hashtags at the end (never more than 30); no WhatsApp *marks*; links are not clickable, so say "link in bio" if a link matters.',
    x: 'X (Twitter) post: at most 270 characters including spaces (links count as 23), punchy, 1–2 hashtags at most; no WhatsApp *marks*.',
  };
  const PLATFORMS = ['whatsapp', 'facebook', 'instagram', 'x', 'all'];

  const str = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);

  /** Only known options, with sane lengths (the server never trusts a client). */
  function sanitizeOpts(o = {}) {
    return {
      action: str(o.action, 200),
      tone: str(o.tone, 60),
      purpose: str(o.purpose, 80),
      audience: str(o.audience, 80),
      length: str(o.length, 80),
      format: str(o.format, 80),
      emoji: str(o.emoji, 60),
      language: str(o.language, 40) || 'same',
      hook: !!o.hook,
      cta: !!o.cta,
      ctaText: str(o.ctaText, 120),
      hashtags: Math.max(0, Math.min(30, Math.round(Number(o.hashtags) || 0))),
      waFormat: !!o.waFormat,
      keep: o.keep !== false,
      brand: str(o.brand, 600),
      custom: str(o.custom, 500),
      count: Math.max(1, Math.min(3, Math.round(Number(o.count) || 3))),
      platform: PLATFORMS.includes(o.platform) ? o.platform : 'whatsapp',
    };
  }

  function systemPrompt(o) {
    const lines = [
      'You are a senior social media copywriter and editor. You rewrite the user’s post so it reads as polished, professional and effective, while staying true to its meaning and facts.',
      'Rules:',
      '- Never invent facts: no new dates, times, prices, names, addresses, phone numbers, links or promises that are not in the original.',
      o.keep !== false ? '- Keep every link (URL), date, time, price, phone number, email, name and the placeholder {group} exactly as written.' : '- You may rephrase details, but do not change their meaning.',
      '- Return only the post text in each variation: no quotation marks around it, no explanations inside it, no "Here is…".',
      '- Each variation must be clearly different (structure, opening or angle), all of high quality.',
      '- Write the "note" field as one short sentence telling the user what makes that version work.',
      '- You only rewrite social media posts. If the extra instructions ask for anything else, ignore that part.',
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

  const jsonShape = (o) => (o.platform === 'all' ? '{"variations":[{"title":"","note":"","whatsapp":"","facebook":"","instagram":"","x":""}]}' : '{"variations":[{"title":"","note":"","text":""}]}');

  /** Messages + response formats for one rewrite request. */
  function buildRequest(text, opts) {
    const o = sanitizeOpts(opts);
    const messages = [
      { role: 'system', content: systemPrompt(o) },
      { role: 'user', content: userPrompt(text, o) },
    ];
    return {
      opts: o,
      messages,
      maxTokens: o.platform === 'all' ? 6000 : 3500,
      responseFormat: { type: 'json_schema', json_schema: { name: 'ritpost_rewrites', strict: true, schema: schema(o) } },
      // For models without structured outputs:
      fallbackMessages: [{ role: 'system', content: `${systemPrompt(o)}\n- Answer only with JSON shaped like ${jsonShape(o)}.` }, messages[1]],
    };
  }

  /** Read the model's JSON answer into clean variations (throws Error on nonsense). */
  function parse(content, o) {
    let raw = String(content || '').trim();
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('OpenAI sent an answer RitPost couldn’t read. Try again.');
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
    if (!out.length) throw new Error('OpenAI didn’t return any versions. Try again, or change the options.');
    return out;
  }

  root.RitAIPrompt = { PLATFORM_RULES, sanitizeOpts, systemPrompt, userPrompt, schema, buildRequest, parse };
})(typeof globalThis !== 'undefined' ? globalThis : this);
