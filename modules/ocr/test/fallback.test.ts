import { expect, test } from 'vitest';
import { CloudEngineError, UnreadableError, withFallback, type OcrEngine } from '../src/index.js';
import { fakeEngine } from './helpers/fakeEngine.js';

const bytes = Buffer.from('a fictional receipt');
const FELL_BACK = 'The cloud reader was unavailable, so this receipt was read on the box instead.';

const failing = (err: Error): OcrEngine & { tries: number } => {
  const e = { ...fakeEngine('azure-document-intelligence', 'cloud'), tries: 0 };
  e.read = () => {
    e.tries += 1;
    return Promise.reject(err);
  };
  return e;
};

test('a cloud failure falls back to local and says so', async () => {
  const cloud = failing(new CloudEngineError('http-500'));
  const local = fakeEngine('local-tesseract', 'local');
  const r = await withFallback(cloud, local).read({ bytes, type: 'image/jpeg' });
  expect(r.engine).toBe('local-tesseract');
  expect(r.warnings).toEqual([FELL_BACK]);
  expect(cloud.tries).toBe(1);
  expect(local.calls).toHaveLength(1);
});

test('an unreadable file is not retried elsewhere', async () => {
  const unreadable = new UnreadableError("This picture couldn't be opened. Please type the details.");
  const cloud = failing(unreadable);
  const local = fakeEngine('local-tesseract', 'local');
  await expect(withFallback(cloud, local).read({ bytes, type: 'image/jpeg' })).rejects.toBe(unreadable);
  expect(local.calls).toHaveLength(0);
});

test('any other failure is not hidden by the fallback', async () => {
  const bug = new TypeError('a bug');
  const local = fakeEngine('local-tesseract', 'local');
  await expect(withFallback(failing(bug), local).read({ bytes, type: 'image/jpeg' })).rejects.toBe(bug);
  expect(local.calls).toHaveLength(0);
});

test('a working cloud reader is used, and nothing is read twice', async () => {
  const cloud = fakeEngine('azure-document-intelligence', 'cloud');
  const local = fakeEngine('local-tesseract', 'local');
  const r = await withFallback(cloud, local).read({ bytes, type: 'application/pdf' });
  expect(r.engine).toBe('azure-document-intelligence');
  expect(r.warnings).toEqual([]);
  expect(cloud.calls).toHaveLength(1);
  expect(local.calls).toHaveLength(0);
});

test('the fallback only ever goes from cloud to local', () => {
  const local = fakeEngine('local-tesseract', 'local');
  const cloud = fakeEngine('azure-document-intelligence', 'cloud');
  expect(() => withFallback(local, cloud)).toThrow('A fallback must keep receipts on the box.');
  expect(() => withFallback(cloud, fakeEngine('other-cloud', 'cloud'))).toThrow('A fallback must keep receipts on the box.');
  expect(() => withFallback(cloud, { ...local, outboundId: 'somewhere' })).toThrow('A fallback must keep receipts on the box.');
});

test("the wrapper carries the primary's identity, and closing it closes both", async () => {
  const cloud = fakeEngine('azure-document-intelligence', 'cloud');
  const local = fakeEngine('local-tesseract', 'local');
  const e = withFallback(cloud, local);
  expect(e).toMatchObject({ id: 'azure-document-intelligence', kind: 'cloud', outboundId: 'azure-document-intelligence' });
  await e.close();
  expect(cloud.closed).toBe(true);
  expect(local.closed).toBe(true);
});
