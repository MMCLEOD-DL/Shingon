# Runs the app's own copy of the foundation smoke. ROOT and SMOKE_SECONDS are exported before this text.
if [ ! -f "$ROOT/deploy/smoke/run-smoke.sh" ]; then
  echo "COUNCIL-REFUSED This app has no deploy/smoke/run-smoke.sh (it was not built from the foundation)."
  exit 3
fi
cd "$ROOT" && HF_SMOKE_BIND=127.0.0.1 timeout --signal=TERM "$SMOKE_SECONDS" bash deploy/smoke/run-smoke.sh 2>&1
echo "COUNCIL-SMOKE-EXIT $?"
