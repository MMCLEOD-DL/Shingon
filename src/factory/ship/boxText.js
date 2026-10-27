// Ruling S9 / S12: anything Conductor keeps or prints from a box (or a build machine, or ssh itself) loses terminal
// control characters and secrets first. The one copy of these helpers for the ship modules.
import { redact } from '../../secrets.js';
import { terminalText } from '../brief.js';

/** Control characters stripped, secrets redacted, cut to `max` characters. */
export const clean = (s, max = Infinity) => String(redact(terminalText(s))).slice(0, max);

const lines = (s) => clean(s).split('\n').map((l) => l.trim()).filter(Boolean);
const shorten = (line, max) => line.slice(0, max).replace(/[.\s]+$/, '');

/** The first non-empty line, cleaned, cut to `max` and without a trailing full stop (callers add their own). */
export const firstLine = (s, max = 160) => shorten(lines(s)[0] ?? '', max);

/** The last non-empty line, the same way. */
export const lastLine = (s, max = 160) => shorten(lines(s).at(-1) ?? '', max);
