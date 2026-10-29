// The only module that talks to the operator service. Paths and shapes follow
// conductor/docs/operator-app/interface.md (contract v1). Everything comes back as
// data or an ApiError; nothing here guesses success.

export class ApiError extends Error {
  constructor({ status, code, message, retryable = false, requestId = null }) {
    super(message);
    Object.assign(this, { status, code, retryable, requestId });
  }
}

const GENERIC = 'The service could not complete that. Check that the Conductor app is still running.';

/** Unique id for idempotent creates and answers (stored by the service with the body). */
export const newRequestId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^a-zA-Z0-9_-]/g, '');

export function createApi({ fetchImpl = (...a) => globalThis.fetch(...a), base = '/api/v1' } = {}) {
  async function call(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetchImpl(base + path, {
        method, credentials: 'same-origin',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError({ status: 0, code: 'unreachable', message: 'The Conductor service is not answering. It may have stopped; start it again and use its new sign-in link.', retryable: true });
    }
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      const e = data?.error;
      throw new ApiError({ status: res.status, code: typeof e?.code === 'string' ? e.code : 'unknown', message: typeof e?.message === 'string' ? e.message : GENERIC, retryable: e?.retryable === true, requestId: e?.requestId ?? null });
    }
    if (data === null) throw new ApiError({ status: res.status, code: 'bad-response', message: GENERIC });
    return data;
  }
  const enc = encodeURIComponent;
  return {
    call,
    signIn: (bootstrapToken) => call('/session', { method: 'POST', body: { bootstrapToken } }),
    health: () => call('/health'),
    setup: () => call('/setup'),
    validateSetup: (body) => call('/setup/validate', { method: 'POST', body }),
    saveSetup: (body) => call('/setup', { method: 'PUT', body }),
    probe: (participantId, kind) => call(`/participants/${enc(participantId)}/probe`, { method: 'POST', body: { kind } }),
    repositories: () => call('/repositories'),
    registerRepository: (path) => call('/repositories', { method: 'POST', body: { path } }),
    runs: (cursor) => call(`/runs${cursor ? `?cursor=${enc(cursor)}` : ''}`),
    run: (id) => call(`/runs/${enc(id)}`),
    review: (id) => call(`/runs/${enc(id)}/review`),
    createRun: ({ repositoryId, request, clientRequestId }) => call('/runs', { method: 'POST', body: { repositoryId, request, presetId: 'default', clientRequestId } }),
    answer: (runId, decisionId, { choiceId, expectedRevision, reviewedCommit, clientRequestId, feedback }) =>
      call(`/runs/${enc(runId)}/decisions/${enc(decisionId)}`, { method: 'POST', body: { choiceId, expectedRevision, reviewedCommit, clientRequestId, ...(feedback ? { feedback } : {}) } }),
    cancel: (id) => call(`/runs/${enc(id)}/cancel`, { method: 'POST', body: {} }),
    resume: (id) => call(`/runs/${enc(id)}/resume`, { method: 'POST', body: {} }),
    // Records only that the operator inspected the repository after an uncertain landing. Starts nothing; Resume is separate.
    recover: (id, { clientRequestId, repositoryInspected, expectedEventSeq, reviewedCommit }) =>
      call(`/runs/${enc(id)}/recover`, { method: 'POST', body: { clientRequestId, repositoryInspected, expectedEventSeq, reviewedCommit } }),
  };
}

/**
 * Reads `#bootstrap=<token>` once, removes it from the address bar and history before
 * any request, and exchanges it for the session cookie. The token is never stored.
 * Returns 'none' when the page was opened without a token (a reload with a cookie).
 */
export async function bootstrapFromFragment(api, { location = window.location, history = window.history } = {}) {
  const token = new URLSearchParams(location.hash.slice(1)).get('bootstrap');
  if (!token) return 'none';
  history.replaceState(null, '', location.pathname + location.search);
  await api.signIn(token);
  return 'signed-in';
}
