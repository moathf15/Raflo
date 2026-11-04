/** Tiny namespaced localStorage wrapper that survives blocked storage (falls back to memory). */
const memory = new Map<string, string>();

function backend(): Pick<Storage, 'getItem' | 'setItem'> {
  try {
    const s = window.localStorage;
    const k = '__riflo_probe__';
    s.setItem(k, '1');
    s.removeItem(k);
    return s;
  } catch {
    return { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => void memory.set(k, v) };
  }
}

export function createStore(namespace: string) {
  const b = backend();
  return {
    read<T>(key: string, fallback: T): T {
      try {
        const raw = b.getItem(`${namespace}:${key}`);
        return raw ? (JSON.parse(raw) as T) : fallback;
      } catch {
        return fallback;
      }
    },
    write<T>(key: string, value: T) {
      b.setItem(`${namespace}:${key}`, JSON.stringify(value));
    }
  };
}
