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

test('on a phone both the camera and the file chooser are offered', () => {
  setMobile(true);
  render(<Wrap><FileDropzone onUploaded={() => undefined} /></Wrap>);
  expect(screen.getByRole('button', { name: 'Take a photo' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Choose a file' })).toBeInTheDocument();
  const camera = screen.getByTestId('camera-input');
  expect(camera).toHaveAttribute('capture', 'environment');
  expect(camera).toHaveAttribute('accept', 'image/*');
  const pick = screen.getByTestId('file-input');
  expect(pick).not.toHaveAttribute('capture');
  expect(pick.getAttribute('accept')).toContain('application/pdf');
  expect(pick.getAttribute('accept')).toContain('image/heic');
});

test('a HEIC file with no reported type is let through on a computer', async () => {
  const f = mockFetch({ 'POST /api/files': [201, { file: { id: 'f2', name: 'IMG_1.heic', contentType: 'image/heic', size: 1500000, createdAt: '2026-10-01T10:00:00.000Z', ownerId: 'u1' } }] });
  render(<Wrap><FileDropzone onUploaded={() => undefined} /></Wrap>);
  await user.upload(screen.getByTestId('file-input'), new File([new Uint8Array([1, 2, 3])], 'IMG_1.heic', { type: '' }));
  expect(await screen.findByText('IMG_1.heic')).toBeInTheDocument();
  expect(screen.getByText('1.4 MB')).toBeInTheDocument();
  expect(f).toHaveBeenCalledWith('/api/files', expect.anything());
});

test('the server refusal text is shown when an upload fails', async () => {
  mockFetch({ 'POST /api/files': [413, { error: 'That file is too large. The limit is 15 MB.' }] });
  render(<Wrap><FileDropzone onUploaded={() => undefined} /></Wrap>);
  await user.upload(screen.getByTestId('file-input'), new File([new Uint8Array([1, 2, 3])], 'a.jpg', { type: 'image/jpeg' }));
  expect(await screen.findByText('That file is too large. The limit is 15 MB.')).toBeInTheDocument();
});

test('a prepare step runs before the checks and the upload, and its file is the one sent', async () => {
  const f = mockFetch({ 'POST /api/files': [201, { file: { id: 'f3', name: 'big.jpg', contentType: 'image/jpeg', size: 4, createdAt: '2026-10-01T10:00:00.000Z', ownerId: 'u1' } }] });
  const small = new File([new Uint8Array(4)], 'big.jpg', { type: 'image/jpeg' });
  const prepare = vi.fn(async () => small);
  render(<Wrap><FileDropzone onUploaded={() => undefined} maxBytes={10} prepare={prepare} /></Wrap>);
  // Over the limit as chosen, under it once prepared.
  const chosen = new File([new Uint8Array(11)], 'big.heic', { type: 'image/heic' });
  await user.upload(screen.getByTestId('file-input'), chosen);
  expect(await screen.findByText('big.jpg')).toBeInTheDocument();
  expect(prepare).toHaveBeenCalledWith(chosen);
  const body = f.mock.calls[0]?.[1]?.body as FormData;
  expect(body.get('file')).toBe(small);
});

test('a file over 40 MB is not prepared in the browser; the size check refuses it', async () => {
  const f = mockFetch({});
  const prepare = vi.fn(async (file: File) => file);
  render(<Wrap><FileDropzone onUploaded={() => undefined} prepare={prepare} /></Wrap>);
  const huge = new File([new Uint8Array(40 * 1024 * 1024 + 1)], 'huge.jpg', { type: 'image/jpeg' });
  await user.upload(screen.getByTestId('file-input'), huge);
  expect(await screen.findByText('That file is too large. The limit is 15 MB.')).toBeInTheDocument();
  expect(prepare).not.toHaveBeenCalled();
  expect(f).not.toHaveBeenCalled();
});
