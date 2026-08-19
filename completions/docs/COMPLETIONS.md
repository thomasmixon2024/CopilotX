# Inline Ghost-Text Completions - Phase 3 (v0.7.0)

Local, low-latency inline suggestions for VS Code.

## Design
- Hot path is 100% offline (`src/core/completions.js`)
- Pattern + heuristic engine (function bodies, return, brackets, identifier continuation)
- Debounced trigger (default ~120-150ms)
- Optional LLM escalation is intentionally out of the hot path

## API
```js
const { getCompletion, extractPrefixSuffix, shouldTrigger } = require('./src/core/completions');
const { prefix, suffix } = extractPrefixSuffix(documentText, cursorOffset);
const { insertText } = getCompletion({ prefix, suffix, languageId: 'javascript' });
```

## VS Code
Registers `vscode.languages.registerInlineCompletionItemProvider` for all files.
Ensure `editor.inlineSuggest.enabled` is true (set via extension configurationDefaults).

## PowerShell
```powershell
Get-CopilotXCompletion -Prefix "const x = " -Suffix ";" -LanguageId javascript
```
