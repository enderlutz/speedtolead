import { useMemo } from "react";
import { MapContainer, TileLayer, Marker, Popup, Polyline } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import type { ScheduledJob } from "@/lib/api";

// Leaflet's default-marker assets break under Vite because the bundled
// image paths use the Webpack module-resolution shape. Re-bind them here
// once at import time so every <Marker /> picks them up.
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

type Props = {
  jobs: ScheduledJob[];
};

export default function TodaysMap({ jobs }: Props) {
  // Only render pins for jobs the backend was able to geocode. Anything
  // still at 0,0 is silently skipped — better than a pin in the Atlantic.
  const pinned = useMemo(
    () => jobs.filter((j) => (j.lat || 0) !== 0 && (j.lng || 0) !== 0),
    [jobs]
  );

  // Center on the mean of all pins so the worker sees their full day at
  // a glance. If nothing pins, fall back to Houston (Alan's service area).
  const center = useMemo<[number, number]>(() => {
    if (pinned.length === 0) return [29.7604, -95.3698];
    const lat = pinned.reduce((s, j) => s + (j.lat || 0), 0) / pinned.length;
    const lng = pinned.reduce((s, j) => s + (j.lng || 0), 0) / pinned.length;
    return [lat, lng];
  }, [pinned]);

  if (pinned.length === 0) {
    return (
      <div className="rounded-lg border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
        Map unavailable — addresses still resolving. Refresh in a minute.
      </div>
    );
  }

  // Draw a route line connecting jobs in arrival_time order so the worker
  // sees their day's path at a glance.
  const routePath: [number, number][] = [...pinned]
    .sort((a, b) => (a.arrival_time || "").localeCompare(b.arrival_time || ""))
    .map((j) => [j.lat || 0, j.lng || 0]);

  return (
    <div className="rounded-lg overflow-hidden border h-48 w-full">
      <MapContainer
        center={center}
        zoom={pinned.length === 1 ? 13 : 10}
        scrollWheelZoom={false}
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {routePath.length > 1 && (
          <Polyline positions={routePath} pathOptions={{ color: "#2563eb", weight: 3, opacity: 0.7 }} />
        )}
        {pinned.map((j) => (
          <Marker key={j.id} position={[j.lat || 0, j.lng || 0]}>
            <Popup>
              <div className="text-xs">
                <p className="font-semibold">{j.customer_name || "(no name)"}</p>
                {j.address && <p className="text-muted-foreground">{j.address}</p>}
                <a
                  href={`https://maps.google.com/?q=${encodeURIComponent(j.address)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 underline"
                >
                  Open in Google Maps
                </a>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
