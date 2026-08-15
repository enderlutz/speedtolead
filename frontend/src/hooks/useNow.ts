import { useEffect, useState } from "react";

/**
 * Current wall-clock time, held in state and refreshed on an interval.
 *
 * Reading `Date.now()` directly in a render body is impure — React can re-run
 * a render at any point, so the value isn't reproducible from props/state and
 * `react-hooks/purity` rejects it. Reading the clock in an effect instead keeps
 * render pure and makes the refresh cadence explicit, which also fixes the
 * quieter bug: an age/staleness badge that only recomputed when its parent
 * happened to re-render now updates on its own.
 *
 * @param intervalMs how often to re-read the clock; <= 0 reads once on mount.
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs <= 0) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
