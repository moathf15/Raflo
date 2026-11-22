import { useCallback, useEffect, useRef, useState } from 'react';
import { onLive, type LiveEvent } from './live';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** All calls go to the HQ API on the same origin. Writes carry the CSRF header the API requires. */
export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  const res = await fetch(`/hq/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'x-hq-csrf': '1', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = data?.error ?? {};
    const msg = err.issues ? err.issues.map((i: { path: string; message: string }) => `${i.path}: ${i.message}`).join('; ') : (err.message ?? res.statusText);
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('hq:unauthorized'));
    throw new ApiError(res.status, err.code ?? 'error', msg);
  }
  return data as T;
}

/**
 * Load `path` and reload it when a live event matching `refreshOn` arrives (event types, or a predicate).
 * Reloads are debounced so bursts of events cause one request.
 */
export function useApi<T>(path: string | null, refreshOn: string[] | ((e: LiveEvent) => boolean) = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const timer = useRef<number | undefined>(undefined);
  const load = useCallback(async () => {
    if (!path) return;
    try {
      const d = await api<T>(path);
      setData(d);
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    setLoading(true);
    setData(null);
    void load();
  }, [load]);
  const match = useRef(refreshOn);
  match.current = refreshOn;
  useEffect(
    () =>
      onLive((e) => {
        const m = match.current;
        const hit = e.type === '*' || (typeof m === 'function' ? m(e) : m.includes(e.type) || m.includes('*'));
        if (!hit) return;
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => void load(), 250);
      }),
    [load]
  );
  return { data, error, loading, reload: load, setData };
}

/** Run an action, tracking busy state and the last error. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}
