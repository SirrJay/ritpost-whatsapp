/*
 * RitPost — AI writing assistant and plan client.
 *
 * Everything goes through the RitPost server (worker/, address in lib/config.js). It holds the
 * OpenAI key, knows the user's plan (free, or premium with an access code) and counts usage.
 * Prompts come from lib/ai-prompt.js, which the server uses too.
 */
(() => {
  if (window.RitAI) return;
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

  async function serverCall(path, body, signal) {
    const base = server();
    if (!base) throw new AIError('This copy of RitPost isn’t connected to a RitPost server.', 'noserver');
    let res;
    try {
      res = await fetch(`${base}${path}`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      if (e?.name === 'AbortError') throw new AIError('Stopped.', 'aborted');
      throw new AIError('Couldn’t reach RitPost. Check your internet connection and try again.', 'network');
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
    if (!res.ok || data?.ok === false) {
      throw new AIError(data?.error || `RitPost returned an error (${res.status}).`, data?.code || '', res.status, { plan: data?.plan || null, info: data || null });
    }
    return data;
  }

  const status = ({ installId, code }) => serverCall('/v1/status', { installId, code: code || '' });
  const redeem = ({ installId, code }) => serverCall('/v1/redeem', { installId, code });

  /** Rewrite through RitPost AI. Returns { variations, usage, model, via, plan }. */
  async function rewrite({ text, opts = {}, signal, installId, code }) {
    if (!String(text || '').trim()) throw new AIError('Write something first; AI improves the text you give it.', 'notext');
    const data = await serverCall('/v1/rewrite', { installId, code: code || '', text, opts: P().sanitizeOpts(opts) }, signal);
    return { variations: data.variations, usage: data.usage || null, model: data.model, via: 'ritpost', plan: data.plan || null };
  }

  window.RitAI = { rewrite, status, redeem, hasServer: () => !!server(), AIError };
})();
