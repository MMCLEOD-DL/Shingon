#!/usr/bin/env bash
# Plan 7 smoke (operator-run via `!` in a real terminal): real claude/codex subscriptions, YOU answering and approving.
# Uses a throwaway projects folder; never touches ~/highland-projects. No local model or tunnel needed.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)" || exit 2
HERE="$ROOT/spikes/brief-smoke"
C="node $ROOT/bin/conductor.js"
export CONDUCTOR_PROJECTS_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/brief-smoke-XXXXXX")"
echo "projects folder (kept for inspection): $CONDUCTOR_PROJECTS_ROOT"
[ -t 0 ] && [ -t 1 ] || { echo "Run this in a real terminal (it asks you questions)."; exit 2; }

echo "== 1. no terminal: must refuse and send nothing =="
$C project new "Thistle Joinery Ltd" --slug thistle || exit 1
$C brief thistle --notes "$HERE/sample-notes.md" </dev/null | cat
[ -z "$(ls -A "$CONDUCTOR_PROJECTS_ROOT/thistle/notes")" ] && echo "OK: nothing imported" || echo "FAIL: notes were imported without a terminal"

echo "== 2. the sitting: answer the questions (try one 'skip'), then [c] once with a change, then [a] =="
$C brief thistle --notes "$HERE/sample-notes.md"; echo "exit: $?"

echo "== 3. the approved brief loads and validates =="
node --input-type=module -e "
  import { loadBrief, validateBrief } from '$ROOT/src/factory/brief.js';
  const b = loadBrief('$CONDUCTOR_PROJECTS_ROOT/thistle');
  console.log('version', b.version, 'approved by', b.approvedBy, 'features', b.features.length);
  console.log('policy', JSON.stringify(b.policy));
  console.log('valid', JSON.stringify(validateBrief(b, { stage: 'approved' })));
  const { acceptanceIds } = await import('$ROOT/src/factory/acceptance.js');
  console.log('example ids', acceptanceIds(b).map((a) => a.id).join(' '));
" || echo "FAIL: loadBrief"

echo "== 4. revise: press Ctrl-C at the first question, then carry on =="
$C brief thistle --revise --notes "$HERE/sample-change-notes.md"; echo "exit after Ctrl-C: $? (expect 130)"
$C project show thistle
$C brief thistle; echo "exit: $?"
$C project list
ls -l "$CONDUCTOR_PROJECTS_ROOT/thistle/brief"
echo "== 5. example ids: unchanged examples keep their tag from v1 to v2 =="
node --input-type=module -e "
  import { readFileSync } from 'node:fs';
  import { acceptanceIds } from '$ROOT/src/factory/acceptance.js';
  for (const v of [1, 2]) {
    const b = JSON.parse(readFileSync('$CONDUCTOR_PROJECTS_ROOT/thistle/brief/brief-v' + v + '.json', 'utf8'));
    console.log('v' + v, acceptanceIds(b).map((a) => a.id).join(' '));
  }
" || echo "FAIL: example ids"
echo "Fill in spikes/brief-smoke/RESULT.md."
