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
  setTimeout(() => typeof renderPlanNote === 'function' && renderPlanNote(), 0);
  $('fbStartBtn').hidden = name !== 'facebook';
  $('socStartBtn').hidden = name !== 'social';
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
  if ($('socTagsMenu')) $('socTagsMenu').hidden = true;
  if ($('fbTagsMenu')) $('fbTagsMenu').hidden = true;
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
  renderSoc();
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
    hashtags: soc.settings.tags,
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
    for (const t of Array.isArray(data.hashtags) ? data.hashtags : []) {
      if (!t?.name || !t?.text || soc.settings.tags.some((x) => keyOf(x.name) === keyOf(t.name))) continue;
      soc.settings.tags.push({ name: String(t.name), text: String(t.text) });
    }
    socSave();
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
        h('span', { class: 'attach-meta' }, h('span', { class: 'attach-name', title: a.name }, a.name), h('span', { class: 'attach-size' }, formatBytes(a.size), a.edit ? h('span', { class: 'edited-tag' }, ' · edited') : null)),
        h(
          'span',
          { class: 'attach-actions' },
          a.type.startsWith('image/')
            ? h('button', { type: 'button', class: 'attach-act', title: 'Crop, filters, text and stickers', 'aria-label': `Edit ${a.name}`, onclick: () => openStudio(a.id) }, 'Edit')
            : null,
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
  $('studioBtn').hidden = !state.attachments.some((a) => a.type.startsWith('image/'));
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
    if (!planBlocked(res)) toast(res?.error || 'Couldn’t start. Make sure WhatsApp Web is open and signed in.', true);
    renderCounts();
  }
}

// ─────────────── Facebook ───────────────
const FB_MIN_GAP = 30; // seconds, manual mode
const FB_MIN_INTERVAL_MIN = 2; // minutes, automatic mode
const FB_DEFAULTS = { mode: 'manual', gapSec: 60, intervalMin: 5, dailyLimit: 20, reviewSec: 10, linkPreview: true, same: true, text: '' };
const FB_MAX_TEXT = 63206; // Facebook's post length limit
const fb = { targets: [], selected: new Set(), settings: { ...FB_DEFAULTS }, run: null, filter: '', kind: 'group', daily: 0, preview: false };
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
    same: s.same !== false,
    text: typeof s.text === 'string' ? s.text.slice(0, FB_MAX_TEXT) : '',
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

/** The text posted on Facebook: the Compose message, or the separate Facebook post. */
const fbMessage = () => (fb.settings.same ? fbText(state.message) : fb.settings.text);
/** Start a separate Facebook post from the Compose message. */
function fbDetach() {
  if (!fb.settings.same) return;
  fb.settings.text = fbText(state.message);
  fb.settings.same = false;
}
function fbInsertAtCursor(text, { block = false } = {}) {
  const ta = $('fbCaption');
  fbDetach();
  const cur = fb.settings.text;
  const focused = ta.value === cur; // a textarea keeps its caret after losing focus
  let s = focused ? ta.selectionStart : cur.length;
  let e = focused ? ta.selectionEnd : cur.length;
  let ins = text;
  if (block && cur.trim()) {
    const head = cur.slice(0, s).replace(/\s+$/, '');
    fb.settings.text = `${head}\n\n${text}${cur.slice(e)}`;
    s = e = head.length + 2 + text.length;
  } else {
    fb.settings.text = cur.slice(0, s) + ins + cur.slice(e);
    s = e = s + ins.length;
  }
  fbSaveSettings();
  renderFbMessage();
  renderFbCounts();
  ta.focus();
  ta.setSelectionRange(s, e);
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
  const ta = $('fbCaption');
  const val = fbMessage();
  if (document.activeElement !== ta || ta.value !== val) ta.value = val;
  ta.classList.toggle('following', fb.settings.same);
  ta.placeholder = fb.settings.same ? 'Write your message in Compose (or untick “Same as Compose” to write a separate Facebook post)' : 'Write your Facebook post…';
  $('fbSame').checked = fb.settings.same;
  ta.hidden = !!fb.preview;
  el.hidden = !fb.preview;
  $('fbPreviewToggle').classList.toggle('on', !!fb.preview);
  const len = [...val].length;
  const cnt = $('fbCharCount');
  cnt.textContent = len > FB_MAX_TEXT ? `${len.toLocaleString()} / ${FB_MAX_TEXT.toLocaleString()}` : `${len.toLocaleString()} character${len === 1 ? '' : 's'}`;
  cnt.classList.toggle('over', len > FB_MAX_TEXT);
  const first = [...fbSelOf('group'), ...fbSelOf('page')][0];
  const hasName = val.includes('{group}');
  $('fbCapHint').textContent = fb.settings.same
    ? 'Following your Compose message. Type here to write a different post for Facebook.'
    : hasName
    ? 'Each group or Page gets its own name where {group} is.'
    : 'Your own Facebook post. Tick “Same as Compose” to follow the Compose message again.';
  const text = (first ? val.replaceAll('{group}', first.name) : val).trim();
  const media = state.attachments.filter(isMedia).length;
  const conflict = media > 0 && hasLink(text);
  const dropMedia = conflict && fb.settings.linkPreview;
  const extra = media ? (dropMedia ? `📎 ${plural(media, 'photo/video')} (left out on Facebook, for the link preview)` : `📎 ${plural(media, 'photo/video')}`) : '';
  el.textContent = text ? (extra ? `${text}\n\n${extra}` : text) : extra || 'Write your Facebook post above, or your message in Compose.';
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
  const hasContent = !!fbMessage().trim() || state.attachments.some(isMedia);
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
  const message = fbMessage().trim();
  if ([...message].length > FB_MAX_TEXT) return toast(`Facebook posts can be up to ${FB_MAX_TEXT.toLocaleString()} characters. Shorten the post first.`, true);
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
          if (!planBlocked(res)) toast(res?.error || 'Couldn’t open Facebook.', true);
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
  $('fbSame').addEventListener('change', (e) => {
    if (e.target.checked) fb.settings.same = true;
    else fbDetach();
    fbSaveSettings();
    renderFbMessage();
    renderFbCounts();
  });
  $('fbCaption').addEventListener('input', (e) => {
    fb.settings.same = false;
    fb.settings.text = e.target.value;
    fbSaveSettings();
    renderFbMessage();
    renderFbCounts();
  });
  $('fbPreviewToggle').addEventListener('click', () => {
    fb.preview = !fb.preview;
    renderFbMessage();
  });
  $('fbNameBtn').addEventListener('click', () => fbInsertAtCursor('{group}'));
  window.RitEmoji?.attach($('fbEmojiBtn'), { target: $('fbCaption'), align: 'left' });
  $('fbTagsBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('fbTagsMenu');
    if (menu.hidden) renderTagsMenu(menu, fbMessage, (t) => fbInsertAtCursor(t, { block: true }));
    $('tplMenu').hidden = true;
    menu.hidden = !menu.hidden;
  });
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

// ─────────────── Instagram & X ───────────────
const SOC_DEFAULTS = { platform: 'instagram', kind: 'post', same: true, captions: { instagram: '', x: '' }, crop: 'original', mode: 'manual', reviewSec: 15, thread: true, premium: false, tags: [], autoAck: false };
const soc = { settings: { ...SOC_DEFAULTS, captions: { ...SOC_DEFAULTS.captions } }, run: null, preview: false };
const IG_TYPES = /^(image\/(jpeg|png|heic|heif|avif)|video\/(mp4|quicktime))$/i;
const IG_LIMIT = 2200;
const X_LIMIT = 280;
const X_PREMIUM_LIMIT = 25000;
const platLabel = (p) => ({ whatsapp: 'WhatsApp', facebook: 'Facebook', instagram: 'Instagram', x: 'X' })[p] || p;
const isSocialPlat = (p) => p === 'instagram' || p === 'x';
const isVideo = (a) => /^video\//.test(a?.type || '') || a?.type === 'image/gif';

async function socLoad() {
  const d = await chrome.storage.local.get(['socSettings', 'socialRun']);
  const s = { ...SOC_DEFAULTS, ...(d.socSettings || {}) };
  soc.settings = {
    ...s,
    platform: s.platform === 'x' ? 'x' : 'instagram',
    kind: s.kind === 'story' ? 'story' : 'post',
    captions: { instagram: '', x: '', ...(s.captions || {}) },
    mode: s.mode === 'auto' ? 'auto' : 'manual',
    reviewSec: Math.min(120, Math.max(5, Number(s.reviewSec) || 15)),
    tags: Array.isArray(s.tags) ? s.tags.filter((t) => t?.name && t?.text) : [],
  };
  soc.run = d.socialRun || null;
}
const socSave = () => persist({ socSettings: soc.settings });

/** Compose text made ready for Instagram/X: no WhatsApp marks, no {group}. */
const socText = (text) =>
  fbText(text)
    .replaceAll('{group}', '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
const socCaption = (p = soc.settings.platform) => (soc.settings.same ? socText(state.message) : soc.settings.captions[p] || '');

/** Length as X counts it: links are 23, emoji and CJK count double. */
function xLength(t) {
  const s = String(t || '').replace(/https?:\/\/\S+/g, 'x'.repeat(23));
  let n = 0;
  for (const ch of s) n += ch.codePointAt(0) > 0x10ff ? 2 : 1;
  return n;
}

/** Split long text into numbered posts, breaking between words (preferring sentence ends). */
function splitThread(text, limit = X_LIMIT) {
  const t = String(text || '').trim();
  if (xLength(t) <= limit) return [t];
  const room = limit - 7; // space for " 12/12"
  const chunks = [];
  let cur = '';
  for (const w of t.split(/(\s+)/)) {
    if (xLength(cur + w) <= room) {
      cur += w;
      if (/[.!?…]["”')]?$/.test(cur) && xLength(cur) > room * 0.75) {
        chunks.push(cur.trim());
        cur = '';
      }
      continue;
    }
    if (cur.trim()) chunks.push(cur.trim());
    cur = w.trimStart();
    while (xLength(cur) > room) {
      chunks.push(cur.slice(0, room));
      cur = cur.slice(room);
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.map((c, i) => `${c} ${i + 1}/${chunks.length}`);
}

/** What would be posted on Instagram or X right now, with problems and notes. */
function socPlan(platform = soc.settings.platform, kind = soc.settings.kind) {
  const media = state.attachments.filter(isMedia);
  const caption = socCaption(platform);
  const notes = [];
  let files = [];
  let error = '';
  let label = 'Post';
  let thread = null;
  if (platform === 'instagram') {
    const ok = media.filter((a) => IG_TYPES.test(a.type));
    if (media.length > ok.length)
      notes.push(`${plural(media.length - ok.length, 'file')} left out: Instagram takes JPG, PNG or HEIC photos and MP4 or MOV videos. Saving a photo in Studio turns it into a JPG.`);
    if (kind === 'story') {
      files = ok.slice(0, 1);
      if (ok.length > 1) notes.push('A Story uses the first photo or video. Use the arrows to choose which one.');
      if (caption) notes.push('Stories have no caption. To put words on it, use Text in Studio.');
      label = 'Story';
    } else {
      files = ok.slice(0, 10);
      label = files.length > 1 ? `Carousel · ${files.length}` : isVideo(files[0]) ? 'Reel' : 'Post';
      if (files.length === 1 && isVideo(files[0])) notes.push('Instagram shares a single video as a Reel.');
    }
    if (!files.length) error = media.length ? 'None of these files can go to Instagram.' : 'Instagram needs a photo or video. Attach one with “+ Add”.';
    else if (kind !== 'story' && caption.length > IG_LIMIT) error = `The caption is ${caption.length.toLocaleString()} characters; Instagram allows ${IG_LIMIT.toLocaleString()}.`;
    else {
      const tags = (caption.match(/#[\p{L}\p{N}_]+/gu) || []).length;
      if (kind !== 'story' && tags > 30) error = `Instagram allows 30 hashtags; this caption has ${tags}.`;
    }
  } else {
    const first = media[0];
    if (first && isVideo(first)) {
      files = [first];
      if (media.length > 1) notes.push('X takes one video or GIF per post, so only the first file is used.');
    } else {
      const imgs = media.filter((a) => !isVideo(a));
      files = imgs.slice(0, 4);
      if (media.length > files.length) notes.push(`X takes up to 4 photos per post, without videos: ${plural(media.length - files.length, 'file')} left out.`);
    }
    const limit = soc.settings.premium ? X_PREMIUM_LIMIT : X_LIMIT;
    const len = xLength(caption);
    if (len > limit) {
      if (soc.settings.thread && !soc.settings.premium) {
        thread = splitThread(caption);
        label = `Thread · ${thread.length}`;
        if (files.length) notes.push('Photos go on the first post of the thread.');
      } else error = `Your text is ${len.toLocaleString()} characters; X allows ${limit.toLocaleString()}. Shorten it, or turn on “thread”.`;
    }
    if (!caption.trim() && !files.length) error = 'Write something or attach a photo first.';
  }
  return { platform, kind: platform === 'x' ? 'post' : kind, caption, files, notes, error, label, thread, targetsLabel: `${platLabel(platform)} ${label.toLowerCase()}` };
}

function openStudio(id) {
  if (!planHas('studio')) return showUpgrade({ reason: `RitPost Studio isn’t included in your ${planName()} plan.` });
  const url = chrome.runtime.getURL(`editor/editor.html${id ? `?id=${encodeURIComponent(id)}` : ''}`);
  chrome.tabs.create({ url, active: true, ...(WINDOW_ID ? { windowId: WINDOW_ID } : {}) }).catch(() => window.open(url, '_blank'));
}

function moveAttachment(id, dir) {
  const i = state.attachments.findIndex((a) => a.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.attachments.length) return;
  [state.attachments[i], state.attachments[j]] = [state.attachments[j], state.attachments[i]];
  attachmentsChanged();
}

/** Stop following Compose so the caption can be edited for this platform. */
function socDetach() {
  if (!soc.settings.same) return;
  const base = socText(state.message);
  soc.settings.captions.instagram ||= base;
  soc.settings.captions.x ||= base;
  soc.settings.same = false;
}

function socInsert(text) {
  socDetach();
  const ta = $('socCaption');
  const p = soc.settings.platform;
  const cur = soc.settings.captions[p] || '';
  soc.settings.captions[p] = cur ? `${cur.replace(/\s+$/, '')}\n\n${text}` : text;
  socSave();
  renderSoc();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function renderSocPlatform() {
  const s = soc.settings;
  const x = s.platform === 'x';
  document.querySelectorAll('#socPlatSeg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.plat === s.platform);
    b.setAttribute('aria-selected', String(b.dataset.plat === s.platform));
  });
  document.querySelectorAll('#socKindSeg button').forEach((b) => b.classList.toggle('on', b.dataset.kind === s.kind));
  $('socKindField').hidden = x;
  $('socKindHint').textContent =
    s.kind === 'story'
      ? 'Beta. Instagram only offers Stories in its phone app layout, so RitPost opens a small phone-sized Instagram window for it. Use a 9:16 photo (Studio → Crop → Fit → Story).'
      : 'One photo or video makes a post (a single video becomes a Reel); 2–10 make a carousel.';
  $('socCropField').hidden = x || s.kind === 'story';
  $('socXField').hidden = !x;
  $('socThread').checked = s.thread;
  $('socPremium').checked = s.premium;
  $('socCrop').value = s.crop;
  $('socCaptionLabel').textContent = x ? 'Post text' : 'Caption';
  $('socSame').checked = s.same;
  $('socStartBtn').classList.toggle('ig', !x);
  $('socStartBtn').classList.toggle('x', x);
}

function renderSocMedia() {
  const plan = socPlan();
  const used = new Set(plan.files.map((a) => a.id));
  const media = state.attachments.filter(isMedia);
  const list = $('socMedia');
  let n = 0;
  list.replaceChildren(
    ...media.map((a, idx) => {
      const on = used.has(a.id);
      const thumb = a.type.startsWith('image/') ? h('img', { src: a.data, alt: '' }) : h('span', { class: 'vid', html: PLAY_SVG });
      const tools = h(
        'span',
        { class: 'soc-tools' },
        h('button', { type: 'button', title: 'Move earlier', 'aria-label': 'Move earlier', disabled: idx === 0, onclick: () => moveAttachment(a.id, -1) }, '‹'),
        a.type.startsWith('image/') ? h('button', { type: 'button', title: 'Edit in Studio', 'aria-label': `Edit ${a.name}`, onclick: () => openStudio(a.id) }, '✎') : null,
        h('button', { type: 'button', title: 'Move later', 'aria-label': 'Move later', disabled: idx === media.length - 1, onclick: () => moveAttachment(a.id, 1) }, '›'),
        h('button', { type: 'button', class: 'del', title: 'Remove', 'aria-label': `Remove ${a.name}`, onclick: () => removeAttachment(a.id) }, '✕')
      );
      return h('li', { class: on ? 'on' : 'off', title: on ? a.name : `${a.name} (not used here)` }, thumb, on ? h('span', { class: 'num' }, String(++n)) : h('span', { class: 'num off' }, '–'), a.edit ? h('span', { class: 'edited' }, 'Edited') : null, tools);
    }),
    h('li', { class: 'add', title: 'Add photos or videos' }, h('button', { type: 'button', onclick: () => $('attachInput').click() }, '+'))
  );
  $('socMediaCount').textContent = media.length ? `(${plan.files.length} used)` : '';
  const note = [...plan.notes];
  if (!media.length) note.unshift(soc.settings.platform === 'x' ? 'Optional on X: up to 4 photos, or 1 video or GIF.' : 'Add a photo or video. Instagram needs at least one.');
  $('socMediaNote').textContent = note.join(' ');
  $('socMediaNote').hidden = !note.length;
}

function renderSocCaption() {
  const s = soc.settings;
  const ta = $('socCaption');
  const val = socCaption();
  if (document.activeElement !== ta || ta.value !== val) ta.value = val;
  ta.classList.toggle('following', s.same);
  ta.placeholder = s.same ? 'Write your message in Compose (or untick “Same as Compose” to write a separate caption)' : s.platform === 'x' ? 'What’s happening?' : 'Write a caption…';
  const plan = socPlan();
  if (s.platform === 'x') {
    const len = xLength(val);
    const limit = s.premium ? X_PREMIUM_LIMIT : X_LIMIT;
    $('socCount').textContent = `${len.toLocaleString()} / ${limit.toLocaleString()}`;
    $('socCount').classList.toggle('over', len > limit && !plan.thread);
    $('socCapHint').textContent = plan.thread ? `Posts as a thread of ${plan.thread.length}.` : s.same ? 'Following your Compose message.' : 'Links count as 23 characters.';
  } else {
    const tags = (val.match(/#[\p{L}\p{N}_]+/gu) || []).length;
    $('socCount').textContent = `${val.length.toLocaleString()} / ${IG_LIMIT.toLocaleString()}${tags ? ` · ${tags} #` : ''}`;
    $('socCount').classList.toggle('over', val.length > IG_LIMIT || tags > 30);
    $('socCapHint').textContent = s.same ? 'Following your Compose message (formatting marks removed).' : 'Links aren’t clickable in Instagram captions.';
  }
  if (soc.preview) renderSocPreview();
}

function socPreviewNode(plan, { large = false } = {}) {
  const firstSrc = plan.files[0];
  const mediaEl = (a, cls = '') =>
    !a ? null : a.type.startsWith('image/') ? h('img', { class: cls, src: a.data, alt: '' }) : h('video', { class: cls, src: a.data, muted: true, playsinline: true, preload: 'metadata' });
  if (plan.platform === 'instagram' && plan.kind === 'story') {
    return h(
      'div',
      { class: `ig-story ${large ? 'lg' : ''}` },
      h('div', { class: 'bars' }, h('i')),
      h('div', { class: 'who' }, h('span', { class: 'av' }), h('b', {}, 'Your story'), h('span', {}, 'now')),
      mediaEl(firstSrc) || h('div', { class: 'none' }, 'No photo yet')
    );
  }
  if (plan.platform === 'instagram') {
    const ratio = { '1:1': '1 / 1', '4:5': '4 / 5', '16:9': '16 / 9' }[soc.settings.crop] || 'auto';
    const cap = plan.caption;
    const short = cap.length > 125 && !large ? `${cap.slice(0, 125).trimEnd()}… ` : cap;
    return h(
      'div',
      { class: 'ig-card' },
      h('div', { class: 'ig-head' }, h('span', { class: 'av' }), h('b', {}, 'your_account'), h('span', { class: 'dots' }, '•••')),
      h(
        'div',
        { class: 'ig-media', style: `aspect-ratio:${ratio}` },
        mediaEl(firstSrc) || h('div', { class: 'none' }, 'Add a photo or video'),
        plan.files.length > 1 ? h('span', { class: 'count' }, `1/${plan.files.length}`) : null
      ),
      plan.files.length > 1 ? h('div', { class: 'ig-dots' }, ...plan.files.map((_, i) => h('i', { class: i ? '' : 'on' }))) : null,
      h('div', { class: 'ig-acts' }, '♡  💬  ➤', h('span', {}, '🔖')),
      cap ? h('div', { class: 'ig-cap' }, h('b', {}, 'your_account '), short, cap.length > 125 && !large ? h('span', { class: 'muted' }, 'more') : null) : null
    );
  }
  const posts = plan.thread || [plan.caption];
  return h(
    'div',
    { class: 'x-thread' },
    ...posts.map((t, i) =>
      h(
        'div',
        { class: 'x-card' },
        h('span', { class: 'av' }),
        h(
          'div',
          { class: 'x-body' },
          h('div', {}, h('b', {}, 'You'), h('span', { class: 'muted' }, ' @you · now')),
          t ? h('div', { class: 'x-text' }, t) : null,
          i === 0 && plan.files.length ? h('div', { class: `x-grid n${plan.files.length}` }, ...plan.files.map((a) => mediaEl(a))) : null,
          h('div', { class: 'x-acts muted' }, '💬   🔁   ♡   📊')
        )
      )
    )
  );
}

function renderSocPreview() {
  $('socPreview').hidden = !soc.preview;
  $('socCaption').hidden = soc.preview;
  $('socPreviewToggle').classList.toggle('on', soc.preview);
  if (soc.preview) setChildren($('socPreview'), socPreviewNode(socPlan()));
}

function renderSocMode() {
  const s = soc.settings;
  const auto = s.mode === 'auto';
  document.querySelectorAll('#socModeSeg button').forEach((b) => {
    const on = b.dataset.mode === s.mode;
    b.classList.toggle('on', on);
    b.classList.toggle('auto', on && auto);
    b.setAttribute('aria-checked', String(on));
  });
  $('socReviewRow').hidden = !auto;
  $('socReview').value = String(s.reviewSec);
  const what = s.platform === 'x' ? 'Post' : s.kind === 'story' ? 'Add to your story' : 'Share';
  $('socModeHint').textContent = auto
    ? `RitPost fills everything in, shows a ${s.reviewSec} s countdown (Hold / Cancel / ${what} now), then clicks ${what}.`
    : `RitPost fills everything in and highlights ${what}; you check the post and click it yourself.`;
}

const socActive = () => soc.run?.status === 'running' && Date.now() - (soc.run.startedAt || 0) < 2 * 60 * 60 * 1000;

function renderSocRun() {
  const r = soc.run;
  const active = socActive();
  $('socRunBox').hidden = !active;
  if (active) {
    $('socRunTitle').textContent = `${platLabel(r.platform)}: ${r.step === 'publishing' ? 'posting…' : r.mode === 'auto' ? 'preparing, then posting' : 'preparing — you click to post'}`;
    $('socRunMeta').textContent = r.kind === 'story' ? 'Story' : r.thread?.length > 1 ? `Thread · ${r.thread.length}` : r.attachmentIds?.length > 1 ? `Carousel · ${r.attachmentIds.length}` : '';
    $('socRunFocus').textContent = `Show ${platLabel(r.platform)}`;
  }
  const last = $('socLast');
  if (!active && r?.finishedAt && Date.now() - r.finishedAt < 24 * 60 * 60 * 1000) {
    last.hidden = false;
    const ok = r.status === 'done';
    setChildren(
      last,
      h(
        'span',
        {},
        h('b', {}, ok ? `Posted to ${platLabel(r.platform)}` : r.status === 'failed' ? `Couldn’t post to ${platLabel(r.platform)}` : 'Stopped'),
        ` · ${timeAgo(r.finishedAt)}`,
        r.error ? h('div', { class: 'stop-reason' }, r.error) : r.note ? h('div', { class: 'muted' }, r.note) : null
      ),
      !ok ? h('button', { type: 'button', class: 'link', onclick: socConfirmStart }, 'Try again') : null
    );
  } else last.hidden = true;
  renderSocStart();
}

function renderSocStart() {
  renderPlanNote();
  const plan = socPlan();
  const btn = $('socStartBtn');
  btn.disabled = !!plan.error || socActive();
  $('socStartLabel').textContent = socActive()
    ? `Posting to ${platLabel(soc.run.platform)}…`
    : plan.error
      ? plan.platform === 'instagram' && !plan.files.length
        ? 'Add a photo or video'
        : 'Fix the post to continue'
      : `Review & post ${plan.platform === 'x' ? 'to X' : plan.kind === 'story' ? 'Story' : `to Instagram`}`;
  btn.title = plan.error || '';
}

function renderSoc() {
  renderSocPlatform();
  renderSocMedia();
  renderSocCaption();
  renderSocMode();
  renderSocRun();
}

function renderSocTagsMenu() {
  renderTagsMenu($('socTagsMenu'), () => socCaption(), socInsert);
}

/** Saved hashtag sets (shared by Facebook, Instagram and X). */
function renderTagsMenu(menu, getText, insert) {
  const tags = soc.settings.tags;
  setChildren(
    menu,
    ...(tags.length
      ? tags.map((t) =>
          h(
            'button',
            { type: 'button', class: 'menu-item', onclick: () => (closeMenu(), insert(t.text)) },
            h('span', { class: 'mi-text' }, h('span', { class: 'mi-name' }, t.name), h('span', { class: 'mi-sub' }, t.text)),
            h(
              'span',
              {
                class: 'x',
                title: 'Delete this set',
                onclick: (e) => {
                  e.stopPropagation();
                  soc.settings.tags = soc.settings.tags.filter((x) => x !== t);
                  socSave();
                  renderTagsMenu(menu, getText, insert);
                  toast(`Deleted “${t.name}”`, false, { label: 'Undo', run: () => (soc.settings.tags.push(t), socSave()) });
                },
              },
              '✕'
            )
          )
        )
      : [h('div', { class: 'menu-empty' }, 'Save the hashtags you use often and add them in one click.')]),
    h('div', { class: 'menu-sep' }),
    h(
      'button',
      {
        type: 'button',
        class: 'menu-item accent',
        onclick: async () => {
          closeMenu();
          const found = [...new Set(getText().match(/#[\p{L}\p{N}_]+/gu) || [])];
          if (!found.length) return toast('Type some #hashtags in the post first, then save them as a set.', true);
          const name = await askName({ title: 'Save hashtag set', label: `${found.length} hashtags: ${short(found.join(' '), 60)}`, placeholder: 'e.g. Church events' });
          if (!name) return;
          soc.settings.tags = [...soc.settings.tags.filter((t) => keyOf(t.name) !== keyOf(name)), { name, text: found.join(' ') }];
          socSave();
          toast(`Saved “${name}”`);
        },
      },
      '+ Save hashtags from this post'
    )
  );
}

function confirmSocAuto() {
  return new Promise((resolve) => {
    openDialog({
      title: 'Turn on automatic posting?',
      confirmText: 'Turn on automatic',
      body: [
        h('p', {}, 'RitPost fills in the post, shows a review countdown, then clicks Share (Instagram) or Post (X) for you. Scheduled posts can then go out while you’re away.'),
        h(
          'ul',
          { class: 'risk' },
          h('li', {}, 'Instagram’s and X’s terms limit automated activity. Posting your own content at a normal pace is low risk, but repeated identical posts can be flagged.'),
          h('li', {}, 'You stay in control: every post shows Hold, Cancel and Post now, and Manual mode is always one click away.')
        ),
      ],
      onConfirm: () => {
        resolve(true);
        return true;
      },
      onCancel: () => resolve(false),
    });
  });
}

/** "Edit before publishing": a final review with the post preview and an editable caption. */
function socConfirmStart() {
  if (socActive()) return toast(`A ${platLabel(soc.run.platform)} post is still open. Finish or stop it first.`, true);
  let plan = socPlan();
  if (plan.error) return toast(plan.error, true);
  const s = soc.settings;
  const what = s.platform === 'x' ? 'Post' : s.kind === 'story' ? 'Add to your story' : 'Share';
  const previewBox = h('div', { class: 'soc-review-preview' });
  const counter = h('span', { class: 'muted' });
  const errLine = h('p', { class: 'field-error' });
  const ta = h('textarea', { class: 'soc-review-text', rows: 5, placeholder: s.platform === 'x' ? 'What’s happening?' : 'Write a caption…' });
  ta.value = plan.caption;
  const emoji = h('button', { type: 'button', class: 'tb emoji-btn', title: 'Add an emoji' }, '😊');
  window.RitEmoji?.attach(emoji, { target: ta, align: 'left' });
  const showCaption = !(s.platform === 'instagram' && s.kind === 'story');
  const refresh = () => {
    plan = socPlan();
    setChildren(previewBox, socPreviewNode(plan, { large: true }));
    counter.textContent = s.platform === 'x' ? `${xLength(ta.value)} / ${s.premium ? X_PREMIUM_LIMIT : X_LIMIT}${plan.thread ? ` · thread of ${plan.thread.length}` : ''}` : `${ta.value.length} / ${IG_LIMIT}`;
    errLine.textContent = plan.error;
    errLine.hidden = !plan.error;
    d.setConfirm(!plan.error);
  };
  ta.addEventListener('input', () => {
    if (ta.value !== socCaption()) {
      socDetach();
      soc.settings.captions[s.platform] = ta.value;
      socSave();
      renderSocCaption();
    }
    refresh();
  });
  const d = openDialog({
    title: `${s.mode === 'auto' ? 'Auto-post' : 'Post'} to ${platLabel(s.platform)}${s.platform === 'instagram' ? ` · ${plan.label}` : plan.thread ? ` · ${plan.label}` : ''}`,
    confirmText: s.mode === 'auto' ? 'Start' : 'Open and fill in',
    body: h(
      'div',
      { class: 'stack' },
      previewBox,
      showCaption ? h('div', { class: 'soc-review-edit' }, h('div', { class: 'field-head' }, h('label', {}, s.platform === 'x' ? 'Post text (edit before publishing)' : 'Caption (edit before publishing)'), h('span', {}, emoji, ' ', counter)), ta) : null,
      errLine,
      h(
        'div',
        { class: 'soc-review-actions' },
        h('button', { type: 'button', class: 'link', onclick: () => (closeDialog(), openStudio(plan.files[0]?.id)) }, '✎ Edit photos in Studio'),
        h('button', { type: 'button', class: 'link', onclick: () => (closeDialog(), openScheduleDialog({ platform: s.platform })) }, '🕒 Schedule instead')
      ),
      h(
        'p',
        { class: 'muted' },
        s.mode === 'auto'
          ? `RitPost opens ${platLabel(s.platform)}, fills everything in and clicks ${what} after a ${s.reviewSec} s countdown you can hold or cancel.`
          : `RitPost opens ${platLabel(s.platform)} and fills everything in. You check it there and click ${what}.`,
        s.platform === 'instagram' && s.kind === 'story' ? ' A small phone-sized Instagram window opens for the Story.' : ''
      ),
      plan.notes.length ? h('p', { class: 'muted' }, plan.notes.join(' ')) : null
    ),
    onConfirm: () => {
      const p = socPlan();
      if (p.error) return false;
      socStart(p);
      return true;
    },
  });
  refresh();
}

async function socStart(plan) {
  const s = soc.settings;
  const run = {
    platform: plan.platform,
    kind: plan.kind,
    caption: plan.platform === 'instagram' && plan.kind === 'story' ? '' : plan.caption,
    thread: plan.thread,
    attachmentIds: plan.files.map((a) => a.id),
    isVideo: !!plan.files[0] && isVideo(plan.files[0]),
    crop: s.crop,
    mode: s.mode,
    reviewSec: s.reviewSec,
  };
  $('socStartBtn').disabled = true;
  const res = await bg('BG_SOCIAL_START', { run });
  if (res?.ok) toast(s.mode === 'auto' ? `Opening ${platLabel(plan.platform)}: RitPost posts after the review countdown.` : `Opening ${platLabel(plan.platform)}: check the post there and click ${plan.platform === 'x' ? 'Post' : 'Share'}.`);
  else {
    if (!planBlocked(res)) toast(res?.error || `Couldn’t open ${platLabel(plan.platform)}.`, true);
    renderSocStart();
  }
}

function socBind() {
  document.querySelectorAll('#socPlatSeg button').forEach((b) =>
    b.addEventListener('click', () => {
      const p = b.dataset.plat;
      if (p === soc.settings.platform) return;
      const from = soc.settings.platform;
      soc.settings.platform = p;
      if (!soc.settings.same && !soc.settings.captions[p]) soc.settings.captions[p] = soc.settings.captions[from] || socText(state.message);
      socSave();
      renderSoc();
    })
  );
  document.querySelectorAll('#socKindSeg button').forEach((b) =>
    b.addEventListener('click', () => {
      soc.settings.kind = b.dataset.kind;
      socSave();
      renderSoc();
    })
  );
  document.querySelectorAll('#socModeSeg button').forEach((b) =>
    b.addEventListener('click', async () => {
      const mode = b.dataset.mode;
      if (mode === soc.settings.mode) return;
      if (mode === 'auto' && !soc.settings.autoAck) {
        if (!(await confirmSocAuto())) return;
        soc.settings.autoAck = true;
      }
      soc.settings.mode = mode;
      socSave();
      renderSocMode();
      toast(mode === 'auto' ? 'Automatic: RitPost posts after a review countdown' : 'Manual: you click Share / Post');
    })
  );
  $('socReview').addEventListener('change', (e) => {
    soc.settings.reviewSec = Math.min(120, Math.max(5, Math.round(Number(e.target.value) || 15)));
    socSave();
    renderSocMode();
  });
  $('socSame').addEventListener('change', (e) => {
    if (e.target.checked) soc.settings.same = true;
    else socDetach();
    socSave();
    renderSoc();
  });
  $('socCaption').addEventListener('input', (e) => {
    socDetach();
    soc.settings.captions[soc.settings.platform] = e.target.value;
    $('socSame').checked = false;
    socSave();
    renderSocCaption();
    renderSocStart();
  });
  $('socCrop').addEventListener('change', (e) => {
    soc.settings.crop = e.target.value;
    socSave();
    if (soc.preview) renderSocPreview();
  });
  $('socThread').addEventListener('change', (e) => {
    soc.settings.thread = e.target.checked;
    socSave();
    renderSoc();
  });
  $('socPremium').addEventListener('change', (e) => {
    soc.settings.premium = e.target.checked;
    socSave();
    renderSoc();
  });
  $('socPreviewToggle').addEventListener('click', () => {
    soc.preview = !soc.preview;
    renderSocPreview();
  });
  window.RitEmoji?.attach($('socEmojiBtn'), { target: $('socCaption'), align: 'left' });
  $('socTagsBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('socTagsMenu');
    if (menu.hidden) renderSocTagsMenu();
    $('tplMenu').hidden = true;
    menu.hidden = !menu.hidden;
  });
  $('socAddMedia').addEventListener('click', () => $('attachInput').click());
  $('socStudio').addEventListener('click', () => openStudio(socPlan().files.find((a) => a.type.startsWith('image/'))?.id));
  $('socStartBtn').addEventListener('click', socConfirmStart);
  $('socRunFocus').addEventListener('click', () => bg('BG_SOCIAL_OPEN', { platform: soc.run?.platform }));
  $('socRunStop').addEventListener('click', async () => {
    await bg('BG_SOCIAL_STOP');
    toast('Stopped');
  });
  $('message').addEventListener('input', () => soc.settings.same && (renderSocCaption(), renderSocMedia(), renderSocStart()));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.socialRun) {
      soc.run = changes.socialRun.newValue || null;
      renderSocRun();
    }
    if (changes.attachments || changes.message) {
      renderSocMedia();
      renderSocCaption();
      renderSocStart();
    }
  });
  // Keep "2 min ago" fresh.
  setInterval(() => !document.hidden && soc.run && renderSocRun(), 30000);
}

// ─────────────── Your plan and the AI writing assistant (RitPost server) ───────────────
const AI_ACTIONS = [
  ['improve', '✨ Improve', 'Make it clearer, more engaging and polished'],
  ['professional', '💼 Professional', 'Rewrite it in a polished, professional, credible style'],
  ['shorter', '✂️ Shorter', 'Make it noticeably shorter and tighter without losing the key information'],
  ['longer', '➕ Expand', 'Expand it with more detail and warmth, without inventing facts'],
  ['grammar', '✅ Fix grammar', 'Fix spelling, grammar and punctuation only; keep the wording and style as close to the original as possible'],
  ['simple', '🧒 Simpler', 'Use simple, everyday words that anyone can understand'],
  ['persuasive', '🎯 Persuasive', 'Make it more persuasive so more people respond'],
  ['headline', '📰 Headline + body', 'Give it a short attention-grabbing headline line, then the body'],
  ['translate', '🌍 Translate', 'Translate it faithfully, keeping the tone'],
];
const AI_TONES = ['Professional', 'Friendly', 'Warm', 'Formal', 'Casual', 'Persuasive', 'Inspirational', 'Exciting', 'Urgent', 'Celebratory', 'Empathetic', 'Authoritative', 'Humorous', 'Respectful', 'Faith-filled'];
const AI_PURPOSES = ['Announcement', 'Event invitation', 'Reminder', 'Promotion or sale', 'Product or service launch', 'Thank-you message', 'Greeting or wishes', 'News update', 'Job vacancy', 'Fundraising or donation appeal', 'Church or ministry message', 'Customer service reply', 'Apology or correction', 'Educational tip'];
const AI_AUDIENCES = ['Everyone', 'Customers', 'Church members', 'Community or group members', 'Professionals and business people', 'Young people', 'Parents and families', 'Students'];
const AI_LANGS = ['English', 'French', 'Spanish', 'Portuguese', 'German', 'Arabic', 'Swahili', 'Hausa', 'Yoruba', 'Igbo', 'Twi', 'Ewe', 'Pidgin English', 'Chinese', 'Hindi'];
const AI_DEFAULTS = { action: 'improve', platform: 'same', tone: '', purpose: '', audience: '', length: '', format: '', emoji: '', language: 'same', hook: false, cta: false, ctaText: '', hashtags: 0, waFormat: false, keep: true, useBrand: true, custom: '', count: 3 };
const ai = { brand: '', last: { ...AI_DEFAULTS }, presets: [], busy: null, installId: '', code: '', plan: null, info: {}, codeError: '' };

async function aiLoad() {
  const { aiSettings, aiInstallId, planCache } = await chrome.storage.local.get(['aiSettings', 'aiInstallId', 'planCache']);
  ai.installId = typeof aiInstallId === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(aiInstallId) ? aiInstallId : (crypto.randomUUID?.() || `${uid()}${uid()}`).replace(/[^A-Za-z0-9-]/g, '');
  if (ai.installId !== aiInstallId) chrome.storage.local.set({ aiInstallId: ai.installId });
  const s = aiSettings || {};
  Object.assign(ai, {
    brand: s.brand || '',
    last: { ...AI_DEFAULTS, ...(s.last || {}) },
    presets: Array.isArray(s.presets) ? s.presets.filter((p) => p?.name && p?.opts) : [],
    code: typeof s.code === 'string' ? s.code : '',
    payCur: typeof s.payCur === 'string' ? s.payCur : '',
  });
  // The last plan RitPost saw, until the server answers.
  if (planCache?.plan) ai.plan = planCache.plan;
}
const aiSave = () => persist({ aiSettings: { brand: ai.brand, last: ai.last, presets: ai.presets, code: ai.code, payCur: ai.payCur } });

function renderAiSettings() {
  $('aiBrand').value = ai.brand;
  renderRitpostAI();
}

const fmtResets = () => {
  const d = new Date();
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return new Date(next).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};
const PLAN_PLATS = ['whatsapp', 'facebook', 'instagram', 'x'];
const planName = (p = ai.plan) => p?.planName || (p?.tier === 'premium' ? 'Premium' : 'Free');
/** One line about AI rewrites, e.g. "Free plan: 28 of 30 rewrites left today". */
function planLine(p = ai.plan) {
  if (!p) return '';
  if (p.limit <= 0) return `${planName(p)} plan: AI rewrites aren’t included`;
  return `${planName(p)}${p.label ? ` (${p.label})` : ''} plan: ${p.remaining} of ${p.limit} rewrites left today`;
}
/** What the plan allows on a platform: { on, daily, used, remaining } (remaining null = unlimited). */
const planPlat = (platform, p = ai.plan) => p?.platforms?.[platform] || null;
/** false only when the known plan leaves out a feature (schedule, auto, studio). */
const planHas = (feature, p = ai.plan) => p?.features?.[feature] !== false;

function usageRow(label, used, limit, on = true) {
  const unlimited = limit === null || limit === undefined;
  const left = unlimited ? null : Math.max(0, limit - used);
  const val = !on ? 'Not included' : unlimited ? (used ? `${used} today · no limit` : 'No limit') : `${left} of ${limit} left`;
  const pct = !on ? 0 : unlimited ? 100 : limit ? Math.min(100, Math.round((used / limit) * 100)) : 100;
  const low = on && !unlimited && left <= Math.max(1, Math.floor(limit * 0.2));
  return h('li', { class: `${on ? '' : 'off'}${low ? ' low' : ''}` }, h('b', {}, label), h('div', { class: 'run-bar' }, h('div', { style: `width:${pct}%${unlimited && on ? ';opacity:.4' : ''}` })), h('span', { class: 'val' }, val));
}

function renderRitpostAI() {
  const box = $('rpaiBox');
  const hasServer = !!window.RitAI?.hasServer();
  box.hidden = !hasServer;
  const p = ai.plan;
  $('aiStatus').textContent = !hasServer
    ? 'Not available in this copy of RitPost.'
    : !p
      ? 'Included with RitPost. Click ✨ AI in Compose or on an Instagram / X caption.'
      : p.limit > 0
        ? `Included in your ${planName(p)} plan: ${p.remaining} of ${p.limit} rewrites left today. Click ✨ AI in Compose or on a caption.`
        : `AI rewrites aren’t included in your ${planName(p)} plan.`;
  renderPlanNote();
  if (!hasServer) return;
  const premium = p?.tier === 'premium';
  $('rpaiTier').textContent = p ? planName(p) : '';
  $('rpaiTier').className = `chip ${premium ? 'premium' : ''}`;
  $('planTitle').replaceChildren(
    p
      ? h('span', {}, premium ? `${planName(p)} plan${p.label ? ` · ${p.label}` : ''}` : 'Free plan', h('span', { class: 'muted' }, p.expiresAt ? ` · until ${new Date(p.expiresAt).toLocaleDateString()}` : premium ? ' · no expiry' : ' · no code needed'))
      : h('span', { class: 'muted' }, ai.info.error || 'Checking your plan…')
  );
  setChildren(
    $('planUsage'),
    ...(p?.platforms ? PLAN_PLATS.map((k) => usageRow(platLabel(k), p.platforms[k].used || 0, p.platforms[k].daily, p.platforms[k].on)) : []),
    p ? usageRow('AI rewrites', p.used || 0, p.limit, p.limit > 0) : null
  );
  const f = p?.features;
  setChildren(
    $('planFeats'),
    ...(f
      ? [
          h('span', {}, f.perRun ? `Up to ${f.perRun} groups / Pages per run` : 'Any number of groups per run'),
          h('span', { class: f.schedule ? '' : 'no' }, 'Scheduled posts'),
          h('span', { class: f.auto ? '' : 'no' }, 'Automatic mode'),
          h('span', { class: f.studio ? '' : 'no' }, 'RitPost Studio'),
        ]
      : [])
  );
  $('rpaiAnn').hidden = !ai.info.announcement;
  $('rpaiAnn').textContent = ai.info.announcement || '';
  $('rpaiCodeRow').hidden = premium;
  $('rpaiPremium').hidden = !premium;
  $('rpaiPremText').textContent = premium ? `Code ${ai.code}` : '';
  $('planUpgrade').hidden = !(ai.info.offers?.length || ai.info.upgradeUrl);
  $('planUpgrade').textContent = premium ? 'See other plans' : 'See plans & upgrade';
  const hint = [];
  if (ai.codeError) hint.push(ai.codeError);
  if (p) hint.push(`Daily limits reset at ${fmtResets()} (midnight UTC).`);
  if (!premium && ai.info.upgradeText) hint.push(ai.info.upgradeText);
  $('rpaiHint').textContent = hint.join(' ');
}

/** The small line under the Start button: posts left today on the platform you're posting to. */
function renderPlanNote() {
  const el = $('planNote');
  if (!el) return;
  const tab = document.body.dataset.tab || 'compose';
  const platform = tab === 'facebook' ? 'facebook' : tab === 'social' ? soc.settings.platform : tab === 'compose' || tab === 'groups' ? 'whatsapp' : null;
  const p = ai.plan;
  const pf = platform && planPlat(platform, p);
  el.hidden = !pf;
  if (!pf) return;
  const up = h('button', { type: 'button', class: 'link', onclick: () => showUpgrade() }, p.tier === 'premium' ? 'Plans' : 'Upgrade');
  el.className = 'plan-note';
  if (!pf.on) {
    el.classList.add('locked');
    setChildren(el, h('span', {}, `🔒 ${platLabel(platform)} isn’t in your ${planName(p)} plan.`), up);
    return;
  }
  if (pf.remaining === null) {
    setChildren(el, h('span', {}, h('b', {}, `${planName(p)} plan`), ` · ${platLabel(platform)}: no daily limit${p.features?.perRun ? ` · up to ${p.features.perRun} per run` : ''}`));
    return;
  }
  if (pf.remaining <= Math.max(1, Math.floor(pf.daily * 0.2))) el.classList.add('warn');
  setChildren(el, h('span', {}, h('b', {}, `${planName(p)} plan`), ` · ${pf.remaining} of ${pf.daily} ${platLabel(platform)} posts left today${p.features?.perRun ? ` · up to ${p.features.perRun} per run` : ''}`), p.tier === 'premium' ? null : up);
}

/** Remember the plan for the background worker (used when the server can't be reached). */
const planRemember = () => ai.plan && chrome.storage.local.set({ planCache: { plan: ai.plan, at: Date.now() } });

async function aiRefreshStatus() {
  if (!window.RitAI?.hasServer()) return;
  try {
    const r = await window.RitAI.status({ installId: ai.installId, code: ai.code });
    ai.plan = r.plan;
    ai.info = { announcement: r.announcement, upgradeText: r.upgradeText, upgradeUrl: r.upgradeUrl, offers: r.offers || [], fx: r.fx || null };
    ai.codeError = '';
  } catch (e) {
    // A stored code that stopped working: say why and fall back to the free plan.
    if (e.plan) ai.plan = e.plan;
    ai.codeError = e.code && /code/.test(e.code) ? e.message : '';
    if (e.info) ai.info = { announcement: e.info.announcement, upgradeText: e.info.upgradeText, upgradeUrl: e.info.upgradeUrl, offers: e.info.offers || [], fx: e.info.fx || null };
    else if (!ai.plan) ai.info = { ...ai.info, error: e.message };
  }
  planRemember();
  renderRitpostAI();
}

async function aiActivateCode() {
  const raw = $('rpaiCode').value.trim();
  if (!raw) return toast('Paste your access code first.', true);
  const btn = $('rpaiActivate');
  btn.disabled = true;
  try {
    const r = await window.RitAI.redeem({ installId: ai.installId, code: raw });
    ai.code = raw.toUpperCase();
    ai.plan = r.plan;
    ai.codeError = '';
    await aiSave();
    planRemember();
    $('rpaiCode').value = '';
    renderRitpostAI();
    toast(`${planName(r.plan)} plan activated${r.plan.expiresAt ? ` until ${new Date(r.plan.expiresAt).toLocaleDateString()}` : ''}`);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

/** Upgrade window: why (if a limit was hit), the plans on offer, and how to get one. */
/** The number in a plan price such as "GHS 50 / month". */
const priceNumber = (price) => {
  const m = String(price || '').replace(/,/g, '').match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
};
/** A plan price shown in the currency the customer picked (from the publisher's exchange rates). */
function priceIn(price, cur) {
  const fx = ai.info.fx;
  const n = priceNumber(price);
  if (!fx || !n || !cur || cur === fx.base || !fx.rates?.[cur]) return null;
  const v = n * fx.rates[cur];
  return `≈ ${cur} ${v.toLocaleString(undefined, { maximumFractionDigits: v >= 100 ? 0 : 2 })}`;
}

function showUpgrade({ reason = '' } = {}) {
  const p = ai.plan;
  const offers = ai.info.offers || [];
  const fx = ai.info.fx;
  const curs = fx?.rates ? Object.keys(fx.rates) : [];
  const canConvert = curs.length > 1 && offers.some((o) => priceNumber(o.price));
  let cur = canConvert && curs.includes(ai.payCur) ? ai.payCur : fx?.base || '';
  let list = null;
  let curNote = null;
  const priceEl = (o) => {
    const conv = priceIn(o.price, cur);
    return o.price ? h('span', { class: 'price' }, conv ? h('span', { title: `${o.price} at today’s rate` }, conv, ' ', h('small', { class: 'muted' }, `(${o.price})`)) : o.price) : null;
  };
  const lim = (pf) => (!pf?.on ? null : pf.daily === null ? 'no daily limit' : `${pf.daily} a day`);
  const offerCard = (o) => {
    const plats = PLAN_PLATS.filter((k) => o.platforms?.[k]?.on).map((k) => `${platLabel(k)} (${lim(o.platforms[k])})`);
    return h(
      'div',
      { class: `up-offer${p?.planId === o.id ? ' cur' : ''}` },
      h('div', { class: 't' }, h('b', {}, o.name), priceEl(o), p?.planId === o.id ? h('span', { class: 'chip' }, 'Your plan') : null),
      o.description ? h('div', { class: 'muted' }, o.description) : null,
      h(
        'ul',
        {},
        plats.length ? h('li', {}, `Post to ${plats.join(', ')}`) : null,
        h('li', {}, o.perRun ? `Up to ${o.perRun} groups or Pages per run` : 'Any number of groups or Pages per run'),
        o.ai ? h('li', {}, `${o.ai} AI rewrites a day`) : null,
        [o.schedule && 'scheduled posts', o.auto && 'Automatic mode', o.studio && 'RitPost Studio'].filter(Boolean).length ? h('li', {}, `Includes ${[o.schedule && 'scheduled posts', o.auto && 'Automatic mode', o.studio && 'RitPost Studio'].filter(Boolean).join(', ')}`) : null,
        o.days ? h('li', {}, `Valid ${o.days} days`) : null
      )
    );
  };
  openDialog({
    title: p?.tier === 'premium' ? '⭐ RitPost plans' : '⭐ Upgrade RitPost',
    hideConfirm: true,
    body: h(
      'div',
      { class: 'ai-dialog' },
      reason ? h('p', { class: 'up-reason' }, reason) : null,
      p ? h('p', { class: 'hint' }, `You’re on the ${planName(p)} plan${p.expiresAt ? `, valid until ${new Date(p.expiresAt).toLocaleDateString()}` : ''}.`) : null,
      canConvert
        ? h(
            'label',
            { class: 'up-cur' },
            h('span', {}, 'Show prices in'),
            h(
              'select',
              {
                onchange: (e) => {
                  cur = e.target.value;
                  ai.payCur = cur;
                  aiSave();
                  list.replaceChildren(...offers.map(offerCard));
                  curNote.hidden = cur === fx.base;
                },
              },
              ...curs.map((c) => h('option', { value: c, selected: c === cur }, c))
            )
          )
        : null,
      offers.length ? (list = h('div', { class: 'up-offers' }, ...offers.map(offerCard))) : h('p', {}, ai.info.upgradeText || 'Get an access code from RitPost to unlock more.'),
      canConvert ? (curNote = h('p', { class: 'hint', hidden: cur === fx.base }, `Converted at today’s exchange rate; the price in ${fx.base} applies. Ask the seller how to pay in your currency.`)) : null,
      h(
        'div',
        { class: 'up-acts' },
        ai.info.upgradeUrl ? h('a', { class: 'btn primary', href: ai.info.upgradeUrl, target: '_blank', rel: 'noopener' }, 'Get premium') : null,
        p?.tier === 'premium' ? null : h('button', { type: 'button', class: 'btn secondary', onclick: () => (closeDialog(), switchTab('settings'), setTimeout(() => $('rpaiCode')?.focus(), 60)) }, 'I have an access code')
      ),
      h('p', { class: 'hint' }, 'After you pay, you get an access code. Paste it in Settings → Your plan and click Activate.')
    ),
  });
}

/** A run the plan refused: explain it in the upgrade window. Returns true when handled. */
function planBlocked(res) {
  if (!res || res.ok || !/^plan_/.test(res.code || '')) return false;
  aiRefreshStatus();
  showUpgrade({ reason: res.error });
  return true;
}

/** Options → the instructions sent to OpenAI. */
function aiRequestOpts(o, platform) {
  const action = AI_ACTIONS.find((a) => a[0] === o.action);
  const lengths = { short: 'short (1–3 sentences)', medium: 'medium (a short paragraph or two)', long: 'long and detailed' };
  const formats = { paragraphs: 'readable short paragraphs', bullets: 'a short intro, then bullet points (•)', lines: 'short punchy lines, one idea per line', story: 'a short story-style post' };
  const emojis = { none: 'no emojis at all', few: 'a few well-placed emojis', many: 'plenty of lively emojis' };
  return {
    action: action ? action[2] : '',
    tone: o.tone,
    purpose: o.purpose,
    audience: o.audience,
    length: lengths[o.length] || (o.action === 'shorter' || o.action === 'longer' ? '' : 'about the same length as the original'),
    format: formats[o.format] || '',
    emoji: emojis[o.emoji] || '',
    language: o.action === 'translate' && o.language === 'same' ? 'English' : o.language,
    hook: o.hook,
    cta: o.cta,
    ctaText: o.ctaText,
    hashtags: o.hashtags,
    waFormat: o.waFormat && (platform === 'whatsapp' || platform === 'all'),
    keep: o.keep,
    brand: o.useBrand ? ai.brand : '',
    custom: o.custom,
    count: o.count,
    platform: o.platform === 'same' ? platform : o.platform,
  };
}

/**
 * The AI window. target 'compose' rewrites the Compose message; 'caption' the Instagram/X caption.
 */
function openAIDialog({ target = 'compose' } = {}) {
  if (!window.RitAI) return toast('The AI module didn’t load. Reload RitPost.', true);
  const isCaption = target === 'caption';
  const isFb = target === 'facebook';
  const here = isCaption ? soc.settings.platform : isFb ? 'facebook' : 'whatsapp';
  const source = () => (isCaption ? socCaption() : isFb ? fbMessage() : state.message);
  if (!window.RitAI.hasServer()) return toast('RitPost AI isn’t available in this copy of RitPost.', true);
  if (ai.plan && ai.plan.limit <= 0) return showUpgrade({ reason: `AI rewrites aren’t included in your ${planName()} plan.` });
  if (!source().trim()) return toast(isCaption ? 'Write a caption first; AI improves the text you give it.' : isFb ? 'Write your Facebook post (or a few words about it) first; AI improves the text you give it.' : 'Write your message first; AI improves the text you give it.', true);

  const o = { ...ai.last };
  if ((isCaption || isFb) && o.platform === 'whatsapp') o.platform = 'same';
  const sel = (label, key, options, blank = 'Any') =>
    h(
      'label',
      { class: 'ai-field' },
      h('span', {}, label),
      h(
        'select',
        { onchange: (e) => (o[key] = key === 'hashtags' ? Number(e.target.value) || 0 : e.target.value) },
        blank === null ? null : h('option', { value: '' }, blank),
        ...options.map((v) => (Array.isArray(v) ? h('option', { value: v[0], selected: o[key] === v[0] }, v[1]) : h('option', { value: v, selected: o[key] === v }, v)))
      )
    );
  const chk = (key, label, extra) =>
    h('label', { class: 'ai-check' }, h('input', { type: 'checkbox', checked: !!o[key], onchange: (e) => ((o[key] = e.target.checked), extra?.(e.target.checked)) }), h('span', {}, label));

  const actions = h('div', { class: 'ai-actions' });
  const renderActions = () =>
    actions.replaceChildren(
      ...AI_ACTIONS.map(([id, label]) =>
        h('button', { type: 'button', class: o.action === id ? 'on' : '', onclick: () => ((o.action = id), renderActions(), langWrap.classList.toggle('hl', id === 'translate')) }, label)
      )
    );
  const langWrap = h(
    'label',
    { class: 'ai-field' },
    h('span', {}, 'Language'),
    h('select', { onchange: (e) => (o.language = e.target.value) }, h('option', { value: 'same', selected: o.language === 'same' }, 'Same as the post'), ...AI_LANGS.map((l) => h('option', { value: l, selected: o.language === l }, l)))
  );
  const ctaText = h('input', { type: 'text', placeholder: 'e.g. Call 024 000 0000, Register at the link', value: o.ctaText, maxlength: 120, oninput: (e) => (o.ctaText = e.target.value) });
  ctaText.hidden = !o.cta;
  const custom = h('textarea', { rows: 2, maxlength: 500, placeholder: 'Anything else? e.g. mention free parking; keep the Bible verse; sound like a bank, not a teenager' });
  custom.value = o.custom;
  custom.addEventListener('input', () => (o.custom = custom.value));
  const presetsRow = h('div', { class: 'ai-presets' });
  const results = h('div', { class: 'ai-results' });
  const status = h('div', { class: 'ai-status' });
  const genBtn = h('button', { type: 'button', class: 'btn primary block ai-go' }, '✨ Generate 3 versions');
  const planInfo = h('div', { class: 'hint ai-plan' }, planLine());

  const renderPresets = () =>
    setChildren(
      presetsRow,
      ...ai.presets.map((p) =>
        h(
          'span',
          { class: 'chip-btn' },
          h('span', { class: 'lbl', onclick: () => (Object.assign(o, { ...AI_DEFAULTS, ...p.opts }), closeDialog(), (ai.last = { ...o }), openAIDialog({ target })) }, p.name),
          h('span', { class: 'x', title: 'Delete preset', onclick: () => ((ai.presets = ai.presets.filter((x) => x !== p)), aiSave(), renderPresets()) }, '✕')
        )
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'chip-btn add',
          onclick: async () => {
            const snapshot = { ...o };
            const name = await askName({ title: 'Save these AI options', label: 'Preset name', placeholder: 'e.g. Church announcement', confirmText: 'Save preset' });
            if (name) {
              ai.presets = [...ai.presets.filter((p) => keyOf(p.name) !== keyOf(name)), { name, opts: snapshot }];
              ai.last = snapshot;
              await aiSave();
              toast(`Preset “${name}” saved`);
            }
            openAIDialog({ target });
          },
        },
        '+ Save as preset'
      )
    );

  function applyText(text, mode) {
    if (isFb) {
      const wasSame = fb.settings.same;
      fbDetach();
      const before = fb.settings.text;
      fb.settings.text = mode === 'insert' && before.trim() ? `${before.trimEnd()}\n\n${text}` : text;
      fbSaveSettings();
      renderFb();
      closeDialog();
      toast('Facebook post updated', false, { label: 'Undo', run: () => ((fb.settings.text = before), (fb.settings.same = wasSame), fbSaveSettings(), renderFb()) });
      return;
    }
    if (isCaption) {
      socDetach();
      const p = soc.settings.platform;
      const before = soc.settings.captions[p] || '';
      soc.settings.captions[p] = mode === 'insert' && before ? `${before.trimEnd()}\n\n${text}` : text;
      socSave();
      renderSoc();
      closeDialog();
      toast(`Caption updated for ${platLabel(p)}`, false, { label: 'Undo', run: () => ((soc.settings.captions[p] = before), socSave(), renderSoc()) });
      return;
    }
    const before = state.message;
    setMessage(mode === 'insert' && before.trim() ? `${before.trimEnd()}\n\n${text}` : text);
    if (soc.settings.same) renderSoc();
    closeDialog();
    toast(mode === 'insert' ? 'Added below your message' : 'Message replaced', false, { label: 'Undo', run: () => (setMessage(before), renderSoc()) });
  }

  function applyAll(v) {
    const beforeMsg = state.message;
    const beforeSoc = JSON.stringify(soc.settings);
    const beforeFb = { same: fb.settings.same, text: fb.settings.text };
    setMessage(v.whatsapp || v.facebook);
    if (v.facebook) {
      fb.settings.same = false;
      fb.settings.text = v.facebook;
      fbSaveSettings();
    }
    socDetach();
    if (v.instagram) soc.settings.captions.instagram = v.instagram;
    if (v.x) soc.settings.captions.x = v.x;
    socSave();
    renderSoc();
    renderFb();
    closeDialog();
    toast('WhatsApp, Facebook, Instagram and X posts updated', false, {
      label: 'Undo',
      run: () => {
        setMessage(beforeMsg);
        soc.settings = JSON.parse(beforeSoc);
        Object.assign(fb.settings, beforeFb);
        socSave();
        fbSaveSettings();
        renderSoc();
        renderFb();
      },
    });
  }

  const copy = (text) => navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Couldn’t copy', true));
  const count = (p, t) => (p === 'x' ? `${xLength(t)}/280` : `${t.length.toLocaleString()} chars`);

  function renderResults(list, platform, meta) {
    const cards = list.map((v, i) => {
      if (platform === 'all') {
        const block = (p, label) =>
          v[p]
            ? h(
                'div',
                { class: 'ai-plat' },
                h('div', { class: 'ai-plat-head' }, h('b', {}, label), h('span', { class: p === 'x' && xLength(v[p]) > 280 ? 'muted over' : 'muted' }, count(p, v[p])), h('button', { type: 'button', class: 'link', onclick: () => copy(v[p]) }, 'Copy')),
                h('div', { class: 'ai-text' }, v[p])
              )
            : null;
        return h(
          'div',
          { class: 'ai-card' },
          h('div', { class: 'ai-card-head' }, h('b', {}, `${i + 1}. ${v.title}`)),
          v.note ? h('div', { class: 'ai-note' }, v.note) : null,
          block('whatsapp', 'WhatsApp'),
          block('facebook', 'Facebook'),
          block('instagram', 'Instagram'),
          block('x', 'X'),
          h('div', { class: 'ai-card-acts' }, h('button', { type: 'button', class: 'btn primary sm', onclick: () => applyAll(v) }, 'Use all four'), h('button', { type: 'button', class: 'btn secondary sm', onclick: () => applyText(v[here] || v.whatsapp, 'replace') }, `Use ${platLabel(here)} version`))
        );
      }
      return h(
        'div',
        { class: 'ai-card' },
        h('div', { class: 'ai-card-head' }, h('b', {}, `${i + 1}. ${v.title}`), h('span', { class: platform === 'x' && xLength(v.text) > 280 ? 'muted over' : 'muted' }, count(platform, v.text))),
        v.note ? h('div', { class: 'ai-note' }, v.note) : null,
        h('div', { class: 'ai-text' }, v.text),
        h(
          'div',
          { class: 'ai-card-acts' },
          h('button', { type: 'button', class: 'btn primary sm', onclick: () => applyText(v.text, 'replace') }, 'Use this'),
          h('button', { type: 'button', class: 'btn secondary sm', onclick: () => applyText(v.text, 'insert') }, 'Add below'),
          h('button', { type: 'button', class: 'btn secondary sm', onclick: () => copy(v.text) }, 'Copy'),
          h(
            'button',
            {
              type: 'button',
              class: 'btn secondary sm',
              title: 'Make 3 new versions based on this one',
              onclick: () => generate(v.text),
            },
            'More like this'
          )
        )
      );
    });
    setChildren(results, ...cards, meta ? h('p', { class: 'hint ai-meta' }, meta) : null);
    results.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }

  async function generate(fromText) {
    if (ai.busy) {
      ai.busy.abort();
      return;
    }
    ai.last = { ...o };
    aiSave();
    const platform = o.platform === 'same' ? here : o.platform;
    const ctrl = new AbortController();
    ai.busy = ctrl;
    const timer = setTimeout(() => ctrl.abort(), 90000);
    genBtn.textContent = 'Stop';
    genBtn.classList.add('busy');
    status.parentElement?.querySelectorAll('.ai-err-acts').forEach((x) => x.remove());
    status.className = 'ai-status';
    setChildren(status, h('span', { class: 'spinner' }), h('span', {}, 'Writing…'));
    try {
      const res = await window.RitAI.rewrite({ text: fromText || source(), opts: aiRequestOpts(o, platform), signal: ctrl.signal, installId: ai.installId, code: ai.code });
      status.replaceChildren();
      if (res.plan) {
        ai.plan = res.plan;
        planRemember();
        renderRitpostAI();
        planInfo.textContent = planLine();
      }
      const who = `RitPost AI (${res.model}) · ${planLine()}`;
      renderResults(res.variations, aiRequestOpts(o, platform).platform, `Written by ${who}. Check names, dates and links before posting.`);
    } catch (e) {
      status.className = 'ai-status err';
      status.textContent = e?.message || String(e);
      if (e?.plan) {
        ai.plan = e.plan;
        renderRitpostAI();
        planInfo.textContent = planLine();
      }
      if (e?.code === 'limit' || e?.code === 'free_off' || /code/.test(e?.code || '')) {
        const reason = e.message;
        const acts = h(
          'div',
          { class: 'ai-card-acts ai-err-acts' },
          h('button', { type: 'button', class: 'btn primary sm', onclick: () => showUpgrade({ reason }) }, 'See plans'),
          ai.info.upgradeUrl ? h('a', { class: 'btn secondary sm', href: ai.info.upgradeUrl, target: '_blank', rel: 'noopener' }, 'Get premium') : null,
          ai.plan?.tier === 'premium' ? null : h('button', { type: 'button', class: 'btn secondary sm', onclick: () => (closeDialog(), switchTab('settings'), setTimeout(() => $('rpaiCode')?.focus(), 60)) }, 'Enter an access code')
        );
        status.after(acts);
      }
    } finally {
      clearTimeout(timer);
      ai.busy = null;
      genBtn.textContent = '✨ Generate 3 versions';
      genBtn.classList.remove('busy');
    }
  }
  genBtn.addEventListener('click', () => generate());

  renderActions();
  renderPresets();
  const preview = source();
  openDialog({
    title: isCaption ? `✨ Rewrite the ${platLabel(here)} caption` : isFb ? '✨ Write the Facebook post with AI' : '✨ Rewrite with AI',
    hideConfirm: true,
    body: h(
      'div',
      { class: 'ai-dialog' },
      h('div', { class: 'ai-source', title: preview }, h('span', { class: 'muted' }, 'Your text: '), preview.length > 160 ? `${preview.slice(0, 160)}…` : preview),
      h('div', { class: 'ai-sec' }, h('div', { class: 'ai-sec-h' }, 'What should AI do?'), actions),
      h(
        'details',
        { class: 'ai-pro', open: true },
        h('summary', {}, '💼 Professional options'),
        h(
          'div',
          { class: 'ai-grid' },
          sel('Write for', 'platform', [['same', isCaption ? `${platLabel(here)} (this caption)` : isFb ? 'Facebook (this post)' : 'WhatsApp (this message)'], ['whatsapp', 'WhatsApp'], ['facebook', 'Facebook'], ['instagram', 'Instagram'], ['x', 'X (280 characters)'], ['all', 'All 4 platforms at once']], null),
          sel('Tone', 'tone', AI_TONES),
          sel('Type of post', 'purpose', AI_PURPOSES),
          sel('Audience', 'audience', AI_AUDIENCES),
          sel('Length', 'length', [['short', 'Short'], ['medium', 'Medium'], ['long', 'Long']], 'Keep about the same'),
          sel('Layout', 'format', [['paragraphs', 'Short paragraphs'], ['bullets', 'Bullet points'], ['lines', 'One idea per line'], ['story', 'Story style']], 'Keep as it is'),
          sel('Emojis', 'emoji', [['none', 'None'], ['few', 'A few'], ['many', 'Lots']], 'Up to AI'),
          langWrap,
          sel('Hashtags', 'hashtags', [[3, '3 hashtags'], [5, '5 hashtags'], [10, '10 hashtags'], [15, '15 hashtags']], 'No extra hashtags')
        ),
        h(
          'div',
          { class: 'ai-checks' },
          chk('hook', 'Strong opening hook'),
          chk('cta', 'Clear call to action', (on) => (ctaText.hidden = !on)),
          ctaText,
          isCaption || isFb ? null : chk('waFormat', 'Use WhatsApp *bold* / _italic_'),
          chk('keep', 'Keep links, dates, prices, names and {group} exactly'),
          ai.brand ? chk('useBrand', 'Use my brand voice (from Settings)') : h('p', { class: 'hint' }, 'Tip: add “About you / your brand voice” in Settings so every rewrite sounds like you.')
        ),
        h('label', { class: 'ai-field wide' }, h('span', {}, 'Extra instructions'), custom),
        h('div', { class: 'ai-sec-h' }, 'My presets'),
        presetsRow
      ),
      genBtn,
      planInfo,
      status,
      results
    ),
    onCancel: () => ai.busy?.abort(),
  });
}

function aiBind() {
  $('rpaiActivate').addEventListener('click', aiActivateCode);
  $('rpaiCode').addEventListener('keydown', (e) => e.key === 'Enter' && aiActivateCode());
  $('rpaiRefresh').addEventListener('click', () => aiRefreshStatus().then(() => toast('Plan updated')));
  $('planUpgrade').addEventListener('click', () => showUpgrade());
  $('rpaiRemove').addEventListener('click', () => {
    const old = ai.code;
    ai.code = '';
    ai.codeError = '';
    aiSave();
    aiRefreshStatus();
    toast('Access code removed from this browser', false, { label: 'Undo', run: () => ((ai.code = old), aiSave(), aiRefreshStatus()) });
  });
  document.querySelector('[data-tab=settings]').addEventListener('click', () => aiRefreshStatus());
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setTimeout(renderPlanNote, 0)));
  $('aiBtn').addEventListener('click', () => openAIDialog({ target: 'compose' }));
  $('socAiBtn').addEventListener('click', () => openAIDialog({ target: 'caption' }));
  $('fbAiBtn').addEventListener('click', () => openAIDialog({ target: 'facebook' }));
  $('aiBrand').addEventListener('change', (e) => {
    ai.brand = e.target.value.trim();
    aiSave();
    toast(ai.brand ? 'Brand voice saved' : 'Brand voice cleared');
  });
  // Automatic mode is a plan feature: explain instead of switching when it isn't included.
  for (const id of ['modeSeg', 'fbModeSeg', 'socModeSeg']) {
    $(id)?.addEventListener(
      'click',
      (e) => {
        if (e.target.closest('button[data-mode="auto"]') && !planHas('auto')) {
          e.stopImmediatePropagation();
          e.preventDefault();
          showUpgrade({ reason: `Automatic mode isn’t included in your ${planName()} plan. Manual mode still works: you press Send / Post yourself.` });
        }
      },
      true
    );
  }
  // The background worker updates the plan after each run.
  chrome.storage.onChanged.addListener((changes, area) => {
    const next = area === 'local' && changes.planCache?.newValue?.plan;
    if (next && JSON.stringify(next) !== JSON.stringify(ai.plan)) {
      ai.plan = next;
      renderRitpostAI();
    }
  });
  setInterval(() => !document.hidden && aiRefreshStatus(), 15 * 60 * 1000);
}

// ─────────────── Scheduled posts ───────────────
const RS = window.RitSchedule;
/** replaceChildren, skipping empty parts (replaceChildren would print "null"). */
const setChildren = (el, ...kids) => el.replaceChildren(...kids.filter((k) => k !== null && k !== undefined && k !== false));
const sched = { jobs: [], history: [] };

async function schedLoad() {
  const d = await chrome.storage.local.get(['schedules', 'schedHistory']);
  sched.jobs = Array.isArray(d.schedules) ? d.schedules : [];
  sched.history = Array.isArray(d.schedHistory) ? d.schedHistory : [];
}
const schedSave = () => persist({ schedules: sched.jobs });

const pad2 = (n) => String(n).padStart(2, '0');
const dateValue = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const timeValue = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const schedTitle = (j) =>
  j.label || String(j.message || '').split('\n')[0].slice(0, 60) || (j.fileNames?.length ? plural(j.fileNames.length, 'file') : 'Scheduled post');

/** What would be scheduled on a platform from the current Compose content and selection. */
function schedSnapshot(platform, keepPreview) {
  const message = state.message.trim();
  if (isSocialPlat(platform)) {
    const p = socPlan(platform, platform === 'x' ? 'post' : soc.settings.kind);
    if (p.error) return { error: p.error };
    return {
      platform,
      message: p.thread ? p.thread.join('\n\n') : p.caption,
      files: p.files,
      names: [p.label],
      targetsLabel: p.targetsLabel,
      social: { kind: p.kind, caption: p.kind === 'story' ? '' : p.caption, thread: p.thread, crop: soc.settings.crop, reviewSec: soc.settings.reviewSec, isVideo: !!p.files[0] && isVideo(p.files[0]) },
    };
  }
  if (platform === 'whatsapp') {
    const groups = state.groups.filter((g) => state.selected.has(g.id));
    if (!groups.length) return { error: 'Select WhatsApp groups in the Groups tab first.' };
    if (!message && !state.attachments.length) return { error: 'Write a message or attach files in Compose first.' };
    return {
      platform,
      message,
      files: state.attachments,
      names: groups.map((g) => g.name),
      targetsLabel: plural(groups.length, 'group'),
      wa: { items: groups.map((g) => ({ name: g.name, text: message.replaceAll('{group}', g.name) })) },
    };
  }
  const items = [...fbSelOf('group'), ...fbSelOf('page')];
  const media = state.attachments.filter(isMedia);
  const fbMsg = fbMessage().trim();
  if (!items.length) return { error: 'Select Facebook groups or Pages in the Facebook tab first.' };
  if (!fbMsg && !media.length) return { error: 'Write the Facebook post or attach photos/videos in Compose first.' };
  const conflict = media.length > 0 && hasLink(fbMsg);
  const sendMedia = !(conflict && keepPreview);
  return {
    platform,
    message: fbMsg,
    conflict,
    files: sendMedia ? media : [],
    leftOut: state.attachments.length - (sendMedia ? media.length : 0),
    names: items.map((t) => t.name),
    targetsLabel: fbWhat(fbSelOf('group').length, fbSelOf('page').length),
    fb: {
      items: items.map((t) => ({ id: t.id, name: t.name, url: t.url, kind: t.kind, text: fbText(fbMsg.replaceAll('{group}', t.name)) })),
      linkPreview: !sendMedia || !media.length,
    },
  };
}

/** Copy files for a schedule, so later changes in Compose don't affect it. */
async function schedKeepFiles(files) {
  if (!files?.length) return { ids: [], names: [] };
  const { schedFiles = {} } = await chrome.storage.local.get('schedFiles');
  const ids = [];
  for (const a of files) {
    const id = `sf${uid()}`;
    // The edited photo is what gets posted; its original and edit recipe stay with Compose.
    const { original, edit, originalName, originalType, ...file } = a;
    schedFiles[id] = { ...file, id };
    ids.push(id);
  }
  await chrome.storage.local.set({ schedFiles });
  return { ids, names: files.map((a) => a.name) };
}

/** Remove kept files no schedule uses any more. */
async function schedDropUnused() {
  const { schedFiles = {} } = await chrome.storage.local.get('schedFiles');
  const used = new Set(sched.jobs.flatMap((j) => j.fileIds || []));
  let changed = false;
  for (const id of Object.keys(schedFiles))
    if (!used.has(id)) {
      delete schedFiles[id];
      changed = true;
    }
  if (changed) await chrome.storage.local.set({ schedFiles });
}

function schedModeHint(platform, mode) {
  if (isSocialPlat(platform)) {
    const what = platform === 'x' ? 'Post' : 'Share';
    return mode === 'auto'
      ? `Automatic: RitPost opens ${platLabel(platform)}, fills in the post and clicks ${what} after a ${soc.settings.reviewSec} s review countdown, so it can go out while you’re away.`
      : `Manual: RitPost opens ${platLabel(platform)} and fills in the post at that time; you check it and click ${what}.`;
  }
  if (platform === 'facebook')
    return mode === 'auto'
      ? `Automatic: RitPost switches profile, fills in each post, gives you ${fb.settings.reviewSec} s to check it and clicks Next; you click Post. About ${fb.settings.intervalMin}–${Math.round(fb.settings.intervalMin * 1.3)} min between posts, at most ${fb.settings.dailyLimit} a day.`
      : 'Manual: RitPost opens each group or Page and fills in the post; you check it and click Post.';
  return mode === 'auto'
    ? `Automatic: RitPost presses Send after a ${state.settings.intervalSec} s countdown on each group. WhatsApp’s terms don’t allow automated messaging, so this can get your account restricted.`
    : 'Manual: RitPost opens each group and fills in the message; you press Enter for each one.';
}

function openScheduleDialog({ platform = 'whatsapp', job = null } = {}) {
  if (!job && !planHas('schedule')) return showUpgrade({ reason: `Scheduled posting isn’t included in your ${planName()} plan.` });
  const editing = !!job;
  const quarter = 15 * 60 * 1000;
  const start = job?.next ? new Date(job.next) : new Date(Math.ceil((Date.now() + 10 * 60 * 1000) / quarter) * quarter);
  const f = {
    platform: job?.platform || platform,
    date: dateValue(start),
    time: job?.repeat?.time && job.repeat.type !== 'once' ? job.repeat.time : timeValue(start),
    repeat: job?.repeat?.type || 'once',
    days: job?.repeat?.days?.length ? [...job.repeat.days] : [start.getDay()],
    endAfter: job?.endAfter || 0,
    mode: job?.mode || null,
    remind: job ? !!job.remind : true,
    missed: job?.missed || 'run',
    label: job?.label || '',
    keepPreview: job?.fb ? job.fb.linkPreview !== false : fb.settings.linkPreview,
    refresh: false,
  };
  const defaultMode = (p) => (p === 'facebook' ? fb.settings.mode : isSocialPlat(p) ? soc.settings.mode : state.settings.mode);
  if (!f.mode) f.mode = defaultMode(f.platform);

  const firstRun = () => {
    const [y, m, d] = f.date.split('-').map(Number);
    const [hh, mm] = f.time.split(':').map(Number);
    if (!y || !m || !d || !Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    const at = new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
    if (f.repeat === 'once') return at;
    const rule = { type: f.repeat, time: f.time, days: f.days };
    let n = RS.nextOccurrence(rule, at - 1);
    if (n && n <= Date.now()) n = RS.nextOccurrence(rule, Date.now());
    return n;
  };
  const snapshot = () => (editing && !f.refresh ? null : schedSnapshot(f.platform, f.keepPreview));

  // ── fields ──
  const whatBox = h('div', { class: 'sched-what' });
  const sum = h('div', { class: 'sched-sum' });
  const modeHint = h('p', { class: 'hint' });
  const linkRow = h('div', {});
  const daysRow = h('div', { class: 'days' });
  const endRow = h('div', {});
  const platSeg = h('div', { class: 'plat-seg' });
  const whatLabel = h('label', { class: 'sl' }, 'What gets posted');

  const dateIn = h('input', { type: 'date', value: f.date, min: dateValue(new Date()), oninput: (e) => ((f.date = e.target.value), update()) });
  const timeIn = h('input', { type: 'time', value: f.time, oninput: (e) => ((f.time = e.target.value), update()) });
  const setWhen = (d) => {
    f.date = dateValue(d);
    f.time = timeValue(d);
    dateIn.value = f.date;
    timeIn.value = f.time;
    if (f.repeat === 'weekly' && !f.days.includes(d.getDay())) f.days = [d.getDay()];
    update();
  };
  const at = (dayOffset, hh, mm = 0) => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, hh, mm, 0, 0);
  };
  const tonight = () => (new Date().getHours() < 20 ? at(0, 20) : at(1, 20));
  const quick = h(
    'div',
    { class: 'quick' },
    h('button', { type: 'button', onclick: () => setWhen(new Date(Math.ceil((Date.now() + 60 * 60 * 1000) / (5 * 60 * 1000)) * 5 * 60 * 1000)) }, 'In 1 hour'),
    h('button', { type: 'button', onclick: () => setWhen(tonight()) }, new Date().getHours() < 20 ? 'Tonight 8 PM' : 'Tomorrow 8 PM'),
    h('button', { type: 'button', onclick: () => setWhen(at(1, 7)) }, 'Tomorrow 7 AM'),
    h('button', { type: 'button', onclick: () => setWhen(at(1, 12)) }, 'Tomorrow noon')
  );

  const repeatSel = h(
    'select',
    { onchange: (e) => ((f.repeat = e.target.value), update()) },
    ...[
      ['once', 'Once'],
      ['daily', 'Every day'],
      ['weekdays', 'Weekdays (Mon–Fri)'],
      ['weekly', 'Weekly, on chosen days'],
    ].map(([v, t]) => h('option', { value: v, selected: v === f.repeat }, t))
  );
  const endSel = h(
    'select',
    { onchange: (e) => ((f.endAfter = Number(e.target.value)), update()) },
    ...[0, 2, 3, 5, 7, 10, 14, 30].map((n) => h('option', { value: n, selected: n === f.endAfter }, n ? `After ${n} times` : 'Never (until you stop it)'))
  );
  const modeSel = h(
    'select',
    { onchange: (e) => ((f.mode = e.target.value), update()) },
    h('option', { value: 'manual', selected: f.mode === 'manual' }, 'Manual'),
    h('option', { value: 'auto', selected: f.mode === 'auto' }, 'Automatic')
  );
  const missedSel = h(
    'select',
    { onchange: (e) => (f.missed = e.target.value) },
    h('option', { value: 'run', selected: f.missed === 'run' }, 'Post when Chrome opens again (up to 6 h late)'),
    h('option', { value: 'skip', selected: f.missed === 'skip' }, 'Skip it and tell me')
  );
  const remindChk = h('input', { type: 'checkbox', checked: f.remind, onchange: (e) => (f.remind = e.target.checked) });
  const labelIn = h('input', { type: 'text', maxlength: 60, placeholder: 'e.g. Sunday service flyer', value: f.label, oninput: (e) => (f.label = e.target.value) });
  const refreshChk = h('input', { type: 'checkbox', onchange: (e) => ((f.refresh = e.target.checked), update()) });

  function renderPlatforms() {
    platSeg.replaceChildren(
      ...['whatsapp', 'facebook', 'instagram', 'x'].map((p) => {
        const s = schedSnapshot(p, f.keepPreview);
        return h(
          'button',
          {
            type: 'button',
            class: f.platform === p ? 'on' : '',
            onclick: () => {
              f.platform = p;
              f.mode = defaultMode(p);
              modeSel.value = f.mode;
              update();
            },
          },
          h('b', {}, platLabel(p)),
          h('small', {}, s.error ? (isSocialPlat(p) ? 'Not ready yet' : 'Nothing selected') : s.targetsLabel)
        );
      })
    );
  }

  function renderWhat() {
    if (editing && !f.refresh) {
      setChildren(whatBox, 
        h('div', { class: 'msg' }, job.message || '(no text)'),
        isSocialPlat(job.platform)
          ? h('div', {}, `On: ${job.targetsLabel}`)
          : h('div', {}, `To: ${job.targetsLabel}${job.names?.length ? ` (${job.names.slice(0, 3).join(', ')}${job.names.length > 3 ? ` +${job.names.length - 3} more` : ''})` : ''}`),
        job.fileNames?.length ? h('div', {}, `📎 ${job.fileNames.join(', ')}`) : null
      );
      return true;
    }
    const s = schedSnapshot(f.platform, f.keepPreview);
    if (s.error) {
      setChildren(whatBox, h('div', { class: 'err' }, s.error));
      return false;
    }
    setChildren(whatBox, 
      h('div', { class: 'msg' }, s.message || '(no text)'),
      isSocialPlat(f.platform)
        ? h('div', {}, `On: ${s.targetsLabel} · ${f.mode === 'auto' ? 'posted by RitPost' : 'you click to post'}`)
        : h('div', {}, `To: ${s.targetsLabel} (${s.names.slice(0, 3).join(', ')}${s.names.length > 3 ? ` +${s.names.length - 3} more` : ''})`),
      s.files.length ? h('div', {}, `📎 ${s.files.map((a) => a.name).join(', ')}`) : null,
      s.leftOut ? h('div', { class: 'muted' }, `${plural(s.leftOut, 'file')} left out on Facebook${s.conflict && f.keepPreview ? ' (for the link preview)' : ' (documents)'}.`) : null
    );
    return true;
  }

  function update() {
    if (!editing) renderPlatforms();
    const okWhat = renderWhat();
    whatLabel.textContent = editing ? 'What gets posted' : `What gets posted (from ${isSocialPlat(f.platform) ? 'the IG & X tab' : 'Compose'})`;
    modeHint.textContent = schedModeHint(f.platform, f.mode);
    modeHint.classList.toggle('warn-hint', (f.platform === 'whatsapp' || isSocialPlat(f.platform)) && f.mode === 'auto');
    daysRow.hidden = f.repeat !== 'weekly';
    daysRow.replaceChildren(
      ...[1, 2, 3, 4, 5, 6, 0].map((d) =>
        h(
          'button',
          {
            type: 'button',
            class: f.days.includes(d) ? 'on' : '',
            'aria-pressed': f.days.includes(d) ? 'true' : 'false',
            onclick: () => {
              f.days = f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d];
              update();
            },
          },
          RS.DAYS[d]
        )
      )
    );
    endRow.hidden = f.repeat === 'once';
    const snap = f.platform === 'facebook' && (!editing || f.refresh) ? schedSnapshot('facebook', f.keepPreview) : null;
    const showLink = f.platform === 'facebook' && (editing && !f.refresh ? job.message && hasLink(job.message) && (job.fileNames?.length || job.fb?.linkPreview) : snap?.conflict);
    linkRow.hidden = !showLink;
    if (showLink && !linkRow.childElementCount)
      linkRow.append(
        h('label', { class: 'sl' }, 'Link and photos/videos'),
        h(
          'select',
          { onchange: (e) => ((f.keepPreview = e.target.value === 'preview'), update()) },
          h('option', { value: 'preview', selected: f.keepPreview }, 'Show the link preview (leave photos/videos out)'),
          h('option', { value: 'media', selected: !f.keepPreview }, 'Post the photos/videos (link as plain text)')
        ),
        h('p', { class: 'hint' }, 'Facebook doesn’t show a link preview on posts with photos or videos.')
      );

    const next = firstRun();
    let problem = '';
    if (!okWhat) problem = 'Nothing to schedule yet.';
    else if (f.repeat === 'weekly' && !f.days.length) problem = 'Pick at least one day.';
    else if (!next) problem = 'Pick a date and time.';
    else if (next < Date.now() + 30 * 1000) problem = 'Pick a time in the future.';
    sum.classList.toggle('bad', !!problem);
    sum.textContent = problem
      ? problem
      : `${f.repeat === 'once' ? 'Posts' : 'First post'} ${RS.formatWhen(next)} (${RS.relative(next)})${f.repeat === 'once' ? '' : ` · then ${RS.describeRepeat({ type: f.repeat, time: f.time, days: f.days }).replace(/^Every/, 'every').replace(/^Weekdays/, 'weekdays')}${f.endAfter ? `, ${f.endAfter} times in all` : ''}`}.`;
    d.setConfirm(!problem);
  }

  const body = h(
    'div',
    { class: 'sform' },
    editing ? null : h('div', {}, h('label', { class: 'sl' }, 'Post to'), platSeg),
    h('div', {}, whatLabel, whatBox),
    editing ? h('label', { class: 'opt-check' }, refreshChk, h('span', {}, 'Use the current Compose message, files and selection instead')) : null,
    h('div', {}, h('label', { class: 'sl' }, 'When'), quick, h('div', { class: 'row2' }, dateIn, timeIn)),
    h('div', {}, h('label', { class: 'sl' }, 'Repeat'), repeatSel, daysRow),
    endRow,
    h('div', {}, h('label', { class: 'sl' }, 'How'), modeSel, modeHint),
    linkRow,
    h('label', { class: 'opt-check' }, remindChk, h('span', {}, 'Remind me 5 minutes before (a Chrome notification)')),
    h('div', {}, h('label', { class: 'sl' }, 'If Chrome is closed or the computer is asleep at that time'), missedSel),
    h('div', {}, h('label', { class: 'sl' }, 'Name (optional)'), labelIn),
    sum
  );
  endRow.append(h('label', { class: 'sl' }, 'Stop'), endSel);

  const d = openDialog({
    title: editing ? 'Edit scheduled post' : 'Schedule a post',
    confirmText: editing ? 'Save changes' : 'Schedule',
    body,
    onConfirm: () => {
      const next = firstRun();
      if (!next || next < Date.now() + 30 * 1000) return false;
      const snap = snapshot();
      if (snap?.error) return false;
      saveScheduled({ f, job, snap, next }).catch((e) => toast(`Couldn’t save the schedule: ${e?.message || e}`, true));
      return true;
    },
  });
  update();
}

async function saveScheduled({ f, job, snap, next }) {
  const repeat = { type: f.repeat, time: f.time, days: f.repeat === 'weekly' ? [...f.days].sort() : [] };
  const settingsFor = (platform, mode, s) =>
    isSocialPlat(platform)
      ? { wa: null, fb: null, social: { ...s.social } }
      : platform === 'whatsapp'
      ? { wa: { items: s.wa.items, settings: { ...state.settings, mode } }, fb: null }
      : {
          wa: null,
          fb: {
            ...s.fb,
            mode,
            gapSec: fb.settings.gapSec,
            intervalSec: fb.settings.intervalMin * 60,
            dailyLimit: fb.settings.dailyLimit,
            reviewSec: fb.settings.reviewSec,
          },
        };
  const common = {
    label: f.label.trim(),
    next,
    repeat,
    endAfter: f.repeat === 'once' ? 0 : f.endAfter,
    mode: f.mode,
    remind: f.remind,
    missed: f.missed,
    status: 'active',
    retryAt: null,
    waiting: '',
  };
  if (!job) {
    const kept = await schedKeepFiles(snap.files);
    const created = {
      id: uid(),
      platform: f.platform,
      createdAt: Date.now(),
      runs: 0,
      message: snap.message,
      names: snap.names.slice(0, 60),
      targetsLabel: snap.targetsLabel,
      fileIds: kept.ids,
      fileNames: kept.names,
      ...settingsFor(f.platform, f.mode, snap),
      ...common,
    };
    sched.jobs.push(created);
    await schedSave();
    renderSched();
    toast(`Scheduled: ${RS.formatWhen(next)} (${RS.relative(next)})`, false, { label: 'View', run: () => switchTab('schedule') });
    return;
  }
  const i = sched.jobs.findIndex((j) => j.id === job.id);
  if (i < 0) return toast('That scheduled post was deleted meanwhile.', true);
  const cur = { ...sched.jobs[i], ...common };
  if (cur.status === 'active' && job.status === 'done') cur.runs = 0;
  if (snap) {
    const kept = await schedKeepFiles(snap.files);
    Object.assign(cur, {
      message: snap.message,
      names: snap.names.slice(0, 60),
      targetsLabel: snap.targetsLabel,
      fileIds: kept.ids,
      fileNames: kept.names,
      ...settingsFor(cur.platform, f.mode, snap),
    });
  } else if (isSocialPlat(cur.platform)) cur.social = { ...cur.social };
  else if (cur.platform === 'whatsapp') cur.wa = { ...cur.wa, settings: { ...cur.wa.settings, mode: f.mode } };
  else cur.fb = { ...cur.fb, mode: f.mode };
  sched.jobs[i] = cur;
  await schedSave();
  await schedDropUnused();
  renderSched();
  toast(`Saved: next post ${RS.formatWhen(next)}`);
}

function schedSetStatus(id, status) {
  const j = sched.jobs.find((x) => x.id === id);
  if (!j) return;
  if (status === 'active') {
    // Resuming: a time that has passed moves on to the next one (or asks for a new time).
    if (!j.next || j.next < Date.now() + 30 * 1000) {
      const n = RS.nextOccurrence(j.repeat, Date.now());
      if (!n) return openScheduleDialog({ job: j });
      j.next = n;
    }
    j.retryAt = null;
    j.waiting = '';
  }
  j.status = status;
  schedSave();
  renderSched();
  toast(status === 'paused' ? 'Paused. It won’t post until you resume it.' : `Resumed: next post ${RS.formatWhen(j.next)}`);
}

function schedDelete(id) {
  const i = sched.jobs.findIndex((x) => x.id === id);
  if (i < 0) return;
  const [removed] = sched.jobs.splice(i, 1);
  schedSave();
  renderSched();
  let undone = false;
  setTimeout(() => !undone && schedDropUnused(), 8000);
  toast(`Deleted “${schedTitle(removed)}”`, false, {
    label: 'Undo',
    run: () => {
      undone = true;
      sched.jobs.splice(Math.min(i, sched.jobs.length), 0, removed);
      schedSave();
      renderSched();
    },
  });
}

function schedRunNow(id) {
  const j = sched.jobs.find((x) => x.id === id);
  if (!j) return;
  openDialog({
    title: 'Post now?',
    confirmText: 'Post now',
    body: h('p', {}, `RitPost starts “${schedTitle(j)}” on ${platLabel(j.platform)} now (${j.targetsLabel}). ${j.repeat?.type === 'once' ? 'This uses up the schedule.' : 'The repeat schedule stays as it is.'}`),
    onConfirm: () => {
      bg('BG_SCHED_RUN', { id }).then((res) => (res?.ok ? toast('Started.') : planBlocked(res) || toast(res?.error || 'Couldn’t start it.', true)));
      return true;
    },
  });
}

function schedClearFinished() {
  sched.jobs = sched.jobs.filter((j) => j.status !== 'done');
  schedSave().then(schedDropUnused);
  renderSched();
}

const HIST_ICON = { started: '✓', missed: '!', failed: '✕', waiting: '…' };
const HIST_TEXT = { started: 'Started', missed: 'Missed', failed: 'Couldn’t start', waiting: 'Waiting' };

function renderSched() {
  const active = sched.jobs.filter((j) => j.status === 'active').length;
  $('schedCount').textContent = active ? String(active) : '';
  const rank = { active: 0, paused: 1, done: 2 };
  const jobs = [...sched.jobs].sort((a, b) => rank[a.status] - rank[b.status] || (a.next || Infinity) - (b.next || Infinity) || (b.lastRunAt || 0) - (a.lastRunAt || 0));
  const cards = jobs.map((j) => {
    const plat = platLabel(j.platform);
    const chip =
      j.status === 'paused'
        ? h('span', { class: 'chip' }, 'Paused')
        : j.status === 'done'
          ? h('span', { class: 'chip' }, 'Finished')
          : j.waiting
            ? h('span', { class: 'chip waiting' }, 'Waiting')
            : h('span', { class: 'chip active' }, 'Scheduled');
    const when =
      j.status === 'done'
        ? h('div', { class: 'sched-when' }, j.lastRunAt ? `Last posted ${RS.formatWhen(j.lastRunAt)}` : 'Finished')
        : h('div', { class: 'sched-when' }, h('b', {}, RS.formatWhen(j.next)), ` · ${RS.relative(j.next)}`);
    const repeatTxt = RS.describeRepeat(j.repeat);
    const meta = [
      j.repeat?.type === 'once' ? 'Once' : `${repeatTxt}${j.endAfter ? ` · ${j.runs || 0} of ${j.endAfter} done` : j.runs ? ` · posted ${j.runs}×` : ''}`,
      `To ${j.targetsLabel}`,
      j.fileNames?.length ? plural(j.fileNames.length, 'file') : null,
      j.mode === 'auto' ? 'Automatic' : 'Manual',
    ]
      .filter(Boolean)
      .join(' · ');
    const btn = (label, run, cls = 'secondary') => h('button', { type: 'button', class: `btn ${cls} sm`, onclick: run }, label);
    const actions =
      j.status === 'done'
        ? [btn('Schedule again', () => openScheduleDialog({ job: { ...j, next: null } })), btn('Delete', () => schedDelete(j.id), 'danger')]
        : [
            btn('Post now', () => schedRunNow(j.id)),
            j.status === 'paused' ? btn('Resume', () => schedSetStatus(j.id, 'active')) : btn('Pause', () => schedSetStatus(j.id, 'paused')),
            btn('Edit', () => openScheduleDialog({ job: j })),
            btn('Delete', () => schedDelete(j.id), 'danger'),
          ];
    return h(
      'div',
      { class: `sched-card ${j.status}`, 'data-sched-id': j.id },
      h('div', { class: 'sched-top' }, h('span', { class: `plat ${j.platform}` }, plat), h('span', { class: 'sched-title', title: j.message || '' }, schedTitle(j)), chip),
      when,
      h('div', { class: 'sched-meta' }, meta),
      j.waiting && j.status === 'active' ? h('div', { class: 'sched-note' }, `${j.waiting} It starts as soon as that finishes.`) : null,
      h('div', { class: 'sched-actions' }, ...actions)
    );
  });
  if (sched.jobs.some((j) => j.status === 'done'))
    cards.push(h('button', { type: 'button', class: 'link', style: 'justify-self:start', onclick: schedClearFinished }, 'Clear finished'));
  $('schedList').replaceChildren(...cards);
  $('schedEmpty').hidden = sched.jobs.length > 0;

  $('schedHistWrap').hidden = !sched.history.length;
  $('schedHist').replaceChildren(
    ...sched.history.slice(0, 15).map((e) =>
      h(
        'li',
        {},
        h('span', { class: `ic ${e.outcome}` }, HIST_ICON[e.outcome] || '•'),
        h('span', { class: 'txt' }, h('b', {}, `${HIST_TEXT[e.outcome] || e.outcome}: `), `${e.title} (${platLabel(e.platform)})`, e.detail ? h('span', { class: 'muted' }, ` — ${e.detail}`) : null),
        h('span', { class: 'ago' }, RS.relative(e.at))
      )
    )
  );
}

function schedBind() {
  $('schedBtn').addEventListener('click', () => {
    const tab = document.body.dataset.tab;
    openScheduleDialog({ platform: tab === 'facebook' ? 'facebook' : tab === 'social' ? soc.settings.platform : 'whatsapp' });
  });
  $('schedNewBtn').addEventListener('click', () => openScheduleDialog({ platform: 'whatsapp' }));
  $('schedHistClear').addEventListener('click', () => {
    sched.history = [];
    persist({ schedHistory: [] });
    renderSched();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.schedules) sched.jobs = changes.schedules.newValue || [];
    if (changes.schedHistory) sched.history = changes.schedHistory.newValue || [];
    if (changes.schedules || changes.schedHistory) renderSched();
  });
  // Keep "in 2 h" style times fresh.
  setInterval(() => !document.hidden && renderSched(), 30000);
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
  window.RitEmoji?.attach($('emojiBtn'), { target: ta });
  $('studioBtn').addEventListener('click', () => openStudio(state.attachments.find((a) => a.type.startsWith('image/'))?.id));

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
    if (area === 'local' && changes.attachments) {
      // Edited, reordered or added in RitPost Studio.
      const list = (changes.attachments.newValue || []).filter((a) => a?.id && a?.data);
      const sig = (l) => l.map((a) => `${a.id}:${a.size}`).join('|');
      if (sig(list) !== sig(state.attachments)) {
        state.attachments = list;
        renderAttachments();
        renderCounts();
      }
    }
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
  await schedLoad();
  await socLoad();
  await aiLoad();
  bind();
  aiBind();
  renderAiSettings();
  aiRefreshStatus();
  fbBind();
  socBind();
  schedBind();
  renderAll();
  renderSched();
  $('version').textContent = `RitPost v${chrome.runtime.getManifest().version}`;

  // Opened while on Facebook: show the Facebook tab. Otherwise bring WhatsApp Web up beside the panel.
  let onFacebook = false;
  let onSocial = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    onFacebook = /^https:\/\/([a-z0-9-]+\.)*facebook\.com\//i.test(tab?.url || '');
    onSocial = /^https:\/\/(www\.)?instagram\.com\//i.test(tab?.url || '') ? 'instagram' : /^https:\/\/(x|twitter)\.com\//i.test(tab?.url || '') ? 'x' : null;
  } catch {
    /* no tab info */
  }
  if (onFacebook) switchTab('facebook');
  else if (onSocial) {
    if (soc.settings.platform !== onSocial) {
      soc.settings.platform = onSocial;
      socSave();
      renderSoc();
    }
    switchTab('social');
  } else {
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
