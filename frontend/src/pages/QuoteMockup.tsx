/**
 * "Get my price": the self-serve fence staining quote, as a mock (Alan,
 * 2026-10-26). A customer types their address, we draw the fence from the
 * property lines, they confirm the sides, tap a height and the wood's
 * condition, and get a price range before giving a name. Then name + mobile
 * to get the exact number: a text in 5 minutes and a real person calls
 * between 8 AM and 8 PM to confirm the measurement.
 *
 * Mock, not live: nothing is saved or sent. What IS real: the lot comes from
 * the City of Houston property-line server for any address typed, the map
 * is Google satellite, and the range uses tonight's rates (Base zone only).
 * Research and the reasons behind each screen: docs/quote-generator/research.md.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Check, ChevronRight, MapPin, Phone, ShieldCheck, Star, Video } from "lucide-react";
import { api } from "@/lib/api";
import { loadGoogleMaps } from "@/lib/googleMaps";
import { cn } from "@/lib/utils";

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = () => (window as any).google;

const SANS = "Inter, system-ui, -apple-system, sans-serif";
const SERIF = "'Instrument Serif', Georgia, 'Times New Roman', serif";
const FONTS_URL = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&display=swap";
const GOLD = "#C9972F";
const PHONE = "346-589-7877";
const PARCELS = "https://geohwp.houstontx.gov/arcgis/rest/services/03_BaseData_External/Parcels_Current/FeatureServer";
// HCAD, FBCAD, MCAD: the three counties we serve, in the order most leads come.
const PARCEL_LAYERS = [4, 5, 3];

// Tonight's rates, mirrored from backend/services/estimator.py. The mock
// prices the Base zone only; the real page uses the ZIP zones.
const RATES: Record<string, { essential: number; signature: number; legacy: number }> = {
  brand_new: { essential: 0.72, signature: 0.84, legacy: 1.09 },
  "1_6yr": { essential: 0.74, signature: 0.86, legacy: 1.11 },
  "6_15yr": { essential: 0.76, signature: 0.88, legacy: 1.13 },
};
const SIZE_TIERS: [number, number][] = [[400, 0.45], [700, 0.28], [1000, 0.25], [1200, 0.12]];
const MIN_JOB = 600;

type Pt = { lat: number; lng: number };
type Mode = "inside" | "both" | "none";
type Side = { key: string; label: string; pts: Pt[]; feet: number; mode: Mode };
type Step = "start" | "measuring" | "map" | "length" | "video" | "height" | "wood" | "price" | "contact" | "done" | "outside";
type Wood = "new" | "grey" | "stained" | "unsure";

const HEIGHTS: { key: string; ft: number; name: string; hint: string; img: string }[] = [
  { key: "std", ft: 6.5, name: "Standard", hint: "A cap board on top, or a board along the bottom. Most fences.", img: "/quote-mockup/h-65ft.jpg" },
  { key: "6", ft: 6, name: "6 ft, plain", hint: "Pickets only, nothing on top or bottom.", img: "/quote-mockup/h-6ft.jpg" },
  { key: "7", ft: 7, name: "7 ft", hint: "Cap on top AND a board along the bottom.", img: "/quote-mockup/h-7ft.jpg" },
  { key: "8", ft: 8, name: "8 ft", hint: "Taller than a person with their arm up.", img: "" },
];
const WOODS: { key: Wood; name: string; hint: string }[] = [
  { key: "new", name: "Brand new", hint: "Put up in the last few months" },
  { key: "grey", name: "Grey and weathered", hint: "Never stained, or it's been years" },
  { key: "stained", name: "Already stained", hint: "The color is still there, maybe fading" },
  { key: "unsure", name: "Not sure", hint: "We'll look when we call" },
];
const BUCKETS: { key: string; feet: number; name: string; hint: string }[] = [
  { key: "small", feet: 150, name: "Small yard", hint: "About 150 ft of fence. Patio homes, zero-lot-line." },
  { key: "typical", feet: 200, name: "Typical lot", hint: "About 200 ft. Most Cypress and Katy subdivisions." },
  { key: "corner", feet: 300, name: "Corner or big lot", hint: "About 300 ft. Cul-de-sac, corner, or a half acre." },
];
const PROOF = ["/proposal-mockup/pkg-signature-a.jpg", "/proposal-mockup/pkg-legacy-wide-a.jpg", "/proposal-mockup/pkg-essential.jpg", "/proposal-mockup/pkg-signature-b.jpg", "/proposal-mockup/stain-dark-walnut.jpg", "/proposal-mockup/stain-cedar-naturaltone.jpg"];

// ── geometry ────────────────────────────────────────────────────────────────
const R = 20902231; // earth radius in feet
function feet(a: Pt, b: Pt): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
/** Local flat coordinates in feet around an origin, for angles and projections. */
function flat(o: Pt, p: Pt): [number, number] {
  const kx = 364000 * Math.cos((o.lat * Math.PI) / 180), ky = 364000;
  return [(p.lng - o.lng) * kx, (p.lat - o.lat) * ky];
}
function lerp(a: Pt, b: Pt, t: number): Pt { return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t }; }
function segDist(o: Pt, p: Pt, a: Pt, b: Pt): number {
  const [px, py] = flat(o, p), [ax, ay] = flat(o, a), [bx, by] = flat(o, b);
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
/** Drop tiny steps and near-straight corners so a lot reads as a few sides. */
function simplify(ring: Pt[]): Pt[] {
  let pts = ring.slice();
  if (pts.length > 1 && feet(pts[0], pts[pts.length - 1]) < 1) pts.pop();
  pts = pts.filter((p, i) => i === 0 || feet(pts[i - 1], p) > 4);
  for (let pass = 0; pass < 3; pass++) {
    const out: Pt[] = [];
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[(i + pts.length - 1) % pts.length], cur = pts[i], next = pts[(i + 1) % pts.length];
      const [ax, ay] = flat(cur, prev), [bx, by] = flat(cur, next);
      const ang = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by)) * 180 / Math.PI;
      if (Math.abs(180 - ang) > 12) out.push(cur);
    }
    if (out.length === pts.length || out.length < 3) break;
    pts = out;
  }
  return pts;
}

/**
 * The fence from the lot: the edge nearest the house is the front (Houston
 * lots: the house sits 20–25 ft off the street, the back yard is deeper).
 * The two sides start where the house's front face is, not at the street.
 * Everything else is fence. Expect ±5–10% before the customer touches it.
 */
function fenceFromParcel(ring: Pt[], house: Pt): Side[] {
  const pts = simplify(ring);
  const n = pts.length;
  if (n < 3) return [];
  const o = pts[0];
  const edges = pts.map((a, i) => ({ a, b: pts[(i + 1) % n], len: feet(a, pts[(i + 1) % n]) }));
  const front = edges.reduce((best, e, i) => (segDist(o, house, e.a, e.b) < segDist(o, house, edges[best].a, edges[best].b) ? i : best), 0);
  const dir = (e: { a: Pt; b: Pt }) => { const [x, y] = flat(e.a, e.b); const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
  const fd = dir(edges[front]);
  const parallel = (e: { a: Pt; b: Pt }) => { const d = dir(e); return Math.abs(d[0] * fd[0] + d[1] * fd[1]) > Math.cos((30 * Math.PI) / 180); };
  // The front can run over a few short edges on a curved street.
  const isFront = new Set<number>([front]);
  for (let k = 1; k < n; k++) { const i = (front + k) % n; if (edges[i].len < 40 && parallel(edges[i])) isFront.add(i); else break; }
  for (let k = 1; k < n; k++) { const i = (front - k + n) % n; if (edges[i].len < 40 && parallel(edges[i])) isFront.add(i); else break; }
  // Walk the rest of the ring starting after the front.
  let start = front; while (isFront.has(start)) start = (start + 1) % n;
  const rest: number[] = [];
  for (let k = 0; k < n; k++) { const i = (start + k) % n; if (!isFront.has(i)) rest.push(i); }
  // Side A until the first edge parallel to the front, the back while parallel, side B after.
  const groups: { label: "left" | "right" | "back"; idx: number[] }[] = [];
  let phase: 0 | 1 | 2 = 0;
  for (const i of rest) {
    const par = parallel(edges[i]);
    if (phase === 0 && par && edges[i].len > 20) phase = 1;
    else if (phase === 1 && !par) phase = 2;
    const label = phase === 1 ? "back" : phase === 0 ? "right" : "left";
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.idx.push(i); else groups.push({ label, idx: [i] });
  }
  // Left and right as seen from the street, facing the house.
  const fm = lerp(edges[front].a, edges[front].b, 0.5);
  const [cx, cy] = pts.reduce(([x, y], p) => { const [fx, fy] = flat(fm, p); return [x + fx / n, y + fy / n]; }, [0, 0]);
  const inward = Math.hypot(cx, cy) ? [cx / Math.hypot(cx, cy), cy / Math.hypot(cx, cy)] : [0, 1];
  const leftV = [-inward[1], inward[0]];
  const sideOf = (idx: number[]) => { const m = lerp(edges[idx[0]].a, edges[idx[idx.length - 1]].b, 0.5); const [x, y] = flat(fm, m); return x * leftV[0] + y * leftV[1] > 0 ? "left" : "right"; };
  // Trim the two sides back to the house's front face.
  const setback = Math.min(60, segDist(o, house, edges[front].a, edges[front].b) + 10);
  const out: Side[] = [];
  for (const grp of groups) {
    const label = grp.label === "back" ? "back" : sideOf(grp.idx);
    const line: Pt[] = [edges[grp.idx[0]].a, ...grp.idx.map((i) => edges[i].b)];
    if (label !== "back") {
      const touchesFrontAtStart = isFront.has((grp.idx[0] - 1 + n) % n);
      const touchesFrontAtEnd = isFront.has((grp.idx[grp.idx.length - 1] + 1) % n);
      if (touchesFrontAtStart && line.length > 1) { const l = feet(line[0], line[1]); line[0] = lerp(line[0], line[1], Math.min(0.6, setback / Math.max(l, 1))); }
      if (touchesFrontAtEnd && line.length > 1) { const a = line[line.length - 2], b = line[line.length - 1]; const l = feet(a, b); line[line.length - 1] = lerp(b, a, Math.min(0.6, setback / Math.max(l, 1))); }
    }
    const f = line.slice(1).reduce((s, p, i) => s + feet(line[i], p), 0);
    if (f < 8) continue;
    out.push({ key: `${label}-${out.length}`, label: label === "back" ? "Back" : label === "left" ? "Left side" : "Right side", pts: line, feet: Math.round(f), mode: "inside" });
  }
  // One row per label, longest first within a label.
  const order = { Back: 0, "Left side": 1, "Right side": 2 } as Record<string, number>;
  return out.sort((a, b) => order[a.label] - order[b.label] || b.feet - a.feet);
}

// ── pricing (mock) ──────────────────────────────────────────────────────────
function sizeRate(sqft: number): number { for (const [upTo, r] of SIZE_TIERS) if (sqft <= upTo) return r; return 0; }
function priceRange(sqft: number, bracket: string): { low: number; high: number; minApplied: boolean } {
  const r = RATES[bracket] || RATES["1_6yr"];
  const add = sqft * sizeRate(sqft);
  let ess = sqft * r.essential + add, leg = sqft * r.legacy + add;
  const minApplied = ess < MIN_JOB;
  if (minApplied) { leg += MIN_JOB - ess; ess = MIN_JOB; }
  const round = (x: number) => Math.round(x / 10) * 10;
  return { low: round(ess), high: round(leg), minApplied };
}
function bracketFor(yearBuilt: number | null, wood: Wood | null): string {
  if (wood === "new") return "brand_new";
  if (wood === "grey") return "6_15yr";
  if (!yearBuilt) return "1_6yr";
  const age = 2026 - yearBuilt;
  return age < 1 ? "brand_new" : age <= 6 ? "1_6yr" : "6_15yr";
}
const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

// ── the screen ──────────────────────────────────────────────────────────────
export default function QuoteMockup({ embedded = false }: { embedded?: boolean }) {
  const [step, setStep] = useState<Step>("start");
  const [address, setAddress] = useState("");
  const [note, setNote] = useState("");
  const [house, setHouse] = useState<Pt | null>(null);
  const [found, setFound] = useState("");
  const [zip, setZip] = useState("");
  const [ring, setRing] = useState<Pt[] | null>(null);
  const [yearBuilt, setYearBuilt] = useState<number | null>(null);
  const [sides, setSides] = useState<Side[]>([]);
  const [gates, setGates] = useState(true);
  const [bucket, setBucket] = useState<string>("");
  const [height, setHeight] = useState<string>("");
  const [wood, setWood] = useState<Wood | null>(null);
  const [military, setMilitary] = useState(false);
  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");
  const [mapsKey, setMapsKey] = useState("");
  const [measureDone, setMeasureDone] = useState(0); // steps ticked on the measuring screen
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!document.querySelector(`link[href="${FONTS_URL}"]`)) {
      const l = document.createElement("link"); l.rel = "stylesheet"; l.href = FONTS_URL; document.head.appendChild(l);
    }
    api.getMapsKey().then((d) => setMapsKey(d.maps_api_key || "")).catch(() => setMapsKey(""));
  }, []);

  const reset = () => {
    setStep("start"); setNote(""); setHouse(null); setFound(""); setZip(""); setRing(null); setYearBuilt(null);
    setSides([]); setGates(true); setBucket(""); setHeight(""); setWood(null); setMilitary(false); setMeasureDone(0);
  };

  /** Address → house point (Google) → lot (City of Houston) → fence sides. */
  const measure = async () => {
    const q = address.trim();
    if (q.length < 6) { inputRef.current?.focus(); setNote("Type your street address, like 12345 Oak Hollow Ln, Cypress."); return; }
    setNote(""); setStep("measuring"); setMeasureDone(0);
    const t0 = Date.now();
    const tick = (n: number) => setMeasureDone((d) => Math.max(d, n));
    try {
      if (!mapsKey) throw new Error("nokey");
      await loadGoogleMaps(mapsKey);
      const G = g().maps;
      const geo = await new Promise<any>((res, rej) => new G.Geocoder().geocode(
        { address: q + (/tx|texas/i.test(q) ? "" : ", TX"), componentRestrictions: { country: "US" } },
        (r: any[], s: string) => (s === "OK" && r?.[0] ? res(r[0]) : rej(new Error(s)))));
      const loc = geo.geometry.location; const h = { lat: loc.lat(), lng: loc.lng() };
      const z = (geo.address_components || []).find((c: any) => c.types?.includes("postal_code"))?.short_name || "";
      const st = (geo.address_components || []).find((c: any) => c.types?.includes("administrative_area_level_1"))?.short_name || "";
      setHouse(h); setFound(geo.formatted_address || q); setZip(z);
      tick(1);
      if (st && st !== "TX") { setStep("outside"); return; }
      let poly: Pt[] | null = null, yb: number | null = null;
      for (const layer of PARCEL_LAYERS) {
        const url = `${PARCELS}/${layer}/query?geometry=${h.lng},${h.lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=ADDRESS,ZIP_CODE,ACREAGE,YEAR_BUILT,Year_Built&outSR=4326&f=geojson`;
        try {
          const r = await fetch(url); const j = await r.json();
          const f = j?.features?.[0];
          if (f?.geometry?.type === "Polygon") {
            poly = (f.geometry.coordinates[0] as [number, number][]).map(([lng, lat]) => ({ lat, lng }));
            const y = Number(f.properties?.YEAR_BUILT || f.properties?.Year_Built || 0); yb = y > 1800 ? y : null;
            break;
          }
        } catch { /* next county */ }
      }
      tick(2);
      if (!poly) { setRing(null); await wait(t0, 1800); setNote("We found your house but not the property lines. Tell us about how long the fence is."); setStep("length"); return; }
      setRing(poly); setYearBuilt(yb);
      const s = fenceFromParcel(poly, h);
      setSides(s);
      tick(3);
      await wait(t0, 2400);
      if (s.length < 2) { setNote("That lot's a tricky shape. Tell us about how long the fence is and a real person will measure it."); setStep("length"); return; }
      setStep("map");
    } catch {
      await wait(t0, 1200);
      setNote(mapsKey ? "We couldn't find that address. Check the spelling, or tell us about how long the fence is." : "Maps key missing on this login. Tell us about how long the fence is.");
      setStep("length");
    }
  };

  const totalFeet = useMemo(() => {
    if (bucket) return BUCKETS.find((b) => b.key === bucket)?.feet || 0;
    const f = sides.reduce((s, x) => s + (x.mode === "inside" ? x.feet : x.mode === "both" ? x.feet * 2 : 0), 0);
    return f + (gates ? 48 : 0);
  }, [sides, gates, bucket]);
  const ft = HEIGHTS.find((h) => h.key === height)?.ft || 6.5;
  const sqft = Math.round(totalFeet * ft);
  const bracket = bracketFor(yearBuilt, wood);
  const range = priceRange(sqft, bracket);
  const low = range.low - (military ? 50 : 0), high = range.high - (military ? 50 : 0);

  const cycle = (key: string) => setSides((ss) => ss.map((s) => (s.key === key ? { ...s, mode: s.mode === "inside" ? "both" : s.mode === "both" ? "none" : "inside" } : s)));

  const body = (
    <div className="flex min-h-[720px] flex-col bg-white text-[#111110]" style={{ fontFamily: SANS }}>
      {step !== "start" && step !== "measuring" && step !== "done" ? (
        <div className="flex items-center justify-between px-4 pt-3">
          <button type="button" onClick={() => setStep(back(step, !!bucket))} className="inline-flex min-h-11 items-center gap-1 text-[15px] font-medium text-[#55534D]"><ArrowLeft className="h-4 w-4" />Back</button>
          <Progress step={step} />
        </div>
      ) : null}

      {step === "start" ? <Start address={address} setAddress={setAddress} onGo={measure} note={note} inputRef={inputRef} /> : null}
      {step === "measuring" ? <Measuring done={measureDone} /> : null}
      {step === "map" && house && ring ? (
        <MapStep mapsKey={mapsKey} house={house} ring={ring} sides={sides} found={found} gates={gates} setGates={setGates} cycle={cycle} totalFeet={totalFeet}
                 onOk={() => setStep("height")} onNotMine={reset} onCantSee={() => { setNote(""); setStep("length"); }} />
      ) : null}
      {step === "length" ? (
        <Screen title="About how long is your fence?" sub={note || "A rough guess is fine. A real person measures it before anything is scheduled."}>
          {BUCKETS.map((b) => <Choice key={b.key} on={bucket === b.key} name={b.name} hint={b.hint} onClick={() => { setBucket(b.key); setStep("height"); }} />)}
          <Choice name="Not sure" hint="No problem. We'll measure it for you." onClick={() => setStep("video")} />
        </Screen>
      ) : null}
      {step === "video" ? (
        <Screen title="We'll measure it for you." sub="Pick whichever is easier. Either way a real person gets you a price.">
          <Choice icon={<Video className="h-5 w-5" />} name="Send a 20-second video" hint="We text you a link. Walk the fence with your phone. Price by text within the hour, 8 AM to 8 PM." onClick={() => { setBucket("typical"); setStep("contact"); }} />
          <Choice icon={<Phone className="h-5 w-5" />} name="Just send my info" hint="We measure it from the satellite photo by tomorrow and text you the price." onClick={() => { setBucket("typical"); setStep("contact"); }} />
        </Screen>
      ) : null}
      {step === "height" ? (
        <Screen title="How tall is your fence?" sub="Tap the one that looks like yours. Not sure? Tap Standard.">
          <div className="grid grid-cols-2 gap-2">
            {HEIGHTS.map((h) => (
              <button key={h.key} type="button" onClick={() => { setHeight(h.key); setStep("wood"); }}
                      className={cn("overflow-hidden rounded-2xl text-left ring-1 transition", height === h.key ? "ring-2 ring-[#111110]" : "ring-[#E3E1DB] hover:ring-[#111110]/40")}>
                {h.img ? <img src={h.img} alt="" className="aspect-[4/3] w-full object-cover" /> : <div className="flex aspect-[4/3] w-full items-end justify-center bg-[#F6F5F2] pb-2"><span className="text-[44px] leading-none" style={{ fontFamily: SERIF }}>8′</span></div>}
                <div className="p-2.5">
                  <p className="text-[15px] font-semibold">{h.name}{h.key === "std" ? <span className="ml-1.5 rounded-full bg-[#111110] px-2 py-0.5 text-[11px] font-bold text-white">Most fences</span> : null}</p>
                  <p className="text-[13px] leading-snug text-[#55534D]">{h.hint}</p>
                </div>
              </button>
            ))}
          </div>
        </Screen>
      ) : null}
      {step === "wood" ? (
        <Screen title="What does the wood look like today?" sub="This decides how much prep we bring.">
          {WOODS.map((w) => <Choice key={w.key} on={wood === w.key} name={w.name} hint={w.hint} onClick={() => { setWood(w.key); setStep("price"); }} />)}
        </Screen>
      ) : null}
      {step === "price" ? (
        <PriceStep totalFeet={totalFeet} ft={ft} sqft={sqft} low={low} high={high} minApplied={range.minApplied} bucket={!!bucket} zip={zip}
                   military={military} setMilitary={setMilitary} onGo={() => setStep("contact")} />
      ) : null}
      {step === "contact" ? (
        <Screen title={bucket && !sides.length ? "Where should we text your price?" : "Where should we text your exact price?"} sub="A text in the next 5 minutes. A real person calls between 8 AM and 8 PM to confirm the measurement, then it's firm.">
          <label className="block text-[14px] font-semibold text-[#55534D]">Your name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="First name is fine" className={INPUT} />
          <label className="mt-3 block text-[14px] font-semibold text-[#55534D]">Mobile number</label>
          <input value={mobile} onChange={(e) => setMobile(e.target.value)} inputMode="tel" placeholder="(713) 555-0123" className={INPUT} />
          <button type="button" onClick={() => setStep("done")} className={BTN}>Text me my price <ChevronRight className="h-5 w-5" /></button>
          <p className="mt-3 text-[13px] leading-snug text-[#8A877F]">By tapping, you agree we can text and call you about your fence. No spam, and you can say stop any time.</p>
        </Screen>
      ) : null}
      {step === "done" ? (
        <Screen title={`Got it${name ? `, ${name.split(" ")[0]}` : ""}. Your price is on the way.`} sub="">
          <div className="space-y-3 text-[15px] leading-relaxed">
            <Row n="1" text="A text with your price range lands in the next 5 minutes." />
            <Row n="2" text="A real person calls you between 8 AM and 8 PM to confirm the measurement. That number is firm." />
            <Row n="3" text="You pick a day. Cleaning day first, a day to dry, then stain day. Pay when it's done." />
          </div>
          <p className="mt-6 rounded-[10px] bg-[#F6F5F2] px-3 py-3 text-[15px]">Want it faster? Call or text <a className="font-semibold underline" href={`tel:${PHONE}`}>{PHONE}</a>.</p>
          <button type="button" onClick={reset} className="mt-6 min-h-11 w-full text-[15px] font-medium text-[#55534D] underline">Start over (mock)</button>
        </Screen>
      ) : null}
      {step === "outside" ? (
        <Screen title="We're not in your area yet." sub={`${found || address} looks like it's outside Houston. We stain fences across Cypress, Katy, Spring, The Woodlands, Sugar Land and the rest of greater Houston.`}>
          <p className="text-[15px]">If that's wrong, go back and check the address. If you know someone in Houston with a grey fence, send them our way.</p>
          <button type="button" onClick={reset} className={BTN}>Try another address</button>
        </Screen>
      ) : null}
    </div>
  );

  return (
    <div className={cn("mx-auto", embedded ? "max-w-6xl" : "max-w-6xl p-4 md:p-6")}>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,420px)_1fr]">
        <div className="mx-auto w-full max-w-[420px] overflow-hidden rounded-[28px] shadow-xl ring-1 ring-[#111110]/10 lg:sticky lg:top-4 lg:self-start">
          {body}
        </div>
        <Notes />
      </div>
      {embedded ? null : <p className="mt-4 text-center text-xs text-muted-foreground"><Link to="/design-lab?tab=quote" className="underline">Back to Design Lab</Link></p>}
    </div>
  );
}

function wait(t0: number, ms: number) { return new Promise<void>((r) => setTimeout(r, Math.max(0, ms - (Date.now() - t0)))); }
function back(step: Step, bucket: boolean): Step {
  if (step === "map" || step === "length") return "start";
  if (step === "video") return "length";
  if (step === "height") return bucket ? "length" : "map";
  if (step === "wood") return "height";
  if (step === "price") return "wood";
  if (step === "contact") return "price";
  return "start";
}

const INPUT = "mt-1 h-12 w-full rounded-[10px] border border-[#D8D5CE] bg-white px-3.5 text-[16px] font-medium text-[#111110] outline-none placeholder:text-[#9B9890] focus:border-[#111110] focus:ring-1 focus:ring-[#111110]";
const BTN = "mt-5 inline-flex min-h-[52px] w-full items-center justify-center gap-1.5 rounded-[12px] bg-[#111110] px-4 text-[17px] font-semibold text-white active:scale-[.99]";

function Progress({ step }: { step: Step }) {
  const n = step === "map" || step === "length" || step === "video" ? 1 : step === "height" ? 2 : step === "wood" ? 3 : 4;
  return (
    <div className="flex items-center gap-1.5" aria-label={`Step ${n} of 4`}>
      {[1, 2, 3, 4].map((i) => <span key={i} className={cn("h-1.5 w-6 rounded-full", i <= n ? "bg-[#111110]" : "bg-[#E3E1DB]")} />)}
      <span className="ml-1 text-[12px] font-semibold text-[#8A877F]">{n}/4</span>
    </div>
  );
}

function Screen({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="flex-1 px-5 pb-6 pt-4">
      <h2 className="text-[28px] font-normal leading-[1.1] tracking-[-0.01em]" style={{ fontFamily: SERIF }}>{title}</h2>
      {sub ? <p className="mt-2 text-[15px] leading-relaxed text-[#55534D]">{sub}</p> : null}
      <div className="mt-5 space-y-2">{children}</div>
    </div>
  );
}

function Choice({ name, hint, on, onClick, icon }: { name: string; hint: string; on?: boolean; onClick: () => void; icon?: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
            className={cn("flex min-h-[60px] w-full items-center gap-3 rounded-2xl px-4 py-3 text-left ring-1 transition", on ? "ring-2 ring-[#111110]" : "ring-[#E3E1DB] hover:ring-[#111110]/40")}>
      {icon ? <span className="shrink-0 text-[#55534D]">{icon}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block text-[16px] font-semibold">{name}</span>
        <span className="block text-[13px] leading-snug text-[#55534D]">{hint}</span>
      </span>
      <ChevronRight className="h-5 w-5 shrink-0 text-[#9B9890]" />
    </button>
  );
}

function Row({ n, text }: { n: string; text: string }) {
  return <div className="flex gap-3"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#111110] text-[13px] font-bold text-white">{n}</span><p>{text}</p></div>;
}

function Start({ address, setAddress, onGo, note, inputRef }: { address: string; setAddress: (s: string) => void; onGo: () => void; note: string; inputRef: React.RefObject<HTMLInputElement | null> }) {
  return (
    <div className="flex-1">
      <div className="relative h-[220px] overflow-hidden">
        <img src="/proposal-mockup/pkg-legacy-wide-a.jpg" alt="" className="h-full w-full object-cover" />
        <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-white to-transparent" />
        <div className="absolute left-4 top-4 rounded-full bg-white/95 px-3 py-1.5 text-[13px] font-semibold shadow-sm">Sterling Fence Staining</div>
      </div>
      <div className="px-5 pb-6">
        <h1 className="text-[34px] font-normal leading-[1.08] tracking-[-0.01em]" style={{ fontFamily: SERIF }}>See your fence staining price in about a minute.</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-[#55534D]">Type your address. We measure your fence from the satellite photo and show you the price. No sales visit, no pressure, nobody has to be home.</p>
        <label className="mt-5 block text-[14px] font-semibold text-[#55534D]">Your street address</label>
        <div className="relative">
          <MapPin className="pointer-events-none absolute left-3 top-[18px] h-5 w-5 text-[#9B9890]" />
          <input ref={inputRef} value={address} onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") onGo(); }}
                 placeholder="12345 Oak Hollow Ln, Cypress" autoComplete="street-address" className={cn(INPUT, "pl-10")} />
        </div>
        {note ? <p className="mt-2 rounded-[10px] bg-rose-50 px-3 py-2 text-[14px] font-medium text-rose-800">{note}</p> : null}
        <button type="button" onClick={onGo} className={BTN}>Get my price <ChevronRight className="h-5 w-5" /></button>
        <p className="mt-3 text-center text-[13px] text-[#8A877F]">Takes about 60 seconds. No email needed.</p>
        <div className="mt-5 flex items-center justify-center gap-2 text-[14px]">
          <span className="flex items-center gap-0.5">{[0, 1, 2, 3, 4].map((i) => <Star key={i} className="h-4 w-4 fill-[#C9972F] text-[#C9972F]" />)}</span>
          <span className="font-semibold">4.9</span><span className="text-[#55534D]">· 41 Google reviews · Cypress, TX</span>
        </div>
      </div>
    </div>
  );
}

function Measuring({ done }: { done: number }) {
  const steps = ["Finding your property lines", "Looking at the satellite photo", "Measuring your fence"];
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <span className="h-10 w-10 animate-spin rounded-full border-[3px] border-[#111110]/10 border-t-[#C9972F]" />
      <h2 className="mt-6 text-[26px] leading-tight" style={{ fontFamily: SERIF }}>Measuring from satellite…</h2>
      <ul className="mt-5 w-full max-w-[280px] space-y-2.5">
        {steps.map((s, i) => (
          <li key={s} className="flex items-center gap-2.5 text-[15px]">
            <span className={cn("flex h-6 w-6 items-center justify-center rounded-full transition", i < done ? "bg-[#111110] text-white" : "bg-[#E3E1DB]")}>{i < done ? <Check className="h-3.5 w-3.5" /> : null}</span>
            <span className={i < done ? "" : "text-[#8A877F]"}>{s}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MapStep({ mapsKey, house, ring, sides, found, gates, setGates, cycle, totalFeet, onOk, onNotMine, onCantSee }: {
  mapsKey: string; house: Pt; ring: Pt[]; sides: Side[]; found: string; gates: boolean; setGates: (b: boolean) => void;
  cycle: (k: string) => void; totalFeet: number; onOk: () => void; onNotMine: () => void; onCantSee: () => void;
}) {
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const drawnRef = useRef<any[]>([]);
  useEffect(() => {
    let live = true;
    loadGoogleMaps(mapsKey).then(() => {
      if (!live || !divRef.current) return;
      const G = g().maps;
      if (!mapRef.current) {
        mapRef.current = new G.Map(divRef.current, { center: house, zoom: 19, mapTypeId: "satellite", disableDefaultUI: true, gestureHandling: "greedy", tilt: 0, clickableIcons: false });
        const b = new G.LatLngBounds(); ring.forEach((p) => b.extend(p)); mapRef.current.fitBounds(b, 24);
      }
      drawnRef.current.forEach((o) => o.setMap(null)); drawnRef.current = [];
      const add = (o: any) => { drawnRef.current.push(o); return o; };
      add(new G.Polygon({ map: mapRef.current, paths: ring, strokeColor: "#ffffff", strokeOpacity: 0.55, strokeWeight: 1.5, fillOpacity: 0 }));
      for (const s of sides) {
        const color = s.mode === "none" ? "#9B9890" : GOLD;
        add(new G.Polyline({ map: mapRef.current, path: s.pts, strokeColor: color, strokeOpacity: s.mode === "none" ? 0.7 : 1, strokeWeight: s.mode === "both" ? 7 : 4, zIndex: 2 }));
        if (s.mode === "both") add(new G.Polyline({ map: mapRef.current, path: s.pts, strokeColor: "#111110", strokeOpacity: 1, strokeWeight: 2, zIndex: 3 }));
        const mid = s.pts[Math.floor((s.pts.length - 1) / 2)], nxt = s.pts[Math.min(s.pts.length - 1, Math.floor((s.pts.length - 1) / 2) + 1)];
        add(new G.Marker({ map: mapRef.current, position: lerp(mid, nxt, 0.5), clickable: false, zIndex: 4,
          icon: { path: "M0,0", scale: 0 },
          label: { text: s.mode === "none" ? `${s.label}: skip` : `${s.label} · ${s.mode === "both" ? s.feet * 2 : s.feet} ft`, color: "#ffffff", fontSize: "13px", fontWeight: "700", className: "quote-map-label" } }));
      }
      add(new G.Marker({ map: mapRef.current, position: house, clickable: false, icon: { path: G.SymbolPath.CIRCLE, scale: 6, fillColor: "#ffffff", fillOpacity: 1, strokeColor: "#111110", strokeWeight: 2 } }));
    }).catch(() => {});
    return () => { live = false; };
  }, [mapsKey, house, ring, sides]);

  return (
    <div className="flex-1 px-5 pb-6 pt-3">
      <h2 className="text-[26px] leading-[1.1] tracking-[-0.01em]" style={{ fontFamily: SERIF }}>Is this your fence?</h2>
      <p className="mt-1 text-[14px] leading-snug text-[#55534D]">{found}</p>
      <div className="relative mt-3 overflow-hidden rounded-2xl ring-1 ring-[#111110]/10">
        <div ref={divRef} className="h-[300px] w-full bg-[#2b2b2b]" />
        <style>{`.quote-map-label{text-shadow:0 1px 3px rgba(0,0,0,.9),0 0 8px rgba(0,0,0,.6)}`}</style>
      </div>
      <p className="mt-2 text-[13px] text-[#55534D]">Gold lines are what we'd stain. Tap a side to change it.</p>
      <ul className="mt-3 space-y-2">
        {sides.map((s) => (
          <li key={s.key}>
            <button type="button" onClick={() => cycle(s.key)} className="flex min-h-12 w-full items-center justify-between rounded-xl px-3.5 py-2 text-left ring-1 ring-[#E3E1DB]">
              <span className="text-[15px] font-semibold">{s.label} <span className="font-normal text-[#55534D]">· {s.feet} ft</span></span>
              <span className={cn("rounded-full px-2.5 py-1 text-[12px] font-bold", s.mode === "inside" ? "bg-[#111110] text-white" : s.mode === "both" ? "bg-[#C9972F] text-[#111110]" : "bg-[#E3E1DB] text-[#55534D]")}>
                {s.mode === "inside" ? "My side" : s.mode === "both" ? "Both sides" : "Not mine / skip"}
              </span>
            </button>
          </li>
        ))}
        <li>
          <button type="button" onClick={() => setGates(!gates)} className="flex min-h-12 w-full items-center justify-between rounded-xl px-3.5 py-2 text-left ring-1 ring-[#E3E1DB]">
            <span className="text-[15px] font-semibold">Front gates <span className="font-normal text-[#55534D]">· both sides · 48 ft</span></span>
            <span className={cn("rounded-full px-2.5 py-1 text-[12px] font-bold", gates ? "bg-[#111110] text-white" : "bg-[#E3E1DB] text-[#55534D]")}>{gates ? "Yes" : "Skip"}</span>
          </button>
        </li>
      </ul>
      <p className="mt-3 text-[13px] text-[#8A877F]">"Both sides" of a shared fence needs your neighbor's OK. We'll ask when we call.</p>
      <div className="mt-3 flex items-baseline justify-between">
        <span className="text-[15px] text-[#55534D]">About</span>
        <span className="text-[30px] leading-none tabular-nums" style={{ fontFamily: SERIF }}>{totalFeet} ft</span>
      </div>
      <button type="button" onClick={onOk} className={BTN}>That's right <ChevronRight className="h-5 w-5" /></button>
      <div className="mt-3 flex justify-between text-[14px] font-medium text-[#55534D]">
        <button type="button" onClick={onNotMine} className="min-h-11 underline">Not my house</button>
        <button type="button" onClick={onCantSee} className="min-h-11 underline">Can't see my fence</button>
      </div>
    </div>
  );
}

function PriceStep({ totalFeet, ft, sqft, low, high, minApplied, bucket, zip, military, setMilitary, onGo }: {
  totalFeet: number; ft: number; sqft: number; low: number; high: number; minApplied: boolean; bucket: boolean; zip: string;
  military: boolean; setMilitary: (b: boolean) => void; onGo: () => void;
}) {
  return (
    <div className="flex-1 px-5 pb-6 pt-3">
      <p className="text-[14px] text-[#55534D]">{bucket ? "About" : "Your fence:"} {totalFeet} ft × {ft} ft tall = {sqft.toLocaleString()} sq ft</p>
      <h2 className="mt-1 text-[22px] leading-tight" style={{ fontFamily: SERIF }}>Your fence, cleaned and stained:</h2>
      <p className="mt-2 text-[46px] leading-none tracking-[-0.02em] tabular-nums" style={{ fontFamily: SERIF }}>{money(low)} – {money(high)}</p>
      <p className="mt-2 text-[15px] leading-relaxed text-[#55534D]">
        {minApplied
          ? "Smaller fences price at our $600 minimum. The crew's trip, the soft-wash cleaning and the setup cost the same on a short fence as a long one."
          : "Where you land depends on the finish you pick: clear seal, semi-transparent color, or solid color. A real person confirms the exact number before anything is scheduled."}
      </p>
      <p className="mt-2 text-[14px] text-[#55534D]">Or 4 payments from <b className="text-[#111110]">{money(low / 4)}</b> with Klarna.</p>
      <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-2.5 text-[15px]">
        <input type="checkbox" checked={military} onChange={(e) => setMilitary(e.target.checked)} className="h-5 w-5 accent-[#111110]" />
        Military or veteran household: $50 off
      </label>

      <button type="button" onClick={onGo} className={BTN}>Get my exact price <ChevronRight className="h-5 w-5" /></button>
      <p className="mt-2 text-center text-[13px] text-[#8A877F]">A text in 5 minutes. A real person calls 8 AM–8 PM to confirm. No sales visit.</p>

      <div className="mt-6 border-t border-[#E3E1DB] pt-5">
        <p className="text-[12px] font-bold uppercase tracking-wider text-[#8A877F]">What's included</p>
        <ul className="mt-2 space-y-1.5 text-[15px]">
          {["Soft-wash cleaning (no pressure washer tearing up the wood)", "A day to dry, then the stain, sprayed and back-brushed", "Color samples held up to your fence before we start", "1-year workmanship warranty and a touch-up can", "Photos of the whole job, start to finish"].map((t) => (
            <li key={t} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-[#C9972F]" />{t}</li>
          ))}
        </ul>
      </div>

      <div className="mt-6">
        <p className="text-[12px] font-bold uppercase tracking-wider text-[#8A877F]">Fences we've stained near {zip || "you"}</p>
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          {PROOF.map((src) => <img key={src} src={src} alt="" className="aspect-square w-full rounded-lg object-cover" />)}
        </div>
        <div className="mt-2 flex items-center gap-2 text-[14px]">
          <span className="flex items-center gap-0.5">{[0, 1, 2, 3, 4].map((i) => <Star key={i} className="h-4 w-4 fill-[#C9972F] text-[#C9972F]" />)}</span>
          <span className="font-semibold">4.9</span><span className="text-[#55534D]">· 41 Google reviews</span>
        </div>
      </div>

      <div className="mt-6">
        <p className="text-[12px] font-bold uppercase tracking-wider text-[#8A877F]">What happens next</p>
        <div className="mt-2 space-y-2.5 text-[15px]">
          <Row n="1" text="Tap the button. A text with this range lands in 5 minutes." />
          <Row n="2" text="A real person calls you between 8 AM and 8 PM, checks the measurement, and that number is firm." />
          <Row n="3" text="You pick a day. $250 holds it. Cleaning day, a day to dry, stain day. Pay the rest when it's done." />
        </div>
        <p className="mt-3 flex items-start gap-2 text-[14px] text-[#55534D]"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#C9972F]" />Nobody has to be home. We love it when you are, so you can pick the color at the fence.</p>
      </div>

      <div className="mt-6 rounded-[10px] bg-[#F6F5F2] px-3 py-3 text-[14px] leading-relaxed text-[#55534D]">
        <b className="text-[#111110]">What could change the price:</b> a fence taller than standard, boards or posts that need replacing (we'll show you each one before touching it), or staining both sides of a fence you share with a neighbor.
      </div>
      <p className="mt-5 text-center text-[14px] text-[#55534D]">Questions? Call or text <a className="font-semibold underline" href={`tel:${PHONE}`}>{PHONE}</a></p>
    </div>
  );
}

/** The decisions behind the mock, so the whole team reads the same thing. */
function Notes() {
  const decided = [
    "A price range first, not three packages. Exact packages come after a real person confirms.",
    "If it's between 8 AM and 8 PM, a real person calls to confirm. Then the number is firm.",
    "No bias up. The range is the straight calculation (Essential to Legacy, tonight's rates).",
    "Height is pictures to tap. Standard (6.5 ft) is the default and marked \"Most fences\".",
    "The fence is pre-drawn from the property lines (free City of Houston server, all three counties). The customer confirms, never draws from blank.",
    "Sides: tap to cycle My side / Both sides / Not mine. Front gates both sides on by default. Neighbor's OK is asked on the call.",
    "Can't see it: \"About how long?\" buckets, then a video link or \"just send my info\".",
    "The satellite photo is shown. Gold lines = what we stain.",
    "Proof under the price: photos (more than three), 4.9 · 41 reviews, 1-year warranty and the touch-up can.",
    "\"Nobody has to be home. We love it when you are\" (colors and pickets get settled at the fence).",
    "Klarna 4 payments and the $50 military line are on. The 20% off is off.",
    "Range first, then name + mobile to get the exact price. It creates a lead marked \"got their price\". Addresses are kept even if they stop halfway.",
    "No day picking from the quote. No \"price good for 7 days\" (not until it's true).",
    "Lives at estimate.sterlingfencetx.com/quote. Sterling only for now. Pressure washing is next.",
  ];
  const open = [
    "Below $600: the wording on the price screen. Does it read right?",
    "Is Essential-to-Legacy the right range, or Signature give-or-take 10%?",
    "The front gates allowance (48 ft, both sides) is a guess. Real page: drawn from the house footprint.",
    "The ZIP zones (+8¢ / +12¢ / +20¢) aren't in the mock. The real page uses them.",
    "Which before/after photos go under the price, and do we pull them by ZIP from Fence Photos?",
    "Follow-up after the text: day 2, day 3, skip, day 5 with an out. Automation or Gio?",
    "Ads: send straight to /quote or keep the lead form too?",
  ];
  return (
    <aside className="space-y-4 text-[14px]">
      <div className="rounded-2xl border bg-card p-4">
        <p className="font-semibold">This is a mock. Nothing is saved or sent.</p>
        <p className="mt-1 text-muted-foreground">What's real: type any Houston address and the lot comes from the city's property-line server, the map is Google satellite, and the range uses tonight's rates (Base zone). Research and sources: <code className="rounded bg-muted px-1 py-0.5 text-[12px]">docs/quote-generator/research.md</code>.</p>
      </div>
      <div className="rounded-2xl border bg-card p-4">
        <p className="font-semibold">Decided tonight (Alan, Oct 26)</p>
        <ul className="mt-2 list-disc space-y-1.5 pl-5">{decided.map((d) => <li key={d}>{d}</li>)}</ul>
      </div>
      <div className="rounded-2xl border bg-card p-4">
        <p className="font-semibold">Still open</p>
        <ul className="mt-2 list-disc space-y-1.5 pl-5">{open.map((d) => <li key={d}>{d}</li>)}</ul>
      </div>
      <div className="rounded-2xl border bg-card p-4">
        <p className="font-semibold">Why it's built this way (from the research)</p>
        <ul className="mt-2 list-disc space-y-1.5 pl-5">
          <li>70% want a digital estimate before talking to anyone; 51% say no pricing is a dealbreaker.</li>
          <li>95% of draw-it-yourself sessions get abandoned. Pre-draw, then confirm.</li>
          <li>Precise numbers and narrow ranges are believed. "Starting at" is poison.</li>
          <li>Showing the work for 2–3 seconds ("Measuring from satellite…") makes people value the result more.</li>
          <li>Promise "no sales visit", never "no human". 74% still want a real person to confirm.</li>
          <li>Contact within an hour is 7× more likely to close than the next hour. Text first.</li>
        </ul>
      </div>
    </aside>
  );
}
