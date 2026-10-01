// Load the Google Maps JS API once per page, shared across every component
// that needs it (drive-path map, lead map). Resolves when window.google.maps
// is ready. The shared promise guarantees the script is injected only once.
let mapsPromise: Promise<void> | null = null;

// Google rejects a bad or wrongly-restricted key by writing to the console
// and leaving the map div blank — the script still loads and the promise
// still resolves, so a component has no way to tell. The one programmatic
// signal is this global, which Google calls on auth failure. Hooked once
// here so every map (lead map, drive path, satellite measure) can show the
// real reason instead of an unexplained grey box.
let authFailed = false;
const authListeners = new Set<() => void>();

if (typeof window !== "undefined") {
  window.gm_authFailure = () => {
    authFailed = true;
    authListeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  };
}

/** Subscribe to Google rejecting the Maps key. Fires immediately if it has
 *  already happened on this page. Returns an unsubscribe function. */
export function onMapsAuthFailure(cb: () => void): () => void {
  authListeners.add(cb);
  if (authFailed) cb();
  return () => { authListeners.delete(cb); };
}

export function loadGoogleMaps(key: string): Promise<void> {
  if (typeof window !== "undefined" && window.google?.maps) return Promise.resolve();
  if (mapsPromise) return mapsPromise;
  mapsPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}`;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => { mapsPromise = null; reject(new Error("Failed to load Google Maps")); };
    document.head.appendChild(s);
  });
  return mapsPromise;
}
