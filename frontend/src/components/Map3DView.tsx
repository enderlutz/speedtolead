import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, RotateCcw, RotateCw } from "lucide-react";

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

export default function Map3DView({ center, heading, lines, onPick }: {
  center: Pt;
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
        center: { lat: center.lat, lng: center.lng, altitude: 0 },
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
          <button type="button" onClick={() => turn(180)} title="See the other side"
            className="h-11 w-11 rounded-md bg-black/70 text-xs font-bold backdrop-blur-sm hover:bg-black/85">
            180°
          </button>
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
