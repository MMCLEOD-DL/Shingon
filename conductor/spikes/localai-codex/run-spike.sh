#!/usr/bin/env bash
# Build-spike #1: can the local model execute an agentic chunk through Codex?
# Requires: desktop worker up; LOCALAI_API_KEY set in the environment.
set -u
MODEL="${LOCALAI_MODEL:-shingon-qwen3.8-27b-q4}"
WORK="$(mktemp -d)"
cd "$WORK" || exit 2
git init -q && git config user.email spike@local && git config user.name spike
git commit -q --allow-empty -m init

echo "== running codex against localai (model=$MODEL) in $WORK =="
codex exec \
  -c model_provider=localai \
  -c "model=$MODEL" \
  --sandbox workspace-write \
  --skip-git-repo-check \
  "Create a file named hello.txt whose only contents are the word: online. Then stop." \
  2>codex.err
rc=$?

echo "== result =="
echo "codex exit: $rc"
if [ -f hello.txt ]; then echo "FILE_CREATED: yes"; echo "contents: $(cat hello.txt)"; else echo "FILE_CREATED: no"; fi
echo "diff lines: $(git status --porcelain | wc -l)"
echo "stderr tail:"; tail -5 codex.err
echo "workdir kept at: $WORK"
