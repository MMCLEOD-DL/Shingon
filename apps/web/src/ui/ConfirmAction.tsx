import { useState } from 'react';
import { Button, Group, Modal, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { ErrorNotice } from './ErrorNotice.js';

/** A button that asks first. The dialog stays open, with the reason, if the action fails. */
export function ConfirmAction({ label, confirmTitle, confirmBody, color = 'red', onConfirm }: {
  label: string;
  confirmTitle: string;
  confirmBody: string;
  color?: string;
  onConfirm: () => unknown;
}) {
  const [opened, { open, close }] = useDisclosure(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      close();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button color={color} variant="light" onClick={() => { setError(null); open(); }}>{label}</Button>
      <Modal opened={opened} onClose={close} title={confirmTitle} centered>
        <Text mb="md">{confirmBody}</Text>
        <ErrorNotice error={error} />
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={close} disabled={busy}>Cancel</Button>
          <Button color={color} loading={busy} onClick={() => { void run(); }}>{label}</Button>
        </Group>
      </Modal>
    </>
  );
}
