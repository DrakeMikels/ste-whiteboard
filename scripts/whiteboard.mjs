#!/usr/bin/env node
// Starts, finds or stops the STE Whiteboard server for a project.
// One server per project, each on the first free port from 3000 up.
//
//   whiteboard.mjs [start]   start the board for the current project, or reuse it
//   whiteboard.mjs status    list running boards
//   whiteboard.mjs stop      stop this project's board ("stop all" stops every board)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.STE_HOME || path.join(os.homedir(), '.ste-whiteboard');
const REGISTRY = path.join(HOME, 'servers.json');
const FIRST_PORT = Number(process.env.STE_PORT) || 3000;

const args = process.argv.slice(2).filter(Boolean);
const cmd = (args[0] || 'start').toLowerCase();
const project = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());

function fail(message) {
  console.log(`STE Whiteboard: ERROR. ${message}`);
  process.exit(1);
}

function readRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); } catch { return {}; }
}

function writeRegistry(reg) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
}

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    const body = await res.json();
    return body.app === 'ste-whiteboard' ? body : null;
  } catch {
    return null;
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, () => probe.close(() => resolve(true)));
  });
}

async function freePort() {
  for (let port = FIRST_PORT; port < FIRST_PORT + 50; port++) {
    if (await portFree(port)) return port;
  }
  return fail(`No free port from ${FIRST_PORT} to ${FIRST_PORT + 49}.`);
}

/** Running boards from the registry; entries whose server is gone are pruned. */
async function running() {
  const reg = readRegistry();
  const live = {};
  for (const [dir, entry] of Object.entries(reg)) {
    const h = await health(entry.port);
    if (h && h.project === dir) live[dir] = { ...entry, pid: h.pid };
  }
  if (Object.keys(live).length !== Object.keys(reg).length) writeRegistry(live);
  return live;
}

function report(status, port, pid) {
  console.log(`STE Whiteboard: ${status}`);
  console.log(`URL: http://localhost:${port}`);
  console.log(`Project: ${project}`);
  console.log(`PID: ${pid}`);
  console.log('Stop: /whiteboard stop');
}

async function start() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 20) fail(`Node ${process.versions.node} is too old. Install Node 20 or later.`);

  const live = await running();
  if (live[project]) return report('already running', live[project].port, live[project].pid);

  const port = await freePort();
  fs.mkdirSync(HOME, { recursive: true });
  const logFile = path.join(HOME, `server-${port}.log`);
  const log = fs.openSync(logFile, 'w');
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: project,
    env: { ...process.env, PORT: String(port), PROJECT_DIR: project, STE_DATA_DIR: path.join(HOME, 'boards') },
    detached: true,
    stdio: ['ignore', log, log],
  });
  let exited = null;
  child.on('exit', (code) => { exited = code; });
  child.unref();

  for (let i = 0; i < 50 && exited === null; i++) {
    const h = await health(port);
    if (h && h.project === project) {
      writeRegistry({ ...live, [project]: { port, pid: child.pid, started: new Date().toISOString() } });
      return report('started', port, child.pid);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const tail = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-5).join('\n');
  return fail(`The server did not start. Log: ${logFile}\n${tail}`);
}

async function status() {
  const live = await running();
  const dirs = Object.keys(live);
  if (!dirs.length) return console.log('STE Whiteboard: no boards are running. Start one with /whiteboard.');
  console.log(`STE Whiteboard: ${dirs.length} board${dirs.length > 1 ? 's' : ''} running`);
  for (const dir of dirs) console.log(`- http://localhost:${live[dir].port}  ${dir}  (pid ${live[dir].pid})`);
}

async function stop() {
  const live = await running();
  const all = (args[1] || '').toLowerCase() === 'all';
  const targets = all ? Object.keys(live) : [project].filter((d) => live[d]);
  if (!targets.length) return console.log(`STE Whiteboard: no board is running for ${all ? 'any project' : project}.`);
  for (const dir of targets) {
    try { process.kill(live[dir].pid, 'SIGTERM'); } catch { /* already gone */ }
    delete live[dir];
    console.log(`STE Whiteboard: stopped the board for ${dir}.`);
  }
  writeRegistry(live);
}

const commands = { start, status, stop };
if (!commands[cmd]) fail(`Unknown option "${cmd}". Use: /whiteboard, /whiteboard status, /whiteboard stop, /whiteboard stop all.`);
await commands[cmd]();
