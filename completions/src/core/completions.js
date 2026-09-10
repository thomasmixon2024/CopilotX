'use strict';

/**
 * completions.js — Phase 3: Inline Ghost-Text Completions (local fast path)
 *
 * Designed for sub-50ms local suggestions using prefix/suffix context.
 * Optional LLM escalation is intentionally NOT in the hot path; callers
 * may invoke it separately. Zero network in getCompletion().
 */

const DEFAULT_DEBOUNCE_MS = 150;

/**
 * Split document text at a UTF-16-ish offset into prefix (before cursor)
 * and suffix (after cursor).
 */
function extractPrefixSuffix(documentText, offset) {
  const text = String(documentText || '');
  let pos = Number(offset);
  if (!Number.isFinite(pos) || pos < 0) pos = 0;
  if (pos > text.length) pos = text.length;
  return {
    prefix: text.slice(0, pos),
    suffix: text.slice(pos),
  };
}

/**
 * Decide whether a completion request should fire.
 * options: { prefix, suffix, debounceMs, lastTriggerAt, now }
 */
function shouldTrigger(options = {}) {
  const prefix = String(options.prefix || '');
  const trimmed = prefix.replace(/\s+$/, '');
  if (!trimmed) return false;

  const debounceMs =
    options.debounceMs !== undefined ? options.debounceMs : DEFAULT_DEBOUNCE_MS;
  const now = options.now !== undefined ? options.now : Date.now();
  const last = options.lastTriggerAt || 0;
  if (debounceMs > 0 && now - last < debounceMs) return false;

  return true;
}

function lastLine(prefix) {
  const lines = String(prefix).split('\n');
  return lines[lines.length - 1] || '';
}

function detectIndent(prefix) {
  const line = lastLine(prefix);
  const m = line.match(/^(\s*)/);
  return m ? m[1] : '';
}

/**
 * Tiny pattern library for common JS/TS/Python idioms.
 * Returns insertText relative to the cursor (what ghost-text should show).
 */
function localPatternComplete(prefix, suffix, languageId) {
  const line = lastLine(prefix);
  const indent = detectIndent(prefix);
  const lang = String(languageId || '').toLowerCase();
  const isPy = lang === 'python' || lang === 'py';
  const isJs =
    !isPy &&
    (lang.includes('javascript') ||
      lang.includes('typescript') ||
      lang === 'js' ||
      lang === 'ts' ||
      lang === '' ||
      lang === 'plaintext');

  // function body just opened
  if (/function\s+\w+\s*\([^)]*\)\s*\{\s*$/.test(prefix.trimEnd()) ||
      /=>\s*\{\s*$/.test(prefix.trimEnd())) {
    if (isJs) return { insertText: `\n${indent}  // TODO\n${indent}`, source: 'local' };
  }

  // incomplete return
  if (/\breturn\s+$/.test(line)) {
    if (isJs) return { insertText: 'undefined;', source: 'local' };
    if (isPy) return { insertText: 'None', source: 'local' };
  }

  // const/let/var name =
  if (/\b(const|let|var)\s+\w+\s*=\s*$/.test(line) && isJs) {
    return { insertText: 'null;', source: 'local' };
  }

  // if ( ... ) {
  if (/if\s*\([^)]*\)\s*\{\s*$/.test(prefix.trimEnd()) && isJs) {
    return { insertText: `\n${indent}  \n${indent}`, source: 'local' };
  }

  // console.log(
  if (/console\.log\(\s*$/.test(line) && isJs) {
    return { insertText: ');', source: 'local' };
  }

  // import from partial
  if (/^import\s+/.test(line.trim()) && /from\s+['"]$/.test(line) && isJs) {
    return { insertText: "';", source: 'local' };
  }

  // Python def
  if (isPy && /def\s+\w+\s*\([^)]*\)\s*:\s*$/.test(prefix.trimEnd())) {
    return { insertText: `\n${indent}    pass`, source: 'local' };
  }

  // Closing bracket balance heuristic: if more opens than closes on line
  const opens = (line.match(/[\(\[\{]/g) || []).length;
  const closes = (line.match(/[\)\]\}]/g) || []).length;
  if (opens > closes && isJs) {
    const stack = [];
    for (const ch of line) {
      if ('({['.includes(ch)) stack.push(ch);
      if (')}]'.includes(ch) && stack.length) stack.pop();
    }
    if (stack.length) {
      const map = { '(': ')', '[': ']', '{': '}' };
      const need = stack
        .slice()
        .reverse()
        .map((c) => map[c])
        .join('');
      // Don't suggest if suffix already starts with the closer
      if (suffix && need && suffix.startsWith(need[0])) {
        return { insertText: '', source: 'local' };
      }
      return { insertText: need, source: 'local' };
    }
  }

  // Generic: mid-word identifier completion from prefix tokens
  const m = line.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
  if (m) {
    const partial = m[1];
    const tokens = String(prefix)
      .split(/[^A-Za-z0-9_]+/)
      .filter((t) => t.length > partial.length && t.startsWith(partial));
    const unique = [...new Set(tokens)];
    if (unique.length === 1) {
      return { insertText: unique[0].slice(partial.length), source: 'local' };
    }
  }

  return { insertText: '', source: 'local' };
}

/**
 * Main entry for inline completions (sync, offline).
 * @returns {{ insertText: string, source: string }}
 */
function getCompletion({ prefix, suffix, languageId } = {}) {
  const p = String(prefix || '');
  const s = String(suffix || '');
  if (!p.trim()) {
    return { insertText: '', source: 'local' };
  }
  try {
    const result = localPatternComplete(p, s, languageId);
    return {
      insertText: result.insertText || '',
      source: result.source || 'deterministic',
    };
  } catch {
    return { insertText: '', source: 'local' };
  }
}

module.exports = {
  getCompletion,
  extractPrefixSuffix,
  shouldTrigger,
  DEFAULT_DEBOUNCE_MS,
};
