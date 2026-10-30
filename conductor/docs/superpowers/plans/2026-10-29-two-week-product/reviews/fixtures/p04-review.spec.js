// Standalone review regressions, deliberately outside the ordinary UI/Node test globs.
import React from '../../../../../../operator-web/node_modules/react/index.js';
import { test, expect } from '../../../../../../operator-web/node_modules/vitest/dist/index.js';
import { render, screen, waitFor } from '../../../../../../operator-web/node_modules/@testing-library/react/dist/index.js';
import userEvent from '../../../../../../operator-web/node_modules/@testing-library/user-event/dist/esm/index.js';
import { RunView } from '../../../../../../operator-web/src/views/RunView.jsx';
import { createApi } from '../../../../../../operator-web/src/api.js';
import { fakeService, fixtures } from '../../../../../../operator-web/tests/fakeService.js';


test('P04-R1: approval stays disabled while the diff tail is inaccessible', async () => {
  const sentinel='+IMPORTANT_CHANGE_HIDDEN_IN_TAIL';
  const review={...structuredClone(fixtures.review),diff:'diff --git a/large.txt b/large.txt\n'+'+ordinary line\n'.repeat(30000)+sentinel+'\n'};
  expect(JSON.stringify(review).length).toBeLessThan(1024*1024);
  const svc=fakeService({review});
  render(React.createElement(RunView,{api:createApi({fetchImpl:svc.fetchImpl}),runId:svc.state.run.id,go:()=>{}}));
  const approve=await screen.findByRole('button',{name:'Approve: create a branch'});
  await waitFor(()=>expect(document.querySelector('.diff')?.textContent).toContain('more characters not shown here'));
  expect(document.querySelector('.diff').textContent).not.toContain(sentinel);
  expect(approve.disabled).toBe(true);
});

test('P04-R2: matching commit alone does not establish that the current test report was shown', async () => {
  const run=structuredClone(fixtures.awaitingResult);
  run.decision.evidence.testReportIds=['NEW_FAILED_TEST_REPORT'];
  run.decision.revision='new-evidence-revision';
  const svc=fakeService({run,review:structuredClone(fixtures.review)});
  render(React.createElement(RunView,{api:createApi({fetchImpl:svc.fetchImpl}),runId:run.id,go:()=>{}}));
  const approve=await screen.findByRole('button',{name:'Approve: create a branch'});
  await screen.findByText('Tests passed');
  expect(fixtures.review.testReportIds).not.toEqual(run.decision.evidence.testReportIds);
  expect(approve.disabled).toBe(true);
});

test('control: a complete same-evidence diff just below the UI limit remains reviewable', async () => {
  const sentinel='+VISIBLE_FINAL_CHANGE';
  const review={...structuredClone(fixtures.review),diff:'diff --git a/large.txt b/large.txt\n'+'+ordinary line\n'.repeat(25000)+sentinel+'\n'};
  expect(review.diff.length).toBeLessThan(400000);
  const svc=fakeService({review});
  render(React.createElement(RunView,{api:createApi({fetchImpl:svc.fetchImpl}),runId:svc.state.run.id,go:()=>{}}));
  const approve=await screen.findByRole('button',{name:'Approve: create a branch'});
  await waitFor(()=>expect(document.querySelector('.diff')?.textContent).toContain(sentinel));
  expect(approve.disabled).toBe(false);
});
