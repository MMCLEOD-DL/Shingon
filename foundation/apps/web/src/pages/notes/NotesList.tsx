import { Link, useNavigate } from 'react-router';
import { Anchor, Button, Center, Container, Loader, Stack } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import type { NoteView } from '@hf/shared';
import { EmptyState, ErrorNotice, PageHeader, ResponsiveList, formatDateTime, type Column } from '../../ui/index.js';
import { useNotes } from '../../queries.js';

export function NotesList() {
  const navigate = useNavigate();
  const q = useNotes();
  const notes = q.data?.pages.flatMap((p) => p.notes) ?? [];
  const columns: Column<NoteView>[] = [
    { key: 'title', label: 'Title', cardHidden: true, render: (n) => <Anchor component={Link} to={`/notes/${n.id}`} onClick={(e) => { e.stopPropagation(); }}>{n.title}</Anchor> },
    { key: 'owner', label: 'By', render: (n) => n.ownerName },
    { key: 'created', label: 'Created', render: (n) => formatDateTime(n.createdAt) },
  ];
  return (
    <Container size="md" p={0}>
      <PageHeader title="Notes" actions={<Button component={Link} to="/notes/new" leftSection={<IconPlus size={18} />}>New note</Button>} />
      <Stack gap="md">
        {q.isPending ? <Center py="xl"><Loader aria-label="Loading" /></Center> : null}
        {q.isError ? <ErrorNotice error={q.error} /> : null}
        {q.data ? (
          <ResponsiveList
            items={notes}
            columns={columns}
            cardTitle={(n) => n.title}
            onOpen={(n) => { void navigate(`/notes/${n.id}`); }}
            empty={<EmptyState title="No notes yet" body="Notes you create will appear here." />}
          />
        ) : null}
        {q.hasNextPage ? (
          <Button variant="default" loading={q.isFetchingNextPage} onClick={() => { void q.fetchNextPage(); }} style={{ alignSelf: 'center' }}>Load more</Button>
        ) : null}
      </Stack>
    </Container>
  );
}
