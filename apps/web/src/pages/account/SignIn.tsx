import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Anchor, Button, PasswordInput, Stack, TextInput } from '@mantine/core';
import { useForm, schemaResolver } from '@mantine/form';
import { SignInInput } from '@hf/shared';
import { api } from '../../api.js';
import { useAuth, type Actor } from '../../auth.js';
import { safeNext } from '../../safeNext.js';
import { ErrorNotice } from '../../ui/index.js';
import { AuthCard } from './AuthCard.js';

export function SignIn() {
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const form = useForm({
    mode: 'uncontrolled',
    initialValues: { email: '', password: '' },
    validate: schemaResolver(SignInInput),
  });

  const submit = form.onSubmit(async (values) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ user: Actor }>('POST', '/api/auth/sign-in', values);
      setUser(res.user);
      void navigate(safeNext(params.get('next'), '/notes'), { replace: true });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  });

  return (
    <AuthCard title="Sign in" footer={<Anchor component={Link} to="/forgot-password">Forgot your password?</Anchor>}>
      <form onSubmit={submit} noValidate>
        <Stack gap="md">
          <ErrorNotice error={error} />
          <TextInput label="Email" type="email" autoComplete="email" inputMode="email" size="md"
            key={form.key('email')} {...form.getInputProps('email')} />
          <PasswordInput label="Password" autoComplete="current-password" size="md"
            key={form.key('password')} {...form.getInputProps('password')} />
          <Button type="submit" size="md" fullWidth loading={busy}>Sign in</Button>
        </Stack>
      </form>
    </AuthCard>
  );
}
