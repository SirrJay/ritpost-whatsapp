/*
 * RitPost — Instagram phone layout for the Story window (runs in the page, at document_start).
 *
 * Instagram only offers "Add to your story" in its phone layout. RitPost opens Stories in a
 * small window marked with #ritpost-story (remembered in sessionStorage for that window only)
 * and makes the page look like a phone browser there. Ordinary Instagram tabs are untouched.
 */
(() => {
  try {
    const KEY = 'ritpost-mobile';
    if (location.hash.includes('ritpost-story')) sessionStorage.setItem(KEY, '1');
    if (sessionStorage.getItem(KEY) !== '1') return;
    const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
    const def = (obj, prop, value) => {
      try {
        Object.defineProperty(obj, prop, { get: () => value, configurable: true });
      } catch {
        /* ignore */
      }
    };
    def(Navigator.prototype, 'userAgent', UA);
    def(Navigator.prototype, 'appVersion', UA.replace(/^Mozilla\//, ''));
    def(Navigator.prototype, 'platform', 'Linux armv8l');
    def(Navigator.prototype, 'maxTouchPoints', 5);
    if (navigator.userAgentData) {
      const data = {
        brands: navigator.userAgentData.brands,
        mobile: true,
        platform: 'Android',
        getHighEntropyValues: async () => ({ mobile: true, platform: 'Android', platformVersion: '14.0.0', model: 'Pixel 8', brands: navigator.userAgentData.brands }),
        toJSON() {
          return { brands: this.brands, mobile: true, platform: 'Android' };
        },
      };
      def(Navigator.prototype, 'userAgentData', data);
    }
    if (!('ontouchstart' in window)) window.ontouchstart = null;
    const mm = window.matchMedia.bind(window);
    window.matchMedia = (q) => {
      if (/pointer:\s*coarse|hover:\s*none/.test(q)) return { matches: true, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false };
      if (/pointer:\s*fine|hover:\s*hover/.test(q)) return { matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false };
      return mm(q);
    };
  } catch {
    /* never break Instagram */
  }
})();
