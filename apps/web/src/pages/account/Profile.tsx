import { useState } from 'react';
import { Button, Container, PasswordInput, Stack, Text, TextInput } from '@mantine/core';
import { useForm, schemaResolver } from '@mantine/form';
import { ChangePasswordInput, UpdateMeInput, type Role } from '@hf/shared';
import { api } from '../../api.js';
import { useAuth, type Actor } from '../../auth.js';
import { ErrorNotice, FormCard, PageHeader, notifySaved } from '../../ui/index.js';

export function roleSentence(role: Role, teamName: string | null | undefined): string {
  if (role === 'admin') return 'You are an admin.';
  const what = role === 'manager' ? 'a manager' : 'a member';
  return teamName ? `You are ${what} of ${teamName}.` : `You are ${what}. You are not on a team yet.`;
}

function NameForm({ user }: { user: Actor }) {
  const { setUser } = useAuth();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const form = useForm({ mode: 'uncontrolled', initialValues: { name: user.name }, validate: schemaResolver(UpdateMeInput) });

  const submit = form.onSubmit(async (values) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ user: Actor }>('PATCH', '/api/me', values);
      setUser({ ...user, name: res.user.name });
      notifySaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  });

  return (
    <FormCard title="Your details">
      <form onSubmit={submit} noValidate>
        <Stack gap="md">
          <ErrorNotice error={error} />
          <TextInput label="Your name" autoComplete="name" size="md" key={form.key('name')} {...form.getInputProps('name')} />
          <TextInput label="Email" value={user.email} readOnly disabled size="md" />
          <Text size="sm" c="dimmed">{roleSentence(user.role, user.teamName)}</Text>
          <Button type="submit" size="md" loading={busy} style={{ alignSelf: 'flex-start' }}>Save</Button>
        </Stack>
      </form>
    </FormCard>
  );
}

function PasswordForm() {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const form = useForm({
    mode: 'uncontrolled',
    initialValues: { currentPassword: '', newPassword: '' },
    validate: schemaResolver(ChangePasswordInput),
  });

  const submit = form.onSubmit(async (values) => {
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/me/password', values);
      form.reset();
      notifySaved('Your password has been changed. You have been signed out on your other devices.');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  });

  return (
    <FormCard title="Change your password">
      <form onSubmit={submit} noValidate>
        <Stack gap="md">
          <ErrorNotice error={error} />
          <PasswordInput label="Current password" autoComplete="current-password" size="md"
            key={form.key('currentPassword')} {...form.getInputProps('currentPassword')} />
          <PasswordInput label="New password" description="At least 10 characters." autoComplete="new-password" size="md"
            key={form.key('newPassword')} {...form.getInputProps('newPassword')} />
          <Button type="submit" size="md" loading={busy} style={{ alignSelf: 'flex-start' }}>Change password</Button>
        </Stack>
      </form>
    </FormCard>
  );
}

export function Profile() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <Container size="sm" p={0}>
      <PageHeader title="Your profile" />
      <Stack gap="lg">
        <NameForm user={user} />
        <PasswordForm />
      </Stack>
    </Container>
  );
}
