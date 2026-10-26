import { notifications } from '@mantine/notifications';

export function notifySaved(message = 'Saved.'): void {
  notifications.show({ message, color: 'teal', autoClose: 3000 });
}

export function notifyError(err: unknown): void {
  const message = err instanceof Error && err.message !== '' ? err.message : 'Something went wrong. Please try again.';
  notifications.show({ title: 'That did not work', message, color: 'red', autoClose: 7000 });
}
