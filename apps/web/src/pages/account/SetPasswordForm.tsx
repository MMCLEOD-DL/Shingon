import { useState } from 'react';
import { Button, PasswordInput, Stack, Text } from '@mantine/core';
import { useForm, schemaResolver } from '@mantine/form';
import { SetPasswordInput } from '@hf/shared';
import { ErrorNotice } from '../../ui/index.js';

/** The "choose a password" form shared by reset and accept-invite. The server's reply to a weak or used link is shown as it comes. */
export function SetPasswordForm({ hint, onSubmit }: { hint: string; onSubmit: (password: string) => Promise<void> }) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const form = useForm({ mode: 'uncontrolled', initialValues: { password: '' }, validate: schemaResolver(SetPasswordInput) });

  const submit = form.onSubmit(async (values) => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(values.password);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  });

  return (
    <form onSubmit={submit} noValidate>
      <Stack gap="md">
        <Text size="sm" c="dimmed">{hint}</Text>
        <ErrorNotice error={error} />
        <PasswordInput label="New password" description="At least 10 characters." autoComplete="new-password" size="md"
          key={form.key('password')} {...form.getInputProps('password')} />
        <Button type="submit" size="md" fullWidth loading={busy}>Set new password</Button>
      </Stack>
    </form>
  );
}
