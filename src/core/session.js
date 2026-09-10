'use strict';

const MAX_TURNS = 12;

function createSession(id = 'default') {
  return { sessionId: id, turns: [] };
}

function appendTurn(session, turn) {
  const next = {
    ...session,
    turns: [...(session.turns || []), { ...turn, at: Date.now() }],
  };
  if (next.turns.length > MAX_TURNS) {
    next.turns = next.turns.slice(-MAX_TURNS);
  }
  return next;
}

function formatContextBlock(session) {
  const turns = (session && session.turns) || [];
  if (!turns.length) return '';
  const lines = ['Previous conversation:'];
  for (const t of turns.slice(-6)) {
    lines.push(`User: ${String(t.input || '').slice(0, 400)}`);
    lines.push(`Assistant (${t.agent || 'ask'}): ${String(t.summary || t.text || '').slice(0, 500)}`);
  }
  return lines.join('\n');
}

function summarize(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);
}

module.exports = { createSession, appendTurn, formatContextBlock, summarize, MAX_TURNS };
