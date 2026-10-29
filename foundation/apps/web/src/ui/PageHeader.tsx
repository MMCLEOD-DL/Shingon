import type { ReactNode } from 'react';
import { Box, Group, Text, Title } from '@mantine/core';

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm" mb="lg">
      <Box style={{ flex: '1 1 16rem', minWidth: 0 }}>
        <Title order={1} size="h2">{title}</Title>
        {description ? <Text c="dimmed" mt={4}>{description}</Text> : null}
      </Box>
      {actions ? <Group gap="sm">{actions}</Group> : null}
    </Group>
  );
}
