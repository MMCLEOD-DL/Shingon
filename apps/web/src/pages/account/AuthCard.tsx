import type { ReactNode } from 'react';
import { Box, Card, Center, Stack, Text, Title } from '@mantine/core';
import { BRAND } from '../../brand.js';

/** The frame every signed-out page shares: the app name, then one calm card (full width on a phone, 420 px at most). */
export function AuthCard({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <Center mih="100dvh" px="md" py="xl" style={{ alignItems: 'flex-start' }}>
      <Box w="100%" maw={420} pt={{ base: 'md', sm: 60 }}>
        <Stack gap="lg">
          <Text ta="center" fw={650} size="xl" c="highland">{BRAND.appName}</Text>
          <Card withBorder padding="lg" radius="md" component="main">
            <Title order={1} size="h3" mb="md">{title}</Title>
            {children}
          </Card>
          {footer !== undefined && <Text ta="center" size="sm">{footer}</Text>}
        </Stack>
      </Box>
    </Center>
  );
}

