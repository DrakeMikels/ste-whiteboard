'use strict';

// End-to-end test of the /whiteboard launcher: start, reuse, a second project, stop.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'whiteboard.mjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ste-home-'));
const env = { ...process.env, STE_HOME: home, STE_PORT: '3190', CLAUDE_PROJECT_DIR: '' };

function run(project, ...args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { cwd: project, env: { ...env, CLAUDE_PROJECT_DIR: project }, encoding: 'utf8' });
}
const urlOf = (out) => out.match(/URL: (\S+)/)[1];

test('starts one board per project and reuses it', async (t) => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'ste-a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'ste-b-'));
  t.after(() => { try { run(a, 'stop', 'all'); } catch { /* already stopped */ } });

  const first = run(a);
  assert.match(first, /STE Whiteboard: started/);
  const health = await fetch(`${urlOf(first)}/api/health`).then((r) => r.json());
  assert.equal(health.project, a);

  assert.match(run(a), /already running/);
  assert.equal(urlOf(run(a)), urlOf(first));

  const second = run(b);
  assert.match(second, /started/);
  assert.notEqual(urlOf(second), urlOf(first));
  assert.match(run(a, 'status'), /2 boards running/);

  assert.match(run(a, 'stop'), /stopped the board/);
  assert.match(run(a, 'status'), /1 board running/);
  run(a, 'stop', 'all');
  assert.match(run(a, 'status'), /no boards are running/);
});

test('rejects unknown options', () => {
  assert.throws(() => run(os.tmpdir(), 'bogus'), (err) => /Unknown option "bogus"/.test(err.stdout));
});
