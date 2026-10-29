# Runs the app's own copy of the foundation smoke. ROOT and SMOKE_SECONDS are exported before this text.
if [ ! -f "$ROOT/deploy/smoke/run-smoke.sh" ]; then
  echo "COUNCIL-REFUSED This app has no deploy/smoke/run-smoke.sh (it was not built from the foundation)."
  exit 3
fi
# Everything after this line is the app's own output: Conductor honours COUNCIL-REFUSED only before it.
echo "COUNCIL-SMOKE-START"
cd "$ROOT" && HF_SMOKE_BIND=127.0.0.1 timeout --signal=TERM "$SMOKE_SECONDS" bash deploy/smoke/run-smoke.sh </dev/null 2>&1
echo "COUNCIL-SMOKE-EXIT $?"
