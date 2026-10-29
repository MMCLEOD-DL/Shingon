/**
 * How ops shows a moment to people: always Europe/London wall-clock time, in UK English. Every ops message (restore,
 * update, checks, the monitor, the CLI) formats times through here, so they all read the same.
 */
const LONG = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/London' });
const CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });

/** "26 October 2026 at 14:05" (Europe/London). */
export const ukDate = (d: Date): string => LONG.format(d);

/** "14:05" (Europe/London). */
export const ukTime = (d: Date): string => CLOCK.format(d);
