/**
 * localStorage cache for the kanban boards, so a board paints instantly on
 * reload instead of flashing empty for a second.
 *
 * Shared by all four boards (v1, v2, B, brick) because the failure mode below
 * is shared, and each board fixing it privately is how it got missed the
 * first time.
 *
 * ## Why this isn't just localStorage.setItem
 *
 * The v2 board's payload is ~2.3 MB of JSON. WebKit measures localStorage in
 * UTF-16 code units against a ~5 MB per-origin budget, so that single entry
 * can bill ~4.6 MB on an iPhone — and two boards' caches together do not fit.
 * setItem then throws QuotaExceededError.
 *
 * Every board wrote its cache inside the fetch's .then(), ahead of
 * .catch(() => toast.error("Failed to load leads")). So a full quota surfaced
 * as a load failure on a load that had already succeeded and already rendered
 * the leads. The board showed the leads and claimed it couldn't fetch them.
 *
 * A cache write is a nicety. It must never be able to report a failure, and
 * it must never run where a failure would be mistaken for one.
 */

/** Read a cached board. Absent, corrupt or unreadable all mean "no cache". */
export function readLeadCache<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * Cache a board, best-effort. Never throws.
 *
 * On a quota failure we drop this key's stale entry and retry once: that entry
 * is the largest thing we're allowed to free, and it was about to be
 * overwritten anyway. If the second attempt fails too, another board is
 * holding the space — give up quietly. The data is already on screen; the only
 * cost is a slower paint on the next reload.
 */
export function writeLeadCache(key: string, data: unknown): void {
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch {
    return; // unserialisable — nothing worth caching
  }

  try {
    localStorage.setItem(key, json);
    return;
  } catch {
    // Over quota (or private mode). Fall through and try to make room.
  }

  try {
    localStorage.removeItem(key);
    localStorage.setItem(key, json);
  } catch {
    // Still no room. Not worth evicting another board's cache over.
  }
}
