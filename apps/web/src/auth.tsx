import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { Center, Loader } from '@mantine/core';
import { can, type Permission, type Role } from '@hf/shared';
import { api, onUnauthorized } from './api.js';
import { EmptyState } from './ui/EmptyState.js';

export interface Actor { id: string; email: string; name: string; role: Role; teamId: string | null }

interface AuthState {
  user: Actor | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  /** For the sign-in and accept-invite pages, which already have the user from the server's reply. */
  setUser: (user: Actor | null) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children, onSignedOut }: { children: ReactNode; onSignedOut?: () => void }) {
  const [user, setUserState] = useState<Actor | null>(null);
  const [loading, setLoading] = useState(true);

  const signedOut = useRef(onSignedOut);
  signedOut.current = onSignedOut;
  const setUser = useCallback((u: Actor | null) => {
    setUserState(u);
    if (u === null) signedOut.current?.();
  }, []);

  const refresh = useCallback(async () => {
    try {
      const me = await api<{ user: Actor | null }>('GET', '/api/me');
      setUserState(me.user);
    } catch {
      // A 401 already cleared the user; any other failure leaves the person signed out on screen rather than guessing.
      setUserState(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    onUnauthorized(() => { setUser(null); });
    void refresh();
    return () => { onUnauthorized(null); };
  }, [refresh, setUser]);

  const signOut = useCallback(async () => {
    try {
      await api('POST', '/api/auth/sign-out');
    } finally {
      // Whatever the server said, this browser stops showing the person's data.
      setUser(null);
    }
  }, [setUser]);

  const value = useMemo<AuthState>(() => ({ user, loading, refresh, signOut, setUser }), [user, loading, refresh, signOut, setUser]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider.');
  return ctx;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Center mih="60vh"><Loader aria-label="Loading" /></Center>;
  if (!user) return <Navigate to={`/sign-in?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

/** Presentation only: hides a page the role cannot use. The server still refuses the data. */
export function RequirePermission({ perm, children }: { perm: Permission; children: ReactNode }) {
  const { user } = useAuth();
  if (!user || !can(user.role, perm)) {
    return <EmptyState title="You don't have access to this page" body="Ask an administrator if you think you should." />;
  }
  return <>{children}</>;
}
