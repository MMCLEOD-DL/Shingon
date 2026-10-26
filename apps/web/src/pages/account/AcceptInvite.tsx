import { Link, useNavigate } from 'react-router';
import { Alert, Anchor } from '@mantine/core';
import { api } from '../../api.js';
import { useAuth, type Actor } from '../../auth.js';
import { AuthCard } from './AuthCard.js';
import { INCOMPLETE_LINK } from './ResetPassword.js';
import { SetPasswordForm } from './SetPasswordForm.js';
import { useLinkToken } from './useLinkToken.js';

export function AcceptInvite() {
  const token = useLinkToken();
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const back = <Anchor component={Link} to="/sign-in">Back to sign in</Anchor>;

  if (token === '') {
    return <AuthCard title="Set up your account" footer={back}><Alert color="red" variant="light" role="alert">{INCOMPLETE_LINK}</Alert></AuthCard>;
  }
  return (
    <AuthCard title="Set up your account" footer={back}>
      <SetPasswordForm
        hint="You have been invited. Choose a password to finish setting up your account."
        onSubmit={async (password) => {
          const res = await api<{ user: Actor }>('POST', '/api/auth/accept-invite', { token, password });
          setUser(res.user);
          void navigate('/notes', { replace: true });
        }}
      />
    </AuthCard>
  );
}
