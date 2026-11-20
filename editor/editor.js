/*
 * RitPost Studio — photo editor for attachments (opens in its own tab).
 *
 * Edits are kept as a recipe ("doc") next to the untouched original, so a photo can be
 * re-edited or reverted later. Saving renders the recipe into a JPEG that replaces the
 * attachment in chrome.storage ("attachments"); the side panel picks the change up.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const MAX_FILES = 10;
const WORK_MAX = 2560; // working copy size (long side)
const EXPORT_MAX = 2160; // saved photo size (long side)
const EMOJI_FONT = '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';

// ─────────────── presets ───────────────
const FILTERS = [
  { id: 'original', name: 'Original', css: '' },
  { id: 'vivid', name: 'Vivid', css: 'saturate(1.35) contrast(1.1)' },
  { id: 'warm', name: 'Warm', css: 'sepia(.12) saturate(1.2)', over: [['rgba(255,150,40,.16)', 'soft-light']] },
  { id: 'cool', name: 'Cool', css: 'saturate(1.05) hue-rotate(-6deg)', over: [['rgba(40,120,255,.14)', 'soft-light']] },
  { id: 'golden', name: 'Golden', css: 'sepia(.25) saturate(1.4) brightness(1.04)' },
  { id: 'bright', name: 'Bright', css: 'brightness(1.15) contrast(1.05) saturate(1.05)' },
  { id: 'dramatic', name: 'Dramatic', css: 'contrast(1.35) saturate(1.15) brightness(.92)', vig: 0.35 },
  { id: 'vintage', name: 'Vintage', css: 'sepia(.35) contrast(.95) brightness(1.05) saturate(.85)', fade: 0.12 },
  { id: 'matte', name: 'Matte', css: 'contrast(.88) brightness(1.05) saturate(.9)', fade: 0.14 },
  { id: 'rose', name: 'Rose', css: 'saturate(1.15)', over: [['rgba(255,80,140,.14)', 'soft-light']] },
  { id: 'tealorange', name: 'Teal & Orange', css: 'contrast(1.1) saturate(1.2)', over: [['rgba(0,128,128,.16)', 'soft-light'], ['rgba(255,140,0,.10)', 'overlay']] },
  { id: 'sunset', name: 'Sunset', css: 'saturate(1.25) contrast(1.05)', over: [['rgba(255,94,58,.15)', 'soft-light'], ['rgba(160,40,200,.08)', 'overlay']] },
  { id: 'fade', name: 'Fade', css: 'contrast(.85) brightness(1.08) saturate(.8)', fade: 0.1 },
  { id: 'mono', name: 'Mono', css: 'grayscale(1) contrast(1.05)' },
  { id: 'noir', name: 'Noir', css: 'grayscale(1) contrast(1.45) brightness(.9)', vig: 0.3 },
];
const FILTER_BY = Object.fromEntries(FILTERS.map((f) => [f.id, f]));

const ADJUST = [
  ['brightness', 'Brightness', -100, 100],
  ['contrast', 'Contrast', -100, 100],
  ['saturation', 'Saturation', -100, 100],
  ['warmth', 'Warmth', -100, 100],
  ['tint', 'Tint', -100, 100],
  ['fade', 'Fade', 0, 100],
  ['vignette', 'Vignette', 0, 100],
  ['blur', 'Soft focus', 0, 100],
];

const RATIOS = [
  ['free', 'Free'],
  ['original', 'Original'],
  ['1:1', '1:1', 'Square post'],
  ['4:5', '4:5', 'Portrait post'],
  ['9:16', '9:16', 'Story / Reel'],
  ['16:9', '16:9', 'Landscape / X'],
  ['1.91:1', '1.91:1', 'Wide'],
];
const ratioValue = (r, doc, img) => {
  if (r === 'free') return null;
  if (r === 'original') {
    const { RW, RH } = rotatedSize(doc, img);
    return RW / RH;
  }
  const [a, b] = r.split(':').map(Number);
  return a / b;
};

const FONTS = [
  ['classic', 'Classic', '700 {s}px "Segoe UI", Roboto, Arial, sans-serif'],
  ['strong', 'Strong', '400 {s}px Impact, "Arial Black", sans-serif'],
  ['serif', 'Elegant', 'italic 600 {s}px Georgia, "Times New Roman", serif'],
  ['type', 'Typewriter', '700 {s}px "Courier New", Courier, monospace'],
  ['script', 'Script', '400 {s}px "Segoe Script", "Brush Script MT", cursive'],
  ['round', 'Rounded', '800 {s}px "Trebuchet MS", "Segoe UI", sans-serif'],
];
const FONT_BY = Object.fromEntries(FONTS.map((f) => [f[0], f[2]]));
const TEXT_STYLES = [
  ['plain', 'Plain'],
  ['shadow', 'Shadow'],
  ['box', 'Box'],
  ['outline', 'Outline'],
  ['neon', 'Neon'],
];
const COLORS = ['#ffffff', '#111111', '#ef4444', '#f97316', '#facc15', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899', '#f5deb3', '#0e7c66'];
const BADGES = [
  ['NEW', '#ef4444'],
  ['LIVE', '#e11d48'],
  ['SALE', '#f97316'],
  ['FREE', '#16a34a'],
  ['TODAY', '#2563eb'],
  ['JOIN US', '#7c3aed'],
  ['LINK IN BIO', '#0e7c66'],
  ['SWIPE ➜', '#0f172a'],
  ['COMING SOON', '#db2777'],
  ['THANK YOU', '#ca8a04'],
  ['LIMITED', '#b91c1c'],
  ['🔥 HOT', '#ea580c'],
];
const QUICK_STICKERS = ['❤️', '🔥', '✨', '🎉', '😍', '😂', '👍', '🙏', '💯', '⭐', '🎵', '📍', '👑', '💪', '🌸', '☀️', '🎁', '✅', '👉', '😎', '🥳'];

const defaultDoc = () => ({
  rot: 0,
  flipH: false,
  flipV: false,
  crop: { x: 0, y: 0, w: 1, h: 1 },
  ratio: 'free',
  fit: null, // { ratio: '9:16', bg: 'blur' | '#hex' }
  filter: 'original',
  strength: 100,
  adj: Object.fromEntries(ADJUST.map(([k]) => [k, 0])),
  layers: [],
  strokes: [],
});

// ─────────────── state ───────────────
const S = {
  atts: [],
  cur: null,
  docs: new Map(),
  hist: new Map(), // id -> { undo: [], redo: [], base }
  imgs: new Map(), // id -> working HTMLImageElement/canvas
  saved: new Map(), // id -> doc JSON at last save
  tool: 'filters',
  sel: -1,
  comparing: false,
  textDefaults: { font: 'classic', style: 'shadow', color: '#ffffff', align: 'center' },
  brush: { color: '#ffffff', size: 8, kind: 'pen' },
};
const doc = () => S.docs.get(S.cur);
const img = () => S.imgs.get(S.cur);
const curAtt = () => S.atts.find((a) => a.id === S.cur);

let toastTimer;
function toast(text, err = false) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('error', err);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.filter((x) => x !== null && x !== undefined && x !== false));
  return el;
}

const loadImage = (src) =>
  new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('This photo could not be opened.'));
    i.src = src;
  });

/** A working copy no larger than WORK_MAX, so sliders stay smooth. */
async function workingCopy(src) {
  const i = await loadImage(src);
  const s = Math.min(1, WORK_MAX / Math.max(i.naturalWidth, i.naturalHeight));
  if (s >= 1) return i;
  const c = document.createElement('canvas');
  c.width = Math.round(i.naturalWidth * s);
  c.height = Math.round(i.naturalHeight * s);
  c.getContext('2d').drawImage(i, 0, 0, c.width, c.height);
  return c;
}
const iw = (i) => i.naturalWidth || i.width;
const ih = (i) => i.naturalHeight || i.height;

// ─────────────── geometry ───────────────
function rotatedSize(d, i) {
  const swap = d.rot % 180 !== 0;
  return { RW: swap ? ih(i) : iw(i), RH: swap ? iw(i) : ih(i) };
}
/** Output size (before scaling) and where the photo sits in it. */
function layout(d, i, { ignoreCrop = false } = {}) {
  const { RW, RH } = rotatedSize(d, i);
  const c = ignoreCrop ? { x: 0, y: 0, w: 1, h: 1 } : d.crop;
  const cw = c.w * RW;
  const ch = c.h * RH;
  let W = cw;
  let H = ch;
  let content = { x: 0, y: 0, w: cw, h: ch };
  if (d.fit && !ignoreCrop) {
    const r = ratioValue(d.fit.ratio, d, i) || cw / ch;
    if (cw / ch > r) H = cw / r;
    else W = ch * r;
    content = { x: (W - cw) / 2, y: (H - ch) / 2, w: cw, h: ch };
  }
  return { RW, RH, crop: c, W, H, content };
}

/** Draw the rotated/flipped photo's crop region into dest rect (dx,dy,dw,dh). */
function drawPhoto(ctx, d, i, crop, dx, dy, dw, dh) {
  const { RW, RH } = rotatedSize(d, i);
  const cx = crop.x * RW;
  const cy = crop.y * RH;
  const cw = crop.w * RW;
  const ch = crop.h * RH;
  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, dy, dw, dh);
  ctx.clip();
  const sx = dw / cw;
  const sy = dh / ch;
  ctx.translate(dx - cx * sx, dy - cy * sy);
  ctx.scale(sx, sy);
  ctx.translate(RW / 2, RH / 2);
  ctx.rotate((d.rot * Math.PI) / 180);
  ctx.scale(d.flipH ? -1 : 1, d.flipV ? -1 : 1);
  ctx.drawImage(i, -iw(i) / 2, -ih(i) / 2, iw(i), ih(i));
  ctx.restore();
}

function adjustCss(a, W) {
  const parts = [];
  if (a.brightness) parts.push(`brightness(${1 + a.brightness / 160})`);
  if (a.contrast) parts.push(`contrast(${1 + a.contrast / 160})`);
  if (a.saturation) parts.push(`saturate(${Math.max(0, 1 + a.saturation / 100)})`);
  if (a.tint) parts.push(`hue-rotate(${a.tint * 0.3}deg)`);
  if (a.blur) parts.push(`blur(${((a.blur / 100) * W) / 250}px)`);
  return parts.join(' ');
}

/**
 * Render a doc into ctx at size W×H (same aspect as layout().W/H).
 * opts: { photoOnly, noLayers, ignoreCrop }
 */
function render(ctx, d, i, W, H, opts = {}) {
  const L = layout(d, i, { ignoreCrop: opts.ignoreCrop });
  const k = W / L.W;
  const box = { x: L.content.x * k, y: L.content.y * k, w: L.content.w * k, h: L.content.h * k };
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  // Background for "fit".
  if (d.fit && !opts.ignoreCrop) {
    if (d.fit.bg === 'blur') {
      const s = Math.max(W / box.w, H / box.h);
      ctx.filter = `blur(${Math.round(W / 28)}px) brightness(.75) saturate(1.2)`;
      const bw = box.w * s * 1.1;
      const bh = box.h * s * 1.1;
      drawPhoto(ctx, d, i, L.crop, (W - bw) / 2, (H - bh) / 2, bw, bh);
      ctx.filter = 'none';
    } else {
      ctx.fillStyle = d.fit.bg || '#ffffff';
      ctx.fillRect(0, 0, W, H);
    }
  }
  const f = opts.original ? FILTER_BY.original : FILTER_BY[d.filter] || FILTER_BY.original;
  const a = opts.original ? defaultDoc().adj : d.adj;
  const adj = adjustCss(a, W);
  const strength = f.id === 'original' ? 0 : (d.strength ?? 100) / 100;
  // Photo: adjustments, then the filter blended in at its strength.
  ctx.filter = adj || 'none';
  drawPhoto(ctx, d, i, L.crop, box.x, box.y, box.w, box.h);
  if (strength > 0) {
    ctx.globalAlpha = strength;
    ctx.filter = `${adj} ${f.css}`.trim() || 'none';
    drawPhoto(ctx, d, i, L.crop, box.x, box.y, box.w, box.h);
    ctx.globalAlpha = 1;
  }
  ctx.filter = 'none';
  // Overlays inside the photo area.
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.clip();
  const overlay = (color, op, alpha = 1) => {
    ctx.globalCompositeOperation = op;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  };
  if (strength > 0) (f.over || []).forEach(([c, op]) => overlay(c, op, strength));
  if (a.warmth > 0) overlay(`rgba(255,140,30,${(a.warmth / 100) * 0.3})`, 'soft-light');
  if (a.warmth < 0) overlay(`rgba(30,120,255,${(-a.warmth / 100) * 0.3})`, 'soft-light');
  const fade = (a.fade / 100) * 0.35 + (strength > 0 ? (f.fade || 0) * strength : 0);
  if (fade > 0) overlay(`rgba(255,255,255,${fade})`, 'source-over');
  const vig = (a.vignette / 100) * 0.75 + (strength > 0 ? (f.vig || 0) * strength : 0);
  if (vig > 0) {
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const r = Math.hypot(box.w, box.h) / 2;
    const g = ctx.createRadialGradient(cx, cy, r * 0.45, cx, cy, r);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${Math.min(0.9, vig)})`);
    ctx.fillStyle = g;
    ctx.fillRect(box.x, box.y, box.w, box.h);
  }
  ctx.restore();
  if (!opts.photoOnly) {
    drawStrokes(ctx, d.strokes, W, H);
    if (!opts.noLayers) d.layers.forEach((l) => drawLayer(ctx, l, W, H));
  }
  ctx.restore();
}

function drawStrokes(ctx, strokes, W, H) {
  for (const s of strokes) {
    if (!s.points.length) continue;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = (s.size / 1000) * W * (s.kind === 'marker' ? 2.2 : 1);
    ctx.strokeStyle = s.color;
    if (s.kind === 'marker') ctx.globalAlpha = 0.45;
    if (s.kind === 'neon') {
      ctx.shadowColor = s.color;
      ctx.shadowBlur = ctx.lineWidth * 2.5;
      ctx.strokeStyle = '#ffffff';
    }
    ctx.beginPath();
    s.points.forEach(([x, y], n) => (n ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)));
    if (s.points.length === 1) ctx.lineTo(s.points[0][0] * W + 0.01, s.points[0][1] * H);
    ctx.stroke();
    ctx.restore();
  }
}

const luminance = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return 1;
  const n = parseInt(m[1], 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};

/** Measure a layer (in output px for width W); returns { w, h, lines, px, lineH }. */
const measureCtx = document.createElement('canvas').getContext('2d');
function layerMetrics(l, W, ctx = measureCtx) {
  const px = Math.max(4, l.size * W);
  if (l.type === 'emoji') {
    ctx.font = `${px}px ${EMOJI_FONT}`;
    return { w: px * 1.2, h: px * 1.2, px, lines: [l.text], lineH: px };
  }
  if (l.type === 'badge') {
    ctx.font = `800 ${px}px "Segoe UI", Roboto, Arial, sans-serif`;
    const tw = ctx.measureText(l.text).width;
    return { w: tw + px * 1.6, h: px * 2, px, lines: [l.text], lineH: px };
  }
  ctx.font = (FONT_BY[l.font] || FONT_BY.classic).replace('{s}', px);
  const lines = String(l.text || ' ').split('\n');
  const widths = lines.map((t) => ctx.measureText(t || ' ').width);
  const lineH = px * 1.22;
  const padX = l.style === 'box' ? px * 0.5 : px * 0.15;
  const padY = l.style === 'box' ? px * 0.3 : px * 0.1;
  return { w: Math.max(...widths) + padX * 2, h: lines.length * lineH + padY * 2, px, lines, widths, lineH, padX, padY };
}

function drawLayer(ctx, l, W, H) {
  const m = layerMetrics(l, W, ctx);
  ctx.save();
  ctx.translate(l.x * W, l.y * H);
  ctx.rotate(l.rot || 0);
  ctx.textBaseline = 'middle';
  if (l.type === 'emoji') {
    ctx.font = `${m.px}px ${EMOJI_FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(l.text, 0, m.px * 0.06);
  } else if (l.type === 'badge') {
    ctx.fillStyle = l.color;
    ctx.shadowColor = 'rgba(0,0,0,.3)';
    ctx.shadowBlur = m.px * 0.4;
    ctx.shadowOffsetY = m.px * 0.12;
    ctx.beginPath();
    ctx.roundRect(-m.w / 2, -m.h / 2, m.w, m.h, m.h / 2);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 ${m.px}px "Segoe UI", Roboto, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(l.text, 0, m.px * 0.05);
  } else {
    ctx.font = (FONT_BY[l.font] || FONT_BY.classic).replace('{s}', m.px);
    const align = l.align || 'center';
    ctx.textAlign = align;
    const left = -m.w / 2 + m.padX;
    const xFor = () => (align === 'left' ? left : align === 'right' ? m.w / 2 - m.padX : 0);
    if (l.style === 'box') {
      ctx.fillStyle = l.color;
      ctx.beginPath();
      ctx.roundRect(-m.w / 2, -m.h / 2, m.w, m.h, m.px * 0.35);
      ctx.fill();
    }
    const top = -m.h / 2 + m.padY + m.lineH / 2;
    m.lines.forEach((t, n) => {
      const y = top + n * m.lineH;
      ctx.save();
      if (l.style === 'shadow') {
        ctx.shadowColor = 'rgba(0,0,0,.65)';
        ctx.shadowBlur = m.px * 0.25;
        ctx.shadowOffsetY = m.px * 0.06;
      }
      if (l.style === 'outline') {
        ctx.lineWidth = m.px * 0.14;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = luminance(l.color) > 0.5 ? '#000000' : '#ffffff';
        ctx.strokeText(t, xFor(), y);
      }
      if (l.style === 'neon') {
        ctx.shadowColor = l.color;
        ctx.shadowBlur = m.px * 0.6;
        ctx.fillStyle = l.color;
        ctx.fillText(t, xFor(), y);
        ctx.shadowBlur = m.px * 0.2;
        ctx.fillStyle = '#ffffff';
      } else ctx.fillStyle = l.style === 'box' ? (luminance(l.color) > 0.6 ? '#111111' : '#ffffff') : l.color;
      ctx.fillText(t, xFor(), y);
      ctx.restore();
    });
  }
  ctx.restore();
}

// ─────────────── display ───────────────
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
let view = { W: 0, H: 0, dpr: 1, cropMode: false };

function draw() {
  const d = doc();
  const i = img();
  if (!d || !i) return;
  const stage = $('stage').getBoundingClientRect();
  const cropMode = S.tool === 'crop';
  const L = layout(d, i, { ignoreCrop: cropMode });
  const scale = Math.min((stage.width - 40) / L.W, (stage.height - 40) / L.H, 4);
  const W = Math.max(1, Math.round(L.W * scale));
  const H = Math.max(1, Math.round(L.H * scale));
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (cropMode) {
    const tmp = { ...d, fit: null };
    render(ctx, tmp, i, W, H, { ignoreCrop: true, photoOnly: true, original: S.comparing });
  } else if (S.comparing) render(ctx, { ...defaultDoc(), rot: d.rot, flipH: d.flipH, flipV: d.flipV, crop: d.crop }, i, W, H);
  else render(ctx, d, i, W, H);
  view = { W, H, dpr, cropMode };
  $('sizeInfo').textContent = `${Math.round(layout(d, i).W * exportScale(d, i))} × ${Math.round(layout(d, i).H * exportScale(d, i))} px`;
  placeCropBox();
  placeSelBox();
  renderUndo();
  renderDirty();
}
/** Saved photos are at most EXPORT_MAX on the long side, and small ones are brought up to 1080. */
const exportScale = (d, i) => {
  const L = layout(d, i);
  return Math.min(EXPORT_MAX / Math.max(L.W, L.H), Math.max(1, 1080 / Math.min(L.W, L.H)));
};
const canvasOffset = () => {
  const c = canvas.getBoundingClientRect();
  const s = $('stage').getBoundingClientRect();
  return { left: c.left - s.left, top: c.top - s.top, rect: c };
};

// ─────────────── history ───────────────
function hist() {
  if (!S.hist.has(S.cur)) S.hist.set(S.cur, { undo: [], redo: [], base: JSON.stringify(doc()) });
  return S.hist.get(S.cur);
}
function commit() {
  const H = hist();
  const now = JSON.stringify(doc());
  if (now === H.base) return;
  H.undo.push(H.base);
  if (H.undo.length > 80) H.undo.shift();
  H.base = now;
  H.redo = [];
  renderUndo();
  renderDirty();
}
function undo() {
  commit();
  const H = hist();
  if (!H.undo.length) return;
  H.redo.push(H.base);
  H.base = H.undo.pop();
  S.docs.set(S.cur, JSON.parse(H.base));
  S.sel = -1;
  renderTool();
  draw();
}
function redo() {
  const H = hist();
  if (!H.redo.length) return;
  H.undo.push(H.base);
  H.base = H.redo.pop();
  S.docs.set(S.cur, JSON.parse(H.base));
  S.sel = -1;
  renderTool();
  draw();
}
function renderUndo() {
  const H = S.cur ? hist() : null;
  $('undoBtn').disabled = !H || (!H.undo.length && JSON.stringify(doc()) === H.base);
  $('redoBtn').disabled = !H || !H.redo.length;
}
const isDirty = (id) => S.docs.has(id) && JSON.stringify(S.docs.get(id)) !== S.saved.get(id);
function renderDirty() {
  document.querySelectorAll('#thumbs li').forEach((li) => li.classList.toggle('dirty', isDirty(li.dataset.id)));
  const d = isDirty(S.cur);
  $('saveState').textContent = !S.cur ? '' : d ? 'Unsaved changes' : curAtt()?.edit ? 'Saved' : '';
  $('saveBtn').disabled = !S.cur || !img();
}

// ─────────────── crop box ───────────────
function placeCropBox() {
  const box = $('cropBox');
  if (!view.cropMode || !doc()) return (box.hidden = true);
  const { left, top } = canvasOffset();
  const c = doc().crop;
  box.hidden = false;
  box.style.left = `${left + c.x * view.W}px`;
  box.style.top = `${top + c.y * view.H}px`;
  box.style.width = `${c.w * view.W}px`;
  box.style.height = `${c.h * view.H}px`;
}

/** Biggest centred crop with this aspect (in rotated photo pixels). */
function cropForRatio(d, i, r) {
  const { RW, RH } = rotatedSize(d, i);
  if (!r) return { x: 0, y: 0, w: 1, h: 1 };
  let w = RW;
  let hh = RW / r;
  if (hh > RH) {
    hh = RH;
    w = RH * r;
  }
  return { x: (RW - w) / 2 / RW, y: (RH - hh) / 2 / RH, w: w / RW, h: hh / RH };
}

function bindCrop() {
  const box = $('cropBox');
  let drag = null;
  box.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    box.setPointerCapture(e.pointerId);
    drag = { mode: e.target.dataset.h || 'move', x: e.clientX, y: e.clientY, start: { ...doc().crop } };
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const d = doc();
    const i = img();
    const dx = (e.clientX - drag.x) / view.W;
    const dy = (e.clientY - drag.y) / view.H;
    const s = drag.start;
    let c = { ...s };
    const min = 0.05;
    if (drag.mode === 'move') {
      c.x = Math.min(1 - s.w, Math.max(0, s.x + dx));
      c.y = Math.min(1 - s.h, Math.max(0, s.y + dy));
    } else {
      const west = drag.mode.includes('w');
      const north = drag.mode.includes('n');
      let x1 = s.x;
      let y1 = s.y;
      let x2 = s.x + s.w;
      let y2 = s.y + s.h;
      if (west) x1 = Math.min(x2 - min, Math.max(0, s.x + dx));
      else x2 = Math.max(x1 + min, Math.min(1, s.x + s.w + dx));
      if (north) y1 = Math.min(y2 - min, Math.max(0, s.y + dy));
      else y2 = Math.max(y1 + min, Math.min(1, s.y + s.h + dy));
      c = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      const r = ratioValue(d.ratio, d, i);
      if (r) {
        // Keep the aspect: width (in rotated px) decides the height.
        const { RW, RH } = rotatedSize(d, i);
        let wpx = c.w * RW;
        let hpx = wpx / r;
        const maxH = (north ? s.y + s.h : 1 - s.y) * RH;
        if (hpx > maxH) {
          hpx = maxH;
          wpx = hpx * r;
        }
        c.w = wpx / RW;
        c.h = hpx / RH;
        if (west) c.x = s.x + s.w - c.w;
        if (north) c.y = s.y + s.h - c.h;
      }
    }
    d.crop = c;
    placeCropBox();
    $('sizeInfo').textContent = `${Math.round(layout(d, i).W)} × ${Math.round(layout(d, i).H)} px (crop)`;
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    commit();
    renderDirty();
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
}

// ─────────────── layers: select, move, scale/rotate ───────────────
function placeSelBox() {
  const box = $('selBox');
  const d = doc();
  const l = d?.layers[S.sel];
  if (!l || view.cropMode || S.comparing) return (box.hidden = true);
  const m = layerMetrics(l, view.W);
  const { left, top } = canvasOffset();
  box.hidden = false;
  box.style.width = `${m.w + 12}px`;
  box.style.height = `${m.h + 12}px`;
  box.style.left = `${left + l.x * view.W - (m.w + 12) / 2}px`;
  box.style.top = `${top + l.y * view.H - (m.h + 12) / 2}px`;
  box.style.transform = `rotate(${l.rot || 0}rad)`;
}

function hitLayer(px, py) {
  const d = doc();
  for (let n = d.layers.length - 1; n >= 0; n--) {
    const l = d.layers[n];
    const m = layerMetrics(l, view.W);
    const dx = px - l.x * view.W;
    const dy = py - l.y * view.H;
    const r = -(l.rot || 0);
    const lx = dx * Math.cos(r) - dy * Math.sin(r);
    const ly = dx * Math.sin(r) + dy * Math.cos(r);
    if (Math.abs(lx) <= m.w / 2 + 6 && Math.abs(ly) <= m.h / 2 + 6) return n;
  }
  return -1;
}

function selectLayer(n) {
  S.sel = n;
  const l = doc()?.layers[n];
  if (l && S.tool !== (l.type === 'text' ? 'text' : 'stickers')) {
    S.tool = l.type === 'text' ? 'text' : 'stickers';
    renderTabs();
  }
  renderTool();
  placeSelBox();
}

function bindLayers() {
  const box = $('selBox');
  let drag = null;
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  // Click on the canvas: pick a layer, or draw.
  canvas.addEventListener('pointerdown', (e) => {
    if (!doc() || view.cropMode) return;
    const p = local(e);
    if (S.tool === 'draw') {
      canvas.setPointerCapture(e.pointerId);
      const s = { color: S.brush.color, size: S.brush.size, kind: S.brush.kind, points: [[p.x / view.W, p.y / view.H]] };
      doc().strokes.push(s);
      drag = { mode: 'draw', s };
      draw();
      return;
    }
    const n = hitLayer(p.x, p.y);
    if (n >= 0) {
      selectLayer(n);
      canvas.setPointerCapture(e.pointerId);
      const l = doc().layers[n];
      drag = { mode: 'move', x: e.clientX, y: e.clientY, sx: l.x, sy: l.y };
    } else if (S.sel >= 0) {
      S.sel = -1;
      renderTool();
      placeSelBox();
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.mode === 'draw') {
      const p = local(e);
      drag.s.points.push([Math.min(1, Math.max(0, p.x / view.W)), Math.min(1, Math.max(0, p.y / view.H))]);
      draw();
    } else moveDrag(e);
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    commit();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('dblclick', (e) => {
    const p = local(e);
    const n = hitLayer(p.x, p.y);
    if (n >= 0 && doc().layers[n].type === 'text') {
      selectLayer(n);
      setTimeout(() => document.querySelector('.tool-body textarea.txt')?.focus(), 30);
    }
  });

  function moveDrag(e) {
    const l = doc().layers[S.sel];
    if (!l) return;
    if (drag.mode === 'move') {
      l.x = Math.min(1.1, Math.max(-0.1, drag.sx + (e.clientX - drag.x) / view.W));
      l.y = Math.min(1.1, Math.max(-0.1, drag.sy + (e.clientY - drag.y) / view.H));
    } else if (drag.mode === 'rot') {
      const r = canvas.getBoundingClientRect();
      const cx = r.left + l.x * view.W;
      const cy = r.top + l.y * view.H;
      const dist = Math.hypot(e.clientX - cx, e.clientY - cy);
      l.size = Math.min(0.6, Math.max(0.012, drag.size * (dist / drag.dist)));
      let rot = drag.rot + Math.atan2(e.clientY - cy, e.clientX - cx) - drag.ang;
      // Snap to straight when close.
      const snap = Math.round(rot / (Math.PI / 4)) * (Math.PI / 4);
      if (Math.abs(rot - snap) < 0.06) rot = snap;
      l.rot = rot;
    }
    draw();
  }
  box.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    box.setPointerCapture(e.pointerId);
    const l = doc().layers[S.sel];
    if (!l) return;
    if (e.target.classList.contains('sel-rot')) {
      const r = canvas.getBoundingClientRect();
      const cx = r.left + l.x * view.W;
      const cy = r.top + l.y * view.H;
      drag = { mode: 'rot', size: l.size, rot: l.rot || 0, dist: Math.max(1, Math.hypot(e.clientX - cx, e.clientY - cy)), ang: Math.atan2(e.clientY - cy, e.clientX - cx) };
    } else drag = { mode: 'move', x: e.clientX, y: e.clientY, sx: l.x, sy: l.y };
  });
  box.addEventListener('pointermove', (e) => drag && drag.mode !== 'draw' && moveDrag(e));
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
  box.addEventListener('dblclick', () => {
    if (doc().layers[S.sel]?.type === 'text') document.querySelector('.tool-body textarea.txt')?.focus();
  });
  box.querySelector('.sel-del').addEventListener('click', deleteLayer);
  box.querySelector('.sel-dup').addEventListener('click', duplicateLayer);
}

function addLayer(l) {
  const d = doc();
  if (!d) return;
  d.layers.push({ x: 0.5, y: 0.5, rot: 0, ...l });
  S.sel = d.layers.length - 1;
  commit();
  renderTool();
  draw();
}
function deleteLayer() {
  const d = doc();
  if (!d || S.sel < 0) return;
  d.layers.splice(S.sel, 1);
  S.sel = -1;
  commit();
  renderTool();
  draw();
}
function duplicateLayer() {
  const d = doc();
  const l = d?.layers[S.sel];
  if (!l) return;
  d.layers.push({ ...l, x: Math.min(0.95, l.x + 0.04), y: Math.min(0.95, l.y + 0.04) });
  S.sel = d.layers.length - 1;
  commit();
  renderTool();
  draw();
}
function moveLayerOrder(dir) {
  const d = doc();
  const n = S.sel;
  const m = n + dir;
  if (n < 0 || m < 0 || m >= d.layers.length) return;
  [d.layers[n], d.layers[m]] = [d.layers[m], d.layers[n]];
  S.sel = m;
  commit();
  renderTool();
  draw();
}

// ─────────────── tool panels ───────────────
function renderTabs() {
  document.querySelectorAll('.tool-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tool === S.tool));
  $('stage').classList.toggle('draw', S.tool === 'draw');
}
function setTool(t) {
  commit();
  if (S.tool === t) return;
  S.tool = t;
  if (t !== 'text' && t !== 'stickers') S.sel = -1;
  if (t === 'text' || t === 'stickers') {
    const l = doc()?.layers[S.sel];
    if (l && (l.type === 'text') !== (t === 'text')) S.sel = -1;
  }
  renderTabs();
  renderTool();
  draw();
}

const sec = (label, ...kids) => h('div', { class: 'sec' }, label ? h('div', { class: 'lbl' }, ...(Array.isArray(label) ? label : [label])) : null, ...kids);
const chip = (label, on, onclick, small) => h('button', { type: 'button', class: on ? 'on' : '', onclick }, label, small ? h('small', {}, small) : null);

function slider({ label, min, max, value, step = 1, onInput, fmt = (v) => (v > 0 ? `+${v}` : String(v)), reset = 0 }) {
  const out = h('output', { title: 'Double-click to reset' }, fmt(value));
  const input = h('input', { type: 'range', min, max, step, value });
  input.addEventListener('input', () => {
    out.textContent = fmt(Number(input.value));
    onInput(Number(input.value));
    draw();
  });
  input.addEventListener('change', commit);
  const resetIt = () => {
    input.value = reset;
    out.textContent = fmt(reset);
    onInput(reset);
    commit();
    draw();
  };
  out.addEventListener('dblclick', resetIt);
  input.addEventListener('dblclick', resetIt);
  return h('div', { class: 'slider' }, h('label', {}, label), out, input);
}

function colorRow(current, onPick) {
  const custom = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(current) ? current : '#ffffff', title: 'Any colour' });
  custom.addEventListener('input', () => onPick(custom.value, false));
  custom.addEventListener('change', () => onPick(custom.value, true));
  return h(
    'div',
    { class: 'colors' },
    ...COLORS.map((c) => h('button', { type: 'button', class: c.toLowerCase() === String(current).toLowerCase() ? 'on' : '', style: `background:${c}`, title: c, onclick: () => onPick(c, true) })),
    custom
  );
}

function renderTool() {
  const body = $('toolBody');
  const d = doc();
  if (!d || !img()) {
    body.replaceChildren(h('p', { class: 'note' }, curAtt() && !curAtt().type.startsWith('image/') ? 'Only photos can be edited. Videos and documents are posted as they are.' : 'Pick a photo on the left.'));
    return;
  }
  const panels = { crop: cropPanel, filters: filtersPanel, adjust: adjustPanel, text: textPanel, stickers: stickersPanel, draw: drawPanel };
  body.replaceChildren(...panels[S.tool](d));
}

function cropPanel(d) {
  const i = img();
  const fitOn = !!d.fit;
  return [
    sec(
      'Aspect ratio',
      h(
        'div',
        { class: 'chips' },
        ...RATIOS.map(([id, label, sub]) =>
          chip(label, d.ratio === id, () => {
            d.ratio = id;
            d.crop = cropForRatio(d, i, ratioValue(id, d, i));
            commit();
            renderTool();
            draw();
          }, sub)
        )
      ),
      h('p', { class: 'note' }, 'Drag the frame or its corners on the photo. Instagram posts look best at 4:5 or 1:1, Stories at 9:16, X at 16:9.')
    ),
    sec(
      'Rotate and flip',
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'button', class: 'tbtn', onclick: () => rotate(-90) }, '⟲ Left'),
        h('button', { type: 'button', class: 'tbtn', onclick: () => rotate(90) }, '⟳ Right'),
        h('button', { type: 'button', class: 'tbtn', onclick: () => ((d.flipH = !d.flipH), commit(), draw()) }, '⇋ Flip'),
        h('button', { type: 'button', class: 'tbtn', onclick: () => ((d.flipV = !d.flipV), commit(), draw()) }, '⇵ Flip')
      )
    ),
    sec(
      ['Fit the whole photo instead', h('span', { class: 'muted', style: 'text-transform:none;letter-spacing:0;font-weight:400' }, fitOn ? 'On' : 'Off')],
      h('p', { class: 'note' }, 'Keeps everything in the picture and fills the space around it, so nothing gets cut off.'),
      h(
        'div',
        { class: 'chips' },
        chip('Off', !fitOn, () => ((d.fit = null), commit(), renderTool(), draw())),
        ...[
          ['1:1', 'Square'],
          ['4:5', 'Portrait'],
          ['9:16', 'Story'],
          ['16:9', 'Landscape'],
        ].map(([r, sub]) => chip(r, fitOn && d.fit.ratio === r, () => ((d.fit = { ratio: r, bg: d.fit?.bg || 'blur' }), commit(), renderTool(), draw()), sub))
      ),
      fitOn
        ? h(
            'div',
            { class: 'colors' },
            h('button', { type: 'button', class: `tbtn ${d.fit.bg === 'blur' ? 'accent' : ''}`, style: 'width:auto;height:28px;border-radius:999px', onclick: () => ((d.fit.bg = 'blur'), commit(), renderTool(), draw()) }, 'Blurred photo'),
            ...['#ffffff', '#000000', '#0e7c66', '#f5deb3', '#1e293b'].map((c) => h('button', { type: 'button', class: d.fit.bg === c ? 'on' : '', style: `background:${c}`, title: c, onclick: () => ((d.fit.bg = c), commit(), renderTool(), draw()) })),
            (() => {
              const ci = h('input', { type: 'color', value: /^#/.test(d.fit.bg) ? d.fit.bg : '#ffffff' });
              ci.addEventListener('input', () => ((d.fit.bg = ci.value), draw()));
              ci.addEventListener('change', commit);
              return ci;
            })()
          )
        : null
    ),
    h('p', { class: 'note' }, 'Tip: one click on “Story” above with “Blurred photo” turns any picture into a full-screen 9:16 Story.'),
  ];
}

function rotate(deg) {
  const d = doc();
  d.rot = (((d.rot + deg) % 360) + 360) % 360;
  d.crop = cropForRatio(d, img(), ratioValue(d.ratio, d, img()));
  commit();
  draw();
}

function filtersPanel(d) {
  const grid = h('div', { class: 'filters' });
  const i = img();
  // Small previews of each filter on this photo.
  const thumbDoc = { ...d, layers: [], strokes: [], adj: d.adj, fit: null, strength: 100 };
  const L = layout(thumbDoc, i);
  const s = 120 / Math.min(L.W, L.H);
  const tmp = document.createElement('canvas');
  tmp.width = Math.max(1, Math.round(L.W * s));
  tmp.height = Math.max(1, Math.round(L.H * s));
  for (const f of FILTERS) {
    // Square, centre-cropped previews (like a phone gallery).
    render(tmp.getContext('2d'), { ...thumbDoc, filter: f.id }, i, tmp.width, tmp.height, { photoOnly: true });
    const c = h('canvas', { width: 120, height: 120 });
    c.getContext('2d').drawImage(tmp, (tmp.width - 120) / 2, (tmp.height - 120) / 2);
    grid.append(
      h(
        'button',
        {
          type: 'button',
          class: d.filter === f.id ? 'on' : '',
          onclick: () => {
            if (d.filter === f.id && f.id !== 'original') return;
            d.filter = f.id;
            d.strength = 100;
            commit();
            renderTool();
            draw();
          },
        },
        c,
        h('span', {}, f.name)
      )
    );
  }
  return [
    sec('Filters', grid),
    d.filter !== 'original'
      ? sec(null, slider({ label: `${FILTER_BY[d.filter].name} strength`, min: 0, max: 100, value: d.strength ?? 100, fmt: (v) => `${v}%`, reset: 100, onInput: (v) => (d.strength = v) }))
      : null,
  ].filter(Boolean);
}

function adjustPanel(d) {
  return [
    sec(
      ['Adjust', h('button', { type: 'button', class: 'tbtn', style: 'padding:3px 8px', onclick: () => ((d.adj = defaultDoc().adj), commit(), renderTool(), draw()) }, 'Reset')],
      ...ADJUST.map(([k, label, min, max]) =>
        slider({ label, min, max, value: d.adj[k] || 0, fmt: min === 0 ? (v) => String(v) : undefined, onInput: (v) => (d.adj[k] = v) })
      )
    ),
    h('p', { class: 'note' }, 'Double-click a slider to reset it. Hold “Hold to compare” at the top to see the original.'),
  ];
}

function layerList(d, types) {
  const items = d.layers.map((l, n) => ({ l, n })).filter(({ l }) => types.includes(l.type));
  if (!items.length) return null;
  return sec(
    'On this photo',
    h(
      'ul',
      { class: 'layer-list' },
      ...items
        .reverse()
        .map(({ l, n }) =>
          h(
            'li',
            { class: n === S.sel ? 'on' : '', onclick: () => selectLayer(n) },
            h('span', {}, l.type === 'text' ? `“${l.text.split('\n')[0]}”` : l.type === 'badge' ? `Label: ${l.text}` : `Sticker ${l.text}`),
            h('button', { type: 'button', class: 'tbtn', style: 'padding:2px 7px', title: 'Delete', onclick: (e) => (e.stopPropagation(), (S.sel = n), deleteLayer()) }, '✕')
          )
        )
    )
  );
}

function textPanel(d) {
  const sel = d.layers[S.sel]?.type === 'text' ? d.layers[S.sel] : null;
  const t = sel || S.textDefaults;
  const apply = (patch, save = true) => {
    Object.assign(S.textDefaults, patch);
    if (sel) Object.assign(sel, patch);
    if (save) commit();
    draw();
  };
  const ta = h('textarea', { class: 'txt', placeholder: 'Type your text…', maxlength: 300 });
  ta.value = sel ? sel.text : '';
  ta.addEventListener('input', () => {
    if (sel) {
      sel.text = ta.value || ' ';
      draw();
    }
  });
  ta.addEventListener('change', commit);
  const emojiBtn = h('button', { type: 'button', class: 'tbtn', title: 'Add an emoji to the text' }, '😊 Emoji');
  window.RitEmoji?.attach(emojiBtn, { target: ta, align: 'left' });
  return [
    sec(
      sel ? 'Edit text' : 'Add text',
      ta,
      h(
        'div',
        { class: 'row' },
        sel
          ? h('button', { type: 'button', class: 'tbtn', onclick: () => ((S.sel = -1), renderTool(), placeSelBox()) }, '+ New text')
          : h('button', {
              type: 'button',
              class: 'tbtn accent',
              onclick: () => {
                const text = ta.value.trim() || 'Your text';
                addLayer({ type: 'text', text, size: 0.075, font: S.textDefaults.font, style: S.textDefaults.style, color: S.textDefaults.color, align: S.textDefaults.align });
              },
            }, 'Add to photo'),
        emojiBtn
      )
    ),
    sec('Font', h('div', { class: 'chips' }, ...FONTS.map(([id, name]) => chip(name, t.font === id, () => (apply({ font: id }), renderTool()))))),
    sec('Style', h('div', { class: 'chips' }, ...TEXT_STYLES.map(([id, name]) => chip(name, t.style === id, () => (apply({ style: id }), renderTool()))))),
    sec('Colour', colorRow(t.color, (c, save) => (apply({ color: c }, save), save && renderTool()))),
    sec(
      'Align',
      h(
        'div',
        { class: 'seg' },
        ...[
          ['left', 'Left'],
          ['center', 'Centre'],
          ['right', 'Right'],
        ].map(([a, n]) => h('button', { type: 'button', class: (t.align || 'center') === a ? 'on' : '', onclick: () => (apply({ align: a }), renderTool()) }, n))
      )
    ),
    sel
      ? sec(
          null,
          slider({ label: 'Size', min: 2, max: 40, value: Math.round(sel.size * 100), fmt: (v) => String(v), reset: 8, onInput: (v) => (sel.size = v / 100) }),
          h(
            'div',
            { class: 'row' },
            h('button', { type: 'button', class: 'tbtn', onclick: () => ((sel.x = 0.5), commit(), draw()) }, 'Centre'),
            h('button', { type: 'button', class: 'tbtn', onclick: () => ((sel.rot = 0), commit(), draw()) }, 'Straighten'),
            h('button', { type: 'button', class: 'tbtn', onclick: () => moveLayerOrder(1) }, 'Bring forward'),
            h('button', { type: 'button', class: 'tbtn', onclick: duplicateLayer }, 'Duplicate')
          )
        )
      : null,
    layerList(d, ['text']),
    h('p', { class: 'note' }, 'Drag text on the photo to move it; use the green handle to resize and rotate. Double-click text to edit it.'),
  ].filter(Boolean);
}

function stickersPanel(d) {
  const sel = d.layers[S.sel] && d.layers[S.sel].type !== 'text' ? d.layers[S.sel] : null;
  const more = h('button', { type: 'button', class: 'tbtn accent' }, 'All emoji…');
  window.RitEmoji?.attach(more, { onPick: (e) => addLayer({ type: 'emoji', text: e, size: 0.16 }), align: 'left' });
  return [
    sec(
      ['Emoji stickers', more],
      h('div', { class: 'emoji-grid' }, ...QUICK_STICKERS.map((e) => h('button', { type: 'button', title: 'Add sticker', onclick: () => addLayer({ type: 'emoji', text: e, size: 0.16 }) }, e)))
    ),
    sec(
      'Labels',
      h('div', { class: 'badges' }, ...BADGES.map(([t, c]) => h('button', { type: 'button', style: `background:${c}`, onclick: () => addLayer({ type: 'badge', text: t, color: c, size: 0.045 }) }, t))),
      (() => {
        const inp = h('input', { type: 'text', placeholder: 'Your own label', maxlength: 24, style: 'height:32px;border:1px solid var(--line);border-radius:9px;background:var(--surface);padding:0 10px;flex:1;min-width:0' });
        const add = () => {
          const t = inp.value.trim().toUpperCase();
          if (t) addLayer({ type: 'badge', text: t, color: '#0e7c66', size: 0.045 });
          inp.value = '';
        };
        inp.addEventListener('keydown', (e) => e.key === 'Enter' && add());
        return h('div', { class: 'row', style: 'flex-wrap:nowrap' }, inp, h('button', { type: 'button', class: 'tbtn', style: 'flex:none', onclick: add }, 'Add'));
      })()
    ),
    sel
      ? sec(
          'Selected sticker',
          slider({ label: 'Size', min: 2, max: 60, value: Math.round(sel.size * 100), fmt: (v) => String(v), reset: sel.type === 'badge' ? 5 : 16, onInput: (v) => (sel.size = v / 100) }),
          sel.type === 'badge' ? colorRow(sel.color, (c, save) => ((sel.color = c), save && commit(), draw(), save && renderTool())) : null,
          h(
            'div',
            { class: 'row' },
            h('button', { type: 'button', class: 'tbtn', onclick: () => ((sel.rot = 0), commit(), draw()) }, 'Straighten'),
            h('button', { type: 'button', class: 'tbtn', onclick: () => moveLayerOrder(1) }, 'Bring forward'),
            h('button', { type: 'button', class: 'tbtn', onclick: duplicateLayer }, 'Duplicate'),
            h('button', { type: 'button', class: 'tbtn', onclick: deleteLayer }, 'Delete')
          )
        )
      : null,
    layerList(d, ['emoji', 'badge']),
  ].filter(Boolean);
}

function drawPanel(d) {
  return [
    sec(
      'Brush',
      h(
        'div',
        { class: 'seg' },
        ...[
          ['pen', 'Pen'],
          ['marker', 'Highlighter'],
          ['neon', 'Neon'],
        ].map(([k, n]) => h('button', { type: 'button', class: S.brush.kind === k ? 'on' : '', onclick: () => ((S.brush.kind = k), renderTool()) }, n))
      ),
      colorRow(S.brush.color, (c, save) => ((S.brush.color = c), save && renderTool())),
      slider({ label: 'Size', min: 2, max: 40, value: S.brush.size, fmt: (v) => String(v), reset: 8, onInput: (v) => (S.brush.size = v) })
    ),
    sec(
      null,
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'button', class: 'tbtn', disabled: !d.strokes.length, onclick: () => (d.strokes.pop(), commit(), renderTool(), draw()) }, 'Remove last line'),
        h('button', { type: 'button', class: 'tbtn', disabled: !d.strokes.length, onclick: () => ((d.strokes = []), commit(), renderTool(), draw()) }, 'Clear drawing')
      ),
      h('p', { class: 'note' }, 'Draw on the photo with your mouse or pen.')
    ),
  ];
}

// ─────────────── attachments strip ───────────────
async function readAtts() {
  const { attachments } = await chrome.storage.local.get('attachments');
  return Array.isArray(attachments) ? attachments.filter((a) => a?.id && a?.data) : [];
}

function renderThumbs() {
  const ol = $('thumbs');
  ol.replaceChildren(
    ...S.atts.map((a) => {
      const isImg = a.type.startsWith('image/');
      const isVid = a.type.startsWith('video/');
      const li = h(
        'li',
        { 'data-id': a.id, class: a.id === S.cur ? 'on' : '', draggable: 'true', title: a.name },
        isImg ? h('img', { src: a.data, alt: '' }) : isVid ? h('video', { src: a.data, muted: true, preload: 'metadata' }) : h('div', { class: 'doc' }, (a.name.split('.').pop() || 'FILE').toUpperCase().slice(0, 4)),
        a.edit ? h('span', { class: 'tag' }, 'Edited') : !isImg ? h('span', { class: 'tag' }, isVid ? 'Video' : 'File') : null
      );
      li.addEventListener('click', () => openAtt(a.id));
      li.addEventListener('dragstart', (e) => {
        li.classList.add('drag');
        e.dataTransfer.setData('text/x-ritpost', a.id);
        e.dataTransfer.effectAllowed = 'move';
      });
      li.addEventListener('dragend', () => li.classList.remove('drag'));
      li.addEventListener('dragover', (e) => {
        if (![...e.dataTransfer.types].includes('text/x-ritpost')) return;
        e.preventDefault();
        li.classList.add('over');
      });
      li.addEventListener('dragleave', () => li.classList.remove('over'));
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        li.classList.remove('over');
        const from = e.dataTransfer.getData('text/x-ritpost');
        if (from && from !== a.id) reorder(from, a.id);
      });
      return li;
    })
  );
  $('stripHint').textContent = S.atts.length > 1 ? 'drag to reorder · this is the post order' : '';
  renderDirty();
}

async function reorder(fromId, toId) {
  const list = await readAtts();
  const from = list.findIndex((a) => a.id === fromId);
  const to = list.findIndex((a) => a.id === toId);
  if (from < 0 || to < 0) return;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
  await chrome.storage.local.set({ attachments: list });
  S.atts = list;
  renderThumbs();
  toast('Order changed');
}

async function openAtt(id) {
  if (S.cur && S.cur !== id) commit();
  const a = S.atts.find((x) => x.id === id);
  if (!a) return;
  S.cur = id;
  S.sel = -1;
  renderThumbs();
  $('videoNote').hidden = true;
  $('empty').hidden = true;
  canvas.hidden = false;
  if (!a.type.startsWith('image/')) {
    canvas.hidden = true;
    const vn = $('videoNote');
    vn.hidden = false;
    vn.replaceChildren(
      a.type.startsWith('video/') ? h('video', { src: a.data, controls: true }) : null,
      h('p', {}, h('b', {}, a.name)),
      h('p', { class: 'muted' }, a.type.startsWith('video/') ? 'Videos are posted as they are. On Instagram a video becomes a Reel.' : 'Documents can’t be edited, and are only sent to WhatsApp.')
    );
    renderTool();
    renderDirty();
    $('sizeInfo').textContent = '';
    return;
  }
  if (!S.imgs.has(id)) {
    try {
      S.imgs.set(id, await workingCopy(a.original || a.data));
    } catch (e) {
      toast(e.message, true);
      return;
    }
    const d = a.edit && a.original ? { ...defaultDoc(), ...a.edit } : defaultDoc();
    S.docs.set(id, d);
    S.saved.set(id, JSON.stringify(d));
  }
  if (S.cur !== id) return;
  hist();
  renderTool();
  draw();
}

// ─────────────── save ───────────────
function exportBlob(d, i) {
  const L = layout(d, i);
  const s = exportScale(d, i);
  const W = Math.round(L.W * s);
  const H = Math.round(L.H * s);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, W, H);
  render(x, d, i, W, H);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
}
const blobToDataURL = (b) =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });

async function save({ asCopy = false } = {}) {
  commit();
  const a = curAtt();
  const d = doc();
  const i = img();
  if (!a || !d || !i) return;
  $('saveBtn').disabled = true;
  try {
    const blob = await exportBlob(d, i);
    if (!blob) throw new Error('The photo could not be saved.');
    if (blob.size > 16 * 1024 * 1024) throw new Error('The edited photo is larger than 16 MB.');
    const data = await blobToDataURL(blob);
    const list = await readAtts();
    const idx = list.findIndex((x) => x.id === a.id);
    if (idx < 0) throw new Error('This attachment was removed in RitPost meanwhile.');
    const base = (a.originalName || a.name).replace(/\.[^.]+$/, '');
    const isPlain = JSON.stringify(d) === JSON.stringify(defaultDoc());
    if (asCopy) {
      if (list.length >= MAX_FILES) throw new Error(`Only ${MAX_FILES} files can be attached. Remove one first.`);
      const copy = { id: Math.random().toString(36).slice(2, 9) + Date.now().toString(36), name: `${base}-edit.jpg`, type: 'image/jpeg', size: blob.size, data, original: list[idx].original || list[idx].data, originalName: list[idx].originalName || list[idx].name, originalType: list[idx].originalType || list[idx].type, edit: d };
      list.splice(idx + 1, 0, copy);
      await chrome.storage.local.set({ attachments: list });
      S.atts = list;
      S.imgs.set(copy.id, i);
      S.docs.set(copy.id, JSON.parse(JSON.stringify(d)));
      S.saved.set(copy.id, JSON.stringify(d));
      // The original keeps its last saved state.
      S.docs.set(a.id, JSON.parse(S.saved.get(a.id)));
      S.hist.delete(a.id);
      S.cur = copy.id;
      renderThumbs();
      renderTool();
      draw();
      toast('Saved as a new attachment');
      return;
    }
    const cur = list[idx];
    if (isPlain && cur.original) {
      // Back to the untouched original.
      list[idx] = { id: cur.id, name: cur.originalName || cur.name, type: cur.originalType || cur.type, size: Math.round(((cur.original.length - cur.original.indexOf(',') - 1) * 3) / 4), data: cur.original };
    } else {
      list[idx] = {
        ...cur,
        name: `${base}.jpg`,
        type: 'image/jpeg',
        size: blob.size,
        data,
        original: cur.original || cur.data,
        originalName: cur.originalName || cur.name,
        originalType: cur.originalType || cur.type,
        edit: d,
      };
    }
    await chrome.storage.local.set({ attachments: list });
    S.atts = list;
    S.saved.set(a.id, JSON.stringify(d));
    renderThumbs();
    toast(isPlain && cur.original ? 'Back to the original photo' : 'Saved. RitPost will post the edited photo.');
  } catch (e) {
    toast(e?.message || String(e), true);
  } finally {
    renderDirty();
  }
}

// ─────────────── wiring ───────────────
function bind() {
  document.querySelectorAll('.tool-tabs button').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('undoBtn').addEventListener('click', undo);
  $('redoBtn').addEventListener('click', redo);
  $('saveBtn').addEventListener('click', () => save());
  $('copyBtn').addEventListener('click', () => save({ asCopy: true }));
  $('resetBtn').addEventListener('click', () => {
    if (!doc()) return;
    commit();
    S.docs.set(S.cur, defaultDoc());
    S.sel = -1;
    commit();
    renderTool();
    draw();
    toast('All edits removed. Save to keep the original.');
  });
  const cmp = $('compareBtn');
  const on = () => {
    if (!doc()) return;
    S.comparing = true;
    draw();
  };
  const off = () => {
    if (!S.comparing) return;
    S.comparing = false;
    draw();
  };
  cmp.addEventListener('pointerdown', on);
  cmp.addEventListener('pointerup', off);
  cmp.addEventListener('pointerleave', off);
  cmp.addEventListener('keydown', (e) => e.key === ' ' && on());
  cmp.addEventListener('keyup', off);

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !typing) {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (k === 'y' && !typing) {
        e.preventDefault();
        redo();
      } else if (k === 's') {
        e.preventDefault();
        save();
      }
      return;
    }
    if (typing) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel >= 0) {
      e.preventDefault();
      deleteLayer();
    } else if (e.key === 'Escape' && S.sel >= 0) {
      S.sel = -1;
      renderTool();
      placeSelBox();
    } else if (S.sel >= 0 && /^Arrow/.test(e.key)) {
      const l = doc().layers[S.sel];
      const step = e.shiftKey ? 0.02 : 0.004;
      if (e.key === 'ArrowLeft') l.x -= step;
      if (e.key === 'ArrowRight') l.x += step;
      if (e.key === 'ArrowUp') l.y -= step;
      if (e.key === 'ArrowDown') l.y += step;
      e.preventDefault();
      draw();
      clearTimeout(bind.t);
      bind.t = setTimeout(commit, 400);
    }
  });
  new ResizeObserver(() => draw()).observe($('stage'));
  window.addEventListener('beforeunload', (e) => {
    commit();
    if ([...S.docs.keys()].some(isDirty)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  // Attachments changed in the side panel (added, removed, replaced).
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !changes.attachments) return;
    const list = (changes.attachments.newValue || []).filter((a) => a?.id && a?.data);
    const sig = (l) => l.map((a) => `${a.id}:${a.size}`).join('|');
    if (sig(list) === sig(S.atts)) return;
    S.atts = list;
    for (const id of [...S.imgs.keys()]) {
      const a = list.find((x) => x.id === id);
      if (!a) {
        S.imgs.delete(id);
        S.docs.delete(id);
        S.hist.delete(id);
      }
    }
    renderThumbs();
    if (!list.some((a) => a.id === S.cur)) {
      S.cur = null;
      start();
    }
  });
  bindCrop();
  bindLayers();
}

async function start() {
  S.atts = await readAtts();
  renderThumbs();
  const want = new URLSearchParams(location.search).get('id');
  const first = S.atts.find((a) => a.id === want) || S.atts.find((a) => a.type.startsWith('image/')) || S.atts[0];
  if (!first) {
    $('empty').hidden = false;
    canvas.hidden = true;
    renderTool();
    renderDirty();
    return;
  }
  await openAtt(first.id);
}

try {
  if (new URLSearchParams(location.search).get('theme') === 'light' || matchMedia('(prefers-color-scheme: light)').matches) document.documentElement.dataset.theme = 'light';
} catch {
  /* keep dark */
}
renderTabs();
bind();
start();

// For tests.
window.__studio = { S, render, layout, defaultDoc, save, exportBlob };
