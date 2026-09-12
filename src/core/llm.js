'use strict';

/**
 * Optional live-model backend.
 * provider: none | local | anthropic | openai | nim
 */
const REQUEST_TIMEOUT_MS = 30000;
const LOCAL_MAX_TOKENS = 768;
const LOCAL_REFRESH_BUDGETS = [LOCAL_MAX_TOKENS, 512, 384, 256];

async function complete({
  provider,
  apiKey,
  model,
  openaiBaseUrl,
  system,
  user,
  messages,
  tools,
  timeoutMs,
  signal,
}) {
  const requestSignal = combineSignals(signal, timeoutMs || REQUEST_TIMEOUT_MS);
  if (provider === 'local') {
    const base = (openaiBaseUrl || 'http://127.0.0.1:8082/v1').replace(/\/$/, '');
    const headers = {
      'content-type': 'application/json',
    };
    if (apiKey) headers['x-api-key'] = apiKey;
    const selectedModel = model || await discoverLocalModel(base);
    if (!selectedModel) {
      throw new Error(
        `No model available from local provider at ${base}. ` +
          `Model auto-discovery via GET ${base}/models returned nothing (many OpenAI-compatible ` +
          `proxies, including fcc-server, don't implement it) and no "copilotx.model" is set. ` +
          `Set "copilotx.model" explicitly, e.g. "open_router/anthropic/claude-sonnet-5".`
      );
    }
    let lastError;
    for (let attempt = 0; attempt < LOCAL_REFRESH_BUDGETS.length; attempt += 1) {
      const res = await fetch(`${base}/messages`, {
        method: 'POST',
        headers,
        signal: combineSignals(signal, timeoutMs || REQUEST_TIMEOUT_MS),
        body: JSON.stringify({
          model: selectedModel,
          max_tokens: LOCAL_REFRESH_BUDGETS[attempt],
          system,
          messages: messages || [{ role: 'user', content: user }],
          tools: tools && tools.length ? tools : undefined,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const content = data.content || [];
        return {
          mode: 'live',
          text: content.filter((item) => item.type === 'text').map((item) => item.text).join('\n'),
          toolCalls: content
            .filter((item) => item.type === 'tool_use')
            .map((item) => ({ id: item.id, name: item.name, input: item.input || {} })),
          assistantMessage: { role: 'assistant', content },
          model: selectedModel,
        };
      }
      const err = await res.text();
      lastError = new Error(`Local model ${res.status}: ${err.slice(0, 400)}`);
      const isCreditCap = res.status === 402 || /billing|credit|afford|max_tokens/i.test(err);
      if (!isCreditCap || attempt === LOCAL_REFRESH_BUDGETS.length - 1) throw lastError;
    }
    throw lastError;
  }

  if (!provider || provider === 'none' || !apiKey) {
    return { mode: 'local', text: null, toolCalls: [] };
  }

  if (provider === 'anthropic') {
    const configuredBase =
      openaiBaseUrl && !openaiBaseUrl.includes('api.openai.com')
        ? openaiBaseUrl
        : 'https://api.anthropic.com';
    const base = configuredBase.replace(/\/$/, '');
    const url = base.includes('/v1') ? `${base}/messages` : `${base}/v1/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: requestSignal,
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-5',
        max_tokens: 2048,
        system,
        messages: messages || [{ role: 'user', content: user }],
        tools: tools && tools.length ? tools : undefined,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic ${res.status}: ${err.slice(0, 400)}`);
    }

    const data = await res.json();
    const text = (data.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    const toolCalls = (data.content || [])
      .filter((c) => c.type === 'tool_use')
      .map((c) => ({ id: c.id, name: c.name, input: c.input || {} }));
    return {
      mode: 'live',
      text,
      toolCalls,
      assistantMessage: { role: 'assistant', content: data.content || [] },
    };
  }

  if (provider === 'openai' || provider === 'nim') {
    const base = (openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      signal: requestSignal,
      body: JSON.stringify({
        model: model || (provider === 'nim' ? 'meta/llama-3.1-8b-instruct' : 'gpt-4o'),
        messages: messages || [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        tools: tools && tools.length
          ? tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.input_schema,
              },
            }))
          : undefined,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI ${res.status}: ${err.slice(0, 400)}`);
    }
    const data = await res.json();
    const message = data.choices?.[0]?.message || {};
    const toolCalls = (message.tool_calls || []).map((call) => {
      let input = {};
      try {
        input = JSON.parse(call.function?.arguments || '{}');
      } catch {
        throw new Error(`Model returned invalid arguments for ${call.function?.name || 'tool'}.`);
      }
      return { id: call.id, name: call.function?.name, input };
    });
    return {
      mode: 'live',
      text: message.content || '',
      toolCalls,
      assistantMessage: { ...message, role: message.role || 'assistant' },
    };
  }

  throw new Error(`Unknown provider: ${provider}`);
}

function safeParseJson(raw, toolName) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw new Error(`Model returned invalid arguments for ${toolName || 'tool'}.`);
  }
}

function combineSignals(signal, timeoutMs) {
  if (!signal && !timeoutMs) return undefined;
  if (!timeoutMs) return signal || undefined;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([signal, timeoutSignal]);
  }
  const controller = new AbortController();
  if (signal.aborted) controller.abort(signal.reason);
  else {
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  timeoutSignal.addEventListener('abort', () => controller.abort(timeoutSignal.reason), {
    once: true,
  });
  return controller.signal;
}

async function readWithIdleTimeout(reader, idleTimeoutMs) {
  if (!idleTimeoutMs) return reader.read();
  let timer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          const err = new Error('Stream stalled: no data received');
          err.name = 'TimeoutError';
          reject(err);
        }, idleTimeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function* sseEvents(res, { idleTimeoutMs } = {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await readWithIdleTimeout(reader, idleTimeoutMs);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Normalize CRLF and bare CR, but defer a lone trailing \r until the
      // next chunk arrives so a \r\n pair split across two chunks is not
      // prematurely broken into two \n characters.
      const holdCR = buffer.endsWith('\r');
      const safe = holdCR ? buffer.slice(0, -1) : buffer;
      const normalized = safe.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      buffer = holdCR ? normalized + '\r' : normalized;
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = rawEvent
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim());
        if (dataLines.length) yield dataLines.join('\n');
      }
    }
    if (buffer.trim()) {
      const dataLines = buffer
        .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
      if (dataLines.length) yield dataLines.join('\n');
    }
  } finally {
    // Always release the reader so the HTTP connection is not left locked
    // when the generator exits via timeout, abort, or normal completion.
    if (typeof reader.cancel === 'function') reader.cancel().catch(() => {});
  }
}

async function streamAnthropic({ url, headers, body, onDelta, signal, stallTimeoutMs }) {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    signal: combineSignals(signal, stallTimeoutMs),
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic ${res.status}: ${err.slice(0, 400)}`);
  }

  let text = '';
  const blocks = [];
  let current = null;
  for await (const data of sseEvents(res, { idleTimeoutMs: stallTimeoutMs })) {
    if (data === '[DONE]') break;
    let evt;
    try {
      evt = JSON.parse(data);
    } catch {
      continue;
    }
    if (evt.type === 'content_block_start') {
      current =
        evt.content_block && evt.content_block.type === 'tool_use'
          ? { type: 'tool_use', id: evt.content_block.id, name: evt.content_block.name, input: '' }
          : { type: 'text', text: '' };
      blocks.push(current);
    } else if (evt.type === 'content_block_delta' && current) {
      if (evt.delta && evt.delta.type === 'text_delta') {
        current.text += evt.delta.text;
        text += evt.delta.text;
        if (onDelta) onDelta(evt.delta.text);
      } else if (evt.delta && evt.delta.type === 'input_json_delta') {
        current.input += evt.delta.partial_json || '';
      }
    } else if (evt.type === 'error') {
      throw new Error(`Anthropic stream error: ${JSON.stringify(evt.error || evt).slice(0, 300)}`);
    }
  }

  const toolCalls = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: safeParseJson(b.input, b.name) }));
  const messageBlocks = blocks.map((b) =>
    b.type === 'tool_use' ? { ...b, input: safeParseJson(b.input, b.name) } : b
  );
  return {
    mode: 'live',
    text,
    toolCalls,
    assistantMessage: { role: 'assistant', content: messageBlocks },
  };
}

async function streamOpenAI({ url, headers, body, onDelta, signal, stallTimeoutMs }) {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    signal: combineSignals(signal, stallTimeoutMs),
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI ${res.status}: ${err.slice(0, 400)}`);
  }

  let text = '';
  const toolMap = new Map();
  for await (const data of sseEvents(res, { idleTimeoutMs: stallTimeoutMs })) {
    if (data === '[DONE]') break;
    let evt;
    try {
      evt = JSON.parse(data);
    } catch {
      continue;
    }
    const choice = evt.choices && evt.choices[0];
    const delta = (choice && choice.delta) || {};
    if (delta.content) {
      text += delta.content;
      if (onDelta) onDelta(delta.content);
    }
    for (const call of delta.tool_calls || []) {
      if (!call || (call.id === undefined && !call.function)) continue;
      const index = typeof call.index === 'number' ? call.index : toolMap.size;
      if (!toolMap.has(index)) {
        toolMap.set(index, { id: `call-${index}`, name: '', input: '' });
      }
      const entry = toolMap.get(index);
      if (call.id) entry.id = call.id;
      if (call.function && call.function.name) entry.name = call.function.name;
      if (call.function && call.function.arguments) entry.input += call.function.arguments;
    }
  }

  const rawCalls = [...toolMap.values()];
  const toolCalls = rawCalls.map((c) => ({
    id: c.id,
    name: c.name,
    input: safeParseJson(c.input, c.name),
  }));
  const assistantMessage = { role: 'assistant', content: text };
  if (rawCalls.length) {
    assistantMessage.tool_calls = rawCalls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: c.input },
    }));
  }
  return { mode: 'live', text, toolCalls, assistantMessage };
}

async function streamComplete({
  provider,
  apiKey,
  model,
  openaiBaseUrl,
  system,
  user,
  messages,
  tools,
  onDelta,
  signal,
  stallTimeoutMs,
}) {
  const stall = stallTimeoutMs || 120000;
  if (provider === 'local' || !provider || provider === 'none' || !apiKey) {
    const result = await complete({
      provider,
      apiKey,
      model,
      openaiBaseUrl,
      system,
      user,
      messages,
      tools,
    });
    if (onDelta && result.text) onDelta(result.text);
    return result;
  }

  if (provider === 'anthropic') {
    const configuredBase =
      openaiBaseUrl && !openaiBaseUrl.includes('api.openai.com')
        ? openaiBaseUrl
        : 'https://api.anthropic.com';
    const base = configuredBase.replace(/\/$/, '');
    const url = base.includes('/v1') ? `${base}/messages` : `${base}/v1/messages`;
    return streamAnthropic({
      url,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: model || 'claude-sonnet-4-5',
        max_tokens: 2048,
        system,
        messages: messages || [{ role: 'user', content: user }],
        tools: tools && tools.length ? tools : undefined,
      },
      onDelta,
      signal,
      stallTimeoutMs: stall,
    });
  }

  if (provider === 'openai' || provider === 'nim') {
    const base = (openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    return streamOpenAI({
      url: `${base}/chat/completions`,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: {
        model: model || (provider === 'nim' ? 'meta/llama-3.1-8b-instruct' : 'gpt-4o'),
        messages: messages || [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        tools: tools && tools.length
          ? tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.input_schema,
              },
            }))
          : undefined,
      },
      onDelta,
      signal,
      stallTimeoutMs: stall,
    });
  }

  throw new Error(`Unknown provider: ${provider}`);
}

async function discoverLocalModel(base) {
  try {
    const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const data = await res.json();
    const models = Array.isArray(data.data) ? data.data : [];
    const preferred = models.find((entry) => entry.id && /instruct|chat|coder/i.test(entry.id));
    return (preferred || models[0])?.id || null;
  } catch {
    return null;
  }
}

function localResponse({ agent, personaName, input, reason, keywords }) {
  return [
    `**${personaName}** · routed via \`${reason}\``,
    keywords && keywords.length ? `Matched: ${keywords.join(', ')}` : '',
    '',
    `You asked:`,
    `> ${input}`,
    '',
    `Live model is off (set \`copilotx.provider\` + API key for Claude/OpenAI).`,
    `Local engine notes:`,
    `- Agent **${agent}** would handle this turn.`,
    `- Workspace context (if enabled) is attached on the next live call.`,
    `- Open the sidebar, type a question, or use **Explain Selection**.`,
    '',
    `_This fallback keeps CopilotX usable without a paid key._`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

module.exports = { complete, streamComplete, localResponse };
