/*
 * RitPost — page bridge (runs in the page's MAIN world)
 *
 * Content scripts can't see WhatsApp's React data, so this tiny bridge reads
 * each chat row's React props to tell groups from individual contacts and
 * writes the result to a DOM attribute: data-ritpost-kind="group|user|channel|broadcast|unknown".
 * It only reads; it never changes WhatsApp's state or sends anything.
 */
(() => {
  // Replace an older copy (e.g. after the extension was updated) instead of stacking listeners.
  if (typeof window.__ritpostBridge === 'function') {
    document.removeEventListener('ritpost:classify', window.__ritpostBridge);
  }

  const ATTR = 'data-ritpost-kind';
  const ROW_SEL = '[role="listitem"], [role="row"]';

  function widKind(id) {
    if (!id) return null;
    let s = '';
    if (typeof id === 'string') s = id;
    else if (typeof id === 'object') {
      if (typeof id._serialized === 'string') s = id._serialized;
      else if (typeof id.server === 'string') s = `${id.user || ''}@${id.server}`;
    }
    if (!s || !s.includes('@')) return null;
    if (/@g\.us$/.test(s)) return 'group';
    if (/@(c\.us|s\.whatsapp\.net|lid)$/.test(s)) return 'user';
    if (/@newsletter$/.test(s)) return 'channel';
    if (/broadcast/.test(s)) return 'broadcast';
    return null;
  }

  function inspectProps(p) {
    if (!p || typeof p !== 'object') return null;
    const candidates = [p.chat, p.contact, p.data, p.model, p.item, p.chatModel, p.conversation, p];
    for (const c of candidates) {
      if (!c || typeof c !== 'object') continue;
      try {
        const k = widKind(c.id) || widKind(c.chat && c.chat.id) || widKind(c.contact && c.contact.id) || widKind(c.wid);
        if (k) return k;
        if (c !== p && typeof c.isGroup === 'boolean') return c.isGroup ? 'group' : 'user';
      } catch {
        /* WhatsApp model getters may throw — ignore */
      }
    }
    return null;
  }

  function fiberOf(el) {
    for (const key in el) {
      if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) return el[key];
    }
    return null;
  }

  function classify(row) {
    const starts = [row.querySelector('span[title]'), row.querySelector('span[dir="auto"]'), row].filter(Boolean);
    for (const start of starts) {
      let f = fiberOf(start);
      let outside = 0;
      for (let i = 0; f && i < 60; i++, f = f.return) {
        const node = f.stateNode;
        if (node instanceof Element && node !== row && !row.contains(node)) {
          // Left the row: stop once we reach a container holding several rows.
          if (node.querySelectorAll(ROW_SEL).length > 1 || ++outside > 3) break;
        }
        const k = inspectProps(f.memoizedProps);
        if (k) return k;
      }
    }
    return 'unknown';
  }

  function classifyAll() {
    const roots = [document.getElementById('pane-side'), document.getElementById('side')].filter(Boolean);
    const seen = new Set();
    for (const root of roots) {
      for (const row of root.querySelectorAll(ROW_SEL)) {
        if (seen.has(row)) continue;
        seen.add(row);
        try {
          row.setAttribute(ATTR, classify(row));
        } catch {
          row.setAttribute(ATTR, 'unknown');
        }
      }
    }
  }

  window.__ritpostBridge = classifyAll;
  document.addEventListener('ritpost:classify', classifyAll);
})();
