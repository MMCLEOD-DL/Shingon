import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Button, Card, Center, Container, Group, Loader, Stack, Text } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { IconEdit } from '@tabler/icons-react';
import type { NoteView as Note } from '@hf/shared';
import { ConfirmAction, ErrorNotice, FilePreview, PageHeader, formatDateTime, notifySaved } from '../../ui/index.js';
import { keys, useDeleteNote, useNote, useUpdateNote } from '../../queries.js';
import { NoteForm } from './NoteForm.js';

function Editing({ note, done }: { note: Note; done: () => void }) {
  const update = useUpdateNote(note.id);
  return (
    <NoteForm
      note={note}
      onCancel={done}
      onSubmit={async (v) => {
        // Only what changed is sent, so a title-only edit leaves the details and photo exactly as they are.
        const changes: { title?: string; body?: string; attachmentId?: string | null } = {};
        if (v.title !== note.title) changes.title = v.title;
        if (v.body !== note.body) changes.body = v.body;
        if (v.attachmentId !== (note.attachment?.id ?? null)) changes.attachmentId = v.attachmentId;
        if (Object.keys(changes).length > 0) await update.mutateAsync(changes);
        notifySaved();
        done();
      }}
    />
  );
}

export function NoteView() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const q = useNote(id);
  const remove = useDeleteNote(id);
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);

  if (q.isPending) return <Center py="xl"><Loader aria-label="Loading" /></Center>;
  if (q.isError) {
    return (
      <Container size="md" p={0}>
        <Stack gap="md" align="flex-start">
          <ErrorNotice error={q.error} />
          <Button component={Link} to="/notes" variant="default">Back to notes</Button>
        </Stack>
      </Container>
    );
  }
  const note = q.data;
  return (
    <Container size="md" p={0}>
      <PageHeader
        title={note.title}
        description={`${note.ownerName} · ${formatDateTime(note.createdAt)}`}
        actions={note.canEdit && !editing ? (
          <>
            <Button variant="default" leftSection={<IconEdit size={18} />} onClick={() => { setEditing(true); }}>Edit</Button>
            <ConfirmAction
              label="Delete"
              confirmTitle="Delete this note?"
              confirmBody="This can't be undone."
              onConfirm={async () => { await remove.mutateAsync();
                void navigate('/notes');
                setTimeout(() => { qc.removeQueries({ queryKey: keys.note(id) }); }, 0);
              }}
            />
          </>
        ) : undefined}
      />
      {editing ? (
        <Editing note={note} done={() => { setEditing(false); }} />
      ) : (
        <Stack gap="md" maw={720}>
          <Card withBorder padding="lg">
            {note.body !== '' ? <Text style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{note.body}</Text> : <Text c="dimmed">No details.</Text>}
          </Card>
          {note.attachment ? <FilePreview file={note.attachment} /> : null}
          {note.updatedAt !== note.createdAt ? <Group><Text size="sm" c="dimmed">Last changed {formatDateTime(note.updatedAt)}</Text></Group> : null}
        </Stack>
      )}
    </Container>
  );
}
