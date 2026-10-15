// The magnifier on a phone (Alan, 2026-10-14: "trying to click on a dot").
// A round close-up of what's under the fixed crosshair, redrawn every frame
// from the canvas's own layers, so a fence corner can be hit exactly without
// pinching in first. Nothing is re-rendered: it copies pixels.
import { useEffect, useRef } from "react";
import type Konva from "konva";

const SIZE = 132;      // css px, the bubble
const MAGNIFY = 3;

export function Loupe({ stageRef, color }: { stageRef: React.RefObject<Konva.Stage | null>; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const out = ref.current;
      const stage = stageRef.current;
      if (!out || !stage) return;
      const dpr = window.devicePixelRatio || 1;
      if (out.width !== SIZE * dpr) { out.width = SIZE * dpr; out.height = SIZE * dpr; }
      const ctx = out.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#1b1915";
      ctx.fillRect(0, 0, out.width, out.height);
      // The crosshair sits in the middle of the stage; take a patch around
      // it from every layer and blow it up.
      const cx = stage.width() / 2;
      const cy = stage.height() / 2;
      const half = SIZE / MAGNIFY / 2;
      for (const layer of stage.getLayers()) {
        const src = layer.getCanvas()._canvas as HTMLCanvasElement;
        const r = src.width / stage.width();   // the layer's own pixel ratio
        try {
          ctx.drawImage(src, (cx - half) * r, (cy - half) * r, half * 2 * r, half * 2 * r, 0, 0, out.width, out.height);
        } catch { /* a layer not ready yet */ }
      }
      // The aim, the same as the crosshair.
      const m = out.width / 2;
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.moveTo(m - 18 * dpr, m); ctx.lineTo(m - 5 * dpr, m);
      ctx.moveTo(m + 5 * dpr, m); ctx.lineTo(m + 18 * dpr, m);
      ctx.moveTo(m, m - 18 * dpr); ctx.lineTo(m, m - 5 * dpr);
      ctx.moveTo(m, m + 5 * dpr); ctx.lineTo(m, m + 18 * dpr);
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(m, m, 4 * dpr, 0, Math.PI * 2);
      ctx.stroke();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [stageRef, color]);
  return (
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none rounded-full shadow-xl ring-4"
      style={{ width: SIZE, height: SIZE, boxShadow: "0 6px 20px rgba(0,0,0,0.55)", ["--tw-ring-color" as string]: color }}
    />
  );
}
