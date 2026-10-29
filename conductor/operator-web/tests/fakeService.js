// An in-memory stand-in for the operator service, seeded from contract-v1.json and used only by
// the unit tests. It implements just enough of interface.md to check that the UI sends the right
// requests and shows the right states. It is not evidence that the real service behaves this way;
// e2e/journey.mjs runs the UI against the real service for that.
import fixtures from './fixtures/contract-v1.json';

const clone = (v) => structuredClone(v);
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

export function fakeService({ run = fixtures.awaitingResult, review = fixtures.review, setup, failWith } = {}) {
  const state = {
    run: clone(run), review: clone(review), calls: [], repositories: clone(fixtures.repositories.repositories),
    setup: setup ?? { configured: true, participants: clone(fixtures.connectionStates).map((p) => ({ ...p, model: null })), local: { model: 'qwen', baseUrl: 'http://127.0.0.1:8080/v1' }, presets: [{ id: 'default', label: 'Configured repository checks', testCommand: 'npm test' }], routing: {}, apiDisabled: true },
    runs: [clone(fixtures.completedRun), clone(fixtures.interruptedRun), clone(fixtures.rejectedRun)],
  };
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    const path = url.replace(/^\/api\/v1/, '');
    state.calls.push({ method, path, body });
    if (failWith && failWith(method, path)) return failWith(method, path);
    if (path === '/health') return json(200, { ready: true, schema: 1 });
    if (path === '/session') return json(200, { authenticated: true });
    if (path === '/setup' && method === 'GET') return json(200, state.setup);
    if (path === '/setup/validate') return json(200, { valid: true });
    if (path === '/setup' && method === 'PUT') return json(200, state.setup);
    if (/^\/participants\/[\w-]+\/probe$/.test(path)) return json(200, { probeKind: body.kind });
    if (path === '/repositories' && method === 'GET') return json(200, { repositories: state.repositories });
    if (path === '/repositories') { const r = { id: 'repo-new', path: body.path, name: 'new', registeredAt: fixtures.completedRun.createdAt }; state.repositories.push(r); return json(201, r); }
    if (path.startsWith('/runs?') || path === '/runs' && method === 'GET') return json(200, { runs: state.runs, nextCursor: null });
    if (path === '/runs' && method === 'POST') return json(202, { ...clone(fixtures.runningRun), id: 'run-new' });
    const m = /^\/runs\/([\w-]+)(?:\/(review|cancel|resume|decisions)(?:\/([\w-]+))?)?$/.exec(path);
    if (m) {
      const [, , sub] = m;
      if (!sub && method === 'GET') return json(200, state.run);
      if (sub === 'review') return state.review ? json(200, state.review) : json(404, { error: { code: 'not-found', message: 'No review is available yet.', retryable: false, requestId: 'r' } });
      if (sub === 'cancel') { state.run = { ...state.run, status: 'cancelling', decision: null, activeDecisionId: null }; return json(202, { requested: true, status: 'cancelling' }); }
      if (sub === 'resume') { state.run = { ...state.run, status: 'running', resumable: false }; return json(202, state.run); }
      if (sub === 'decisions') {
        const d = state.run.decision;
        if (!d || d.id !== m[3] || body.expectedRevision !== d.revision || body.reviewedCommit !== d.evidence.commit) return json(409, clone(fixtures.staleDecision));
        state.run = { ...state.run, status: 'running', decision: null, activeDecisionId: null };
        return json(200, { accepted: true, decisionId: d.id });
      }
    }
    return json(404, { error: { code: 'not-found', message: 'Endpoint not found.', retryable: false, requestId: 'r' } });
  };
  return { state, fetchImpl, fixtures };
}

export { fixtures };
