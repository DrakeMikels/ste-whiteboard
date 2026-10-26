'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { distill } = require('../server/ste');

const texts = (r) => r.statements.map((s) => s.text);

test('replaces non-approved words and expands contractions', () => {
  const r = distill("We utilize the cache in order to speed up reads. It's fast.");
  assert.deepEqual(texts(r), ['We use the cache to speed up reads.', 'It is fast.']);
});

test('turns "I will" / "Let me" into procedural steps', () => {
  const r = distill("Let me check the logs. I'll restart the server.");
  assert.deepEqual(r.statements.map((s) => [s.kind, s.text]), [
    ['step', 'Check the logs.'],
    ['step', 'Restart the server.'],
  ]);
});

test('rewrites first person to Claude and drops interjections', () => {
  const r = distill('Great! I have added the route.');
  assert.deepEqual(texts(r), ['Claude has added the route.']);
});

test('keeps technical names intact', () => {
  const r = distill('I modified `utilize.js` and server/index.js.');
  assert.equal(texts(r)[0], 'Claude changed `utilize.js` and `server/index.js`.');
});

test('splits long sentences and flags passive voice', () => {
  const long = 'The server reads every transcript line from the session log file on disk, which keeps the board in sync with the newest Claude Code output at all times.';
  const r = distill(long);
  assert.ok(r.statements.length >= 2);
  assert.ok(r.statements.every((s) => s.checks.length));
  const passive = distill('The file was written by the hook.');
  assert.equal(passive.statements[0].checks.active, false);
});

test('marks risks as CAUTION and lists as steps', () => {
  const r = distill('1. Run `npm test`\n2. Open the board\n\nDo not delete the data folder.');
  assert.deepEqual(r.statements.map((s) => s.kind), ['step', 'step', 'caution']);
});

test('request mode turns wishes into commands', () => {
  const r = distill('I want you to build a whiteboard. Can you run it on port 3000?', { mode: 'request' });
  assert.deepEqual(texts(r), ['Build a whiteboard.', 'Run it on port 3000.']);
  const lets = distill("lets review the board. Let's add a test.", { mode: 'request' });
  assert.deepEqual(lets.statements.map((s) => [s.kind, s.text]), [
    ['step', 'Review the board.'],
    ['step', 'Add a test.'],
  ]);
});

test('drops markdown noise: headings, tables, lead-ins', () => {
  const r = distill('## Summary\n\nHere is what changed:\n\n| a | b |\n|---|---|\n\n- **Server**: runs on port 3000');
  assert.deepEqual(texts(r), ['Server: runs on port 3000.']);
});

test('notes keep the writer as subject and lose hedges', () => {
  const r = distill("I think we should basically utilize the export button in order to share the board.", { mode: 'note' });
  assert.deepEqual(texts(r), ['We should use the export button to share the board.']);
});
