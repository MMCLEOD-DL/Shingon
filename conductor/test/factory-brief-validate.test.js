import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrief, validateBrief, cleanText, MODULES, LIMITS } from '../src/factory/brief.js';
import { validBrief, approvedBrief } from './helpers/briefFixtures.js';

const problems = (b, stage) => validateBrief(b, stage ? { stage } : undefined).problems;
const has = (b, re, stage) => {
  const p = problems(b, stage);
  assert.ok(p.some((m) => re.test(m)), JSON.stringify(p));
};
const withPolicy = (over) => validBrief({ policy: { ...validBrief().policy, ...over } });

test('the fixture is ready and, once stamped, approved', () => {
  assert.deepEqual(validateBrief(validBrief()), { ok: true, problems: [] });
  assert.deepEqual(validateBrief(approvedBrief(), { stage: 'approved' }), { ok: true, problems: [] });
  has(validBrief(), /has not been approved/, 'approved');
  assert.deepEqual(MODULES, ['ocr', 'pdf-export', 'xlsx-export', 'scheduled-jobs']);
});

test('cleanText strips control, escape and bidi characters, trims and clips', () => {
  assert.equal(cleanText('  \x1b[31mred\x1b[0m‮evil\u0007 ', 100), 'redevil');
  assert.equal(cleanText('line one\nline\ttwo', 100), 'line one\nline\ttwo');
  assert.equal(cleanText('abcdef', 4), 'abc…');
  assert.equal(cleanText(42, 10), undefined);
  assert.equal(cleanText('   ', 10), '');
});

test('normalizeBrief keeps known keys only, drops approval and meta, caps lists, never throws', () => {
  const raw = JSON.parse('{"__proto__": {"polluted": true}, "client": "\\u001b]0;pwn\\u0007Acme", "approvedAt": "2026-01-01T00:00:00Z", "approvedBy": "the model", "version": 9, "slug": "../x", "run": "rm -rf /", "features": "not a list"}');
  const b = normalizeBrief(raw);
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.hasOwn(b, '__proto__'), false);
  assert.equal(b.client, 'Acme');
  for (const k of ['approvedAt', 'approvedBy', 'version', 'slug', 'run', 'createdAt', 'revisedFrom']) assert.equal(Object.hasOwn(b, k), false, k);
  assert.equal(b.schema, 1);
  assert.equal(b.features, undefined, 'a wrong type is dropped so the validator reports it missing');
  const many = normalizeBrief({ features: Array.from({ length: 100 }, (_, i) => ({ id: `f${i}` })) });
  assert.equal(many.features.length, LIMITS.features);
  for (const bad of [null, 'text', 42, [], undefined]) assert.equal(typeof normalizeBrief(bad), 'object');
  const kept = normalizeBrief(validBrief());
  assert.deepEqual(kept, validBrief(), 'a clean brief survives normalisation unchanged');
  const fromApproved = normalizeBrief(approvedBrief());
  assert.equal(fromApproved.features[0].acceptance[0].id, undefined, 'example ids are Conductor\'s, never the model\'s');
  assert.equal(Object.hasOwn(fromApproved, 'exampleSeq'), false);
  assert.equal(normalizeBrief({ policy: { operatorAccess: 'yes' } }).policy.operatorAccess, undefined, 'only a real boolean is kept');
});

test('identity and kind', () => {
  has('nope', /The brief is not a JSON object/);
  has(validBrief({ schema: 2 }), /format this Conductor does not know \(schema 2; expected 1\)/);
  has(validBrief({ kind: 'game' }), /This brief is for "game", but the factory can only build web apps for now/);
  has(validBrief({ kind: undefined }), /does not say what kind of software it is/);
  has(validBrief({ client: '' }), /does not say who the client is/);
  has(validBrief({ purpose: 'An app.' }), /purpose is too short/);
});

test('roles, records and features cross-check each other', () => {
  const b = validBrief();
  has({ ...b, roles: [] }, /The brief has no roles/);
  has({ ...b, roles: [...b.roles, { ...b.roles[0] }] }, /Two roles are called "Staff"/);
  has({ ...b, roles: [{ ...b.roles[0], mapsTo: 'owner' }, ...b.roles.slice(1)] }, /Role "Staff": "mapsTo" must be admin, manager or member \(the foundation's fixed roles\), not "owner"/);
  has({ ...b, roles: b.roles.slice(0, 2) }, /No role maps to admin/);
  has({ ...b, roles: [{ ...b.roles[0], sees: '' }, ...b.roles.slice(1)] }, /Role "Staff" does not say what it may see/);
  has({ ...b, records: [] }, /The brief lists no records/);
  const f = b.features[0];
  has({ ...b, features: [] }, /The brief has no features/);
  has({ ...b, features: [{ ...f, id: 'Upload Receipt' }, b.features[1]] }, /Feature "Upload Receipt": its id must be lower-case words joined by hyphens/);
  has({ ...b, features: [f, { ...b.features[1], id: 'upload-receipt' }] }, /Two features have the id "upload-receipt"/);
  has({ ...b, features: [{ ...f, roles: ['Accounts'] }, b.features[1]] }, /Feature "upload-receipt" is used by "Accounts", which is not one of the roles/);
  has({ ...b, features: [{ ...f, data: ['Invoice'] }, b.features[1]] }, /Feature "upload-receipt" uses "Invoice", which is not one of the records/);
  has({ ...b, features: [{ ...f, acceptance: [] }, b.features[1]] }, /Feature "upload-receipt" has no worked examples/);
  has({ ...b, features: [{ ...f, acceptance: [{ given: 'a receipt is uploaded', when: 'the manager opens it', then: 'it works correctly' }] }, b.features[1]] }, /^Feature "upload-receipt", example 1: "works correctly" cannot be checked by a test/);
});

test('outputs, modules and integrations must agree with the policy', () => {
  const b = validBrief();
  has({ ...b, outputs: [{ ...b.outputs[0], format: 'pdf' }] }, /Output "Monthly expenses report" is a PDF, so the modules must include pdf-export/);
  has({ ...b, modules: ['ocr'] }, /Output "Monthly expenses report" is a spreadsheet, so the modules must include xlsx-export/);
  has({ ...b, outputs: [{ ...b.outputs[0], format: 'fax' }] }, /Output "Monthly expenses report": the format must be screen, pdf, xlsx, csv or email, not "fax"/);
  has({ ...b, modules: ['ocr', 'xlsx-export', 'payments'] }, /"payments" is not an optional module the foundation has \(ocr, pdf-export, xlsx-export, scheduled-jobs\)/);
  const reader = { name: 'Receipt reading', purpose: 'Read the amount and VAT from receipt photos', dataSent: 'Receipt images', service: 'azure-document-intelligence' };
  has({ ...b, integrations: [reader] }, /Integration "Receipt reading" sends data to Azure Document Intelligence, but the data policy does not allow it: add "azure-document-intelligence" to the policy's outside services, or drop the integration/);
  assert.deepEqual(problems({ ...b, integrations: [reader], policy: { ...b.policy, outbound: ['azure-document-intelligence'] } }), []);
  has({ ...b, integrations: [{ ...reader, service: 'xero' }] }, /Integration "Receipt reading": "service" must be one of the outside services Conductor knows \(cloudflare-tunnel, azure-document-intelligence\), not "xero"/);
  has({ ...b, integrations: [{ ...reader, service: undefined }] }, /Integration "Receipt reading": "service" must be one of the outside services Conductor knows \(cloudflare-tunnel, azure-document-intelligence\); the brief does not say/);
});

test('the data policy profile (spec §6)', () => {
  has(validBrief({ policy: undefined }), /The brief has no data policy/);
  has(withPolicy({ hosting: 'aws' }), /Hosting must be client-box \(the client's own computer\) or operator-server \(a server you run\), not "aws"/);
  has(withPolicy({ residency: 'us' }), /Data residency must be uk, uk-eu or any, not "us"/);
  has(withPolicy({ outbound: 'none' }), /"outbound" must be a list of the outside services data may go to \(an empty list means none\)/);
  has(withPolicy({ outbound: ['Cloudflare'] }), /"Cloudflare" is not an outside service Conductor knows \(known: cloudflare-tunnel, azure-document-intelligence\)/);
  assert.deepEqual(problems(withPolicy({ outbound: ['cloudflare-tunnel'] })), []);
  has(withPolicy({ retention: { text: '', days: null } }), /does not say how long records are kept/);
  has(withPolicy({ retention: { text: 'six years', days: 0 } }), /retention days must be a whole number from 1 to 36500, or null when not known/);
  has(withPolicy({ backupDestination: { kind: 'usb', detail: 'x' } }), /backup destination must be client-owned, operator-run or cloud-bucket, not "usb"/);
  has(withPolicy({ operatorAccess: false }), /The client has not accepted your remote access for support \(operatorAccess must be true\)\. The factory cannot take on a job without it\./);
  has(withPolicy({ backupDestination: { kind: 'cloud-bucket', detail: 's3://backup:Sup3rSecretPass@bucket.example' } }), /seems to contain a password or key \(at policy → backupDestination → detail\)\. Briefs must never hold credentials: remove it/);
  has(validBrief({ assumptions: ['The admin password: hunter2hunter2'] }), /seems to contain a password or key \(at assumptions → 1\)/);
});

test('stages: draft tolerates unknowns only while questions are open', () => {
  const q = [{ id: 'q1', question: 'Where should backups go?', why: 'Backups must never stay only on the same box' }];
  const unknownPolicy = withPolicy({ hosting: null, backupDestination: null });
  const unknownExamples = validBrief({ features: validBrief().features.map((f) => ({ ...f, acceptance: [] })) });
  assert.deepEqual(problems({ ...unknownPolicy, openQuestions: q }, 'draft'), []);
  assert.deepEqual(problems({ ...unknownExamples, openQuestions: q }, 'draft'), []);
  has(unknownPolicy, /Hosting must be/, 'draft'); // no open questions → nothing excuses the gap
  has({ ...validBrief(), openQuestions: q }, /There is still 1 open question; the brief can't be approved until it is answered/);
  has({ ...validBrief(), openQuestions: [...q, { ...q[0], id: 'q2' }] }, /There are still 2 open questions/);
  has({ ...validBrief({ features: [{ ...validBrief().features[0], acceptance: [{ given: 'x', when: 'y', then: 'z' }] }] }), openQuestions: q }, /example 1/, 'draft');
  has(approvedBrief({ approvedAt: 'yesterday' }), /has not been approved/, 'approved');
  has(approvedBrief({ version: 0 }), /version number/, 'approved');
  has(approvedBrief({ features: validBrief().features }), /Feature "upload-receipt", example 1 has no valid id \(Conductor numbers examples when the brief is approved\)/, 'approved');
  has(approvedBrief({ exampleSeq: { 'upload-receipt': 1 } }), /Feature "monthly-report", example 1 has no valid id/, 'approved'); // n above the counter
  const twice = approvedBrief();
  twice.features[1] = { ...twice.features[1], acceptance: [...twice.features[1].acceptance, { ...twice.features[1].acceptance[0] }] };
  has({ ...twice, exampleSeq: { 'upload-receipt': 1, 'monthly-report': 2 } }, /Two worked examples have the id "monthly-report#1"/, 'approved');
  assert.deepEqual(problems(approvedBrief({ features: validBrief().features })), [], 'ids are only required at the approved stage');
  assert.throws(() => validateBrief(validBrief(), { stage: 'final' }), /stage must be draft, ready or approved/);
});
