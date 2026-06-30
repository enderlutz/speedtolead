import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { EstimatorDrivePath } from "@/lib/api";

// Load the Google Maps JS API once, shared across mounts. Resolves when
// window.google.maps is ready.
let mapsPromise: Promise<void> | null = null;
function loadGoogleMaps(key: string): Promise<void> {
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

/** Admin-only map: the GPS trail the estimator actually drove (blue line)
 *  plus numbered markers for the planned stops. */
export default function EstimatorDriveMap({ data }: { data: EstimatorDrivePath }) {
  const ref = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    if (!data.maps_api_key) { setStatus("error"); return; }

    loadGoogleMaps(data.maps_api_key)
      .then(() => {
        if (cancelled || !ref.current || !window.google) return;
        const maps = window.google.maps;
        const bounds = new maps.LatLngBounds();
        const path: GLatLngLiteral[] = data.pings.map((p) => ({ lat: p.lat, lng: p.lng }));
        const stops = data.visits.filter((v) => v.lat != null && v.lng != null);

        path.forEach((p) => bounds.extend(p));
        stops.forEach((v) => bounds.extend({ lat: v.lat as number, lng: v.lng as number }));

        const center = path[0] || (stops[0] ? { lat: stops[0].lat as number, lng: stops[0].lng as number } : { lat: 30.16, lng: -95.46 });
        const map = new maps.Map(ref.current, {
          center,
          zoom: 11,
          mapTypeControl: false,
          streetViewControl: false,
        });

        // Driven route — blue polyline through the GPS pings.
        if (path.length > 1) {
          new maps.Polyline({
            path,
            map,
            strokeColor: "#2563eb",
            strokeOpacity: 0.85,
            strokeWeight: 4,
          });
        }
        // Planned stops — numbered markers in visiting order.
        stops.forEach((v, i) => {
          new maps.Marker({
            position: { lat: v.lat as number, lng: v.lng as number },
            map,
            label: { text: String(i + 1), color: "#ffffff", fontSize: "12px", fontWeight: "600" },
            title: `${i + 1}. ${v.customer_name || "Stop"}${v.start_time ? ` @ ${v.start_time}` : ""}`,
          });
        });

        if (!bounds.isEmpty()) map.fitBounds(bounds);
        setStatus("ready");
      })
      .catch(() => { if (!cancelled) setStatus("error"); });

    return () => { cancelled = true; };
  }, [data]);

  if (status === "error") {
    return (
      <div className="rounded border bg-muted/30 p-3 text-xs text-amber-600">
        Couldn't load the map. Check that GOOGLE_MAPS_API_KEY is set and the Maps JavaScript API is enabled.
      </div>
    );
  }

  return (
    <div className="relative">
      <div ref={ref} className="h-72 w-full rounded border" />
      {status === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center rounded bg-muted/40">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  );
}
