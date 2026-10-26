'use strict';

// Smoke test against a real Claude Code log on this machine. The other tests use
// hand-written fixtures, so only this one notices when Claude Code changes its
// log format. Set STE_REAL_LOG=<file.jsonl> to check a given log. Skipped when
// this machine has no Claude Code logs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Session, listSessions, directoryHealth, transcriptDir } = require('../server/transcript');

function newestRealLog() {
  if (process.env.STE_REAL_LOG) return process.env.STE_REAL_LOG;
  const root = path.join(os.homedir(), '.claude', 'projects');
  let others = [];
  try { others = fs.readdirSync(root).map((n) => path.join(root, n)); } catch { /* no Claude Code here */ }
  for (const dir of [transcriptDir(path.join(__dirname, '..')), ...others]) {
    const [newest] = listSessions(dir);
    if (newest) return newest.file;
  }
  return null;
}

const file = newestRealLog();

test('the newest real Claude Code log still reads as turns', { skip: !file && 'no Claude Code logs on this machine' }, () => {
  const s = new Session(file);
  s.poll();
  const h = s.health();
  assert.deepEqual(h.warnings, [], `${file}: ${h.warnings.map((w) => w.text).join(' ')}`);
  assert.ok(s.turns.some((t) => t.prompt), `${file}: no turn has a user prompt`);
  if (h.stats.assistant) assert.ok(h.stats.readable, `${file}: no Claude text or tool calls`);
  assert.equal(directoryHealth(path.dirname(file)).ok, true);
});
