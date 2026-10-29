/**
 * The page to go to after signing in. Only a path on this site is accepted: it must start with a single "/"
 * (not "//" or "/\\", which browsers read as another site), carry no scheme and no control characters.
 * Anything else, including a missing value, goes to the fallback.
 */
export function safeNext(next: string | null | undefined, fallback = '/'): string {
  if (typeof next !== 'string' || next === '') return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return fallback;
  try {
    const base = 'http://app.invalid';
    if (new URL(next, base).origin !== base) return fallback;
  } catch {
    return fallback;
  }
  return next;
}
