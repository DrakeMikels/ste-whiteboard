'use strict';

// Reads Claude Code session transcripts (~/.claude/projects/<encoded-cwd>/*.jsonl)
// and folds them into turns: one user prompt plus everything Claude did after it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// Below this many lines or messages a session is too young to call empty.
const MIN_FOR_WARNING = 10;

function transcriptDir(projectDir) {
  const encoded = path.resolve(projectDir).replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', encoded);
}

function stripTags(text) {
  return String(text || '')
    .replace(/<([a-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .trim();
}

function promptText(content) {
  if (typeof content === 'string') return stripTags(content);
  if (!Array.isArray(content)) return '';
  if (content.some((b) => b.type === 'tool_result')) return '';
  return stripTags(content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
}

class Session {
  constructor(file) {
    this.file = file;
    this.id = path.basename(file, '.jsonl');
    this.offset = 0;
    this.partial = '';
    this.decoder = new StringDecoder('utf8'); // keeps a multi-byte char split across polls
    this.title = null;
    this.cwd = null;
    this.turns = [];
    this.pending = new Map(); // tool_use id -> file change awaiting its result
    this.version = 0;
    // What the reader relied on, so a log format change shows up as a warning.
    this.stats = { lines: 0, bad: 0, messages: 0, assistant: 0, readable: 0, malformed: 0, noPath: 0 };
  }

  /** Read new bytes since the last poll. Returns true when turns changed. */
  poll() {
    let stat;
    try { stat = fs.statSync(this.file); } catch { return false; }
    if (stat.size < this.offset) { // file rewritten: start over
      Object.assign(this, new Session(this.file));
    }
    if (stat.size === this.offset) return false;
    const fd = fs.openSync(this.file, 'r');
    const buf = Buffer.alloc(stat.size - this.offset);
    fs.readSync(fd, buf, 0, buf.length, this.offset);
    fs.closeSync(fd);
    this.offset = stat.size;

    const lines = (this.partial + this.decoder.write(buf)).split('\n');
    this.partial = lines.pop();
    let changed = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      this.stats.lines++;
      let e;
      try { e = JSON.parse(line); } catch { this.stats.bad++; continue; }
      this.check(e);
      try { changed = this.ingest(e) || changed; } catch { this.stats.malformed++; }
    }
    if (changed) this.version++;
    return changed;
  }

  check(e) {
    if (e.isSidechain || (e.type !== 'user' && e.type !== 'assistant')) return;
    const s = this.stats;
    const content = e.message && e.message.content;
    const shapeOk = Array.isArray(content) || (e.type === 'user' && typeof content === 'string');
    if (!shapeOk || !e.uuid || !e.timestamp) { s.malformed++; if (!shapeOk) return; }
    s.messages++;
    if (e.type !== 'assistant') return;
    s.assistant++;
    for (const b of content) {
      if (b.type === 'text' || b.type === 'tool_use') s.readable++;
      const input = b.input || {};
      if (b.type === 'tool_use' && FILE_TOOLS.has(b.name) && !input.file_path && !input.notebook_path) s.noPath++;
    }
  }

  /** Warnings when the log no longer looks like what this reader expects. */
  health() {
    const s = this.stats;
    const warnings = [];
    const warn = (code, text) => warnings.push({ code, text });
    if (s.lines >= MIN_FOR_WARNING && !s.messages) {
      warn('no-messages', `No user or Claude messages found in ${s.lines} log lines.`);
    } else if (s.messages >= MIN_FOR_WARNING && !this.turns.some((t) => t.prompt)) {
      warn('no-prompts', `No user prompts found in ${s.messages} messages.`);
    }
    if (s.assistant >= MIN_FOR_WARNING && !s.readable) {
      warn('no-content', `No text or tool calls found in ${s.assistant} Claude messages.`);
    }
    if (s.malformed) warn('malformed', `${s.malformed} messages have an unexpected shape.`);
    if (s.bad) warn('bad-lines', `${s.bad} log lines are not valid JSON.`);
    if (s.noPath) warn('no-file-path', `${s.noPath} file edits have no file path.`);
    return { ok: !warnings.length, warnings, stats: { ...s } };
  }

  currentTurn(ts) {
    if (!this.turns.length) this.turns.push(newTurn('start', ts, ''));
    return this.turns[this.turns.length - 1];
  }

  ingest(e) {
    if (e.type === 'custom-title' && e.customTitle) { this.title = e.customTitle; return true; }
    if (e.isSidechain || !e.message) return false;
    if (e.cwd) this.cwd = e.cwd;
    const { content } = e.message;

    if (e.type === 'user') {
      if (Array.isArray(content)) this.resolveResults(content, e.toolUseResult);
      if (e.isMeta) return false;
      const text = promptText(content);
      if (!text) return Array.isArray(content) && content.some((b) => b.type === 'tool_result');
      this.turns.push(newTurn(e.uuid, e.timestamp, text));
      return true;
    }

    if (e.type !== 'assistant' || !Array.isArray(content)) return false;
    const turn = this.currentTurn(e.timestamp);
    let changed = false;
    for (const block of content) {
      if (block.type === 'text' && block.text.trim()) {
        turn.texts.push({ id: e.uuid, ts: e.timestamp, text: block.text });
        changed = true;
      } else if (block.type === 'tool_use') {
        changed = this.toolUse(turn, block) || changed;
      }
    }
    if (changed) turn.updated = e.timestamp;
    return changed;
  }

  toolUse(turn, block) {
    const input = block.input || {};
    if (FILE_TOOLS.has(block.name) && (input.file_path || input.notebook_path)) {
      const rel = this.relative(input.file_path || input.notebook_path);
      const f = turn.files.get(rel) || { path: rel, edits: 0, created: false };
      f.edits++;
      turn.files.set(rel, f);
      if (block.name === 'Write') this.pending.set(block.id, f);
      return true;
    }
    if (block.name === 'Bash') { turn.commands++; return true; }
    if (/arch_update$/.test(block.name)) {
      const added = (input.nodes || []).map((n) => n.label || n.id);
      const removed = input.remove_nodes || [];
      turn.arch.push({ added, removed, edges: (input.edges || []).length });
      return true;
    }
    return false;
  }

  resolveResults(content, result) {
    for (const b of content) {
      if (b.type !== 'tool_result') continue;
      const f = this.pending.get(b.tool_use_id);
      if (f && result && result.type === 'create') f.created = true;
      this.pending.delete(b.tool_use_id);
    }
  }

  relative(p) {
    if (!this.cwd || !p.startsWith(this.cwd)) return p;
    return path.relative(this.cwd, p) || p;
  }
}

function newTurn(id, ts, prompt) {
  return { id, ts, updated: ts, prompt, texts: [], files: new Map(), commands: 0, arch: [] };
}

function firstPrompt(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.slice(0, n).toString('utf8').split('\n')) {
      try {
        const e = JSON.parse(line);
        if (e.type === 'custom-title') return e.customTitle;
        if (e.type === 'user' && !e.isMeta && e.message) {
          const t = promptText(e.message.content);
          if (t) return t.slice(0, 80);
        }
      } catch { /* partial line */ }
    }
  } catch { /* unreadable */ }
  return null;
}

function listSessions(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch { return []; }
  return names
    .map((n) => {
      const file = path.join(dir, n);
      const st = fs.statSync(file);
      return { id: path.basename(n, '.jsonl'), file, mtime: st.mtimeMs, size: st.size };
    })
    .filter((s) => s.size > 0)
    .sort((a, b) => b.mtime - a.mtime)
    .map((s) => ({ ...s, title: firstPrompt(s.file) }))
    .filter((s) => s.title);
}

/** Warn when session logs exist but the board can read none of them. */
function directoryHealth(dir) {
  let files = 0;
  try {
    files = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl') && fs.statSync(path.join(dir, n)).size > 0).length;
  } catch { /* no transcript folder yet */ }
  const listed = listSessions(dir).length;
  const warnings = files && !listed
    ? [{ code: 'no-sessions', text: `Found ${files} session logs, but none has a prompt the board can read.` }]
    : [];
  return { ok: !warnings.length, warnings, files, listed };
}

module.exports = { Session, listSessions, directoryHealth, transcriptDir };
