import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './types.js';

/**
 * Minimal data-fetching hook: loading/error/data state, automatic cancellation on
 * unmount or refetch (AbortController), and normalized `ApiError`. Deliberately
 * small — not a cache library. If a shared cache is later justified it is a
 * platform (Agent 1) decision via CCR, so domains do not each pick their own.
 */
export interface QueryState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** Re-run the fetcher. */
  refetch: () => void;
}

export function useQuery<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[] = [],
): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refetch = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    fetcherRef
      .current(ctrl.signal)
      .then((result) => {
        if (!ctrl.signal.aborted) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        const apiErr =
          err instanceof ApiError
            ? err
            : new ApiError({ status: 0, code: 'unknown', message: 'Unexpected error' });
        if (apiErr.isCancelled) return;
        setError(apiErr);
        setLoading(false);
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);

  return { data, error, loading, refetch };
}
