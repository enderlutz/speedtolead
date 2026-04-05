import { useState, useEffect, useCallback, useRef } from "react";
import { api, type LeadDetail, type EstimateDetail } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { generatePricingIncludes } from "@/lib/pricing-includes";
import { pdfToScreen, screenToPdf } from "@/lib/pdf-coords";
import type { PdfField } from "@/lib/pdf-types";
import { PRESET_FIELD_LABELS, PRESET_FIELD_COLORS } from "@/lib/pdf-types";
import ColorPicker from "@/components/ColorPicker";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Send, Plus, Trash2, Loader2 } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lead: LeadDetail;
  estimate: EstimateDetail;
  fenceSides: string[];
  onSent: () => void;
}

function genId() {
  return `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export default function PdfPreviewModal({ open, onOpenChange, lead, estimate, fenceSides, onSent }: Props) {
  const [pages, setPages] = useState<{ page_num: number; image_data: string }[]>([]);
  const [pageSizes, setPageSizes] = useState<{ width: number; height: number }[]>([]);
  const [currentPage, setCurrentPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [fields, setFields] = useState<PdfField[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{ fieldId: string; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => { dragRef.current = null; }, []);

  const selected = fields.find((f) => f.id === selectedId) || null;
  const pageFields = fields.filter((f) => f.page === currentPage);

  const getPageSize = useCallback((page: number) => pageSizes[page] || { width: 612, height: 792 }, [pageSizes]);

  const getImgDims = useCallback(() => {
    if (!imgRef.current) return { w: 612, h: 792 };
    const w = imgRef.current.clientWidth;
    const h = imgRef.current.clientHeight;
    return { w: w > 0 ? w : 612, h: h > 0 ? h : 792 };
  }, []);

  const buildValues = useCallback((): Record<string, string> => {
    const tiers = estimate.tiers || { essential: 0, signature: 0, legacy: 0 };
    return {
      customer_name: lead.contact_name || "",
      address: lead.address || "",
      essential_price: formatCurrency(tiers.essential),
      signature_price: formatCurrency(tiers.signature),
      legacy_price: formatCurrency(tiers.legacy),
      essential_monthly: `$${Math.round(tiers.essential / 21)}/mo`,
      signature_monthly: `$${Math.round(tiers.signature / 21)}/mo`,
      legacy_monthly: `$${Math.round(tiers.legacy / 21)}/mo`,
      pricing_includes: generatePricingIncludes(fenceSides),
      date: new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
    };
  }, [lead, estimate, fenceSides]);

  // Load on open
  useEffect(() => {
    if (!open) {
      setPages([]);
      setFields([]);
      setSelectedId(null);
      setEditingId(null);
      return;
    }
    setLoading(true);

    // Load template field map + page sizes
    api.getPdfTemplate().then((tmpl) => {
      const fm = tmpl.field_map as Record<string, { page: number; x: number; y: number; font_size: number; color?: string }>;
      const vals = buildValues();
      const ps = (tmpl as unknown as { page_sizes: { width: number; height: number }[] }).page_sizes || [];
      setPageSizes(ps);

      setFields(Object.entries(fm).map(([key, v]) => ({
        id: key,
        label: PRESET_FIELD_LABELS[key] || key,
        page: v.page,
        x: v.x,
        y: v.y,
        font_size: v.font_size || 12,
        color: v.color || PRESET_FIELD_COLORS[key] || "#2B2B2B",
        value: vals[key] || "",
      })));
    }).catch(() => {});

    // Get initial preview
    api.previewEstimatePdf(estimate.id).then((data) => {
      setPages(data.pages);
      setCurrentPage(0);
    }).catch(() => toast.error("Failed to load preview")).finally(() => setLoading(false));
  }, [open, estimate.id, buildValues]);

  // Debounced re-render
  const refreshPreview = useCallback((currentFields: PdfField[]) => {
    const overrides: Record<string, unknown> = {};
    const extra: Record<string, unknown>[] = [];
    for (const f of currentFields) {
      if (f.id.startsWith("custom_")) {
        extra.push({ page: f.page, x: f.x, y: f.y, font_size: f.font_size, color: f.color, value: f.value || "" });
      } else {
        overrides[f.id] = { page: f.page, x: f.x, y: f.y, font_size: f.font_size, color: f.color };
      }
    }
    api.previewEstimatePdf(estimate.id, Object.keys(overrides).length ? overrides : undefined, extra.length ? extra : undefined)
      .then((data) => setPages(data.pages))
      .catch(() => {});
  }, [estimate.id]);

  const scheduleRefresh = useCallback((updatedFields: PdfField[]) => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => refreshPreview(updatedFields), 800);
  }, [refreshPreview]);

  const updateField = useCallback((id: string, updates: Partial<PdfField>) => {
    setFields((prev) => {
      const next = prev.map((f) => (f.id === id ? { ...f, ...updates } : f));
      scheduleRefresh(next);
      return next;
    });
  }, [scheduleRefresh]);

  const deleteField = (id: string) => {
    setFields((prev) => {
      const next = prev.filter((f) => f.id !== id);
      scheduleRefresh(next);
      return next;
    });
    if (selectedId === id) setSelectedId(null);
    if (editingId === id) setEditingId(null);
  };

  const addCustomField = () => {
    const id = genId();
    const ps = getPageSize(currentPage);
    setFields((prev) => {
      const next = [...prev, {
        id, label: "Custom", page: currentPage,
        x: ps.width / 2, y: ps.height / 3,
        font_size: 12, color: "#2B2B2B", value: "Custom text",
      }];
      scheduleRefresh(next);
      return next;
    });
    setSelectedId(id);
    setEditingId(id);
  };

  const handleMouseDown = (e: React.MouseEvent, fieldId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (editingId === fieldId) return; // don't drag while editing
    setSelectedId(fieldId);
    const { w, h } = getImgDims();
    const field = fields.find((f) => f.id === fieldId);
    if (!field) return;
    const ps = getPageSize(field.page);
    const screen = pdfToScreen(field.x, field.y, w, h, ps.width, ps.height);
    dragRef.current = { fieldId, startX: e.clientX, startY: e.clientY, origX: screen.x, origY: screen.y };

    const handleMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const { w: cw, h: ch } = getImgDims();
      const ps2 = getPageSize(currentPage);
      const pdf = screenToPdf(
        dragRef.current.origX + ev.clientX - dragRef.current.startX,
        dragRef.current.origY + ev.clientY - dragRef.current.startY,
        cw, ch, ps2.width, ps2.height
      );
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

  // Double-click to edit inline
  const handleDoubleClick = (e: React.MouseEvent, fieldId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setEditingId(fieldId);
    setSelectedId(fieldId);
    setTimeout(() => editInputRef.current?.focus(), 50);
  };

  const handleSend = async () => {
    setSending(true);
    try {
      const overrides: Record<string, unknown> = {};
      const extra: Record<string, unknown>[] = [];
      for (const f of fields) {
        if (f.id.startsWith("custom_")) {
          extra.push({ page: f.page, x: f.x, y: f.y, font_size: f.font_size, color: f.color, value: f.value || "" });
        } else {
          overrides[f.id] = { page: f.page, x: f.x, y: f.y, font_size: f.font_size, color: f.color };
        }
      }
      await api.approveWithOverrides(estimate.id, Object.keys(overrides).length ? overrides : undefined, extra.length ? extra : undefined);
      toast.success("Estimate sent to customer!");
      onOpenChange(false);
      onSent();
    } catch {
      toast.error("Failed to send");
    } finally {
      setSending(false);
    }
  };

  const currentPageData = pages.find((p) => p.page_num === currentPage);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[90vw] max-h-[92vh] overflow-hidden flex flex-col" showCloseButton>
        <DialogHeader>
          <DialogTitle>Preview — {lead.contact_name}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="flex-1 overflow-hidden grid grid-cols-1 lg:grid-cols-[1fr_200px] gap-3">
            {/* PDF preview with live editing */}
            <div className="overflow-y-auto">
              <div className="flex items-center gap-2 mb-2">
                <Button variant="outline" size="sm" disabled={currentPage === 0} onClick={() => setCurrentPage((p) => p - 1)}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-xs font-medium">Page {currentPage + 1} / {pages.length}</span>
                <Button variant="outline" size="sm" disabled={currentPage >= pages.length - 1} onClick={() => setCurrentPage((p) => p + 1)}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" onClick={addCustomField} className="ml-auto">
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add Text
                </Button>
              </div>

              <div className="relative border rounded-lg overflow-hidden bg-gray-100" onClick={() => { setSelectedId(null); setEditingId(null); }}>
                {currentPageData && (
                  <img ref={imgRef} src={`data:image/jpeg;base64,${currentPageData.image_data}`}
                    alt={`Page ${currentPage + 1}`} className="w-full block" draggable={false} />
                )}
                {/* Field markers — small crosshairs since text is in the rendered PDF */}
                {pageFields.map((field) => {
                  const { w, h } = getImgDims();
                  const ps = getPageSize(currentPage);
                  const screen = pdfToScreen(field.x, field.y, w, h, ps.width, ps.height);
                  const isSelected = field.id === selectedId;
                  const isEditing = field.id === editingId;

                  return (
                    <div key={field.id} data-field
                      onMouseDown={(e) => handleMouseDown(e, field.id)}
                      onDoubleClick={(e) => handleDoubleClick(e, field.id)}
                      onClick={(e) => { e.stopPropagation(); setSelectedId(field.id); }}
                      className={`absolute select-none touch-none ${
                        isEditing ? "z-30" : isSelected ? "z-20" : "z-10 cursor-grab"
                      }`}
                      style={{ left: screen.x, top: screen.y }}
                    >
                      {isEditing ? (
                        <input
                          ref={editInputRef}
                          value={field.value || ""}
                          onChange={(e) => updateField(field.id, { value: e.target.value })}
                          onKeyDown={(e) => { if (e.key === "Enter") setEditingId(null); }}
                          onBlur={() => setEditingId(null)}
                          onClick={(e) => e.stopPropagation()}
                          className="bg-white/90 border border-primary rounded px-1 py-0.5 outline-none"
                          style={{
                            color: field.color,
                            fontSize: Math.max(10, Math.min(field.font_size * (w / (ps.width || 612)) * 0.9, 24)),
                            fontFamily: "'Libre Baskerville', serif",
                            minWidth: 60,
                          }}
                        />
                      ) : (
                        /* Crosshair marker + label */
                        <div className="flex items-start gap-1" style={{ transform: "translate(0, -50%)" }}>
                          {/* Arrow/crosshair pointing to exact insertion point */}
                          <div className={`flex flex-col items-center ${isSelected ? "" : "opacity-60 hover:opacity-100"}`}>
                            <div className="w-0 h-0 border-l-[5px] border-r-[5px] border-t-[6px] border-l-transparent border-r-transparent"
                              style={{ borderTopColor: isSelected ? "#3b82f6" : field.color }} />
                            <div className="w-px h-2" style={{ backgroundColor: isSelected ? "#3b82f6" : field.color }} />
                          </div>
                          {/* Small label */}
                          <span className={`text-[9px] font-medium px-1 rounded whitespace-nowrap ${
                            isSelected ? "bg-blue-500 text-white" : "bg-black/50 text-white"
                          }`}>
                            {field.label}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Compact controls */}
            <div className="overflow-y-auto space-y-2 border-l pl-3 hidden lg:block">
              {selected ? (
                <div className="space-y-2">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase">{selected.label}</p>
                  <div>
                    <label className="text-[10px] text-muted-foreground block">Size</label>
                    <div className="flex items-center gap-1">
                      <input type="range" min={8} max={80} value={selected.font_size}
                        onChange={(e) => updateField(selected.id, { font_size: Number(e.target.value) })} className="flex-1" />
                      <span className="text-[10px] font-mono w-5">{selected.font_size}</span>
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] text-muted-foreground block">Color</label>
                    <ColorPicker value={selected.color} onChange={(c) => updateField(selected.id, { color: c })} />
                  </div>
                  <Button variant="destructive" size="sm" onClick={() => deleteField(selected.id)} className="w-full">
                    <Trash2 className="h-3 w-3 mr-1" /> Remove
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Double-click a field to edit its text. Drag to reposition.</p>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSend} disabled={sending || loading} className="bg-green-600 hover:bg-green-700 text-white">
            <Send className={`h-4 w-4 mr-2 ${sending ? "animate-spin" : ""}`} />
            {sending ? "Sending..." : "Approve & Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
