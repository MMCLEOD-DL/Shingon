// Only fixed, bounded explanations leave the worker. CLI output may contain
// credentials, private paths, URLs or model text: never interpolate it here.
export function probeGuidance({ reason, evidence, error }) {
  const retry = ' Retry explicitly; checks may use subscription allowance.';
  if (evidence === 'file-missing') return 'The coding check finished without creating its verification file. Check that the configured sandbox permits workspace writes.' + retry;
  if (evidence === 'file-mismatch') return 'The coding check created a file with unexpected contents. Check the model and file-writing support.' + retry;
  if (evidence === 'file-unreadable') return 'The coding check verification file could not be read. Check temporary-folder and sandbox permissions.' + retry;
  if (evidence === 'wrong-reply') return 'The CLI finished without returning the expected check response. Check the selected model and connection.' + retry;
  if (reason === 'timeout') return 'The CLI exceeded the connection-check time limit. Check its availability before retrying.' + retry;
  if (reason === 'unauthorized') return "The CLI rejected its sign-in or authentication. Sign in through that CLI's supported login flow." + retry;
  if (reason === 'rate-limit') return 'The CLI reported a usage or rate limit. Wait until the limit allows another check.' + retry;
  if (reason === 'version-skew') return 'The CLI rejected a configuration option. Check the supported CLI version and configuration.' + retry;
  const text = typeof error === 'string' ? error.slice(0, 4096).toLowerCase() : '';
  if (/private.*codex.*home.*busy/.test(text)) return 'Private Codex settings are busy or unavailable. Check for another call and settings-folder access.' + retry;
  if (/read.only/.test(text)) return 'The CLI reported a read-only workspace. Check the configured sandbox mode before retrying the coding check.' + retry;
  if (/windows.*sandbox|sandbox.*(?:not configured|not enabled|setup|failed)/.test(text)) return 'The CLI reported a sandbox setup problem. Complete its supported sandbox setup before retrying.' + retry;
  if (/permission denied|access denied|eacces|eperm/.test(text)) return 'The CLI reported a file access refusal. Check workspace and sandbox permissions.' + retry;
  return 'The CLI did not complete the check successfully. Check the CLI account, selected model and endpoint.' + retry;
}
