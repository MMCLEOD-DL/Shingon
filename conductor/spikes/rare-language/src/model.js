// Where attempts come from: an OpenAI-compatible chat endpoint (LocalAI on the desktop), or a replay file.
import { readFileSync } from 'node:fs';

export function buildPrompt(task, adapter) {
  return [
    `Write ${adapter.language} code for the task below.`,
    `Reply with one fenced code block holding the complete contents of ${adapter.solutionFile}, and nothing else.`,
    '',
    `Task: ${task.title}`,
    task.prompt,
  ].join('\n');
}

// The first fenced block's body, or the whole reply when there is none. An empty result is still an attempt: it
// fails to compile, which is what the model actually produced.
export function extractCode(text) {
  const reply = String(text ?? '').replace(/\r\n?/g, '\n');
  const m = /```[^\n`]*\n([\s\S]*?)```/.exec(reply);
  return `${(m ? m[1] : reply).trim()}\n`;
}

// The key is read from the environment variable the operator names; its value is sent only to baseUrl and is never
// written to a record or printed.
export function chatClient({ baseUrl, model, apiKeyEnv = null, temperature = 0.8, maxTokens = 2048, timeoutMs = 300000, env = process.env, fetchImpl = fetch }) {
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) throw new Error('--model-url must start with http:// or https://.');
  if (typeof model !== 'string' || model === '') throw new Error('--model is required.');
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  return {
    describe: () => ({ kind: 'chat', url, model, temperature, keyFrom: apiKeyEnv }),
    async generate(prompt) {
      const headers = { 'content-type': 'application/json' };
      const key = apiKeyEnv ? env[apiKeyEnv] : null;
      if (apiKeyEnv && !key) throw new Error(`The environment variable ${apiKeyEnv} is not set.`);
      if (key) headers.authorization = `Bearer ${key}`;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, temperature, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`The model server answered HTTP ${res.status}.`);
      const body = await res.json();
      const text = body?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new Error('The model server answered without a message.');
      return text;
    },
  };
}

// A replay file: { "<task id>": ["reply 1", "reply 2", ...] }, used in order and repeated from the start when
// there are more attempts than replies. For tests, and for re-checking saved replies against a new checker.
export function replayClient(file) {
  const replies = JSON.parse(readFileSync(file, 'utf8'));
  const next = new Map();
  return {
    describe: () => ({ kind: 'replay', file }),
    async generate(prompt, task) {
      const list = replies[task.id];
      if (!Array.isArray(list) || list.length === 0) throw new Error(`The replay file has no replies for ${task.id}.`);
      const i = next.get(task.id) ?? 0;
      next.set(task.id, i + 1);
      return list[i % list.length];
    },
  };
}
