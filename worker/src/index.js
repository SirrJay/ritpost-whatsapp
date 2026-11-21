// Cloudflare Worker entry: the shared prompt code + the admin page + the app.
import '../../lib/ai-prompt.js';
import adminHtml from './admin.html';
import { createApp } from './app.js';

const app = createApp({ adminHtml });

export default {
  fetch: (req, env, ctx) => app.fetch(req, env, ctx),
  scheduled: (event, env, ctx) => ctx.waitUntil(app.scheduled(event, env)),
};
