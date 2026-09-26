import { useEffect } from "react";
import type { ScopeStateApi } from "./use-scope-state";

// Spec Section 20. B/R/V mode switches, Enter/Escape finish/cancel the
// current trace, F flips blue arrows on the selected segment.
export function useKeyboardShortcuts(scope: ScopeStateApi, onSave: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        scope.undo();
        return;
      }
      if (ctrl && ((e.key.toLowerCase() === "z" && e.shiftKey) || e.key.toLowerCase() === "y")) {
        e.preventDefault();
        scope.redo();
        return;
      }
      if (ctrl && e.key.toLowerCase() === "s") {
        e.preventDefault();
        onSave();
        return;
      }

      if (scope.drawingPoints.length > 0) {
        if (e.key === "Enter") {
          e.preventDefault();
          scope.finishDrawing();
        } else if (e.key === "Escape") {
          e.preventDefault();
          scope.cancelDrawing();
        }
        return;
      }

      switch (e.key.toLowerCase()) {
        case "b":
          scope.startDrawing("blue");
          break;
        case "r":
          scope.startDrawing("red");
          break;
        case "v":
          scope.setMode("select");
          break;
        case "f":
          if (scope.selectedId) scope.flipArrows(scope.selectedId);
          break;
        case "[":
          scope.rotateBy(-1);
          break;
        case "]":
          scope.rotateBy(1);
          break;
        case "delete":
        case "backspace":
          if (scope.selectedId) scope.deleteSegment(scope.selectedId);
          break;
        case "escape":
          scope.selectSegment(null);
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [scope, onSave]);
}
