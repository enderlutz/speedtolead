import { useEffect, useRef, useState } from "react";

// The property in Google's photoreal 3D (Alan, 2026-10-30: "enable 3d
// rendering on this"). Look only: spin, tilt and zoom to see the fence
// behind the trees and how tall it stands. Measuring stays on the flat
// view, since feet traced on a tilted picture would be wrong. The lines
// already traced are draped on the ground in their run colours.
type Pt = { lat: number; lng: number };

export default function Map3DView({ center, heading, lines }: {
  center: Pt;
  heading: number;
  lines: { path: Pt[]; color: string }[];
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const mapRef = useRef<any>(null);
  const libRef = useRef<any>(null);
  const drawnRef = useRef<any[]>([]);
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

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

  useEffect(() => {
    const map = mapRef.current, lib = libRef.current;
    if (status !== "ready" || !map || !lib) return;
    drawnRef.current.forEach((d) => d.remove());
    drawnRef.current = lines.filter((l) => l.path.length > 1).map((l) => {
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
    });
  }, [status, lines]);

  return (
    <div className="absolute inset-0 bg-black">
      <div ref={boxRef} className="absolute inset-0" />
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
