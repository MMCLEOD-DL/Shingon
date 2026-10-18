// src/result.js
const BRAND = Symbol.for('conductor.Result');

export function makeResult(partial = {}) {
  const usage = partial.usage ?? {};
  return {
    [BRAND]: true,
    text: partial.text ?? '',
    diff: partial.diff ?? null,
    verdict: partial.verdict ?? null,
    usage: { costUsd: usage.costUsd ?? null, raw: usage.raw ?? null },
    ok: partial.ok ?? true,
    error: partial.error ?? null,
  };
}

export function isResult(x) {
  return !!x && typeof x === 'object' && x[BRAND] === true;
}
