'use strict';

// STE Whiteboard client: pan/zoom canvas, auto-laid-out turn rows, draggable
// cards and notes, live updates over SSE, and an STE inspector.

const COLS = ['request', 'progress', 'changes', 'result'];
const COL_LABEL = { request: 'REQUEST', progress: 'PROGRESS', changes: 'CHANGES', result: 'RESULT' };
const CARD_W = 320;
const GAP = 40;
const LEFT = 76;
const TOP = 40;
const colX = (type) => LEFT + COLS.indexOf(type) * (CARD_W + GAP);
const NOTE_X = LEFT + COLS.length * (CARD_W + GAP) + GAP;
const CARD_CAP = 6; // statements a card shows before "+N MORE"
const COMPACT_K = 0.6; // below this zoom, cards shrink to a one-statement summary
const RULES = {
  length: 'LENGTH',
  active: 'ACTIVE',
  simpleVerb: 'VERB',
  clear: 'CLEAR',
};

const $ = (sel) => document.querySelector(sel);
const viewport = $('#viewport');
const world = $('#world');
const inspector = $('#inspector');

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage off */ } },
};

let board = { cards: [], state: { positions: {}, hidden: [], notes: [] }, git: { repo: false }, target: { min: 75, max: 80 } };
let sessionId = store.get('ste.session', 'latest');
let view = store.get('ste.view', { x: 24, y: 24, k: 0.9 });
let selected = null;
let expanded = new Set();
let compact = false;
let seen = new Set();
let firstRender = true;
let lastInteraction = 0;
let events = null;

// --- helpers ------------------------------------------------------------------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function inline(s) {
  return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
}
function hhmm(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toTimeString().slice(0, 5);
}
function band(score) {
  const { min, max } = board.target;
  if (score == null) return '';
  return score < min ? 'below' : score > max ? 'above' : 'in';
}
function api(path, opts = {}) {
  const sep = path.includes('?') ? '&' : '?';
  return fetch(`${path}${sep}session=${encodeURIComponent(sessionId)}`, {
    ...opts,
    headers: { 'content-type': 'application/json' },
  }).then((r) => r.json());
}

// --- view transform ----------------------------------------------------------

function applyView() {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  const g = 22 * view.k;
  viewport.style.backgroundSize = `${g}px ${g}px`;
  viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
  $('#zoom-level').textContent = `${Math.round(view.k * 100)}%`;
  setCompact(view.k < COMPACT_K);
  store.set('ste.view', view);
}

/** Compact cards change height, so the turn rows must be laid out again. */
function setCompact(on) {
  if (on === compact) return;
  compact = on;
  viewport.classList.toggle('is-compact', on);
  layout(visibleCards());
}

function zoomCenter(factor) {
  const r = viewport.getBoundingClientRect();
  zoomAt(r.width / 2, r.height / 2, factor);
}

function zoomAt(cx, cy, factor) {
  const k = Math.min(2.5, Math.max(0.2, view.k * factor));
  view.x = cx - ((cx - view.x) * k) / view.k;
  view.y = cy - ((cy - view.y) * k) / view.k;
  view.k = k;
  applyView();
}

function toWorld(clientX, clientY) {
  const r = viewport.getBoundingClientRect();
  return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k };
}

function bounds() {
  const els = [...world.querySelectorAll('.card')];
  if (!els.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of els) {
    const x = el.offsetLeft, y = el.offsetTop;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + el.offsetWidth); maxY = Math.max(maxY, y + el.offsetHeight);
  }
  return { minX: Math.min(minX, 0), minY: Math.min(minY, 0), maxX, maxY };
}

function fit() {
  const r = viewport.getBoundingClientRect();
  const scale = (b) => Math.min(1.2, Math.max(0.2, Math.min((r.width - 48) / (b.maxX - b.minX), (r.height - 48) / (b.maxY - b.minY))));
  // Measure full cards first. If they only fit below COMPACT_K, measure the compact cards instead.
  setCompact(false);
  let b = bounds();
  if (!b) return;
  let k = scale(b);
  if (k < COMPACT_K) {
    setCompact(true);
    b = bounds();
    k = Math.min(scale(b), COMPACT_K - 0.01);
  }
  view = { k, x: 24 - b.minX * k, y: 24 - b.minY * k };
  applyView();
}

function panTo(el) {
  const r = viewport.getBoundingClientRect();
  const targetY = r.height - 40 - (el.offsetTop + el.offsetHeight) * view.k;
  if (el.offsetTop * view.k + view.y > r.height - 80 || (el.offsetTop + el.offsetHeight) * view.k + view.y > r.height) {
    view.y = Math.max(targetY, 24 - el.offsetTop * view.k);
    world.style.transition = 'transform .5s var(--ease)';
    applyView();
    setTimeout(() => { world.style.transition = ''; }, 520);
  }
}

// --- rendering ------------------------------------------------------------------

function cardHTML(c) {
  const issues = (s) => Object.entries(s.checks || {}).filter(([, ok]) => !ok).map(([k]) => RULES[k]);
  const extra = c.statements.length - CARD_CAP;
  const open = expanded.has(c.id);
  const shown = extra > 0 && !open ? c.statements.slice(0, CARD_CAP) : c.statements;
  const items = shown.map((s) => {
    const bad = issues(s);
    const flag = s.kind === 'caution' ? '<span class="s__flag">CAUTION</span>' : '';
    return `<li class="s s--${s.kind}${bad.length ? ' has-issue' : ''}"${bad.length ? ` title="Guideline gaps: ${bad.join(', ')}"` : ''}>${flag}${inline(s.text)}</li>`;
  }).join('');
  const score = c.score != null ? `<span class="card__score ${band(c.score) === 'below' ? 'below' : ''}">STE ${c.score}%</span>` : '<span class="card__score">LOG</span>';
  const code = c.code && c.code.length ? `<pre class="card__code">${esc(c.code[0])}</pre>` : '';
  const foot = [];
  if (extra > 0) foot.push(`<button data-act="expand" aria-expanded="${open}">${open ? 'SHOW LESS' : `+${extra} MORE`}</button>`);
  if (c.more) foot.push(`<span title="The distiller keeps the first statements only.">${c.more} trimmed</span>`);
  if (c.source) foot.push('<button data-act="source">SOURCE</button>');
  return `
    <div class="card__head" data-drag>
      <span class="card__tag">${COL_LABEL[c.type]}</span>
      <span class="card__meta">T${String(c.turn).padStart(2, '0')} · ${hhmm(c.ts)}</span>
      ${score}
      <button class="card__x" data-act="hide" title="Hide card" aria-label="Hide card">×</button>
    </div>
    <ol class="stmts">${items || '<li class="s">No statements.</li>'}</ol>
    ${code}
    ${foot.length ? `<div class="card__foot">${foot.join('<span>·</span>')}</div>` : ''}`;
}

function noteHTML(n) {
  const score = n.score != null ? `<span class="card__score ${band(n.score) === 'below' ? 'below' : ''}">STE ${n.score}%</span>` : '<span class="card__score">NOTE</span>';
  return `
    <div class="card__head" data-drag>
      <span class="card__tag">NOTE</span>
      <span class="card__meta">${hhmm(n.ts)}</span>
      ${score}
      <button class="card__x" data-act="delete-note" title="Delete note" aria-label="Delete note">×</button>
    </div>
    <textarea class="note__text" placeholder="Type a note. Use STE to rewrite it." spellcheck="false">${esc(n.text || '')}</textarea>
    <div class="card__foot"><button data-act="ste">REWRITE AS STE</button></div>`;
}

function visibleCards() {
  const hidden = new Set(board.state.hidden);
  return board.cards.filter((c) => !hidden.has(c.id));
}

function render() {
  const { state } = board;
  const visible = visibleCards();
  const keep = new Set();

  // Columns header.
  let head = world.querySelector('.col-heads');
  if (!head) {
    head = document.createElement('div');
    head.className = 'col-heads';
    head.innerHTML = COLS.map((t) => `<div class="col-head" style="left:${colX(t)}px;width:${CARD_W}px"><b style="background:var(--c-${t})"></b>${COL_LABEL[t]}</div>`).join('');
    world.appendChild(head);
  }

  // Cards: create or update in place so live updates do not flicker.
  for (const c of visible) {
    keep.add(c.id);
    let el = world.querySelector(`[data-id="${CSS.escape(c.id)}"]`);
    const html = cardHTML(c);
    if (!el) {
      el = document.createElement('article');
      el.className = `card card--${c.type}`;
      el.dataset.id = c.id;
      el.dataset.kind = 'card';
      if (!firstRender && !seen.has(c.id)) el.classList.add('is-new');
      world.appendChild(el);
    }
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
    el.classList.toggle('is-selected', selected === c.id);
    seen.add(c.id);
  }

  // Notes.
  for (const n of state.notes) {
    keep.add(n.id);
    let el = world.querySelector(`[data-id="${CSS.escape(n.id)}"]`);
    if (!el) {
      el = document.createElement('article');
      el.className = 'card card--note';
      el.dataset.id = n.id;
      el.dataset.kind = 'note';
      el.innerHTML = noteHTML(n);
      world.appendChild(el);
    } else if (document.activeElement !== el.querySelector('textarea')) {
      const html = noteHTML(n);
      if (el._html !== html) { el.innerHTML = html; el._html = html; }
    }
    el.style.left = `${n.x}px`;
    el.style.top = `${n.y}px`;
    el.classList.toggle('is-selected', selected === n.id);
  }

  for (const el of world.querySelectorAll('.card')) {
    if (!keep.has(el.dataset.id)) {
      if (selected === el.dataset.id) selected = null;
      el.remove();
    }
  }

  layout(visible);
  renderMeter(visible);
  renderInspector();
  $('#empty').hidden = !!board.session;
  firstRender = false;
}

/** Turn rows: each turn gets a row; cards without a saved position sit in their column. */
function layout(visible) {
  const { positions } = board.state;
  for (const el of world.querySelectorAll('.row-label')) el.remove();
  const byTurn = new Map();
  for (const c of visible) {
    if (!byTurn.has(c.turn)) byTurn.set(c.turn, []);
    byTurn.get(c.turn).push(c);
  }
  let y = TOP;
  for (const [turn, cards] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
    let rowH = 0;
    for (const c of cards) {
      const el = world.querySelector(`[data-id="${CSS.escape(c.id)}"]`);
      if (!el) continue;
      const pos = positions[c.id] || { x: colX(c.type), y };
      el.style.left = `${pos.x}px`;
      el.style.top = `${pos.y}px`;
      rowH = Math.max(rowH, positions[c.id] ? 0 : el.offsetHeight);
    }
    const label = document.createElement('div');
    label.className = 'row-label';
    label.style.left = '0px';
    label.style.top = `${y}px`;
    label.innerHTML = `<strong>T${String(turn).padStart(2, '0')}</strong>${hhmm(cards[0].ts)}`;
    world.appendChild(label);
    y += Math.max(rowH, 60) + GAP;
  }
}

function avgScore(cards) {
  const scored = cards.filter((c) => c.score != null);
  return scored.length ? Math.round(scored.reduce((a, c) => a + c.score, 0) / scored.length) : null;
}

function renderMeter(visible) {
  const score = avgScore(visible);
  const { min, max } = board.target;
  $('#meter-value').textContent = score == null ? 'STE —' : `STE ${score}%`;
  const status = $('#meter-status');
  const b = band(score);
  status.className = `meter__status ${b}`;
  status.textContent = score == null ? `target ${min}–${max}` : b === 'in' ? 'IN TARGET' : b === 'above' ? 'ABOVE TARGET' : 'BELOW TARGET';
  $('#meter-fill').style.width = `${score || 0}%`;
  const bandEl = $('#meter-band');
  bandEl.style.left = `${min}%`;
  bandEl.style.width = `${max - min}%`;
}

function renderGitChip() {
  const g = board.git;
  const chip = $('#git-chip');
  if (!g || !g.repo) { chip.textContent = 'no git'; return; }
  chip.innerHTML = `${esc(g.branch)} · ${g.files.length} changed <span class="add">+${g.added}</span> <span class="del">−${g.removed}</span>`;
}

function renderInspector() {
  const card = board.cards.find((c) => c.id === selected);
  inspector.innerHTML = `<div class="insp">${card ? cardInspector(card) : overview()}</div>`;
}

function cardInspector(c) {
  const checks = c.statements.map((s) => {
    const pills = Object.entries(s.checks || {}).map(([k, ok]) => `<span class="pill ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'} ${RULES[k]}</span>`).join('');
    return `<div class="check"><p>${inline(s.text)}</p><div class="pills"><span class="pill">${s.kind.toUpperCase()}</span>${pills}</div></div>`;
  }).join('');
  return `
    <section>
      <h2>${COL_LABEL[c.type]} · TURN ${c.turn}</h2>
      <div class="big">${c.score != null ? `${c.score}%` : 'LOG'}</div>
      <p>${c.score != null ? `STE compliance. Target ${board.target.min}–${board.target.max}%.` : 'Factual change log. Not scored.'}</p>
      <div class="row"><button class="btn btn--sm" data-act="deselect">← Overview</button><button class="btn btn--sm" data-act="hide-selected">Hide card</button></div>
    </section>
    <section><h2>STATEMENTS</h2>${checks}</section>
    ${c.source ? `<section><h2>SOURCE TEXT</h2><pre>${esc(c.source)}</pre></section>` : ''}`;
}

function overview() {
  const hidden = new Set(board.state.hidden);
  const visible = board.cards.filter((c) => !hidden.has(c.id));
  const stmts = visible.flatMap((c) => (c.score != null ? c.statements : []));
  const gaps = Object.keys(RULES).map((k) => [k, stmts.filter((s) => s.checks && s.checks[k] === false).length]);
  const turns = new Set(visible.map((c) => c.turn)).size;
  const score = avgScore(visible);
  const g = board.git;
  const files = g && g.repo ? g.files.slice(0, 12).map((f) => `<li><span class="code">${esc(f.code)}</span><span>${esc(f.path)}</span></li>`).join('') : '';
  const commits = g && g.repo ? g.commits.slice(0, 8).map((c) => `<li><span class="hash">${esc(c.hash)}</span><span>${esc(c.subject)}</span></li>`).join('') : '';
  return `
    <section>
      <h2>SESSION</h2>
      <div class="big">${score == null ? '—' : `${score}%`}</div>
      <p>Average STE compliance. Target ${board.target.min}–${board.target.max}%. The rules are a guideline, not a hard limit.</p>
      <div class="kv">
        <span>Turns</span><span>${turns}</span>
        <span>Cards</span><span>${visible.length}</span>
        <span>Statements</span><span>${stmts.length}</span>
        <span>Hidden cards</span><span>${hidden.size}${hidden.size ? ' <button class="btn btn--sm" data-act="unhide">Show</button>' : ''}</span>
      </div>
    </section>
    <section>
      <h2>GUIDELINE GAPS</h2>
      <div class="kv">${gaps.map(([k, n]) => `<span>${RULES[k]}</span><span>${n}</span>`).join('')}</div>
    </section>
    <section>
      <h2>STE RULES IN USE</h2>
      <div class="rule"><b>LENGTH</b><span>Max 20 words for a procedure step. Max 25 words for a description.</span></div>
      <div class="rule"><b>ACTIVE</b><span>Use the active voice. Say who does the action.</span></div>
      <div class="rule"><b>VERB</b><span>Use simple verb tenses. Do not use "-ing" verb forms.</span></div>
      <div class="rule"><b>CLEAR</b><span>Do not use vague words like "maybe" or "probably".</span></div>
      <div class="rule"><b>WORDS</b><span>Use approved words: "use", not "utilize". Remove filler words.</span></div>
      <div class="rule"><b>STEPS</b><span>Write instructions as commands. One step on each line.</span></div>
      <div class="rule"><b>CAUTION</b><span>Put a CAUTION flag on risk and failure statements.</span></div>
    </section>
    ${g && g.repo ? `
    <section>
      <h2>WORKING TREE · ${esc(g.branch)}</h2>
      ${files ? `<ul>${files}</ul>` : '<p>No uncommitted changes.</p>'}
      ${g.files.length > 12 ? `<p>+${g.files.length - 12} more files.</p>` : ''}
    </section>
    <section><h2>COMMITS</h2><ul>${commits || '<li>No commits.</li>'}</ul></section>` : ''}
    <section><h2>CONTROLS</h2>
      <p>Drag the board to move. Ctrl + scroll or pinch to zoom. Drag a card header to move the card. Double-click the board to add a note. Press <code>f</code> to fit and <code>i</code> to hide this panel.</p>
    </section>`;
}

// --- data ------------------------------------------------------------------------

async function loadSessions() {
  const list = await fetch('/api/sessions').then((r) => r.json());
  const sel = $('#session');
  sel.innerHTML = '<option value="latest">Latest session</option>' + list.map((s) => `<option value="${esc(s.id)}">${esc(hhmm(s.mtime))} · ${esc(s.title)}</option>`).join('');
  sel.value = list.some((s) => s.id === sessionId) ? sessionId : 'latest';
  sessionId = sel.value;
}

function setBoard(data) {
  const prevIds = new Set(board.cards.map((c) => c.id));
  board = data;
  $('#export').href = `/api/export?session=${encodeURIComponent(sessionId)}`;
  $('#empty-path').textContent = data.project || '';
  renderGitChip();
  render();
  const fresh = board.cards.filter((c) => !prevIds.has(c.id));
  if (fresh.length && prevIds.size && $('#follow').checked && Date.now() - lastInteraction > 8000) {
    const el = world.querySelector(`[data-id="${CSS.escape(fresh[fresh.length - 1].id)}"]`);
    if (el) panTo(el);
  }
}

/** True when at least one card overlaps the visible part of the board. */
function anyCardInView() {
  const r = viewport.getBoundingClientRect();
  return [...world.querySelectorAll('.card')].some((el) => {
    const b = el.getBoundingClientRect();
    return b.right > r.left && b.left < r.right && b.bottom > r.top && b.top < r.bottom;
  });
}

async function load() {
  seen = new Set();
  firstRender = true;
  selected = null;
  expanded = new Set();
  world.innerHTML = '';
  setBoard(await api('/api/board'));
  if (!anyCardInView()) fit(); // the saved view can point at another session's cards
  connect();
}

function connect() {
  if (events) events.close();
  events = new EventSource(`/api/events?session=${encodeURIComponent(sessionId)}`);
  let opened = false;
  events.onopen = () => {
    $('#live').classList.add('is-on');
    // After a reconnect (server restart), events may have been missed: refetch.
    if (opened) api('/api/board').then(setBoard);
    opened = true;
  };
  events.onerror = () => $('#live').classList.remove('is-on');
  events.addEventListener('board', (e) => setBoard(JSON.parse(e.data)));
  events.addEventListener('state', (e) => { board.state = JSON.parse(e.data); render(); });
  events.addEventListener('git', (e) => { board.git = JSON.parse(e.data); renderGitChip(); if (!selected) renderInspector(); });
}

function patch(body) {
  return api('/api/state', { method: 'PATCH', body: JSON.stringify(body) }).then((state) => {
    if (state && state.positions) board.state = state;
    return state;
  });
}

// --- notes -------------------------------------------------------------------------

function addNote(at) {
  const r = viewport.getBoundingClientRect();
  const p = at || toWorld(r.left + r.width / 2 - 160 * view.k, r.top + 120);
  const note = { id: `note-${Date.now().toString(36)}`, x: Math.round(p.x), y: Math.round(p.y), text: '', ts: Date.now(), score: null };
  board.state.notes.push(note);
  render();
  patch({ notes: [note] });
  const ta = world.querySelector(`[data-id="${note.id}"] textarea`);
  if (ta) ta.focus();
}

async function scoreNote(id, text, rewrite) {
  const res = await fetch('/api/distill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, mode: 'note' }) }).then((r) => r.json());
  const update = { id, score: res.score };
  if (rewrite) update.text = res.statements.map((s) => (s.kind === 'caution' ? `CAUTION: ${s.text}` : s.text)).join('\n');
  else update.text = text;
  const note = board.state.notes.find((n) => n.id === id);
  if (note) Object.assign(note, update);
  const ta = world.querySelector(`[data-id="${CSS.escape(id)}"] textarea`);
  if (rewrite && ta) ta.value = update.text;
  await patch({ notes: [update] });
  render();
}

// --- interaction -------------------------------------------------------------------

let drag = null;

viewport.addEventListener('pointerdown', (e) => {
  lastInteraction = Date.now();
  if (e.target.closest('.zoom')) return;
  const cardEl = e.target.closest('.card');
  if (cardEl) {
    if (!e.target.closest('[data-drag]') || e.target.closest('button')) return;
    const start = toWorld(e.clientX, e.clientY);
    drag = { el: cardEl, dx: start.x - cardEl.offsetLeft, dy: start.y - cardEl.offsetTop, moved: false };
    cardEl.classList.add('is-dragging');
    viewport.setPointerCapture(e.pointerId);
    return;
  }
  drag = { pan: true, sx: e.clientX - view.x, sy: e.clientY - view.y, moved: false };
  viewport.classList.add('is-panning');
  viewport.setPointerCapture(e.pointerId);
});

viewport.addEventListener('pointermove', (e) => {
  if (!drag) return;
  drag.moved = true;
  if (drag.pan) {
    view.x = e.clientX - drag.sx;
    view.y = e.clientY - drag.sy;
    applyView();
    return;
  }
  const p = toWorld(e.clientX, e.clientY);
  drag.el.style.left = `${Math.round(p.x - drag.dx)}px`;
  drag.el.style.top = `${Math.round(p.y - drag.dy)}px`;
});

viewport.addEventListener('pointerup', () => {
  if (!drag) return;
  const d = drag;
  drag = null;
  viewport.classList.remove('is-panning');
  if (d.pan) {
    if (!d.moved && selected) { selected = null; render(); }
    return;
  }
  d.el.classList.remove('is-dragging');
  if (!d.moved) return;
  const x = d.el.offsetLeft, y = d.el.offsetTop, id = d.el.dataset.id;
  if (d.el.dataset.kind === 'note') {
    const n = board.state.notes.find((m) => m.id === id);
    if (n) Object.assign(n, { x, y });
    patch({ notes: [{ id, x, y }] });
  } else {
    board.state.positions[id] = { x, y };
    patch({ positions: { [id]: { x, y } } });
  }
});

viewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  lastInteraction = Date.now();
  const r = viewport.getBoundingClientRect();
  if (e.ctrlKey || e.metaKey) {
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01));
  } else {
    view.x -= e.deltaX;
    view.y -= e.deltaY;
    applyView();
  }
}, { passive: false });

viewport.addEventListener('dblclick', (e) => {
  if (e.target.closest('.card, .zoom')) return;
  addNote(toWorld(e.clientX, e.clientY));
});

viewport.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]');
  const cardEl = e.target.closest('.card');
  if (act && cardEl) {
    const id = cardEl.dataset.id;
    if (act.dataset.act === 'hide') {
      board.state.hidden.push(id);
      if (selected === id) selected = null;
      patch({ hide: [id] });
      render();
    } else if (act.dataset.act === 'source') {
      selected = id;
      setInspector(true);
      render();
    } else if (act.dataset.act === 'expand') {
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      render();
    } else if (act.dataset.act === 'delete-note') {
      board.state.notes = board.state.notes.filter((n) => n.id !== id);
      patch({ removeNotes: [id] });
      render();
    } else if (act.dataset.act === 'ste') {
      scoreNote(id, cardEl.querySelector('textarea').value, true);
    }
    return;
  }
  if (cardEl && cardEl.dataset.kind === 'card' && !window.getSelection().toString()) {
    selected = selected === cardEl.dataset.id ? null : cardEl.dataset.id;
    render();
  }
});

world.addEventListener('focusout', (e) => {
  if (!e.target.matches('.note__text')) return;
  if (e.relatedTarget && e.relatedTarget.dataset.act === 'ste') return; // the rewrite saves it
  const id = e.target.closest('.card').dataset.id;
  const note = board.state.notes.find((n) => n.id === id);
  if (note && note.text !== e.target.value) scoreNote(id, e.target.value, false);
});

inspector.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]');
  if (!act) return;
  if (act.dataset.act === 'deselect') selected = null;
  if (act.dataset.act === 'hide-selected' && selected) { board.state.hidden.push(selected); patch({ hide: [selected] }); selected = null; }
  if (act.dataset.act === 'unhide') { board.state.hidden = []; patch({ unhideAll: true }); }
  render();
});

window.addEventListener('keydown', (e) => {
  if (e.target.matches('textarea, input, select')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape' && selected) { selected = null; render(); }
  if (e.key === 'f') fit();
  if (e.key === 'i') setInspector(document.body.classList.contains('insp-closed'));
  if (e.key === 'n') { e.preventDefault(); addNote(); }
  if (e.key === '=' || e.key === '+') zoomCenter(1.2);
  if (e.key === '-') zoomCenter(1 / 1.2);
});

function setInspector(open) {
  document.body.classList.toggle('insp-closed', !open);
  const btn = $('#inspector-toggle');
  btn.setAttribute('aria-expanded', String(open));
  btn.title = `${open ? 'Hide' : 'Show'} inspector (i)`;
  store.set('ste.inspector', open);
}

$('#add-note').addEventListener('click', () => addNote());
$('#fit').addEventListener('click', fit);
$('#zoom-in').addEventListener('click', () => zoomCenter(1.2));
$('#zoom-out').addEventListener('click', () => zoomCenter(1 / 1.2));
$('#zoom-level').addEventListener('click', () => zoomCenter(1 / view.k));
$('#inspector-toggle').addEventListener('click', () => setInspector(document.body.classList.contains('insp-closed')));
$('#relayout').addEventListener('click', () => {
  const ids = Object.keys(board.state.positions);
  board.state.positions = {};
  render();
  patch({ positions: Object.fromEntries(ids.map((id) => [id, null])) }).then(() => { board.state.positions = {}; render(); });
});
$('#session').addEventListener('change', (e) => {
  sessionId = e.target.value;
  store.set('ste.session', sessionId);
  load();
});
$('#follow').addEventListener('change', (e) => store.set('ste.follow', e.target.checked));
$('#theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('ste.theme', next);
});

// --- boot ---------------------------------------------------------------------------

document.documentElement.dataset.theme = store.get('ste.theme', 'dark');
$('#follow').checked = store.get('ste.follow', true);
setInspector(store.get('ste.inspector', true));
applyView();
loadSessions().then(load);
setInterval(loadSessions, 30000);
