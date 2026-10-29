import { describe, test, expect, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createApi, ApiError, bootstrapFromFragment } from '../src/api.js';
import { applyEvents, followRun, STREAM } from '../src/events.js';
import { plain } from '../src/text.js';
import { FakeEventSource } from './setup.js';

const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });

describe('api client', () => {
  test('service errors keep their code, message and request id; unknown codes stay errors', async () => {
    const api = createApi({ fetchImpl: async () => reply(409, { error: { code: 'stale-decision', message: 'Review the current evidence first.', retryable: false, requestId: 'req-1' } }) });
    await expect(api.run('r1')).rejects.toMatchObject({ status: 409, code: 'stale-decision', message: 'Review the current evidence first.', requestId: 'req-1' });
    const odd = createApi({ fetchImpl: async () => reply(500, { surprise: true }) });
    await expect(odd.run('r1')).rejects.toBeInstanceOf(ApiError);
    await expect(odd.run('r1')).rejects.toMatchObject({ code: 'unknown' });
  });

  test('a non-JSON success is not treated as success', async () => {
    const api = createApi({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('html'); } }) });
    await expect(api.health()).rejects.toMatchObject({ code: 'bad-response' });
  });

  test('an unreachable service is reported as such, not as a failed run', async () => {
    const api = createApi({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    await expect(api.runs()).rejects.toMatchObject({ status: 0, code: 'unreachable' });
  });

  test('requests are same-origin and carry the exact contract fields', async () => {
    const seen = [];
    const api = createApi({ fetchImpl: async (url, init) => { seen.push({ url, init }); return reply(200, { accepted: true }); } });
    await api.answer('run-1', 'd-1', { choiceId: 'approve', expectedRevision: 'rev', reviewedCommit: null, clientRequestId: 'c1' });
    expect(seen[0].url).toBe('/api/v1/runs/run-1/decisions/d-1');
    expect(seen[0].init.credentials).toBe('same-origin');
    expect(JSON.parse(seen[0].init.body)).toEqual({ choiceId: 'approve', expectedRevision: 'rev', reviewedCommit: null, clientRequestId: 'c1' });
    await api.recover('run-1', { clientRequestId: 'c2', repositoryInspected: true, expectedEventSeq: 7, reviewedCommit: 'a'.repeat(40) });
    expect(seen[1].url).toBe('/api/v1/runs/run-1/recover');
    expect(seen[1].init.method).toBe('POST');
    expect(JSON.parse(seen[1].init.body)).toEqual({ clientRequestId: 'c2', repositoryInspected: true, expectedEventSeq: 7, reviewedCommit: 'a'.repeat(40) });
  });

  test('bootstrap: the fragment is removed from the address bar before the token is sent, and never stored', async () => {
    const order = [];
    const location = { hash: '#bootstrap=secret-token', pathname: '/', search: '' };
    const history = { replaceState: (...a) => order.push(['replace', a[2]]) };
    const api = { signIn: async (t) => { order.push(['signIn', t]); } };
    expect(await bootstrapFromFragment(api, { location, history })).toBe('signed-in');
    expect(order).toEqual([['replace', '/'], ['signIn', 'secret-token']]);
    expect(JSON.stringify(window.localStorage)).not.toContain('secret-token');
    expect(JSON.stringify(window.sessionStorage)).not.toContain('secret-token');
    expect(await bootstrapFromFragment(api, { location: { hash: '', pathname: '/', search: '' }, history })).toBe('none');
  });
});

describe('event stream', () => {
  test('events are applied in order and once, whatever the delivery', () => {
    const e = (seq) => ({ seq, message: `m${seq}` });
    let list = applyEvents([], [e(2), e(1)]);
    list = applyEvents(list, [e(2), e(3), e(1)]);
    expect(list.map((x) => x.seq)).toEqual([1, 2, 3]);
    const same = applyEvents(list, [e(3)]);
    expect(same).toBe(list);
  });

  test('a lost stream reconnects from the largest applied sequence, and a refused cursor asks for a resync', async () => {
    const states = []; const got = []; let timer;
    const onResync = vi.fn();
    let cursorOk = true;
    const f = followRun('run-1', {
      after: 0, onEvent: (e) => got.push(e.seq), onState: (s) => states.push(s), onResync,
      checkCursor: async () => cursorOk, setTimer: (fn) => { timer = fn; return 1; }, clearTimer: () => {},
    });
    const first = FakeEventSource.all[0];
    expect(first.url).toBe('/api/v1/runs/run-1/events?after=0');
    first.open(); first.emit({ seq: 1 }); first.emit({ seq: 2 }); first.emit({ seq: 2 });
    expect(got).toEqual([1, 2]);
    await first.fail();
    expect(states).toContain(STREAM.reconnecting);
    expect(first.closed).toBe(true);
    timer();
    expect(FakeEventSource.all[1].url).toBe('/api/v1/runs/run-1/events?after=2');
    cursorOk = false;
    await FakeEventSource.all[1].fail();
    expect(onResync).toHaveBeenCalledOnce();
    expect(states.at(-1)).toBe(STREAM.resync);
    f.close();
  });
});

test('untrusted text loses terminal escapes, control and bidi characters', () => {
  expect(plain('\x1b[31mred\x1b[0m ‮evil\u0007')).toBe('red evil');
});

test('the copied contract fixture matches the service branch fixture when both are present', () => {
  const canonical = new URL('../../test/fixtures/operator-app/contract-v1.json', import.meta.url);
  const copy = new URL('./fixtures/contract-v1.json', import.meta.url);
  if (!existsSync(canonical)) return; // before integration the fixture lives only on codex/operator-app-v1 @ a8c97bc
  expect(readFileSync(copy, 'utf8')).toBe(readFileSync(canonical, 'utf8'));
});
