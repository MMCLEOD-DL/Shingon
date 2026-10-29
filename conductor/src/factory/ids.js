// src/factory/ids.js — run ids and Compose project names (Contract 7 §7.1).
export const SLUG_RE = /^(?=.{1,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const RUN_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
export const COMPOSE_PROJECT_RE = /^hf-[a-z0-9-]+-\d{8}-\d{6}-[0-9a-f]{4}$/;

const defaultRand = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');

// The run's kind (build, change) lives in its record, not in its id.
export function newRunId(now = new Date(), rand = defaultRand) {
  const p = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${p}-${rand()}`;
}

export function composeProjectOf(slug, runId) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw new Error(`"${slug}" is not a valid project name`);
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) throw new Error(`"${runId}" is not a valid run id`);
  return `hf-${slug}-${runId}`;
}
