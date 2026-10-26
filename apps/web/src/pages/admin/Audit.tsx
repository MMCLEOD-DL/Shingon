import { Button, Center, Container, Loader, Stack } from '@mantine/core';
import { EmptyState, ErrorNotice, PageHeader, ResponsiveList, formatDateTime, type Column } from '../../ui/index.js';
import { useAudit, type AuditEntry } from '../../queries.js';

const WHAT: Record<string, string> = {
  'auth.sign_in': 'Signed in',
  'auth.sign_in_failed': 'Failed sign-in',
  'auth.sign_out': 'Signed out',
  'auth.password_changed': 'Changed password',
  'auth.password_reset_requested': 'Asked for a password reset',
  'auth.password_reset': 'Reset password',
  'user.invited': 'Invited someone',
  'user.invite_accepted': 'Accepted an invite',
  'user.updated': 'Changed a person',
  'user.disabled': 'Switched an account off',
  'user.enabled': 'Switched an account on',
  'team.created': 'Added a team',
  'file.uploaded': 'Uploaded a file',
  'file.downloaded': 'Downloaded a file',
  'file.deleted': 'Deleted a file',
  'note.created': 'Created a note',
  'note.updated': 'Changed a note',
  'note.deleted': 'Deleted a note',
  'seed.demo': 'Loaded demo data',
};

const columns: Column<AuditEntry>[] = [
  { key: 'at', label: 'When', render: (e) => formatDateTime(e.at) },
  { key: 'who', label: 'Who', render: (e) => e.actorLabel },
  { key: 'what', label: 'What', render: (e) => WHAT[e.action] ?? e.action },
  { key: 'ip', label: 'From', render: (e) => e.ip ?? '' },
];

export function Audit() {
  const q = useAudit();
  const entries = q.data?.pages.flatMap((p) => p.entries) ?? [];
  return (
    <Container size="lg" p={0}>
      <PageHeader title="Activity log" />
      <Stack gap="md">
        {q.isPending ? <Center py="xl"><Loader aria-label="Loading" /></Center> : null}
        {q.isError ? <ErrorNotice error={q.error} /> : null}
        {q.data ? <ResponsiveList items={entries} columns={columns} cardTitle={(e) => e.actorLabel} empty={<EmptyState title="Nothing recorded yet" />} /> : null}
        {q.hasNextPage ? (
          <Button variant="default" loading={q.isFetchingNextPage} onClick={() => { void q.fetchNextPage(); }} style={{ alignSelf: 'center' }}>Load more</Button>
        ) : null}
      </Stack>
    </Container>
  );
}
