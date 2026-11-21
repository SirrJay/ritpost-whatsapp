/*
 * RitPost — publisher settings (used by the side panel and the background worker).
 *
 * aiServer: the address of your RitPost server (the Cloudflare Worker in worker/), e.g.
 *   'https://ritpost-ai.your-name.workers.dev'. It runs RitPost AI, plans, access codes and
 *   posting limits. See worker/README.md.
 */
self.RITPOST_CONFIG = {
  aiServer: 'https://ritpost-ai.sirrjohn9.workers.dev',
};
