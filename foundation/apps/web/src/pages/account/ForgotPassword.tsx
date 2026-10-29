import { useState } from 'react';
import { Link } from 'react-router';
import { Alert, Anchor, Button, Stack, Text, TextInput } from '@mantine/core';
import { useForm, schemaResolver } from '@mantine/form';
import { IconMailCheck } from '@tabler/icons-react';
import { ForgotInput } from '@hf/shared';
import { api } from '../../api.js';
import { ErrorNotice } from '../../ui/index.js';
import { AuthCard } from './AuthCard.js';

export function ForgotPassword() {
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useForm({ mode: 'uncontrolled', initialValues: { email: '' }, validate: schemaResolver(ForgotInput) });

  const submit = form.onSubmit(async (values) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string }>('POST', '/api/auth/forgot-password', values);
      setMessage(res.message);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  });

  const back = <Anchor component={Link} to="/sign-in">Back to sign in</Anchor>;
  if (message !== null) {
    return (
      <AuthCard title="Check your email" footer={back}>
        <Alert color="teal" variant="light" icon={<IconMailCheck size={18} />}>{message}</Alert>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Forgot your password?" footer={back}>
      <form onSubmit={submit} noValidate>
        <Stack gap="md">
          <Text size="sm" c="dimmed">Enter your email and we will send you a link to choose a new password.</Text>
          <ErrorNotice error={error} />
          <TextInput label="Email" type="email" autoComplete="email" inputMode="email" size="md"
            key={form.key('email')} {...form.getInputProps('email')} />
          <Button type="submit" size="md" fullWidth loading={busy}>Send reset link</Button>
        </Stack>
      </form>
    </AuthCard>
  );
}
