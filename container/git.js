'use strict';

// Minimal git plumbing for the container runtime. All commands run through
// execFile with argument arrays — no shell interpolation.

const { execFile } = require('child_process');

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`git ${args.join(' ')} failed: ${(stderr || err.message || '').trim()}`));
      } else {
        resolve(String(stdout || '').trim());
      }
    });
  });
}

async function isRepo(cwd) {
  try {
    await git(['rev-parse', '--is-inside-work-tree'], cwd);
    return true;
  } catch {
    return false;
  }
}

async function currentBranch(cwd) {
  const out = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return out || 'HEAD';
}

async function assertCleanTree(cwd) {
  const out = await git(['status', '--porcelain'], cwd);
  if (out) {
    throw new Error(
      `Working tree is not clean (${out.split('\n').length} change(s)). Commit or stash first, or pass --allow-dirty.`
    );
  }
}

async function createBranch(name, cwd) {
  await git(['checkout', '-b', name], cwd);
  return name;
}

async function commitAll(message, cwd) {
  await git(['add', '-A'], cwd);
  const staged = await git(['status', '--porcelain'], cwd);
  if (!staged) return false;
  await git(['commit', '-m', message], cwd);
  return true;
}

async function push(branch, cwd) {
  await git(['push', '-u', 'origin', branch], cwd);
}

module.exports = { git, isRepo, currentBranch, assertCleanTree, createBranch, commitAll, push };
