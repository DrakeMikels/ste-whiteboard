'use strict';

// Guards the session-log reader against Claude Code log format drift: if these
// fail after a Claude Code update, the board would otherwise just go empty.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Session, listSessions, directoryHealth, transcriptDir } = require('../server/transcript');

const FIXTURE = path.join(__dirname, 'fixtures', 'session.jsonl');
const fixtureLines = () => fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ste-transcript-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function load(file = FIXTURE) {
  const s = new Session(file);
  s.poll();
  return s;
}

const entry = (type, uuid, content, extra = {}) => JSON.stringify({
  type, uuid, isSidechain: false, cwd: '/work/demo', timestamp: `2026-10-01T10:00:0${uuid.length % 10}.000Z`,
  message: { role: type, content }, ...extra,
});

test('groups the fixture into one turn per real user prompt', () => {
  const s = load();
  assert.equal(s.id, 'session');
  assert.equal(s.title, 'Health route');
  assert.equal(s.cwd, '/work/demo');
  assert.deepEqual(s.turns.map((t) => [t.id, t.prompt]), [
    ['u-1', 'Add a health route to the server.'],
    ['u-2', 'Now run the tests.'],
  ]);
  assert.equal(s.turns[0].ts, '2026-10-01T10:00:01.000Z');
  assert.equal(s.turns[0].updated, '2026-10-01T10:00:14.000Z');
  assert.equal(s.version, 1);
});

test('collects assistant text in order and ignores thinking and sidechains', () => {
  const [first] = load().turns;
  assert.deepEqual(first.texts.map((t) => [t.id, t.text]), [
    ['a-2', 'Let me read the server files.'],
    ['a-8', 'I added the health route in `server/health.js`.'],
  ]);
  assert.ok(!first.texts.some((t) => /Subagent/.test(t.text)));
});

test('records tool calls: file writes and edits, shell commands, architecture updates', () => {
  const [first] = load().turns;
  assert.deepEqual([...first.files.values()], [
    { path: 'server/health.js', edits: 1, created: true },
    { path: 'server/index.js', edits: 2, created: false },
  ]);
  assert.equal(first.commands, 1);
  assert.deepEqual(first.arch, [{ added: ['Health API'], removed: ['legacy'], edges: 1 }]);
});

test('skips meta, system, attachment, snapshot and command-only entries', () => {
  const s = load();
  const prompts = s.turns.map((t) => t.prompt).join('\n');
  assert.doesNotMatch(prompts, /local-command-caveat|command-name|\/cost|system-reminder/);
  assert.equal(s.turns.length, 2);
});

test('a turn with one assistant text has nothing for PROGRESS', () => {
  const second = load().turns[1];
  assert.equal(second.texts.length, 1);
  assert.equal(second.files.size, 0);
  assert.equal(second.commands, 0);
});

test('a Write to an existing file counts as a change, not a creation', () => {
  const file = path.join(tmpDir(), 'overwrite.jsonl');
  fs.writeFileSync(file, [
    entry('user', 'u-1', 'Rewrite the config.'),
    entry('assistant', 'a-1', [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/work/demo/config.json' } }]),
    entry('user', 'r-1', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }], { toolUseResult: { type: 'update', filePath: '/work/demo/config.json' } }),
    entry('assistant', 'a-2', [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/work/demo/x.js' } }]),
  ].join('\n') + '\n');
  const [turn] = load(file).turns;
  assert.deepEqual([...turn.files.values()], [{ path: 'config.json', edits: 1, created: false }]);
});

test('assistant output before any prompt goes into a "start" turn', () => {
  const file = path.join(tmpDir(), 'resumed.jsonl');
  fs.writeFileSync(file, entry('assistant', 'a-1', [{ type: 'text', text: 'Resuming work.' }]) + '\n');
  const s = load(file);
  assert.equal(s.turns.length, 1);
  assert.equal(s.turns[0].id, 'start');
  assert.equal(s.turns[0].prompt, '');
  assert.equal(s.turns[0].texts[0].text, 'Resuming work.');
});

test('holds a partial last line until the rest of it is written', () => {
  const file = path.join(tmpDir(), 'live.jsonl');
  const lines = fixtureLines();
  const lastPrompt = lines.findIndex((l) => l.includes('"uuid":"u-2"'));
  const head = lines.slice(0, lastPrompt).join('\n') + '\n';
  const cut = Math.floor(lines[lastPrompt].length / 2);
  fs.writeFileSync(file, head + lines[lastPrompt].slice(0, cut));

  const s = new Session(file);
  assert.equal(s.poll(), true);
  assert.equal(s.turns.length, 1);
  assert.equal(s.poll(), false, 'no new bytes, no change');

  fs.appendFileSync(file, lines[lastPrompt].slice(cut) + '\n' + lines.slice(lastPrompt + 1).join('\n') + '\n');
  assert.equal(s.poll(), true);
  assert.deepEqual(s.turns.map((t) => t.prompt), ['Add a health route to the server.', 'Now run the tests.']);
  assert.equal(s.version, 2);
});

test('keeps a multi-byte character that is split across two polls', () => {
  const file = path.join(tmpDir(), 'utf8.jsonl');
  const line = Buffer.from(entry('user', 'u-1', 'Fix it — now ✅') + '\n');
  const cut = line.indexOf(Buffer.from('—')) + 1;
  fs.writeFileSync(file, line.subarray(0, cut));
  const s = new Session(file);
  s.poll();
  fs.appendFileSync(file, line.subarray(cut));
  s.poll();
  assert.equal(s.turns[0].prompt, 'Fix it — now ✅');
});

test('skips a malformed line and keeps reading after it', () => {
  const file = path.join(tmpDir(), 'broken.jsonl');
  const lines = fixtureLines();
  lines.splice(4, 0, '{"type":"assistant","message":{"content":[', 'not json at all', '');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const s = load(file);
  assert.equal(s.turns.length, 2);
  assert.equal(s.turns[0].texts.length, 2);
});

test('starts over when the log file is rewritten shorter', () => {
  const file = path.join(tmpDir(), 'rewrite.jsonl');
  fs.copyFileSync(FIXTURE, file);
  const s = load(file);
  assert.equal(s.turns.length, 2);
  fs.writeFileSync(file, entry('user', 'u-new', 'Fresh start.') + '\n');
  assert.equal(s.poll(), true);
  assert.deepEqual(s.turns.map((t) => t.prompt), ['Fresh start.']);
  assert.equal(s.title, null);
});

test('a missing file polls as unchanged', () => {
  const s = new Session(path.join(tmpDir(), 'gone.jsonl'));
  assert.equal(s.poll(), false);
  assert.deepEqual(s.turns, []);
});

test('listSessions lists sessions with a title, newest first', () => {
  // The title is the first prompt, or a custom title written before it.
  const dir = tmpDir();
  const older = path.join(dir, 'older.jsonl');
  fs.writeFileSync(older, entry('user', 'u-1', [{ type: 'text', text: 'Older prompt.' }]) + '\n');
  fs.utimesSync(older, new Date('2026-01-01'), new Date('2026-01-01'));
  fs.copyFileSync(FIXTURE, path.join(dir, 'newer.jsonl'));
  const titled = path.join(dir, 'titled.jsonl');
  fs.writeFileSync(titled, JSON.stringify({ type: 'custom-title', customTitle: 'Named early' }) + '\n' + fixtureLines().join('\n') + '\n');
  fs.utimesSync(titled, new Date('2025-01-01'), new Date('2025-01-01'));
  fs.writeFileSync(path.join(dir, 'empty.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'meta-only.jsonl'), entry('user', 'u-m', '<local-command-caveat>x</local-command-caveat>', { isMeta: true }) + '\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a session');

  assert.deepEqual(listSessions(dir).map((s) => [s.id, s.title]), [
    ['newer', 'Add a health route to the server.'],
    ['older', 'Older prompt.'],
    ['titled', 'Named early'],
  ]);
  assert.deepEqual(listSessions(path.join(dir, 'nope')), []);
});

test('transcriptDir encodes the project path like Claude Code does', () => {
  assert.equal(
    transcriptDir('/Users/mike/Dev Projects/arch-live-test'),
    path.join(os.homedir(), '.claude', 'projects', '-Users-mike-Dev-Projects-arch-live-test'),
  );
});

// --- format-change warnings ---------------------------------------------------

/** Write the fixture twice (enough lines to warn on) with a format change applied. */
function drifted(name, change) {
  const file = path.join(tmpDir(), `${name}.jsonl`);
  const lines = fixtureLines().map(change);
  fs.writeFileSync(file, [...lines, ...lines].join('\n') + '\n');
  return load(file);
}
const codes = (s) => s.health().warnings.map((w) => w.code);

test('the current log format raises no warnings', () => {
  const h = load().health();
  assert.equal(h.ok, true);
  assert.deepEqual(h.warnings, []);
  assert.equal(h.stats.bad, 0);
  assert.ok(h.stats.messages > 0 && h.stats.readable > 0);
});

test('a young session is not called empty', () => {
  const file = path.join(tmpDir(), 'young.jsonl');
  fs.writeFileSync(file, fixtureLines().slice(0, 3).join('\n') + '\n');
  assert.deepEqual(codes(load(file)), []);
});

test('warns when messages move to a new field', () => {
  const s = drifted('renamed-message', (l) => l.replace(/"message":/g, '"msg":'));
  assert.equal(s.turns.length, 0);
  assert.deepEqual(codes(s), ['no-messages', 'malformed']);
});

test('warns when prompt content changes shape', () => {
  const s = drifted('object-prompt', (l) => (l.includes('"type":"user"')
    ? l.replace(/"content":"([^"]*)"/, '"content":{"text":"$1"}').replace(/"content":\[\{"type":"text"[^\]]*\]/, '"content":{"text":"x"}')
    : l));
  assert.deepEqual(codes(s), ['no-prompts', 'malformed']);
});

test('warns when Claude content blocks are renamed', () => {
  const s = drifted('renamed-blocks', (l) => l.replace(/"type":"text"/g, '"type":"output_text"').replace(/"type":"tool_use"/g, '"type":"tool_call"'));
  assert.ok(codes(s).includes('no-content'));
});

test('warns when file edits lose their file path', () => {
  const s = drifted('renamed-path', (l) => l.replace(/"file_path":/g, '"path":'));
  assert.equal(s.turns[0].files.size, 0);
  assert.deepEqual(codes(s), ['no-file-path']);
});

test('warns about lines that are not valid JSON', () => {
  const file = path.join(tmpDir(), 'bad-json.jsonl');
  const lines = fixtureLines();
  lines.splice(4, 0, '{"type":"assistant","message":{"content":[', 'not json at all');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const h = load(file).health();
  assert.deepEqual(h.warnings.map((w) => w.code), ['bad-lines']);
  assert.equal(h.stats.bad, 2);
});

test('directoryHealth warns when no log in the folder can be read', () => {
  const dir = tmpDir();
  assert.deepEqual(directoryHealth(dir), { ok: true, warnings: [], files: 0, listed: 0 });
  assert.equal(directoryHealth(path.join(dir, 'missing')).ok, true);

  const lines = fixtureLines().map((l) => l.replace(/"message":/g, '"msg":').replace(/"custom-title"/g, '"renamed-title"'));
  fs.writeFileSync(path.join(dir, 'a.jsonl'), lines.join('\n') + '\n');
  const broken = directoryHealth(dir);
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.warnings.map((w) => w.code), ['no-sessions']);
  assert.equal(broken.files, 1);

  fs.copyFileSync(FIXTURE, path.join(dir, 'b.jsonl'));
  assert.deepEqual(directoryHealth(dir), { ok: true, warnings: [], files: 2, listed: 1 });
});
