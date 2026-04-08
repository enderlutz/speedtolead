import { useEffect } from "react";
import { NUDGE_PX, NUDGE_SHIFT_PX } from "./constants";
import type { useEditorState } from "./use-editor-state";

export function useKeyboardShortcuts(
  editor: ReturnType<typeof useEditorState>,
  scaleX: number,
  onSave: () => void,
) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't fire when typing in inputs
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const ctrl = e.ctrlKey || e.metaKey;

      // Undo/Redo
      if (ctrl && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        editor.undo();
        return;
      }
      if (ctrl && e.key === "z" && e.shiftKey) {
        e.preventDefault();
        editor.redo();
        return;
      }

      // Save
      if (ctrl && e.key === "s") {
        e.preventDefault();
        onSave();
        return;
      }

      // Duplicate
      if (ctrl && e.key === "d" && editor.selectedId) {
        e.preventDefault();
        editor.duplicateField(editor.selectedId);
        return;
      }

      // Lock
      if (ctrl && e.key === "l" && editor.selectedId) {
        e.preventDefault();
        editor.toggleLock(editor.selectedId);
        return;
      }

      // Delete
      if ((e.key === "Delete" || e.key === "Backspace") && editor.selectedId) {
        e.preventDefault();
        editor.deleteField(editor.selectedId);
        return;
      }

      // Escape — deselect
      if (e.key === "Escape") {
        editor.setSelectedId(null);
        return;
      }

      // Arrow nudge
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) && editor.selectedId) {
        e.preventDefault();
        const px = e.shiftKey ? NUDGE_SHIFT_PX : NUDGE_PX;
        const pdfPx = px / scaleX; // convert screen px to PDF points
        const field = editor.selected;
        if (!field || field.locked) return;

        const updates: { x?: number; y?: number } = {};
        if (e.key === "ArrowLeft") updates.x = field.x - pdfPx;
        if (e.key === "ArrowRight") updates.x = field.x + pdfPx;
        if (e.key === "ArrowUp") updates.y = field.y - pdfPx;
        if (e.key === "ArrowDown") updates.y = field.y + pdfPx;
        editor.updateField(field.id, updates);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [editor, scaleX, onSave]);
}
