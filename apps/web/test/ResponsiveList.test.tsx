import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { ResponsiveList } from '../src/ui/index.js';
import { theme } from '../src/theme.js';
import { setMobile } from './setup.js';

const items = [{ id: '1', title: 'Taxi', amount: '£12.40' }];
const ui = () => render(<MantineProvider theme={theme}><ResponsiveList items={items} cardTitle={(i) => i.title}
  columns={[{ key: 'title', label: 'Title', render: (i) => i.title }, { key: 'amount', label: 'Amount', render: (i) => i.amount }]}
  empty={<p>Nothing yet</p>} /></MantineProvider>);

test('a table on desktop', () => { setMobile(false); ui(); expect(screen.getByRole('table')).toBeInTheDocument(); });
test('cards on a phone, with labels', () => {
  setMobile(true); ui();
  expect(screen.queryByRole('table')).toBeNull();
  expect(screen.getByText('Amount')).toBeInTheDocument();
  expect(screen.getByText('£12.40')).toBeInTheDocument();
});
test('the empty state shows when there is nothing', () => {
  setMobile(false);
  render(<MantineProvider theme={theme}><ResponsiveList items={[]} cardTitle={() => ''} columns={[]} empty={<p>Nothing yet</p>} /></MantineProvider>);
  expect(screen.getByText('Nothing yet')).toBeInTheDocument();
});
