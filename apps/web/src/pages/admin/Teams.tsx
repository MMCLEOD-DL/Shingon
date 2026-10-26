import { useState } from 'react';
import { Button, Center, Container, Group, Loader, Modal, Stack, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useDisclosure } from '@mantine/hooks';
import { IconPlus } from '@tabler/icons-react';
import type { TeamView } from '@hf/shared';
import { EmptyState, ErrorNotice, PageHeader, ResponsiveList, notifySaved, type Column } from '../../ui/index.js';
import { useCreateTeam, useTeams } from '../../queries.js';

function AddTeam({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const create = useCreateTeam();
  const [error, setError] = useState<unknown>(null);
  const form = useForm({ mode: 'controlled', initialValues: { name: '' }, validate: { name: (v) => (v.trim() === '' ? 'Enter a team name.' : v.trim().length > 80 ? 'Use at most 80 characters.' : null) } });
  const close = () => { form.reset(); setError(null); onClose(); };
  const submit = form.onSubmit(async (v) => {
    setError(null);
    try {
      await create.mutateAsync(v.name.trim());
      notifySaved('Team added.');
      close();
    } catch (e) {
      setError(e);
    }
  });
  return (
    <Modal opened={opened} onClose={close} title="Add team" centered>
      <form onSubmit={submit} noValidate>
        <Stack gap="md">
          <ErrorNotice error={error} />
          <TextInput label="Team name" {...form.getInputProps('name')} />
          <Group justify="flex-end">
            <Button variant="default" onClick={close} disabled={create.isPending}>Cancel</Button>
            <Button type="submit" loading={create.isPending}>Save team</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

export function Teams() {
  const q = useTeams();
  const [adding, { open, close }] = useDisclosure(false);
  const columns: Column<TeamView>[] = [{ key: 'name', label: 'Team', cardHidden: true, render: (t) => t.name }];
  return (
    <Container size="sm" p={0}>
      <PageHeader title="Teams" actions={<Button leftSection={<IconPlus size={18} />} onClick={open}>Add team</Button>} />
      <Stack gap="md">
        {q.isPending ? <Center py="xl"><Loader aria-label="Loading" /></Center> : null}
        {q.isError ? <ErrorNotice error={q.error} /> : null}
        {q.data ? <ResponsiveList items={q.data} columns={columns} cardTitle={(t) => t.name} empty={<EmptyState title="No teams yet" />} /> : null}
      </Stack>
      <AddTeam opened={adding} onClose={close} />
    </Container>
  );
}
