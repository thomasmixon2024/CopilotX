'use strict';

const fs = require('fs');
const path = require('path');
const { resolveWorkspaceFile } = require('./tools');

const MAX_PROPOSED_BYTES = 512 * 1024;

let proposalCounter = 0;

function nextProposalId() {
  proposalCounter += 1;
  return `p${Date.now().toString(36)}-${proposalCounter}`;
}

function requireWorkspaceFile(relPath, workspace, mustExist) {
  if (typeof relPath !== 'string' || !relPath.trim()) {
    throw new Error('A non-empty path is required.');
  }
  const absolute = resolveWorkspaceFile(relPath, workspace, { mustExist });
  if (mustExist && !fs.existsSync(absolute)) {
    throw new Error(`File does not exist: ${relPath}`);
  }
  return absolute;
}

function diffStats(original, proposed) {
  function linesOf(text) {
    const arr = text ? text.split(/\r?\n/) : [];
    if (arr.length && arr[arr.length - 1] === '') arr.pop();
    return arr;
  }
  const before = linesOf(original);
  const after = linesOf(proposed);
  let added = 0;
  let removed = 0;
  const max = Math.max(before.length, after.length);
  for (let i = 0; i < max; i += 1) {
    if (before[i] !== after[i]) {
      if (i < before.length) removed += 1;
      if (i < after.length) added += 1;
    }
  }
  return { added, removed };
}

function buildProposal(call, workspace) {
  const args = call.input && typeof call.input === 'object' ? call.input : {};

  let original;
  let proposed;
  let absolute;

  if (call.name === 'write_file') {
    if (typeof args.content !== 'string') {
      throw new Error('write_file requires a string content argument.');
    }
    if (Buffer.byteLength(args.content, 'utf8') > MAX_PROPOSED_BYTES) {
      throw new Error('Proposed content exceeds the 512 KB limit.');
    }
    absolute = requireWorkspaceFile(args.path, workspace, false);
    original = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : '';
    proposed = args.content;
  } else if (call.name === 'edit_file') {
    if (typeof args.find !== 'string' || !args.find) {
      throw new Error('edit_file requires a non-empty find argument.');
    }
    if (typeof args.replace !== 'string') {
      throw new Error('edit_file requires a replace argument (use "" to delete).');
    }
    absolute = requireWorkspaceFile(args.path, workspace, true);
    original = fs.readFileSync(absolute, 'utf8');
    const occurrences = original.split(args.find).length - 1;
    if (occurrences === 0) {
      throw new Error('edit_file: the find text does not appear in the file.');
    }
    if (occurrences > 1) {
      throw new Error(
        `edit_file: the find text appears ${occurrences} times. Provide a longer, unique snippet.`
      );
    }
    proposed = original.replace(args.find, args.replace);
  } else {
    throw new Error(`Unknown write tool: ${call.name}`);
  }

  return {
    id: nextProposalId(),
    tool: call.name,
    path: absolute,
    relPath: path.relative(
      path.resolve((workspace.workspaceFolders || [{}])[0].path || '.'),
      absolute
    ).split(path.sep).join('/'),
    created: call.name === 'write_file' && !fs.existsSync(absolute),
    original,
    proposed,
    diff: diffStats(original, proposed),
  };
}

function applyProposal(proposal) {
  if (!proposal || !proposal.path) throw new Error('Invalid proposal.');
  if (fs.existsSync(proposal.path)) {
    const current = fs.readFileSync(proposal.path, 'utf8');
    if (current !== proposal.original) {
      throw new Error('File changed since the proposal was made. Discard and re-propose.');
    }
  } else if (!proposal.created) {
    throw new Error('File no longer exists. Discard and re-propose.');
  }
  fs.mkdirSync(path.dirname(proposal.path), { recursive: true });
  fs.writeFileSync(proposal.path, proposal.proposed, 'utf8');
  return { applied: true, path: proposal.path, diff: proposal.diff };
}

module.exports = { buildProposal, applyProposal, diffStats };
