'use strict';

/**
 * Optional live-model backend.
 * provider: none | anthropic | openai | nim
 */
async function complete({
  provider,
  apiKey,
  model,
  openaiBaseUrl,
  system,
  user,
  messages,
  tools,
}) {
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

module.exports = { complete, localResponse };
