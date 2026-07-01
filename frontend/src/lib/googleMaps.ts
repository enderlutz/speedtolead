// Load the Google Maps JS API once per page, shared across every component
// that needs it (drive-path map, lead map). Resolves when window.google.maps
// is ready. The shared promise guarantees the script is injected only once.
let mapsPromise: Promise<void> | null = null;

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
