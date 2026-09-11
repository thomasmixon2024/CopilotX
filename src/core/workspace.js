'use strict';

function mentionsWorkspace(input) {
  return /@workspace\b/i.test(String(input || ''));
}

function formatWorkspaceBlock(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return '';
  const lines = ['=== WORKSPACE CONTEXT ==='];

  if (snapshot.workspaceFolders && snapshot.workspaceFolders.length) {
    lines.push(
      'Folders: ' +
        snapshot.workspaceFolders.map((f) => `${f.name} (${f.path})`).join(', ')
    );
  }

  if (snapshot.activeFile) {
    const af = snapshot.activeFile;
    lines.push(`Active file: ${af.path} [${af.languageId}] (${af.lineCount} lines)`);
    const body = String(af.content || '');
    const clipped = body.length > 8000 ? body.slice(0, 8000) + '\n…[truncated]' : body;
    lines.push('--- active file ---');
    lines.push(clipped);
    lines.push('--- end active file ---');
  }

  if (snapshot.selection && snapshot.selection.text) {
    lines.push(
      `Selection L${snapshot.selection.startLine}-L${snapshot.selection.endLine}:`
    );
    lines.push(snapshot.selection.text.slice(0, 4000));
  }

  if (snapshot.cursor) {
    lines.push(`Cursor: L${snapshot.cursor.line}:${snapshot.cursor.character}`);
  }

  if (snapshot.openTabs && snapshot.openTabs.length) {
    lines.push(
      'Open tabs: ' +
        snapshot.openTabs
          .slice(0, 20)
          .map((t) => t.path)
          .join(', ')
    );
  }

  if (snapshot.projectTree && snapshot.projectTree.length) {
    lines.push('Project tree:');
    lines.push(snapshot.projectTree.slice(0, 80).join('\n'));
  }

  lines.push('=== END WORKSPACE ===');
  if (lines.length <= 2) return '';
  return lines.join('\n');
}

module.exports = { mentionsWorkspace, formatWorkspaceBlock };
