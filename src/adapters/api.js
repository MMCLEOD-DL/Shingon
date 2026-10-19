// src/adapters/api.js
// Paid-API fallback participants (spec §7: never the default). Text-only: they can draft
// a plan or review, never edit files. The key goes only into the request header.
import { getRolePreset } from '../roles.js';
import { normalize } from '../normalizer.js';
import { makeResult } from '../result.js';
import { redact, addScrubEnv } from '../secrets.js';
import { isContextOverflow } from '../health.js';

const BODY_MAX = 300;

function priced(prices, inTok, outTok) {
  if (!prices || !Number.isFinite(inTok) || !Number.isFinite(outTok)) return null;
  return (inTok * prices.inputPerMTok + outTok * prices.outputPerMTok) / 1e6;
}

// 401/403/429/5xx: this participant is unusable right now, try the next one.
function failureFor(status, body) {
  if (isContextOverflow(body)) return 'context-overflow';
  if (status === 401 || status === 403 || status === 429 || status >= 500) return 'infrastructure';
  return null;
}

class ApiAdapter {
  constructor({ kind, model, envKey, baseUrl, timeoutMs = 300000, maxTokens = 8192, prices = null }) {
    if (!model) throw new Error(`${kind} requires a model`);
    this.kind = kind;
    this.model = model;
    this.envKey = envKey;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.maxTokens = maxTokens;
    this.prices = prices;
    addScrubEnv(envKey); // a custom key name never reaches a CLI, test command or local agent
  }

  // Presence only: a real check would be a paid call.
  probe() {
    return process.env[this.envKey] ? { ok: true, reason: '' } : { ok: false, reason: 'unauthorized' };
  }

  async run(role, task, context = '', opts = {}) {
    if (opts.write) return makeResult({ ok: false, error: 'an API participant cannot edit files' });
    const key = process.env[this.envKey];
    if (!key) return makeResult({ ok: false, error: `${this.envKey} is not set`, failure: 'infrastructure' });
    const preset = getRolePreset(role);
    const system = `${preset.systemPrompt}\n\n${preset.outputShape}`;
    const prompt = context ? `${task}\n\n---\nContext:\n${context}` : task;
    const { url, headers, body } = this.request({ key, system, prompt });

    let res;
    let text;
    try {
      res = await fetch(url, {
        method: 'POST', headers, body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
      });
      text = await res.text();
    } catch (e) {
      if (e?.name === 'TimeoutError') return makeResult({ ok: false, error: 'timed out', failure: 'timeout' });
      const why = e?.cause?.code ?? e?.message ?? String(e);
      return makeResult({ ok: false, error: redact(`could not reach ${new URL(url).host}: ${why}`), failure: 'infrastructure' });
    }
    if (!res.ok) {
      return makeResult({ ok: false, error: redact(`HTTP ${res.status}: ${text.slice(0, BODY_MAX)}`), failure: failureFor(res.status, text) });
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return makeResult({ ok: false, error: 'the API reply was not JSON' });
    }
    const { out, inTok, outTok } = this.parse(data);
    const norm = normalize(out);
    return makeResult({
      text: norm.text, diff: norm.diff, verdict: norm.verdict, ok: true,
      usage: { costUsd: priced(this.prices, inTok, outTok), raw: data.usage ?? null },
    });
  }
}

export class AnthropicApiAdapter extends ApiAdapter {
  constructor({ envKey = 'ANTHROPIC_API_KEY', baseUrl = 'https://api.anthropic.com', ...rest } = {}) {
    super({ kind: 'anthropic-api', envKey, baseUrl, ...rest });
  }

  request({ key, system, prompt }) {
    return {
      url: `${this.baseUrl}/v1/messages`,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: { model: this.model, max_tokens: this.maxTokens, system, messages: [{ role: 'user', content: prompt }] },
    };
  }

  parse(data) {
    const out = (data.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('');
    return { out, inTok: data.usage?.input_tokens, outTok: data.usage?.output_tokens };
  }
}

export class OpenAiApiAdapter extends ApiAdapter {
  constructor({ envKey = 'OPENAI_API_KEY', baseUrl = 'https://api.openai.com/v1', ...rest } = {}) {
    super({ kind: 'openai-api', envKey, baseUrl, ...rest });
  }

  request({ key, system, prompt }) {
    return {
      url: `${this.baseUrl}/responses`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: { model: this.model, instructions: system, input: prompt, max_output_tokens: this.maxTokens },
    };
  }

  parse(data) {
    const out = typeof data.output_text === 'string'
      ? data.output_text
      : (data.output ?? []).flatMap((o) => o?.content ?? []).filter((c) => c?.type === 'output_text').map((c) => c.text).join('');
    return { out, inTok: data.usage?.input_tokens, outTok: data.usage?.output_tokens };
  }
}
