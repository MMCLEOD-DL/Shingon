import { useState } from 'react';
import { Button, Group, Stack, Textarea, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import type { FileView, NoteView } from '@hf/shared';
import { ErrorNotice, FileDropzone } from '../../ui/index.js';

export interface NoteFormValues { title: string; body: string; attachmentId: string | null }

/** Shared by New note and Edit. `onSubmit` gets the values; it throws to keep the form open and show the reason. */
export function NoteForm({ note, onSubmit, onCancel }: {
  note?: NoteView;
  onSubmit: (values: NoteFormValues) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const [attachment, setAttachment] = useState<FileView | null>(note?.attachment ?? null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const form = useForm({
    mode: 'uncontrolled',
    initialValues: { title: note?.title ?? '', body: note?.body ?? '' },
    validate: {
      title: (v) => (v.trim() === '' ? 'Enter a title.' : v.trim().length > 200 ? 'Use at most 200 characters.' : null),
      body: (v) => (v.length > 10000 ? 'Use at most 10,000 characters.' : null),
    },
  });

  const submit = form.onSubmit(async (values) => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ title: values.title.trim(), body: values.body, attachmentId: attachment?.id ?? null });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  });

  return (
    <form onSubmit={submit} noValidate>
      <Stack gap="md" maw={720}>
        <ErrorNotice error={error} />
        <TextInput label="Title" size="md" key={form.key('title')} {...form.getInputProps('title')} />
        <Textarea label="Details" autosize minRows={4} maxRows={14} size="md" key={form.key('body')} {...form.getInputProps('body')} />
        <div>
          <FileDropzone value={attachment} onUploaded={setAttachment} onRemoved={() => { setAttachment(null); }} />
        </div>
        <Group>
          <Button type="submit" loading={busy}>Save note</Button>
          {onCancel ? <Button variant="default" onClick={onCancel} disabled={busy}>Cancel</Button> : null}
        </Group>
      </Stack>
    </form>
  );
}
