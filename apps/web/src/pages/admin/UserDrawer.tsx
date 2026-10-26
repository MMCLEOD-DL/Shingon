import { useState } from 'react';
import { Badge, Button, Divider, Drawer, Modal, Group, Select, Stack, Switch, Text, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useMediaQuery } from '@mantine/hooks';
import type { UpdateUserInput, UserView } from '@hf/shared';
import { useAuth } from '../../auth.js';
import { ErrorNotice, notifyError, notifySaved } from '../../ui/index.js';
import { useResendInvite, useTeams, useUpdateUser } from '../../queries.js';
import { ROLE_OPTIONS } from './roles.js';

function DrawerBody({ person, onClose }: { person: UserView; onClose: () => void }) {
  const { user: me } = useAuth();
  const isSelf = me?.id === person.id;
  const teams = useTeams();
  const update = useUpdateUser(person.id);
  const resend = useResendInvite(person.id);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState<UpdateUserInput | null>(null);
  const form = useForm({
    mode: 'controlled',
    initialValues: { name: person.name, role: person.role, teamId: person.teamId, active: !person.disabled },
    validate: { name: (v) => (v.trim() === '' ? 'Enter a name.' : null) },
  });

  const save = async (changes: UpdateUserInput) => {
    try {
      await update.mutateAsync(changes);
      notifySaved();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setPending(null);
    }
  };

  const submit = form.onSubmit(async (v) => {
    setError(null);
    // Only what changed is sent, and never the role or active switch for your own row.
    const changes: UpdateUserInput = {};
    if (v.name.trim() !== person.name) changes.name = v.name.trim();
    if (!isSelf && v.role !== person.role) changes.role = v.role;
    if (v.teamId !== person.teamId) changes.teamId = v.teamId;
    if (!isSelf && v.active === person.disabled) changes.disabled = !v.active;
    if (Object.keys(changes).length === 0) { onClose(); return; }
    // Switching someone off signs them out, so it asks first.
    if (changes.disabled === true) { setPending(changes); return; }
    await save(changes);
  });

  const sendAgain = async () => {
    try {
      await resend.mutateAsync();
      notifySaved(`Invite sent again to ${person.email}.`);
    } catch (e) {
      notifyError(e);
    }
  };

  return (
    <>
    <Modal opened={pending !== null} onClose={() => { setPending(null); }} title={`Switch off ${person.name}'s account?`} centered>
      <Text mb="md">{person.name} will be signed out everywhere and won't be able to sign in until you switch the account back on.</Text>
      <Group justify="flex-end">
        <Button variant="default" onClick={() => { setPending(null); }} disabled={update.isPending}>Cancel</Button>
        <Button color="red" loading={update.isPending} onClick={() => { if (pending) void save(pending); }}>Switch off account</Button>
      </Group>
    </Modal>
    <form onSubmit={submit} noValidate>
      <Stack gap="md">
        <ErrorNotice error={error} />
        <Text c="dimmed" size="sm">{person.email}</Text>
        <TextInput label="Name" {...form.getInputProps('name')} />
        {isSelf ? (
          <Text size="sm" c="dimmed">You can't change your own role or disable your own account.</Text>
        ) : (
          <Select label="Role" data={ROLE_OPTIONS} allowDeselect={false} {...form.getInputProps('role')} />
        )}
        <Select
          label="Team"
          description="Managers and members need a team."
          data={(teams.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
          clearable
          placeholder="No team"
          {...form.getInputProps('teamId')}
        />
        {isSelf ? null : <Switch label="Account active" {...form.getInputProps('active', { type: 'checkbox' })} />}
        {!person.activated ? (
          <>
            <Divider />
            <Group justify="space-between" wrap="wrap" gap="sm">
              <Badge color="yellow" variant="light">Invite sent</Badge>
              <Button variant="default" loading={resend.isPending} onClick={() => { void sendAgain(); }}>Send invite again</Button>
            </Group>
          </>
        ) : null}
        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={onClose} disabled={update.isPending}>Cancel</Button>
          <Button type="submit" loading={update.isPending}>Save changes</Button>
        </Group>
      </Stack>
    </form>
    </>
  );
}

/** Full screen on a phone, from the right on a desktop. */
export function UserDrawer({ person, onClose }: { person: UserView | null; onClose: () => void }) {
  const mobile = useMediaQuery('(max-width: 48em)', false, { getInitialValueInEffect: false });
  return (
    <Drawer opened={person !== null} onClose={onClose} position="right" size={mobile ? '100%' : 'md'} title={person?.name ?? ''}>
      {person ? <DrawerBody key={person.id} person={person} onClose={onClose} /> : null}
    </Drawer>
  );
}
