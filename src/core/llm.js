'use strict';

/**
 * Optional live-model backend.
 * provider: none | local | anthropic | openai | nim
 */
const REQUEST_TIMEOUT_MS = 30000;

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
  const requestSignal = signal || AbortSignal.timeout(timeoutMs || REQUEST_TIMEOUT_MS);
  if (provider === 'local') {
    const base = (openaiBaseUrl || 'http://127.0.0.1:8082/v1').replace(/\/$/, '');
    const headers = {
      'content-type': 'application/json',
    };
    if (apiKey) headers['x-api-key'] = apiKey;
    const selectedModel = model || await discoverLocalModel(base);
    if (!selectedModel) {
      return { mode: 'local', text: null, toolCalls: [] };
    }
    const res = await fetch(`${base}/messages`, {
      method: 'POST',
      headers,
      signal: requestSignal,
      body: JSON.stringify({
        model: selectedModel,
        max_tokens: 2048,
        system,
        messages: messages || [{ role: 'user', content: user }],
        tools: tools && tools.length ? tools : undefined,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Local model ${res.status}: ${err.slice(0, 400)}`);
    }
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
      assistantMessage: message,
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

async function* sseEvents(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, idx).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
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
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    if (dataLines.length) yield dataLines.join('\n');
  }
}

async function streamAnthropic({ url, headers, body, onDelta, signal }) {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic ${res.status}: ${err.slice(0, 400)}`);
  }

  let text = '';
  const blocks = [];
  let current = null;
  for await (const data of sseEvents(res)) {
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
  return {
    mode: 'live',
    text,
    toolCalls,
    assistantMessage: { role: 'assistant', content: blocks },
  };
}

async function streamOpenAI({ url, headers, body, onDelta, signal }) {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI ${res.status}: ${err.slice(0, 400)}`);
  }

  let text = '';
  const toolMap = new Map();
  for await (const data of sseEvents(res)) {
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
}) {
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
