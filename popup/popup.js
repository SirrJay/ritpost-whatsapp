/* RitPost — popup */
'use strict';

const DEFAULT_SETTINGS = { delayMs: 2000, mode: 'manual', intervalSec: 6, randomize: true, autoAck: false, linkSeparate: true };
const clampInterval = (v) => Math.min(600, Math.max(5, Math.round(Number(v) || 6)));
const AVATAR_COLORS = ['#0e7c66', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#0891b2', '#4d7c0f', '#9333ea'];
const CHECK_SVG = '<svg viewBox="0 0 12 12"><path d="M4.6 8.6 2.3 6.3l-.9.9 3.2 3.2 6-6-.9-.9z"/></svg>';
const PENCIL_SVG = '<svg viewBox="0 0 20 20"><path d="M13.6 2.9a1.8 1.8 0 0 1 2.5 0l1 1a1.8 1.8 0 0 1 0 2.5L7.4 16.1 3 17l.9-4.4 9.7-9.7Zm1.4 1.1-1 1 1 1 1-1-1-1Zm-2 2L5.2 13.4l-.4 1.8 1.8-.4L14 7l-1-1Z"/></svg>';
const LIST_SVG = '<svg viewBox="0 0 20 20"><path d="M3 4.5h2v2H3v-2Zm4 .25h10v1.5H7v-1.5ZM3 9h2v2H3V9Zm4 .25h10v1.5H7v-1.5ZM3 13.5h2v2H3v-2Zm4 .25h10v1.5H7v-1.5Z"/></svg>';
const USE_SVG = '<svg viewBox="0 0 20 20"><path d="M2.9 2.7a.75.75 0 0 1 .82-.1l13.5 6.75a.75.75 0 0 1 0 1.34L3.72 17.44a.75.75 0 0 1-1.05-.87L4.38 10 2.67 3.43a.75.75 0 0 1 .23-.73ZM5.6 10.75l-1.07 4.13L14.57 10 4.53 5.12l1.07 4.13H10v1.5H5.6Z"/></svg>';
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
  manageSel: new Set(), // groups ticked in the Groups tab (for bulk actions)
  listSel: new Set(), // lists ticked in the Groups tab
  editingId: null,
  preview: false,
  status: { open: false },
};

const $ = (id) => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
// Invisible / formatting characters WhatsApp sprinkles into chat names (same set as content.js).
const INVISIBLE = /[­​-‏‪-‮⁠-⁤﻿︎️]/g;
const normName = (s) => String(s || '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
const keyOf = (s) => normName(s).normalize('NFKC').toLowerCase();
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
const short = (s, n = 26) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
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
const GROUP_KEYS = ['groups', 'selected', 'lists', 'templates'];

/**
 * Clean up stored groups/lists: drop blank names, merge duplicates (names that only
 * differ by spacing, case or invisible characters), give every entry an id, and point
 * lists/selection at the surviving ids. Also repairs data saved by older versions.
 */
function sanitize(d) {
  const groups = [];
  const idByKey = new Map();
  const remap = new Map();
  const usedIds = new Set();
  for (const raw of Array.isArray(d.groups) ? d.groups : []) {
    const obj = raw && typeof raw === 'object' ? raw : {};
    const name = normName(typeof raw === 'string' ? raw : obj.name);
    if (!name) continue;
    let id = obj.id ? String(obj.id) : uid();
    const k = keyOf(name);
    if (idByKey.has(k)) {
      if (!remap.has(id)) remap.set(id, idByKey.get(k));
      continue;
    }
    if (usedIds.has(id)) id = uid();
    usedIds.add(id);
    idByKey.set(k, id);
    if (obj.id && !remap.has(String(obj.id))) remap.set(String(obj.id), id);
    remap.set(id, id);
    groups.push({ ...obj, id, name, addedAt: obj.addedAt || Date.now() });
  }
  groups.sort(byName);
  const fix = (ids) => [...new Set((Array.isArray(ids) ? ids : []).map((id) => remap.get(String(id))).filter(Boolean))];

  const lists = [];
  for (const l of Array.isArray(d.lists) ? d.lists : []) {
    const name = normName(l?.name);
    if (!name) continue;
    const ids = fix(l.groupIds);
    const same = lists.find((x) => keyOf(x.name) === keyOf(name));
    if (same) same.groupIds = [...new Set([...same.groupIds, ...ids])];
    else lists.push({ id: l.id ? String(l.id) : uid(), name, groupIds: ids, createdAt: l.createdAt || Date.now() });
  }
  lists.sort(byName);

  const templates = (Array.isArray(d.templates) ? d.templates : []).filter((t) => t?.name && typeof t.text === 'string');
  return { groups, lists, templates, selected: fix(d.selected) };
}

function applyGroupData(clean) {
  state.groups = clean.groups;
  state.lists = clean.lists;
  state.templates = clean.templates;
  state.selected = new Set(clean.selected);
}

async function load() {
  const d = await chrome.storage.local.get([...GROUP_KEYS, 'message', 'settings', 'lastRun', 'attachments']);
  const clean = sanitize(d);
  applyGroupData(clean);
  state.message = d.message || '';
  state.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
  state.lastRun = d.lastRun || null;
  state.attachments = Array.isArray(d.attachments) ? d.attachments.filter((a) => a?.id && a?.data) : [];
  // Write back anything that had to be repaired.
  const changed = GROUP_KEYS.some((k) => d[k] !== undefined && JSON.stringify(d[k]) !== JSON.stringify(clean[k]));
  if (changed) await persist({ groups: clean.groups, lists: clean.lists, templates: clean.templates, selected: clean.selected });
}

/** Save to chrome.storage and tell the user if it didn't work (instead of failing silently). */
async function persist(data) {
  try {
    await chrome.storage.local.set(data);
    return true;
  } catch (e) {
    toast(`Couldn’t save your changes: ${e?.message || e}`, true);
    return false;
  }
}

const saveGroups = () => persist({ groups: state.groups, selected: [...state.selected], lists: state.lists });
const saveSelected = () => persist({ selected: [...state.selected] });
const saveTemplates = () => persist({ templates: state.templates });
const saveLists = () => persist({ lists: state.lists });

/** Another RitPost panel (e.g. in a second window) changed the saved groups: pick up its changes. */
let syncTimer;
function syncFromStorageSoon() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    const clean = sanitize(await chrome.storage.local.get(GROUP_KEYS));
    const current = { groups: state.groups, lists: state.lists, templates: state.templates, selected: [...state.selected] };
    if (JSON.stringify(clean) === JSON.stringify(current)) return; // our own write
    applyGroupData(clean);
    if (state.editingId && !state.groups.some((g) => g.id === state.editingId)) state.editingId = null;
    refreshGroups();
    renderTemplateMenu();
  }, 120);
}

let msgTimer;
function saveMessageSoon() {
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => chrome.storage.local.set({ message: state.message }), 250);
}

// ─────────────── UI helpers ───────────────
let toastTimer;
/** Short status message. `action` ({ label, run }) adds a button such as Undo. */
function toast(text, isError = false, action = null) {
  const t = $('toast');
  t.replaceChildren(h('span', { class: 'toast-text' }, text));
  if (action)
    t.append(
      h(
        'button',
        {
          type: 'button',
          class: 'toast-action',
          onclick: () => {
            t.classList.remove('show');
            action.run();
          },
        },
        action.label
      )
    );
  t.classList.toggle('error', isError);
  t.classList.toggle('has-action', !!action);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 7000 : 2800);
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
  document.body.dataset.tab = name;
  $('fbStartBtn').hidden = name !== 'facebook';
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
let dialogCancel = null;
function openDialog({ title, body, confirmText = 'Save', onConfirm, onCancel = null, hideConfirm = false, danger = false }) {
  // Replacing an open dialog counts as cancelling it.
  if (!$('modal').hidden) closeDialog();
  $('modalTitle').textContent = title;
  $('modalBody').replaceChildren(...(Array.isArray(body) ? body : [body]));
  const btn = $('modalConfirm');
  btn.textContent = confirmText;
  btn.hidden = hideConfirm;
  btn.disabled = false;
  btn.className = `btn ${danger ? 'danger-solid' : 'primary'}`;
  dialogConfirm = onConfirm;
  dialogCancel = onCancel;
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
function closeDialog(confirmed = false) {
  const cancel = dialogCancel;
  $('modal').hidden = true;
  dialogConfirm = null;
  dialogCancel = null;
  if (!confirmed && cancel) cancel();
}

/** Resolves with the entered name, or null if the dialog is dismissed. */
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
      onCancel: () => resolve(null),
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
  if (!name) return;
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

/** Ids of a list's groups that still exist. */
function listMembers(l) {
  const ids = new Set(state.groups.map((g) => g.id));
  return l.groupIds.filter((id) => ids.has(id));
}

/** Select a list's groups for sending (the chip in Compose / the send icon in Groups). */
function useList(l, { goCompose = false } = {}) {
  const members = listMembers(l);
  if (!members.length) return toast(`“${l.name}” has no groups yet. Edit it to add some.`, true);
  state.selected = new Set(members);
  saveSelected();
  if (goCompose) switchTab('compose');
  refreshGroups();
  if (goCompose) toast(`Selected ${plural(members.length, 'group')} from “${l.name}”`);
}

function renderLists() {
  const wrap = $('listChips');
  const sel = state.selected;
  wrap.replaceChildren(
    ...state.lists.map((l) => {
      const members = listMembers(l);
      const active = members.length > 0 && members.length === sel.size && members.every((id) => sel.has(id));
      return h(
        'button',
        {
          type: 'button',
          class: `chip-btn${active ? ' active' : ''}`,
          title: active ? `Click again to clear the selection` : `Select the ${plural(members.length, 'group')} in “${l.name}”`,
          onclick: (e) => {
            if (e.target.closest('.x')) return;
            if (active) {
              state.selected.clear();
              saveSelected();
              refreshGroups();
            } else useList(l);
          },
        },
        h('span', { class: 'lbl' }, l.name),
        h('span', { class: 'cnt' }, String(members.length)),
        h(
          'span',
          {
            class: 'x',
            title: 'Delete list (your groups stay saved)',
            onclick: () => deleteLists([l.id]),
          },
          '✕'
        )
      );
    })
  );
  $('listsBar').hidden = state.groups.length === 0;
  $('saveListBtn').disabled = sel.size === 0;
  $('saveListBtn').textContent = sel.size ? `+ Save ${sel.size} to list` : '+ Save selection';
}

function saveList() {
  if (!state.selected.size) return toast('Select some groups first.', true);
  openAddToList([...state.selected], {
    title: `Save ${plural(state.selected.size, 'selected group')}`,
    prefer: 'new',
  });
}

// ─────────────── Groups tab: saved lists ───────────────
function renderListManager() {
  const rows = state.lists.map((l) => {
    const n = listMembers(l).length;
    const input = h('input', { type: 'checkbox', 'aria-label': `Select list ${l.name}` });
    input.checked = state.listSel.has(l.id);
    input.addEventListener('change', () => {
      input.checked ? state.listSel.add(l.id) : state.listSel.delete(l.id);
      renderListBulk();
    });
    return h(
      'li',
      {},
      h(
        'label',
        { class: 'pick' },
        input,
        h('span', { class: 'check', html: CHECK_SVG }),
        h('span', { class: 'list-icon', html: LIST_SVG }),
        h('span', { class: 'name-wrap' }, h('span', { class: 'name', title: l.name }, l.name), h('span', { class: 'sub' }, n ? plural(n, 'group') : 'Empty'))
      ),
      h('button', { type: 'button', class: 'icon-btn', title: 'Select these groups for sending', html: USE_SVG, onclick: () => useList(l, { goCompose: true }) }),
      h('button', { type: 'button', class: 'icon-btn', title: 'Edit list: rename, add or remove groups', html: PENCIL_SVG, onclick: () => openListEditor(l.id) }),
      h('button', { type: 'button', class: 'icon-btn del', title: 'Delete list (your groups stay saved)', onclick: () => deleteLists([l.id]) }, '✕')
    );
  });
  $('listManage').replaceChildren(...rows);
  $('listsEmpty').hidden = state.lists.length > 0 || state.groups.length === 0;
  $('listsSection').hidden = state.groups.length === 0 && state.lists.length === 0;
  $('listCount').textContent = state.lists.length ? `(${state.lists.length})` : '';
  renderListBulk();
}

function renderListBulk() {
  const n = state.listSel.size;
  $('listBulk').hidden = !n;
  $('listBulkCount').textContent = `${plural(n, 'list')} selected`;
  $('listSelAll').textContent = state.lists.length && n === state.lists.length ? 'None' : 'Select all';
  $('listSelAll').hidden = state.lists.length < 2;
  $('listSelAllSep').hidden = state.lists.length < 2;
}

// ─────────────── Groups tab: saved groups ───────────────
function manageVisible() {
  const f = state.manageFilter.toLowerCase();
  return f ? state.groups.filter((g) => g.name.toLowerCase().includes(f)) : state.groups;
}

function renderManageList() {
  const failed = failedNames();
  const listsOf = new Map();
  for (const l of state.lists) for (const id of l.groupIds) listsOf.set(id, [...(listsOf.get(id) || []), l.name]);

  const rows = manageVisible().map((g) => {
    if (state.editingId === g.id) {
      const input = h('input', { type: 'text', value: g.name, maxlength: 120, 'aria-label': 'Group name' });
      const commit = () => state.editingId === g.id && renameGroup(g.id, input.value);
      const cancel = () => {
        state.editingId = null;
        renderManageList();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          e.stopPropagation();
          cancel();
        }
      });
      input.addEventListener('blur', (e) => {
        // Leaving the field saves, unless the click went to this row's own buttons.
        if (e.relatedTarget?.closest?.('.editing')) return;
        commit();
      });
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
      return h(
        'li',
        { class: 'editing' },
        avatar(g.name),
        input,
        h('button', { type: 'button', class: 'icon-btn ok', title: 'Save (Enter)', onclick: commit, html: CHECK_SVG }),
        h('button', { type: 'button', class: 'icon-btn', title: 'Cancel (Esc)', onclick: cancel }, '↺')
      );
    }

    const input = h('input', { type: 'checkbox', 'aria-label': `Select ${g.name}` });
    input.checked = state.manageSel.has(g.id);
    input.addEventListener('change', () => {
      input.checked ? state.manageSel.add(g.id) : state.manageSel.delete(g.id);
      renderBulkBar();
    });
    const inLists = listsOf.get(g.id);
    return h(
      'li',
      {},
      h(
        'label',
        { class: 'pick' },
        input,
        h('span', { class: 'check', html: CHECK_SVG }),
        avatar(g.name),
        h(
          'span',
          { class: 'name-wrap' },
          h('span', { class: 'name', title: g.name }, g.name),
          inLists ? h('span', { class: 'sub', title: `In: ${inLists.join(', ')}` }, inLists.join(' · ')) : null
        ),
        failed.has(keyOf(g.name)) ? h('span', { class: 'status-dot bad', title: 'Not found last time. Rename it to match WhatsApp exactly.' }, 'Failed') : null
      ),
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
      h('button', { type: 'button', class: 'icon-btn del', title: 'Delete group', onclick: () => deleteGroups([g.id]) }, '✕')
    );
  });
  if (state.groups.length && !rows.length) rows.push(h('li', { class: 'note' }, 'No groups match your search.'));
  $('manageList').replaceChildren(...rows);
  $('manageEmpty').hidden = state.groups.length > 0;
  $('manageFilterWrap').hidden = state.groups.length < 8;
  $('groupsHead').hidden = state.groups.length === 0;
  $('manageCount').textContent = state.groups.length ? `(${state.groups.length})` : '';
  renderBulkBar();
}

function renderBulkBar() {
  const n = state.manageSel.size;
  $('bulkBar').hidden = !n;
  const shown = new Set(manageVisible().map((g) => g.id));
  const hidden = [...state.manageSel].filter((id) => !shown.has(id)).length;
  $('bulkCount').replaceChildren(h('b', {}, String(n)), ' selected', hidden ? h('span', { class: 'muted' }, ` · ${hidden} hidden by search`) : '');
  const allShown = shown.size > 0 && [...shown].every((id) => state.manageSel.has(id));
  $('mSelAll').textContent = allShown ? 'Clear' : state.manageFilter ? 'Select shown' : 'Select all';
}

/** Re-render everything that shows groups or lists. */
function refreshGroups() {
  const gids = new Set(state.groups.map((g) => g.id));
  for (const id of state.manageSel) if (!gids.has(id)) state.manageSel.delete(id);
  for (const id of state.selected) if (!gids.has(id)) state.selected.delete(id);
  const lids = new Set(state.lists.map((l) => l.id));
  for (const id of state.listSel) if (!lids.has(id)) state.listSel.delete(id);
  renderPickList();
  renderLists();
  renderManageList();
  renderListManager();
  renderCounts();
  if (state.preview) renderPreview();
}

function renderCounts() {
  const n = state.selected.size;
  $('groupCount').textContent = state.groups.length;
  $('selCount').textContent = state.groups.length ? `(${n} of ${state.groups.length})` : '';
  $('charCount').textContent = state.message.length.toLocaleString();

  if (state.attachments.length) renderAttachNote();
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
      onCancel: () => resolve(false),
    });
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
              refreshGroups();
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
  refreshGroups();
  renderTemplateMenu();
  renderAttachments();
  renderLastRun();
  renderStatus();
  renderFb();
}

// ─────────────── group actions ───────────────
function addGroups(names, { select = true } = {}) {
  const existing = new Set(state.groups.map((g) => keyOf(g.name)));
  let added = 0;
  for (const raw of names) {
    const name = normName(raw);
    if (!name || existing.has(keyOf(name))) continue;
    const g = { id: uid(), name, addedAt: Date.now() };
    state.groups.push(g);
    if (select) state.selected.add(g.id);
    existing.add(keyOf(name));
    added++;
  }
  if (added) {
    state.groups.sort(byName);
    saveGroups();
    refreshGroups();
  }
  return added;
}

function renameGroup(id, value) {
  const name = normName(value);
  const g = state.groups.find((x) => x.id === id);
  if (!g) return;
  if (!name || name === g.name) {
    state.editingId = null;
    renderManageList();
    return;
  }
  if (state.groups.some((x) => x.id !== id && keyOf(x.name) === keyOf(name))) return toast('Another group already has that name.', true);
  g.name = name;
  state.editingId = null;
  state.groups.sort(byName);
  saveGroups();
  refreshGroups();
  toast('Group renamed');
}

/** Deep copy of everything a delete can touch, for Undo. */
function snapshot() {
  return {
    groups: state.groups.map((g) => ({ ...g })),
    selected: [...state.selected],
    lists: state.lists.map((l) => ({ ...l, groupIds: [...l.groupIds] })),
  };
}

function undoTo(snap) {
  return {
    label: 'Undo',
    run: async () => {
      state.groups = snap.groups;
      state.selected = new Set(snap.selected);
      state.lists = snap.lists;
      await saveGroups();
      refreshGroups();
      toast('Restored');
    },
  };
}

/** A short "A, B, C and 4 more" preview for confirmation dialogs. */
function namesPreview(names) {
  const shown = names.slice(0, 5);
  return h(
    'ul',
    { class: 'names-preview' },
    ...shown.map((n) => h('li', {}, n)),
    names.length > shown.length ? h('li', { class: 'muted' }, `and ${names.length - shown.length} more`) : null
  );
}

/**
 * Delete groups (and take them out of every list). One group is deleted straight away
 * with Undo; several ask first when `confirm` is set.
 */
function deleteGroups(ids, { confirm = false, message } = {}) {
  const drop = new Set(ids);
  const victims = state.groups.filter((g) => drop.has(g.id));
  if (!victims.length) return 0;
  const go = () => {
    const snap = snapshot();
    state.groups = state.groups.filter((g) => !drop.has(g.id));
    drop.forEach((id) => {
      state.selected.delete(id);
      state.manageSel.delete(id);
    });
    state.lists.forEach((l) => (l.groupIds = l.groupIds.filter((id) => !drop.has(id))));
    if (drop.has(state.editingId)) state.editingId = null;
    saveGroups();
    refreshGroups();
    toast(message || (victims.length === 1 ? `Deleted “${short(victims[0].name, 34)}”` : `Deleted ${plural(victims.length, 'group')}`), false, undoTo(snap));
  };
  if (!confirm || victims.length === 1) {
    go();
    return victims.length;
  }
  const affected = state.lists.filter((l) => l.groupIds.some((id) => drop.has(id)));
  openDialog({
    title: `Delete ${plural(victims.length, 'group')}?`,
    confirmText: `Delete ${plural(victims.length, 'group')}`,
    danger: true,
    body: [
      h('p', { class: 'muted' }, 'These groups will be removed from RitPost. Nothing changes in WhatsApp itself.'),
      namesPreview(victims.map((g) => g.name)),
      affected.length
        ? h('p', { class: 'muted' }, `They will also be taken out of ${affected.length === 1 ? `the list “${affected[0].name}”` : plural(affected.length, 'list')}.`)
        : null,
    ].filter(Boolean),
    onConfirm: () => {
      go();
      return true;
    },
  });
  return 0;
}

// ─────────────── lists ───────────────
const findListByName = (name, exceptId) => state.lists.find((l) => l.id !== exceptId && keyOf(l.name) === keyOf(name));

/** Add groups to a list; returns how many were new to it. */
function addToList(list, ids) {
  const have = new Set(list.groupIds);
  const fresh = ids.filter((id) => !have.has(id));
  list.groupIds = [...list.groupIds, ...fresh];
  return fresh.length;
}

function createList(name, ids) {
  const list = { id: uid(), name: normName(name), groupIds: [...new Set(ids)], createdAt: Date.now() };
  state.lists.push(list);
  state.lists.sort(byName);
  return list;
}

/** Delete lists. The groups in them stay saved. */
function deleteLists(ids, { confirm = false } = {}) {
  const drop = new Set(ids);
  const victims = state.lists.filter((l) => drop.has(l.id));
  if (!victims.length) return;
  const go = () => {
    const snapLists = state.lists.map((l) => ({ ...l, groupIds: [...l.groupIds] }));
    state.lists = state.lists.filter((l) => !drop.has(l.id));
    drop.forEach((id) => state.listSel.delete(id));
    saveLists();
    refreshGroups();
    toast(victims.length === 1 ? `Deleted list “${short(victims[0].name, 30)}”` : `Deleted ${plural(victims.length, 'list')}`, false, {
      label: 'Undo',
      run: async () => {
        // Restore the lists only, keeping any group changes made since.
        const gids = new Set(state.groups.map((g) => g.id));
        const keep = new Set(state.lists.map((l) => l.id));
        for (const l of snapLists) if (drop.has(l.id) && !keep.has(l.id)) state.lists.push({ ...l, groupIds: l.groupIds.filter((id) => gids.has(id)) });
        state.lists.sort(byName);
        await saveLists();
        refreshGroups();
        toast('Restored');
      },
    });
  };
  if (!confirm || victims.length === 1) return go();
  openDialog({
    title: `Delete ${plural(victims.length, 'list')}?`,
    confirmText: `Delete ${plural(victims.length, 'list')}`,
    danger: true,
    body: [h('p', { class: 'muted' }, 'Only the lists are removed. The groups in them stay saved.'), namesPreview(victims.map((l) => l.name))],
    onConfirm: () => {
      go();
      return true;
    },
  });
}

/**
 * Put groups into a list: an existing one (added to it, nothing removed) or a new one.
 * Used by "Save selection" in Compose and "Add to list" in the Groups tab.
 */
function openAddToList(ids, { title, prefer = 'existing', onDone } = {}) {
  ids = [...new Set(ids)];
  if (!ids.length) return toast('Select some groups first.', true);
  let mode = state.lists.length && prefer === 'existing' ? 'existing' : 'new';
  let target = null;

  const seg = h('div', { class: 'seg', role: 'tablist' });
  const pane = h('div', { class: 'stack' });
  const nameInput = h('input', { type: 'text', maxlength: 60, placeholder: 'e.g. Church groups' });
  const hint = h('p', { class: 'hint' });
  const freshIn = (l) => ids.filter((id) => !l.groupIds.includes(id)).length;

  const d = openDialog({
    title: title || `Add ${plural(ids.length, 'group')} to a list`,
    confirmText: 'Add',
    body: [seg, pane],
    onConfirm: () => {
      let list = mode === 'existing' ? target : findListByName(nameInput.value);
      let msg;
      if (list) {
        const added = addToList(list, ids);
        const already = ids.length - added;
        msg = added
          ? `Added ${plural(added, 'group')} to “${short(list.name)}”${already ? ` (${already} already in it)` : ''}`
          : `All of them are already in “${short(list.name)}”`;
      } else {
        const name = normName(nameInput.value);
        if (!name) return false;
        list = createList(name, ids);
        msg = `Saved list “${short(name)}” with ${plural(ids.length, 'group')}`;
      }
      saveLists();
      refreshGroups();
      toast(msg);
      onDone?.(list);
      return true;
    },
  });

  const sync = () => {
    if (mode === 'existing') {
      d.setConfirm(!!target, target ? `Add to “${short(target.name, 20)}”` : 'Choose a list');
      return;
    }
    const name = normName(nameInput.value);
    const clash = name && findListByName(name);
    hint.hidden = !clash;
    hint.textContent = clash
      ? `You already have a list called “${clash.name}”. These groups will be added to it, and nothing already in it is removed.`
      : '';
    d.setConfirm(!!name, clash ? `Add to “${short(clash.name, 20)}”` : 'Create list');
  };

  const drawPane = () => {
    if (mode === 'new') {
      pane.replaceChildren(h('label', {}, 'New list name'), nameInput, hint);
      setTimeout(() => nameInput.focus(), 30);
    } else {
      const rows = state.lists.map((l) => {
        const n = freshIn(l);
        const total = listMembers(l).length;
        const input = h('input', { type: 'radio', name: 'ritpost-target' });
        input.checked = target?.id === l.id;
        input.disabled = n === 0;
        input.addEventListener('change', () => {
          target = l;
          sync();
        });
        return h(
          'li',
          {},
          h(
            'label',
            { class: `pick radio${n === 0 ? ' disabled' : ''}` },
            input,
            h('span', { class: 'check' }),
            h('span', { class: 'list-icon', html: LIST_SVG }),
            h(
              'span',
              { class: 'name-wrap' },
              h('span', { class: 'name', title: l.name }, l.name),
              h('span', { class: 'sub' }, `${plural(total, 'group')} · `, n ? h('span', { class: 'plus' }, `+${n} new`) : 'all already in it')
            )
          )
        );
      });
      pane.replaceChildren(h('ul', { class: 'list' }, ...rows));
    }
    sync();
  };

  const drawSeg = () => {
    const opt = (key, label) =>
      h(
        'button',
        {
          type: 'button',
          class: mode === key ? 'on' : '',
          onclick: () => {
            mode = key;
            drawSeg();
            drawPane();
          },
        },
        label
      );
    seg.replaceChildren(...(state.lists.length ? [opt('existing', `Existing list (${state.lists.length})`)] : []), opt('new', 'New list'));
  };

  // Preselect the only sensible target.
  const candidates = state.lists.filter((l) => freshIn(l) > 0);
  if (candidates.length === 1) target = candidates[0];
  nameInput.addEventListener('input', sync);
  nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && $('modalConfirm').click());
  drawSeg();
  drawPane();
}

/** Create a list, or edit one: rename it and tick/untick the groups in it. */
function openListEditor(listId = null, { preselect = [] } = {}) {
  const list = listId ? state.lists.find((l) => l.id === listId) : null;
  if (listId && !list) return;
  const members = new Set(list ? listMembers(list) : preselect);
  const before = new Set(members);

  const nameInput = h('input', { type: 'text', maxlength: 60, placeholder: 'e.g. Church groups', value: list?.name || '' });
  const err = h('p', { class: 'field-error', hidden: true });
  const search = h('input', { type: 'search', placeholder: 'Search groups' });
  const count = h('span', { class: 'muted' });
  const ul = h('ul', { class: 'list' });
  let d;

  const sync = () => {
    const name = normName(nameInput.value);
    const clash = name && findListByName(name, listId);
    err.hidden = !clash;
    err.textContent = clash ? `You already have a list called “${clash.name}”. Pick another name.` : '';
    const added = [...members].filter((id) => !before.has(id)).length;
    const removed = [...before].filter((id) => !members.has(id)).length;
    const changes = list && (added || removed) ? ` · ${[added && `+${added}`, removed && `−${removed}`].filter(Boolean).join(' ')}` : '';
    count.textContent = `${plural(members.size, 'group')} in this list${changes}`;
    d.setConfirm(!!name && !clash, list ? 'Save changes' : `Create list${members.size ? ` · ${members.size}` : ''}`);
  };

  const draw = () => {
    const f = search.value.trim().toLowerCase();
    const shown = state.groups.filter((g) => g.name.toLowerCase().includes(f));
    const rows = shown.map((g) =>
      checkRow(g.name, members.has(g.id), (on) => {
        on ? members.add(g.id) : members.delete(g.id);
        sync();
      })
    );
    if (!state.groups.length) rows.push(h('li', { class: 'note' }, 'You have no saved groups yet. Import them first.'));
    else if (!rows.length) rows.push(h('li', { class: 'note' }, 'No groups match your search.'));
    ul.replaceChildren(...rows);
    return shown;
  };

  const body = [
    h('label', {}, 'List name'),
    nameInput,
    err,
    h(
      'div',
      { class: 'field-head' },
      h('label', {}, 'Groups in this list'),
      h(
        'span',
        { class: 'links' },
        h(
          'button',
          {
            type: 'button',
            class: 'link',
            onclick: () => {
              draw().forEach((g) => members.add(g.id));
              draw();
              sync();
            },
          },
          'Select shown'
        ),
        h('span', { class: 'sep' }, '·'),
        h(
          'button',
          {
            type: 'button',
            class: 'link',
            onclick: () => {
              draw().forEach((g) => members.delete(g.id));
              draw();
              sync();
            },
          },
          'Clear shown'
        )
      )
    ),
    state.groups.length >= 8 ? h('div', { class: 'search', html: $('filterWrap').querySelector('svg').outerHTML }, search) : null,
    ul,
    h(
      'div',
      { class: 'field-head' },
      count,
      list
        ? h(
            'button',
            {
              type: 'button',
              class: 'link danger',
              onclick: () => {
                closeDialog();
                deleteLists([list.id]);
              },
            },
            'Delete list'
          )
        : null
    ),
  ].filter(Boolean);

  d = openDialog({
    title: list ? 'Edit list' : 'New list',
    confirmText: list ? 'Save changes' : 'Create list',
    body,
    onConfirm: () => {
      const name = normName(nameInput.value);
      if (!name || findListByName(name, listId)) return false;
      // Keep the list's order for groups that stay, append the new ones.
      if (list) {
        list.name = name;
        list.groupIds = [...list.groupIds.filter((id) => members.has(id)), ...[...members].filter((id) => !list.groupIds.includes(id))];
        state.lists.sort(byName);
      } else createList(name, [...members]);
      saveLists();
      refreshGroups();
      toast(list ? `Saved “${short(name)}” · ${plural(members.size, 'group')}` : `Created list “${short(name)}” · ${plural(members.size, 'group')}`);
      return true;
    },
  });
  nameInput.addEventListener('input', sync);
  nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && $('modalConfirm').click());
  search.addEventListener('input', draw);
  draw();
  sync();
  setTimeout(() => (list && search.isConnected ? search : nameInput).focus(), 30);
}

// ─────────────── import from WhatsApp ───────────────
const KIND_LABEL = { group: 'Group', user: 'Contact', channel: 'Channel', broadcast: 'Broadcast', unknown: '' };

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
            const ids = savedNonGroups.map((g) => g.id).filter((id) => state.groups.some((g) => g.id === id));
            banner.remove();
            deleteGroups(ids, { message: `Removed ${plural(ids.length, 'contact')} from your group list` });
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
    facebook: fb.targets.map((t) => ({ name: t.name, url: t.url, kind: t.kind })),
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
    const added = addGroups(names.map((n) => (typeof n === 'string' ? n : n?.name)).filter(Boolean), { select: false });

    // Lists: new ones are created, lists you already have get the missing groups added.
    const idByKey = new Map(state.groups.map((g) => [keyOf(g.name), g.id]));
    let lists = 0;
    for (const l of Array.isArray(data.lists) ? data.lists : []) {
      const name = normName(l?.name);
      if (!name) continue;
      const ids = [...new Set((Array.isArray(l.groups) ? l.groups : []).map((n) => idByKey.get(keyOf(n))).filter(Boolean))];
      const existing = findListByName(name);
      if (existing) {
        if (addToList(existing, ids)) lists++;
      } else {
        createList(name, ids);
        lists++;
      }
    }
    let tpls = 0;
    for (const t of data.templates || []) {
      if (!t?.name || !t?.text || state.templates.some((x) => keyOf(x.name) === keyOf(t.name))) continue;
      state.templates.push({ id: uid(), name: t.name, text: t.text, createdAt: Date.now() });
      tpls++;
    }
    const fbEntries = (Array.isArray(data.facebook) ? data.facebook : [])
      .map((t) => {
        const p = parseFbUrl(t?.url);
        return p ? { ...p, name: t.name || p.slug, kind: t.kind === 'page' ? 'page' : p.kind } : null;
      })
      .filter(Boolean);
    const fbAdded = fbEntries.length ? fbAdd(fbEntries) : 0;
    saveLists();
    saveTemplates();
    renderAll();
    toast(`Restored ${plural(added, 'group')}, ${plural(lists, 'list')}, ${plural(tpls, 'template')}${fbAdded ? `, ${fbAdded} Facebook` : ''}`);
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
    const problem = fileProblem(f, total);
    if (problem) {
      problems.push(problem);
      if (problem.includes('64 MB')) break;
      continue;
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

/** Why a file can't be attached (or null). `otherBytes` is the size of the other attachments. */
function fileProblem(f, otherBytes) {
  if (!f.size) return `${f.name} is empty.`;
  if (f.size > MAX_FILE_BYTES) return `${f.name} is larger than 16 MB.`;
  if (otherBytes + f.size > MAX_TOTAL_BYTES) return 'Attachments are limited to 64 MB in total.';
  return null;
}

function attachmentsChanged() {
  saveAttachments();
  renderAttachments();
  renderCounts();
}

/** Put removed attachments back where they were. */
function restoreAttachments(removed) {
  for (const { item, index } of [...removed].sort((a, b) => a.index - b.index)) {
    if (state.attachments.length >= MAX_FILES || state.attachments.some((a) => a.id === item.id)) continue;
    state.attachments.splice(Math.min(index, state.attachments.length), 0, item);
  }
  attachmentsChanged();
}

function removeAttachment(id) {
  const index = state.attachments.findIndex((a) => a.id === id);
  if (index < 0) return;
  const [item] = state.attachments.splice(index, 1);
  attachmentsChanged();
  toast(`Removed ${item.name}`, false, { label: 'Undo', run: () => restoreAttachments([{ item, index }]) });
}

function removeAllAttachments() {
  if (!state.attachments.length) return;
  const removed = state.attachments.map((item, index) => ({ item, index }));
  state.attachments = [];
  attachmentsChanged();
  toast(`Removed ${plural(removed.length, 'file')}`, false, { label: 'Undo', run: () => restoreAttachments(removed) });
}

/** Swap one attachment for another file, in the same place. */
let replacingId = null;
function pickReplacement(id) {
  replacingId = id;
  $('replaceInput').click();
}
async function replaceAttachment(id, file) {
  const index = state.attachments.findIndex((a) => a.id === id);
  if (index < 0 || !file) return;
  const old = state.attachments[index];
  const others = state.attachments.reduce((s, a) => s + (a.id === id ? 0 : a.size || 0), 0);
  const problem = fileProblem(file, others);
  if (problem) return toast(problem, true);
  let data;
  try {
    data = await readAsDataURL(file);
  } catch {
    return toast(`${file.name} couldn’t be read.`, true);
  }
  const fresh = { id: uid(), name: file.name, type: file.type || 'application/octet-stream', size: file.size, data };
  state.attachments.splice(index, 1, fresh);
  try {
    await saveAttachments();
  } catch (e) {
    state.attachments.splice(index, 1, old);
    renderAttachments();
    return toast(`Couldn’t save ${file.name}: ${e?.message || e}`, true);
  }
  renderAttachments();
  renderCounts();
  document.querySelector(`[data-attach-id="${fresh.id}"]`)?.classList.add('replaced');
  toast(`Replaced ${old.name} with ${file.name}`, false, {
    label: 'Undo',
    run: () => {
      const i = state.attachments.findIndex((a) => a.id === fresh.id);
      if (i < 0) return;
      state.attachments.splice(i, 1, old);
      attachmentsChanged();
    },
  });
}

const PLAY_SVG = '<svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M6 4.5v11l9-5.5-9-5.5Z"/></svg>';

/** The note under the attachments, and the "send the link separately" choice when the message has a link. */
function renderAttachNote() {
  const msg = state.message.trim();
  const n = state.attachments.length;
  const linkCase = n > 0 && /(https?:\/\/|www\.)\S+/i.test(msg);
  const separate = linkCase && state.settings.linkSeparate !== false;
  $('linkSepRow').hidden = !linkCase;
  $('linkSep').checked = state.settings.linkSeparate !== false;
  $('attachNote').textContent = !msg
    ? 'Files will be sent without a caption. Write a message above to add one.'
    : separate
      ? 'Files are sent first, then your message as its own text with the link preview.'
      : 'Your message is sent as the caption.';
}

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
        { class: 'attach-item', 'data-attach-id': a.id },
        thumb,
        h('span', { class: 'attach-meta' }, h('span', { class: 'attach-name', title: a.name }, a.name), h('span', { class: 'attach-size' }, formatBytes(a.size))),
        h(
          'span',
          { class: 'attach-actions' },
          h('button', { type: 'button', class: 'attach-act', title: 'Choose another file instead', 'aria-label': `Replace ${a.name}`, onclick: () => pickReplacement(a.id) }, 'Replace'),
          h('button', { type: 'button', class: 'attach-act del', title: 'Remove this file', 'aria-label': `Remove ${a.name}`, onclick: () => removeAttachment(a.id) }, 'Remove')
        )
      );
    })
  );
  const n = state.attachments.length;
  list.hidden = !n;
  $('attachNote').hidden = !n;
  renderAttachNote();
  $('attachClear').hidden = n < 2;
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

// ─────────────── Facebook ───────────────
const FB_MIN_GAP = 30; // seconds, manual mode
const FB_MIN_INTERVAL_MIN = 2; // minutes, automatic mode
const FB_DEFAULTS = { mode: 'manual', gapSec: 60, intervalMin: 5, dailyLimit: 20, reviewSec: 10, linkPreview: true };
const fb = { targets: [], selected: new Set(), settings: { ...FB_DEFAULTS }, run: null, filter: '', kind: 'group', daily: 0 };
const isMedia = (a) => /^(image|video)\//.test(a?.type || '');
/** Facebook shows a link preview only for posts without photos/videos. */
const hasLink = (s) => /(https?:\/\/|www\.)\S+/i.test(s || '');

/** Normalise a Facebook link; returns { url, kind, slug } or null. */
function parseFbUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!/(^|\.)facebook\.com$|(^|\.)fb\.com$/i.test(u.hostname)) return null;
  const path = u.pathname.replace(/\/+$/, '');
  const g = path.match(/^\/groups\/([^/]+)/i);
  if (g) return { url: `https://www.facebook.com/groups/${g[1]}/`, kind: 'group', slug: decodeURIComponent(g[1]) };
  if (/^\/profile\.php$/i.test(path) && u.searchParams.get('id'))
    return { url: `https://www.facebook.com/profile.php?id=${u.searchParams.get('id')}`, kind: 'page', slug: u.searchParams.get('id') };
  const p = path.match(/^\/(?:pg\/)?([^/]+)/);
  if (!p || /^(home\.php|watch|marketplace|gaming|events|friends|messages|notifications|login|groups|pages)$/i.test(p[1])) return null;
  return { url: `https://www.facebook.com/${p[1]}`, kind: 'page', slug: decodeURIComponent(p[1]) };
}
const fbKey = (url) => String(url).toLowerCase().replace(/\/+$/, '');
/** Strip labels Facebook puts on pictures ("Profile picture for …") from imported names. */
const cleanFbName = (s) =>
  normName(String(s || '').replace(/^(profile picture|profile photo|cover photo|picture|photo|avatar)\s+(for|of)\s+/i, ''));

async function fbLoad() {
  const d = await chrome.storage.local.get(['fbTargets', 'fbSelected', 'fbSettings', 'fbRun', 'fbDaily']);
  const raw = Array.isArray(d.fbTargets) ? d.fbTargets : [];
  fb.targets = raw
    .filter((t) => t?.id && t?.url && t?.name)
    .map((t) => ({ ...t, name: cleanFbName(t.name) || t.name, kind: t.kind === 'page' ? 'page' : 'group' }))
    .sort(byName);
  // Repair names saved by 1.7.x ("Profile picture for …").
  if (raw.some((t) => t?.name && cleanFbName(t.name) !== t.name)) persist({ fbTargets: fb.targets });
  const ids = new Set(fb.targets.map((t) => t.id));
  fb.selected = new Set((d.fbSelected || []).filter((id) => ids.has(id)));
  const s = { ...FB_DEFAULTS, ...(d.fbSettings || {}) };
  fb.settings = {
    mode: s.mode === 'auto' ? 'auto' : 'manual',
    gapSec: Math.min(900, Math.max(FB_MIN_GAP, Number(s.gapSec) || 60)),
    intervalMin: Math.min(60, Math.max(FB_MIN_INTERVAL_MIN, Number(s.intervalMin) || 5)),
    dailyLimit: Math.min(50, Math.max(1, Number(s.dailyLimit) || 20)),
    reviewSec: Math.min(120, Math.max(5, Number(s.reviewSec) || 10)),
    linkPreview: s.linkPreview !== false,
  };
  fb.run = d.fbRun || null;
  fb.daily = d.fbDaily?.day === new Date().toISOString().slice(0, 10) ? d.fbDaily.count : 0;
}
const fbSave = () => persist({ fbTargets: fb.targets, fbSelected: [...fb.selected] });
const fbSaveSettings = () => persist({ fbSettings: fb.settings });

/** WhatsApp marks (*bold*, _italic_, ~strike~, ```mono```) don't format on Facebook. */
function fbText(text) {
  return String(text || '')
    .replace(/```([\s\S]+?)```/g, '$1')
    .replace(/(^|[\s(])([*_~])(?=\S)([^\n]*?\S)\2(?=$|[\s).,!?:;])/gm, '$1$3');
}

const fbOf = (kind) => fb.targets.filter((t) => t.kind === kind);
const fbSelOf = (kind) => fb.targets.filter((t) => t.kind === kind && fb.selected.has(t.id));
function fbWhat(groups, pages) {
  const parts = [];
  if (groups) parts.push(plural(groups, 'group'));
  if (pages) parts.push(`${pages} Page${pages === 1 ? '' : 's'}`);
  return parts.join(' + ');
}

function fbAdd(entries) {
  const have = new Set(fb.targets.map((t) => fbKey(t.url)));
  let added = 0;
  for (const e of entries) {
    if (!e?.url || have.has(fbKey(e.url))) continue;
    have.add(fbKey(e.url));
    fb.targets.push({ id: uid(), name: cleanFbName(e.name) || e.url, url: e.url, kind: e.kind === 'page' ? 'page' : 'group', addedAt: Date.now() });
    added++;
  }
  fb.targets.sort(byName);
  fbSave();
  renderFb();
  return added;
}

function fbDelete(id) {
  const t = fb.targets.find((x) => x.id === id);
  if (!t) return;
  const before = { targets: [...fb.targets], selected: new Set(fb.selected) };
  fb.targets = fb.targets.filter((x) => x.id !== id);
  fb.selected.delete(id);
  fbSave();
  renderFb();
  toast(`Removed ${short(t.name)}`, false, {
    label: 'Undo',
    run: () => {
      fb.targets = before.targets;
      fb.selected = before.selected;
      fbSave();
      renderFb();
    },
  });
}

function fbActive() {
  return !!fb.run && (fb.run.status === 'running' || fb.run.status === 'waiting');
}

function renderFbKind() {
  const isPage = fb.kind === 'page';
  document.querySelectorAll('#fbKindSeg button').forEach((b) => {
    const on = b.dataset.kind === fb.kind;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  $('fbGroupCount').textContent = String(fbOf('group').length);
  $('fbPageCount').textContent = String(fbOf('page').length);
  $('fbImportLabel').textContent = isPage ? 'Import Pages I manage' : 'Import my Facebook groups';
  $('fbUrl').placeholder = isPage ? 'Paste a Page link (facebook.com/YourPage)' : 'Paste a group link (facebook.com/groups/…)';
  $('fbListTitle').textContent = isPage ? 'Pages' : 'Groups';
  $('fbFilter').placeholder = isPage ? 'Filter Pages' : 'Filter groups';
}

function renderFbList() {
  const list = $('fbList');
  const q = keyOf(fb.filter);
  const ofKind = fbOf(fb.kind);
  const shown = ofKind.filter((t) => !q || keyOf(t.name).includes(q) || t.url.toLowerCase().includes(q));
  const results = new Map((fb.run?.results || []).map((r) => [r.id, r.status]));
  list.replaceChildren(
    ...shown.map((t) => {
      const st = results.get(t.id);
      const tag =
        st === 'posted'
          ? h('span', { class: 'kind-tag ok' }, 'Posted')
          : st === 'failed' || st === 'skipped'
          ? h('span', { class: 'kind-tag fail' }, st === 'failed' ? 'Failed' : 'Skipped')
          : null;
      const del = h(
        'button',
        {
          type: 'button',
          class: 'row-del',
          title: 'Remove',
          'aria-label': `Remove ${t.name}`,
          onclick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            fbDelete(t.id);
          },
        },
        '✕'
      );
      const row = checkRow(
        t.name,
        fb.selected.has(t.id),
        (on) => {
          if (on) fb.selected.add(t.id);
          else fb.selected.delete(t.id);
          persist({ fbSelected: [...fb.selected] });
          renderFbCounts();
        },
        h('span', { class: 'row-extra' }, tag, del)
      );
      row.querySelector('.name').title = `${t.name}\n${t.url}`;
      return row;
    })
  );
  if (!shown.length && ofKind.length) list.append(h('li', { class: 'note' }, 'No matches'));
  list.hidden = !ofKind.length;
  $('fbFilterWrap').hidden = ofKind.length < 8;
  const empty = $('fbEmpty');
  empty.hidden = !!ofKind.length;
  empty.replaceChildren(
    ...(fb.kind === 'page'
      ? [
          h('p', {}, h('strong', {}, 'No Pages yet')),
          h('p', { class: 'muted' }, 'Import the Pages you manage, or paste a Page link above. When it’s a Page’s turn, RitPost switches to the Page’s profile so the post comes from your Page.'),
        ]
      : [h('p', {}, h('strong', {}, 'No Facebook groups yet')), h('p', { class: 'muted' }, 'Import the groups you’ve joined, or paste a group link above.')])
  );
}

function renderFbMessage() {
  const el = $('fbMsgPreview');
  const text = fbText(state.message.trim());
  const media = state.attachments.filter(isMedia).length;
  const conflict = media > 0 && hasLink(text);
  const dropMedia = conflict && fb.settings.linkPreview;
  const extra = media ? (dropMedia ? `📎 ${plural(media, 'photo/video')} (left out on Facebook, for the link preview)` : `📎 ${plural(media, 'photo/video')}`) : '';
  el.textContent = text ? (extra ? `${text}\n\n${extra}` : text) : extra || 'Write your message in the Compose tab first.';
  el.classList.toggle('empty-msg', !text && !media);
  const note = $('fbLinkNote');
  note.hidden = !conflict;
  if (conflict)
    note.textContent = dropMedia
      ? 'Your message has a link: RitPost leaves the photos/videos out on Facebook so the link preview shows. You can change this when you start.'
      : 'Facebook doesn’t show a link preview on posts with photos/videos. Your photos/videos will be posted and the link stays as plain text. You can change this when you start.';
}

function renderFbMode() {
  const auto = fb.settings.mode === 'auto';
  document.querySelectorAll('#fbModeSeg button').forEach((b) => {
    const on = b.dataset.mode === fb.settings.mode;
    b.classList.toggle('on', on);
    b.classList.toggle('auto', on && auto);
    b.setAttribute('aria-checked', String(on));
  });
  $('fbGapRow').hidden = auto;
  $('fbAutoRows').hidden = !auto;
  $('fbGap').value = String(fb.settings.gapSec);
  $('fbInterval').value = String(fb.settings.intervalMin);
  $('fbDailyLimit').value = String(fb.settings.dailyLimit);
  $('fbReview').value = String(fb.settings.reviewSec);
  $('fbTodayCount').textContent = `Posted today: ${fb.daily}.`;
  $('fbModeHint').textContent = auto
    ? `RitPost fills in each post, gives you ${fb.settings.reviewSec} s to check it and clicks Next; you click Post to publish. It waits ${fb.settings.intervalMin}–${Math.round(fb.settings.intervalMin * 1.3)} minutes between posts, stops at ${fb.settings.dailyLimit} posts a day, and stops at once if Facebook shows a posting limit.`
    : 'RitPost fills in each post; you check it and click Post yourself.';
}

function renderFbCounts() {
  const g = fbSelOf('group').length;
  const p = fbSelOf('page').length;
  const n = g + p;
  const ofKind = fbOf(fb.kind);
  const selKind = fbSelOf(fb.kind).length;
  $('fbCount').textContent = String(fb.targets.length);
  $('fbGroupCount').textContent = String(fbOf('group').length);
  $('fbPageCount').textContent = String(fbOf('page').length);
  $('fbSelCount').textContent = ofKind.length ? `(${selKind} of ${ofKind.length})` : '';
  $('fbSelSummary').textContent = n ? `Selected: ${fbWhat(g, p)}${g && p ? ' (groups first, then Pages)' : ''}` : '';
  const hasContent = !!state.message.trim() || state.attachments.some(isMedia);
  $('fbStartBtn').disabled = !n || !hasContent || fbActive();
  $('fbStartLabel').textContent = fbActive()
    ? 'Posting to Facebook…'
    : !hasContent
    ? 'Write a message first'
    : n
    ? `${fb.settings.mode === 'auto' ? 'Auto-post' : 'Post'} to ${fbWhat(g, p)}`
    : 'Pick groups or Pages';
}

function renderFbRun() {
  const r = fb.run;
  const active = fbActive();
  $('fbRunBox').hidden = !active;
  if (active) {
    $('fbRunTitle').textContent =
      r.status === 'waiting' ? 'Waiting before the next post…' : `Posting: ${short(r.items[r.index]?.name || '', 30)}`;
    $('fbRunMeta').textContent = `${Math.min(r.index + 1, r.items.length)} of ${r.items.length}${r.mode === 'auto' ? ' · Automatic' : ''}`;
    $('fbRunFill').style.width = `${Math.round((r.index / r.items.length) * 100)}%`;
  }
  const last = $('fbLastRun');
  if (!active && r?.results?.length) {
    const okIds = new Set(r.results.filter((x) => x.status === 'posted').map((x) => x.id));
    const notDone = r.items.length - okIds.size;
    last.hidden = false;
    last.replaceChildren(
      h('span', {}, `${r.status === 'stopped' ? 'Stopped' : 'Last Facebook session'}: ${okIds.size} of ${r.items.length} posted · ${timeAgo(r.finishedAt || r.startedAt)}`),
      r.stopReason ? h('div', { class: 'stop-reason' }, r.stopReason) : null,
      notDone
        ? h(
            'button',
            {
              type: 'button',
              class: 'link',
              onclick: () => {
                fb.selected = new Set(r.items.map((x) => x.id).filter((id) => !okIds.has(id) && fb.targets.some((t) => t.id === id)));
                persist({ fbSelected: [...fb.selected] });
                renderFb();
                toast(`Selected ${fbWhat(fbSelOf('group').length, fbSelOf('page').length)} not posted yet`);
              },
            },
            'Select unposted'
          )
        : null
    );
  } else last.hidden = true;
  renderFbCounts();
}

function renderFb() {
  renderFbKind();
  renderFbMessage();
  renderFbMode();
  renderFbList();
  renderFbRun();
}

async function fbImport() {
  const kind = fb.kind;
  const btn = $('fbImportBtn');
  const label = $('fbImportLabel');
  const old = label.textContent;
  btn.disabled = true;
  label.textContent = kind === 'page' ? 'Reading your Pages on Facebook…' : 'Reading your groups on Facebook…';
  try {
    const res = await bg('BG_FB_SCAN', { kind: kind === 'page' ? 'pages' : 'groups' });
    const items = res?.items || res?.groups || [];
    if (!res?.ok) return toast(res?.error || 'Couldn’t read Facebook.', true);
    if (!items.length)
      return toast(
        kind === 'page'
          ? 'No Pages found. Make sure you’re signed in as yourself (not as a Page) and manage at least one Page.'
          : 'No groups found. Make sure you’re signed in to Facebook and have joined some groups.',
        true
      );
    const added = fbAdd(items.map((g) => ({ ...g, kind })));
    const noun = kind === 'page' ? 'Page' : 'group';
    toast(added ? `Imported ${added} ${noun}${added === 1 ? '' : 's'} (${items.length} found)` : `All ${items.length} ${noun}s were already saved`);
  } finally {
    btn.disabled = false;
    label.textContent = old;
  }
}

function confirmFbAuto() {
  return new Promise((resolve) => {
    openDialog({
      title: 'Turn on automatic Facebook posting?',
      confirmText: 'Turn on automatic',
      body: [
        h('p', {}, 'RitPost opens each group or Page, switches profile, fills in your post and clicks Next by itself after a review countdown. You click Post to publish each one; RitPost then carries on with the next.'),
        h(
          'ul',
          { class: 'risk' },
          h('li', {}, 'Facebook’s terms don’t allow automated posting, and no interval is guaranteed to be safe. Facebook can hold posts for review, limit your posting or restrict your account.'),
          h('li', {}, `To keep the risk low, RitPost waits at least ${FB_MIN_INTERVAL_MIN} minutes between posts (5 by default, randomised), stops at your daily limit (20 by default), and stops at once if Facebook shows a “temporarily blocked” or posting-limit message.`),
          h('li', {}, 'Post only to groups that welcome your posts and follow each group’s rules. Repeating the same post in many groups is what Facebook flags most.')
        ),
        h('p', { class: 'muted' }, 'Every post shows a countdown with Post now, Hold, Skip and Stop. You can switch back to Manual at any time.'),
      ],
      onConfirm: () => {
        resolve(true);
        return true;
      },
      onCancel: () => resolve(false),
    });
  });
}

async function fbSetMode(mode) {
  if (mode === fb.settings.mode) return;
  if (mode === 'auto' && !(await confirmFbAuto())) return;
  fb.settings.mode = mode;
  fbSaveSettings();
  renderFbMode();
  renderFbCounts();
  toast(mode === 'auto' ? 'Automatic Facebook posting on' : 'Manual Facebook posting');
}

function fbConfirmStart() {
  if (fbActive()) return;
  // Groups first (posted as you), then Pages (RitPost switches to each Page's profile).
  const items = [...fbSelOf('group'), ...fbSelOf('page')];
  if (!items.length) return;
  const message = state.message.trim();
  const media = state.attachments.filter(isMedia);
  if (!message && !media.length) return;
  const g = fbSelOf('group').length;
  const p = fbSelOf('page').length;
  const docs = state.attachments.length - media.length;
  const auto = fb.settings.mode === 'auto';
  // Facebook drops the link preview as soon as a photo/video is added (checked live), so let the user pick.
  const conflict = media.length > 0 && hasLink(message);
  let keepPreview = fb.settings.linkPreview;
  const choice = (value, title, sub) =>
    h(
      'label',
      {},
      h('input', {
        type: 'radio',
        name: 'fbLinkChoice',
        value,
        checked: (value === 'preview') === keepPreview,
        onchange: () => (keepPreview = value === 'preview'),
      }),
      h('span', {}, h('b', {}, title), h('br'), sub)
    );
  const remainingToday = Math.max(0, fb.settings.dailyLimit - fb.daily);
  if (auto && !remainingToday) return toast(`Today’s limit of ${fb.settings.dailyLimit} Facebook posts is reached. Continue tomorrow, or raise the limit.`, true);
  openDialog({
    title: `${auto ? 'Auto-post' : 'Post'} to ${fbWhat(g, p)}`,
    confirmText: 'Start',
    body: h(
      'div',
      {},
      auto
        ? h('p', {}, `RitPost opens each one, fills in your message and photos/videos, gives you ${fb.settings.reviewSec} s to check it and clicks Next. `, h('b', {}, 'You click Post to publish each one.'), ` It waits about ${fb.settings.intervalMin}–${Math.round(fb.settings.intervalMin * 1.3)} minutes between posts.`)
        : h('p', {}, 'RitPost opens each one, fills in your message and photos/videos. ', h('b', {}, 'You check the post and click Post yourself.'), ` RitPost then waits about ${fb.settings.gapSec} s before the next one.`),
      auto && items.length > remainingToday
        ? h('p', { class: 'muted' }, `Only ${remainingToday} more post${remainingToday === 1 ? '' : 's'} fit today’s limit; RitPost stops there and you can continue tomorrow with “Select unposted”.`)
        : null,
      auto ? h('p', { class: 'muted' }, `This takes roughly ${Math.round((Math.min(items.length, remainingToday) - 1) * fb.settings.intervalMin * 1.15)} minutes. Keep the Facebook tab open; you can use other tabs meanwhile.`) : null,
      p ? h('p', { class: 'muted' }, 'Pages come after groups. When it’s a Page’s turn, RitPost switches to that Page’s profile by itself so the post comes from the Page, and switches back to your profile for any group that follows. At the end, the Facebook panel offers “Switch back to my profile”.') : null,
      docs ? h('p', { class: 'muted' }, `${plural(docs, 'document')} will be left out (Facebook gets photos and videos only).`) : null,
      conflict
        ? h(
            'div',
            {},
            h('p', { class: 'muted' }, 'Your message has a link, and Facebook doesn’t show a link preview on posts with photos or videos.'),
            h(
              'div',
              { class: 'link-choice' },
              choice('preview', 'Show the link preview', `Post the text and link only; leave out ${plural(media.length, 'photo/video')}.`),
              choice('media', 'Post the photos/videos', 'The link stays as plain text, with no preview.')
            )
          )
        : null
    ),
    onConfirm: () => {
      if (conflict && keepPreview !== fb.settings.linkPreview) {
        fb.settings.linkPreview = keepPreview;
        fbSaveSettings();
        renderFbMessage();
      }
      const sendMedia = !(conflict && keepPreview);
      (async () => {
        const run = {
          items: items.map((t) => ({ id: t.id, name: t.name, url: t.url, kind: t.kind, text: fbText(message.replaceAll('{group}', t.name)) })),
          attachmentIds: sendMedia ? media.map((a) => a.id) : [],
          linkPreview: !sendMedia || !media.length,
          mode: fb.settings.mode,
          gapSec: fb.settings.gapSec,
          intervalSec: fb.settings.intervalMin * 60,
          dailyLimit: fb.settings.dailyLimit,
          reviewSec: fb.settings.reviewSec,
        };
        $('fbStartBtn').disabled = true;
        const res = await bg('BG_FB_START', { run });
        if (res?.ok) toast(auto ? `Automatic Facebook posting started: ${fbWhat(g, p)}.` : `Facebook posting started: ${fbWhat(g, p)}. Click Post on Facebook for each one.`);
        else {
          toast(res?.error || 'Couldn’t open Facebook.', true);
          renderFbCounts();
        }
      })();
      return true;
    },
  });
}

function fbNumber(id, key, min, max, fallback, label, unit) {
  $(id).addEventListener('change', (e) => {
    fb.settings[key] = Math.min(max, Math.max(min, Math.round(Number(e.target.value) || fallback)));
    e.target.value = String(fb.settings[key]);
    fbSaveSettings();
    renderFbMode();
    toast(`${label}: ${fb.settings[key]} ${unit}`);
  });
}

function fbBind() {
  document.querySelectorAll('#fbKindSeg button').forEach((b) =>
    b.addEventListener('click', () => {
      fb.kind = b.dataset.kind;
      fb.filter = '';
      $('fbFilter').value = '';
      renderFbKind();
      renderFbList();
      renderFbCounts();
    })
  );
  document.querySelectorAll('#fbModeSeg button').forEach((b) => b.addEventListener('click', () => fbSetMode(b.dataset.mode)));
  $('fbImportBtn').addEventListener('click', fbImport);
  $('fbAddForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const parsed = parseFbUrl($('fbUrl').value);
    if (!parsed) return toast('That isn’t a Facebook group or Page link.', true);
    const name = normName($('fbName').value) || parsed.slug.replace(/[-_.]+/g, ' ');
    if (!fbAdd([{ ...parsed, name }])) return toast('That link is already saved.', true);
    const t = fb.targets.find((x) => fbKey(x.url) === fbKey(parsed.url));
    if (t) fb.selected.add(t.id);
    fb.kind = parsed.kind;
    fbSave();
    renderFb();
    $('fbUrl').value = '';
    $('fbName').value = '';
    toast(`Added ${parsed.kind === 'page' ? 'Page' : 'group'}: ${short(name)}`);
  });
  $('fbFilter').addEventListener('input', (e) => {
    fb.filter = e.target.value;
    renderFbList();
  });
  $('fbSelAll').addEventListener('click', () => {
    fbOf(fb.kind).forEach((t) => fb.selected.add(t.id));
    persist({ fbSelected: [...fb.selected] });
    renderFbList();
    renderFbCounts();
  });
  $('fbSelNone').addEventListener('click', () => {
    fbOf(fb.kind).forEach((t) => fb.selected.delete(t.id));
    persist({ fbSelected: [...fb.selected] });
    renderFbList();
    renderFbCounts();
  });
  fbNumber('fbGap', 'gapSec', FB_MIN_GAP, 900, 60, 'Wait between posts', 's');
  fbNumber('fbInterval', 'intervalMin', FB_MIN_INTERVAL_MIN, 60, 5, 'Interval between posts', 'min');
  fbNumber('fbDailyLimit', 'dailyLimit', 1, 50, 20, 'Daily limit', 'posts');
  fbNumber('fbReview', 'reviewSec', 5, 120, 10, 'Review time', 's');
  $('fbStartBtn').addEventListener('click', fbConfirmStart);
  $('fbRunFocus').addEventListener('click', () => bg('BG_FB_OPEN'));
  $('fbRunStop').addEventListener('click', async () => {
    await bg('BG_FB_STOP');
    toast('Facebook posting stopped');
  });
  $('message').addEventListener('input', () => {
    renderFbMessage();
    renderFbCounts();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.fbRun) {
      fb.run = changes.fbRun.newValue || null;
      renderFbRun();
      renderFbList();
    }
    if (changes.fbDaily) {
      const d = changes.fbDaily.newValue;
      fb.daily = d?.day === new Date().toISOString().slice(0, 10) ? d.count : 0;
      renderFbMode();
    }
    if (changes.attachments || changes.message) {
      renderFbMessage();
      renderFbCounts();
    }
    if (changes.fbTargets || changes.fbSelected) fbLoad().then(renderFb);
  });
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

  // Groups tab: bulk actions on ticked groups.
  $('mSelAll').addEventListener('click', () => {
    const shown = manageVisible();
    const allShown = shown.length > 0 && shown.every((g) => state.manageSel.has(g.id));
    shown.forEach((g) => (allShown ? state.manageSel.delete(g.id) : state.manageSel.add(g.id)));
    renderManageList();
  });
  $('bulkClear').addEventListener('click', () => {
    state.manageSel.clear();
    renderManageList();
  });
  $('bulkDelete').addEventListener('click', () => deleteGroups([...state.manageSel], { confirm: true }));
  $('bulkAddList').addEventListener('click', () =>
    openAddToList([...state.manageSel], {
      onDone: () => {
        state.manageSel.clear();
        renderManageList();
      },
    })
  );
  $('bulkUse').addEventListener('click', () => {
    state.selected = new Set(state.manageSel);
    saveSelected();
    switchTab('compose');
    refreshGroups();
    toast(`Selected ${plural(state.selected.size, 'group')} for sending`);
  });

  // Groups tab: lists.
  $('newListBtn').addEventListener('click', () => openListEditor(null, { preselect: [...state.manageSel] }));
  $('listSelAll').addEventListener('click', () => {
    if (state.listSel.size === state.lists.length) state.listSel.clear();
    else state.lists.forEach((l) => state.listSel.add(l.id));
    renderListManager();
  });
  $('listBulkClear').addEventListener('click', () => {
    state.listSel.clear();
    renderListManager();
  });
  $('listBulkDelete').addEventListener('click', () => deleteLists([...state.listSel], { confirm: true }));

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
  document.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', () => closeDialog()));
  $('modal').addEventListener('click', (e) => e.target.id === 'modal' && closeDialog());
  $('modalConfirm').addEventListener('click', () => {
    const fn = dialogConfirm;
    if (!fn || $('modalConfirm').disabled) return;
    // Don't close a dialog that the confirm handler itself opened.
    if (fn() !== false && dialogConfirm === fn) closeDialog(true);
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
      danger: true,
      body: h('p', { class: 'muted' }, 'This deletes all saved groups, lists, templates, your draft and session history from this browser. It cannot be undone.'),
      onConfirm: () => {
        (async () => {
          await chrome.storage.local.clear();
          await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
          await load();
          await fbLoad();
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
  $('attachClear').addEventListener('click', removeAllAttachments);
  $('linkSep').addEventListener('change', (e) => {
    state.settings.linkSeparate = e.target.checked;
    renderAttachNote();
    saveSettings(e.target.checked ? 'Message sent separately, with the link preview' : 'Message sent as the caption (no link preview)');
  });
  $('replaceInput').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (replacingId && file) replaceAttachment(replacingId, file);
    replacingId = null;
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
      } else if (!$('tab-groups').hidden && (state.manageSel.size || state.listSel.size)) {
        e.preventDefault();
        state.manageSel.clear();
        state.listSel.clear();
        refreshGroups();
      }
    }
    // Delete key in the Groups tab deletes the ticked groups (asks first).
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && document.activeElement.type !== 'checkbox';
    if (e.key === 'Delete' && !typing && $('modal').hidden && !$('tab-groups').hidden && state.manageSel.size) {
      e.preventDefault();
      deleteGroups([...state.manageSel], { confirm: true });
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && $('modal').hidden && !$('startBtn').disabled) start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && GROUP_KEYS.some((k) => changes[k])) syncFromStorageSoon();
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
  await fbLoad();
  bind();
  fbBind();
  renderAll();
  $('version').textContent = `RitPost v${chrome.runtime.getManifest().version}`;

  // Opened while on Facebook: show the Facebook tab. Otherwise bring WhatsApp Web up beside the panel.
  let onFacebook = false;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    onFacebook = /^https:\/\/([a-z0-9-]+\.)*facebook\.com\//i.test(tab?.url || '');
  } catch {
    /* no tab info */
  }
  if (onFacebook) switchTab('facebook');
  else {
    const s = await bg('BG_STATUS');
    if (!s?.open || !s?.active) await bg('BG_OPEN');
  }
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
