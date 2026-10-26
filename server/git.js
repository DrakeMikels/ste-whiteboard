'use strict';

// Polls the tracked project's git working tree: branch, uncommitted changes, recent commits.

const { execFile } = require('child_process');

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

async function snapshot(cwd) {
  const [branch, status, numstat, log] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['status', '--porcelain=v1', '-uall']),
    git(cwd, ['diff', 'HEAD', '--numstat']),
    git(cwd, ['log', '-n', '15', '--format=%h%x09%ct%x09%s']),
  ]);
  if (status === null) return { repo: false };

  const files = status.split('\n').filter(Boolean).map((l) => ({ code: l.slice(0, 2).trim() || 'M', path: l.slice(3) }));
  let added = 0;
  let removed = 0;
  for (const l of (numstat || '').split('\n').filter(Boolean)) {
    const [a, d] = l.split('\t');
    added += Number(a) || 0;
    removed += Number(d) || 0;
  }
  const commits = (log || '').split('\n').filter(Boolean).map((l) => {
    const [hash, ct, ...subject] = l.split('\t');
    return { hash, ts: Number(ct) * 1000, subject: subject.join('\t') };
  });
  return { repo: true, branch: (branch || '').trim(), files, added, removed, commits };
}

module.exports = { snapshot };
