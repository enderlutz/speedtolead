import { useState, useRef, useCallback, useEffect } from "react";
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
  pageSizes: { width: number; height: number }[];
  initialFieldMap: Record<string, { page: number; x: number; y: number; font_size: number; color?: string }>;
  onSave: (fieldMap: Record<string, unknown>) => void;
}

function genId() {
  return `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export default function PdfTemplateEditor({ pageCount, pageSizes, initialFieldMap, onSave }: Props) {
  const [currentPage, setCurrentPage] = useState(0);
  const [fields, setFields] = useState<PdfField[]>(() =>
    Object.entries(initialFieldMap).map(([key, v]) => ({
      id: key,
      label: PRESET_FIELD_LABELS[key] || key,
      page: v.page,
      x: v.x,
      y: v.y,
      font_size: v.font_size || 12,
      color: v.color || PRESET_FIELD_COLORS[key] || "#2B2B2B",
    }))
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pageImageUrl, setPageImageUrl] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ fieldId: string; startX: number; startY: number; origX: number; origY: number } | null>(null);

  // Load page image via fetch (handles auth + avoids CORS issues)
  useEffect(() => {
    let cancelled = false;
    setPageImageUrl(null);
    fetch(api.getTemplatePageUrl(currentPage))
      .then((res) => { if (res.ok) return res.blob(); throw new Error(); })
      .then((blob) => { if (!cancelled) setPageImageUrl(URL.createObjectURL(blob)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [currentPage]);

  const selected = fields.find((f) => f.id === selectedId) || null;
  const pageFields = fields.filter((f) => f.page === currentPage);
  const usedPresets = new Set(fields.filter((f) => PRESET_FIELDS.includes(f.id as never)).map((f) => f.id));

  const getPageSize = useCallback((page: number) => {
    return pageSizes[page] || { width: 612, height: 792 };
  }, [pageSizes]);

  const getImgDims = useCallback(() => {
    if (!imgRef.current) return { w: 612, h: 792 };
    const w = imgRef.current.clientWidth;
    const h = imgRef.current.clientHeight;
    return { w: w > 0 ? w : 612, h: h > 0 ? h : 792 };
  }, []);

  const handleAddField = (key: string, label: string) => {
    const id = PRESET_FIELDS.includes(key as never) ? key : genId();
    const ps = getPageSize(currentPage);
    setFields((prev) => [...prev, {
      id, label, page: currentPage,
      x: ps.width / 2, y: ps.height / 3,
      font_size: 14,
      color: PRESET_FIELD_COLORS[key] || "#2B2B2B",
    }]);
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
    const ps = getPageSize(field.page);
    const screen = pdfToScreen(field.x, field.y, w, h, ps.width, ps.height);
    dragRef.current = { fieldId, startX: e.clientX, startY: e.clientY, origX: screen.x, origY: screen.y };

    const handleMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      const { w: cw, h: ch } = getImgDims();
      const ps2 = getPageSize(currentPage);
      const pdf = screenToPdf(dragRef.current.origX + dx, dragRef.current.origY + dy, cw, ch, ps2.width, ps2.height);
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

  const handleTouchStart = (e: React.TouchEvent, fieldId: string) => {
    e.stopPropagation();
    setSelectedId(fieldId);
    const touch = e.touches[0];
    const { w, h } = getImgDims();
    const field = fields.find((f) => f.id === fieldId);
    if (!field) return;
    const ps = getPageSize(field.page);
    const screen = pdfToScreen(field.x, field.y, w, h, ps.width, ps.height);
    dragRef.current = { fieldId, startX: touch.clientX, startY: touch.clientY, origX: screen.x, origY: screen.y };

    const handleMove = (ev: TouchEvent) => {
      ev.preventDefault();
      if (!dragRef.current) return;
      const t = ev.touches[0];
      const { w: cw, h: ch } = getImgDims();
      const ps2 = getPageSize(currentPage);
      const pdf = screenToPdf(
        dragRef.current.origX + t.clientX - dragRef.current.startX,
        dragRef.current.origY + t.clientY - dragRef.current.startY,
        cw, ch, ps2.width, ps2.height
      );
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
      fieldMap[f.id] = {
        page: f.page,
        x: Math.round(f.x * 100) / 100,
        y: Math.round(f.y * 100) / 100,
        font_size: f.font_size,
        color: f.color,
      };
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

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" disabled={currentPage === 0} onClick={() => setCurrentPage((p) => p - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs font-medium min-w-[60px] text-center">Page {currentPage + 1} / {pageCount}</span>
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
                  <button key={key} onClick={() => handleAddField(key, PRESET_FIELD_LABELS[key])}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: PRESET_FIELD_COLORS[key] }} />
                    {PRESET_FIELD_LABELS[key]}
                  </button>
                ))}
                <div className="border-t my-1" />
                <button onClick={() => {
                  const label = prompt("Custom field label:");
                  if (label) handleAddField(label.toLowerCase().replace(/\s+/g, "_"), label);
                }} className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors text-muted-foreground">
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
        <div ref={containerRef} className="relative border rounded-lg overflow-hidden bg-gray-100" onClick={() => setSelectedId(null)}>
          {pageImageUrl ? (
            <img ref={imgRef} src={pageImageUrl} alt={`Page ${currentPage + 1}`}
              className="w-full block" draggable={false} onLoad={() => setFields((f) => [...f])} />
          ) : (
            <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">Loading page...</div>
          )}
          {pageFields.map((field) => {
            const { w, h } = getImgDims();
            const ps = getPageSize(currentPage);
            const screen = pdfToScreen(field.x, field.y, w, h, ps.width, ps.height);
            const isSelected = field.id === selectedId;
            return (
              <div key={field.id} data-field
                onMouseDown={(e) => handleMouseDown(e, field.id)}
                onTouchStart={(e) => handleTouchStart(e, field.id)}
                className={`absolute cursor-grab select-none touch-none ${
                  isSelected ? "z-20" : "z-10"
                }`}
                style={{ left: screen.x, top: screen.y }}>
                <div className="flex items-start gap-1" style={{ transform: "translate(0, -50%)" }}>
                  {/* Arrow pointing to exact text insertion point */}
                  <div className={`flex flex-col items-center ${isSelected ? "" : "opacity-70 hover:opacity-100"}`}>
                    <div className="w-0 h-0 border-l-[5px] border-r-[5px] border-t-[7px] border-l-transparent border-r-transparent"
                      style={{ borderTopColor: isSelected ? "#3b82f6" : field.color }} />
                    <div className="w-0.5 h-2.5" style={{ backgroundColor: isSelected ? "#3b82f6" : field.color }} />
                  </div>
                  {/* Label tag */}
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap shadow-sm ${
                    isSelected ? "bg-blue-500 text-white ring-2 ring-blue-300" : "text-white"
                  }`} style={{ backgroundColor: isSelected ? undefined : field.color }}>
                    <GripVertical className="h-3 w-3 inline-block -ml-0.5 mr-0.5 opacity-60" />
                    {field.label}
                  </span>
                </div>
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
                  <input type="range" min={8} max={80} value={selected.font_size}
                    onChange={(e) => updateField(selected.id, { font_size: Number(e.target.value) })} className="flex-1" />
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
                  <Input type="number" value={Math.round(selected.x)} onChange={(e) => updateField(selected.id, { x: Number(e.target.value) })} className="h-7 text-xs" />
                </div>
                <div>
                  <label className="text-[10px] font-medium text-muted-foreground mb-1 block">Y</label>
                  <Input type="number" value={Math.round(selected.y)} onChange={(e) => updateField(selected.id, { y: Number(e.target.value) })} className="h-7 text-xs" />
                </div>
              </div>
              <div>
                <label className="text-[10px] font-medium text-muted-foreground mb-1 block">Page</label>
                <select className="w-full border border-input rounded-md px-2 py-1 text-xs bg-background"
                  value={selected.page} onChange={(e) => updateField(selected.id, { page: Number(e.target.value) })}>
                  {Array.from({ length: pageCount }, (_, i) => <option key={i} value={i}>Page {i + 1}</option>)}
                </select>
              </div>
              <Button variant="destructive" size="sm" onClick={() => deleteField(selected.id)} className="w-full">
                <Trash2 className="h-3.5 w-3.5 mr-1" /> Remove Field
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Click a field to edit, or "Add Field" to place a new one.</p>
          )}
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">All Fields ({fields.length})</p>
            <div className="space-y-1 max-h-[300px] overflow-y-auto">
              {fields.map((f) => (
                <button key={f.id} onClick={() => { setSelectedId(f.id); setCurrentPage(f.page); }}
                  className={`w-full text-left px-2 py-1.5 rounded text-xs flex items-center gap-2 transition-colors ${
                    f.id === selectedId ? "bg-primary/10 text-primary" : "hover:bg-muted"}`}>
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
