'use strict';

// Turns session turns into whiteboard cards, and stores the parts people edit
// (card positions, hidden cards, sticky notes) in data/boards/<session>.json.

const fs = require('fs');
const path = require('path');
const { distill } = require('./ste');

// The plugin launcher points this outside the plugin folder, which updates replace.
const DATA_DIR = process.env.STE_DATA_DIR || path.join(__dirname, '..', 'data', 'boards');

function changeStatements(turn) {
  const out = [];
  for (const f of turn.files.values()) {
    const verb = f.created ? 'Created' : 'Changed';
    const times = !f.created && f.edits > 1 ? ` (${f.edits} edits)` : '';
    out.push({ text: `${verb} \`${f.path}\`${times}.`, kind: 'desc' });
  }
  for (const a of turn.arch) {
    const parts = [];
    if (a.added.length) parts.push(`added or changed ${a.added.join(', ')}`);
    if (a.removed.length) parts.push(`removed ${a.removed.join(', ')}`);
    if (!parts.length && a.edges) parts.push(`changed ${a.edges} connections`);
    if (parts.length) out.push({ text: `Architecture map: ${parts.join('; ')}.`, kind: 'desc' });
  }
  if (turn.commands) {
    out.push({ text: `Ran ${turn.commands} shell command${turn.commands > 1 ? 's' : ''}.`, kind: 'desc' });
  }
  return out;
}

function card(id, turnIndex, type, ts, result, source) {
  return {
    id, turn: turnIndex, type, ts,
    statements: result.statements,
    more: result.more || 0,
    code: result.code || [],
    score: result.score ?? null,
    source: source || '',
  };
}

function buildCards(session) {
  const cards = [];
  session.turns.forEach((turn, i) => {
    const n = i + 1;
    if (turn.prompt) {
      cards.push(card(`${turn.id}:request`, n, 'request', turn.ts,
        distill(turn.prompt, { mode: 'request', max: 6 }), turn.prompt));
    }
    const texts = turn.texts;
    if (texts.length > 1) {
      const progress = texts.slice(0, -1).map((t) => t.text).join('\n\n');
      cards.push(card(`${turn.id}:progress`, n, 'progress', texts[0].ts,
        distill(progress, { mode: 'response', max: 6 }), progress));
    }
    const changes = changeStatements(turn);
    if (changes.length) {
      cards.push(card(`${turn.id}:changes`, n, 'changes', turn.updated,
        { statements: changes.map((s) => ({ ...s, score: 100, checks: {} })), score: null }));
    }
    if (texts.length) {
      const last = texts[texts.length - 1];
      cards.push(card(`${turn.id}:result`, n, 'result', last.ts,
        distill(last.text, { mode: 'response', max: 10 }), last.text));
    }
  });
  return cards;
}

function statePath(sessionId) {
  return path.join(DATA_DIR, `${sessionId.replace(/[^\w-]/g, '')}.json`);
}

function loadState(sessionId) {
  try {
    return { positions: {}, hidden: [], notes: [], ...JSON.parse(fs.readFileSync(statePath(sessionId), 'utf8')) };
  } catch {
    return { positions: {}, hidden: [], notes: [] };
  }
}

function saveState(sessionId, state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = statePath(sessionId);
  fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(file + '.tmp', file);
}

/** Merge a client patch into the stored state. */
function patchState(sessionId, patch) {
  const state = loadState(sessionId);
  for (const [id, pos] of Object.entries(patch.positions || {})) {
    if (pos) state.positions[id] = pos;
    else delete state.positions[id];
  }
  if (patch.hide) state.hidden = [...new Set([...state.hidden, ...patch.hide])];
  if (patch.unhideAll) state.hidden = [];
  for (const note of patch.notes || []) {
    const i = state.notes.findIndex((x) => x.id === note.id);
    if (i >= 0) state.notes[i] = { ...state.notes[i], ...note };
    else state.notes.push(note);
  }
  if (patch.removeNotes) state.notes = state.notes.filter((x) => !patch.removeNotes.includes(x.id));
  saveState(sessionId, state);
  return state;
}

const TYPE_TITLE = { request: 'REQUEST', progress: 'PROGRESS', changes: 'CHANGES', result: 'RESULT' };

function toMarkdown(session, cards, state) {
  const hidden = new Set(state.hidden);
  const lines = [`# ${session.title || session.id}`, '', 'Written to ASD-STE100 guidelines (target 75–80% compliance).', ''];
  let turn = 0;
  for (const c of cards) {
    if (hidden.has(c.id)) continue;
    if (c.turn !== turn) { turn = c.turn; lines.push(`## Turn ${turn}`, ''); }
    lines.push(`### ${TYPE_TITLE[c.type]}${c.score != null ? ` · STE ${c.score}%` : ''}`, '');
    let step = 0;
    for (const s of c.statements) {
      if (s.kind === 'step') lines.push(`${++step}. ${s.text}`);
      else if (s.kind === 'caution') lines.push(`> **CAUTION:** ${s.text}`);
      else lines.push(`- ${s.text}`);
    }
    lines.push('');
  }
  if (state.notes.length) {
    lines.push('## Notes', '');
    for (const n of state.notes) lines.push(`- ${n.text.replace(/\n+/g, ' ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { buildCards, loadState, patchState, toMarkdown };
