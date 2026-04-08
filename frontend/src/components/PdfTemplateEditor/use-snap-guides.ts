import { useCallback, useState } from "react";
import type { EditorField } from "./use-editor-state";
import { SNAP_THRESHOLD_PX } from "./constants";

export interface SnapLine {
  orientation: "horizontal" | "vertical";
  position: number; // screen pixels
}

interface SnapResult {
  x: number;
  y: number;
  lines: SnapLine[];
}

export function useSnapGuides(
  fields: EditorField[],
  currentPage: number,
  scaleX: number,
  scaleY: number,
) {
  const [snapLines, setSnapLines] = useState<SnapLine[]>([]);

  const checkSnap = useCallback(
    (fieldId: string, screenX: number, screenY: number): SnapResult => {
      const dragged = fields.find((f) => f.id === fieldId);
      if (!dragged) return { x: screenX, y: screenY, lines: [] };

      const others = fields.filter((f) => f.id !== fieldId && f.page === currentPage);
      const lines: SnapLine[] = [];
      let snappedX = screenX;
      let snappedY = screenY;

      const dragW = (dragged.width || dragged.font_size * 5) * scaleX;
      const dragH = dragged.font_size * scaleY * 1.4;

      // Dragged field edges
      const dLeft = screenX;
      const dRight = screenX + dragW;
      const dCenterX = screenX + dragW / 2;
      const dTop = screenY;
      const dBottom = screenY + dragH;
      const dCenterY = screenY + dragH / 2;

      const dragEdgesX = [
        { val: dLeft, offset: 0 },
        { val: dCenterX, offset: dragW / 2 },
        { val: dRight, offset: dragW },
      ];
      const dragEdgesY = [
        { val: dTop, offset: 0 },
        { val: dCenterY, offset: dragH / 2 },
        { val: dBottom, offset: dragH },
      ];

      let bestDx = SNAP_THRESHOLD_PX + 1;
      let bestDy = SNAP_THRESHOLD_PX + 1;

      for (const other of others) {
        const oX = other.x * scaleX;
        const oY = other.y * scaleY;
        const oW = (other.width || other.font_size * 5) * scaleX;
        const oH = other.font_size * scaleY * 1.4;

        const otherEdgesX = [oX, oX + oW / 2, oX + oW];
        const otherEdgesY = [oY, oY + oH / 2, oY + oH];

        for (const de of dragEdgesX) {
          for (const oe of otherEdgesX) {
            const dist = Math.abs(de.val - oe);
            if (dist < SNAP_THRESHOLD_PX && dist < bestDx) {
              bestDx = dist;
              snappedX = oe - de.offset;
            }
          }
        }

        for (const de of dragEdgesY) {
          for (const oe of otherEdgesY) {
            const dist = Math.abs(de.val - oe);
            if (dist < SNAP_THRESHOLD_PX && dist < bestDy) {
              bestDy = dist;
              snappedY = oe - de.offset;
            }
          }
        }
      }

      // Build guide lines for snapped edges
      if (bestDx <= SNAP_THRESHOLD_PX) {
        // Find which edge snapped for the vertical guide
        for (const de of dragEdgesX) {
          const adjustedVal = snappedX + de.offset;
          for (const other of others) {
            const oX = other.x * scaleX;
            const oW = (other.width || other.font_size * 5) * scaleX;
            for (const oe of [oX, oX + oW / 2, oX + oW]) {
              if (Math.abs(adjustedVal - oe) < 1) {
                lines.push({ orientation: "vertical", position: oe });
              }
            }
          }
        }
      }
      if (bestDy <= SNAP_THRESHOLD_PX) {
        for (const de of dragEdgesY) {
          const adjustedVal = snappedY + de.offset;
          for (const other of others) {
            const oY = other.y * scaleY;
            const oH = other.font_size * scaleY * 1.4;
            for (const oe of [oY, oY + oH / 2, oY + oH]) {
              if (Math.abs(adjustedVal - oe) < 1) {
                lines.push({ orientation: "horizontal", position: oe });
              }
            }
          }
        }
      }

      setSnapLines(lines);
      return { x: snappedX, y: snappedY, lines };
    },
    [fields, currentPage, scaleX, scaleY],
  );

  const clearSnap = useCallback(() => setSnapLines([]), []);

  return { snapLines, checkSnap, clearSnap };
}
