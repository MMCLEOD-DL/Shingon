/**
 * The one plain line printed when the app cannot start. No stack trace, and never the error text itself: database
 * messages can contain connection details. The advice depends on what failed: setting up the database, or listening.
 */
export function startFailure(stage: { setup: true } | { listen: number }, e: unknown): string {
  const raw = (e as { code?: unknown } | null)?.code;
  const code = typeof raw === 'string' ? raw : undefined;
  if ('setup' in stage) {
    return `The app could not start: it could not set up the database or the web server${code ? ` (${code})` : ''}. Check the database address and that the database is running.`;
  }
  const port = String(stage.listen);
  if (code === 'EADDRINUSE') return `The app could not start: port ${port} is already in use by another program. Stop that program, or set PORT to a free port.`;
  if (code === 'EACCES') return `The app could not start: it is not allowed to listen on port ${port}. Use a port above 1024 (set PORT), or run it the way the bundle does.`;
  return `The app could not start: it could not listen on port ${port}${code ? ` (${code})` : ''}. Check that PORT is a free port on this machine.`;
}
