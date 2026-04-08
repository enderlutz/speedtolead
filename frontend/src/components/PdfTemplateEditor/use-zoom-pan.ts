import { useState, useCallback } from "react";
import { MIN_ZOOM, MAX_ZOOM, ZOOM_STEP } from "./constants";

export function useZoomPan() {
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });

  const handleWheel = useCallback(
    (e: { evt: WheelEvent }) => {
      const we = e.evt;
      we.preventDefault();

      if (we.ctrlKey || we.metaKey) {
        // Zoom toward cursor
        const direction = we.deltaY < 0 ? 1 : -1;
        const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom + direction * ZOOM_STEP));
        setZoom(newZoom);
      } else {
        // Pan
        setPanOffset((prev) => ({
          x: prev.x - (we.shiftKey ? we.deltaY : we.deltaX),
          y: prev.y - (we.shiftKey ? 0 : we.deltaY),
        }));
      }
    },
    [zoom],
  );

  const zoomIn = useCallback(() => setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP)), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(MIN_ZOOM, z - ZOOM_STEP)), []);
  const fitToPage = useCallback(() => {
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
  }, []);

  return { zoom, panOffset, handleWheel, zoomIn, zoomOut, fitToPage, setZoom };
}
