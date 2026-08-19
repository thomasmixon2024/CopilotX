'use strict';

const fs = require('fs');
const path = require('path');

/**
 * session.js
 * Lightweight file-backed multi-turn memory for CopilotX.
 *
 * Stores the last N turns (user input + agent + short response summary)
 * under Logs/session.json. Fully offline, zero external dependencies.
 * Designed so both live and deterministic modes can optionally receive
 * prior context without changing the public API contract.
 *
 * Options (via runCopilotX options or env):
 *   sessionId   - optional named session (default: "default")
 *   useSession  - boolean, default true
 *   maxTurns    - how many prior turns to keep (default 6)
 *   clearSession- if true, wipe session before this turn
 */

const DEFAULT_MAX_TURNS = 6;

function sessionPath(logsDir, sessionId) {
  const safe = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return path.join(logsDir, `session-${safe}.json`);
}

function loadSession(logsDir, sessionId) {
  const file = sessionPath(logsDir, sessionId);
  try {
    if (!fs.existsSync(file)) {
      return { sessionId: sessionId || 'default', turns: [], updatedAt: null };
    }
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw || raw.trim().length < 2) {
      return { sessionId: sessionId || 'default', turns: [], updatedAt: null };
    }
    const data = JSON.parse(raw);
    if (!Array.isArray(data.turns)) data.turns = [];
    return data;
  } catch {
    return { sessionId: sessionId || 'default', turns: [], updatedAt: null };
  }
}

function saveSession(logsDir, session) {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  const file = sessionPath(logsDir, session.sessionId);
  const payload = {
    sessionId: session.sessionId || 'default',
    turns: Array.isArray(session.turns) ? session.turns : [],
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function clearSession(logsDir, sessionId) {
  const file = sessionPath(logsDir, sessionId);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
  return { sessionId: sessionId || 'default', turns: [], updatedAt: null };
}

/**
 * Append a completed turn and trim to maxTurns.
 */
function appendTurn(session, turn, maxTurns = DEFAULT_MAX_TURNS) {
  const turns = Array.isArray(session.turns) ? session.turns.slice() : [];
  turns.push({
    at: new Date().toISOString(),
    input: String(turn.input || '').slice(0, 2000),
    agent: turn.agent || 'ask',
    mode: turn.mode || 'deterministic',
    summary: String(turn.summary || '').slice(0, 400),
  });
  const keep = Math.max(1, maxTurns);
  session.turns = turns.slice(-keep);
  return session;
}

/**
 * Build a short plain-text context block from prior turns for injection
 * into live system prompts or deterministic responses.
 */
function formatContextBlock(session, maxTurns = DEFAULT_MAX_TURNS) {
  const turns = (session && Array.isArray(session.turns) ? session.turns : []).slice(-maxTurns);
  if (turns.length === 0) return '';

  const lines = ['Prior conversation context (most recent last):'];
  turns.forEach((t, i) => {
    lines.push(`${i + 1}. [User] ${t.input}`);
    lines.push(`   [${(t.agent || '?').toUpperCase()} / ${t.mode}] ${t.summary}`);
  });
  return lines.join('\n');
}

/**
 * Produce a one-line summary of a response for storage (prefer first
 * non-empty substantive line after the header).
 */
function summarizeResponse(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  // Skip structural / header lines so the stored summary is substantive
  for (const line of lines) {
    if (/^\[[A-Z ]+AGENT\]/.test(line)) continue;
    if (/^Routed on /.test(line)) continue;
    if (/^Input:/.test(line)) continue;
    if (/^Mode:/.test(line)) continue;
    if (/^---$/.test(line)) continue;
    if (/^Persona purpose:?$/i.test(line)) continue;
    if (/^Core behaviors:?$/i.test(line)) continue;
    if (/^Session context:?$/i.test(line)) continue;
    if (/^Structured response/i.test(line)) continue;
    if (/^Prior conversation/i.test(line)) continue;
    if (line.length < 12) continue;
    return line.length > 380 ? line.slice(0, 377) + '...' : line;
  }
  return lines[0] ? lines[0].slice(0, 380) : '(empty response)';
}

module.exports = {
  loadSession,
  saveSession,
  clearSession,
  appendTurn,
  formatContextBlock,
  summarizeResponse,
  DEFAULT_MAX_TURNS,
};
