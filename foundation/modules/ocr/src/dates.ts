/** Dates on a receipt, read in UK order (day first) and returned as YYYY-MM-DD. Days that don't exist are dropped. */

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

const ISO = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g;
// dd/mm/yyyy, dd/mm/yy, dd-mm-yyyy, dd.mm.yy (the same separator twice).
const NUMERIC = /(?<![\d/.-])(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})(?!\d)(?![/.-]\d)/g;
// 2 March 2026, 2 Mar 2026, 2nd Mar. 2026
const NAMED = /(?<!\d)(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})(?!\d)/g;

function iso(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Every real date on the line, in the order they appear. */
export function findDates(text: string): string[] {
  const found: { at: number; value: string }[] = [];
  const add = (at: number, value: string | null): void => {
    if (value !== null) found.push({ at, value });
  };
  for (const m of text.matchAll(ISO)) add(m.index, iso(Number(m[1]), Number(m[2]), Number(m[3])));
  for (const m of text.matchAll(NUMERIC)) {
    const year = m[4] ?? '';
    add(m.index, iso(year.length === 2 ? 2000 + Number(year) : Number(year), Number(m[3]), Number(m[1])));
  }
  for (const m of text.matchAll(NAMED)) {
    const month = MONTHS[(m[2] ?? '').toLowerCase()];
    if (month !== undefined) add(m.index, iso(Number(m[3]), month, Number(m[1])));
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.value);
}

/** Whole days from `a` to `b` (both YYYY-MM-DD); positive when `b` is later. */
export function daysBetween(a: string, b: string): number {
  const day = (s: string): number => {
    const [y = 0, m = 1, d = 1] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d) / 86_400_000;
  };
  return day(b) - day(a);
}

const TIME = /(?<![\d.:])\d{1,2}[:.]\d{2}(?::\d{2})?\s*(?:am|pm)?(?![\d.:])/gi;

/** The line with its dates and times taken out, leaving any label ("Sell by", "Invoice date"). */
export function withoutDatesAndTimes(text: string): string {
  return text.replace(ISO, ' ').replace(NUMERIC, ' ').replace(NAMED, (m, _d, month: string) => (MONTHS[month.toLowerCase()] === undefined ? m : ' ')).replace(TIME, ' ');
}
