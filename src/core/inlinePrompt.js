'use strict';

const INLINE_SYSTEM =
  'You are a code completion engine. Continue the code exactly where it stops. ' +
  'Output ONLY the text that should be inserted at the cursor. ' +
  'No explanations, no markdown fences, no repetition of existing code.';

function extractWindow(text, offset) {
  const before = text.slice(0, offset).split('\n');
  const after = text.slice(offset).split('\n');
  return {
    prefix: before.slice(-200).join('\n'),
    suffix: after.slice(0, 40).join('\n'),
  };
}

function buildInlinePrompt({ prefix, suffix, languageId }) {
  return {
    system: INLINE_SYSTEM,
    user: `Language: ${languageId || 'plaintext'}\n\n<code>\n${prefix}<CURSOR>${suffix}\n</code>\n\nContinue the code at <CURSOR>.`,
  };
}

function cleanCompletion(text, prefix) {
  let insert = String(text || '');
  insert = insert.replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/```\s*$/, '');
  const maxOverlap = Math.min(prefix.length, insert.length, 200);
  for (let len = maxOverlap; len > 0; len -= 1) {
    if (insert.startsWith(prefix.slice(-len))) {
      insert = insert.slice(len);
      break;
    }
  }
  return insert;
}

module.exports = { INLINE_SYSTEM, extractWindow, buildInlinePrompt, cleanCompletion };
