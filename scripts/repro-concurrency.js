'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const { runTurn } = require('../src/core/engine');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-'));
const workspace = { workspaceFolders: [{ name: 'w', path: tmpRoot }] };

globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  const content = body.messages.at(-1).content;
  const match = content.match(/(\d+)\s*$/);
  const asked = match ? match[1] : '0';
  const firstModelRound = !body.messages.some((m) => m.role === 'assistant');
  console.log('ROLES:', body.messages.map((m) => m.role).join(','), '| asked=', asked, '| firstRound=', firstModelRound);
  if (firstModelRound) {
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: '',
            tool_calls: [{
              id: 'w1',
              type: 'function',
              function: { name: 'write_file', arguments: JSON.stringify({ path: `out-${asked}.txt`, content: 'c' }) },
            }],
          },
        }],
      }),
    };
  }
  return { ok: true, json: async () => ({ choices: [{ message: { content: `done ${asked}`, tool_calls: [] } }] }) };
};

(async () => {
  const r = await runTurn({
    input: '0',
    session: { sessionId: 't', turns: [] },
    workspace,
    settings: { model: '', openaiBaseUrl: 'https://api.openai.com/v1', includeWorkspace: false, streamResponses: false, allowWrites: 'approval', provider: 'openai', apiKey: 'k' },
  });
  console.log('proposals:', r.proposals.length, '| text:', r.text);
})();
