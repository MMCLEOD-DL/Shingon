import { useState } from 'react';

/**
 * Reset and invite links carry their token after the "#", so it is never sent to the server in a request line or logged.
 * Read it once, then take it out of the address bar so it does not linger in the history or a screenshot.
 */
export function useLinkToken(): string {
  const [token] = useState(() => {
    const found = window.location.hash.replace(/^#(token=)?/, '');
    if (window.location.hash !== '') window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    return found;
  });
  return token;
}
