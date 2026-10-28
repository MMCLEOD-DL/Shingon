import { test, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useReading } from '../../../src/modules/ocr/useReading.js';
import { Refusal, mockApi, pendingView, readWith, resetApi } from './testHelpers.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); resetApi(); });

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

test('polls every 1.5 seconds while the reading is pending, and stops once it is read', async () => {
  const read = readWith({ amount: [1240, 0.97] });
  const get = mockApi('getReading', read);
  get.mockReturnValueOnce(pendingView()).mockReturnValueOnce(pendingView());
  const { result } = renderHook(() => useReading('r1'));
  await advance(0);
  expect(get).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledWith('r1', undefined);
  expect(result.current.reading?.status).toBe('pending');
  await advance(1499);
  expect(get).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(get).toHaveBeenCalledTimes(2);
  await advance(1500);
  expect(get).toHaveBeenCalledTimes(3);
  expect(result.current.reading).toEqual(read);
  expect(result.current.error).toBeNull();
  await advance(10_000);
  expect(get).toHaveBeenCalledTimes(3);
});

test('after 90 seconds of pending it stops and says the details can be typed now', async () => {
  const get = mockApi('getReading', pendingView());
  const { result } = renderHook(() => useReading('r1'));
  await advance(0);
  await advance(88_500);
  expect(result.current.error).toBeNull();
  await advance(1500);
  expect((result.current.error as Error).message).toBe('Reading is taking longer than usual. You can type the details now.');
  expect(result.current.reading?.status).toBe('pending');
  const calls = get.mock.calls.length;
  await advance(30_000);
  expect(get.mock.calls.length).toBe(calls);
});

test('a reading that cannot be seen gives the server\'s sentence and stops', async () => {
  const get = mockApi('getReading', new Refusal(404, "We couldn't find that."));
  const { result } = renderHook(() => useReading('r1'));
  await advance(0);
  expect((result.current.error as Error).message).toBe("We couldn't find that.");
  expect(result.current.reading).toBeUndefined();
  await advance(10_000);
  expect(get).toHaveBeenCalledTimes(1);
});

test('a dropped connection while waiting keeps polling', async () => {
  const read = readWith({ amount: [1240, 0.97] });
  mockApi('getReading', pendingView());
  const { result } = renderHook(() => useReading('r1'));
  await advance(0);
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
  await advance(1500);
  expect(result.current.error).toBeNull();
  vi.stubGlobal('fetch', real);
  mockApi('getReading', read);
  await advance(1500);
  expect(result.current.reading).toEqual(read);
});

test('stops polling when the page is left', async () => {
  const get = mockApi('getReading', pendingView());
  const { unmount } = renderHook(() => useReading('r1'));
  await advance(0);
  unmount();
  await advance(10_000);
  expect(get).toHaveBeenCalledTimes(1);
});

test('a server fault while waiting keeps polling, as a dropped connection does', async () => {
  const read = readWith({ amount: [1240, 0.97] });
  const get = mockApi('getReading', read);
  get.mockReturnValueOnce(pendingView()).mockReturnValueOnce(new Refusal(503, 'Something went wrong. Please try again.'));
  const { result } = renderHook(() => useReading('r1'));
  await advance(0);
  await advance(1500);
  expect(result.current.error).toBeNull();
  await advance(1500);
  expect(result.current.reading).toEqual(read);
  expect(get).toHaveBeenCalledTimes(3);
});
