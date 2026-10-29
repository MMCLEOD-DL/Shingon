/**
 * Money is whole pence everywhere (Plan 12 Ruling 3). These helpers never use fractions of a penny,
 * so totals add up exactly: 10p + 20p is always 30p.
 */

/** An amount in whole pence: always a safe integer. */
export type Pence = number;

export class MoneyError extends Error {
  /** The sentence staff or the operator may see. */
  readonly userMessage: string;
  constructor(userMessage: string) {
    super(userMessage);
    this.name = 'MoneyError';
    this.userMessage = userMessage;
  }
}

// An optional minus (hyphen or U+2212), an optional £, whole pounds (plain, or grouped in threes by commas)
// and up to two decimal places.
const POUNDS = /^([-−])?£?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

/** Reads an amount in pounds ('12.40', '£1,234.56', '-5.00') as whole pence. */
export function toPence(text: string): Pence {
  const m = POUNDS.exec(text.trim());
  if (!m) throw new MoneyError('That is not an amount in pounds and pence, like 12.40.');
  const [, minus, pounds = '', pence = ''] = m;
  const n = Number(pounds.replaceAll(',', '') + pence.padEnd(2, '0'));
  if (!Number.isSafeInteger(n)) throw new MoneyError('That amount is too large.');
  return minus !== undefined && n !== 0 ? -n : n;
}

const checkPence = (p: number): void => {
  if (!Number.isSafeInteger(p)) throw new MoneyError('An amount of money must be a whole number of pence.');
};

/** 1240 -> '£12.40'; 123456 -> '£1,234.56'; -500 -> '−£5.00' (a true minus sign, U+2212). */
export function formatPounds(p: Pence): string {
  checkPence(p);
  const abs = Math.abs(p);
  const pounds = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+$)/g, ',');
  const pence = String(abs % 100).padStart(2, '0');
  return `${p < 0 ? '−' : ''}£${pounds}.${pence}`;
}

/** Adds amounts of pence; refuses a fraction of a penny or a total too large to hold exactly. */
export function sumPence(values: readonly Pence[]): Pence {
  let total = 0;
  for (const v of values) {
    checkPence(v);
    total += v;
    if (!Number.isSafeInteger(total)) throw new MoneyError('The total is too large.');
  }
  return total;
}

/**
 * The VAT inside a gross (VAT-inclusive) amount: gross × rate ÷ (1 + rate), rounded half up, in integers only.
 * The rate is in basis points (20% = 2000). £12.40 at 20% gives £2.07.
 */
export function vatFromGross(gross: Pence, rateBasisPoints: number): Pence {
  checkPence(gross);
  if (!Number.isSafeInteger(rateBasisPoints) || rateBasisPoints < 0) throw new MoneyError('A VAT rate must be a whole number of basis points, 0 or more.');
  if (gross < 0) {
    const vat = vatFromGross(-gross, rateBasisPoints);
    return vat === 0 ? 0 : -vat;
  }
  const n = gross * rateBasisPoints;
  const d = 10000 + rateBasisPoints;
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(2 * n + d)) throw new MoneyError('That amount is too large to work out its VAT.');
  return Math.floor((2 * n + d) / (2 * d));
}
