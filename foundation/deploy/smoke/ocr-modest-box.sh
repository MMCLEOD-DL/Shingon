#!/usr/bin/env bash
# The modest-box OCR check (spec §5), run on the throwaway build machine after the images are built:
#   bash deploy/smoke/ocr-modest-box.sh
#
# It reads the fictional receipt corpus with the app image's own local OCR, inside a container limited to what a small
# client box has (2 CPUs, 2 GB of memory, no network at all, one reading at a time), and writes the measured figures and a
# PASS or FAIL per gate line to deploy/smoke/OCR-RESULT.md. It exits 0 only when every line passes.
#
# Settings:
#   HF_OCR_IMAGE           the app image to check (default highland/app:0.2.0)
#   HF_OCR_BASELINE_IMAGE  the image to measure growth against (default highland/app:0.1.0; skipped when it is not here)
#   HF_OCR_RESULT          where the result goes (default deploy/smoke/OCR-RESULT.md)
# Only the image is used: nothing is downloaded and no client data is involved (Ruling 10).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="${HF_OCR_IMAGE:-highland/app:0.2.0}"
BASELINE="${HF_OCR_BASELINE_IMAGE:-highland/app:0.1.0}"
RESULT="${HF_OCR_RESULT:-$ROOT/deploy/smoke/OCR-RESULT.md}"
CORPUS="$ROOT/modules/ocr/test/fixtures/receipts"
TODAY=2026-03-31
GROWTH_LIMIT=60000000          # 60 MB
MEDIAN_LIMIT_MS=10000
SLOWEST_LIMIT_MS=30000

command -v docker >/dev/null || { echo "Docker is not installed. Run this on the build machine." >&2; exit 2; }
command -v node >/dev/null || { echo "Node.js is needed to read the results." >&2; exit 2; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "There is no image $IMAGE here. Build it first (npm run images)." >&2; exit 2; }

TMP="$(mktemp -d /tmp/hf-ocr-modest-XXXXXX)"
NAMES=()
cleanup() {
  for n in "${NAMES[@]}"; do docker rm -f "$n" >/dev/null 2>&1 || true; done
  rm -rf "$TMP"
}
trap cleanup EXIT
cp -R "$CORPUS" "$TMP/corpus"
chmod -R a+rX "$TMP/corpus"

has_files() { find "$1" -maxdepth 1 -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' -o -iname '*.heic' -o -iname '*.pdf' \) | grep -q .; }

# Reads one folder in a modest-box container. Writes <label>.json (the bench report), <label>.peak (peak memory in bytes,
# from the container's own cgroup) and <label>.state (exit code and whether it was killed for running out of memory).
read_folder() {
  local label="$1" folder="$2"
  local name="hf-ocr-modest-$label-$$"
  NAMES+=("$name")
  set +e
  docker run --name "$name" --cpus=2 --memory=2g --memory-swap=2g --network none -e OCR_CONCURRENCY=1 \
    -v "$TMP/corpus:/corpus:ro" --entrypoint sh "$IMAGE" -c \
    'node modules/ocr/dist/bench.js "$1" --today "$2" --json /dev/stdout; s=$?; cat /sys/fs/cgroup/memory.peak >&2 2>/dev/null || echo unknown >&2; exit $s' \
    sh "/corpus/$folder" "$TODAY" > "$TMP/$label.out" 2> "$TMP/$label.err"
  set -e
  head -n 1 "$TMP/$label.out" > "$TMP/$label.json"
  tail -n 1 "$TMP/$label.err" > "$TMP/$label.peak"
  docker inspect "$name" --format '{{.State.ExitCode}} {{.State.OOMKilled}}' > "$TMP/$label.state"
  docker rm -f "$name" >/dev/null
}

FOLDERS=(rendered)
read_folder rendered rendered
if has_files "$TMP/corpus/photos"; then read_folder photos photos; FOLDERS+=(photos); fi
# Not a gate line of its own: proves the PDF reader (its child process, pdfjs-dist without the native canvas) works in the image.
read_folder pdf pdf

size_of() { docker image inspect "$1" --format '{{.Size}}'; }
# The image's files as stored on an ordinary disk (apparent bytes), which does not depend on this machine's storage driver.
files_of() { docker run --rm --network none --user root --entrypoint du "$1" -sxb / 2>/dev/null | cut -f1; }
GROWTH_LINE="not measured ($BASELINE is not on this machine)"
GROWTH_OK=skip
if docker image inspect "$BASELINE" >/dev/null 2>&1; then
  GROWTH_LINE="$(size_of "$IMAGE") $(size_of "$BASELINE") $(files_of "$IMAGE") $(files_of "$BASELINE")"
  GROWTH_OK=measured
fi

CPU="$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ *//')"
COMMIT="$(cd "$ROOT" && git rev-parse --short HEAD 2>/dev/null || echo unknown)"

node - "$TMP" "$RESULT" "$IMAGE" "$BASELINE" "$CPU" "$COMMIT" "$GROWTH_OK" "$GROWTH_LINE" "$GROWTH_LIMIT" "$MEDIAN_LIMIT_MS" "$SLOWEST_LIMIT_MS" "${FOLDERS[*]}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [tmp, result, image, baseline, cpu, commit, growthOk, growthLine, growthLimit, medianLimit, slowestLimit, folderList] = process.argv.slice(2);
const folders = folderList.split(' ');
const read = (label) => {
  const [exit, oom] = fs.readFileSync(path.join(tmp, `${label}.state`), 'utf8').trim().split(' ');
  let report = null;
  try { report = JSON.parse(fs.readFileSync(path.join(tmp, `${label}.json`), 'utf8')); } catch { /* the run failed */ }
  const peak = Number(fs.readFileSync(path.join(tmp, `${label}.peak`), 'utf8').trim());
  return { label, exit: Number(exit), oom: oom === 'true', report, peak: Number.isFinite(peak) ? peak : null };
};
const runs = folders.map(read);
const pdf = read('pdf');
const cases = runs.flatMap((r) => (r.report ? r.report.cases : []));
const times = cases.map((c) => c.ms).sort((a, b) => a - b);
const mid = Math.floor(times.length / 2);
const median = times.length === 0 ? NaN : times.length % 2 ? times[mid] : Math.round((times[mid - 1] + times[mid]) / 2);
const slowest = times.length === 0 ? NaN : times[times.length - 1];
const slowestCase = cases.find((c) => c.ms === slowest);
const FIELDS = ['amount', 'vat', 'date', 'merchant'];
const certainWrong = cases.reduce((n, c) => n + FIELDS.filter((f) => c.outcome[f] === 'confidentlyWrong').length, 0);
const allRan = runs.every((r) => r.exit === 0 && r.report !== null);
const anyOom = [...runs, pdf].some((r) => r.oom);
const s = (ms) => `${(ms / 1000).toFixed(1)} s`;
const mb = (b) => `${(b / 1e6).toFixed(1)} MB`;
const verdict = (ok) => (ok ? 'PASS' : 'FAIL');

let growthCell = growthLine;
let growthPass = false;
if (growthOk === 'measured') {
  const [size, baseSize, files, baseFiles] = growthLine.split(' ').map(Number);
  const bySize = size - baseSize;
  const byFiles = files - baseFiles;
  // The larger of the two measures counts: docker's own size (storage-driver dependent) and the files' apparent bytes.
  growthPass = Math.max(bySize, byFiles) <= Number(growthLimit);
  growthCell = `${mb(bySize)} by docker image inspect .Size (${size} vs ${baseSize} bytes); ${mb(byFiles)} by the image's files (${files} vs ${baseFiles} bytes)`;
}

const peakMb = Math.max(...[...runs, pdf].map((r) => r.peak ?? 0));
const pdfCases = pdf.report ? pdf.report.cases : [];
const pdfRead = pdf.exit === 0 && pdfCases.some((c) => c.file === 'e-ticket.pdf' && c.unreadable === null && c.outcome.amount === 'right');

const rows = [
  ['Median seconds per receipt', '≤ 10', Number.isFinite(median) ? s(median) : 'no readings', allRan && median <= Number(medianLimit)],
  ['Slowest receipt', '≤ 30 s (below OCR_TIMEOUT_MS)', Number.isFinite(slowest) ? `${s(slowest)} (${slowestCase ? slowestCase.file : '?'})` : 'no readings', allRan && slowest <= Number(slowestLimit)],
  ['Out-of-memory kills', 'none', `${anyOom ? 'killed' : 'none'} (peak memory ${peakMb > 0 ? mb(peakMb) : 'not available'} of 2 GB)`, !anyOom],
  ['`confidentlyWrong` (all fields)', '0', String(certainWrong), allRan && certainWrong === 0],
  ['Network', 'none needed (`--network none` succeeds)', allRan ? `every run finished with --network none (${runs.map((r) => `${r.label}: exit ${r.exit}`).join(', ')})` : `a run failed (${runs.map((r) => `${r.label}: exit ${r.exit}`).join(', ')})`, allRan],
  ['App image growth over v0.1.0', '≤ 60 MB', growthCell, growthPass],
];
const pass = rows.every((r) => r[3]);
const byField = FIELDS.map((f) => {
  const count = (o) => cases.filter((c) => c.outcome[f] === o).length;
  return `| ${f} | ${count('right')} of ${cases.length} | ${count('wrongFlagged')} | ${count('confidentlyWrong')} | ${count('missing')} |`;
});
const out = [
  '# Modest-box OCR check',
  '',
  `Run on ${new Date().toISOString().slice(0, 10)} by \`deploy/smoke/ocr-modest-box.sh\` on the throwaway build machine (CT 111 \`hf-build\`), commit ${commit}.`,
  `Host CPU: ${cpu}. The box: \`docker run --cpus=2 --memory=2g --network none\` with \`OCR_CONCURRENCY=1\`, image \`${image}\`, compared with \`${baseline}\`.`,
  `Corpus: ${folders.map((f) => `\`${f}/\``).join(' and ')} (${cases.length} receipts with an expected reading), read with \`--today 2026-03-31\`.${folders.includes('photos') ? '' : ' The `photos/` folder has no pictures yet (operator follow-up: photograph printed fictional receipts).'}`,
  '',
  `**Overall: ${verdict(pass)}**`,
  '',
  '| Measure | Pass | Measured | Result |',
  '|---|---|---|---|',
  ...rows.map(([m, p, v, ok]) => `| ${m} | ${p} | ${v} | ${verdict(ok)} |`),
  '',
  '## By field',
  '',
  '| Field | Right | Wrong, marked "Please check" | Wrong and shown as certain | Not found |',
  '|---|---|---|---|---|',
  ...byField,
  '',
  '## By receipt',
  '',
  '| Receipt | Seconds | Total | VAT | Date | Merchant |',
  '|---|---|---|---|---|---|',
  ...cases.map((c) => `| ${c.file} | ${(c.ms / 1000).toFixed(1)} | ${c.unreadable !== null ? `could not be read: ${c.unreadable}` : FIELDS.map((f) => c.outcome[f]).join(' | ')} |`),
  '',
  '## PDF reading inside the image',
  '',
  `The PDF folder was read in the same modest box, through the PDF reader's child process (\`modules/ocr/dist/pdfChild.js\`) and pdfjs-dist without its native canvas: ${pdfRead ? 'the e-ticket PDF\'s text was read and its total was right' : '**the e-ticket PDF was not read correctly**'} (exit ${pdf.exit}).`,
  ...pdfCases.map((c) => `- ${c.file}: ${c.unreadable !== null ? `could not be read (${c.unreadable})` : FIELDS.map((f) => `${f} ${c.outcome[f]}`).join(', ')}, ${(c.ms / 1000).toFixed(1)} s.`),
  '',
];
fs.writeFileSync(result, out.join('\n'));
console.log(out.slice(0, 16).join('\n'));
process.exit(pass && pdfRead ? 0 : 1);
NODE
