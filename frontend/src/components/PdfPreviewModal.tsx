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
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  ChevronLeft, ChevronRight, Send, Plus, Trash2, GripVertical, Loader2,
} from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lead: LeadDetail;
  estimate: EstimateDetail;
  fenceSides: string[];
  onSent: () => void;
}

let customCounter = 0;

export default function PdfPreviewModal({ open, onOpenChange, lead, estimate, fenceSides, onSent }: Props) {
  const [pages, setPages] = useState<{ page_num: number; image_data: string }[]>([]);
  const [currentPage, setCurrentPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [fields, setFields] = useState<PdfField[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ fieldId: string; startX: number; startY: number; origX: number; origY: number } | null>(null);

  const selected = fields.find((f) => f.id === selectedId) || null;
  const pageFields = fields.filter((f) => f.page === currentPage);

  const getImgDims = useCallback(() => {
    if (!imgRef.current) return { w: 612, h: 792 };
    return { w: imgRef.current.clientWidth, h: imgRef.current.clientHeight };
  }, []);

  // Build auto-fill values
  const buildValues = useCallback(() => {
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

  // Load preview on open
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setSelectedId(null);

    // Load template field map to initialize field positions
    api.getPdfTemplate().then((tmpl) => {
      const fm = tmpl.field_map as Record<string, { page: number; x: number; y: number; font_size: number; color?: string }>;
      const vals = buildValues();
      const initialFields: PdfField[] = Object.entries(fm).map(([key, v]) => ({
        id: key,
        label: PRESET_FIELD_LABELS[key] || key,
        page: v.page,
        x: v.x,
        y: v.y,
        font_size: v.font_size || 12,
        color: v.color || PRESET_FIELD_COLORS[key] || "#2B2B2B",
        value: (vals as Record<string, string>)[key] || "",
      }));
      setFields(initialFields);
    }).catch(() => {});

    // Get preview pages
    api.previewEstimatePdf(estimate.id).then((data) => {
      setPages(data.pages);
      setCurrentPage(0);
    }).catch(() => toast.error("Failed to load preview")).finally(() => setLoading(false));
  }, [open, estimate.id, buildValues]);

  const refreshPreview = useCallback(() => {
    const overrides: Record<string, unknown> = {};
    const extra: Record<string, unknown>[] = [];
    for (const f of fields) {
      if (f.id.startsWith("custom_")) {
        extra.push({ page: f.page, x: f.x, y: f.y, font_size: f.font_size, color: f.color, value: f.value || "" });
      } else {
        overrides[f.id] = { page: f.page, x: f.x, y: f.y, font_size: f.font_size, color: f.color };
      }
    }
    api.previewEstimatePdf(estimate.id, Object.keys(overrides).length ? overrides : undefined, extra.length ? extra : undefined)
      .then((data) => setPages(data.pages))
      .catch(() => {});
  }, [fields, estimate.id]);

  // Debounced refresh on field changes
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const handleFieldChange = useCallback(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(refreshPreview, 600);
  }, [refreshPreview]);

  const updateField = (id: string, updates: Partial<PdfField>) => {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...updates } : f)));
    handleFieldChange();
  };

  const deleteField = (id: string) => {
    setFields((prev) => prev.filter((f) => f.id !== id));
    if (selectedId === id) setSelectedId(null);
    handleFieldChange();
  };

  const addCustomField = () => {
    const id = `custom_${++customCounter}`;
    setFields((prev) => [...prev, {
      id, label: "Custom Text", page: currentPage, x: 200, y: 400, font_size: 12, color: "#2B2B2B", value: "Custom text",
    }]);
    setSelectedId(id);
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
      const { w: cw, h: ch } = getImgDims();
      const pdf = screenToPdf(dragRef.current.origX + dx, dragRef.current.origY + dy, cw, ch);
      updateField(dragRef.current.fieldId, { x: Math.round(pdf.x * 10) / 10, y: Math.round(pdf.y * 10) / 10 });
    };
    const handleUp = () => {
      dragRef.current = null;
      handleFieldChange();
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
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
          <DialogTitle>Preview Estimate — {lead.contact_name}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="flex-1 overflow-hidden grid grid-cols-1 lg:grid-cols-[1fr_220px] gap-3">
            {/* PDF preview */}
            <div className="overflow-y-auto">
              {/* Page nav */}
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

              {/* PDF page with overlays */}
              <div className="relative border rounded-lg overflow-hidden bg-gray-100" onClick={() => setSelectedId(null)}>
                {currentPageData && (
                  <img
                    ref={imgRef}
                    src={`data:image/jpeg;base64,${currentPageData.image_data}`}
                    alt={`Page ${currentPage + 1}`}
                    className="w-full block"
                    draggable={false}
                  />
                )}
                {pageFields.map((field) => {
                  const { w, h } = getImgDims();
                  const screen = pdfToScreen(field.x, field.y, w, h);
                  const isSelected = field.id === selectedId;
                  return (
                    <div
                      key={field.id}
                      data-field
                      onMouseDown={(e) => handleMouseDown(e, field.id)}
                      className={`absolute cursor-grab select-none touch-none flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-medium text-white whitespace-nowrap ${
                        isSelected ? "ring-2 ring-white shadow-lg z-20" : "z-10 opacity-80 hover:opacity-100"
                      }`}
                      style={{
                        left: screen.x,
                        top: screen.y,
                        backgroundColor: field.color + "cc",
                        transform: "translate(-50%, -100%)",
                      }}
                      onClick={(e) => { e.stopPropagation(); setSelectedId(field.id); }}
                    >
                      <GripVertical className="h-2.5 w-2.5 opacity-60" />
                      {field.label}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Properties panel */}
            <div className="overflow-y-auto space-y-3 border-l pl-3 hidden lg:block">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Properties</p>
              {selected ? (
                <div className="space-y-2.5">
                  <div>
                    <label className="text-[10px] text-muted-foreground mb-0.5 block">Label</label>
                    <p className="text-xs font-medium">{selected.label}</p>
                  </div>
                  {(selected.id.startsWith("custom_") || editingValue === selected.id) && (
                    <div>
                      <label className="text-[10px] text-muted-foreground mb-0.5 block">Value</label>
                      <Input
                        value={selected.value || ""}
                        onChange={(e) => updateField(selected.id, { value: e.target.value })}
                        className="h-7 text-xs"
                      />
                    </div>
                  )}
                  {!selected.id.startsWith("custom_") && editingValue !== selected.id && (
                    <Button variant="ghost" size="sm" className="text-xs" onClick={() => setEditingValue(selected.id)}>
                      Edit value
                    </Button>
                  )}
                  <div>
                    <label className="text-[10px] text-muted-foreground mb-0.5 block">Font Size</label>
                    <div className="flex items-center gap-2">
                      <input type="range" min={8} max={48} value={selected.font_size}
                        onChange={(e) => updateField(selected.id, { font_size: Number(e.target.value) })} className="flex-1" />
                      <span className="text-[10px] font-mono w-6 text-right">{selected.font_size}</span>
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] text-muted-foreground mb-0.5 block">Color</label>
                    <ColorPicker value={selected.color} onChange={(c) => updateField(selected.id, { color: c })} />
                  </div>
                  <Button variant="destructive" size="sm" onClick={() => deleteField(selected.id)} className="w-full">
                    <Trash2 className="h-3 w-3 mr-1" /> Remove
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Select a field marker to edit</p>
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
