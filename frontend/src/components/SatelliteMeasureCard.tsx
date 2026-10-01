import { useCallback, useEffect, useRef, useState } from "react";
import { api, type MeasurementPhoto } from "@/lib/api";
import { loadGoogleMaps, onMapsAuthFailure } from "@/lib/googleMaps";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  Camera, Loader2, Ruler, Search, Undo2, Trash2, Plus, X, RefreshCw,
} from "lucide-react";

/**
 * Measure and capture a property without leaving the page.
 *
 * The loop this replaces, per lead: open maps.google.com in a new tab, find
 * the house, measure with Google's tool, screenshot, save to disk, come
 * back, pick the file, upload — then upload the same image again for the
 * fence scope.
 *
 * Three things shape the design:
 *
 * 1. **A job needs several measurements.** All the insides is one run; the
 *    back side facing out is another. So a view holds multiple *runs* that
 *    sum, and a lead holds multiple *photos* that also sum. Linear Feet ends
 *    up as the total across every photo, computed server-side.
 *
 * 2. **The capture is taken server-side.** Google serves map tiles
 *    cross-origin, so painting this map into a <canvas> taints it and
 *    `toDataURL()` throws — screenshotting a Google map in the browser is
 *    not possible, not merely awkward. The interactive map finds and frames;
 *    the backend re-fetches the identical centre and zoom from Static Maps.
 *    That is also why the capture passes the map div's real pixel width:
 *    Static Maps renders `size` pixels of ground, so a fixed 640 would save
 *    a wider view than was measured.
 *
 * 3. **Distances are computed locally with haversine**, not Google's
 *    `geometry` library. The shared loader injects the Maps script once
 *    without extra libraries, so depending on `geometry` would mean either
 *    changing that shared URL or breaking whenever another component loads
 *    the script first. Over a few hundred feet the two agree to well under
 *    an inch.
 */

interface Props {
  leadId: string;
  lat: number;
  lng: number;
  address?: string;
  /** Push the job total into the estimator's Linear Feet input. */
  onLinearFeet?: (feet: number) => void;
  /** Re-fetch the lead so the measurement and scope previews refresh. */
  onChange: () => void;
}

const EARTH_FT = 20902231; // mean Earth radius in feet
const DEFAULT_ZOOM = 20;

// One colour per run so overlapping measurements stay tellable apart.
const RUN_COLORS = ["#f59e0b", "#38bdf8", "#a3e635", "#f472b6", "#fb923c", "#c084fc"];

type Pt = { lat: number; lng: number };
type Run = { id: number; points: Pt[]; closed: boolean };

/** The Maps namespace once the shared loader has injected the script, or
 *  null before that. Callers early-return rather than asserting, so a slow
 *  or blocked script load degrades to an inert card. */
function mapsNS(): GoogleMapsNS | null {
  return (typeof window !== "undefined" && window.google?.maps) || null;
}

function haversineFeet(a: Pt, b: Pt): number {
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

function runFeet(run: Run): number {
  const path = run.closed && run.points.length > 2
    ? [...run.points, run.points[0]]
    : run.points;
  let sum = 0;
  for (let i = 1; i < path.length; i++) sum += haversineFeet(path[i - 1], path[i]);
  return sum;
}

export default function SatelliteMeasureCard({
  leadId, lat, lng, address, onLinearFeet, onChange,
}: Props) {
  const mapDivRef = useRef<HTMLDivElement>(null);
  // Typed loosely on purpose: src/types/google-maps.d.ts is a hand-written
  // minimal shim, not @types/google.maps, so Map/Marker aren't fully described.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const mapRef = useRef<any>(null);
  const overlaysRef = useRef<any[]>([]);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const [status, setStatus] = useState<
    "loading" | "ready" | "nokey" | "error" | "authfail"
  >("loading");
  const [runs, setRuns] = useState<Run[]>([{ id: 1, points: [], closed: false }]);
  const [activeRun, setActiveRun] = useState(1);
  const [capturing, setCapturing] = useState(false);
  const [search, setSearch] = useState("");
  const [mapsKey, setMapsKey] = useState("");
  const [keySource, setKeySource] = useState("");
  const [photos, setPhotos] = useState<MeasurementPhoto[]>([]);
  const [jobTotal, setJobTotal] = useState<number | null>(null);

  const viewTotal = runs.reduce((s, r) => s + runFeet(r), 0);
  const anyPoints = runs.some((r) => r.points.length > 0);

  // Google rejecting the key beats everything else: the script loads, the
  // promise resolves, and the div just stays grey. Without this the card
  // would sit on "loading" with the reason only in the console.
  useEffect(() => onMapsAuthFailure(() => setStatus("authfail")), []);

  const loadPhotos = useCallback(async () => {
    try {
      const d = await api.listMeasurements(leadId);
      setPhotos(d.measurements);
      setJobTotal(d.total_linear_feet);
    } catch {
      /* non-fatal: the map is still usable without the strip */
    }
  }, [leadId]);

  useEffect(() => { void loadPhotos(); }, [loadPhotos]);

  useEffect(() => {
    let cancelled = false;
    api.getMapsKey()
      .then((d) => {
        if (cancelled) return;
        setMapsKey(d.maps_api_key || "");
        setKeySource(d.key_source || "");
        if (!d.maps_api_key) setStatus("nokey");
      })
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
          tilt: 0,             // Static Maps has no tilt; keep them matched.
          rotateControl: false,
          streetViewControl: false,
          fullscreenControl: true,
          mapTypeControl: false,
          clickableIcons: false,
        });
        mapRef.current.addListener(
          "click",
          (e: { latLng: { lat(): number; lng(): number } }) => {
            if (!e.latLng) return;
            const p = { lat: e.latLng.lat(), lng: e.latLng.lng() };
            setRuns((prev) => prev.map((r) =>
              r.id === activeRunRef.current
                ? { ...r, points: [...r.points, p] }
                : r,
            ));
          },
        );
        setStatus("ready");

        // Most leads aren't geocoded — the background map loop only covers
        // leads in mappable stages — so without this the map would open on
        // central Houston. Resolve the address so it lands on the house.
        if ((!lat || !lng) && address && address.trim()) {
          try {
            new g.Geocoder().geocode({ address: address.trim() }, (res, ok) => {
              if (cancelled || ok !== "OK" || !res || res.length === 0) return;
              const loc = res[0].geometry.location;
              mapRef.current?.setCenter({ lat: loc.lat(), lng: loc.lng() });
              mapRef.current?.setZoom(DEFAULT_ZOOM);
            });
          } catch {
            /* leave the default view; the search box still works */
          }
        }
      })
      .catch(() => { if (!cancelled) setStatus("error"); });
    return () => { cancelled = true; };
  }, [mapsKey, lat, lng, address]);

  // The click handler is registered once, so it closes over the first
  // activeRun. A ref keeps it reading the current one.
  const activeRunRef = useRef(activeRun);
  useEffect(() => { activeRunRef.current = activeRun; }, [activeRun]);

  // Redraw paths, vertices and per-leg labels. Google overlays aren't
  // React-managed, so everything is torn down first or they leak onto the map.
  useEffect(() => {
    const g = mapsNS();
    if (status !== "ready" || !mapRef.current || !g) return;

    overlaysRef.current.forEach((o) => o.setMap(null));
    overlaysRef.current = [];

    runs.forEach((run, idx) => {
      if (run.points.length === 0) return;
      const color = RUN_COLORS[idx % RUN_COLORS.length];
      const path = run.closed && run.points.length > 2
        ? [...run.points, run.points[0]]
        : run.points;

      overlaysRef.current.push(new g.Polyline({
        path,
        map: mapRef.current,
        strokeColor: color,
        strokeWeight: run.id === activeRun ? 4 : 3,
        strokeOpacity: run.id === activeRun ? 1 : 0.75,
      }));

      run.points.forEach((p) => {
        overlaysRef.current.push(new g.Marker({
          position: p,
          map: mapRef.current,
          icon: {
            path: g.SymbolPath.CIRCLE,
            scale: 5,
            fillColor: color,
            fillOpacity: 1,
            strokeColor: "#fff",
            strokeWeight: 2,
          },
        }));
      });

      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i];
        const feet = haversineFeet(a, b);
        if (feet < 3) continue;
        overlaysRef.current.push(new g.Marker({
          position: { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 },
          map: mapRef.current,
          icon: { path: g.SymbolPath.CIRCLE, scale: 0, fillOpacity: 0, strokeOpacity: 0 },
          label: {
            text: `${Math.round(feet)} ft`,
            color: "#fff",
            fontSize: "12px",
            fontWeight: "700",
          },
        }));
      }
    });
  }, [runs, activeRun, status]);

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

  function addRun() {
    // id computed from current state rather than inside the updater — a
    // setState nested in another updater runs twice under StrictMode.
    const id = Math.max(0, ...runs.map((r) => r.id)) + 1;
    setRuns((prev) => [...prev, { id, points: [], closed: false }]);
    setActiveRun(id);
  }

  function removeRun(id: number) {
    const left = runs.filter((r) => r.id !== id);
    if (left.length === 0) return;      // always keep one to click into
    setRuns(left);
    // Picking runs[0] blindly would point at the run just deleted.
    if (activeRun === id) setActiveRun(left[0].id);
  }

  function resetRuns() {
    setRuns([{ id: 1, points: [], closed: false }]);
    setActiveRun(1);
  }

  async function capture(replaceId?: string) {
    if (!mapRef.current) return;
    setCapturing(true);
    try {
      const c = mapRef.current.getCenter();
      const rect = mapDivRef.current?.getBoundingClientRect();
      const px = Math.max(100, Math.min(640, Math.round(rect?.width || 640)));
      const res = await api.captureSatelliteMeasurement(leadId, {
        lat: c.lat(),
        lng: c.lng(),
        zoom: Math.round(mapRef.current.getZoom()),
        size: `${px}x${px}`,
        also_scope: true,
        linear_feet: viewTotal > 0 ? Math.round(viewTotal) : null,
        replace_id: replaceId || null,
      });
      toast.success(
        res.total_linear_feet
          ? `${res.label} saved — job total ${res.total_linear_feet} ft, ready for scope of work`
          : `${res.label} saved — ready for scope of work`,
      );
      if (res.total_linear_feet && onLinearFeet) onLinearFeet(res.total_linear_feet);
      resetRuns();
      await loadPhotos();
      onChange();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Capture failed";
      // Google's refusal arrives as "502: {"detail":"..."}". Pull out the
      // sentence that actually says what to do.
      const billing = /enable Billing/i.test(msg);
      const notEnabled = /has not been used in project|is disabled/i.test(msg);
      toast.error(
        billing
          ? "Google needs Billing enabled on the Cloud project before it will serve map images."
          : notEnabled
            ? "Enable the Maps Static API on your Google Maps key, then try again."
            : msg,
        { duration: 10000 },
      );
    } finally {
      setCapturing(false);
    }
  }

  async function removePhoto(p: MeasurementPhoto) {
    if (!confirm(`Delete ${p.label}? The job total will be re-calculated.`)) return;
    try {
      const res = await api.deleteMeasurementPhoto(leadId, p.id);
      if (res.total_linear_feet && onLinearFeet) onLinearFeet(res.total_linear_feet);
      await loadPhotos();
      onChange();
      toast.success(
        res.total_linear_feet
          ? `${p.label} deleted — job total now ${res.total_linear_feet} ft`
          : `${p.label} deleted`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete");
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
          Click along the fence to measure it. Add a separate measurement for
          each run — insides, back side — and they add up. Capture saves the
          photo and fills Linear Feet. No new tab.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {status === "nokey" || status === "error" || status === "authfail" ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 space-y-1">
            {status === "nokey" ? (
              <p>No Google Maps key is configured, so the satellite view can't load.</p>
            ) : status === "authfail" ? (
              <>
                <p className="font-medium">Google rejected the Maps key.</p>
                {keySource === "server_key" ? (
                  <p className="text-xs">
                    The backend is serving <code>GOOGLE_MAPS_API_KEY</code>,
                    which is the <b>server-side</b> key — it has no browser
                    referrer allowance, so Google refuses it here. Set a
                    separate <code>GOOGLE_MAPS_BROWSER_KEY</code> on Railway
                    with <b>Maps JavaScript API</b> + <b>Geocoding API</b>{" "}
                    enabled and <code>admin.atpressurewash.com/*</code> in its
                    allowed referrers.
                  </p>
                ) : (
                  <p className="text-xs">
                    Usually <b>Maps JavaScript API</b> isn't enabled, billing
                    is off, or the key's <b>HTTP referrer restrictions</b>
                    {" "}don't include this domain.
                  </p>
                )}
              </>
            ) : (
              <p>
                The satellite view failed to load — the Maps script or the key
                lookup didn't come back.
              </p>
            )}
          </div>
        ) : null}

        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); doSearch(); } }}
              placeholder={address || "Search an address…"}
              className="pl-8"
            />
          </div>
          <Button variant="outline" size="sm" onClick={doSearch}>Find</Button>
        </div>

        {/* Square, to match the square Static Maps capture. */}
        <div
          ref={mapDivRef}
          className="w-full aspect-square max-w-full rounded-lg border bg-muted"
        />

        {/* Each run, its footage, and which one clicks land on. */}
        <div className="space-y-1.5">
          {runs.map((run, idx) => {
            const feet = runFeet(run);
            const active = run.id === activeRun;
            return (
              <div
                key={run.id}
                onClick={() => setActiveRun(run.id)}
                className={`flex items-center gap-2 rounded-md border px-2 py-1.5 cursor-pointer ${
                  active ? "border-primary bg-primary/5" : "hover:bg-muted/40"
                }`}
              >
                <span
                  className="h-3 w-3 rounded-full shrink-0"
                  style={{ background: RUN_COLORS[idx % RUN_COLORS.length] }}
                />
                <span className="text-sm font-medium">
                  Measurement {idx + 1}
                </span>
                <span className="text-sm tabular-nums ml-auto">
                  {feet > 0
                    ? `${Math.round(feet)} ft`
                    : <span className="text-muted-foreground text-xs">
                        {active ? "click the map…" : "empty"}
                      </span>}
                </span>
                {run.points.length >= 3 ? (
                  <Button
                    size="sm" variant="ghost" className="h-6 px-1.5 text-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRuns((p) => p.map((r) =>
                        r.id === run.id ? { ...r, closed: !r.closed } : r));
                    }}
                    title="Count the leg back to the first point"
                  >
                    {run.closed ? "open" : "close"}
                  </Button>
                ) : null}
                {run.points.length > 0 ? (
                  <Button
                    size="sm" variant="ghost" className="h-6 w-6 p-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRuns((p) => p.map((r) =>
                        r.id === run.id ? { ...r, points: r.points.slice(0, -1) } : r));
                    }}
                    title="Undo last point"
                  >
                    <Undo2 className="h-3.5 w-3.5" />
                  </Button>
                ) : null}
                {runs.length > 1 ? (
                  <Button
                    size="sm" variant="ghost" className="h-6 w-6 p-0"
                    onClick={(e) => { e.stopPropagation(); removeRun(run.id); }}
                    title="Remove this measurement"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                ) : null}
              </div>
            );
          })}

          <div className="flex items-center gap-2 pt-0.5">
            <Button variant="outline" size="sm" onClick={addRun}>
              <Plus className="h-4 w-4 mr-1" /> Add measurement
            </Button>
            {anyPoints ? (
              <Button variant="ghost" size="sm" onClick={resetRuns}>
                <Trash2 className="h-4 w-4 mr-1" /> Clear all
              </Button>
            ) : null}
            <span className="ml-auto text-sm font-semibold tabular-nums">
              {viewTotal > 0 ? `${Math.round(viewTotal)} ft this view` : ""}
            </span>
          </div>
        </div>

        <Button
          onClick={() => void capture()}
          disabled={capturing || status !== "ready"}
          className="w-full"
        >
          {capturing
            ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Capturing…</>
            : <><Camera className="h-4 w-4 mr-2" /> Capture → Scope of Work</>}
        </Button>

        {/* Retained photos. Nothing is replaced, so an earlier view can
            always be re-opened rather than re-measured. */}
        {photos.length > 0 ? (
          <div className="space-y-2 pt-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                Saved photos ({photos.length})
              </span>
              <span className="text-sm font-semibold tabular-nums">
                {jobTotal ? `${jobTotal} ft total` : "no footage recorded"}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {photos.map((p) => (
                <PhotoTile
                  key={p.id}
                  leadId={leadId}
                  photo={p}
                  onDelete={() => void removePhoto(p)}
                  onReshoot={() => void capture(p.id)}
                  disabled={capturing || status !== "ready"}
                />
              ))}
            </div>
            {jobTotal && onLinearFeet ? (
              <Button
                variant="outline" size="sm" className="w-full"
                onClick={() => onLinearFeet(jobTotal)}
              >
                Use {jobTotal} ft as Linear Feet
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** One saved photo. The image needs the auth header, so it is fetched as a
 *  blob rather than pointed at with an <img src>. */
function PhotoTile({
  leadId, photo, onDelete, onReshoot, disabled,
}: {
  leadId: string;
  photo: MeasurementPhoto;
  onDelete: () => void;
  onReshoot: () => void;
  disabled: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!photo.has_image) return;
    let cancelled = false;
    let made: string | null = null;
    api.fetchMeasurementPhotoUrl(leadId, photo.id).then((u) => {
      if (cancelled) { if (u) URL.revokeObjectURL(u); return; }
      made = u;
      setUrl(u);
    });
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [leadId, photo.id, photo.has_image]);

  return (
    <div className="rounded-md border overflow-hidden group relative">
      {url ? (
        <img src={url} alt={photo.label} className="w-full aspect-square object-cover" />
      ) : (
        <div className="w-full aspect-square bg-muted animate-pulse" />
      )}
      <div className="px-2 py-1 flex items-center gap-1 text-xs">
        <span className="font-medium">{photo.label}</span>
        <span className="tabular-nums text-muted-foreground ml-auto">
          {photo.linear_feet ? `${Math.round(photo.linear_feet)} ft` : "—"}
        </span>
      </div>
      <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <Button
          size="sm" variant="secondary" className="h-6 w-6 p-0"
          onClick={onReshoot} disabled={disabled}
          title="Re-shoot this measurement from the current view"
        >
          <RefreshCw className="h-3 w-3" />
        </Button>
        <Button
          size="sm" variant="destructive" className="h-6 w-6 p-0"
          onClick={onDelete}
          title="Delete this photo"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
