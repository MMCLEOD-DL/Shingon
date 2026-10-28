import { useEffect, useState } from 'react';
import type { ReadingView } from '@hf/shared';
import { ApiError, getReading } from '../../api.js';

export const POLL_MS = 1500;
export const GIVE_UP_MS = 90_000;
export const TAKING_LONG = 'Reading is taking longer than usual. You can type the details now.';

/**
 * A reading, looked at again every 1.5 seconds while it is pending. After 90 seconds it stops and `error` says the
 * details can be typed now (the reading stays pending). A refusal from the server (not found) stops it too; a dropped
 * connection does not.
 */
export function useReading(id: string): { reading: ReadingView | undefined; error: unknown } {
  const [state, setState] = useState<{ id: string; reading: ReadingView | undefined; error: unknown }>({ id, reading: undefined, error: null });

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    setState({ id, reading: undefined, error: null });
    const again = (): void => {
      if (Date.now() - started >= GIVE_UP_MS) {
        setState((s) => ({ ...s, error: new Error(TAKING_LONG) }));
        return;
      }
      timer = setTimeout(() => { void look(); }, POLL_MS);
    };
    const look = async (): Promise<void> => {
      try {
        const reading = await getReading(id);
        if (stopped) return;
        setState({ id, reading, error: null });
        if (reading.status === 'pending') again();
      } catch (e) {
        if (stopped) return;
        if (e instanceof ApiError && e.status === 0) again();
        else setState((s) => ({ ...s, error: e }));
      }
    };
    void look();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id]);

  // Until the effect has started for a new id, nothing from the previous one is shown.
  return state.id === id ? { reading: state.reading, error: state.error } : { reading: undefined, error: null };
}
