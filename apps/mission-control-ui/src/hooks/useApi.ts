import { useCallback, useEffect, useRef, useState } from "react";

export function useApi<T>(fn: () => Promise<T>, deps: unknown[] = [], pollMs = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(() => {
    setLoading(true);
    fnRef.current()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
    if (pollMs <= 0) return;
    const t = setInterval(() => {
      fnRef.current()
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch((e: Error) => setError(e));
    }, pollMs);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, reload };
}
