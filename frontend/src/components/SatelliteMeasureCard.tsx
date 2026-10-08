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
  /** The ZIP the customer gave us. Used to pin the street down — a street
   *  line alone resolves ambiguously — but never trusted, because customers
   *  do fill it in wrong. See locateProperty. */
  zipCode?: string;
  /** Push the job total into the estimator's Linear Feet input. */
  onLinearFeet?: (feet: number) => void;
  /** Re-fetch the lead so the measurement and scope previews refresh. */
  onChange: () => void;
}

const EARTH_FT = 20902231; // mean Earth radius in feet
const DEFAULT_ZOOM = 20;

// One colour per run so overlapping measurements stay tellable apart.
const RUN_COLORS = ["#f59e0b", "#38bdf8", "#a3e635", "#f472b6", "#fb923c", "#c084fc"];

// Coarse pointer means fingers: bigger vertices and bigger tap targets.
// Checked once at module load — this does not change mid-session, and a
// media-query listener would be noise for what it buys.
const IS_TOUCH =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(pointer: coarse)").matches;

// A 24px icon button is well under the ~44px a fingertip needs, and these
// sit in a row next to each other where a miss undoes the wrong thing.
const TAP_BTN = IS_TOUCH ? "h-9 w-9 p-0" : "h-6 w-6 p-0";

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

/**
 * Where a tap actually landed, computed from first principles.
 *
 * Google's click event hands back a latLng, but it derives that from a cached
 * copy of the container's dimensions. When that cache is stale the point
 * lands nowhere near the finger — badly on a phone, where the error scales
 * with how wrong the cache is. Telling the map to resize helps, but it is a
 * race: any layout change between the resize and the tap reopens the gap.
 *
 * So this does the projection itself, from three things we can trust: the
 * map's centre, its zoom, and the div's size measured at the moment of the
 * tap. Standard Web Mercator with 256px tiles, which is exactly what Google
 * renders, so the result agrees with the imagery to the pixel.
 *
 * `getBounds()` would be the easier route and is NOT used — it comes from the
 * same stale size cache, so it would inherit the bug.
 */
function latLngFromPixel(
  center: Pt, zoom: number, width: number, height: number, px: number, py: number,
): Pt {
  const scale = 256 * Math.pow(2, zoom);          // world size in pixels
  const sinLat = Math.sin((center.lat * Math.PI) / 180);

  // Project the centre into world pixel space.
  const cx = ((center.lng + 180) / 360) * scale;
  const cy = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;

  // The tap, as an offset from the centre of the viewport.
  const tx = cx + (px - width / 2);
  const ty = cy + (py - height / 2);

  // Unproject back to degrees.
  const lng = (tx / scale) * 360 - 180;
  const n = Math.PI * (1 - (2 * ty) / scale);
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { lat, lng };
}

// Sterling works the Houston metro. A geocode landing outside this box is
// wrong, whatever Google says — the usual cause is a mistyped ZIP matching a
// real street somewhere else. Generous on purpose: it only has to catch
// "different state", not "different suburb". Mirrors the backend's
// _in_home_region check in api/leads.py.
const TX_BOX = { minLat: 25.5, maxLat: 36.6, minLng: -106.7, maxLng: -93.4 };

function inHomeRegion(p: Pt): boolean {
  return (
    p.lat >= TX_BOX.minLat && p.lat <= TX_BOX.maxLat &&
    p.lng >= TX_BOX.minLng && p.lng <= TX_BOX.maxLng
  );
}

/**
 * Find the property, using the ZIP but not trusting it.
 *
 * A street line on its own is ambiguous — "225 Mesquite Falls Ln" exists in
 * more than one state — so the ZIP is what pins it down and is always
 * included. But customers do type the wrong ZIP, and a wrong-but-valid ZIP
 * geocodes confidently to the wrong place, which is worse than failing.
 *
 * So: try with the ZIP, sanity-check the answer is in Texas, and if it isn't
 * (or the ZIP produced nothing) fall back to the street line restricted to
 * TX. `onResult` reports which route won so the VA can see when a ZIP was
 * overridden rather than silently measuring the wrong house.
 */
function locateProperty(
  g: GoogleMapsNS,
  address: string,
  zip: string,
  onResult: (p: Pt, note: string) => void,
) {
  const street = address.trim();
  const z = (zip || "").trim();
  if (!street) return;

  const tryTxOnly = () => {
    new g.Geocoder().geocode(
      { address: street, componentRestrictions: { country: "US", administrativeArea: "TX" } },
      (res, ok) => {
        if (ok !== "OK" || !res?.length) return;
        const loc = res[0].geometry.location;
        const p = { lat: loc.lat(), lng: loc.lng() };
        if (!inHomeRegion(p)) return;   // give up rather than guess
        onResult(p, z
          ? `ZIP ${z} didn't resolve near Houston — located from the street address instead. Worth checking.`
          : "No ZIP on file — located from the street address.");
      },
    );
  };

  if (!z) { tryTxOnly(); return; }

  new g.Geocoder().geocode(
    { address: `${street} ${z}`, componentRestrictions: { country: "US" } },
    (res, ok) => {
      if (ok !== "OK" || !res?.length) { tryTxOnly(); return; }
      const loc = res[0].geometry.location;
      const p = { lat: loc.lat(), lng: loc.lng() };
      if (!inHomeRegion(p)) { tryTxOnly(); return; }
      onResult(p, "");
    },
  );
}

/** Google's click payload: a latLng it computed, plus the raw DOM event. */
type GMapMouseEvent = {
  latLng?: { lat(): number; lng(): number };
  domEvent?: MouseEvent | TouchEvent;
};

/**
 * The tapped point, preferring our own projection over Google's.
 *
 * Falls back to Google's latLng only when the raw DOM event or the map state
 * isn't available, so the worst case is the old behaviour rather than no
 * point at all.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function pointFromMapClick(
  e: GMapMouseEvent, map: any, div: HTMLDivElement | null,
): Pt | null {
  const fallback = e.latLng
    ? { lat: e.latLng.lat(), lng: e.latLng.lng() }
    : null;

  const dom = e.domEvent;
  if (!dom || !div || !map?.getCenter || !map?.getZoom) return fallback;

  // A touch tap reports its coordinates on changedTouches, not on the event.
  let clientX: number | undefined;
  let clientY: number | undefined;
  if ("clientX" in dom && typeof dom.clientX === "number") {
    clientX = dom.clientX;
    clientY = (dom as MouseEvent).clientY;
  } else {
    const t = (dom as TouchEvent).changedTouches?.[0]
      || (dom as TouchEvent).touches?.[0];
    if (t) { clientX = t.clientX; clientY = t.clientY; }
  }
  if (clientX === undefined || clientY === undefined) return fallback;

  // Measured now, not cached — that is the whole point.
  const rect = div.getBoundingClientRect();
  if (!rect.width || !rect.height) return fallback;

  const c = map.getCenter();
  const z = map.getZoom();
  if (!c || typeof z !== "number") return fallback;

  return latLngFromPixel(
    { lat: c.lat(), lng: c.lng() },
    z, rect.width, rect.height,
    clientX - rect.left, clientY - rect.top,
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function runFeet(run: Run): number {
  const path = run.closed && run.points.length > 2
    ? [...run.points, run.points[0]]
    : run.points;
  let sum = 0;
  for (let i = 1; i < path.length; i++) sum += haversineFeet(path[i - 1], path[i]);
  return sum;
}

export default function SatelliteMeasureCard({
  leadId, lat, lng, address, zipCode, onLinearFeet, onChange,
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
  // Set when Google refuses the capture for a key/billing reason. The map
  // and the capture use DIFFERENT keys (browser vs server), so "the map
  // works but Capture won't" is normal and needs its own diagnosis.
  const [keyProblem, setKeyProblem] = useState("");
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnosis, setDiagnosis] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [mapsKey, setMapsKey] = useState("");
  const [keySource, setKeySource] = useState("");
  const [photos, setPhotos] = useState<MeasurementPhoto[]>([]);
  const [jobTotal, setJobTotal] = useState<number | null>(null);
  // Set when the property had to be located the hard way — e.g. the ZIP the
  // customer gave didn't resolve near Houston. Shown rather than swallowed,
  // because measuring the wrong house produces a confidently wrong quote.
  const [locateNote, setLocateNote] = useState("");

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

  // Build the map exactly once.
  //
  // This deliberately depends on `mapsKey` alone. It used to also depend on
  // the lead's lat/lng/address, which looked harmless but wasn't: the lead
  // page does not unmount when you switch customers — React Router keeps
  // this component mounted and only changes the lead — so the effect re-ran
  // and constructed a SECOND google.maps.Map over the same div while the
  // first was still alive and still listening for clicks. Two maps with
  // different centres both handling taps is why measuring worked on the
  // first customer and then went wrong on the next one.
  //
  // Re-aiming at a new property is a separate effect below, which moves this
  // map rather than replacing it.
  useEffect(() => {
    if (!mapsKey || mapRef.current) return;
    let cancelled = false;
    loadGoogleMaps(mapsKey)
      .then(() => {
        const g = mapsNS();
        if (cancelled || !mapDivRef.current || !g || mapRef.current) return;
        mapRef.current = new g.Map(mapDivRef.current, {
          center: { lat: 29.7604, lng: -95.3698 },   // Houston, until aimed
          zoom: 11,
          mapTypeId: "satellite",
          tilt: 0,             // Static Maps has no tilt; keep them matched.
          rotateControl: false,
          streetViewControl: false,
          fullscreenControl: true,
          mapTypeControl: false,
          clickableIcons: false,
          // "greedy" so one finger pans the map. The mobile default is
          // "cooperative", which needs two fingers and makes a one-finger
          // drag scroll the page instead — which reads as the map ignoring
          // you. Measuring is a tapping job, so the map wins the gesture.
          gestureHandling: "greedy",
          // Chunkier controls for thumbs.
          controlSize: 32,
          zoomControl: true,
        });
        mapRef.current.addListener("click", (e: GMapMouseEvent) => {
          const p = pointFromMapClick(e, mapRef.current, mapDivRef.current);
          if (!p) return;
          setRuns((prev) => prev.map((r) =>
            r.id === activeRunRef.current
              ? { ...r, points: [...r.points, p] }
              : r,
          ));
        });
        setStatus("ready");
      })
      .catch(() => { if (!cancelled) setStatus("error"); });
    return () => { cancelled = true; };
  }, [mapsKey]);

  // Aim the existing map at whichever customer is open, and start their
  // measurements from scratch.
  //
  // Keyed on leadId as well as the coordinates: two customers can share a
  // lat/lng of 0 (most leads are never geocoded), so without leadId in the
  // deps, switching between two un-geocoded leads would silently carry the
  // previous property's traced points — and their footage — into the next
  // one's capture.
  useEffect(() => {
    if (status !== "ready" || !mapRef.current) return;
    const g = mapsNS();
    if (!g) return;
    let cancelled = false;

    setRuns([{ id: 1, points: [], closed: false }]);
    setActiveRun(1);

    setLocateNote("");

    if (lat && lng) {
      mapRef.current.setCenter({ lat, lng });
      mapRef.current.setZoom(DEFAULT_ZOOM);
    } else if (address && address.trim()) {
      // Most leads aren't geocoded — the background map loop only covers
      // leads in mappable stages — so without this the map would sit on
      // central Houston. Resolve the address so it lands on the house.
      try {
        locateProperty(g, address, zipCode || "", (p, note) => {
          if (cancelled) return;
          mapRef.current?.setCenter(p);
          mapRef.current?.setZoom(DEFAULT_ZOOM);
          if (note) setLocateNote(note);
        });
      } catch {
        /* leave the view where it is; the search box still works */
      }
    }
    return () => { cancelled = true; };
  }, [leadId, lat, lng, address, zipCode, status]);

  // The click handler is registered once, so it closes over the first
  // activeRun. A ref keeps it reading the current one.
  const activeRunRef = useRef(activeRun);
  useEffect(() => { activeRunRef.current = activeRun; }, [activeRun]);

  // Keep Google's idea of the container size in step with reality.
  //
  // Google caches the map div's dimensions and hit-tests clicks against that
  // cache. If the div resizes afterwards, a tap is translated using the old
  // size and the point lands away from the finger — proportionally to how
  // wrong the cache is, so on a phone it can be most of the screen. This div
  // resizes for several ordinary reasons: it is `aspect-square`, so its
  // height follows its width; the warning box above it appears and
  // disappears; and the saved-photo strip below it arrives after a fetch.
  //
  // A ResizeObserver covers all of those plus rotating the phone, without
  // guessing which one happened. Centre is saved and restored because a
  // resize re-anchors on the top-left corner, not the middle.
  useEffect(() => {
    const el = mapDivRef.current;
    if (status !== "ready" || !el) return;
    if (typeof ResizeObserver === "undefined") return;

    let frame = 0;
    const ro = new ResizeObserver(() => {
      // Coalesce the burst a layout change produces into one correction.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const g = mapsNS();
        const map = mapRef.current;
        if (!g || !map) return;
        const c = map.getCenter?.();
        g.event.trigger(map, "resize");
        if (c) map.setCenter({ lat: c.lat(), lng: c.lng() });
      });
    });
    ro.observe(el);
    return () => { cancelAnimationFrame(frame); ro.disconnect(); };
  }, [status]);

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
            // Bigger on touch: a 5px dot under a fingertip is invisible at
            // the moment you most need to see where the last point landed.
            scale: IS_TOUCH ? 7 : 5,
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
      // Google has no imagery-date parameter, so the one thing we control is
      // detail: capturing below the framed zoom means a wider, coarser image
      // than was measured. Said out loud rather than silently accepted.
      if (res.zoom < res.requested_zoom) {
        toast.warning(
          `Saved at zoom ${res.zoom} — Google wouldn't serve the image at ${res.requested_zoom}, `
          + "so it covers more ground than you framed.",
          { duration: 8000 },
        );
      }
      setKeyProblem("");
      setDiagnosis([]);
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
      const friendly = billing
        ? "Google needs Billing enabled on the Cloud project behind the SERVER key. "
          + "The map you just drew on uses a different key, which is why it still works."
        : notEnabled
          ? "Enable the Maps Static API on the server Google Maps key, then try again."
          : msg;
      if (billing || notEnabled) setKeyProblem(friendly);
      toast.error(friendly, { duration: 10000 });
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
              placeholder={
                address
                  ? `${address}${zipCode ? ` ${zipCode}` : ""}`
                  : "Search an address…"
              }
              className="pl-8"
            />
          </div>
          <Button variant="outline" size="sm" onClick={doSearch}>Find</Button>
        </div>

        {locateNote ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {locateNote}
          </div>
        ) : null}

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
                    size="sm" variant="ghost" className={IS_TOUCH ? "h-9 px-3 text-xs" : "h-6 px-1.5 text-xs"}
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
                    size="sm" variant="ghost" className={TAP_BTN}
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
                    size="sm" variant="ghost" className={TAP_BTN}
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

        {/* Google refused the image. Shown here rather than only as a toast,
            because the fix lives in the Cloud Console and the toast is gone
            by the time anybody gets there. */}
        {keyProblem ? (
          <div className="rounded-lg border border-amber-400 bg-amber-50 p-3 space-y-2">
            <p className="text-xs text-amber-900 font-medium">{keyProblem}</p>
            <Button
              variant="outline"
              size="sm"
              disabled={diagnosing}
              onClick={async () => {
                setDiagnosing(true);
                try {
                  const r = await api.getMapsKeySelftest();
                  const lines = Object.entries(r.checks).map(([name, c]) =>
                    `${c.ok ? "OK" : "FAILING"} — ${name}${c.detail ? `: ${c.detail}` : ""}`);
                  lines.push(
                    `Map key in use: ${r.key_source}`,
                    r.has_separate_browser_key
                      ? "A separate browser key is configured, so the map and the capture use different Google projects."
                      : "One key does both jobs, so this is project-wide.",
                  );
                  setDiagnosis(lines);
                } catch (e) {
                  setDiagnosis([e instanceof Error ? e.message : "Could not reach the diagnostic"]);
                } finally {
                  setDiagnosing(false);
                }
              }}
            >
              {diagnosing
                ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Asking Google…</>
                : "Ask Google what's wrong"}
            </Button>
            {diagnosis.length > 0 ? (
              <ul className="text-[11px] text-amber-900 space-y-1 font-mono break-words">
                {diagnosis.map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            ) : null}
          </div>
        ) : null}

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
