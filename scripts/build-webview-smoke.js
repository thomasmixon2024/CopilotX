'use strict';
// Generates a browser-runnable harness from the REAL webview HTML in src/chatView.js
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'chatView.js'),
  'utf8'
);
const start = src.indexOf('`<!DOCTYPE html>');
const end = src.indexOf('</html>`;');
if (start === -1 || end === -1) throw new Error('webview template not found');
let html = src.slice(start + 1, end + '</html>'.length);
html = html.replace(/\$\{webview\.cspSource\}/g, 'vscode-webview:');
html = html.replace(/\$\{nonce\}/g, 'smoketest');

const preamble = `<script nonce="smoketest">
window.__posted = [];
window.__spoken = [];
window.__cancelled = 0;
window.acquireVsCodeApi = function () {
  return { postMessage: (m) => window.__posted.push(m), getState: () => ({}), setState: () => {} };
};
window.SpeechSynthesisUtterance = function FakeUtterance(text) { this.text = text; };
Object.defineProperty(window, 'speechSynthesis', {
  configurable: true,
  value: {
    speak: (u) => window.__spoken.push(u),
    cancel: () => { window.__cancelled += 1; },
    speaking: false, pending: false, paused: false,
    getVoices: () => [{ name: 'Test Voice' }],
    addEventListener: () => {}, removeEventListener: () => {},
  },
});
</script>`;

html = html.replace('<body>', '<body>' + preamble);
const out = path.join(process.env.TEMP || '/tmp', 'copilotx-webview-smoke.html');
fs.writeFileSync(out, html, 'utf8');
console.log('WROTE', out);
