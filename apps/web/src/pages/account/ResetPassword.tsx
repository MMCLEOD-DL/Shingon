import { Link, useNavigate } from 'react-router';
import { Alert, Anchor } from '@mantine/core';
import { api } from '../../api.js';
import { notifySaved } from '../../ui/index.js';
import { AuthCard } from './AuthCard.js';
import { SetPasswordForm } from './SetPasswordForm.js';
import { useLinkToken } from './useLinkToken.js';

export const INCOMPLETE_LINK = 'This link is incomplete. Open the link from your email again.';

export function ResetPassword() {
  const token = useLinkToken();
  const navigate = useNavigate();
  const back = <Anchor component={Link} to="/sign-in">Back to sign in</Anchor>;

  if (token === '') {
    return <AuthCard title="Choose a new password" footer={back}><Alert color="red" variant="light" role="alert">{INCOMPLETE_LINK}</Alert></AuthCard>;
  }
  return (
    <AuthCard title="Choose a new password" footer={back}>
      <SetPasswordForm
        hint="Pick something you have not used elsewhere. Changing it signs you out on every device."
        onSubmit={async (password) => {
          await api('POST', '/api/auth/reset-password', { token, password });
          notifySaved('Your password has been changed. Please sign in.');
          void navigate('/sign-in', { replace: true });
        }}
      />
    </AuthCard>
  );
}
