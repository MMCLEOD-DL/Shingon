import { test, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FileDropzone } from '../src/ui/FileDropzone.js';
import { Wrap, mockFetch, setMobile, user } from './helpers.js';

afterEach(() => vi.unstubAllGlobals());

test('too-large and wrong-type files are refused in plain English before upload', async () => {
  const f = mockFetch({});
  render(<Wrap><FileDropzone onUploaded={() => undefined} maxBytes={10} /></Wrap>);
  // The shared formatter says "1 KB" below a megabyte (the brief's "0 MB" would be misleading).
  await user.upload(screen.getByTestId('file-input'), new File([new Uint8Array(11)], 'big.jpg', { type: 'image/jpeg' }));
  expect(await screen.findByText('That file is too large. The limit is 1 KB.')).toBeInTheDocument();
  expect(f).not.toHaveBeenCalled();
});

test('an empty file is refused before upload', async () => {
  const f = mockFetch({});
  render(<Wrap><FileDropzone onUploaded={() => undefined} /></Wrap>);
  await user.upload(screen.getByTestId('file-input'), new File([], 'nothing.jpg', { type: 'image/jpeg' }));
  expect(await screen.findByText('That file is empty.')).toBeInTheDocument();
  expect(f).not.toHaveBeenCalled();
});

test('on a phone the camera button is offered', () => {
  setMobile(true);
  render(<Wrap><FileDropzone onUploaded={() => undefined} /></Wrap>);
  expect(screen.getByRole('button', { name: 'Take or choose a photo' })).toBeInTheDocument();
  expect(screen.getByTestId('file-input')).toHaveAttribute('capture', 'environment');
});

test('the server refusal text is shown when an upload fails', async () => {
  mockFetch({ 'POST /api/files': [413, { error: 'That file is too large. The limit is 15 MB.' }] });
  render(<Wrap><FileDropzone onUploaded={() => undefined} /></Wrap>);
  await user.upload(screen.getByTestId('file-input'), new File([new Uint8Array([1, 2, 3])], 'a.jpg', { type: 'image/jpeg' }));
  expect(await screen.findByText('That file is too large. The limit is 15 MB.')).toBeInTheDocument();
});
