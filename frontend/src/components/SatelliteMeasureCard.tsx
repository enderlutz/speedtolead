import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type MeasurementPhoto } from "@/lib/api";
import { loadGoogleMaps, onMapsAuthFailure } from "@/lib/googleMaps";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/Panel";
import { ACCENT } from "@/lib/accents";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  Camera, Loader2, Ruler, Search, Undo2, Trash2, Plus, X, RefreshCw,
  ArrowUp, ZoomIn, ZoomOut, Upload, FileText } from "lucide-react";

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

// Fine zoom and rotation (Alan, 2026-10-08: "adjust the angle I'm looking at
// the house" and "zoom in exactly as much as I want"). Google's satellite
// basemap is raster, so Maps JS neither turns it nor zooms it by fractions.
// Google holds the whole-number zoom; a CSS transform on the map div carries
// the rest — turned by `rot` degrees and scaled by 2^frac. The div is twice
// the frame's size so that, turned and at the smallest scale, it still
// covers the frame. Capture sends the fractional zoom and the rotation and
// the server turns and crops the Static Maps image to match.
const ZOOM_STEP = 0.25;
const ZOOM_MIN = 14;
const ZOOM_MAX = 22;

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

/** A point's offset from the map centre, in map pixels at `zoom` — the
 *  inverse of latLngFromPixel, for placing the footage labels. */
function pixelFromLatLng(center: Pt, zoom: number, p: Pt): { x: number; y: number } {
  const scale = 256 * Math.pow(2, zoom);
  const proj = (q: Pt) => {
    const sinLat = Math.sin((q.lat * Math.PI) / 180);
    return {
      x: ((q.lng + 180) / 360) * scale,
      y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale,
    };
  };
  const c = proj(center), q = proj(p);
  return { x: q.x - c.x, y: q.y - c.y };
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
  leadId, lat, lng, address, zipCode, onLinearFeet, onChange,
}: Props) {
  const navigate = useNavigate();
  const mapDivRef = useRef<HTMLDivElement>(null);
  // The square the VA sees. The map div inside it is twice its size and
  // transformed; the overlay on top takes every gesture.
  const frameRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [rot, setRot] = useState(0);          // degrees clockwise, 0 = north up
  const [frac, setFrac] = useState(0);        // zoom beyond Google's whole number
  const [zf, setZf] = useState(DEFAULT_ZOOM); // the fine zoom, for the slider
  // Mirrors of rot/frac for the gesture handlers, written synchronously so a
  // pinch never reads a stale value.
  const viewRef = useRef({ rot: 0, frac: 0 });
  // Bumped on every pan and zoom so the footage labels follow the map.
  const [tick, setTick] = useState(0);
  const [labels, setLabels] = useState<{ key: string; x: number; y: number; text: string }[]>([]);
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
  // Where the house actually is. The map centres here on open, but the VA
  // pans and zooms while tracing, so the map centre stops being the house —
  // and a captured aerial of a street of near-identical roofs is impossible
  // to match to a customer without a pin on it.
  const [pin, setPin] = useState<Pt | null>(null);
  const pinOverlayRef = useRef<GMarker | null>(null);
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

  /** Map-local offset for a screen offset: undo the frame's turn and scale. */
  function unrotate(dx: number, dy: number): { x: number; y: number } {
    const { rot: r, frac: f } = viewRef.current;
    const a = (-r * Math.PI) / 180;
    const s = Math.pow(2, f);
    return {
      x: (dx * Math.cos(a) - dy * Math.sin(a)) / s,
      y: (dx * Math.sin(a) + dy * Math.cos(a)) / s,
    };
  }

  /** Screen offset for a map-local offset: apply the frame's turn and scale. */
  function rotateOut(ux: number, uy: number): { x: number; y: number } {
    const { rot: r, frac: f } = viewRef.current;
    const a = (r * Math.PI) / 180;
    const s = Math.pow(2, f);
    return {
      x: (ux * Math.cos(a) - uy * Math.sin(a)) * s,
      y: (ux * Math.sin(a) + uy * Math.cos(a)) * s,
    };
  }

  /** The zoom as framed: Google's whole number plus our fraction. */
  function zoomFine(): number {
    const z = mapRef.current?.getZoom?.();
    return (typeof z === "number" ? z : DEFAULT_ZOOM) + viewRef.current.frac;
  }

  /** Zoom to a fractional level. Google takes the whole number — and may
   *  refuse to go as far as asked, since its ceiling depends on the imagery
   *  at that spot — and the wrapper's scale takes whatever is left.
   *
   *  Google is moved with moveCamera, which is instant. setZoom ANIMATES the
   *  tiles over a quarter second, and under a CSS scale that has already
   *  snapped to compensate, that reads as the picture lurching to half size
   *  and growing back — the glitch Alan saw on the slider (2026-10-08). */
  const setZoomFine = useCallback((target: number) => {
    const map = mapRef.current;
    if (!map?.getZoom) return;
    const want = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX + 1, target));
    const whole = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(want)));
    if (map.getZoom() !== whole) {
      const c = map.getCenter?.();
      if (typeof map.moveCamera === "function" && c) map.moveCamera({ zoom: whole, center: c });
      else map.setZoom(whole);
    }
    const got = map.getZoom();
    const base = typeof got === "number" ? got : whole;
    const f = Math.max(-0.5, Math.min(1, want - base));
    viewRef.current.frac = f;
    setFrac(f);
    setZf(base + f);
  }, []);

  // The compass dial: grab it and spin. The view turns by the same amount
  // the finger moved round the dial's centre, so it follows wherever it was
  // grabbed; a tap (no turn) puts north back at the top.
  const dialRef = useRef<HTMLDivElement>(null);
  const dialDrag = useRef<{ id: number; angle0: number; rot0: number; turned: boolean } | null>(null);

  function dialAngle(e: React.PointerEvent): number {
    const r = dialRef.current?.getBoundingClientRect();
    if (!r) return 0;
    return (Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI;
  }

  function onDialDown(e: React.PointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dialDrag.current = { id: e.pointerId, angle0: dialAngle(e), rot0: viewRef.current.rot, turned: false };
  }

  function onDialMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dialDrag.current;
    if (!d || d.id !== e.pointerId) return;
    const delta = dialAngle(e) - d.angle0;
    if (!d.turned && Math.abs(delta) < 3) return;
    d.turned = true;
    setRotation(d.rot0 + delta);
  }

  function onDialUp(e: React.PointerEvent<HTMLDivElement>) {
    const d = dialDrag.current;
    if (!d || d.id !== e.pointerId) return;
    dialDrag.current = null;
    if (!d.turned && e.type === "pointerup") setRotation(0);
  }

  const setRotation = useCallback((deg: number) => {
    const r = ((deg % 360) + 360) % 360;
    viewRef.current.rot = r;
    setRot(r);
  }, []);

  /** North up, whole zoom: how every property opens. */
  const resetView = useCallback(() => {
    viewRef.current = { rot: 0, frac: 0 };
    setRot(0);
    setFrac(0);
    setZf(DEFAULT_ZOOM);
  }, []);

  /** Where a tap on the frame landed, computed from first principles — see
   *  latLngFromPixel — through the frame's turn and scale. */
  function pointFromFrame(clientX: number, clientY: number): Pt | null {
    const map = mapRef.current, frame = frameRef.current, div = mapDivRef.current;
    if (!map?.getCenter || !map?.getZoom || !frame || !div) return null;
    const r = frame.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const u = unrotate(clientX - (r.left + r.width / 2), clientY - (r.top + r.height / 2));
    const W = div.offsetWidth, H = div.offsetHeight;
    const c = map.getCenter();
    const z = map.getZoom();
    if (!c || typeof z !== "number") return null;
    return latLngFromPixel({ lat: c.lat(), lng: c.lng() }, z, W, H, W / 2 + u.x, H / 2 + u.y);
  }

  /** Drag the picture by a screen delta: the map's centre moves the other
   *  way, through the same projection a tap uses, so it tracks the finger
   *  exactly whatever the angle and scale. */
  function panByScreen(dx: number, dy: number) {
    const map = mapRef.current, div = mapDivRef.current;
    if (!map?.getCenter || !map?.getZoom || !div) return;
    const u = unrotate(dx, dy);
    const W = div.offsetWidth, H = div.offsetHeight;
    const c = map.getCenter();
    const z = map.getZoom();
    if (!c || typeof z !== "number") return;
    map.setCenter(latLngFromPixel({ lat: c.lat(), lng: c.lng() }, z, W, H, W / 2 - u.x, H / 2 - u.y));
  }

  function addPoint(p: Pt) {
    setRuns((prev) => prev.map((r) =>
      r.id === activeRunRef.current ? { ...r, points: [...r.points, p] } : r,
    ));
  }

  // One gesture layer for tap, drag, pinch and twist. A tap is a press that
  // moved less than 4px; anything else pans. Two fingers zoom by their
  // distance and turn by their angle.
  const gestureRef = useRef<{
    pts: Map<number, { x: number; y: number }>;
    down: { x: number; y: number } | null;
    moved: boolean;
    pinch: { dist: number; angle: number; zf: number; rot: number; mid: { x: number; y: number } } | null;
  }>({ pts: new Map(), down: null, moved: false, pinch: null });

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (status !== "ready") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const g = gestureRef.current;
    g.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.pts.size === 1) {
      g.down = { x: e.clientX, y: e.clientY };
      g.moved = false;
      g.pinch = null;
    } else if (g.pts.size === 2) {
      const [a, b] = [...g.pts.values()];
      g.pinch = {
        dist: Math.hypot(b.x - a.x, b.y - a.y),
        angle: Math.atan2(b.y - a.y, b.x - a.x),
        zf: zoomFine(),
        rot: viewRef.current.rot,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
      g.moved = true;
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const g = gestureRef.current;
    const prev = g.pts.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    g.pts.set(e.pointerId, cur);
    if (g.pts.size >= 2 && g.pinch) {
      const [a, b] = [...g.pts.values()];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      setZoomFine(g.pinch.zf + Math.log2(Math.max(0.05, dist / Math.max(1, g.pinch.dist))));
      setRotation(g.pinch.rot + ((angle - g.pinch.angle) * 180) / Math.PI);
      panByScreen(mid.x - g.pinch.mid.x, mid.y - g.pinch.mid.y);
      g.pinch.mid = mid;
      return;
    }
    if (g.pts.size === 1 && g.down) {
      if (!g.moved && Math.hypot(cur.x - g.down.x, cur.y - g.down.y) < 4) return;
      g.moved = true;
      panByScreen(cur.x - prev.x, cur.y - prev.y);
    }
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const g = gestureRef.current;
    if (!g.pts.has(e.pointerId)) return;
    g.pts.delete(e.pointerId);
    if (g.pts.size === 0) {
      if (!g.moved && e.type === "pointerup") {
        const p = pointFromFrame(e.clientX, e.clientY);
        if (p) addPoint(p);
      }
      g.pinch = null;
      g.moved = false;
      g.down = null;
    } else if (g.pts.size === 1) {
      // Lifting one finger of a pinch must not drop a point.
      g.pinch = null;
      g.moved = true;
    }
  }

  // Wheel zooms by fractions; with shift held it turns the view. Registered
  // by hand: React's onWheel is passive, so it can't stop the page scrolling
  // under the map.
  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.shiftKey) {
        setRotation(viewRef.current.rot + (e.deltaY || e.deltaX) * 0.2);
        return;
      }
      const z = mapRef.current?.getZoom?.();
      const cur = (typeof z === "number" ? z : DEFAULT_ZOOM) + viewRef.current.frac;
      setZoomFine(cur - e.deltaY * 0.0025);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setZoomFine, setRotation]);

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
          fullscreenControl: false,
          mapTypeControl: false,
          clickableIcons: false,
          // Google gets no gestures at all. The div is turned and scaled by
          // CSS (see the constants at the top), which Google's own drag and
          // scroll-zoom know nothing about — a drag to the right would slide
          // the picture off at an angle. The overlay above the map handles
          // tap, drag, wheel, pinch and twist, and moves the map itself.
          gestureHandling: "none",
          draggable: false,
          scrollwheel: false,
          disableDoubleClickZoom: true,
          keyboardShortcuts: false,
          zoomControl: false,
        });
        // Every pan and zoom re-places the on-screen footage labels.
        mapRef.current.addListener("center_changed", () => setTick((t) => t + 1));
        mapRef.current.addListener("zoom_changed", () => setTick((t) => t + 1));
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

    setPin(null);

    resetView();
    if (lat && lng) {
      mapRef.current.setCenter({ lat, lng });
      mapRef.current.setZoom(DEFAULT_ZOOM);
      setPin({ lat, lng });
    } else if (address && address.trim()) {
      // Most leads aren't geocoded — the background map loop only covers
      // leads in mappable stages — so without this the map would sit on
      // central Houston. Resolve the address so it lands on the house.
      try {
        locateProperty(g, address, zipCode || "", (p, note) => {
          if (cancelled) return;
          mapRef.current?.setCenter(p);
          mapRef.current?.setZoom(DEFAULT_ZOOM);
          setPin(p);
          if (note) setLocateNote(note);
        });
      } catch {
        /* leave the view where it is; the search box still works */
      }
    }
    return () => { cancelled = true; };
  }, [leadId, lat, lng, address, zipCode, status, resetView]);

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
        // Google makes overlays clickable by default, so they ate any tap
        // that landed on an existing line or dot — which made it impossible
        // to start a new run that crosses one already drawn. Overlapping
        // runs in different colours is exactly how Alan reads the drawing,
        // so clicks have to reach the map underneath.
        clickable: false,
      }));

      run.points.forEach((p) => {
        overlaysRef.current.push(new g.Marker({
          position: p,
          map: mapRef.current,
          clickable: false,
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

    });
  }, [runs, activeRun, status]);

  // The per-leg footage labels are React elements over the frame, not Google
  // markers: a marker label turns with the map and reads sideways or upside
  // down once the view is rotated. Placed from the map's centre and zoom
  // through the same transform the map div has.
  useEffect(() => {
    const map = mapRef.current, frame = frameRef.current;
    if (status !== "ready" || !map?.getCenter || !frame) { setLabels([]); return; }
    const c = map.getCenter();
    const z = map.getZoom();
    if (!c || typeof z !== "number") { setLabels([]); return; }
    const center = { lat: c.lat(), lng: c.lng() };
    const half = { x: frame.clientWidth / 2, y: frame.clientHeight / 2 };
    const out: { key: string; x: number; y: number; text: string }[] = [];
    runs.forEach((run) => {
      const path = run.closed && run.points.length > 2 ? [...run.points, run.points[0]] : run.points;
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i];
        const feet = haversineFeet(a, b);
        if (feet < 3) continue;
        const u = pixelFromLatLng(center, z, { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 });
        const d = rotateOut(u.x, u.y);
        out.push({ key: `${run.id}-${i}`, x: half.x + d.x, y: half.y + d.y, text: `${Math.round(feet)} ft` });
      }
    });
    setLabels(out);
  }, [runs, status, tick, rot, frac]);

  // Its own effect and its own ref: the run overlays are torn down on every
  // points change, and the pin must survive that.
  useEffect(() => {
    const g = mapsNS();
    if (status !== "ready" || !mapRef.current || !g) return;
    pinOverlayRef.current?.setMap(null);
    pinOverlayRef.current = null;
    if (!pin) return;
    pinOverlayRef.current = new g.Marker({
      position: pin,
      map: mapRef.current,
      title: address || "The property being measured",
      // Must not eat taps — the house is exactly where tracing starts.
      clickable: false,
      zIndex: 1,
      // A ring rather than Google's teardrop: the map can be turned, and a
      // teardrop pointing sideways reads as a mistake. The saved photo still
      // gets Google's red marker.
      icon: {
        path: g.SymbolPath.CIRCLE,
        scale: 11,
        fillColor: "#ef4444",
        fillOpacity: 0.25,
        strokeColor: "#ef4444",
        strokeWeight: 3,
      },
    });
    return () => {
      pinOverlayRef.current?.setMap(null);
      pinOverlayRef.current = null;
    };
  }, [pin, status, address]);

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
        // Searching is how a wrong geocode gets corrected, so the pin moves
        // with it — otherwise it would still mark the wrong house.
        setPin({ lat: loc.lat(), lng: loc.lng() });
        setZoomFine(DEFAULT_ZOOM);
      });
    } catch {
      toast.error("Address lookup failed");
    }
  }, [search, setZoomFine]);

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
    let saved = false;
    setCapturing(true);
    try {
      const c = mapRef.current.getCenter();
      const rect = frameRef.current?.getBoundingClientRect();
      const px = Math.max(100, Math.min(640, Math.round(rect?.width || 640)));
      const res = await api.captureSatelliteMeasurement(leadId, {
        lat: c.lat(),
        lng: c.lng(),
        // The fine zoom and the angle, exactly as framed. The server turns
        // and crops Google's north-up image to match (see _turn_and_crop).
        zoom: Math.round(zoomFine() * 100) / 100,
        rotation: Math.round(viewRef.current.rot * 10) / 10,
        size: `${px}x${px}`,
        also_scope: true,
        linear_feet: viewTotal > 0 ? Math.round(viewTotal) : null,
        replace_id: replaceId || null,
        // Send the traced runs so the saved photo carries the lines, in the
        // same colours as on screen. The map's polylines are browser
        // overlays and can never be in the image — Google has to redraw
        // them server-side at the same centre and zoom, which is also why
        // they land exactly where they were traced.
        // Colour is taken from the run's index in the FULL list, matching
        // the on-screen rendering, and only then filtered. Filtering first
        // would renumber the colours whenever an empty run sat in the
        // middle, so the photo would disagree with what was just traced.
        // Marks the house in the saved photo. Without it an aerial of a
        // street of near-identical roofs cannot be matched to a customer.
        pin: pin ? { lat: pin.lat, lng: pin.lng } : null,
        paths: runs
          .map((r, idx) => ({
            color: RUN_COLORS[idx % RUN_COLORS.length].replace("#", ""),
            closed: r.closed,
            points: r.points.map((p) => ({ lat: p.lat, lng: p.lng })),
          }))
          .filter((r) => r.points.length >= 2),
      });
      toast.success(
        res.total_linear_feet
          ? `${res.label} saved — job total ${res.total_linear_feet} ft. Opening the scope editor…`
          : `${res.label} saved. Opening the scope editor…`,
      );
      // Google has no imagery-date parameter, so the one thing we control is
      // detail: capturing below the framed zoom means a wider, coarser image
      // than was measured. Said out loud rather than silently accepted.
      if (res.zoom < res.requested_zoom - 0.01) {
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
      saved = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Capture failed";
      // Google's refusal arrives as "502: {"detail":"..."}". Pull out the
      // sentence that actually says what to do.
      // The backend tries the server key and then the browser key, and names
      // both in the detail. Collapsing that to one friendly sentence hid the
      // fact that BOTH had been refused, and claimed the browser key still
      // worked when it had just failed. Show Google's own words per key.
      const triedBoth = /browser key:/i.test(msg) && /server key:/i.test(msg);
      const billing = /enable Billing/i.test(msg);
      const notEnabled = /has not been used in project|is disabled|not enabled/i.test(msg);
      const refusal = msg.replace(/^.*refused the capture\s*[—:-]\s*/i, "");

      const headline = triedBoth
        ? "Both Google Maps keys were refused, so this needs fixing in the Google Cloud Console — "
          + "no change on our side can get around it. Google's reason for each key is below; "
          + "send it to whoever manages the Cloud project."
        : billing
          ? "Google needs Billing enabled on the Cloud project behind this Maps key."
          : notEnabled
            ? "Enable the Maps Static API on this Google Maps key, then try again."
            : msg;

      if (triedBoth || billing || notEnabled) {
        setKeyProblem(headline);
        // Split "server key: … ; browser key: …" into one line each.
        setDiagnosis(
          triedBoth
            ? refusal.split(/;\s*(?=(?:server|browser) key:)/i).map((t) => t.trim()).filter(Boolean)
            : [],
        );
      }
      toast.error(headline, { duration: 12000 });
    } finally {
      setCapturing(false);
    }
    // Straight into the scope editor with the photo just captured, so the
    // enhance / drone view / fence colours step starts without a tab
    // change (Alan, 2026-10-09). Capture already made it the scope's
    // source image, and Linear Feet is saved on the server, so nothing is
    // lost by leaving. The editor's back arrow returns to this customer.
    if (saved) navigate(`/leads/${leadId}/scope`);
  }

  // For the cases the map can't serve — a new build Google Earth hasn't
  // photographed, a surveyor's PDF. The upload is one more photo in the
  // same list; this replaced the separate "Measurement screenshot" card
  // (Alan, 2026-10-08: the two were the same thing twice).
  const uploadRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  async function uploadShot(file: File) {
    if (file.size > 15 * 1024 * 1024) {
      toast.error("That file is over 15 MB");
      return;
    }
    setUploading(true);
    try {
      const r = await api.uploadMeasurement(leadId, file);
      toast.success(`${r.label || "Photo"} saved`);
      await loadPhotos();
      onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
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
    <Panel
      icon={Ruler}
      title="Measure & capture"
      sub="Tap along the fence to measure it; drag to move, scroll or pinch to zoom, and turn the view with the buttons on the map. Add a separate run for each stretch and they add up. Capture saves the photo as you framed it and fills Linear Feet."
      accent={ACCENT.violet}
    >
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

        {/* Square, to match the square Static Maps capture. The map div is
            twice the frame and transformed; the overlay takes every gesture;
            the controls sit outside the transform so they never turn. */}
        <div
          ref={frameRef}
          className="relative w-full aspect-square max-w-full overflow-hidden rounded-xl border bg-muted select-none"
        >
          <div
            ref={mapDivRef}
            className="absolute"
            style={{
              // 210%: turned 45° at the smallest scale (0.71) the frame's
              // diagonal needs exactly 200% — the extra is margin.
              left: "-55%", top: "-55%", width: "210%", height: "210%",
              transform: `rotate(${rot}deg) scale(${Math.pow(2, frac)})`,
              willChange: "transform",
            }}
          />
          <div
            ref={overlayRef}
            className="absolute inset-0 cursor-crosshair touch-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {labels.map((l) => (
              <span
                key={l.key}
                className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap text-[12px] font-bold text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.9)]"
                style={{ left: l.x, top: l.y }}
              >
                {l.text}
              </span>
            ))}
          </div>

          {/* The angle: a compass you spin. Drag anywhere on the dial and
              the view turns with your finger; the arrow always points north;
              a tap puts north back at the top. Two fingers twist on a phone,
              shift + scroll turns it on a desktop. */}
          <div className="absolute right-2 top-2 flex flex-col items-center gap-1 text-white">
            <div
              ref={dialRef}
              onPointerDown={onDialDown}
              onPointerMove={onDialMove}
              onPointerUp={onDialUp}
              onPointerCancel={onDialUp}
              title="Drag to turn the view · tap to point north"
              className="relative h-16 w-16 cursor-grab touch-none select-none rounded-full bg-black/60 shadow-md shadow-black/30 ring-1 ring-white/25 backdrop-blur-sm active:cursor-grabbing"
            >
              {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
                <span
                  key={a}
                  className={a % 90 ? "absolute left-1/2 top-1 h-1 w-px bg-white/30" : "absolute left-1/2 top-1 h-1.5 w-px bg-white/60"}
                  style={{ transform: `translateX(-50%) rotate(${a}deg)`, transformOrigin: "50% 28px" }}
                />
              ))}
              <div className="absolute inset-0 flex items-center justify-center" style={{ transform: `rotate(${rot}deg)` }}>
                <div className="flex -translate-y-2.5 flex-col items-center">
                  <ArrowUp className="h-5 w-5 text-gold-light drop-shadow" />
                  <span className="text-[9px] font-bold leading-none">N</span>
                </div>
              </div>
              <span className="pointer-events-none absolute inset-x-0 bottom-1 text-center text-[9px] font-semibold tabular-nums text-white/80">
                {Math.round(rot)}°
              </span>
            </div>
            <button
              type="button"
              onClick={() => setRotation(viewRef.current.rot + 180)}
              title="Flip the view around"
              className="h-7 rounded-md bg-black/60 px-2 text-[10px] font-bold backdrop-blur-sm hover:bg-black/75"
            >
              180°
            </button>
          </div>

          {/* Fine zoom. Google's own control jumps a whole level at a time,
              which is either too close or too far for a scope photo. Scroll
              or pinch for the same thing. */}
          <div className="absolute inset-x-2 bottom-2 flex items-center gap-1.5 rounded-lg bg-black/60 px-2 py-1 text-white backdrop-blur-sm">
            <button type="button" onClick={() => setZoomFine(zf - ZOOM_STEP)} title="Zoom out a little"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-white/15">
              <ZoomOut className="h-4 w-4" />
            </button>
            <input
              type="range"
              min={ZOOM_MIN}
              max={ZOOM_MAX + 1}
              step={0.05}
              value={zf}
              onChange={(e) => setZoomFine(Number(e.target.value))}
              aria-label="Zoom"
              className="h-1.5 min-w-0 flex-1 accent-gold"
            />
            <button type="button" onClick={() => setZoomFine(zf + ZOOM_STEP)} title="Zoom in a little"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-white/15">
              <ZoomIn className="h-4 w-4" />
            </button>
            <span className="w-12 shrink-0 text-right text-[11px] font-semibold tabular-nums">{zf.toFixed(2)}×</span>
          </div>
        </div>

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
              <>
                <ul className="text-[11px] text-amber-900 space-y-1 font-mono break-words">
                  {diagnosis.map((d, i) => <li key={i}>{d}</li>)}
                </ul>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(diagnosis.join("\n"));
                      toast.success("Copied — paste it to whoever manages the Cloud project");
                    } catch {
                      toast.error("Couldn't copy. Select the text above instead.");
                    }
                  }}
                >
                  Copy for Fragne
                </Button>
              </>
            ) : null}
          </div>
        ) : null}

        {/* Every photo for this customer — captures and uploads alike, each
            tagged with the estimate it was taken for. Nothing is replaced,
            so an earlier view can always be re-opened rather than
            re-measured. */}
        <div className="space-y-2 border-t pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Photos{photos.length ? ` (${photos.length})` : ""}
            </span>
            {jobTotal ? (
              <span className="text-sm font-semibold tabular-nums">{jobTotal} ft total</span>
            ) : null}
            <Button
              variant="outline" size="sm" className="ml-auto h-7 text-xs"
              onClick={() => uploadRef.current?.click()}
              disabled={uploading}
              title="Google Earth screenshot or a surveyor's PDF, for when the map can't see the house"
            >
              {uploading ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Upload className="h-3.5 w-3.5 mr-1" />}
              Upload a screenshot
            </Button>
            <input
              ref={uploadRef}
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadShot(f);
                e.target.value = "";
              }}
            />
          </div>
          {photos.length > 0 ? (
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
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Nothing saved yet. Capture the view above, or upload a screenshot if the map can't see the house.
            </p>
          )}
          {jobTotal && onLinearFeet ? (
            <Button
              variant="outline" size="sm" className="w-full"
              onClick={() => onLinearFeet(jobTotal)}
            >
              Use {jobTotal} ft as Linear Feet
            </Button>
          ) : null}
        </div>
    </Panel>
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

  const isPdf = (photo.mime || "").includes("pdf");
  const captured = photo.source === "satellite_capture";
  return (
    <div className="rounded-xl border overflow-hidden group relative bg-card">
      {url && !isPdf ? (
        <a href={url} target="_blank" rel="noreferrer" title="Open full size">
          <img src={url} alt={photo.label} className="w-full aspect-square object-cover" />
        </a>
      ) : url && isPdf ? (
        <a href={url} target="_blank" rel="noreferrer" title="Open the PDF"
          className="flex w-full aspect-square flex-col items-center justify-center gap-1 bg-muted text-muted-foreground">
          <FileText className="h-7 w-7" />
          <span className="text-[10px] font-semibold uppercase tracking-wide">PDF</span>
        </a>
      ) : (
        <div className="w-full aspect-square bg-muted animate-pulse" />
      )}
      {/* Which estimate this photo is for. */}
      {photo.estimate_label ? (
        <span className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-ink/80 px-2 py-0.5 text-[10px] font-bold text-gold-light ring-1 ring-gold/40 backdrop-blur-sm">
          {photo.estimate_label}
        </span>
      ) : null}
      <div className="px-2 py-1 flex items-center gap-1 text-xs">
        <span className="font-medium">{photo.label}</span>
        {!captured ? <span className="text-[10px] text-muted-foreground">uploaded</span> : null}
        <span className="tabular-nums text-muted-foreground ml-auto">
          {photo.linear_feet ? `${Math.round(photo.linear_feet)} ft` : "—"}
        </span>
      </div>
      <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {captured ? (
        <Button
          size="sm" variant="secondary" className="h-6 w-6 p-0"
          onClick={onReshoot} disabled={disabled}
          title="Re-shoot this measurement from the current view"
        >
          <RefreshCw className="h-3 w-3" />
        </Button>
        ) : null}
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
