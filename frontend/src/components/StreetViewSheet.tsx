import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, X } from "lucide-react";

/** Street View over the whole screen, for houses the satellite doesn't show
 *  yet (Alan, 2026-11-24: "I can get a pretty accurate idea of where the
 *  fence is from the street view"). Look only, no tracing. Closing drops
 *  you back on the measure screen exactly as it was: nothing under it is
 *  touched. Uses the Maps JavaScript key the measure tool already loaded. */
/** `at` = where to stand (a spot picked on the blue Street View lines);
 *  `face` = the house to look at when it opens (the lead's pin). Without a
 *  face it looks at `at` from the nearest street spot, as before. */
export default function StreetViewSheet({ at, face, onClose }: {
  at: { lat: number; lng: number };
  face?: { lat: number; lng: number } | null;
  onClose: () => void;
}) {
  const divRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "none">("loading");

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener("keydown", onKey); };
  }, [onClose]);

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = (window as any).google?.maps;
    if (!g || !divRef.current) { setState("none"); return; }
    let live = true;
    const svc = new g.StreetViewService();
    const target = face || at;
    svc.getPanorama({ location: at, radius: face ? 50 : 120, preference: g.StreetViewPreference?.NEAREST, source: g.StreetViewSource?.OUTDOOR },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (data: any, status: string) => {
        if (!live || !divRef.current) return;
        if (status !== "OK" || !data?.location?.latLng) { setState("none"); return; }
        const from = data.location.latLng;
        // Face the house from where the car stood.
        const toRad = (d: number) => (d * Math.PI) / 180;
        const y = Math.sin(toRad(target.lng - from.lng())) * Math.cos(toRad(target.lat));
        const x = Math.cos(toRad(from.lat())) * Math.sin(toRad(target.lat)) - Math.sin(toRad(from.lat())) * Math.cos(toRad(target.lat)) * Math.cos(toRad(target.lng - from.lng()));
        const heading = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
        new g.StreetViewPanorama(divRef.current, {
          pano: data.location.pano,
          pov: { heading, pitch: 0 },
          zoom: 0,
          addressControl: false,
          fullscreenControl: false,
          motionTracking: false,
          motionTrackingControl: false,
          enableCloseButton: false,
          showRoadLabels: false,
        });
        setState("ready");
      });
    return () => { live = false; };
  }, [at, face]);

  return createPortal(
    <div className="fixed inset-0 z-[80] bg-black" role="dialog" aria-modal="true" aria-label="Street View">
      <div ref={divRef} className="absolute inset-0" />
      {state === "loading" ? (
        <div className="absolute inset-0 flex items-center justify-center text-white"><Loader2 className="h-8 w-8 animate-spin" /></div>
      ) : null}
      {state === "none" ? (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-base font-semibold text-white">
          {face ? "No Street View right there. Go back and pick a spot on a blue line." : "Google has no Street View near this house."}
        </div>
      ) : null}
      <button type="button" onClick={onClose}
              className="absolute left-3 top-[max(0.75rem,env(safe-area-inset-top))] z-10 inline-flex min-h-12 items-center gap-2 rounded-full bg-black/80 px-5 text-base font-bold text-white shadow-lg ring-1 ring-white/30 touch-manipulation hover:bg-black">
        <X className="h-5 w-5" />Back to measuring
      </button>
      {state === "ready" ? (
        <p className="pointer-events-none absolute inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-10 mx-auto w-fit rounded-lg bg-black/70 px-3 py-2 text-center text-sm font-semibold text-white">
          Drag to look around. Tap the arrows on the road to move. Look only, trace on the map.
        </p>
      ) : null}
    </div>,
    document.body,
  );
}
