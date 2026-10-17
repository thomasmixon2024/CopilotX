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

function requireWorkspaceFile(relPath, workspace, mustExist, options = {}) {
  if (typeof relPath !== 'string' || !relPath.trim()) {
    throw new Error('A non-empty path is required.');
  }
  const absolute = resolveWorkspaceFile(relPath, workspace, { mustExist, ...options });
  if (mustExist && !fs.existsSync(absolute)) {
    throw new Error(`File does not exist: ${relPath}`);
  }
  return absolute;
}

function linesOf(text) {
  const arr = text ? text.split(/\r?\n/) : [];
  if (arr.length && arr[arr.length - 1] === '') arr.pop();
  return arr;
}

function diffStats(original, proposed) {
  const before = linesOf(original);
  const after = linesOf(proposed);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1;
  }
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB -= 1;
    endA -= 1;
  }
  return { added: endA - start, removed: endB - start };
}

function buildProposal(call, workspace) {
  const args = call.input && typeof call.input === 'object' ? call.input : {};

  let original;
  let proposed;
  let absolute;
  let lexicalPath;

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
    // Match against a normalized copy so LF snippets hit CRLF files, then
    // re-hydrate the file's own line-ending convention.
    const usesCrlf = original.includes('\r\n');
    const haystack = usesCrlf ? original.replace(/\r\n/g, '\n') : original;
    const needle = args.find.replace(/\r\n/g, '\n');
    let replacement = args.replace;
    replacement = replacement.replace(/\r\n/g, '\n');

    const occurrences = haystack.split(needle).length - 1;
    if (occurrences === 0) {
      throw new Error('edit_file: the find text does not appear in the file.');
    }
    if (occurrences > 1) {
      throw new Error(
        `edit_file: the find text appears ${occurrences} times. Provide a longer, unique snippet.`
      );
    }
    // Function-form replace prevents $& / $` / $' expansion in the payload.
    const replaced = haystack.replace(needle, () => replacement);
    proposed = usesCrlf ? replaced.replace(/\n/g, '\r\n') : replaced;
  } else if (call.name === 'delete_file') {
    absolute = requireWorkspaceFile(args.path, workspace, true, { rejectSymlink: true });
    lexicalPath = path.isAbsolute(args.path)
      ? path.resolve(args.path)
      : path.resolve(workspace.workspaceFolders[0].path, args.path);
    const stat = fs.lstatSync(lexicalPath);
    if (stat.isSymbolicLink()) {
      throw new Error('delete_file does not support symbolic links.');
    }
    if (!stat.isFile()) {
      throw new Error('delete_file can only delete regular files.');
    }
    original = fs.readFileSync(absolute, 'utf8');
    proposed = '';
  } else {
    throw new Error(`Unknown write tool: ${call.name}`);
  }

  return {
    id: nextProposalId(),
    tool: call.name,
    path: absolute,
    ...(lexicalPath ? { lexicalPath } : {}),
    relPath: path.relative(
      path.resolve((workspace.workspaceFolders || [{}])[0].path || '.'),
      absolute
    ).split(path.sep).join('/'),
    created: call.name === 'write_file' && !fs.existsSync(absolute),
    deleted: call.name === 'delete_file',
    original,
    proposed,
    diff: diffStats(original, proposed),
  };
}

// Pure drift check: given the proposal and the file's current on-disk content
// (null when the file is missing), returns an error message or null when safe.
function checkDrift(proposal, currentOnDisk) {
  if (!proposal || !proposal.path) return 'Invalid proposal.';
  if (currentOnDisk === null || currentOnDisk === undefined) {
    return proposal.created ? null : 'File no longer exists. Discard and re-propose.';
  }
  if (currentOnDisk !== proposal.original) {
    return 'File changed since the proposal was made. Discard and re-propose.';
  }
  return null;
}

function applyProposal(proposal) {
  if (!proposal || !proposal.path) throw new Error('Invalid proposal.');
  const targetPath = proposal.tool === 'delete_file'
    ? (proposal.lexicalPath || proposal.path)
    : proposal.path;
  const current = fs.existsSync(targetPath)
    ? fs.readFileSync(targetPath, 'utf8')
    : null;
  const drift = checkDrift(proposal, current);
  if (drift) throw new Error(drift);
  if (proposal.tool === 'delete_file') {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('delete_file can only delete the originally proposed regular file.');
    }
    fs.unlinkSync(targetPath);
    return { applied: true, path: proposal.path, diff: proposal.diff };
  }
  fs.mkdirSync(path.dirname(proposal.path), { recursive: true });
  fs.writeFileSync(proposal.path, proposal.proposed, 'utf8');
  return { applied: true, path: proposal.path, diff: proposal.diff };
}

module.exports = { buildProposal, applyProposal, checkDrift, diffStats };
