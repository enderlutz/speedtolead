import { useState, useCallback, useRef } from "react";
import { PRESET_FIELD_LABELS, PRESET_FIELD_COLORS, PRESET_FIELDS } from "@/lib/pdf-types";
import { MAX_HISTORY } from "./constants";

export interface EditorField {
  id: string;
  label: string;
  page: number;
  x: number;
  y: number;
  font_size: number;
  color: string;
  width: number;
  locked: boolean;
}

interface FieldMapEntry {
  page: number;
  x: number;
  y: number;
  font_size: number;
  color?: string;
  width?: number;
}

function genId() {
  return `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function fieldsFromMap(fm: Record<string, FieldMapEntry>): EditorField[] {
  return Object.entries(fm).map(([key, v]) => ({
    id: key,
    label: PRESET_FIELD_LABELS[key] || key,
    page: v.page,
    x: v.x,
    y: v.y,
    font_size: v.font_size || 14,
    color: v.color || PRESET_FIELD_COLORS[key] || "#2B2B2B",
    width: v.width || 0,
    locked: false,
  }));
}

export function useEditorState(initialFieldMap: Record<string, FieldMapEntry>) {
  const [fields, setFields] = useState<EditorField[]>(() => fieldsFromMap(initialFieldMap));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [previewMode, setPreviewMode] = useState(true);

  // Undo/redo history
  const historyRef = useRef<EditorField[][]>([fieldsFromMap(initialFieldMap)]);
  const historyIndexRef = useRef(0);

  const pushHistory = useCallback((newFields: EditorField[]) => {
    const h = historyRef.current;
    const idx = historyIndexRef.current;
    // Truncate future entries
    historyRef.current = h.slice(0, idx + 1);
    historyRef.current.push(newFields.map((f) => ({ ...f })));
    if (historyRef.current.length > MAX_HISTORY) {
      historyRef.current.shift();
    } else {
      historyIndexRef.current++;
    }
  }, []);

  const updateField = useCallback((id: string, updates: Partial<EditorField>) => {
    setFields((prev) => {
      const next = prev.map((f) => (f.id === id ? { ...f, ...updates } : f));
      pushHistory(next);
      return next;
    });
  }, [pushHistory]);

  // Silent update — no history push (for mid-drag, live slider)
  const updateFieldSilent = useCallback((id: string, updates: Partial<EditorField>) => {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...updates } : f)));
  }, []);

  const commitToHistory = useCallback(() => {
    setFields((prev) => {
      pushHistory(prev);
      return prev;
    });
  }, [pushHistory]);

  const addField = useCallback((key: string, label: string, x: number, y: number, width = 0) => {
    const id = PRESET_FIELDS.includes(key as (typeof PRESET_FIELDS)[number]) ? key : genId();
    setFields((prev) => {
      const next = [...prev, {
        id, label, page: 0, x, y,
        font_size: 14,
        color: PRESET_FIELD_COLORS[key] || "#2B2B2B",
        width,
        locked: false,
      } satisfies EditorField];
      // Set page to current
      next[next.length - 1].page = 0; // Will be overridden by caller
      pushHistory(next);
      return next;
    });
    setSelectedId(id);
    return id;
  }, [pushHistory]);

  const addFieldOnPage = useCallback((key: string, label: string, x: number, y: number, page: number, width = 0) => {
    const id = PRESET_FIELDS.includes(key as (typeof PRESET_FIELDS)[number]) ? key : genId();
    const newField: EditorField = {
      id, label, page, x, y,
      font_size: 14,
      color: PRESET_FIELD_COLORS[key] || "#2B2B2B",
      width,
      locked: false,
    };
    setFields((prev) => {
      const next = [...prev, newField];
      pushHistory(next);
      return next;
    });
    setSelectedId(id);
    return id;
  }, [pushHistory]);

  const deleteField = useCallback((id: string) => {
    setFields((prev) => {
      const field = prev.find((f) => f.id === id);
      if (field?.locked) return prev;
      const next = prev.filter((f) => f.id !== id);
      pushHistory(next);
      return next;
    });
    setSelectedId((prev) => (prev === id ? null : prev));
  }, [pushHistory]);

  const duplicateField = useCallback((id: string) => {
    setFields((prev) => {
      const original = prev.find((f) => f.id === id);
      if (!original) return prev;
      const newId = genId();
      const clone: EditorField = {
        ...original,
        id: newId,
        label: original.label + " (copy)",
        x: original.x + 15,
        y: original.y + 15,
        locked: false,
      };
      const next = [...prev, clone];
      pushHistory(next);
      setSelectedId(newId);
      return next;
    });
  }, [pushHistory]);

  const toggleLock = useCallback((id: string) => {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, locked: !f.locked } : f)));
  }, []);

  const undo = useCallback(() => {
    if (historyIndexRef.current > 0) {
      historyIndexRef.current--;
      setFields(historyRef.current[historyIndexRef.current].map((f) => ({ ...f })));
    }
  }, []);

  const redo = useCallback(() => {
    if (historyIndexRef.current < historyRef.current.length - 1) {
      historyIndexRef.current++;
      setFields(historyRef.current[historyIndexRef.current].map((f) => ({ ...f })));
    }
  }, []);

  const togglePreviewMode = useCallback(() => setPreviewMode((p) => !p), []);

  const selected = fields.find((f) => f.id === selectedId) || null;
  const pageFields = fields.filter((f) => f.page === currentPage);
  const usedPresets = new Set(fields.filter((f) => PRESET_FIELDS.includes(f.id as (typeof PRESET_FIELDS)[number])).map((f) => f.id));

  const buildFieldMap = useCallback((): Record<string, unknown> => {
    const map: Record<string, unknown> = {};
    for (const f of fields) {
      map[f.id] = {
        page: f.page,
        x: Math.round(f.x * 100) / 100,
        y: Math.round(f.y * 100) / 100,
        font_size: f.font_size,
        color: f.color,
        width: f.width || 0,
      };
    }
    return map;
  }, [fields]);

  return {
    fields, pageFields, selected, selectedId, currentPage, previewMode, usedPresets,
    setSelectedId, setCurrentPage,
    updateField, updateFieldSilent, commitToHistory,
    addField, addFieldOnPage, deleteField, duplicateField, toggleLock,
    undo, redo, togglePreviewMode, buildFieldMap,
  };
}
