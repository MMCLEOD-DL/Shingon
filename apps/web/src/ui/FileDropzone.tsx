import { useState } from 'react';
import { Anchor, Button, Group, Image, Loader, Paper, Progress, Stack, Text } from '@mantine/core';
import { Dropzone, type FileRejection } from '@mantine/dropzone';
import { useMediaQuery } from '@mantine/hooks';
import { IconCamera, IconFile, IconPhoto, IconUpload, IconX } from '@tabler/icons-react';
import { formatLimit, type FileView } from '@hf/shared';
import { uploadFile } from '../api.js';
import { formatSize } from './format.js';
import { ErrorNotice } from './ErrorNotice.js';

export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
// HEIC and HEIF carry their extensions too, because some computers report no type for them. The server looks at the bytes anyway.
const DROP_ACCEPT: Record<string, string[]> = Object.fromEntries(
  ACCEPTED_TYPES.map((t) => [t, t === 'image/heic' ? ['.heic'] : t === 'image/heif' ? ['.heif'] : []]),
);
const PICK_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.heic,.heif';
const RASTER = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DEFAULT_MAX = 15 * 1024 * 1024;

// The same sentences the server uses, so a refusal reads the same wherever it comes from.
const NOT_ACCEPTED = "That kind of file isn't accepted. Use a photo (JPEG, PNG, WebP, HEIC) or a PDF.";
const EMPTY = 'That file is empty.';
const tooLarge = (max: number): string => `That file is too large. The limit is ${formatLimit(max)}.`;

export const fileUrl = (id: string): string => `/api/files/${encodeURIComponent(id)}/content`;

/** Thumbnail for a photo, a download link for anything else. The server sends non-photos as downloads. */
export function FilePreview({ file, onRemove }: { file: FileView; onRemove?: () => void }) {
  return (
    <Paper withBorder p="sm" radius="md">
      <Group wrap="nowrap" gap="md" align="center">
        {RASTER.has(file.contentType)
          ? <Image src={fileUrl(file.id)} alt="" w={72} h={72} fit="cover" radius="sm" />
          : <IconFile size={40} aria-hidden="true" />}
        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Anchor href={fileUrl(file.id)} target="_blank" rel="noopener" truncate="end">{file.name}</Anchor>
          <Text size="xs" c="dimmed">{formatSize(file.size)}</Text>
        </Stack>
        {onRemove ? <Button variant="subtle" color="red" size="compact-md" leftSection={<IconX size={16} />} onClick={onRemove}>Remove</Button> : null}
      </Group>
    </Paper>
  );
}

/** Choose or drop one file and upload it at once. On a phone, one big button opens the camera or the photo library. */
export function FileDropzone({ onUploaded, onRemoved, value = null, maxBytes = DEFAULT_MAX, prepare }: {
  onUploaded: (file: FileView) => void;
  onRemoved?: () => void;
  /** A file already attached, shown in place of the chooser. */
  value?: FileView | null;
  maxBytes?: number;
  /** Runs on the chosen file before the checks and the upload (receipts: turn the photo upright, JPEG, smaller). */
  prepare?: (file: File) => Promise<File>;
}) {
  const mobile = useMediaQuery('(max-width: 48em)', false, { getInitialValueInEffect: false });
  const [current, setCurrent] = useState<FileView | null>(value);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const problem = (f: File): string | null => {
    if (f.size === 0) return EMPTY;
    if (f.size > maxBytes) return tooLarge(maxBytes);
    // Some phones report no type for HEIC: let the server look at the bytes.
    if (f.type !== '' && !ACCEPTED_TYPES.includes(f.type)) return NOT_ACCEPTED;
    return null;
  };

  const send = async (chosen: File | undefined) => {
    if (!chosen) return;
    setError(null);
    setBusy(chosen.name);
    let f = chosen;
    if (prepare) {
      try {
        f = await prepare(chosen);
      } catch {
        f = chosen; // preparing is a nicety: the original still goes up
      }
    }
    const refusal = problem(f);
    if (refusal) { setBusy(null); setError(new Error(refusal)); return; }
    try {
      const file = await uploadFile(f);
      setCurrent(file);
      onUploaded(file);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const rejected = (rejections: FileRejection[]) => {
    const code = rejections[0]?.errors[0]?.code;
    const first = rejections[0]?.file;
    setError(new Error(first && first.size === 0 ? EMPTY : code === 'file-too-large' ? tooLarge(maxBytes) : NOT_ACCEPTED));
  };

  if (current) {
    return <FilePreview file={current} onRemove={() => { setCurrent(null); setError(null); onRemoved?.(); }} />;
  }

  return (
    <Stack gap="xs">
      {busy !== null ? (
        <Paper withBorder p="md" radius="md" role="status">
          <Group gap="sm" mb="xs"><Loader size="sm" /><Text size="sm">Uploading {busy}…</Text></Group>
          <Progress value={100} animated aria-label="Uploading" />
        </Paper>
      ) : mobile ? (
        <Stack gap="xs">
          <Button fullWidth size="lg" leftSection={<IconCamera size={20} />} onClick={() => { document.getElementById('hf-camera-input')?.click(); }}>
            Take a photo
          </Button>
          <Button fullWidth size="lg" variant="default" leftSection={<IconPhoto size={20} />} onClick={() => { document.getElementById('hf-file-input')?.click(); }}>
            Choose a file
          </Button>
          <input
            id="hf-camera-input" type="file" accept="image/*" capture="environment" data-testid="camera-input" hidden
            onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; void send(f); }}
          />
          <input
            id="hf-file-input" type="file" accept={PICK_ACCEPT} data-testid="file-input" hidden
            onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; void send(f); }}
          />
        </Stack>
      ) : (
        <Dropzone
          onDrop={(files) => { void send(files[0]); }}
          onReject={rejected}
          accept={DROP_ACCEPT}
          // With a prepare step the size is checked on the prepared file (a big phone photo shrinks), not here.
          maxSize={prepare ? Infinity : maxBytes}
          multiple={false}
          inputProps={{ 'data-testid': 'file-input' } as React.InputHTMLAttributes<HTMLInputElement>}
        >
          <Group justify="center" gap="md" mih={110} style={{ pointerEvents: 'none' }}>
            <Dropzone.Accept><IconUpload size={36} aria-hidden="true" /></Dropzone.Accept>
            <Dropzone.Reject><IconX size={36} aria-hidden="true" /></Dropzone.Reject>
            <Dropzone.Idle><IconPhoto size={36} aria-hidden="true" /></Dropzone.Idle>
            <div>
              <Text>Drop a photo or PDF here, or click to choose one</Text>
              <Text size="sm" c="dimmed">JPEG, PNG, WebP, HEIC or PDF, up to {formatLimit(maxBytes)}</Text>
            </div>
          </Group>
        </Dropzone>
      )}
      <ErrorNotice error={error} />
    </Stack>
  );
}
