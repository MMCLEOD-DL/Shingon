import { useState } from 'react';
import { Badge, Button, Center, Container, Loader, Stack } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconUserPlus } from '@tabler/icons-react';
import { can, type UserView } from '@hf/shared';
import { useAuth } from '../../auth.js';
import { EmptyState, ErrorNotice, PageHeader, ResponsiveList, type Column } from '../../ui/index.js';
import { useUsers } from '../../queries.js';
import { InviteModal } from './InviteModal.js';
import { UserDrawer } from './UserDrawer.js';
import { ROLE_LABEL } from './roles.js';

function Status({ u }: { u: UserView }) {
  if (u.disabled) return <Badge color="red" variant="light">Switched off</Badge>;
  if (!u.activated) return <Badge color="yellow" variant="light">Invite sent</Badge>;
  return <Badge color="teal" variant="light">Active</Badge>;
}

export function Users() {
  const { user: me } = useAuth();
  const q = useUsers();
  const [invite, { open, close }] = useDisclosure(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Presentation only: the server refuses these calls for anyone else.
  const canManage = me !== null && can(me.role, 'users:manage');
  const selected = q.data?.find((u) => u.id === selectedId) ?? null;

  const columns: Column<UserView>[] = [
    { key: 'name', label: 'Name', cardHidden: true, render: (u) => u.name },
    { key: 'email', label: 'Email', render: (u) => u.email },
    { key: 'role', label: 'Role', render: (u) => ROLE_LABEL[u.role] },
    { key: 'team', label: 'Team', render: (u) => u.teamName ?? 'No team' },
    { key: 'status', label: 'Status', render: (u) => <Status u={u} /> },
  ];

  return (
    <Container size="lg" p={0}>
      <PageHeader
        title="People"
        actions={canManage ? <Button leftSection={<IconUserPlus size={18} />} onClick={open}>Invite someone</Button> : undefined}
      />
      <Stack gap="md">
        {q.isPending ? <Center py="xl"><Loader aria-label="Loading" /></Center> : null}
        {q.isError ? <ErrorNotice error={q.error} /> : null}
        {q.data ? (
          <ResponsiveList
            items={q.data}
            columns={columns}
            cardTitle={(u) => u.name}
            {...(canManage ? { onOpen: (u: UserView) => { setSelectedId(u.id); } } : {})}
            empty={<EmptyState title="No one here yet" />}
          />
        ) : null}
      </Stack>
      {canManage ? <InviteModal opened={invite} onClose={close} /> : null}
      {canManage ? <UserDrawer person={selected} onClose={() => { setSelectedId(null); }} /> : null}
    </Container>
  );
}
