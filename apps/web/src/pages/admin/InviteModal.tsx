import { useState } from 'react';
import { Button, Group, Modal, Select, Stack, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import type { InviteInput } from '@hf/shared';
import { ErrorNotice, notifySaved } from '../../ui/index.js';
import { useInviteUser, useTeams } from '../../queries.js';
import { ROLE_OPTIONS } from './roles.js';

export function InviteModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const teams = useTeams(opened);
  const invite = useInviteUser();
  const [error, setError] = useState<unknown>(null);
  const form = useForm({
    mode: 'controlled',
    initialValues: { email: '', name: '', role: 'member', teamId: null as string | null },
    validate: {
      email: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? null : 'Enter a valid email address.'),
      name: (v) => (v.trim() === '' ? 'Enter their name.' : null),
      role: (v) => (v ? null : 'Choose a role.'),
    },
  });

  const close = () => { form.reset(); setError(null); onClose(); };
  const submit = form.onSubmit(async (v) => {
    setError(null);
    // The server checks every field again; its own wording is shown if it refuses.
    const input = { email: v.email.trim(), name: v.name.trim(), role: v.role as InviteInput['role'], teamId: v.teamId };
    try {
      await invite.mutateAsync(input);
      notifySaved(`Invite sent to ${input.email}.`);
      close();
    } catch (e) {
      setError(e);
    }
  });

  return (
    <Modal opened={opened} onClose={close} title="Invite someone" centered fullScreen={false}>
      <form onSubmit={submit} noValidate>
        <Stack gap="md">
          <ErrorNotice error={error} />
          <TextInput label="Email" type="email" autoComplete="off" {...form.getInputProps('email')} />
          <TextInput label="Name" autoComplete="off" {...form.getInputProps('name')} />
          <Select label="Role" data={ROLE_OPTIONS} allowDeselect={false} {...form.getInputProps('role')} />
          <Select
            label="Team"
            description="Managers and members need a team."
            data={(teams.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
            clearable
            placeholder={teams.isPending ? 'Loading teams…' : 'No team'}
            {...form.getInputProps('teamId')}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={close} disabled={invite.isPending}>Cancel</Button>
            <Button type="submit" loading={invite.isPending}>Send invite</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
