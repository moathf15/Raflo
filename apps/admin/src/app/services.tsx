import { createHttpAdminApi, createMockAdminApi, type AdminApi, type SessionUser } from '@riflo/core';
import { Toast } from '@riflo/ui';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

interface Services {
  api: AdminApi;
  user: SessionUser | null;
  setUser: (u: SessionUser | null) => void;
  toast: string | null;
  notify: (m: string | null) => void;
}
const Ctx = createContext<Services | null>(null);

/**
 * VITE_API_URL set → the real RIFLO API. The mock admin runs only in development or an explicit
 * sample-data preview (VITE_ALLOW_MOCK=true); main.tsx refuses to start otherwise (audit 6.1).
 */
export const usingMock = !import.meta.env.VITE_API_URL;
function makeApi(): AdminApi {
  const url = import.meta.env.VITE_API_URL as string | undefined;
  if (url) return createHttpAdminApi({ baseUrl: url.replace(/\/$/, '') });
  if (import.meta.env.DEV || import.meta.env.VITE_ALLOW_MOCK === 'true') return createMockAdminApi();
  throw new Error('VITE_API_URL is not set for this production build');
}

export function ServicesProvider({ children }: { children: ReactNode }) {
  const api = useMemo(makeApi, []);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [toast, notify] = useState<string | null>(null);
  const clear = useCallback(() => notify(null), []);
  // One toast for the whole app, so messages survive page changes without restarting.
  return (
    <Ctx.Provider value={{ api, user, setUser, toast, notify }}>
      {children}
      <Toast message={toast} onDone={clear} />
    </Ctx.Provider>
  );
}

export function useServices() {
  const s = useContext(Ctx);
  if (!s) throw new Error('ServicesProvider missing');
  return s;
}
