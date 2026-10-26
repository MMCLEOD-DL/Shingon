import type { ReactNode } from 'react';
import { Stack, Text, Title } from '@mantine/core';

export function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <Stack align="center" gap="xs" py="xl" ta="center" maw={420} mx="auto">
      <Title order={2} size="h3">{title}</Title>
      {body ? <Text c="dimmed">{body}</Text> : null}
      {action ? <div style={{ marginTop: 8 }}>{action}</div> : null}
    </Stack>
  );
}
