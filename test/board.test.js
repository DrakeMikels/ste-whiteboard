'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Session } = require('../server/transcript');

// board.js keeps its state in <its folder>/../data/boards. Load a copy from a
// temp folder so these tests never touch the real data/boards/.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ste-board-'));
fs.mkdirSync(path.join(TMP, 'server'));
for (const f of ['board.js', 'ste.js']) {
  fs.copyFileSync(path.join(__dirname, '..', 'server', f), path.join(TMP, 'server', f));
}
const { buildCards, loadState, patchState, toMarkdown } = require(path.join(TMP, 'server', 'board.js'));
const BOARDS = path.join(TMP, 'data', 'boards');
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function fixtureSession() {
  const s = new Session(path.join(__dirname, 'fixtures', 'session.jsonl'));
  s.poll();
  return s;
}

function turn(fields) {
  return { id: 't', ts: 'ts', updated: 'ts', prompt: '', texts: [], files: new Map(), commands: 0, arch: [], ...fields };
}

test('builds REQUEST, PROGRESS, CHANGES and RESULT cards per turn', () => {
  const cards = buildCards(fixtureSession());
  assert.deepEqual(cards.map((c) => [c.id, c.turn, c.type]), [
    ['u-1:request', 1, 'request'],
    ['u-1:progress', 1, 'progress'],
    ['u-1:changes', 1, 'changes'],
    ['u-1:result', 1, 'result'],
    ['u-2:request', 2, 'request'],
    ['u-2:result', 2, 'result'],
  ]);
  for (const c of cards) {
    assert.ok(c.statements.length, `${c.id} has statements`);
    assert.ok(Array.isArray(c.code));
  }
});

test('cards keep their source text and timestamps', () => {
  const byId = Object.fromEntries(buildCards(fixtureSession()).map((c) => [c.id, c]));
  assert.equal(byId['u-1:request'].source, 'Add a health route to the server.');
  assert.equal(byId['u-1:request'].ts, '2026-10-01T10:00:01.000Z');
  assert.equal(byId['u-1:progress'].source, 'Let me read the server files.');
  assert.equal(byId['u-1:progress'].ts, '2026-10-01T10:00:03.000Z');
  assert.equal(byId['u-1:result'].source, 'I added the health route in `server/health.js`.');
  assert.equal(byId['u-1:result'].ts, '2026-10-01T10:00:14.000Z');
  assert.equal(byId['u-1:changes'].ts, '2026-10-01T10:00:14.000Z');
  assert.equal(typeof byId['u-1:request'].score, 'number');
  assert.equal(byId['u-1:changes'].score, null);
});

test('CHANGES lists created and changed files, architecture and commands', () => {
  const changes = buildCards(fixtureSession()).find((c) => c.type === 'changes');
  assert.deepEqual(changes.statements.map((s) => s.text), [
    'Created `server/health.js`.',
    'Changed `server/index.js` (2 edits).',
    'Architecture map: added or changed Health API; removed legacy.',
    'Ran 1 shell command.',
  ]);
  assert.ok(changes.statements.every((s) => s.kind === 'desc' && s.score === 100));
});

test('CHANGES wording for connection-only map updates and several commands', () => {
  const cards = buildCards({ turns: [turn({ commands: 3, arch: [{ added: [], removed: [], edges: 2 }] })] });
  assert.deepEqual(cards.map((c) => c.type), ['changes']);
  assert.deepEqual(cards[0].statements.map((s) => s.text), [
    'Architecture map: changed 2 connections.',
    'Ran 3 shell commands.',
  ]);
});

test('a turn without a prompt or text gets no REQUEST or RESULT', () => {
  assert.deepEqual(buildCards({ turns: [turn({ id: 'start' })] }), []);
  const cards = buildCards({ turns: [turn({ id: 'start', texts: [{ id: 'a', ts: 'ts', text: 'Resuming work.' }] })] });
  assert.deepEqual(cards.map((c) => c.id), ['start:result']);
  assert.deepEqual(buildCards({ turns: [] }), []);
});

test('loadState returns empty defaults for an unknown session', () => {
  assert.deepEqual(loadState('never-saved'), { positions: {}, hidden: [], notes: [] });
});

test('patchState saves positions, hidden cards and notes to disk', () => {
  const id = 'sess-save';
  patchState(id, { positions: { 'u-1:request': { x: 10, y: 20 }, 'u-1:result': { x: 5, y: 5 } } });
  patchState(id, { positions: { 'u-1:result': null }, hide: ['u-1:progress', 'u-1:progress'] });
  patchState(id, { hide: ['u-2:result'], notes: [{ id: 'n1', text: 'Check the route.', x: 1, y: 2 }] });
  const state = patchState(id, { notes: [{ id: 'n1', text: 'Check the health route.' }, { id: 'n2', text: 'Second.' }] });

  const expected = {
    positions: { 'u-1:request': { x: 10, y: 20 } },
    hidden: ['u-1:progress', 'u-2:result'],
    notes: [{ id: 'n1', text: 'Check the health route.', x: 1, y: 2 }, { id: 'n2', text: 'Second.' }],
  };
  assert.deepEqual(state, expected);
  assert.deepEqual(loadState(id), expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(BOARDS, `${id}.json`), 'utf8')), expected);
  assert.ok(!fs.existsSync(path.join(BOARDS, `${id}.json.tmp`)));
});

test('patchState can unhide all cards and remove notes', () => {
  const id = 'sess-remove';
  patchState(id, { hide: ['a', 'b'], notes: [{ id: 'n1', text: 'one' }, { id: 'n2', text: 'two' }] });
  const state = patchState(id, { unhideAll: true, removeNotes: ['n1'] });
  assert.deepEqual(state.hidden, []);
  assert.deepEqual(state.notes, [{ id: 'n2', text: 'two' }]);
});

test('session ids cannot escape the boards folder', () => {
  patchState('../../escape', { hide: ['x'] });
  assert.ok(fs.existsSync(path.join(BOARDS, 'escape.json')));
  assert.ok(!fs.existsSync(path.join(TMP, 'escape.json')));
  assert.deepEqual(loadState('../../escape').hidden, ['x']);
});

test('a corrupt state file loads as defaults', () => {
  fs.mkdirSync(BOARDS, { recursive: true });
  fs.writeFileSync(path.join(BOARDS, 'corrupt.json'), '{"positions":');
  assert.deepEqual(loadState('corrupt'), { positions: {}, hidden: [], notes: [] });
  fs.writeFileSync(path.join(BOARDS, 'partial.json'), '{"hidden":["a"]}');
  assert.deepEqual(loadState('partial'), { positions: {}, hidden: ['a'], notes: [] });
});

test('toMarkdown skips hidden cards and appends notes', () => {
  const s = fixtureSession();
  const cards = buildCards(s);
  const md = toMarkdown(s, cards, { positions: {}, hidden: ['u-1:progress'], notes: [{ id: 'n', text: 'Line one\nline two' }] });
  assert.match(md, /^# Health route\n/);
  assert.match(md, /## Turn 1\n\n### REQUEST · STE \d+%/);
  assert.match(md, /### CHANGES\n\n- Created `server\/health.js`\./);
  assert.match(md, /## Turn 2/);
  assert.doesNotMatch(md, /### PROGRESS/);
  assert.match(md, /## Notes\n\n- Line one line two\n/);
});
