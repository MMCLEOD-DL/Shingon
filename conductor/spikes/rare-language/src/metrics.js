// The Stage 1 numbers: how often an attempt compiles, pass@1, and pass@k.

// The unbiased pass@k estimate from n attempts with c passes (Chen et al., 2021): the chance that at least one of k
// attempts drawn without replacement passes. With k = n it is simply "solved at least once".
export function passAtK(n, c, k) {
  if (!Number.isInteger(n) || !Number.isInteger(c) || !Number.isInteger(k) || n < 1 || c < 0 || c > n || k < 1) {
    throw new Error(`passAtK needs whole numbers with 0 <= c <= n and n, k >= 1 (got n=${n}, c=${c}, k=${k}).`);
  }
  if (k > n) return null; // not measurable from this many attempts
  if (k === 1) return c / n; // the same value as the product below, without its rounding
  if (n - c < k) return 1;
  let fail = 1;
  for (let i = n - c + 1; i <= n; i += 1) fail *= 1 - k / i;
  return 1 - fail;
}

// records: [{ task, status }]. Attempts whose checker failed ("error") say nothing about the model, so they are
// counted and reported but left out of every rate.
export function summarize(records, ks = [1, 10]) {
  const byTask = new Map();
  for (const r of records) {
    if (!byTask.has(r.task)) byTask.set(r.task, { task: r.task, attempts: 0, compiled: 0, passed: 0, errors: 0 });
    const t = byTask.get(r.task);
    if (r.status === 'error') { t.errors += 1; continue; }
    t.attempts += 1;
    if (r.status === 'pass' || r.status === 'test-fail') t.compiled += 1;
    if (r.status === 'pass') t.passed += 1;
  }
  const tasks = [...byTask.values()];
  const counted = tasks.filter((t) => t.attempts > 0);
  const attempts = counted.reduce((s, t) => s + t.attempts, 0);
  // pass@k averages over the tasks with at least k counted attempts. A task that lost attempts to errors is left out
  // of that k, and the number left out is reported beside it, so one bad checker run cannot blank the result.
  const passAt = {};
  const passAtExcluded = {};
  for (const k of ks) {
    const values = counted.map((t) => passAtK(t.attempts, t.passed, k)).filter((v) => v !== null);
    passAt[k] = values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : null;
    passAtExcluded[k] = tasks.length - values.length;
  }
  return {
    tasks: tasks.length,
    attempts,
    errors: tasks.reduce((s, t) => s + t.errors, 0),
    compileRate: attempts > 0 ? counted.reduce((s, t) => s + t.compiled, 0) / attempts : null,
    passAt,
    passAtExcluded,
    solvedAtLeastOnce: counted.filter((t) => t.passed > 0).length,
    perTask: tasks,
  };
}
