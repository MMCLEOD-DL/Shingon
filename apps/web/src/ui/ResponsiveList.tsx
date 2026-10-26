import type { KeyboardEvent, ReactNode } from 'react';
import { Card, Group, Stack, Table, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';

/** cardHidden: left out of the phone cards, for a column the card title already shows. */
export interface Column<T> { key: string; label: string; render: (item: T) => ReactNode; cardHidden?: boolean }

function activate(e: KeyboardEvent, open: () => void) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    open();
  }
}

/** A table from the sm breakpoint up, a stack of labelled cards on a phone. */
export function ResponsiveList<T extends { id: string | number }>({ items, columns, cardTitle, empty, onOpen }: {
  items: readonly T[];
  columns: readonly Column<T>[];
  cardTitle: (item: T) => ReactNode;
  empty: ReactNode;
  onOpen?: (item: T) => void;
}) {
  const mobile = useMediaQuery('(max-width: 48em)', false, { getInitialValueInEffect: false });
  if (items.length === 0) return <>{empty}</>;

  if (mobile) {
    return (
      <Stack gap="sm">
        {items.map((item) => (
          <Card
            key={item.id}
            withBorder
            padding="md"
            {...(onOpen ? { role: 'button', tabIndex: 0, onClick: () => { onOpen(item); }, onKeyDown: (e: KeyboardEvent) => { activate(e, () => { onOpen(item); }); }, style: { cursor: 'pointer' } } : {})}
          >
            <Text fw={600} mb="xs">{cardTitle(item)}</Text>
            <Stack gap={6}>
              {columns.filter((c) => !c.cardHidden).map((c) => (
                <Group key={c.key} justify="space-between" align="flex-start" wrap="nowrap" gap="md">
                  <Text size="sm" c="dimmed">{c.label}</Text>
                  <Text size="sm" ta="right" component="div" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{c.render(item)}</Text>
                </Group>
              ))}
            </Stack>
          </Card>
        ))}
      </Stack>
    );
  }

  return (
    <Table.ScrollContainer minWidth={480}>
      <Table highlightOnHover={onOpen !== undefined} verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>{columns.map((c) => <Table.Th key={c.key}>{c.label}</Table.Th>)}</Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {items.map((item) => (
            <Table.Tr
              key={item.id}
              {...(onOpen ? { tabIndex: 0, onClick: () => { onOpen(item); }, onKeyDown: (e: KeyboardEvent) => { activate(e, () => { onOpen(item); }); }, style: { cursor: 'pointer' } } : {})}
            >
              {columns.map((c) => <Table.Td key={c.key}>{c.render(item)}</Table.Td>)}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
