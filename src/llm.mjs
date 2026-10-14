// Language-model calls through the OpenAI Responses API.
// llmJson: one structured answer with a strict JSON schema. llmAgent: a function-calling loop.
// LLM_MOCK=1 uses the supplied mock functions so the app runs without a key.
const MODEL = () => process.env.OPENAI_MODEL || 'gpt-5.6-terra';
export const llmMock = () => process.env.LLM_MOCK === '1';

async function responses(payload) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set');
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL(), store: false, ...payload }),
    signal: AbortSignal.timeout(90000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`model error ${res.status}: ${body?.error?.message || 'unknown'}`);
  return body;
}
const textOf = (body) => body.output_text ?? (body.output || []).flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');

export async function llmJson({ system, user, name, schema, mock }) {
  if (llmMock()) return mock();
  const body = await responses({
    input: [{ role: 'system', content: system }, { role: 'user', content: user }],
    text: { format: { type: 'json_schema', name, schema, strict: true } },
  });
  const text = textOf(body);
  if (!text) throw new Error('model returned no text');
  return JSON.parse(text);
}

// tools: [{ name, description, parameters (JSON schema, strict), run: async (args) => result }]
// history: prior [{role, content}] turns. onEvent receives {type:'tool', name, args, result, ms}.
export async function llmAgent({ system, history, user, tools, onEvent, maxSteps = 6, mock }) {
  if (llmMock()) return mock({ tools, onEvent });
  const defs = tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: true }));
  const input = [{ role: 'system', content: system }, ...history, { role: 'user', content: user }];
  for (let step = 0; step < maxSteps; step++) {
    const body = await responses({ input, tools: defs, parallel_tool_calls: false });
    const calls = (body.output || []).filter((o) => o.type === 'function_call');
    if (!calls.length) return textOf(body).trim();
    for (const item of body.output || []) if (item.type === 'function_call') input.push({ type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments });
    for (const c of calls) {
      const tool = tools.find((t) => t.name === c.name);
      const t0 = Date.now();
      let args = {}, result;
      try { args = JSON.parse(c.arguments || '{}'); result = tool ? await tool.run(args) : { error: `unknown tool ${c.name}` }; }
      catch (e) { result = { error: e.message }; }
      onEvent?.({ type: 'tool', name: c.name, args, result, ms: Date.now() - t0 });
      input.push({ type: 'function_call_output', call_id: c.call_id, output: JSON.stringify(result).slice(0, 12000) });
    }
  }
  return 'I ran out of steps working on that. Could you ask it a simpler way?';
}
