import { useNavigate } from 'react-router';
import { Container } from '@mantine/core';
import { PageHeader } from '../../ui/index.js';
import { useCreateNote } from '../../queries.js';
import { NoteForm } from './NoteForm.js';

export function NoteNew() {
  const navigate = useNavigate();
  const create = useCreateNote();
  return (
    <Container size="md" p={0}>
      <PageHeader title="New note" />
      <NoteForm
        onCancel={() => { void navigate('/notes'); }}
        onSubmit={async (v) => {
          const note = await create.mutateAsync(v);
          void navigate(`/notes/${note.id}`);
        }}
      />
    </Container>
  );
}
