import { useCallback, useEffect, useRef, useState } from 'react';

export type AsyncState<T> = { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready'; data: T };

/**
 * Load data with explicit loading / error / ready states.
 * `reload` shows the loading state again; `refresh` updates in place (keeps the
 * current screen, sheets and edits mounted) and is what to call after a mutation.
 */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  const latest = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const loader = useCallback(load, deps);

  const run = useCallback(
    (silent: boolean) => {
      const id = ++latest.current;
      if (!silent) setState({ status: 'loading' });
      loader().then(
        (data) => id === latest.current && setState({ status: 'ready', data }),
        (error) => id === latest.current && !silent && setState({ status: 'error', error })
      );
    },
    [loader]
  );

  useEffect(() => run(false), [run]);
  const reload = useCallback(() => run(false), [run]);
  const refresh = useCallback(() => run(true), [run]);
  const set = useCallback((data: T) => setState({ status: 'ready', data }), []);
  return { state, reload, refresh, set };
}
