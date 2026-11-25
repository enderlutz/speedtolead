import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ChevronUp, Home, Minus, Plus, RotateCcw, RotateCw } from "lucide-react";

// The property in Google's photoreal 3D (Alan, 2026-10-30: "enable 3d
// rendering on this… make it so that I can measure when I'm on angle").
// Spin, tilt and zoom; each tap drops a point where it lands on Google's 3D
// model, so the feet are the same as on the flat view however tilted the
// camera is (only the spot's lat/lng is used). The traced lines are draped
// on the ground in their run colours, a dot on every point.
// A one-finger or mouse drag circles the house (Alan, 2026-11-01: "change
// the side of the house I'm viewing it from… swipe"): left/right turns
// around it, up/down looks from higher or lower. Google's own drag only
// slid the map, and turning needed a right-drag or a two-finger twist.
// Two fingers still pinch to zoom, the wheel still zooms, a tap still adds
// a point. The buttons turn it 45° at a time for anyone who doesn't swipe.
type Pt = { lat: number; lng: number };

export default function Map3DView({ center, pin, heading, lines, onPick }: {
  center: Pt;
  pin?: Pt | null;
  heading: number;
  lines: { path: Pt[]; color: string }[];
  onPick?: (p: Pt) => void;
}) {
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const boxRef = useRef<HTMLDivElement>(null);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const mapRef = useRef<any>(null);
  const libRef = useRef<any>(null);
  const drawnRef = useRef<any[]>([]);
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  // When the last drag ended: Google may still read the press as a tap, and
  // a turn must never drop a point.
  const draggedAtRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const maps = (window as any).google?.maps;
    if (!maps?.importLibrary) { setStatus("error"); return; }
    maps.importLibrary("maps3d").then((lib: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      if (cancelled || !boxRef.current) return;
      libRef.current = lib;
      const map = new lib.Map3DElement({
        // Altitude is meters above the ground: aim at roof level.
        center: { lat: center.lat, lng: center.lng, altitude: 4 },
        range: 110,
        tilt: 55,
        heading,
        mode: lib.MapMode?.HYBRID ?? "HYBRID",
      });
      // A tap (not a drag) on the 3D picture: its spot on the model.
      map.addEventListener("gmp-click", (e: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        const pos = e?.position;
        const lat = typeof pos?.lat === "function" ? pos.lat() : pos?.lat;
        const lng = typeof pos?.lng === "function" ? pos.lng() : pos?.lng;
        if (Date.now() - draggedAtRef.current < 400) return;
        if (typeof lat === "number" && typeof lng === "number") pickRef.current?.({ lat, lng });
      });
      map.style.width = "100%";
      map.style.height = "100%";
      boxRef.current.appendChild(map);
      mapRef.current = map;
      setStatus("ready");
      // The customer's house: a pin standing over the roof with a line
      // down to the ground, so we always measure the right house (Alan,
      // 2026-11-25).
      if (pin) {
        try {
          const house = new lib.Marker3DElement({
            position: { lat: pin.lat, lng: pin.lng, altitude: 18 },
            altitudeMode: lib.AltitudeMode?.RELATIVE_TO_GROUND ?? "RELATIVE_TO_GROUND",
            extruded: true,
            drawsWhenOccluded: true,
            label: "Customer",
          });
          map.append(house);
        } catch { /* the 3D still works without the pin */ }
      }
    }).catch(() => { if (!cancelled) setStatus("error"); });
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // Built once per opening; the parent unmounts this on "Back to measuring".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drag to circle the house. Capture phase on the box, so the map under it
  // never sees the moves (and never slides); presses and releases still
  // reach it so its own state stays clean.
  useEffect(() => {
    const box = boxRef.current;
    if (status !== "ready" || !box) return;
    const pointers = new Set<number>();
    let drag: { id: number; x: number; y: number; heading: number; tilt: number; moved: boolean } | null = null;
    const down = (e: PointerEvent) => {
      pointers.add(e.pointerId);
      const map = mapRef.current;
      if (pointers.size > 1 || !map || (e.pointerType === "mouse" && e.button !== 0)) { drag = null; return; }
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, heading: Number(map.heading) || 0, tilt: Number(map.tilt) || 55, moved: false };
    };
    const move = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id || pointers.size > 1) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      e.stopPropagation();
      e.preventDefault();
      const map = mapRef.current;
      if (!map) return;
      map.heading = (((drag.heading - dx * 0.3) % 360) + 360) % 360;
      map.tilt = Math.max(0, Math.min(80, drag.tilt - dy * 0.25));
    };
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (drag && e.pointerId === drag.id) {
        if (drag.moved) draggedAtRef.current = Date.now();
        drag = null;
      }
    };
    // Google may follow the mouse or the finger through these instead.
    const block = (e: Event) => {
      if (drag?.moved) { e.stopPropagation(); if (e.cancelable) e.preventDefault(); }
    };
    const opts = { capture: true, passive: false } as AddEventListenerOptions;
    box.addEventListener("pointerdown", down, opts);
    box.addEventListener("pointermove", move, opts);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    box.addEventListener("mousemove", block, opts);
    box.addEventListener("touchmove", block, opts);
    return () => {
      box.removeEventListener("pointerdown", down, opts);
      box.removeEventListener("pointermove", move, opts);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      box.removeEventListener("mousemove", block, opts);
      box.removeEventListener("touchmove", block, opts);
    };
  }, [status]);

  // Fly the drone: slide the spot it looks at forward/back/left/right
  // (as seen on screen), zoom in/out, or jump back over the house
  // (Alan, 2026-11-25: "how we can actually move around the house").
  // Steps scale with the zoom, so a step is always about a fifth of the view.
  const fly = (fwd: number, right: number, zoom = 1, home = false) => {
    const map = mapRef.current;
    if (!map) return;
    const range = Math.max(25, Math.min(800, (Number(map.range) || 110) * zoom));
    const heading = Number(map.heading) || 0;
    const tilt = Number(map.tilt) || 55;
    const c = map.center;
    const lat0 = typeof c?.lat === "function" ? c.lat() : c?.lat ?? center.lat;
    const lng0 = typeof c?.lng === "function" ? c.lng() : c?.lng ?? center.lng;
    let next = { lat: lat0, lng: lng0, altitude: 4 };
    if (home) next = { lat: (pin || center).lat, lng: (pin || center).lng, altitude: 4 };
    else if (fwd || right) {
      const step = range * 0.22, h = (heading * Math.PI) / 180;
      const north = (fwd * Math.cos(h) - right * Math.sin(h)) * step;
      const east = (fwd * Math.sin(h) + right * Math.cos(h)) * step;
      next = { lat: lat0 + north / 111320, lng: lng0 + east / (111320 * Math.cos((lat0 * Math.PI) / 180)), altitude: 4 };
    }
    if (typeof map.flyCameraTo === "function") {
      map.flyCameraTo({ endCamera: { center: next, range, heading, tilt }, durationMillis: 350 });
    } else {
      map.center = next;
      map.range = range;
    }
  };
  const flyRef = useRef(fly);
  flyRef.current = fly;
  // Laptop: arrow keys move, + / - zoom, H goes back to the house.
  useEffect(() => {
    if (status !== "ready") return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const k: Record<string, () => void> = {
        ArrowUp: () => flyRef.current(1, 0), ArrowDown: () => flyRef.current(-1, 0),
        ArrowLeft: () => flyRef.current(0, -1), ArrowRight: () => flyRef.current(0, 1),
        "+": () => flyRef.current(0, 0, 0.7), "=": () => flyRef.current(0, 0, 0.7),
        "-": () => flyRef.current(0, 0, 1.4), h: () => flyRef.current(0, 0, 1, true),
      };
      const fn = k[e.key];
      if (fn) { e.preventDefault(); e.stopPropagation(); fn(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [status]);

  // The buttons: a smooth turn around the same spot.
  const turn = (dHeading: number, dTilt = 0) => {
    const map = mapRef.current;
    if (!map) return;
    const heading = ((((Number(map.heading) || 0) + dHeading) % 360) + 360) % 360;
    const tilt = Math.max(0, Math.min(80, (Number(map.tilt) || 55) + dTilt));
    const c = map.center;
    if (typeof map.flyCameraTo === "function" && c) {
      map.flyCameraTo({ endCamera: { center: c, range: map.range, heading, tilt }, durationMillis: 500 });
    } else {
      map.heading = heading;
      map.tilt = tilt;
    }
  };

  useEffect(() => {
    const map = mapRef.current, lib = libRef.current;
    if (status !== "ready" || !map || !lib) return;
    drawnRef.current.forEach((d) => d.remove());
    const dots = lines.flatMap((l) => l.path.map((p) => {
      const m = new lib.Marker3DElement({
        position: { lat: p.lat, lng: p.lng, altitude: 0 },
        altitudeMode: lib.AltitudeMode?.CLAMP_TO_GROUND ?? "CLAMP_TO_GROUND",
        drawsWhenOccluded: true,
        sizePreserved: true,
      });
      map.append(m);
      return m;
    }));
    drawnRef.current = [...dots, ...lines.filter((l) => l.path.length > 1).map((l) => {
      const line = new lib.Polyline3DElement({
        path: l.path.map((p) => ({ lat: p.lat, lng: p.lng, altitude: 0 })),
        strokeColor: l.color,
        strokeWidth: 6,
        outerColor: "#000000",
        outerWidth: 0.4,
        altitudeMode: lib.AltitudeMode?.CLAMP_TO_GROUND ?? "CLAMP_TO_GROUND",
        drawsOccludedSegments: true,
      });
      map.append(line);
      return line;
    })];
  }, [status, lines]);

  return (
    <div className="absolute inset-0 bg-black">
      <div ref={boxRef} className="absolute inset-0" style={{ touchAction: "none" }} />
      {status === "ready" ? (
        <div className="absolute right-2 top-2 flex flex-col gap-1.5 text-white">
          {([
            ["Turn left", () => turn(-45), <RotateCcw key="l" className="h-5 w-5" />],
            ["Turn right", () => turn(45), <RotateCw key="r" className="h-5 w-5" />],
            ["Look from higher", () => turn(0, -15), <ChevronUp key="u" className="h-5 w-5" />],
            ["Look from lower", () => turn(0, 15), <ChevronDown key="d" className="h-5 w-5" />],
          ] as const).map(([label, fn, icon]) => (
            <button key={label} type="button" onClick={fn} title={label} aria-label={label}
              className="flex h-11 w-11 items-center justify-center rounded-md bg-black/70 backdrop-blur-sm hover:bg-black/85">
              {icon}
            </button>
          ))}
          <div className="mt-1.5 flex flex-col gap-1.5">
            <button type="button" onClick={() => fly(0, 0, 0.7)} title="Zoom in (+)" aria-label="Zoom in"
              className="flex h-11 w-11 items-center justify-center rounded-md bg-black/70 backdrop-blur-sm hover:bg-black/85">
              <Plus className="h-5 w-5" />
            </button>
            <button type="button" onClick={() => fly(0, 0, 1.4)} title="Zoom out (-)" aria-label="Zoom out"
              className="flex h-11 w-11 items-center justify-center rounded-md bg-black/70 backdrop-blur-sm hover:bg-black/85">
              <Minus className="h-5 w-5" />
            </button>
          </div>
        </div>
      ) : null}
      {status === "ready" ? (
        // Move pad: slide the view like walking the drone; the middle
        // button flies back over the customer's house.
        <div className="absolute bottom-16 left-2 grid grid-cols-3 gap-1 text-white" aria-label="Move the view">
          {([
            [null],
            ["Move forward (↑)", () => fly(1, 0), <ArrowUp key="f" className="h-5 w-5" />],
            [null],
            ["Move left (←)", () => fly(0, -1), <ArrowLeft key="l" className="h-5 w-5" />],
            ["Back over the house (H)", () => fly(0, 0, 1, true), <Home key="h" className="h-5 w-5" />],
            ["Move right (→)", () => fly(0, 1), <ArrowRight key="r" className="h-5 w-5" />],
            [null],
            ["Move back (↓)", () => fly(-1, 0), <ArrowDown key="b" className="h-5 w-5" />],
            [null],
          ] as const).map((b, i) => b[0] === null ? <span key={i} /> : (
            <button key={i} type="button" onClick={b[1]} title={b[0]} aria-label={b[0]}
              className={`flex h-11 w-11 items-center justify-center rounded-md backdrop-blur-sm touch-manipulation ${i === 4 ? "bg-red-600/85 hover:bg-red-600" : "bg-black/70 hover:bg-black/85"}`}>
              {b[2]}
            </button>
          ))}
        </div>
      ) : null}
      {status === "loading" ? (
        <div className="absolute inset-0 flex items-center justify-center text-sm font-semibold text-white/80">Loading 3D…</div>
      ) : status === "error" ? (
        <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm font-semibold text-white/90">
          3D didn't load. Google may not have 3D for this area, or the Maps key needs the 3D tiles turned on.
        </div>
      ) : null}
    </div>
  );
}
