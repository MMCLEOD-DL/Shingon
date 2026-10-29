import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exampleProblems, EXAMPLE_RULES_TEXT, assignExampleIds, acceptanceIds, testTag, EXAMPLE_ID_RE } from '../src/factory/acceptance.js';
import { OUTBOUND_SERVICES, outboundProblems } from '../src/factory/outbound.js';

const W = 'Feature "x", example 1';
const ok = (ex) => assert.deepEqual(exampleProblems(ex, W), [], JSON.stringify(ex));
const bad = (ex, re) => {
  const p = exampleProblems(ex, W);
  assert.ok(p.some((m) => re.test(m)), `${JSON.stringify(ex)} → ${JSON.stringify(p)}`);
  assert.ok(p.every((m) => m.startsWith(`${W}: `)));
};

test('concrete examples pass', () => {
  ok({ given: 'a member uploads a £12.40 receipt with £2.07 VAT dated 3 March 2026, category Travel', when: 'the manager opens the March report', then: 'the receipt appears under Travel with net £10.33 and VAT £2.07' });
  ok({ given: 'Alice and Bob are both Staff', when: "Alice opens the address of one of Bob's claims", then: 'she sees the message “You can’t see this claim” and none of his details' });
  ok({ given: 'Finance is signed in', when: 'she exports the March 2026 claims', then: 'the file is called "expenses-2026-03.xlsx"' });
  ok({ given: 'a claim was rejected by the manager', when: 'the member opens it', then: 'it is marked Rejected with the reason the manager typed' });
  ok({ given: 'a claim is waiting for approval', when: 'the manager approves it on a Friday', then: 'friday payroll includes it' }); // weekday anchor, any case
});

test('the parts must all be there, long enough, and free of placeholders', () => {
  bad({ given: 'a receipt', then: 'the total shows £5.00' }, /needs "given", "when" and "then"/);
  bad(null, /needs "given", "when" and "then"/);
  bad({ given: 'x', when: 'the manager looks', then: 'the total shows £5.00' }, /the "given" part is too short to check \("x"\)/);
  bad({ given: 'a receipt, a mileage claim etc.', when: 'the manager looks', then: 'the total shows £5.00' }, /the "given" part still has a placeholder \("etc"\)/);
  bad({ given: 'a receipt for TBD pounds', when: 'the manager looks', then: 'the total shows £5.00' }, /placeholder \("TBD"\)/);
  bad({ given: 'a receipt is uploaded', when: 'the manager looks…', then: 'the total shows £5.00' }, /the "when" part still has a placeholder/);
  bad({ given: 'a receipt is uploaded', when: 'the manager looks', then: 'x'.repeat(601) }, /the "then" part is too long/);
});

test('the result must say exactly what happens', () => {
  bad({ given: 'a receipt is uploaded', when: 'the manager opens the report', then: 'the totals are right' }, /the result \("then …"\) does not say exactly what should happen\. Give a figure, a name, a date or the exact words shown/);
  bad({ given: 'a receipt is uploaded', when: 'the manager opens the report', then: 'the report works correctly' }, /"works correctly" cannot be checked by a test\. Say what the person sees or what number comes out/);
  bad({ given: 'Bob uploads a receipt', when: 'the manager opens the report', then: 'it is shown to Bob as expected' }, /"as expected" cannot be checked by a test/);
  bad({ given: 'a receipt is uploaded', when: 'the manager opens it', then: 'the receipt is handled. It is saved' }, /does not say exactly what should happen/); // "It" starts a sentence: not a name
});

test('the rules text the author sees names every rule', () => {
  for (const s of ['given', 'when', 'then', 'placeholder', 'a figure, a name, a date or the exact words', 'works correctly', '£12.40']) {
    assert.ok(EXAMPLE_RULES_TEXT.includes(s), s);
  }
});

// Example ids (Contract 7 §7.4). The briefs here carry only what assignExampleIds reads.
const A = { given: 'Alice is signed in as Staff', when: 'she uploads a £12.40 receipt dated 3 March 2026', then: 'her list shows Travel £12.40' };
const B = { given: 'Bob is signed in as Staff', when: 'he uploads a £5.00 parking receipt', then: 'his list shows Parking £5.00' };
const C = { given: "Alice's £12.40 claim was approved in March 2026", when: 'Finance downloads the March report', then: 'the Travel row shows £12.40' };
const C2 = { ...C, then: 'the Travel row shows net £10.33 and VAT £2.07' };
const D = { given: 'Alice is signed in as Staff', when: 'she uploads a receipt with no amount', then: 'she sees "Please enter the amount"' };
const briefOf = (map) => ({ features: Object.entries(map).map(([id, acceptance]) => ({ id, title: `Title of ${id}`, acceptance })) });
const ids = (b) => b.features.flatMap((f) => f.acceptance.map((e) => e.id));

test('example ids: assigned at approval, kept on revision, an n is never reused', () => {
  const draft = briefOf({ 'upload-receipt': [A, B], 'monthly-report': [C] });
  const v1 = assignExampleIds(draft);
  assert.deepEqual(ids(v1), ['upload-receipt#1', 'upload-receipt#2', 'monthly-report#1']);
  assert.deepEqual(v1.exampleSeq, { 'upload-receipt': 2, 'monthly-report': 1 });
  assert.equal(draft.features[0].acceptance[0].id, undefined, 'pure: the input is not changed');

  // Revision: B removed, A unchanged (moved after a new D, extra spaces ignored), C reworded.
  const v2 = assignExampleIds(briefOf({ 'upload-receipt': [D, { ...A, when: `  ${A.when}  ` }], 'monthly-report': [C2] }), v1);
  assert.deepEqual(ids(v2), ['upload-receipt#3', 'upload-receipt#1', 'monthly-report#2']);
  assert.deepEqual(v2.exampleSeq, { 'upload-receipt': 3, 'monthly-report': 2 });

  // B comes back: it is new to v2, so it takes #4, never #2 again. A feature dropped and re-added keeps counting.
  const v3 = assignExampleIds(briefOf({ 'upload-receipt': [A, B] }), v2);
  assert.deepEqual(ids(v3), ['upload-receipt#1', 'upload-receipt#4']);
  assert.deepEqual(v3.exampleSeq, { 'upload-receipt': 4, 'monthly-report': 2 });
  const v4 = assignExampleIds(briefOf({ 'upload-receipt': [A], 'monthly-report': [C2] }), v3);
  assert.deepEqual(ids(v4), ['upload-receipt#1', 'monthly-report#3']);

  // Ids a model sneaks in are ignored: Conductor numbers examples itself.
  assert.deepEqual(ids(assignExampleIds(briefOf({ 'upload-receipt': [{ ...A, id: 'upload-receipt#99' }] }))), ['upload-receipt#1']);
});

test('acceptanceIds and testTag read the stored ids', () => {
  const v1 = assignExampleIds(briefOf({ 'upload-receipt': [A, B], 'monthly-report': [C] }));
  assert.deepEqual(acceptanceIds(v1)[2], { id: 'monthly-report#1', featureId: 'monthly-report', n: 1, title: 'Title of monthly-report', example: { given: C.given, when: C.when, then: C.then } });
  assert.deepEqual(acceptanceIds(v1).map((a) => a.id), ['upload-receipt#1', 'upload-receipt#2', 'monthly-report#1']);
  assert.throws(() => acceptanceIds(briefOf({ 'upload-receipt': [A] })), /Feature "upload-receipt", example 1 has no valid id; only an approved brief carries example ids/);
  assert.equal(testTag('upload-receipt#2'), '[upload-receipt#2]');
  assert.throws(() => testTag('upload receipt'), /testTag: "upload receipt" is not an example id/);
  assert.ok(EXAMPLE_ID_RE.test('monthly-report#12') && !EXAMPLE_ID_RE.test('monthly-report#0'));
});

test('outside services: a fixed list of ids; unknown ids are refused', () => {
  assert.deepEqual(Object.keys(OUTBOUND_SERVICES), ['cloudflare-tunnel', 'azure-document-intelligence']);
  assert.deepEqual(OUTBOUND_SERVICES['cloudflare-tunnel'].hosts, ['*.cloudflare.com', '*.argotunnel.com']);
  assert.deepEqual(OUTBOUND_SERVICES['azure-document-intelligence'].hosts, ['*.cognitiveservices.azure.com']);
  for (const s of Object.values(OUTBOUND_SERVICES)) assert.ok(s.label && s.carries, JSON.stringify(s));
  assert.ok(Object.isFrozen(OUTBOUND_SERVICES) && Object.isFrozen(OUTBOUND_SERVICES['cloudflare-tunnel']));
  assert.deepEqual(outboundProblems([]), []);
  assert.deepEqual(outboundProblems(['cloudflare-tunnel', 'azure-document-intelligence']), []);
  assert.match(outboundProblems('none')[0], /"outbound" must be a list of the outside services data may go to \(an empty list means none\)/);
  assert.match(outboundProblems(['Xero'])[0], /"Xero" is not an outside service Conductor knows \(known: cloudflare-tunnel, azure-document-intelligence\)/);
  assert.match(outboundProblems(['cloudflare-tunnel', 'cloudflare-tunnel'])[0], /"cloudflare-tunnel" is listed twice/);
  assert.match(outboundProblems([42])[0], /42 is not an outside service Conductor knows/);
});
