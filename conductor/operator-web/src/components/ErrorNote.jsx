import { plain } from '../text.js';

const HINTS = {
  unauthorized: 'Your sign-in has ended. Restart the Conductor app and open its new link.',
  busy: 'Another run or connection check is active. Wait for it to finish, or stop it first.',
  'stale-decision': 'This question changed or was already answered. The latest state has been loaded; review it again.',
  'resync-required': 'The progress view fell behind. It has been reloaded from the service.',
  'storage-unavailable': 'The service could not save its state and has stopped work. Check the disk, then restart the app.',
  'setup-required': 'Set up the connections first (Connections page).',
  'rate-limit': 'Too many requests. Wait a moment and try again.',
  unreachable: null,
};

/** Shows a service error as a sentence. Unknown codes are errors, never success. */
export function ErrorNote({ error, onDismiss }) {
  if (!error) return null;
  const hint = HINTS[error.code];
  return (
    <div className="error" role="alert">
      <p><strong>{plain(error.message || 'Something went wrong.', 500)}</strong></p>
      {hint && <p>{hint}</p>}
      {error.requestId && <p className="muted">Reference: {plain(error.requestId, 80)}</p>}
      {onDismiss && <button type="button" onClick={onDismiss}>Dismiss</button>}
    </div>
  );
}
