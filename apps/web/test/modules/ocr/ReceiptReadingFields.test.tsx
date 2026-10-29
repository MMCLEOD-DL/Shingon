import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ReceiptReadingFields } from '../../../src/modules/ocr/index.js';
import { Wrap, user } from '../../helpers.js';
import { Refusal, confirmedView, fieldOf, mockApi, pendingView, readWith, resetApi } from './testHelpers.js';

afterEach(() => { vi.unstubAllGlobals(); resetApi(); });

const show = (ui: React.ReactNode) => render(<Wrap>{ui}</Wrap>);

test('fields arrive pre-filled; low-confidence ones say Please check', () => {
  show(<ReceiptReadingFields reading={readWith({ amount: [1240, 0.97], vat: [270, 0.5], date: ['2026-03-12', 0.95], merchant: ['Northside Taxis', 0.6] })} canConfirm onConfirmed={vi.fn()} />);
  expect(screen.getByLabelText('Total')).toHaveValue('12.40');
  expect(screen.getByLabelText('VAT')).toHaveValue('2.70');
  expect(screen.getByLabelText('Date')).toHaveValue('2026-03-12');
  expect(screen.getByLabelText('Shop or supplier')).toHaveValue('Northside Taxis');
  expect(within(fieldOf('VAT')).getByText('Please check')).toBeVisible();
  expect(within(fieldOf('Shop or supplier')).getByText('Please check')).toBeVisible();
  expect(within(fieldOf('Total')).queryByText('Please check')).toBeNull();
  expect(within(fieldOf('Date')).queryByText('Please check')).toBeNull();
  // Amounts open the number pad with a decimal point on a phone.
  expect(screen.getByLabelText('Total')).toHaveAttribute('inputmode', 'decimal');
});

test('a field exactly at the confidence line is shown as read, and a missing field says Please check', () => {
  show(<ReceiptReadingFields reading={readWith({ amount: [1240, 0.85], date: ['2026-03-12', 0.95], merchant: ['Northside Taxis', 0.9] })} canConfirm onConfirmed={vi.fn()} />);
  expect(within(fieldOf('Total')).queryByText('Please check')).toBeNull();
  expect(screen.getByLabelText('VAT')).toHaveValue('');
  expect(within(fieldOf('VAT')).getByText('Please check')).toBeVisible();
});

test('nothing is saved until Confirm, and the corrected values are what is sent', async () => {
  const confirm = mockApi('confirmReading', confirmedView());
  const onConfirmed = vi.fn();
  show(<ReceiptReadingFields reading={readWith({ amount: [1240, 0.97], vat: [270, 0.5], date: ['2026-03-12', 0.95], merchant: ['Northside Taxis', 0.6] })} canConfirm onConfirmed={onConfirmed} />);
  await user.clear(screen.getByLabelText('VAT'));
  await user.type(screen.getByLabelText('VAT'), '2.07');
  expect(confirm).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(confirm).toHaveBeenCalledWith('r1', { amountPence: 1240, vatPence: 207, date: '2026-03-12', merchant: 'Northside Taxis' });
  expect(await screen.findByText('Receipt confirmed.')).toBeVisible();
  expect(onConfirmed).toHaveBeenCalledWith(confirmedView());
  expect(screen.getByLabelText('VAT')).toHaveAttribute('readonly');
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
});

test('"No VAT shown" sends no VAT', async () => {
  const confirm = mockApi('confirmReading', confirmedView());
  show(<ReceiptReadingFields reading={readWith({ amount: [320, 0.97], vat: [50, 0.4], date: ['2026-03-02', 0.95], merchant: ['Fictional Rail', 0.9] })} canConfirm onConfirmed={vi.fn()} />);
  await user.click(screen.getByLabelText('No VAT shown'));
  expect(screen.getByLabelText('VAT')).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(confirm).toHaveBeenCalledWith('r1', expect.objectContaining({ amountPence: 320, vatPence: null }));
});

test('a reading that found "no VAT" arrives with the box ticked and still says Please check', () => {
  // The extractor scores "no VAT shown" at 0.7 (NO_VAT_SHOWN), below CONFIDENT: a guess the person must check (Ruling 1).
  show(<ReceiptReadingFields reading={readWith({ amount: [320, 0.97], vat: [null, 0.7], date: ['2026-03-02', 0.95], merchant: ['Fictional Rail', 0.9] })} canConfirm onConfirmed={vi.fn()} />);
  expect(screen.getByLabelText('No VAT shown')).toBeChecked();
  expect(screen.getByLabelText('VAT')).toBeDisabled();
  expect(within(fieldOf('VAT')).getByText('Please check')).toBeVisible();
});

test('the reading\'s warnings are shown above the fields', () => {
  const reading = readWith({ amount: [1240, 0.6] });
  reading.proposal!.warnings = ['This receipt may not be in pounds.', 'The date is in the future.'];
  show(<ReceiptReadingFields reading={reading} canConfirm onConfirmed={vi.fn()} />);
  const first = screen.getByText('This receipt may not be in pounds.');
  expect(screen.getByText('The date is in the future.')).toBeVisible();
  expect(first.compareDocumentPosition(screen.getByLabelText('Total')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test('an unreadable receipt shows the reason and an empty form that still works', async () => {
  const confirm = mockApi('confirmReading', confirmedView());
  const reading = readWith({}, { status: 'unreadable', proposal: null, problem: "We couldn't read this photo. iPhone HEIC photos can't be read here." });
  show(<ReceiptReadingFields reading={reading} canConfirm onConfirmed={vi.fn()} />);
  const problem = screen.getByText("We couldn't read this photo. iPhone HEIC photos can't be read here.");
  const next = screen.getByText('Type the details below.');
  expect(problem.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  for (const label of ['Total', 'VAT', 'Date', 'Shop or supplier']) expect(screen.getByLabelText(label)).toHaveValue('');
  // An empty form is not a list of "Please check" badges: the sentence above says what to do.
  expect(screen.queryByText('Please check')).toBeNull();
  await user.type(screen.getByLabelText('Total'), '£8.75');
  await user.type(screen.getByLabelText('VAT'), '1.46');
  await user.type(screen.getByLabelText('Date'), '2026-03-05');
  await user.type(screen.getByLabelText('Shop or supplier'), 'Corner Café');
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(confirm).toHaveBeenCalledWith('r1', { amountPence: 875, vatPence: 146, date: '2026-03-05', merchant: 'Corner Café' });
});

test('an amount that is not pounds and pence is caught before sending', async () => {
  const confirm = mockApi('confirmReading', confirmedView());
  show(<ReceiptReadingFields reading={readWith({ amount: [1240, 0.97], vat: [207, 0.9], date: ['2026-03-12', 0.95], merchant: ['Northside Taxis', 0.9] })} canConfirm onConfirmed={vi.fn()} />);
  await user.clear(screen.getByLabelText('Total'));
  await user.type(screen.getByLabelText('Total'), '12,4o');
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(within(fieldOf('Total')).getByText('Enter an amount like 12.40.')).toBeVisible();
  // The person is taken to the field to fix.
  expect(screen.getByLabelText('Total')).toHaveFocus();
  expect(confirm).not.toHaveBeenCalled();
});

test('a minus total asks for a positive amount; focus goes to the first field with a problem', async () => {
  const confirm = mockApi('confirmReading', confirmedView());
  show(<ReceiptReadingFields reading={readWith({ amount: [1240, 0.97], vat: [207, 0.9], date: ['2026-03-12', 0.95], merchant: ['Northside Taxis', 0.9] })} canConfirm onConfirmed={vi.fn()} />);
  await user.clear(screen.getByLabelText('Total'));
  await user.type(screen.getByLabelText('Total'), '-5.00');
  await user.clear(screen.getByLabelText('Shop or supplier'));
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(within(fieldOf('Total')).getByText('Enter the total as a positive amount.')).toBeVisible();
  expect(within(fieldOf('Shop or supplier')).getByText('Enter the shop or supplier.')).toBeVisible();
  expect(screen.getByLabelText('Total')).toHaveFocus();
  expect(confirm).not.toHaveBeenCalled();
});

test('VAT above the total is caught before sending, with the server\'s sentence', async () => {
  const confirm = mockApi('confirmReading', confirmedView());
  show(<ReceiptReadingFields reading={readWith({ amount: [1240, 0.97], vat: [207, 0.9], date: ['2026-03-12', 0.95], merchant: ['Northside Taxis', 0.9] })} canConfirm onConfirmed={vi.fn()} />);
  await user.clear(screen.getByLabelText('VAT'));
  await user.type(screen.getByLabelText('VAT'), '13.00');
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(within(fieldOf('VAT')).getByText("The VAT can't be more than the total.")).toBeVisible();
  expect(screen.getByLabelText('VAT')).toHaveFocus();
  expect(confirm).not.toHaveBeenCalled();
});

test('a refusal from the server is shown in its own words and the form stays open', async () => {
  mockApi('confirmReading', new Refusal(409, 'This receipt has already been confirmed.'));
  show(<ReceiptReadingFields reading={readWith({ amount: [1240, 0.97], vat: [207, 0.9], date: ['2026-03-12', 0.95], merchant: ['Northside Taxis', 0.9] })} canConfirm onConfirmed={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(await screen.findByText('This receipt has already been confirmed.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();
  expect(screen.queryByText('Receipt confirmed.')).toBeNull();
});

test('a manager sees read-only fields and the explanation, with no Confirm button', () => {
  show(<ReceiptReadingFields reading={readWith({ amount: [1240, 0.97], vat: [270, 0.5], date: ['2026-03-12', 0.95], merchant: ['Northside Taxis', 0.6] })} canConfirm={false} onConfirmed={vi.fn()} />);
  expect(screen.getByText('Only the person who uploaded this receipt, or an admin, can confirm it.')).toBeVisible();
  for (const label of ['Total', 'VAT', 'Date', 'Shop or supplier']) expect(screen.getByLabelText(label)).toHaveAttribute('readonly');
  expect(screen.getByLabelText('Total')).toHaveValue('12.40');
  expect(screen.getByLabelText('No VAT shown')).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
});

test('a confirmed reading is shown read-only', () => {
  show(<ReceiptReadingFields reading={confirmedView()} canConfirm onConfirmed={vi.fn()} />);
  expect(screen.getByText('Receipt confirmed.')).toBeVisible();
  // The confirmed values, not the proposal, are shown.
  expect(screen.getByLabelText('VAT')).toHaveValue('2.07');
  for (const label of ['Total', 'VAT', 'Date', 'Shop or supplier']) expect(screen.getByLabelText(label)).toHaveAttribute('readonly');
  expect(screen.queryByText('Please check')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
});

test('a reading still pending (the page stopped waiting) can be typed in and confirmed, with no Please check marks', async () => {
  const confirm = mockApi('confirmReading', confirmedView());
  show(<ReceiptReadingFields reading={pendingView()} canConfirm onConfirmed={vi.fn()} />);
  expect(screen.queryByText('Please check')).toBeNull();
  await user.type(screen.getByLabelText('Total'), '12.40');
  await user.type(screen.getByLabelText('VAT'), '2.07');
  await user.type(screen.getByLabelText('Date'), '2026-03-12');
  await user.type(screen.getByLabelText('Shop or supplier'), 'Northside Taxis');
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(confirm).toHaveBeenCalledWith('r1', { amountPence: 1240, vatPence: 207, date: '2026-03-12', merchant: 'Northside Taxis' });
});
