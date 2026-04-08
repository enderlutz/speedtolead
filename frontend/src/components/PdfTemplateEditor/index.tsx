import { useState, useEffect, useRef, useCallback } from "react";
import { DndContext, PointerSensor, TouchSensor, useSensor, useSensors, useDroppable, DragOverlay } from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { api } from "@/lib/api";
import { screenToPdf } from "@/lib/pdf-coords";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Save, ZoomIn, ZoomOut, Maximize2, Undo2, Redo2, Eye, EyeOff } from "lucide-react";
import { useEditorState } from "./use-editor-state";
import { useSnapGuides } from "./use-snap-guides";
import { useKeyboardShortcuts } from "./use-keyboard-shortcuts";
import { useZoomPan } from "./use-zoom-pan";
import PdfTemplateCanvas from "./PdfTemplateCanvas";
import FieldToolbar from "./FieldToolbar";
import PropertiesPanel from "./PropertiesPanel";
import Rulers from "./Rulers";

interface Props {
  pageCount: number;
  pageSizes: { width: number; height: number }[];
  initialFieldMap: Record<string, { page: number; x: number; y: number; font_size: number; color?: string; width?: number }>;
  onSave: (fieldMap: Record<string, unknown>) => void;
}

export default function PdfTemplateEditor({ pageCount, pageSizes, initialFieldMap, onSave }: Props) {
  const editor = useEditorState(initialFieldMap);
  const { zoom, panOffset, handleWheel, zoomIn, zoomOut, fitToPage } = useZoomPan();
  const [saving, setSaving] = useState(false);
  const [pageImage, setPageImage] = useState<HTMLImageElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ width: 800, height: 600 });

  const getPageSize = useCallback(
    (page: number) => pageSizes[page] || { width: 612, height: 792 },
    [pageSizes],
  );

  const ps = getPageSize(editor.currentPage);
  const scaleX = stageSize.width / ps.width;
  const scaleY = stageSize.height / ps.height;

  const { snapLines, checkSnap, clearSnap } = useSnapGuides(editor.fields, editor.currentPage, scaleX, scaleY);

  // Load page image
  useEffect(() => {
    let cancelled = false;
    setPageImage(null);
    fetch(api.getTemplatePageUrl(editor.currentPage, Date.now().toString()))
      .then((r) => { if (r.ok) return r.blob(); throw new Error(); })
      .then((blob) => {
        if (cancelled) return;
        const img = new window.Image();
        img.onload = () => { if (!cancelled) setPageImage(img); };
        img.src = URL.createObjectURL(blob);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [editor.currentPage]);

  // Responsive stage sizing
  useEffect(() => {
    const resize = () => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const w = rect.width - 30; // account for ruler
      const h = rect.height - 22;
      if (w > 0 && h > 0) {
        const pageAspect = ps.width / ps.height;
        const containerAspect = w / h;
        if (containerAspect > pageAspect) {
          setStageSize({ width: h * pageAspect, height: h });
        } else {
          setStageSize({ width: w, height: w / pageAspect });
        }
      }
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [ps.width, ps.height]);

  // Drag handlers for canvas fields
  const handleFieldDragStart = useCallback((id: string) => {
    editor.setSelectedId(id);
  }, [editor]);

  const handleFieldDragMove = useCallback((id: string, screenX: number, screenY: number) => {
    const snapped = checkSnap(id, screenX, screenY);
    const pdf = screenToPdf(snapped.x, snapped.y, stageSize.width, stageSize.height, ps.width, ps.height);
    editor.updateFieldSilent(id, {
      x: Math.round(pdf.x * 10) / 10,
      y: Math.round(pdf.y * 10) / 10,
    });
  }, [checkSnap, editor, stageSize, ps]);

  const handleFieldDragEnd = useCallback((_id: string, _screenX: number, _screenY: number) => {
    clearSnap();
    editor.commitToHistory();
  }, [clearSnap, editor]);

  // Save
  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const fieldMap = editor.buildFieldMap();
      await api.updateFieldMap(fieldMap);
      onSave(fieldMap);
      toast.success("Field map saved");
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }, [editor, onSave]);

  useKeyboardShortcuts(editor, scaleX, handleSave);

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
  );

  // Drop zone for toolbar → canvas
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: "pdf-canvas-drop" });

  const handleDndDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || over.id !== "pdf-canvas-drop") return;

    const data = active.data.current as { fieldKey: string; label: string } | undefined;
    if (!data) return;

    // Place field at center of visible area
    const centerPdfX = ps.width / 2;
    const centerPdfY = ps.height / 3;
    editor.addFieldOnPage(data.fieldKey, data.label, centerPdfX, centerPdfY, editor.currentPage, 200);
  }, [editor, ps]);

  return (
    <DndContext sensors={sensors} onDragEnd={handleDndDragEnd}>
      <div className="space-y-2">
        {/* Toolbar */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" disabled={editor.currentPage === 0}
              onClick={() => editor.setCurrentPage(editor.currentPage - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-xs font-medium min-w-[70px] text-center">
              Page {editor.currentPage + 1} / {pageCount}
            </span>
            <Button variant="outline" size="sm" disabled={editor.currentPage >= pageCount - 1}
              onClick={() => editor.setCurrentPage(editor.currentPage + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>

            <div className="w-px h-5 bg-border mx-1" />

            <Button variant="outline" size="icon" className="h-8 w-8" onClick={editor.undo} title="Undo (Ctrl+Z)">
              <Undo2 className="h-3.5 w-3.5" />
            </Button>
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={editor.redo} title="Redo (Ctrl+Shift+Z)">
              <Redo2 className="h-3.5 w-3.5" />
            </Button>

            <div className="w-px h-5 bg-border mx-1" />

            <Button variant="outline" size="icon" className="h-8 w-8" onClick={zoomOut} title="Zoom out">
              <ZoomOut className="h-3.5 w-3.5" />
            </Button>
            <span className="text-xs font-mono w-10 text-center">{Math.round(zoom * 100)}%</span>
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={zoomIn} title="Zoom in">
              <ZoomIn className="h-3.5 w-3.5" />
            </Button>
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={fitToPage} title="Fit to page">
              <Maximize2 className="h-3.5 w-3.5" />
            </Button>
          </div>

          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" onClick={editor.togglePreviewMode}>
              {editor.previewMode ? <EyeOff className="h-3.5 w-3.5 mr-1" /> : <Eye className="h-3.5 w-3.5 mr-1" />}
              {editor.previewMode ? "Labels" : "Preview"}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              <Save className="h-4 w-4 mr-1" /> {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>

        {/* Main editor area */}
        <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr_220px] gap-0 border rounded-lg overflow-hidden" style={{ height: "70vh" }}>
          {/* Left: field toolbar */}
          <div className="hidden lg:block">
            <FieldToolbar
              fields={editor.fields}
              selectedId={editor.selectedId}
              usedPresets={editor.usedPresets}
              currentPage={editor.currentPage}
              onSelect={editor.setSelectedId}
              onNavigate={editor.setCurrentPage}
              onToggleLock={editor.toggleLock}
            />
          </div>

          {/* Center: canvas */}
          <div ref={containerRef} className={`relative bg-gray-200 overflow-hidden ${isOver ? "ring-2 ring-primary/40 ring-inset" : ""}`}>
            <Rulers
              zoom={zoom}
              pdfWidth={ps.width}
              pdfHeight={ps.height}
              scaleX={scaleX}
              scaleY={scaleY}
            />
            <div ref={setDropRef} className="absolute" style={{ top: 22, left: 30, right: 0, bottom: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <PdfTemplateCanvas
                pageFields={editor.pageFields}
                selectedId={editor.selectedId}
                stageWidth={stageSize.width}
                stageHeight={stageSize.height}
                scaleX={scaleX}
                scaleY={scaleY}
                zoom={zoom}
                panOffset={panOffset}
                pageImage={pageImage}
                snapLines={snapLines}
                previewMode={editor.previewMode}
                onFieldSelect={editor.setSelectedId}
                onFieldDragStart={handleFieldDragStart}
                onFieldDragMove={handleFieldDragMove}
                onFieldDragEnd={handleFieldDragEnd}
                onWheel={handleWheel}
              />
            </div>
          </div>

          {/* Right: properties */}
          <div className="hidden lg:block">
            <PropertiesPanel
              selected={editor.selected}
              pageCount={pageCount}
              previewMode={editor.previewMode}
              onUpdate={editor.updateField}
              onUpdateSilent={editor.updateFieldSilent}
              onCommit={editor.commitToHistory}
              onDelete={editor.deleteField}
              onDuplicate={editor.duplicateField}
              onToggleLock={editor.toggleLock}
              onTogglePreview={editor.togglePreviewMode}
            />
          </div>
        </div>
      </div>

      {/* Drag overlay for toolbar items */}
      <DragOverlay>
        {null}
      </DragOverlay>
    </DndContext>
  );
}
