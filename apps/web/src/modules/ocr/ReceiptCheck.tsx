import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Alert, Button, Center, Container, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { ReadingView } from '@hf/shared';
import { getFile } from '../../api.js';
import { useAuth } from '../../auth.js';
import { ErrorNotice, FilePreview, PageHeader } from '../../ui/index.js';
import { ReceiptReadingFields } from './ReceiptReadingFields.js';
import { useReading } from './useReading.js';

/** Example page: the photo, then the reading's fields to check, correct and confirm. */
export function ReceiptCheck() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const { reading, error } = useReading(id);
  const [confirmed, setConfirmed] = useState<ReadingView | null>(null);
  const shown = confirmed?.id === id ? confirmed : reading;
  const fileId = shown?.fileId;
  const file = useQuery({ queryKey: ['file', fileId], enabled: fileId !== undefined, queryFn: () => getFile(fileId ?? '') });
  const canConfirm = user !== null && shown !== undefined && (shown.ownerId === user.id || user.role === 'admin');

  let body;
  if (!shown && error) {
    body = (
      <Stack gap="md" align="flex-start">
        <ErrorNotice error={error} />
        <Button component={Link} to="/receipts/new" variant="default">Read a receipt</Button>
      </Stack>
    );
  } else if (!shown) {
    body = <Center py="xl"><Loader aria-label="Loading" /></Center>;
  } else if (shown.status === 'pending' && !error) {
    body = (
      <Paper withBorder p="md" radius="md" role="status">
        <Group gap="sm"><Loader size="sm" /><Text>Reading your receipt…</Text></Group>
      </Paper>
    );
  } else {
    body = (
      <Stack gap="md">
        {error ? <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={18} />}>{error instanceof Error ? error.message : ''}</Alert> : null}
        {/* Remounted when the reading's state changes, so the fields start from what was read. */}
        <ReceiptReadingFields key={`${shown.id}:${shown.status}`} reading={shown} canConfirm={canConfirm} onConfirmed={setConfirmed} />
      </Stack>
    );
  }

  return (
    <Container size="md" p={0}>
      <PageHeader title="Check the details" />
      <Stack gap="md" maw={560}>
        {file.data ? <FilePreview file={file.data} /> : null}
        {body}
      </Stack>
    </Container>
  );
}
