'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const MAX_FILE_BYTES = 100 * 1024;
const MAX_LINES = 2000;
const MAX_LIST_ENTRIES = 400;
const MAX_SEARCH_RESULTS = 50;
const MAX_SEARCH_FILES = 200;
const SEARCH_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
]);

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
  {
    name: 'list_dir',
    description: 'List files and directories inside the current workspace, recursively up to a depth.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative directory path. Defaults to the workspace root.',
        },
        depth: {
          type: 'integer',
          minimum: 1,
          maximum: 5,
          description: 'Recursion depth. Defaults to 2.',
        },
      },
    },
  },
  {
    name: 'search_files',
    description: 'Search file contents across the current workspace for a text or regex pattern.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Text or regular expression to search for.',
        },
        is_regex: {
          type: 'boolean',
          description: 'Treat the pattern as a regular expression. Defaults to false.',
        },
        path: {
          type: 'string',
          description: 'Workspace-relative directory to search in. Defaults to the workspace root.',
        },
        max_results: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Maximum matches to return. Defaults to 50.',
        },
      },
      required: ['pattern'],
    },
  },
];

const WRITE_TOOL_DEFINITIONS = [
  {
    name: 'write_file',
    description:
      'Propose the full content of a workspace file. The change is NOT applied until the user approves it.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative file path to create or overwrite.',
        },
        content: {
          type: 'string',
          description: 'The complete new file content.',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Propose replacing one exact, unique snippet inside a workspace file. The change is NOT applied until the user approves it.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative file path to edit.',
        },
        find: {
          type: 'string',
          description: 'Exact existing snippet to replace. Must appear exactly once in the file.',
        },
        replace: {
          type: 'string',
          description: 'Replacement text. Use an empty string to delete the snippet.',
        },
      },
      required: ['path', 'find', 'replace'],
    },
  },
  {
    name: 'delete_file',
    description:
      'Propose deleting one regular workspace file. The file is NOT deleted until the user approves it.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Workspace-relative file path to delete.',
        },
      },
      required: ['path'],
    },
  },
];

function getToolDefinitions({ includeWrites = false } = {}) {
  const defs = includeWrites ? [...TOOL_DEFINITIONS, ...WRITE_TOOL_DEFINITIONS] : TOOL_DEFINITIONS;
  return defs.map((tool) => ({ ...tool }));
}

function workspaceRoots(workspace) {
  return (workspace && workspace.workspaceFolders ? workspace.workspaceFolders : [])
    .map((folder) => path.resolve(folder.path))
    .filter(Boolean);
}

function resolveWorkspaceFile(
  filePath,
  workspace,
  { mustExist = true, rejectSymlink = false } = {}
) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('A non-empty path is required.');
  }

  const roots = workspaceRoots(workspace);
  if (!roots.length) throw new Error('No workspace folder is open.');

  const candidate = path.resolve(filePath);
  const absolute = path.isAbsolute(filePath)
    ? candidate
    : path.resolve(roots[0], filePath);
  let realPath;
  if (fs.existsSync(absolute)) {
    if (rejectSymlink && fs.lstatSync(absolute).isSymbolicLink()) {
      throw new Error('Symbolic links are not supported for this operation.');
    }
    realPath = fs.realpathSync(absolute);
  } else if (mustExist) {
    throw new Error(`File does not exist: ${filePath}`);
  } else {
    // Resolve through the nearest existing ancestor so new files inside
    // not-yet-created subdirectories still validate against the workspace.
    let probe = path.dirname(absolute);
    const tail = [];
    while (!fs.existsSync(probe)) {
      tail.unshift(path.basename(probe));
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    realPath = path.resolve(fs.realpathSync(probe), ...tail, path.basename(absolute));
  }
  const realRoots = roots.map((root) => fs.realpathSync(root));
  const insideRoot = roots.some(
    (_, index) =>
      realPath === realRoots[index] ||
      realPath.startsWith(`${realRoots[index]}${path.sep}`)
  );
  if (!insideRoot) throw new Error('Path is outside the current workspace.');
  return realPath;
}

async function readFile(input, workspace) {
  const args = input && typeof input === 'object' ? input : {};
  const filePath = resolveWorkspaceFile(args.path, workspace);
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw new Error('Path is not a file.');

  const length = Math.min(stat.size, MAX_FILE_BYTES);
  const fh = await fsp.open(filePath, 'r');
  let buffer;
  try {
    buffer = Buffer.alloc(length);
    await fh.read(buffer, 0, length, 0);
  } finally {
    await fh.close();
  }
  const bytesTruncated = stat.size > MAX_FILE_BYTES;

  const allLines = buffer.toString('utf8').split(/\r?\n/);
  const linesTruncated = allLines.length > MAX_LINES;
  const lines = linesTruncated ? allLines.slice(0, MAX_LINES) : allLines;

  const start = Number.isInteger(args.start_line) ? Math.max(1, args.start_line) : 1;
  const end = Number.isInteger(args.end_line)
    ? Math.min(lines.length, Math.max(start, args.end_line))
    : lines.length;
  return {
    path: filePath,
    start_line: start,
    end_line: end,
    total_lines: allLines.length,
    truncated: bytesTruncated || linesTruncated,
    content: lines.slice(start - 1, end).join('\n'),
  };
}

async function listDir(input, workspace) {
  const args = input && typeof input === 'object' ? input : {};
  const roots = workspaceRoots(workspace);
  if (!roots.length) throw new Error('No workspace folder is open.');

  const dirPath = args.path && String(args.path).trim() ? String(args.path) : roots[0];
  const dirReal = resolveWorkspaceFile(dirPath, workspace);
  const stat = await fsp.stat(dirReal);
  if (!stat.isDirectory()) throw new Error('Path is not a directory.');

  const depth = Number.isInteger(args.depth) ? Math.min(5, Math.max(1, args.depth)) : 2;
  const entries = [];

  async function walk(dir, level, prefix) {
    if (entries.length >= MAX_LIST_ENTRIES || level > depth) return;
    let items;
    try {
      items = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      if (entries.length >= MAX_LIST_ENTRIES) break;
      if (item.name.startsWith('.')) continue;
      if (SEARCH_SKIP_DIRS.has(item.name)) continue;
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        entries.push(`${rel}/`);
        await walk(full, level + 1, rel);
      } else if (item.isFile()) {
        entries.push(rel);
      }
    }
  }

  await walk(dirReal, 1, path.relative(roots[0], dirReal).split(path.sep).filter(Boolean).join('/'));
  return {
    path: dirReal,
    total: entries.length,
    truncated: entries.length >= MAX_LIST_ENTRIES,
    entries,
  };
}

function isProbablyBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return sample.includes(0);
}

async function searchFiles(input, workspace) {
  const args = input && typeof input === 'object' ? input : {};
  const pattern = typeof args.pattern === 'string' ? args.pattern : '';
  if (!pattern.trim()) throw new Error('search_files requires a non-empty pattern.');

  let matcher;
  if (args.is_regex) {
    try {
      matcher = new RegExp(pattern, 'i');
    } catch (err) {
      throw new Error(`Invalid regular expression: ${err.message}`);
    }
  } else {
    const needle = pattern.toLowerCase();
    matcher = { test: (line) => line.toLowerCase().includes(needle) };
  }

  const roots = workspaceRoots(workspace);
  if (!roots.length) throw new Error('No workspace folder is open.');
  const searchRoot = args.path && String(args.path).trim()
    ? resolveWorkspaceFile(String(args.path), workspace)
    : roots[0];
  const realRoot = fs.realpathSync(searchRoot);
  const stat = fs.statSync(realRoot);
  if (!stat.isDirectory()) throw new Error('Path is not a directory.');

  const maxResults = Number.isInteger(args.max_results)
    ? Math.min(MAX_SEARCH_RESULTS, Math.max(1, args.max_results))
    : MAX_SEARCH_RESULTS;
  const matches = [];
  let filesScanned = 0;
  let truncated = false;

  async function walk(dir) {
    if (matches.length >= maxResults || filesScanned >= MAX_SEARCH_FILES) {
      truncated = matches.length >= maxResults || filesScanned >= MAX_SEARCH_FILES;
      return;
    }
    let items;
    try {
      items = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (matches.length >= maxResults || filesScanned >= MAX_SEARCH_FILES) {
        truncated = true;
        return;
      }
      if (item.name.startsWith('.')) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (SEARCH_SKIP_DIRS.has(item.name)) continue;
        await walk(full);
        continue;
      }
      if (!item.isFile()) continue;
      let content;
      try {
        const statFile = await fsp.stat(full);
        if (statFile.size > MAX_FILE_BYTES * 4) continue;
        content = await fsp.readFile(full, 'utf8');
      } catch {
        continue;
      }
      if (isProbablyBinary(Buffer.from(content.slice(0, 4096), 'utf8'))) continue;
      filesScanned += 1;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (matcher.test(lines[i])) {
          matches.push({
            file: path.relative(realRoot, full).split(path.sep).join('/'),
            line: i + 1,
            text: lines[i].slice(0, 200),
          });
          if (matches.length >= maxResults) {
            truncated = true;
            return;
          }
        }
      }
    }
  }

  await walk(realRoot);
  return {
    pattern,
    path: realRoot,
    files_scanned: filesScanned,
    total_matches: matches.length,
    truncated,
    matches,
  };
}

const TOOL_HANDLERS = {
  read_file: readFile,
  list_dir: listDir,
  search_files: searchFiles,
};

async function executeToolCall(call, workspace) {
  if (!call || !call.name || !TOOL_HANDLERS[call.name]) {
    throw new Error(`Unknown tool: ${call && call.name ? call.name : 'missing name'}`);
  }
  return TOOL_HANDLERS[call.name](call.input, workspace);
}

module.exports = { getToolDefinitions, executeToolCall, resolveWorkspaceFile };
