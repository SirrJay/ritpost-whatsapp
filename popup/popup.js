/* RitPost — popup */
'use strict';

const DEFAULT_SETTINGS = { delayMs: 2000, mode: 'manual', intervalSec: 6, randomize: true, autoAck: false };
const clampInterval = (v) => Math.min(600, Math.max(5, Math.round(Number(v) || 6)));
const AVATAR_COLORS = ['#0e7c66', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#0891b2', '#4d7c0f', '#9333ea'];
const CHECK_SVG = '<svg viewBox="0 0 12 12"><path d="M4.6 8.6 2.3 6.3l-.9.9 3.2 3.2 6-6-.9-.9z"/></svg>';
const PENCIL_SVG = '<svg viewBox="0 0 20 20"><path d="M13.6 2.9a1.8 1.8 0 0 1 2.5 0l1 1a1.8 1.8 0 0 1 0 2.5L7.4 16.1 3 17l.9-4.4 9.7-9.7Zm1.4 1.1-1 1 1 1 1-1-1-1Zm-2 2L5.2 13.4l-.4 1.8 1.8-.4L14 7l-1-1Z"/></svg>';
const FAILED = new Set(['notfound', 'failed', 'readonly']);
const MAX_FILES = 10;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

const state = {
  groups: [],
  selected: new Set(),
  message: '',
  settings: { ...DEFAULT_SETTINGS },
  templates: [],
  lists: [],
  attachments: [],
  lastRun: null,
  filter: '',
  manageFilter: '',
  editingId: null,
  preview: false,
  status: { open: false },
};

const $ = (id) => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
const normName = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const keyOf = (s) => normName(s).toLowerCase();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let WINDOW_ID = null;
function bg(type, payload = {}) {
  return chrome.runtime
    .sendMessage({ type, payload: { ...payload, windowId: WINDOW_ID } })
    .catch((e) => ({ ok: false, error: e.message }));
}

// ─────────────── storage ───────────────
async function load() {
  const d = await chrome.storage.local.get(['groups', 'selected', 'message', 'settings', 'lastRun', 'templates', 'lists', 'attachments']);
  state.groups = Array.isArray(d.groups) ? d.groups : [];
  const ids = new Set(state.groups.map((g) => g.id));
  state.selected = new Set((d.selected || []).filter((id) => ids.has(id)));
  state.message = d.message || '';
  state.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
  state.lastRun = d.lastRun || null;
  state.templates = Array.isArray(d.templates) ? d.templates : [];
  state.lists = Array.isArray(d.lists) ? d.lists : [];
  state.attachments = Array.isArray(d.attachments) ? d.attachments.filter((a) => a?.id && a?.data) : [];
}

const saveGroups = () => chrome.storage.local.set({ groups: state.groups, selected: [...state.selected], lists: state.lists });
const saveSelected = () => chrome.storage.local.set({ selected: [...state.selected] });
const saveTemplates = () => chrome.storage.local.set({ templates: state.templates });
const saveLists = () => chrome.storage.local.set({ lists: state.lists });

let msgTimer;
function saveMessageSoon() {
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => chrome.storage.local.set({ message: state.message }), 250);
}

// ─────────────── UI helpers ───────────────
let toastTimer;
function toast(text, isError = false) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

function avatar(name) {
  const clean = name.replace(/[^\p{L}\p{N}\s]/gu, '').trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  const initials = ((parts[0]?.[0] || [...name][0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  const el = h('span', { class: 'avatar' }, initials);
  el.style.background = AVATAR_COLORS[hash % AVATAR_COLORS.length];
  return el;
}

function checkRow(name, checked, onChange, extra) {
  const input = h('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h(
    'li',
    {},
    h('label', { class: 'pick' }, input, h('span', { class: 'check', html: CHECK_SVG }), avatar(name), h('span', { class: 'name', title: name }, name), extra)
  );
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.id !== `tab-${name}`));
  closeMenu();
}

/** Group names that failed in the last session. */
function failedNames() {
  const r = state.lastRun;
  if (!r?.results) return new Set();
  return new Set(r.results.filter((x) => FAILED.has(x.status)).map((x) => keyOf(x.name)));
}

// ─────────────── dialog ───────────────
let dialogConfirm = null;
function openDialog({ title, body, confirmText = 'Save', onConfirm, hideConfirm = false }) {
  $('modalTitle').textContent = title;
  $('modalBody').replaceChildren(...(Array.isArray(body) ? body : [body]));
  const btn = $('modalConfirm');
  btn.textContent = confirmText;
  btn.hidden = hideConfirm;
  btn.disabled = false;
  dialogConfirm = onConfirm;
  $('modal').hidden = false;
  closeMenu();
  return {
    setConfirm(enabled, text) {
      btn.disabled = !enabled;
      if (text) btn.textContent = text;
    },
    showConfirm(show) {
      btn.hidden = !show;
    },
  };
}
function closeDialog() {
  $('modal').hidden = true;
  dialogConfirm = null;
}

function askName({ title, label, placeholder, value = '', confirmText = 'Save' }) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', placeholder, maxlength: 60, value });
    const d = openDialog({
      title,
      confirmText,
      body: [h('label', {}, label), input],
      onConfirm: () => {
        const v = normName(input.value);
        if (!v) return false;
        resolve(v);
        return true;
      },
    });
    const sync = () => d.setConfirm(!!normName(input.value));
    input.addEventListener('input', sync);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && $('modalConfirm').click());
    sync();
    setTimeout(() => input.focus(), 30);
  });
}

// ─────────────── editor ───────────────
function setMessage(text) {
  state.message = text;
  $('message').value = text;
  saveMessageSoon();
  renderCounts();
  if (state.preview) renderPreview();
}

function wrapSelection(marker) {
  const ta = $('message');
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  const sel = ta.value.slice(s, e);
  const isBlock = marker === '```';
  if (sel) {
    ta.setRangeText(`${marker}${sel}${marker}`, s, e, 'select');
  } else {
    ta.setRangeText(`${marker}${marker}`, s, e, 'end');
    ta.selectionStart = ta.selectionEnd = s + marker.length;
  }
  if (isBlock && !sel) ta.selectionStart = ta.selectionEnd = s + 3;
  ta.focus();
  state.message = ta.value;
  saveMessageSoon();
  renderCounts();
}

function formatWhatsApp(text, sample) {
  let out = escapeHtml(text);
  out = out.replace(/```([\s\S]+?)```/g, '<code>$1</code>');
  const inline = (m, tag) =>
    new RegExp(`(^|[\\s>(])\\${m}(?!\\s)([^\\${m}\\n]+?)(?<!\\s)\\${m}(?=$|[\\s<.,!?:;)])`, 'g');
  out = out.replace(inline('*'), '$1<strong>$2</strong>');
  out = out.replace(inline('_'), '$1<em>$2</em>');
  out = out.replace(inline('~'), '$1<del>$2</del>');
  out = out.replace(/\{group\}/g, () => `<span class="ph">${escapeHtml(sample)}</span>`);
  return out;
}

function renderPreview() {
  const b = $('bubble');
  if (!state.message.trim()) {
    b.className = 'bubble empty';
    b.textContent = 'Your message preview appears here.';
    return;
  }
  const first = state.groups.find((g) => state.selected.has(g.id));
  b.className = 'bubble';
  b.innerHTML = formatWhatsApp(state.message, first?.name || 'Group name');
}

function togglePreview(on = !state.preview) {
  state.preview = on;
  $('previewToggle').classList.toggle('on', on);
  $('message').hidden = on;
  $('preview').hidden = !on;
  document.querySelectorAll('.toolbar [data-wrap], #insertToken').forEach((b) => (b.disabled = on));
  if (on) renderPreview();
  else $('message').focus();
}

// ─────────────── templates menu ───────────────
function closeMenu() {
  $('tplMenu').hidden = true;
}

function renderTemplateMenu() {
  const menu = $('tplMenu');
  const items = state.templates.map((t) =>
    h(
      'button',
      {
        type: 'button',
        class: 'menu-item',
        onclick: (e) => {
          if (e.target.closest('.x')) return;
          setMessage(t.text);
          closeMenu();
          toast(`Loaded “${t.name}”`);
        },
      },
      h('span', { class: 'mi-text' }, h('span', { class: 'mi-name' }, t.name), h('span', { class: 'mi-sub' }, t.text.replace(/\s+/g, ' ').slice(0, 60))),
      h(
        'span',
        {
          class: 'x',
          title: 'Delete template',
          onclick: () => {
            state.templates = state.templates.filter((x) => x.id !== t.id);
            saveTemplates();
            renderTemplateMenu();
            toast(`Deleted “${t.name}”`);
          },
        },
        '✕'
      )
    )
  );
  menu.replaceChildren(
    ...(items.length ? items : [h('div', { class: 'menu-empty' }, 'No templates yet. Save messages you send often.')]),
    h('div', { class: 'menu-sep' }),
    h('button', { type: 'button', class: 'menu-item accent', onclick: saveTemplate }, '+ Save current message as template')
  );
}

async function saveTemplate() {
  closeMenu();
  const text = state.message.trim();
  if (!text) return toast('Write a message first.', true);
  const name = await askName({ title: 'Save template', label: 'Template name', placeholder: 'e.g. Weekly announcement' });
  const existing = state.templates.find((t) => keyOf(t.name) === keyOf(name));
  if (existing) existing.text = text;
  else state.templates.push({ id: uid(), name, text, createdAt: Date.now() });
  state.templates.sort((a, b) => a.name.localeCompare(b.name));
  saveTemplates();
  toast(existing ? `Updated “${name}”` : `Saved “${name}”`);
}

// ─────────────── renderers ───────────────
function visibleGroups() {
  const f = state.filter.toLowerCase();
  return f ? state.groups.filter((g) => g.name.toLowerCase().includes(f)) : state.groups;
}

function renderPickList() {
  const failed = failedNames();
  const list = $('pickList');
  const rows = visibleGroups().map((g) =>
    checkRow(
      g.name,
      state.selected.has(g.id),
      (on) => {
        on ? state.selected.add(g.id) : state.selected.delete(g.id);
        saveSelected();
        renderCounts();
        renderLists();
      },
      failed.has(keyOf(g.name)) ? h('span', { class: 'status-dot bad', title: 'Failed last time. Check the name in the Groups tab.' }, 'Failed') : null
    )
  );
  if (state.groups.length && !rows.length) rows.push(h('li', { class: 'note' }, 'No groups match your filter.'));
  list.replaceChildren(...rows);
  $('pickEmpty').hidden = state.groups.length > 0;
  $('filterWrap').hidden = state.groups.length < 8;
}

function renderLists() {
  const wrap = $('listChips');
  const sel = state.selected;
  const ids = new Set(state.groups.map((g) => g.id));
  wrap.replaceChildren(
    ...state.lists.map((l) => {
      const members = l.groupIds.filter((id) => ids.has(id));
      const active = members.length && members.length === sel.size && members.every((id) => sel.has(id));
      return h(
        'button',
        {
          type: 'button',
          class: `chip-btn${active ? ' active' : ''}`,
          title: `Select the ${plural(members.length, 'group')} in “${l.name}”`,
          onclick: (e) => {
            if (e.target.closest('.x')) return;
            state.selected = new Set(members);
            saveSelected();
            renderPickList();
            renderCounts();
            renderLists();
          },
        },
        h('span', { class: 'lbl' }, l.name),
        h('span', { class: 'cnt' }, String(members.length)),
        h(
          'span',
          {
            class: 'x',
            title: 'Delete list',
            onclick: () => {
              state.lists = state.lists.filter((x) => x.id !== l.id);
              saveLists();
              renderLists();
              toast(`Deleted list “${l.name}”`);
            },
          },
          '✕'
        )
      );
    })
  );
  $('listsBar').hidden = state.groups.length === 0;
  $('saveListBtn').disabled = sel.size === 0;
}

async function saveList() {
  if (!state.selected.size) return toast('Select some groups first.', true);
  const name = await askName({ title: 'Save group list', label: `List name (${plural(state.selected.size, 'group')})`, placeholder: 'e.g. Church groups' });
  const existing = state.lists.find((l) => keyOf(l.name) === keyOf(name));
  if (existing) existing.groupIds = [...state.selected];
  else state.lists.push({ id: uid(), name, groupIds: [...state.selected] });
  saveLists();
  renderLists();
  toast(existing ? `Updated list “${name}”` : `Saved list “${name}”`);
}

function renderManageList() {
  const failed = failedNames();
  const f = state.manageFilter.toLowerCase();
  const groups = f ? state.groups.filter((g) => g.name.toLowerCase().includes(f)) : state.groups;
  const rows = groups.map((g) => {
    if (state.editingId === g.id) {
      const input = h('input', { type: 'text', value: g.name, maxlength: 120 });
      const commit = () => renameGroup(g.id, input.value);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          e.stopPropagation();
          state.editingId = null;
          renderManageList();
        }
      });
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
      return h(
        'li',
        {},
        avatar(g.name),
        input,
        h('button', { type: 'button', class: 'icon-btn', title: 'Save', onclick: commit, html: CHECK_SVG.replace('viewBox="0 0 12 12"', 'viewBox="0 0 12 12" style="fill:currentColor"') })
      );
    }
    return h(
      'li',
      {},
      avatar(g.name),
      h('span', { class: 'name', title: g.name }, g.name),
      failed.has(keyOf(g.name)) ? h('span', { class: 'status-dot bad', title: 'Not found last time. Rename it to match WhatsApp exactly.' }, 'Failed') : null,
      h('button', {
        type: 'button',
        class: 'icon-btn',
        title: 'Rename',
        html: PENCIL_SVG,
        onclick: () => {
          state.editingId = g.id;
          renderManageList();
        },
      }),
      h('button', { type: 'button', class: 'icon-btn del', title: 'Remove group', onclick: () => removeGroup(g.id) }, '✕')
    );
  });
  if (state.groups.length && !rows.length) rows.push(h('li', { class: 'note' }, 'No groups match your search.'));
  $('manageList').replaceChildren(...rows);
  $('manageEmpty').hidden = state.groups.length > 0;
  $('manageFilterWrap').hidden = state.groups.length < 8;
}

function renderCounts() {
  const n = state.selected.size;
  $('groupCount').textContent = state.groups.length;
  $('selCount').textContent = state.groups.length ? `(${n} of ${state.groups.length})` : '';
  $('charCount').textContent = state.message.length.toLocaleString();

  if (state.attachments.length)
    $('attachNote').textContent = state.message.trim()
      ? 'Your message is sent as the caption.'
      : 'Files will be sent without a caption. Write a message above to add one.';
  const hasContent = state.message.trim().length > 0 || state.attachments.length > 0;
  const ready = n > 0 && hasContent;
  const running = !!state.status.running;
  $('startBtn').disabled = !ready || running;
  const auto = state.settings.mode === 'auto';
  $('startLabel').textContent = running
    ? 'Session in progress in WhatsApp…'
    : !hasContent
      ? 'Write a message or attach a file'
      : !n
        ? 'Select groups to start'
        : auto
          ? `Auto-send to ${plural(n, 'group')} · every ${state.settings.intervalSec}s`
          : `Start sending to ${plural(n, 'group')}`;
}

// ─────────────── send mode ───────────────
function renderMode() {
  const auto = state.settings.mode === 'auto';
  document.querySelectorAll('#modeSeg button').forEach((b) => {
    const on = b.dataset.mode === state.settings.mode;
    b.classList.toggle('on', on);
    b.classList.toggle('auto', on && auto);
    b.setAttribute('aria-checked', String(on));
  });
  $('intervalWrap').hidden = !auto;
  $('interval').value = state.settings.intervalSec;
  $('intervalSetting').value = state.settings.intervalSec;
  $('randomize').checked = state.settings.randomize !== false;
  renderCounts();
}

function saveSettings(msg) {
  chrome.storage.local.set({ settings: state.settings });
  if (msg) toast(msg);
}

function setInterval_(v) {
  state.settings.intervalSec = clampInterval(v);
  saveSettings();
  renderMode();
}

function confirmAutoMode() {
  return new Promise((resolve) => {
    openDialog({
      title: 'Turn on automatic sending?',
      confirmText: 'Turn on automatic',
      body: [
        h('p', {}, 'In Automatic mode, RitPost presses Send for you after a countdown on each group.'),
        h(
          'ul',
          { class: 'risk' },
          h('li', {}, 'WhatsApp’s terms don’t allow automated or bulk messaging. Any interval can lead to your account being restricted or banned. A longer interval only lowers the risk.'),
          h('li', {}, 'Lower your risk: use longer intervals, send to fewer groups at a time, and only post where members expect your messages.'),
          h('li', {}, 'You stay in control: every group shows a countdown with Send now, Hold, Skip, Pause and Stop.')
        ),
        h('p', { class: 'muted' }, 'You can switch back to Manual at any time, including during a session.'),
      ],
      onConfirm: () => {
        resolve(true);
        return true;
      },
    });
    // Resolve false if the dialog is dismissed.
    const watch = setInterval(() => {
      if ($('modal').hidden) {
        clearInterval(watch);
        resolve(false);
      }
    }, 200);
  });
}

async function setMode(mode) {
  if (mode === state.settings.mode) return;
  if (mode === 'auto' && !state.settings.autoAck) {
    if (!(await confirmAutoMode())) return;
    state.settings.autoAck = true;
  }
  state.settings.mode = mode;
  saveSettings(mode === 'auto' ? `Automatic: RitPost presses Send after ${state.settings.intervalSec}s on each group` : 'Manual: you press Enter for each group');
  renderMode();
}

function renderStatus() {
  const s = state.status;
  const pill = $('conn');
  let cls = 'off';
  let txt = 'Open WhatsApp';
  if (s.open && s.running) [cls, txt] = ['ok', 'Sending…'];
  else if (s.open && s.ready) [cls, txt] = ['ok', 'Connected'];
  else if (s.open) [cls, txt] = ['warn', 'Not signed in'];
  pill.className = `pill ${cls}`;
  pill.querySelector('.txt').textContent = txt;
  pill.title = s.open ? 'Switch to WhatsApp Web' : 'Open WhatsApp Web';
  renderCounts();
  renderRunBox();
}

/** Live progress of the session running in WhatsApp Web. */
function renderRunBox() {
  const running = !!state.status.running;
  const r = state.lastRun;
  $('runBox').hidden = !running;
  $('startBtn').hidden = running;
  $('modeBar').hidden = running; // the running session keeps the mode it started with (switchable in WhatsApp)
  $('lastRun').hidden = running || !r?.counts;
  if (!running) return;

  const total = r && !r.done ? r.total : 0;
  const doneCount = r && !r.done ? (r.results || []).length : 0;
  const sent = r && !r.done ? r.counts?.sent || 0 : 0;
  const paused = !!state.status.paused;
  $('runBox').classList.toggle('paused', paused);
  $('runTitle').textContent = paused ? 'Paused' : total ? `Group ${Math.min(doneCount + 1, total)} of ${total}` : 'Sending…';
  $('runMeta').textContent = total ? `${sent} sent` : '';
  $('runFill').style.width = total ? `${Math.round((doneCount / total) * 100)}%` : '0%';
  $('runPause').textContent = paused ? 'Resume' : 'Pause';
}

function timeAgo(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return new Date(ts).toLocaleDateString();
}

function renderLastRun() {
  const r = state.lastRun;
  const el = $('lastRun');
  if (!r || !r.counts) return (el.hidden = true);
  el.hidden = false;
  const unsent = (r.results || []).filter((x) => x.status !== 'sent');
  const left = h(
    'span',
    {},
    h('b', {}, r.done ? 'Last session' : 'In progress'),
    ` · ${timeAgo(r.finishedAt || r.startedAt)} · `,
    h('span', { class: 'ok' }, `${r.counts.sent} sent`),
    r.done && unsent.length ? h('span', {}, ' · ', h('span', { class: 'bad' }, `${unsent.length} not sent`)) : null
  );
  const right =
    r.done && unsent.length
      ? h(
          'button',
          {
            type: 'button',
            class: 'link',
            onclick: () => {
              const names = new Set(unsent.map((x) => keyOf(x.name)));
              state.selected = new Set(state.groups.filter((g) => names.has(keyOf(g.name))).map((g) => g.id));
              saveSelected();
              switchTab('compose');
              renderPickList();
              renderLists();
              renderCounts();
              toast(`Selected ${plural(state.selected.size, 'unsent group')}`);
            },
          },
          'Select unsent'
        )
      : null;
  el.replaceChildren(left, right || '');
}

function renderAll() {
  $('message').value = state.message;
  $('delay').value = String(state.settings.delayMs);
  renderMode();
  renderPickList();
  renderLists();
  renderManageList();
  renderTemplateMenu();
  renderAttachments();
  renderLastRun();
  renderStatus();
}

// ─────────────── group actions ───────────────
function addGroups(names) {
  const existing = new Set(state.groups.map((g) => keyOf(g.name)));
  let added = 0;
  for (const raw of names) {
    const name = normName(raw);
    if (!name || existing.has(keyOf(name))) continue;
    const g = { id: uid(), name, addedAt: Date.now() };
    state.groups.push(g);
    state.selected.add(g.id);
    existing.add(keyOf(name));
    added++;
  }
  if (added) {
    state.groups.sort((a, b) => a.name.localeCompare(b.name));
    saveGroups();
    renderPickList();
    renderLists();
    renderManageList();
    renderCounts();
  }
  return added;
}

function renameGroup(id, value) {
  const name = normName(value);
  const g = state.groups.find((x) => x.id === id);
  if (!g || !name) return;
  if (state.groups.some((x) => x.id !== id && keyOf(x.name) === keyOf(name))) return toast('Another group already has that name.', true);
  g.name = name;
  state.editingId = null;
  state.groups.sort((a, b) => a.name.localeCompare(b.name));
  saveGroups();
  renderManageList();
  renderPickList();
  toast('Group renamed');
}

function removeGroup(id) {
  const g = state.groups.find((x) => x.id === id);
  state.groups = state.groups.filter((x) => x.id !== id);
  state.selected.delete(id);
  state.lists.forEach((l) => (l.groupIds = l.groupIds.filter((x) => x !== id)));
  saveGroups();
  renderPickList();
  renderLists();
  renderManageList();
  renderCounts();
  if (g) toast(`Removed “${g.name}”`);
}

// ─────────────── import from WhatsApp ───────────────
const KIND_LABEL = { group: 'Group', user: 'Contact', channel: 'Channel', broadcast: 'Broadcast', unknown: '' };

function removeGroupsByKey(keys) {
  const drop = new Set(state.groups.filter((g) => keys.has(keyOf(g.name))).map((g) => g.id));
  if (!drop.size) return 0;
  state.groups = state.groups.filter((g) => !drop.has(g.id));
  drop.forEach((id) => state.selected.delete(id));
  state.lists.forEach((l) => (l.groupIds = l.groupIds.filter((id) => !drop.has(id))));
  saveGroups();
  renderPickList();
  renderLists();
  renderManageList();
  renderCounts();
  return drop.size;
}

async function openImport() {
  const importSel = new Set();
  const d = openDialog({
    title: 'Import groups from WhatsApp Web',
    body: h('div', { class: 'loading' }, h('span', { class: 'spinner' }), 'Reading your chat list from WhatsApp Web…'),
    confirmText: 'Add selected',
    onConfirm: () => {
      const added = addGroups([...importSel]);
      toast(added ? `Added ${plural(added, 'group')}` : 'No new groups added');
      return true;
    },
  });
  d.setConfirm(false);

  const res = await bg('BG_SCAN');
  if ($('modal').hidden) return;

  if (!res?.ok) {
    d.showConfirm(false);
    $('modalBody').replaceChildren(
      h(
        'div',
        { class: 'empty' },
        h('p', {}, h('strong', {}, 'Couldn’t read your chats')),
        h('p', { class: 'muted' }, res?.error || 'Open WhatsApp Web, sign in, and try again.'),
        h('button', { type: 'button', class: 'btn secondary sm', onclick: () => bg('BG_OPEN') }, 'Open WhatsApp Web')
      )
    );
    return;
  }

  // Accept both the new [{name, kind}] format and plain names.
  const all = (res.chats || []).map((c) => (typeof c === 'string' ? { name: c, kind: 'unknown' } : c));
  const classifiedOk = all.length > 0 && (res.classified ?? 0) / all.length >= 0.5;
  const have = new Set(state.groups.map((g) => keyOf(g.name)));
  const fresh = all.filter((c) => !have.has(keyOf(c.name)));
  const groups = fresh.filter((c) => c.kind === 'group');
  const contacts = fresh.filter((c) => c.kind === 'user');

  // Saved entries that are actually individual contacts / channels.
  const notGroups = new Set(all.filter((c) => c.kind === 'user' || c.kind === 'channel' || c.kind === 'broadcast').map((c) => keyOf(c.name)));
  const savedNonGroups = state.groups.filter((g) => notGroups.has(keyOf(g.name)));

  let view = classifiedOk ? 'groups' : 'all';
  const sourceFor = () => (view === 'groups' ? groups : view === 'contacts' ? contacts : fresh);

  const input = h('input', { type: 'search', placeholder: 'Search' });
  const count = h('span', { class: 'muted' });
  const list = h('ul', { class: 'list' });
  const seg = h('div', { class: 'seg' });

  const sync = () => {
    count.textContent = `${importSel.size} selected`;
    d.setConfirm(importSel.size > 0, importSel.size ? `Add ${plural(importSel.size, 'chat')}` : 'Add selected');
  };
  const draw = () => {
    const f = input.value.toLowerCase();
    const shown = sourceFor().filter((c) => c.name.toLowerCase().includes(f));
    const rows = shown.map((c) =>
      checkRow(
        c.name,
        importSel.has(c.name),
        (on) => (on ? importSel.add(c.name) : importSel.delete(c.name), sync()),
        view !== 'groups' && KIND_LABEL[c.kind] ? h('span', { class: `kind ${c.kind}` }, KIND_LABEL[c.kind]) : null
      )
    );
    if (!rows.length)
      rows.push(
        h('li', { class: 'note' }, view === 'groups' ? 'No new groups found. Groups you already saved are hidden.' : 'Nothing to show.')
      );
    list.replaceChildren(...rows);
    return shown;
  };
  const drawSeg = () => {
    const opt = (key, label, n) =>
      h(
        'button',
        {
          type: 'button',
          class: view === key ? 'on' : '',
          onclick: () => {
            view = key;
            drawSeg();
            draw();
          },
        },
        `${label} (${n})`
      );
    seg.replaceChildren(
      ...(classifiedOk ? [opt('groups', 'Groups', groups.length), opt('contacts', 'Contacts', contacts.length)] : []),
      opt('all', 'All chats', fresh.length)
    );
  };
  input.addEventListener('input', draw);

  const parts = [];
  if (savedNonGroups.length) {
    const banner = h(
      'div',
      { class: 'banner warn' },
      h(
        'span',
        {},
        savedNonGroups.length === 1
          ? '1 saved entry is an individual contact, not a group.'
          : `${savedNonGroups.length} saved entries are individual contacts, not groups.`
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn secondary sm',
          onclick: () => {
            const n = removeGroupsByKey(new Set(savedNonGroups.map((g) => keyOf(g.name))));
            banner.remove();
            toast(`Removed ${plural(n, 'contact')} from your group list`);
          },
        },
        'Remove them'
      )
    );
    parts.push(banner);
  }
  if (!classifiedOk)
    parts.push(
      h(
        'div',
        { class: 'banner info' },
        h('span', {}, 'RitPost couldn’t tell groups from contacts on this WhatsApp version. Pick only your groups from the list below.')
      )
    );
  parts.push(
    seg,
    h('div', { class: 'search', html: $('filterWrap').querySelector('svg').outerHTML }, input),
    h(
      'div',
      { class: 'field-head' },
      count,
      h(
        'span',
        { class: 'links' },
        h('button', { type: 'button', class: 'link', onclick: () => (draw().forEach((c) => importSel.add(c.name)), draw(), sync()) }, 'Select shown'),
        h('span', { class: 'sep' }, '·'),
        h('button', { type: 'button', class: 'link', onclick: () => (importSel.clear(), draw(), sync()) }, 'Clear')
      )
    ),
    list
  );

  $('modalBody').replaceChildren(...parts);
  drawSeg();
  draw();
  sync();
  input.focus();
}

// ─────────────── backup ───────────────
async function exportData() {
  const nameById = new Map(state.groups.map((g) => [g.id, g.name]));
  const data = {
    app: 'RitPost',
    version: 2,
    exportedAt: new Date().toISOString(),
    groups: state.groups.map((g) => g.name),
    lists: state.lists.map((l) => ({ name: l.name, groups: l.groupIds.map((id) => nameById.get(id)).filter(Boolean) })),
    templates: state.templates.map((t) => ({ name: t.name, text: t.text })),
  };
  const res = await bg('BG_DOWNLOAD', {
    filename: `ritpost-backup-${new Date().toISOString().slice(0, 10)}.json`,
    json: JSON.stringify(data, null, 2),
  });
  if (!res?.ok) toast(`Export failed: ${res?.error || 'unknown error'}`, true);
  else if (!res.cancelled)
    toast(`Exported ${plural(state.groups.length, 'group')}, ${plural(state.lists.length, 'list')}, ${plural(state.templates.length, 'template')}`);
}

async function restoreData(file) {
  try {
    const data = JSON.parse(await file.text());
    const names = Array.isArray(data) ? data : data.groups;
    if (!Array.isArray(names)) throw new Error();
    const added = addGroups(names.map((n) => (typeof n === 'string' ? n : n?.name)).filter(Boolean));

    const idByKey = new Map(state.groups.map((g) => [keyOf(g.name), g.id]));
    let lists = 0;
    for (const l of data.lists || []) {
      if (!l?.name || state.lists.some((x) => keyOf(x.name) === keyOf(l.name))) continue;
      state.lists.push({ id: uid(), name: l.name, groupIds: (l.groups || []).map((n) => idByKey.get(keyOf(n))).filter(Boolean) });
      lists++;
    }
    let tpls = 0;
    for (const t of data.templates || []) {
      if (!t?.name || !t?.text || state.templates.some((x) => keyOf(x.name) === keyOf(t.name))) continue;
      state.templates.push({ id: uid(), name: t.name, text: t.text, createdAt: Date.now() });
      tpls++;
    }
    saveLists();
    saveTemplates();
    renderAll();
    toast(`Restored ${plural(added, 'group')}, ${plural(lists, 'list')}, ${plural(tpls, 'template')}`);
  } catch {
    toast('That file is not a valid RitPost backup.', true);
  }
}

// ─────────────── attachments ───────────────
const saveAttachments = () => chrome.storage.local.set({ attachments: state.attachments });

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const readAsDataURL = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('Could not read the file'));
    r.readAsDataURL(file);
  });

async function addAttachments(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  const problems = [];
  let total = state.attachments.reduce((s, a) => s + (a.size || 0), 0);
  let added = 0;
  for (const f of files) {
    if (state.attachments.length >= MAX_FILES) {
      problems.push(`Only ${MAX_FILES} files can be attached.`);
      break;
    }
    if (!f.size) {
      problems.push(`${f.name} is empty.`);
      continue;
    }
    if (f.size > MAX_FILE_BYTES) {
      problems.push(`${f.name} is larger than 16 MB.`);
      continue;
    }
    if (total + f.size > MAX_TOTAL_BYTES) {
      problems.push('Attachments are limited to 64 MB in total.');
      break;
    }
    try {
      const data = await readAsDataURL(f);
      state.attachments.push({ id: uid(), name: f.name, type: f.type || 'application/octet-stream', size: f.size, data });
      total += f.size;
      added++;
    } catch {
      problems.push(`${f.name} couldn’t be read.`);
    }
  }
  if (added) {
    try {
      await saveAttachments();
    } catch (e) {
      state.attachments.splice(-added, added);
      problems.push(`Couldn’t save the attachments: ${e?.message || e}`);
      added = 0;
    }
  }
  renderAttachments();
  renderCounts();
  if (problems.length) toast(problems[0], true);
  else if (added) toast(`${plural(added, 'file')} attached`);
}

function removeAttachment(id) {
  state.attachments = state.attachments.filter((a) => a.id !== id);
  saveAttachments();
  renderAttachments();
  renderCounts();
}

const PLAY_SVG = '<svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M6 4.5v11l9-5.5-9-5.5Z"/></svg>';

function renderAttachments() {
  const list = $('attachList');
  list.replaceChildren(
    ...state.attachments.map((a) => {
      const ext = (a.name.includes('.') ? a.name.split('.').pop() : 'FILE').slice(0, 4).toUpperCase();
      let thumb;
      if (a.type.startsWith('image/')) thumb = h('span', { class: 'attach-thumb' }, h('img', { src: a.data, alt: '' }));
      else if (a.type.startsWith('video/')) thumb = h('span', { class: 'attach-thumb video', html: PLAY_SVG });
      else thumb = h('span', { class: 'attach-thumb' }, ext);
      return h(
        'li',
        { class: 'attach-item' },
        thumb,
        h('span', { class: 'attach-meta' }, h('span', { class: 'attach-name', title: a.name }, a.name), h('span', { class: 'attach-size' }, formatBytes(a.size))),
        h('button', { type: 'button', class: 'attach-remove', title: 'Remove', 'aria-label': `Remove ${a.name}`, onclick: () => removeAttachment(a.id) }, '✕')
      );
    })
  );
  const n = state.attachments.length;
  list.hidden = !n;
  $('attachNote').hidden = !n;
  $('attachNote').textContent = state.message.trim()
    ? 'Your message is sent as the caption.'
    : 'Files will be sent without a caption. Write a message above to add one.';
  $('attachHint').textContent = n
    ? `${plural(n, 'file')} · ${formatBytes(state.attachments.reduce((s, a) => s + a.size, 0))}`
    : 'Up to 10 files · 16 MB each';
}

// ─────────────── start ───────────────
async function start() {
  const message = state.message.trim();
  const attachments = state.attachments.map((a) => a.id);
  const items = state.groups
    .filter((g) => state.selected.has(g.id))
    .map((g) => ({ name: g.name, text: message.replaceAll('{group}', g.name) }));
  if (!items.length || (!message && !attachments.length)) return;

  $('startBtn').disabled = true;
  $('startLabel').textContent = 'Opening WhatsApp Web…';

  const res = await bg('BG_START', { run: { items, settings: state.settings, attachments } });
  if (res?.ok) {
    state.status = { ...state.status, open: true, running: true, paused: false };
    renderStatus();
    toast(`Sending started: ${plural(items.length, 'group')}. Press Enter in WhatsApp for each one.`);
  } else {
    toast(res?.error || 'Couldn’t start. Make sure WhatsApp Web is open and signed in.', true);
    renderCounts();
  }
}

// ─────────────── wiring ───────────────
function bind() {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.goto)));

  const ta = $('message');
  ta.addEventListener('input', () => {
    state.message = ta.value;
    saveMessageSoon();
    renderCounts();
  });
  ta.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'b' || k === 'i') {
      e.preventDefault();
      wrapSelection(k === 'b' ? '*' : '_');
    }
  });
  document.querySelectorAll('[data-wrap]').forEach((b) => b.addEventListener('click', () => wrapSelection(b.dataset.wrap)));
  $('insertToken').addEventListener('click', () => {
    ta.setRangeText('{group}', ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input'));
    ta.focus();
  });
  $('previewToggle').addEventListener('click', () => togglePreview());

  $('tplBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('tplMenu');
    if (menu.hidden) renderTemplateMenu();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu-wrap')) closeMenu();
  });

  $('filter').addEventListener('input', (e) => {
    state.filter = e.target.value.trim();
    renderPickList();
  });
  $('manageFilter').addEventListener('input', (e) => {
    state.manageFilter = e.target.value.trim();
    renderManageList();
  });

  const bulk = (on) => {
    visibleGroups().forEach((g) => (on ? state.selected.add(g.id) : state.selected.delete(g.id)));
    saveSelected();
    renderPickList();
    renderLists();
    renderCounts();
    if (state.preview) renderPreview();
  };
  $('selAll').addEventListener('click', () => bulk(true));
  $('selNone').addEventListener('click', () => bulk(false));
  $('saveListBtn').addEventListener('click', saveList);

  $('addForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('newGroup');
    const name = normName(input.value);
    if (!name) return;
    if (addGroups([name])) {
      input.value = '';
      toast(`Added “${name}”`);
    } else toast('That group is already in your list.', true);
    input.focus();
  });

  $('importBtn').addEventListener('click', openImport);
  document.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', closeDialog));
  $('modal').addEventListener('click', (e) => e.target.id === 'modal' && closeDialog());
  $('modalConfirm').addEventListener('click', () => {
    if (!dialogConfirm || $('modalConfirm').disabled) return;
    if (dialogConfirm() !== false) closeDialog();
  });

  $('delay').addEventListener('change', (e) => {
    state.settings.delayMs = Number(e.target.value) || DEFAULT_SETTINGS.delayMs;
    saveSettings('Settings saved');
  });
  document.querySelectorAll('#modeSeg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('interval').addEventListener('change', (e) => setInterval_(e.target.value));
  $('intervalSetting').addEventListener('change', (e) => {
    setInterval_(e.target.value);
    toast(`Interval set to ${state.settings.intervalSec}s`);
  });
  $('randomize').addEventListener('change', (e) => {
    state.settings.randomize = e.target.checked;
    saveSettings(e.target.checked ? 'Interval will vary slightly' : 'Interval will be exact');
  });

  $('exportBtn').addEventListener('click', () => {
    if (!state.groups.length && !state.templates.length) return toast('There is nothing to export yet.', true);
    exportData();
  });
  $('restoreBtn').addEventListener('click', () => $('restoreFile').click());
  $('restoreFile').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) restoreData(f);
    e.target.value = '';
  });

  $('resetBtn').addEventListener('click', () => {
    openDialog({
      title: 'Reset RitPost?',
      confirmText: 'Delete everything',
      body: h('p', { class: 'muted' }, 'This deletes all saved groups, lists, templates, your draft and session history from this browser. It cannot be undone.'),
      onConfirm: () => {
        (async () => {
          await chrome.storage.local.clear();
          await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
          await load();
          renderAll();
          toast('Everything has been reset');
        })();
        return true;
      },
    });
  });

  $('attachBtn').addEventListener('click', () => $('attachInput').click());
  $('attachInput').addEventListener('change', (e) => {
    addAttachments(e.target.files);
    e.target.value = '';
  });
  // Files can also be dragged onto the message area.
  const attachWrap = document.querySelector('.attach');
  const attachZone = attachWrap.closest('.field');
  attachZone.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    attachWrap.classList.add('dragover');
  });
  attachZone.addEventListener('dragleave', (e) => {
    if (!attachZone.contains(e.relatedTarget)) attachWrap.classList.remove('dragover');
  });
  attachZone.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    attachWrap.classList.remove('dragover');
    addAttachments(e.dataTransfer.files);
  });

  $('conn').addEventListener('click', () => bg('BG_OPEN'));
  $('startBtn').addEventListener('click', start);
  $('runFocus').addEventListener('click', () => bg('BG_OPEN'));
  $('runPause').addEventListener('click', async () => {
    const res = await bg('BG_CONTROL', { action: 'pause' });
    if (res?.ok) {
      state.status.paused = res.paused;
      renderRunBox();
      toast(res.paused ? 'Paused. RitPost will hold before the next group.' : 'Resumed');
    } else toast(res?.error || 'Couldn’t reach WhatsApp Web.', true);
  });
  $('runStop').addEventListener('click', async () => {
    const res = await bg('BG_CONTROL', { action: 'stop' });
    if (res?.ok) toast('Stopping the session…');
    else toast(res?.error || 'Couldn’t reach WhatsApp Web.', true);
    setTimeout(refreshStatus, 800);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('modal').hidden) {
        e.preventDefault();
        closeDialog();
      } else if (!$('tplMenu').hidden) {
        e.preventDefault();
        closeMenu();
      }
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && $('modal').hidden && !$('startBtn').disabled) start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings?.newValue) {
      // e.g. mode switched from the panel inside WhatsApp Web
      state.settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
      renderMode();
    }
    if (area === 'local' && changes.lastRun) {
      state.lastRun = changes.lastRun.newValue || null;
      if (state.lastRun && !state.lastRun.done) state.status.running = true;
      if (state.lastRun?.done) state.status.running = false;
      renderLastRun();
      renderStatus();
      renderPickList();
      renderManageList();
    }
  });
}

async function refreshStatus() {
  const s = await bg('BG_STATUS');
  state.status = s?.ok ? s : { open: false };
  renderStatus();
}

(async function init() {
  try {
    WINDOW_ID = (await chrome.windows.getCurrent()).id;
  } catch {
    WINDOW_ID = null;
  }
  await load();
  bind();
  renderAll();
  $('version').textContent = `RitPost v${chrome.runtime.getManifest().version}`;

  // RitPost opens together with WhatsApp Web: bring it up beside the panel.
  const s = await bg('BG_STATUS');
  if (!s?.open || !s?.active) await bg('BG_OPEN');
  await refreshStatus();

  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!document.hidden) await refreshStatus();
      schedule();
    }, state.status.running ? 1500 : 4000);
  };
  schedule();
  $('message').focus();
})();
