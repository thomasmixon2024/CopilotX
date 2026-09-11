'use strict';

const vscode = require('vscode');
const { complete } = require('./core/llm');
const { getSettings } = require('./workspaceCollector');
const {
  extractWindow,
  buildInlinePrompt,
  cleanCompletion,
} = require('./core/inlinePrompt');

const INLINE_TIMEOUT_MS = 8000;
const INLINE_DEBOUNCE_MS = 350;
const MAX_DOCUMENT_CHARS = 500000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CopilotXInlineCompletionProvider {
  constructor() {
    this.inFlight = null;
  }

  async provideInlineCompletions(document, position, _context, token) {
    const settings = getSettings();
    if (!settings.inlineCompletions) return undefined;
    if (settings.provider === 'none' || !settings.apiKey) return undefined;
    if (document.getText().length > MAX_DOCUMENT_CHARS) return undefined;

    if (this.inFlight) {
      this.inFlight.abort();
      this.inFlight = null;
    }

    await delay(INLINE_DEBOUNCE_MS);
    if (token.isCancellationRequested) return undefined;

    const controller = new AbortController();
    this.inFlight = controller;
    try {
      const { prefix, suffix } = extractWindow(
        document.getText(),
        document.offsetAt(position)
      );
      const prompt = buildInlinePrompt({ prefix, suffix, languageId: document.languageId });
      const result = await complete({
        provider: settings.provider,
        apiKey: settings.apiKey,
        model: settings.model,
        openaiBaseUrl: settings.openaiBaseUrl,
        system: prompt.system,
        user: prompt.user,
        timeoutMs: INLINE_TIMEOUT_MS,
        signal: controller.signal,
      });
      if (token.isCancellationRequested) return undefined;
      if (result.mode !== 'live' || !result.text) return undefined;
      const insert = cleanCompletion(result.text, prefix);
      if (!insert.trim()) return undefined;
      return [
        new vscode.InlineCompletionItem(insert, new vscode.Range(position, position)),
      ];
    } catch {
      return undefined;
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
  }
}

module.exports = { CopilotXInlineCompletionProvider };
