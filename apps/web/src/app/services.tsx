import { createHttpApi, createMockApi, type SessionUser, type Trip, type UserApi } from '@riflo/core';
import { Toast } from '@riflo/ui';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SignInSheet } from '../features/auth/SignInSheet';

interface Draft {
  trip: Trip;
  /** Set when the plan came from "use it again". */
  reusedFrom?: string;
}

interface Services {
  api: UserApi;
  user: SessionUser | null;
  /** Resolves true once signed in (opening the sign-in sheet if needed), false if dismissed. */
  requireSignIn: () => Promise<boolean>;
  signOut: () => Promise<void>;
  draft: Draft | null;
  setDraft: (d: Draft | null) => void;
  toast: string | null;
  notify: (msg: string | null) => void;
}

const Ctx = createContext<Services | null>(null);

/** Thrown when a production build has no API configured and the mock wasn't explicitly allowed. */
export class MissingApiConfig extends Error {}

/**
 * VITE_API_URL set → the real RIFLO API.
 * The in-browser mock only runs in development or when VITE_ALLOW_MOCK=true (shareable previews).
 * A production build with neither fails visibly instead of quietly showing sample data (audit 6.1).
 */
export const usingMock = !import.meta.env.VITE_API_URL;
function makeApi(): UserApi {
  const url = import.meta.env.VITE_API_URL as string | undefined;
  if (url) return createHttpApi({ baseUrl: url.replace(/\/$/, '') });
  if (import.meta.env.DEV || import.meta.env.VITE_ALLOW_MOCK === 'true') return createMockApi({ failPlan: window.location.href.includes('fail=plan') });
  throw new MissingApiConfig('VITE_API_URL is not set for this production build');
}

export function ServicesProvider({ children }: { children: ReactNode }) {
  const api = useMemo(makeApi, []);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [toast, notify] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const waiters = useRef<((ok: boolean) => void)[]>([]);

  useEffect(() => {
    api.auth.current().then(setUser, () => setUser(null));
  }, [api]);

  const requireSignIn = useCallback(async () => {
    if (!api.auth.requiresAccount) return true;
    if (user ?? (await api.auth.current().catch(() => null))) return true;
    setSigningIn(true);
    return new Promise<boolean>((resolve) => waiters.current.push(resolve));
  }, [api, user]);

  const finish = useCallback((u: SessionUser | null) => {
    setSigningIn(false);
    if (u) setUser(u);
    waiters.current.splice(0).forEach((r) => r(!!u));
  }, []);

  const signOut = useCallback(async () => {
    await api.auth.signOut();
    setUser(null);
  }, [api]);

  const clear = useCallback(() => notify(null), []);
  // One toast and one sign-in sheet for the whole app.
  return (
    <Ctx.Provider value={{ api, user, requireSignIn, signOut, draft, setDraft, toast, notify }}>
      {children}
      <SignInSheet open={signingIn} api={api} onDone={finish} />
      <Toast message={toast} onDone={clear} />
    </Ctx.Provider>
  );
}

export function useServices() {
  const s = useContext(Ctx);
  if (!s) throw new Error('ServicesProvider missing');
  return s;
}
