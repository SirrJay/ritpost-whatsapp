/*
 * RitPost — publisher settings.
 *
 * aiServer: the address of your RitPost AI server (the Cloudflare Worker in worker/), e.g.
 *   'https://ritpost-ai.your-name.workers.dev'. Leave it empty to offer only "use your own
 *   OpenAI key". See worker/README.md.
 */
window.RITPOST_CONFIG = {
  aiServer: '',
};
