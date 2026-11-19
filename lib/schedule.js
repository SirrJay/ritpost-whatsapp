/*
 * RitPost — schedule rules, shared by the side panel and the background worker.
 * A repeat rule is { type: 'once' | 'daily' | 'weekdays' | 'weekly', time: 'HH:MM', days: [0-6] } (0 = Sunday).
 */
(function (g) {
  'use strict';
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const parseTime = (t) => {
    const [h, m] = String(t || '09:00').split(':').map(Number);
    return [Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 0];
  };

  /** First time (ms) strictly after `after` that matches a repeating rule; null for 'once' or no match. */
  function nextOccurrence(repeat, after) {
    const r = repeat || { type: 'once' };
    if (r.type === 'once') return null;
    const [hh, mm] = parseTime(r.time);
    const d = new Date(after);
    for (let i = 0; i < 400; i++) {
      const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, hh, mm, 0, 0);
      if (c.getTime() <= after) continue;
      const day = c.getDay();
      if (r.type === 'daily') return c.getTime();
      if (r.type === 'weekdays' && day >= 1 && day <= 5) return c.getTime();
      if (r.type === 'weekly' && (r.days || []).includes(day)) return c.getTime();
    }
    return null;
  }

  const timeLabel = (t) => {
    const [h, m] = parseTime(t);
    return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };

  function describeRepeat(repeat) {
    const r = repeat || { type: 'once' };
    const at = timeLabel(r.time);
    if (r.type === 'daily') return `Every day at ${at}`;
    if (r.type === 'weekdays') return `Weekdays (Mon–Fri) at ${at}`;
    if (r.type === 'weekly') {
      const days = [...(r.days || [])].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAYS[d]);
      return days.length === 7 ? `Every day at ${at}` : `Every ${days.join(', ')} at ${at}`;
    }
    return 'Once';
  }

  /** "Fri 21 Nov, 9:00 AM" */
  function formatWhen(ms) {
    return new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  }

  /** "in 2 h 5 min", "in 3 days", "5 min ago" */
  function relative(ms, now = Date.now()) {
    const diff = ms - now;
    const abs = Math.abs(diff);
    const min = Math.round(abs / 60000);
    let s;
    if (min < 1) s = 'less than a minute';
    else if (min < 60) s = `${min} min`;
    else if (min < 60 * 24) {
      const h = Math.floor(min / 60);
      const m = min % 60;
      s = m ? `${h} h ${m} min` : `${h} h`;
    } else {
      const days = Math.round(min / (60 * 24));
      s = `${days} day${days === 1 ? '' : 's'}`;
    }
    return diff >= 0 ? `in ${s}` : `${s} ago`;
  }

  g.RitSchedule = { DAYS, nextOccurrence, describeRepeat, formatWhen, relative, timeLabel };
})(typeof self !== 'undefined' ? self : window);
