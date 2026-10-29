import type { ReactNode } from 'react';
import { Card, Title } from '@mantine/core';

export function FormCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card withBorder padding="lg" maw={560} w="100%">
      <Title order={2} size="h3" mb="md">{title}</Title>
      {children}
    </Card>
  );
}
