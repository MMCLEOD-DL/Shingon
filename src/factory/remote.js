// Remote scripts for factory machines. Every value is validated with assertSafe and single-quoted with
// shQuote before it reaches a script; scripts are sent over `ssh bash -s` (see ssh.js).
import { SLUG_RE, RUN_ID_RE, COMPOSE_PROJECT_RE } from './ids.js';

export const shQuote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

const PURPOSES = ['preview', 'council', 'smoke', 'ship'];
const isStr = (v) => typeof v === 'string';
const CHECKS = {
  slug: (v) => isStr(v) && SLUG_RE.test(v),
  runId: (v) => isStr(v) && RUN_ID_RE.test(v),
  project: (v) => isStr(v) && COMPOSE_PROJECT_RE.test(v),
  path: (v) => isStr(v) && /^\/[A-Za-z0-9/_.-]+$/.test(v) && !v.split('/').includes('..'),
  host: (v) => isStr(v) && /^[A-Za-z0-9.-]{1,253}$/.test(v) && !v.startsWith('-'),
  user: (v) => isStr(v) && /^[a-z_][a-z0-9_-]{0,31}$/.test(v),
  port: (v) => Number.isInteger(v) && v >= 1 && v <= 65535,
  client: (v) => isStr(v) && v.length >= 1 && v.length <= 80 && !/[\x00-\x1f\x7f]/.test(v),
  purpose: (v) => PURPOSES.includes(v),
  image: (v) => isStr(v) && /^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]+$/.test(v),
};

export function assertSafe(kind, value) {
  if (!CHECKS[kind]?.(value)) throw new Error(`unsafe ${kind} for a remote command: ${JSON.stringify(value)}`);
  return value;
}

const q = (kind, value) => shQuote(assertSafe(kind, value));
const head = (root) => `set -euo pipefail\nROOT=${q('path', root)}\n`;

export function ownerJson({ factory, project, run, purpose, createdAt }) {
  return JSON.stringify({ factory, project, run: assertSafe('runId', run), purpose: assertSafe('purpose', purpose), createdAt });
}

export function lockScript({ root, owner }) {
  const b64 = Buffer.from(String(owner), 'utf8').toString('base64');
  return `${head(root)}mkdir -p "$ROOT/runs"
if mkdir "$ROOT/lock" 2>/dev/null; then printf %s ${shQuote(b64)} | base64 -d > "$ROOT/lock/owner.json"; echo HF-LOCKED; else echo HF-BUSY; cat "$ROOT/lock/owner.json" 2>/dev/null || true; fi
`;
}

export function unlockScript({ root, runId }) {
  const needle = `"run":"${assertSafe('runId', runId)}"`;
  return `${head(root)}if [ ! -d "$ROOT/lock" ]; then echo HF-NO-LOCK
elif grep -qF ${shQuote(needle)} "$ROOT/lock/owner.json" 2>/dev/null; then rm -rf "$ROOT/lock"; echo HF-UNLOCKED
else echo HF-NOT-OURS; fi
`;
}

export function readLockScript({ root }) {
  return `${head(root)}if [ -d "$ROOT/lock" ]; then echo HF-HELD; cat "$ROOT/lock/owner.json" 2>/dev/null || true; else echo HF-FREE; fi
`;
}

// Shell function: tear down one compose project (best effort), then remove its folder.
const TEARDOWN_FN = `teardown() {
  local P="$1"; shift
  local DIR="$ROOT/runs/$P"
  if [ -f "$DIR/bundle/compose.yaml" ]; then (cd "$DIR/bundle" && docker compose -p "$P" --profile tools --profile tunnel down -v --remove-orphans) || true; fi
  docker ps -aq --filter "label=com.docker.compose.project=$P" | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker volume ls -q --filter "label=com.docker.compose.project=$P" | xargs -r docker volume rm >/dev/null 2>&1 || true
  docker network ls -q --filter "label=com.docker.compose.project=$P" | xargs -r docker network rm >/dev/null 2>&1 || true
  for img in "$@"; do docker rmi "$img" >/dev/null 2>&1 || true; done
  rm -rf "$DIR"
}
`;

export function teardownScript({ root, project, images = [] }) {
  const imgs = images.map((i) => q('image', i)).join(' ');
  return `${head(root)}P=${q('project', project)}
${TEARDOWN_FN}teardown "$P" ${imgs}
left=$(docker ps -aq --filter "label=com.docker.compose.project=$P" | wc -l | tr -d ' ')
if [ "$left" = 0 ]; then echo HF-TORN-DOWN; else echo "HF-LEFTOVERS $left"; fi
`;
}

export function sweepScript({ root, olderThanSec, keepRuns = [] }) {
  if (!Number.isInteger(olderThanSec) || olderThanSec < 0) throw new Error(`unsafe olderThanSec for a remote command: ${JSON.stringify(olderThanSec)}`);
  const keep = keepRuns.map((r) => q('runId', r)).join(' ');
  return `${head(root)}OLDER=${olderThanSec}
${TEARDOWN_FN}KEEP=(${keep})
{ ls -1 "$ROOT/runs" 2>/dev/null || true; docker ps -a --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null || true; } | sort -u | while IFS= read -r p; do
  [[ "$p" =~ ^hf-[a-z0-9-]+-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$ ]] || continue
  skip=0
  for r in \${KEEP[@]+"\${KEEP[@]}"}; do case "$p" in *-"$r") skip=1;; esac; done
  [ "$skip" = 1 ] && continue
  if [ -e "$ROOT/runs/$p" ]; then age=$(( $(date +%s) - $(stat -c %Y "$ROOT/runs/$p") )); else age=$OLDER; fi
  if [ "$age" -ge "$OLDER" ]; then teardown "$p"; echo "HF-SWEPT $p"; fi
done
echo HF-SWEEP-DONE
`;
}

export function parseMarker(stdout) {
  const lines = String(stdout ?? '').split('\n');
  let i = lines.length - 1;
  while (i >= 0 && !lines[i].startsWith('HF-')) i--;
  if (i < 0) return { marker: null, rest: String(stdout ?? '').trim() };
  const m = /^(\S+)\s?(.*)$/.exec(lines[i]);
  return { marker: m[1], rest: [m[2], ...lines.slice(i + 1)].join('\n').trim() };
}
