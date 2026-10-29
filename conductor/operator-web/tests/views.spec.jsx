import { describe, test, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../src/App.jsx';
import { RunView } from '../src/views/RunView.jsx';
import { Setup } from '../src/views/Setup.jsx';
import { History } from '../src/views/History.jsx';
import { NewTask } from '../src/views/NewTask.jsx';
import { createApi } from '../src/api.js';
import { fakeService, fixtures } from './fakeService.js';
import { FakeEventSource } from './setup.js';

const withRun = (run, opts = {}) => {
  const svc = fakeService({ run, ...opts });
  const api = createApi({ fetchImpl: svc.fetchImpl });
  const go = (p) => svc.state.calls.push({ method: 'NAV', path: p });
  return { svc, api, go };
};
const showRun = (run, opts) => { const ctx = withRun(run, opts); render(<RunView api={ctx.api} runId={run.id} go={ctx.go} />); return ctx; };

describe('run states from the contract fixtures', () => {
  test.each([
    ['runningRun', 'Working'], ['pausedRun', 'Paused'], ['interruptedRun', 'Interrupted'],
    ['failedRun', 'Failed'], ['rejectedRun', 'Rejected — no branch created'], ['completedRun', 'Branch created'],
  ])('%s shows "%s"', async (key, text) => {
    showRun(fixtures[key]);
    expect(await screen.findByText(text)).toBeTruthy();
  });

  test('a completed run names its branch and says nothing was merged or deployed', async () => {
    showRun(fixtures.completedRun);
    expect(await screen.findByText(/was created in the repository\. Nothing was merged, pushed or deployed\./)).toBeTruthy();
    expect(screen.getByText(fixtures.completedRun.landedBranch)).toBeTruthy();
  });

  test('a rejected run never mentions a landed branch', async () => {
    showRun(fixtures.rejectedRun);
    await screen.findByText(/No branch was created/);
    expect(screen.queryByText(/was created in the repository/)).toBeNull();
  });

  test('resume is offered only for a resumable interrupted, paused or failed run, and calls the service', async () => {
    const { svc } = showRun({ ...fixtures.interruptedRun, resumable: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    expect(svc.state.calls.some((c) => c.method === 'POST' && c.path.endsWith('/resume'))).toBe(true);
    expect(await screen.findByText(/Earlier answers do not carry over/)).toBeTruthy();
  });
  test('no resume button for a completed run', async () => {
    showRun(fixtures.completedRun);
    await screen.findByText('Branch created');
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  test('weakened review coverage is shown with its reasons', async () => {
    showRun({ ...fixtures.runningRun, coverage: { local: 'used', vendors: ['anthropic'], weakened: true, reasons: ['Only one vendor reviewed.'] } });
    expect(await screen.findByText('Review coverage is weaker than planned.')).toBeTruthy();
    expect(screen.getByText('Only one vendor reviewed.')).toBeTruthy();
  });
});

describe('result decision', () => {
  test('approve is unavailable until the exact reviewed evidence is shown, then sends revision, commit and a request id once', async () => {
    const { svc } = showRun(fixtures.awaitingResult);
    const approve = await screen.findByRole('button', { name: 'Approve: create a branch' });
    await waitFor(() => expect(approve.disabled).toBe(false));
    expect(screen.getByText('Tests passed')).toBeTruthy();
    expect(screen.getByText(/Nothing is merged, pushed or deployed/)).toBeTruthy();
    await userEvent.click(approve);
    const answers = svc.state.calls.filter((c) => c.path.includes('/decisions/'));
    expect(answers).toHaveLength(1);
    expect(answers[0].body).toMatchObject({ choiceId: 'approve', expectedRevision: fixtures.awaitingResult.decision.revision, reviewedCommit: fixtures.awaitingResult.decision.evidence.commit });
    expect(answers[0].body.clientRequestId).toMatch(/^[\w-]{1,80}$/);
    expect(await screen.findByText(/Answer saved\. Waiting for Conductor to continue — this does not yet mean the work is finished\./)).toBeTruthy();
  });

  test('a review for a different commit keeps approval disabled', async () => {
    showRun(fixtures.awaitingResult, { review: { ...fixtures.review, commit: 'b'.repeat(40) } });
    const approve = await screen.findByRole('button', { name: 'Approve: create a branch' });
    await screen.findByText(/Approval stays unavailable until they are shown/);
    expect(approve.disabled).toBe(true);
  });

  test('a stale decision is refused, explained, and the run is reloaded', async () => {
    const stale = { ...fixtures.awaitingResult, decision: { ...fixtures.awaitingResult.decision, revision: 'changed-underneath' } };
    const { svc } = showRun(stale, { failWith: (m, p) => (p.includes('/decisions/') ? { ok: false, status: 409, json: async () => fixtures.staleDecision } : null) });
    const approve = await screen.findByRole('button', { name: 'Approve: create a branch' });
    await waitFor(() => expect(approve.disabled).toBe(false));
    const before = svc.state.calls.filter((c) => c.method === 'GET' && /^\/runs\/[\w-]+$/.test(c.path)).length;
    await userEvent.click(approve);
    expect(await screen.findByText(fixtures.staleDecision.error.message)).toBeTruthy();
    expect(screen.getByText(/This question changed or was already answered/)).toBeTruthy();
    await waitFor(() => expect(svc.state.calls.filter((c) => c.method === 'GET' && /^\/runs\/[\w-]+$/.test(c.path)).length).toBeGreaterThan(before));
    expect(screen.queryByText(/Answer saved/)).toBeNull();
  });

  test.each([['failedChecks', 'Tests failed (exit code'], ['unrunChecks', 'Tests were not run']])('%s never look green', async (key, title) => {
    showRun(fixtures.awaitingResult, { review: { ...fixtures.review, tests: fixtures[key] } });
    const heading = await screen.findByText(new RegExp(title.replace(/[()]/g, '\\$&')));
    const box = heading.closest('section');
    expect(box.className).not.toContain('checks-passed');
    expect(within(box).getByText(/Approving now would land work whose checks are not known to pass/)).toBeTruthy();
  });

  test('a missing test report is shown as missing, not passed', async () => {
    showRun(fixtures.awaitingResult, { review: { ...fixtures.review, tests: undefined } });
    expect(await screen.findByText('No test report was provided')).toBeTruthy();
  });

  test('malicious model text is shown literally and never becomes markup or a link', async () => {
    const run = { ...fixtures.awaitingResult, decision: { ...fixtures.awaitingResult.decision, prompt: fixtures.maliciousContent.summary + ' <img src=x onerror=alert(1)>' } };
    const { container } = render(<RunView api={withRun(run, { review: { ...fixtures.review, diff: fixtures.maliciousContent.diff, files: ['<b>x</b>.js'] } }).api} runId={run.id} go={() => {}} />);
    expect(await screen.findByText('+<script>window.evil()</script>')).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect([...container.querySelectorAll('a')].some((a) => /^javascript:/i.test(a.getAttribute('href') ?? ''))).toBe(false);
    expect(screen.getByText('<b>x</b>.js')).toBeTruthy();
  });

  test('focus moves to a newly pending question', async () => {
    showRun(fixtures.awaitingResult);
    const heading = await screen.findByRole('heading', { name: 'Review the finished work' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });
});

describe('other decision kinds use their own choices', () => {
  test.each([
    ['escalationDecision', 'The models disagree: your call', 'approve'],
    ['planDecision', 'Approve the plan', 'approve'],
    ['chunkDecision', 'Approve the next coding step', 'approve'],
    ['fallbackDecision', 'The local model is unavailable', 'continue'],
  ])('%s', async (key, title, choiceId) => {
    const run = { ...fixtures.runningRun, status: 'awaiting-decision', activeDecisionId: fixtures[key].id, decision: fixtures[key] };
    const { svc } = showRun(run);
    expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
    const label = fixtures[key].choices.find((c) => c.id === choiceId).label;
    await userEvent.click(screen.getByRole('button', { name: label }));
    const sent = svc.state.calls.find((c) => c.path.includes('/decisions/'));
    expect(sent.body).toMatchObject({ choiceId, reviewedCommit: null, expectedRevision: fixtures[key].revision });
  });
  test('fallback explains it uses subscriptions and never paid APIs', async () => {
    showRun({ ...fixtures.runningRun, status: 'awaiting-decision', decision: fixtures.fallbackDecision });
    expect(await screen.findByText(/never switches to paid API keys/)).toBeTruthy();
  });
});

describe('live progress', () => {
  test('a lost connection says reconnecting and does not change the run state shown', async () => {
    showRun(fixtures.runningRun);
    await screen.findByText('Working');
    const es = FakeEventSource.all[0];
    es.open();
    await es.fail();
    expect(await screen.findByText(/Connection lost — reconnecting\. The run itself is unaffected/)).toBeTruthy();
    expect(screen.getByText('Working')).toBeTruthy();
  });
  test('progress events appear once each in the activity log', async () => {
    showRun(fixtures.runningRun);
    await screen.findByText('Working');
    const es = FakeEventSource.all[0];
    for (const e of [...fixtures.events.slice(0, 1), ...fixtures.events.slice(0, 1)]) es.emit(e);
    expect(await screen.findByText('Activity log (1)')).toBeTruthy();
  });
});

test('cancel asks first, then reports a request rather than a confirmed stop', async () => {
  const { svc } = showRun(fixtures.runningRun);
  await userEvent.click(await screen.findByRole('button', { name: 'Stop run…' }));
  expect(svc.state.calls.some((c) => c.path.endsWith('/cancel'))).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: 'Yes, stop this run' }));
  expect(svc.state.calls.filter((c) => c.path.endsWith('/cancel'))).toHaveLength(1);
  expect(await screen.findByText(/Stop requested\. Conductor will show "Interrupted" once the worker has actually stopped\./)).toBeTruthy();
  expect(await screen.findByText('Stopping (not yet confirmed)')).toBeTruthy();
});

describe('setup', () => {
  test('nothing is called verified without a check; probes that use allowance say so; no secret fields', async () => {
    const svc = fakeService();
    render(<Setup api={createApi({ fetchImpl: svc.fetchImpl })} />);
    expect((await screen.findAllByText('not checked')).length).toBeGreaterThan(0);
    expect(screen.queryByText('verified')).toBeNull();
    expect(screen.getByText(/This uses a little of your subscription allowance/)).toBeTruthy();
    expect(document.querySelector('input[type=password]')).toBeNull();
    expect(screen.getByText(/never asks for passwords, tokens or API keys/)).toBeTruthy();
  });
  test('saving validates first, then saves only the local model settings', async () => {
    const svc = fakeService();
    render(<Setup api={createApi({ fetchImpl: svc.fetchImpl })} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Save local model' }));
    const writes = svc.state.calls.filter((c) => c.path.startsWith('/setup') && c.method !== 'GET');
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /setup/validate', 'PUT /setup']);
    expect(Object.keys(writes[1].body)).toEqual(['local']);
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });
  test('a probe calls the explicit probe endpoint with its kind', async () => {
    const svc = fakeService();
    render(<Setup api={createApi({ fetchImpl: svc.fetchImpl })} />);
    await userEvent.click((await screen.findAllByRole('button', { name: 'Check sign-in' }))[0]);
    expect(svc.state.calls.find((c) => c.path.endsWith('/probe')).body).toEqual({ kind: 'authenticated' });
  });
});

test('new task: one click, one run, with the default preset and a request id', async () => {
  const svc = fakeService();
  const went = [];
  render(<NewTask api={createApi({ fetchImpl: svc.fetchImpl })} go={(p) => went.push(p)} />);
  await screen.findByRole('combobox');
  await userEvent.type(screen.getByLabelText(/Describe the change/), 'Add a doubled() helper');
  await userEvent.click(screen.getByRole('button', { name: 'Start' }));
  const posts = svc.state.calls.filter((c) => c.method === 'POST' && c.path === '/runs');
  expect(posts).toHaveLength(1);
  expect(posts[0].body).toMatchObject({ repositoryId: 'repo-fixture', request: 'Add a doubled() helper', presetId: 'default' });
  expect(went).toEqual(['/runs/run-new']);
});

test('new task: adding a repository needs an explicit confirmation of the access granted', async () => {
  const svc = fakeService();
  render(<NewTask api={createApi({ fetchImpl: svc.fetchImpl })} go={() => {}} />);
  await userEvent.type(await screen.findByLabelText(/Full path/), '/home/me/project');
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(svc.state.calls.some((c) => c.method === 'POST' && c.path === '/repositories')).toBe(false);
  expect(screen.getByText(/create new branches in it\. It never merges or pushes/)).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Add repository' }));
  expect(svc.state.calls.find((c) => c.method === 'POST' && c.path === '/repositories').body).toEqual({ path: '/home/me/project' });
});

test('history lists runs and offers resume only where the service says resumable', async () => {
  const svc = fakeService();
  render(<History api={createApi({ fetchImpl: svc.fetchImpl })} go={() => {}} />);
  expect(await screen.findByText('Branch created')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Resume' })).toHaveLength(svc.state.runs.filter((r) => r.resumable && ['interrupted', 'paused', 'failed'].includes(r.status)).length);
});

test('without a session the app explains how to sign in instead of simulating anything', async () => {
  const svc = fakeService({ failWith: (m, p) => (p === '/health' ? { ok: false, status: 401, json: async () => ({ error: { code: 'unauthorized', message: 'Open the app using its local bootstrap link.', retryable: false, requestId: 'r' } }) } : null) });
  render(<App api={createApi({ fetchImpl: svc.fetchImpl })} />);
  expect(await screen.findByText(/Open the link the Conductor app printed when it started/)).toBeTruthy();
  expect(screen.queryByText(/Simulated/)).toBeNull();
});

test('approved landing cannot be cancelled through the UI', async () => {
  showRun(fixtures.landingRun);
  expect(await screen.findByText(/Adding the approved result to the repository/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Stop run…' })).toBeNull();
});
test('uncertain landing explains repository inspection instead of offering resume', async () => {
  showRun(fixtures.uncertainLandingRun);
  expect(await screen.findByText(/The approved result may already be in the repository/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  expect(screen.queryByText(/It has no saved work to resume/)).toBeNull();
});

test('after an approval is accepted, neither the old question nor Stop is offered while the snapshot is still the pre-answer one', async () => {
  // The service keeps returning the pre-answer snapshot (as an in-flight refresh would): the UI must not resurrect it.
  const frozen = fixtures.awaitingResult;
  const svc = fakeService({ run: frozen });
  const base = svc.fetchImpl;
  const fetchImpl = async (url, init = {}) => {
    const r = await base(url, init);
    if (/\/runs\/[\w-]+$/.test(url) && (init.method ?? 'GET') === 'GET') return { ok: true, status: 200, json: async () => frozen };
    return r;
  };
  render(<RunView api={createApi({ fetchImpl })} runId={frozen.id} go={() => {}} />);
  const approve = await screen.findByRole('button', { name: 'Approve: create a branch' });
  await waitFor(() => expect(approve.disabled).toBe(false));
  await userEvent.click(approve);
  await screen.findByText(/Answer saved/);
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByRole('button', { name: 'Approve: create a branch' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Stop run…' })).toBeNull();
});
