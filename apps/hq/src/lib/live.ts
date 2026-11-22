import { useEffect, useState } from 'react';

export interface LiveEvent {
  type: string;
  at: string;
  [k: string]: unknown;
}

type Listener = (e: LiveEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;
let connected = false;
const statusListeners = new Set<(c: boolean) => void>();

const setConnected = (c: boolean) => {
  connected = c;
  statusListeners.forEach((l) => l(c));
};

/** One Server-Sent Events connection for the whole app; the browser reconnects automatically. */
export function connectLive() {
  if (source) return;
  source = new EventSource('/hq/v1/stream', { withCredentials: true });
  source.onopen = () => {
    setConnected(true);
    // After a reconnect, anything may have changed while we were away.
    listeners.forEach((l) => l({ type: '*', at: new Date().toISOString() }));
  };
  source.onerror = () => setConnected(false);
  source.onmessage = (m) => {
    try {
      const ev = JSON.parse(m.data) as LiveEvent;
      listeners.forEach((l) => l(ev));
    } catch {
      /* ignore malformed */
    }
  };
}

export function disconnectLive() {
  source?.close();
  source = null;
  setConnected(false);
}

export function onLive(fn: Listener) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useLiveConnected() {
  const [c, setC] = useState(connected);
  useEffect(() => {
    statusListeners.add(setC);
    return () => {
      statusListeners.delete(setC);
    };
  }, []);
  return c;
}
