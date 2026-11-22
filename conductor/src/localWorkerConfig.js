// Trusted on-disk configuration only. Browser setup never accepts these fields.
export function localWorkerConfig(local) {
  if (local === undefined) return null;
  if (!local || typeof local !== 'object' || Array.isArray(local)
    || Object.keys(local).some(k => k !== 'worker')) throw new Error('Invalid local configuration.');
  if (local.worker === undefined) return null;
  const w = local.worker;
  if (!w || typeof w !== 'object' || Array.isArray(w)
    || Object.keys(w).some(k => !['startCommand', 'readyUrl', 'startTimeoutMs'].includes(k))) throw new Error('Invalid local.worker configuration.');
  if (!Array.isArray(w.startCommand) || !w.startCommand.length || w.startCommand.length > 64
    || w.startCommand.some(a => typeof a !== 'string' || a.length > 4096 || /[\0\r\n]/.test(a)) || !w.startCommand[0].trim()) {
    throw new Error('local.worker.startCommand must be a non-empty executable argument list.');
  }
  if (w.startCommand.some(a => /-executionpolicy/i.test(a))) throw new Error('local.worker.startCommand must use the existing execution policy; -ExecutionPolicy is refused.');
  let url;
  try { url = new URL(w.readyUrl); } catch { /* fixed validation error below */ }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('local.worker.readyUrl must be an HTTP(S) readiness URL without credentials, a query or fragment.');
  }
  const timeout = w.startTimeoutMs ?? 180000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647) throw new Error('local.worker.startTimeoutMs must be a positive bounded integer.');
  return { startCommand: [...w.startCommand], readyUrl: url.href, startTimeoutMs: timeout };
}
