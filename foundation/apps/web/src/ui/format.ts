const FORMAT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' });

/** Times are stored in UTC and always shown in London time. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : FORMAT.format(d);
}

/** A file size for people: "820 KB", "1.4 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1048576) return `${String(Math.round(bytes / 1024))} KB`;
  const mb = bytes / 1048576;
  return `${mb >= 10 ? String(Math.round(mb)) : mb.toFixed(1)} MB`;
}
