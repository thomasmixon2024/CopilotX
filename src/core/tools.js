'use strict';

const fs = require('fs');
const path = require('path');

const TOOL_DEFINITIONS = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file inside the current workspace.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative file path, or an absolute path inside a workspace folder.',
        },
        start_line: {
          type: 'integer',
          minimum: 1,
          description: 'Optional 1-based first line to return.',
        },
        end_line: {
          type: 'integer',
          minimum: 1,
          description: 'Optional 1-based last line to return, inclusive.',
        },
      },
      required: ['path'],
    },
  },
];

function getToolDefinitions() {
  return TOOL_DEFINITIONS.map((tool) => ({ ...tool }));
}

function workspaceRoots(workspace) {
  return (workspace && workspace.workspaceFolders ? workspace.workspaceFolders : [])
    .map((folder) => path.resolve(folder.path))
    .filter(Boolean);
}

function resolveWorkspaceFile(filePath, workspace) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('read_file requires a non-empty path.');
  }

  const roots = workspaceRoots(workspace);
  if (!roots.length) throw new Error('No workspace folder is open.');

  const candidate = path.resolve(filePath);
  const absolute = path.isAbsolute(filePath)
    ? candidate
    : path.resolve(roots[0], filePath);
  const realPath = fs.realpathSync(absolute);
  const realRoots = roots.map((root) => fs.realpathSync(root));
  const insideRoot = roots.some(
    (_, index) =>
      realPath === realRoots[index] ||
      realPath.startsWith(`${realRoots[index]}${path.sep}`)
  );
  if (!insideRoot) throw new Error('Path is outside the current workspace.');
  return realPath;
}

function readFile(input, workspace) {
  const args = input && typeof input === 'object' ? input : {};
  const filePath = resolveWorkspaceFile(args.path, workspace);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('Path is not a file.');

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const start = Number.isInteger(args.start_line) ? Math.max(1, args.start_line) : 1;
  const end = Number.isInteger(args.end_line)
    ? Math.min(lines.length, Math.max(start, args.end_line))
    : lines.length;
  return {
    path: filePath,
    start_line: start,
    end_line: end,
    content: lines.slice(start - 1, end).join('\n'),
  };
}

function executeToolCall(call, workspace) {
  if (!call || call.name !== 'read_file') {
    throw new Error(`Unknown tool: ${call && call.name ? call.name : 'missing name'}`);
  }
  return readFile(call.input, workspace);
}

module.exports = { getToolDefinitions, executeToolCall };
