'use strict';

// STE Whiteboard server: serves the board UI, streams live updates over SSE,
// tails Claude Code transcripts and polls git for the tracked project.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Session, listSessions, directoryHealth, transcriptDir } = require('./transcript');
const { buildCards, loadState, patchState, toMarkdown } = require('./board');
const { snapshot } = require('./git');
const { distill, TARGET } = require('./ste');

const PORT = Number(process.env.PORT) || 3000;
const PROJECT_DIR = path.resolve(process.env.PROJECT_DIR || process.cwd());
const TRANSCRIPTS = process.env.TRANSCRIPT_DIR || transcriptDir(PROJECT_DIR);
const PUBLIC = path.join(__dirname, '..', 'public');

const sessions = new Map(); // id -> Session
const cardCache = new Map(); // id -> { version, cards }
const clients = new Set(); // { res, session: id | 'latest' }
let git = { repo: false };
let gitKey = '';

function latestId() {
  const list = listSessions(TRANSCRIPTS);
  return list.length ? list[0].id : null;
}

function getSession(id) {
  const resolved = !id || id === 'latest' ? latestId() : id;
  if (!resolved) return null;
  if (!sessions.has(resolved)) {
    const file = path.join(TRANSCRIPTS, `${resolved}.jsonl`);
    if (!fs.existsSync(file)) return null;
    const s = new Session(file);
    s.poll();
    sessions.set(resolved, s);
  }
  return sessions.get(resolved);
}

// Distilling every turn is the costly part: do it once per session version,
// not once per connected client.
function cardsFor(session) {
  const hit = cardCache.get(session.id);
  if (hit && hit.version === session.version) return hit.cards;
  const cards = buildCards(session);
  cardCache.set(session.id, { version: session.version, cards });
  return cards;
}

// A Claude Code log format change would otherwise just leave the board empty:
// log each new warning once, and send them to the client with the board.
const healthLogged = new Map(); // session id or '' -> warning codes already logged
function checkHealth(session) {
  const health = session ? session.health() : directoryHealth(TRANSCRIPTS);
  const key = session ? session.id : '';
  const logged = healthLogged.get(key) || new Set();
  for (const w of health.warnings) {
    if (logged.has(w.code)) continue;
    logged.add(w.code);
    console.warn(`[log format] ${session ? `session ${session.id}` : TRANSCRIPTS}: ${w.text} The Claude Code log format may have changed.`);
  }
  healthLogged.set(key, logged);
  return health;
}

function boardPayload(session) {
  if (!session) return { session: null, cards: [], state: loadState('none'), git, target: TARGET, project: PROJECT_DIR, health: checkHealth(null) };
  return {
    session: { id: session.id, title: session.title || firstTitle(session), version: session.version },
    cards: cardsFor(session),
    state: loadState(session.id),
    git,
    target: TARGET,
    project: PROJECT_DIR,
    health: checkHealth(session),
  };
}

function firstTitle(session) {
  const t = session.turns.find((x) => x.prompt);
  return t ? t.prompt.slice(0, 80) : session.id;
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(filter, event, dataFor) {
  for (const c of clients) if (filter(c)) send(c.res, event, dataFor(c));
}

// --- polling loops ---------------------------------------------------------

let lastLatest = null;
setInterval(() => {
  const latest = latestId();
  const latestChanged = latest !== lastLatest;
  lastLatest = latest;
  const watched = new Set([...clients].map((c) => (c.session === 'latest' ? latest : c.session)));
  for (const id of watched) {
    const s = getSession(id);
    if (!s) continue;
    const changed = s.poll();
    if (!changed && !(latestChanged && id === latest)) continue;
    const payload = boardPayload(s);
    broadcast((c) => (c.session === 'latest' ? latest : c.session) === id, 'board', () => payload);
  }
}, 1000);

async function pollGit() {
  git = await snapshot(PROJECT_DIR);
  const key = JSON.stringify(git);
  if (key !== gitKey) {
    gitKey = key;
    broadcast(() => true, 'git', () => git);
  }
}
pollGit();
setInterval(pollGit, 3000);

// --- http --------------------------------------------------------------------

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json' };

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
  });
}

function serveStatic(res, pathname) {
  const file = path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionParam = url.searchParams.get('session') || 'latest';
  try {
    if (url.pathname === '/api/health') {
      return json(res, 200, { ok: true, app: 'ste-whiteboard', project: PROJECT_DIR, port: PORT, pid: process.pid });
    }
    if (url.pathname === '/api/sessions') {
      return json(res, 200, listSessions(TRANSCRIPTS).map(({ id, title, mtime }) => ({ id, title, mtime })));
    }
    if (url.pathname === '/api/board') {
      const s = getSession(sessionParam);
      if (s) s.poll();
      return json(res, 200, boardPayload(s));
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const client = { res, session: sessionParam };
      clients.add(client);
      send(res, 'git', git);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(client); });
      return;
    }
    if (url.pathname === '/api/state' && req.method === 'PATCH') {
      const s = getSession(sessionParam);
      if (!s) return json(res, 404, { error: 'no session' });
      const state = patchState(s.id, await readBody(req));
      broadcast((c) => c.res !== res && getSession(c.session) === s, 'state', () => state);
      return json(res, 200, state);
    }
    if (url.pathname === '/api/distill' && req.method === 'POST') {
      const { text, mode } = await readBody(req);
      return json(res, 200, distill(text || '', { mode: mode || 'note', max: 20 }));
    }
    if (url.pathname === '/api/export') {
      const s = getSession(sessionParam);
      if (!s) return json(res, 404, { error: 'no session' });
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="ste-board-${s.id.slice(0, 8)}.md"`,
      });
      return res.end(toMarkdown({ ...s, title: s.title || firstTitle(s) }, cardsFor(s), loadState(s.id)));
    }
    return serveStatic(res, decodeURIComponent(url.pathname));
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: String(err.message || err) });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is in use. Start with PORT=<other port>, or use /whiteboard to pick a free port.`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`STE Whiteboard on http://localhost:${PORT}`);
  console.log(`  project:     ${PROJECT_DIR}`);
  console.log(`  transcripts: ${TRANSCRIPTS}`);
});
