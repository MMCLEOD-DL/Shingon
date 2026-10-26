import { Alert } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';

/** Shows the server's own plain-English message (or the network message) for a failed call. */
export function ErrorNotice({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  const message = error instanceof Error && error.message !== '' ? error.message : 'Something went wrong. Please try again.';
  return (
    <Alert color="red" variant="light" icon={<IconAlertCircle size={18} />} role="alert">
      {message}
    </Alert>
  );
}
