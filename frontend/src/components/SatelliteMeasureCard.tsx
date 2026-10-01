import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { loadGoogleMaps } from "@/lib/googleMaps";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Camera, Loader2, Ruler, Search, Undo2, Trash2 } from "lucide-react";

/**
 * Measure and capture a property without leaving the page.
 *
 * The old loop was: open maps.google.com in a new tab, find the house, use
 * Google's measure tool, screenshot, save to disk, come back, pick the file,
 * upload — then repeat the upload for the fence scope. Per lead. This does
 * the whole thing in one card.
 *
 * Two deliberate design points:
 *
 * 1. **The capture is taken server-side.** Google serves map tiles
 *    cross-origin, so painting this map into a <canvas> taints it and
 *    `toDataURL()` throws — browser screenshotting a Google map is not
 *    possible, not just awkward. So the interactive map is for finding and
 *    framing, and the backend fetches Static Maps at the exact centre and
 *    zoom shown here. Keep the aspect ratio square to match the 640x640
 *    request, or the captured image won't be what was framed.
 *
 * 2. **Distances are computed locally with haversine**, not with Google's
 *    `geometry` library. The shared loader injects the Maps script once and
 *    without extra libraries; depending on `geometry` here would mean either
 *    changing that shared URL or breaking whenever another component loads
 *    the script first. Over a few hundred feet haversine and Google agree to
 *    well under an inch.
 */

interface Props {
  leadId: string;
  lat: number;
  lng: number;
  address?: string;
  /** Push the measured footage into the estimator's Linear Feet input. */
  onLinearFeet?: (feet: number) => void;
  /** Re-fetch the lead so the measurement + scope previews refresh. */
  onChange: () => void;
}

const EARTH_FT = 20902231; // mean Earth radius in feet
const DEFAULT_ZOOM = 20;

function haversineFeet(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_FT * Math.asin(Math.min(1, Math.sqrt(h)));
}

type Pt = { lat: number; lng: number };

/** The Maps namespace once the shared loader has injected the script, or
 *  null before that. Every caller below early-returns on null rather than
 *  asserting, so a slow or blocked script load degrades to an inert card. */
function mapsNS(): GoogleMapsNS | null {
  return (typeof window !== "undefined" && window.google?.maps) || null;
}

export default function SatelliteMeasureCard({
  leadId, lat, lng, address, onLinearFeet, onChange,
}: Props) {
  const mapDivRef = useRef<HTMLDivElement>(null);
  // Typed loosely on purpose: src/types/google-maps.d.ts is a hand-written
  // minimal shim rather than @types/google.maps, so the Map/Marker classes
  // aren't fully described.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const mapRef = useRef<any>(null);
  const lineRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const labelsRef = useRef<any[]>([]);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const [status, setStatus] = useState<"loading" | "ready" | "nokey" | "error">("loading");
  const [points, setPoints] = useState<Pt[]>([]);
  const [closed, setClosed] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [search, setSearch] = useState("");
  const [mapsKey, setMapsKey] = useState("");

  // Total of the traced path. When the loop is closed the final leg back to
  // the first point counts too — a fence usually goes all the way round.
  const total = (() => {
    let sum = 0;
    for (let i = 1; i < points.length; i++) sum += haversineFeet(points[i - 1], points[i]);
    if (closed && points.length > 2) sum += haversineFeet(points[points.length - 1], points[0]);
    return sum;
  })();

  useEffect(() => {
    let cancelled = false;
    api.getMapsKey()
      .then((d) => { if (!cancelled) setMapsKey(d.maps_api_key || ""); })
      .catch(() => { if (!cancelled) setStatus("error"); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!mapsKey) return;
    let cancelled = false;
    loadGoogleMaps(mapsKey)
      .then(() => {
        const g = mapsNS();
        if (cancelled || !mapDivRef.current || !g) return;
        const center = lat && lng ? { lat, lng } : { lat: 29.7604, lng: -95.3698 }; // Houston
        mapRef.current = new g.Map(mapDivRef.current, {
          center,
          zoom: lat && lng ? DEFAULT_ZOOM : 11,
          mapTypeId: "satellite",
          tilt: 0,            // Static Maps has no tilt; keep them matched.
          rotateControl: false,
          streetViewControl: false,
          fullscreenControl: true,
          mapTypeControl: false,
          clickableIcons: false,
        });
        mapRef.current.addListener("click", (e: { latLng: { lat(): number; lng(): number } }) => {
          if (!e.latLng) return;
          setPoints((prev) => [...prev, { lat: e.latLng.lat(), lng: e.latLng.lng() }]);
        });
        setStatus("ready");

        // Most leads aren't geocoded — the background map loop only covers
        // leads in mappable stages, so lat/lng is 0 for the majority and
        // this would otherwise open on central Houston. Resolve the address
        // here so the map lands on the house with nothing typed.
        if ((!lat || !lng) && address && address.trim()) {
          try {
            new g.Geocoder().geocode({ address: address.trim() }, (res, ok) => {
              if (cancelled || ok !== "OK" || !res || res.length === 0) return;
              const loc = res[0].geometry.location;
              mapRef.current?.setCenter({ lat: loc.lat(), lng: loc.lng() });
              mapRef.current?.setZoom(DEFAULT_ZOOM);
            });
          } catch {
            /* leave it on the default view; the search box still works */
          }
        }
      })
      .catch(() => { if (!cancelled) setStatus("error"); });
    return () => { cancelled = true; };
  }, [mapsKey, lat, lng, address]);

  useEffect(() => {
    if (!mapsKey && status === "loading") {
      const t = setTimeout(() => setStatus((s) => (s === "loading" ? "nokey" : s)), 4000);
      return () => clearTimeout(t);
    }
  }, [mapsKey, status]);

  // Redraw the path, the vertex dots and the per-leg footage labels whenever
  // the points change. Everything is torn down first — Google overlays are
  // not React-managed, so leaving them attached leaks them onto the map.
  useEffect(() => {
    const g = mapsNS();
    if (status !== "ready" || !mapRef.current || !g) return;

    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];
    labelsRef.current.forEach((m) => m.setMap(null));
    labelsRef.current = [];
    if (lineRef.current) { lineRef.current.setMap(null); lineRef.current = null; }

    if (points.length === 0) return;

    const path = closed && points.length > 2 ? [...points, points[0]] : points;
    lineRef.current = new g.Polyline({
      path,
      map: mapRef.current,
      strokeColor: "#f59e0b",
      strokeWeight: 3,
      strokeOpacity: 1,
    });

    points.forEach((p) => {
      markersRef.current.push(new g.Marker({
        position: p,
        map: mapRef.current,
        icon: {
          path: g.SymbolPath.CIRCLE,
          scale: 5,
          fillColor: "#f59e0b",
          fillOpacity: 1,
          strokeColor: "#fff",
          strokeWeight: 2,
        },
      }));
    });

    // Footage per leg, pinned at each leg's midpoint.
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const feet = haversineFeet(a, b);
      if (feet < 3) continue;
      labelsRef.current.push(new g.Marker({
        position: { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 },
        map: mapRef.current,
        icon: { path: g.SymbolPath.CIRCLE, scale: 0, fillOpacity: 0, strokeOpacity: 0 },
        label: {
          text: `${Math.round(feet)} ft`,
          color: "#fff",
          fontSize: "12px",
          fontWeight: "700",
          className: "gm-leg-label",
        },
      }));
    }
  }, [points, closed, status]);

  const doSearch = useCallback(() => {
    const g = mapsNS();
    const q = search.trim();
    if (!q || !mapRef.current || !g) return;
    try {
      new g.Geocoder().geocode({ address: q }, (res, ok) => {
        if (ok !== "OK" || !res || res.length === 0) {
          toast.error("Couldn't find that address");
          return;
        }
        const loc = res[0].geometry.location;
        mapRef.current.setCenter({ lat: loc.lat(), lng: loc.lng() });
        mapRef.current.setZoom(DEFAULT_ZOOM);
      });
    } catch {
      toast.error("Address lookup failed");
    }
  }, [search]);

  async function capture() {
    if (!mapRef.current) return;
    setCapturing(true);
    try {
      const c = mapRef.current.getCenter();
      // Match the capture's ground coverage to what is on screen. Static
      // Maps renders `size` CSS pixels of ground at the given zoom, so
      // asking for a flat 640x640 while the div is, say, 520px wide would
      // save a wider view than the VA framed — the fence would sit smaller
      // in the image than they just measured. 640 is the ceiling the
      // standard tier serves; scale=2 then doubles the resolution without
      // changing the area covered.
      const rect = mapDivRef.current?.getBoundingClientRect();
      const px = Math.max(100, Math.min(640, Math.round(rect?.width || 640)));
      const res = await api.captureSatelliteMeasurement(leadId, {
        lat: c.lat(),
        lng: c.lng(),
        zoom: Math.round(mapRef.current.getZoom()),
        size: `${px}x${px}`,
        also_scope: true,
        linear_feet: total > 0 ? Math.round(total) : null,
      });
      toast.success(
        res.linear_feet
          ? `Captured — ${res.linear_feet} ft saved, ready for scope of work`
          : "Captured — ready for scope of work",
      );
      if (res.linear_feet && onLinearFeet) onLinearFeet(res.linear_feet);
      onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Capture failed");
    } finally {
      setCapturing(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Ruler className="h-4 w-4" />
          Measure &amp; Capture
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Click along the fence to measure it, then capture the view straight
          into the scope of work. No new tab.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {status === "nokey" || status === "error" ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {status === "nokey"
              ? "No Google Maps key is configured, so the satellite view can't load."
              : "The satellite view failed to load. Check the Maps key's allowed referrers."}
          </div>
        ) : null}

        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void doSearch(); } }}
              placeholder={address || "Search an address…"}
              className="pl-8"
            />
          </div>
          <Button variant="outline" size="sm" onClick={() => void doSearch()}>Find</Button>
        </div>

        {/* Square, to match the square Static Maps capture. */}
        <div
          ref={mapDivRef}
          className="w-full aspect-square max-w-full rounded-lg border bg-muted"
        />

        <div className="flex flex-wrap items-center gap-2">
          <div className="text-sm font-semibold tabular-nums mr-auto">
            {points.length < 2
              ? <span className="text-muted-foreground font-normal">Click two or more points to measure</span>
              : <>{Math.round(total)} ft<span className="text-muted-foreground font-normal"> traced</span></>}
          </div>
          <Button
            variant="outline" size="sm"
            disabled={points.length === 0}
            onClick={() => setPoints((p) => p.slice(0, -1))}
          >
            <Undo2 className="h-4 w-4 mr-1" /> Undo
          </Button>
          <Button
            variant="outline" size="sm"
            disabled={points.length < 3}
            onClick={() => setClosed((c) => !c)}
            title="Count the leg back to the first point"
          >
            {closed ? "Open path" : "Close loop"}
          </Button>
          <Button
            variant="outline" size="sm"
            disabled={points.length === 0}
            onClick={() => { setPoints([]); setClosed(false); }}
          >
            <Trash2 className="h-4 w-4 mr-1" /> Clear
          </Button>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => void capture()}
            disabled={capturing || status !== "ready"}
            className="flex-1 min-w-[200px]"
          >
            {capturing
              ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Capturing…</>
              : <><Camera className="h-4 w-4 mr-2" /> Capture → Scope of Work</>}
          </Button>
          {total > 0 && onLinearFeet ? (
            <Button variant="outline" onClick={() => onLinearFeet(Math.round(total))}>
              Use {Math.round(total)} ft
            </Button>
          ) : null}
        </div>

        <p className="text-[11px] text-muted-foreground">
          The capture saves the satellite image as both the measurement on
          file and the scope-of-work source, and writes the traced footage
          into Linear Feet.
        </p>
      </CardContent>
    </Card>
  );
}
