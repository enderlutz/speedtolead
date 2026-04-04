import { useState, useRef, useCallback } from "react";
import { api } from "@/lib/api";
import { pdfToScreen, screenToPdf } from "@/lib/pdf-coords";
import { PRESET_FIELDS, PRESET_FIELD_LABELS, PRESET_FIELD_COLORS, type PdfField } from "@/lib/pdf-types";
import ColorPicker from "@/components/ColorPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Plus, Trash2, Save, GripVertical } from "lucide-react";

interface Props {
  pageCount: number;
  initialFieldMap: Record<string, { page: number; x: number; y: number; font_size: number; color?: string }>;
  onSave: (fieldMap: Record<string, unknown>) => void;
}

function genId() {
  return `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export default function PdfTemplateEditor({ pageCount, initialFieldMap, onSave }: Props) {
  const [currentPage, setCurrentPage] = useState(0);
  const [fields, setFields] = useState<PdfField[]>(() => {
    return Object.entries(initialFieldMap).map(([key, v]) => ({
      id: key,
      label: PRESET_FIELD_LABELS[key] || key,
      page: v.page,
      x: v.x,
      y: v.y,
      font_size: v.font_size || 12,
      color: v.color || PRESET_FIELD_COLORS[key] || "#2B2B2B",
    }));
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ fieldId: string; startX: number; startY: number; origX: number; origY: number } | null>(null);

  const selected = fields.find((f) => f.id === selectedId) || null;
  const pageFields = fields.filter((f) => f.page === currentPage);
  const usedPresets = new Set(fields.filter((f) => PRESET_FIELDS.includes(f.id as never)).map((f) => f.id));

  const [, setImgLoaded] = useState(false);
  const getImgDims = useCallback(() => {
    if (!imgRef.current) return { w: 612, h: 792 };
    const w = imgRef.current.clientWidth;
    const h = imgRef.current.clientHeight;
    return { w: w > 0 ? w : 612, h: h > 0 ? h : 792 };
  }, []);

  const handleAddField = (key: string, label: string) => {
    const id = PRESET_FIELDS.includes(key as never) ? key : genId();
    const newField: PdfField = {
      id,
      label,
      page: currentPage,
      x: 200,
      y: 400,
      font_size: 14,
      color: PRESET_FIELD_COLORS[key] || "#2B2B2B",
    };
    setFields((prev) => [...prev, newField]);
    setSelectedId(id);
    setAddMenuOpen(false);
  };

  const updateField = (id: string, updates: Partial<PdfField>) => {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...updates } : f)));
  };

  const deleteField = (id: string) => {
    setFields((prev) => prev.filter((f) => f.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const handleMouseDown = (e: React.MouseEvent, fieldId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedId(fieldId);
    const { w, h } = getImgDims();
    const field = fields.find((f) => f.id === fieldId);
    if (!field) return;
    const screen = pdfToScreen(field.x, field.y, w, h);
    dragRef.current = { fieldId, startX: e.clientX, startY: e.clientY, origX: screen.x, origY: screen.y };

    const handleMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      const newScreenX = dragRef.current.origX + dx;
      const newScreenY = dragRef.current.origY + dy;
      const { w: cw, h: ch } = getImgDims();
      const pdf = screenToPdf(newScreenX, newScreenY, cw, ch);
      updateField(dragRef.current.fieldId, { x: Math.round(pdf.x * 10) / 10, y: Math.round(pdf.y * 10) / 10 });
    };

    const handleUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  };

  // Touch support
  const handleTouchStart = (e: React.TouchEvent, fieldId: string) => {
    e.stopPropagation();
    setSelectedId(fieldId);
    const touch = e.touches[0];
    const { w, h } = getImgDims();
    const field = fields.find((f) => f.id === fieldId);
    if (!field) return;
    const screen = pdfToScreen(field.x, field.y, w, h);
    dragRef.current = { fieldId, startX: touch.clientX, startY: touch.clientY, origX: screen.x, origY: screen.y };

    const handleMove = (ev: TouchEvent) => {
      ev.preventDefault();
      if (!dragRef.current) return;
      const t = ev.touches[0];
      const dx = t.clientX - dragRef.current.startX;
      const dy = t.clientY - dragRef.current.startY;
      const newScreenX = dragRef.current.origX + dx;
      const newScreenY = dragRef.current.origY + dy;
      const { w: cw, h: ch } = getImgDims();
      const pdf = screenToPdf(newScreenX, newScreenY, cw, ch);
      updateField(dragRef.current.fieldId, { x: Math.round(pdf.x * 10) / 10, y: Math.round(pdf.y * 10) / 10 });
    };

    const handleEnd = () => {
      dragRef.current = null;
      window.removeEventListener("touchmove", handleMove);
      window.removeEventListener("touchend", handleEnd);
    };

    window.addEventListener("touchmove", handleMove, { passive: false });
    window.addEventListener("touchend", handleEnd);
  };

  const handleSave = async () => {
    setSaving(true);
    const fieldMap: Record<string, unknown> = {};
    for (const f of fields) {
      fieldMap[f.id] = { page: f.page, x: f.x, y: f.y, font_size: f.font_size, color: f.color };
    }
    try {
      await api.updateFieldMap(fieldMap);
      onSave(fieldMap);
      toast.success("Field map saved");
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handlePageClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-field]")) return;
    setSelectedId(null);
  };

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" disabled={currentPage === 0} onClick={() => setCurrentPage((p) => p - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs font-medium min-w-[60px] text-center">
            Page {currentPage + 1} / {pageCount}
          </span>
          <Button variant="outline" size="sm" disabled={currentPage >= pageCount - 1} onClick={() => setCurrentPage((p) => p + 1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="relative">
            <Button variant="outline" size="sm" onClick={() => setAddMenuOpen(!addMenuOpen)}>
              <Plus className="h-4 w-4 mr-1" /> Add Field
            </Button>
            {addMenuOpen && (
              <div className="absolute z-50 top-full mt-1 right-0 bg-popover border rounded-lg shadow-lg py-1 w-48">
                {PRESET_FIELDS.filter((k) => !usedPresets.has(k)).map((key) => (
                  <button
                    key={key}
                    onClick={() => handleAddField(key, PRESET_FIELD_LABELS[key])}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors flex items-center gap-2"
                  >
                    <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: PRESET_FIELD_COLORS[key] }} />
                    {PRESET_FIELD_LABELS[key]}
                  </button>
                ))}
                <div className="border-t my-1" />
                <button
                  onClick={() => {
                    const label = prompt("Custom field label:");
                    if (label) handleAddField(label.toLowerCase().replace(/\s+/g, "_"), label);
                  }}
                  className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors text-muted-foreground"
                >
                  + Custom Field...
                </button>
              </div>
            )}
          </div>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            <Save className="h-4 w-4 mr-1" /> {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_240px] gap-4">
        {/* PDF page with overlay */}
        <div
          ref={containerRef}
          className="relative border rounded-lg overflow-hidden bg-gray-100"
          onClick={handlePageClick}
        >
          <img
            ref={imgRef}
            src={`${api.getTemplatePageUrl(currentPage)}`}
            alt={`Page ${currentPage + 1}`}
            className="w-full block"
            draggable={false}
            onLoad={() => setImgLoaded(true)}
          />
          {/* Field markers overlay */}
          {pageFields.map((field) => {
            const { w, h } = getImgDims();
            const screen = pdfToScreen(field.x, field.y, w, h);
            const isSelected = field.id === selectedId;
            return (
              <div
                key={field.id}
                data-field
                onMouseDown={(e) => handleMouseDown(e, field.id)}
                onTouchStart={(e) => handleTouchStart(e, field.id)}
                className={`absolute cursor-grab select-none touch-none flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-white whitespace-nowrap ${
                  isSelected ? "ring-2 ring-white shadow-lg z-20" : "z-10 opacity-90 hover:opacity-100"
                }`}
                style={{
                  left: screen.x,
                  top: screen.y,
                  backgroundColor: field.color,
                  transform: "translate(-50%, -100%)",
                  fontSize: Math.max(9, Math.min(field.font_size * 0.7, 14)),
                }}
              >
                <GripVertical className="h-3 w-3 opacity-60" />
                {field.label}
              </div>
            );
          })}
        </div>

        {/* Properties panel */}
        <div className="space-y-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Properties</p>
          {selected ? (
            <div className="space-y-3 border rounded-lg p-3">
              <div>
                <label className="text-[10px] font-medium text-muted-foreground mb-1 block">Label</label>
                <p className="text-sm font-medium">{selected.label}</p>
              </div>
              <div>
                <label className="text-[10px] font-medium text-muted-foreground mb-1 block">Font Size</label>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={8}
                    max={48}
                    value={selected.font_size}
                    onChange={(e) => updateField(selected.id, { font_size: Number(e.target.value) })}
                    className="flex-1"
                  />
                  <span className="text-xs font-mono w-8 text-right">{selected.font_size}</span>
                </div>
              </div>
              <div>
                <label className="text-[10px] font-medium text-muted-foreground mb-1 block">Color</label>
                <ColorPicker value={selected.color} onChange={(c) => updateField(selected.id, { color: c })} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] font-medium text-muted-foreground mb-1 block">X</label>
                  <Input
                    type="number"
                    value={Math.round(selected.x)}
                    onChange={(e) => updateField(selected.id, { x: Number(e.target.value) })}
                    className="h-7 text-xs"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-medium text-muted-foreground mb-1 block">Y</label>
                  <Input
                    type="number"
                    value={Math.round(selected.y)}
                    onChange={(e) => updateField(selected.id, { y: Number(e.target.value) })}
                    className="h-7 text-xs"
                  />
                </div>
              </div>
              <div>
                <label className="text-[10px] font-medium text-muted-foreground mb-1 block">Page</label>
                <select
                  className="w-full border border-input rounded-md px-2 py-1 text-xs bg-background"
                  value={selected.page}
                  onChange={(e) => updateField(selected.id, { page: Number(e.target.value) })}
                >
                  {Array.from({ length: pageCount }, (_, i) => (
                    <option key={i} value={i}>Page {i + 1}</option>
                  ))}
                </select>
              </div>
              <Button variant="destructive" size="sm" onClick={() => deleteField(selected.id)} className="w-full">
                <Trash2 className="h-3.5 w-3.5 mr-1" /> Remove Field
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Click a field to edit its properties, or click "Add Field" to place a new one.</p>
          )}

          {/* Field list */}
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">All Fields ({fields.length})</p>
            <div className="space-y-1 max-h-[300px] overflow-y-auto">
              {fields.map((f) => (
                <button
                  key={f.id}
                  onClick={() => { setSelectedId(f.id); setCurrentPage(f.page); }}
                  className={`w-full text-left px-2 py-1.5 rounded text-xs flex items-center gap-2 transition-colors ${
                    f.id === selectedId ? "bg-primary/10 text-primary" : "hover:bg-muted"
                  }`}
                >
                  <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: f.color }} />
                  <span className="truncate">{f.label}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground shrink-0">p{f.page + 1}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
