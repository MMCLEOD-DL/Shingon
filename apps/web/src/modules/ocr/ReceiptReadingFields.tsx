import { useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Alert, Button, Checkbox, Group, Stack, Text, TextInput } from '@mantine/core';
import { IconAlertTriangle, IconCircleCheck, IconInfoCircle } from '@tabler/icons-react';
import { CONFIDENT, ConfirmReadingInput, formatPounds, toPence, type Pence, type ReadingView, type Scored } from '@hf/shared';
import { confirmReading } from '../../api.js';
import { ErrorNotice } from '../../ui/index.js';

const AMOUNT_HELP = 'Enter an amount like 12.40.';
const VAT_HELP = 'Enter the VAT, like 2.07, or tick "No VAT shown".';
const TOO_LARGE = 'That amount is too large.';
const NOT_NEGATIVE = 'Enter the total as a positive amount.';
const MERCHANT_HELP = 'Enter the shop or supplier.';
const MERCHANT_LONG = 'Use at most 120 characters.';

type Field = 'amount' | 'vat' | 'date' | 'merchant';
const FIELD_ORDER: readonly Field[] = ['amount', 'vat', 'date', 'merchant'];
type Errors = Partial<Record<Field, string>>;

/** Pence as typed in a field: 1240 → "12.40" (the shared formatter, without the pound sign). */
const asTyped = (p: Pence | null | undefined): string => (p === null || p === undefined ? '' : formatPounds(p).replace('£', ''));

function startingValues(r: ReadingView) {
  if (r.status === 'confirmed' && r.confirmed) {
    const c = r.confirmed;
    return { amount: asTyped(c.amountPence), vat: asTyped(c.vatPence), noVat: c.vatPence === null, date: c.date, merchant: c.merchant };
  }
  const p = r.proposal;
  return {
    amount: asTyped(p?.amountPence?.value),
    vat: asTyped(p?.vatPence?.value),
    noVat: p?.vatPence !== null && p?.vatPence !== undefined && p.vatPence.value === null,
    date: p?.date?.value ?? '',
    merchant: p?.merchant?.value ?? '',
  };
}

/** Checks the typed values as the server will; the VAT-above-total sentence is the shared schema's own. */
function check(v: ReturnType<typeof startingValues>): { input: ConfirmReadingInput } | { errors: Errors } {
  const errors: Errors = {};
  const pence = (field: 'amount' | 'vat', text: string): Pence | undefined => {
    if (text.trim() === '') {
      errors[field] = field === 'vat' ? VAT_HELP : AMOUNT_HELP;
      return undefined;
    }
    try {
      return toPence(text);
    } catch {
      errors[field] = AMOUNT_HELP;
      return undefined;
    }
  };
  const amountPence = pence('amount', v.amount);
  const vatPence = v.noVat ? null : pence('vat', v.vat);
  if (Object.keys(errors).length > 0) return { errors };
  const parsed = ConfirmReadingInput.safeParse({ amountPence, vatPence, date: v.date, merchant: v.merchant });
  if (parsed.success) return { input: parsed.data };
  for (const issue of parsed.error.issues) {
    const at = issue.path[0];
    // A refund typed as a minus amount gets its own sentence; zero is not an amount.
    if (at === 'amountPence') errors.amount ??= issue.code === 'too_big' ? TOO_LARGE : amountPence !== undefined && amountPence < 0 ? NOT_NEGATIVE : AMOUNT_HELP;
    else if (at === 'vatPence') errors.vat ??= issue.code === 'custom' ? issue.message : AMOUNT_HELP;
    else if (at === 'date') errors.date ??= issue.message;
    else if (at === 'merchant') errors.merchant ??= issue.code === 'too_big' ? MERCHANT_LONG : MERCHANT_HELP;
  }
  return { errors };
}

function PleaseCheck() {
  return (
    <Group component="span" gap={4} wrap="nowrap">
      <IconAlertTriangle size={14} aria-hidden="true" />
      <span>Please check</span>
    </Group>
  );
}

const checkStyles = { description: { color: 'var(--mantine-color-orange-9)', fontWeight: 600, fontSize: 'var(--mantine-font-size-sm)' } };

/**
 * The "confirm or correct" pattern (Plan 12 Ruling 1): the reading's proposal arrives pre-filled, fields it is unsure of
 * say "Please check", and nothing is saved until the person presses Confirm. Client features copy this component.
 */
export function ReceiptReadingFields({ reading, canConfirm, onConfirmed }: {
  reading: ReadingView;
  /** The owner (or an admin) may confirm; anyone else who can see the reading sees it read-only. */
  canConfirm: boolean;
  onConfirmed: (r: ReadingView) => void;
}) {
  const [done, setDone] = useState<ReadingView | null>(null);
  const shown = done ?? reading;
  const [values, setValues] = useState(() => startingValues(reading));
  const [errors, setErrors] = useState<Errors>({});
  const formRef = useRef<HTMLFormElement>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const confirmed = shown.status === 'confirmed';
  const readOnly = confirmed || !canConfirm;
  const proposal = shown.proposal;
  const marks = shown.status === 'read' && !readOnly;
  const unsure = (f: Scored<unknown> | null | undefined): boolean => marks && (!f || f.confidence < CONFIDENT);
  const set = (field: keyof typeof values) => (value: string | boolean) => {
    setValues((v) => ({ ...v, [field]: value }));
    if (field !== 'noVat') setErrors((e) => ({ ...e, [field]: undefined }));
    else setErrors((e) => ({ ...e, vat: undefined }));
  };

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    const result = check(values);
    if ('errors' in result) {
      setErrors(result.errors);
      // Take the person to the first field that needs fixing (on a phone it may be off the screen).
      const first = FIELD_ORDER.find((f) => result.errors[f] !== undefined);
      if (first) formRef.current?.querySelector<HTMLInputElement>(`[data-field="${first}"] input`)?.focus();
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const saved = await confirmReading(shown.id, result.input);
      setDone(saved);
      setValues(startingValues(saved));
      onConfirmed(saved);
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  };

  const field = (label: string, key: 'amount' | 'vat' | 'date' | 'merchant', extra: { needsCheck: boolean; money?: boolean; type?: string; disabled?: boolean }): ReactNode => (
    <TextInput
      label={label}
      size="md"
      type={extra.type ?? 'text'}
      inputMode={extra.money ? 'decimal' : undefined}
      autoComplete="off"
      value={values[key]}
      onChange={(ev) => { set(key)(ev.currentTarget.value); }}
      readOnly={readOnly}
      disabled={extra.disabled === true}
      error={errors[key]}
      description={extra.needsCheck ? <PleaseCheck /> : undefined}
      styles={checkStyles}
      wrapperProps={{ 'data-field': key }}
    />
  );

  return (
    <form ref={formRef} onSubmit={(e) => { void submit(e); }} noValidate>
      <Stack gap="md" maw={560}>
        {confirmed ? (
          <Alert color="green" variant="light" icon={<IconCircleCheck size={18} />} role="status">Receipt confirmed.</Alert>
        ) : null}
        {shown.status === 'unreadable' ? (
          <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={18} />}>
            <Text size="sm">{shown.problem ?? "We couldn't read this receipt."}</Text>
            <Text size="sm">Type the details below.</Text>
          </Alert>
        ) : null}
        {!confirmed && proposal && proposal.warnings.length > 0 ? (
          <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={18} />}>
            {proposal.warnings.map((w) => <Text size="sm" key={w}>{w}</Text>)}
          </Alert>
        ) : null}
        {!confirmed && !canConfirm ? (
          <Alert color="blue" variant="light" icon={<IconInfoCircle size={18} />}>Only the person who uploaded this receipt can confirm it.</Alert>
        ) : null}
        {field('Total', 'amount', { needsCheck: unsure(proposal?.amountPence), money: true })}
        <Stack gap="xs">
          {/* The badge stays whatever the box says: a "no VAT shown" proposal is a guess too (Ruling 1). */}
          {field('VAT', 'vat', { needsCheck: unsure(proposal?.vatPence), money: true, disabled: values.noVat && !readOnly })}
          <Checkbox
            label="No VAT shown"
            size="xl"
            styles={{ label: { fontSize: 'var(--mantine-font-size-md)' } }}
            checked={values.noVat}
            disabled={readOnly}
            onChange={(ev) => { set('noVat')(ev.currentTarget.checked); }}
          />
        </Stack>
        {field('Date', 'date', { needsCheck: unsure(proposal?.date), type: 'date' })}
        {field('Shop or supplier', 'merchant', { needsCheck: unsure(proposal?.merchant) })}
        <ErrorNotice error={failure} />
        {readOnly ? null : (
          <Group>
            <Button type="submit" size="md" loading={busy}>Confirm</Button>
          </Group>
        )}
      </Stack>
    </form>
  );
}
