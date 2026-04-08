import React, { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Stage, Layer, Image as KonvaImage, Text as KonvaText, Rect } from "react-konva";
import { api, type LeadDetail, type EstimateDetail } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { generatePricingIncludes } from "@/lib/pricing-includes";
import { PRESET_FIELD_LABELS, PRESET_FIELD_COLORS } from "@/lib/pdf-types";
import ColorPicker from "@/components/ColorPicker";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { ArrowLeft, ChevronLeft, ChevronRight, Plus, Trash2, Send, Type, Loader2 } from "lucide-react";

interface CanvasField {
  id: string;
  label: string;
  page: number;
  x: number; // PDF points
  y: number;
  font_size: number;
  color: string;
  value: string;
  bold: boolean;
  width: number; // text box width (0 = no box, left-aligned)
}

function genId() {
  return `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export default function EditPdf() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [lead, setLead] = useState<LeadDetail | null>(null);
  const [estimate, setEstimate] = useState<EstimateDetail | null>(null);
  const [fields, setFields] = useState<CanvasField[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [currentPage, setCurrentPage] = useState(0);
  const [pageImages, setPageImages] = useState<(HTMLImageElement | null)[]>([]);
  const [pageSizes, setPageSizes] = useState<{ width: number; height: number }[]>([]);
  const [pageCount, setPageCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [stageSize, setStageSize] = useState({ width: 600, height: 776 });
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const selected = fields.find((f) => f.id === selectedId) || null;
  const pageFields = fields.filter((f) => f.page === currentPage);
  const currentPageSize = pageSizes[currentPage] || { width: 612, height: 792 };
  const scaleX = stageSize.width / currentPageSize.width;
  const scaleY = stageSize.height / currentPageSize.height;

  // Resize stage to fit container
  const updateStageSize = useCallback(() => {
    if (!containerRef.current) return;
    const w = containerRef.current.clientWidth;
    const ratio = currentPageSize.height / currentPageSize.width;
    setStageSize({ width: w, height: w * ratio });
  }, [currentPageSize]);

  useEffect(() => {
    updateStageSize();
    window.addEventListener("resize", updateStageSize);
    return () => window.removeEventListener("resize", updateStageSize);
  }, [updateStageSize]);

  // Load lead, estimate, template, and page images
  useEffect(() => {
    if (!id) return;
    setLoading(true);

    Promise.all([
      api.getLead(id),
      api.getPdfTemplate(),
    ]).then(([leadData, tmpl]) => {
      setLead(leadData);
      const est = leadData.estimates?.[0];
      setEstimate(est || null);

      const ps = (tmpl as unknown as { page_sizes?: { width: number; height: number }[] }).page_sizes || [];
      setPageSizes(ps);
      setPageCount(tmpl.page_count || 0);

      // Build auto-fill values
      const tiers = est?.tiers || { essential: 0, signature: 0, legacy: 0 };
      const fd = leadData.form_data || {};
      const fenceSides = Array.isArray(fd.fence_sides) ? fd.fence_sides : [];
      const includeFinancing = String(fd.include_financing ?? "true") !== "false";
      const pricingIncludes = generatePricingIncludes(fenceSides);

      const vals: Record<string, string> = {
        customer_name: (leadData.contact_name || "").split(" ").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" "),
        address: leadData.address || "",
        essential_price: includeFinancing ? `${formatCurrency(tiers.essential)} or $${(tiers.essential / 21).toFixed(2)}/mo` : formatCurrency(tiers.essential),
        signature_price: includeFinancing ? `${formatCurrency(tiers.signature)} or $${(tiers.signature / 21).toFixed(2)}/mo` : formatCurrency(tiers.signature),
        legacy_price: includeFinancing ? `${formatCurrency(tiers.legacy)} or $${(tiers.legacy / 21).toFixed(2)}/mo` : formatCurrency(tiers.legacy),
        essential_monthly: includeFinancing ? "Per month for 21mo" : "",
        signature_monthly: includeFinancing ? "Per month for 21mo" : "",
        legacy_monthly: includeFinancing ? "Per month for 21mo" : "",
        pricing_includes: pricingIncludes,
        date: new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
      };

      // Load field map from template + fill values
      const fm = tmpl.field_map as Record<string, { page: number; x: number; y: number; font_size: number; color?: string; width?: number }>;
      const initialFields: CanvasField[] = Object.entries(fm).map(([key, v]) => ({
        id: key,
        label: PRESET_FIELD_LABELS[key] || key,
        page: v.page,
        x: v.x,
        y: v.y,
        font_size: v.font_size || 14,
        color: v.color || PRESET_FIELD_COLORS[key] || "#2B2B2B",
        value: vals[key] || "",
        bold: key === "customer_name",
        width: (v as Record<string, unknown>).width as number || 0,
      }));
      setFields(initialFields);

      // Load page images
      const imgs: (HTMLImageElement | null)[] = new Array(tmpl.page_count).fill(null);
      for (let i = 0; i < tmpl.page_count; i++) {
        const img = new window.Image();
        img.crossOrigin = "anonymous";
        const pageIdx = i;
        fetch(api.getTemplatePageUrl(i, tmpl.id))
          .then((r) => r.blob())
          .then((blob) => {
            img.onload = () => {
              imgs[pageIdx] = img;
              setPageImages([...imgs]);
            };
            img.src = URL.createObjectURL(blob);
          })
          .catch(() => {});
      }
    }).catch(() => toast.error("Failed to load data"))
      .finally(() => setLoading(false));
  }, [id]);

  const updateField = (fieldId: string, updates: Partial<CanvasField>) => {
    setFields((prev) => prev.map((f) => (f.id === fieldId ? { ...f, ...updates } : f)));
  };

  const deleteField = (fieldId: string) => {
    setFields((prev) => prev.filter((f) => f.id !== fieldId));
    if (selectedId === fieldId) setSelectedId(null);
    if (editingId === fieldId) setEditingId(null);
  };

  const addCustomField = () => {
    const newField: CanvasField = {
      id: genId(),
      label: "Custom Text",
      page: currentPage,
      x: currentPageSize.width / 2,
      y: currentPageSize.height / 3,
      font_size: 14,
      color: "#2B2B2B",
      value: "Custom text",
      bold: false,
      width: 0,
    };
    setFields((prev) => [...prev, newField]);
    setSelectedId(newField.id);
  };

  // Offset fields above the finger while dragging on touch devices
  const DRAG_OFFSET_Y = 50;
  const isTouchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0;

  const handleDragEnd = (fieldId: string, canvasX: number, canvasY: number) => {
    const pdfX = canvasX / scaleX;
    const pdfY = isTouchDevice ? (canvasY + DRAG_OFFSET_Y) / scaleY : canvasY / scaleY;
    updateField(fieldId, { x: Math.round(pdfX * 10) / 10, y: Math.round(pdfY * 10) / 10 });
  };

  const startEditing = (fieldId: string) => {
    const field = fields.find((f) => f.id === fieldId);
    if (!field) return;
    setEditingId(fieldId);
    setEditValue(field.value);
    setTimeout(() => textareaRef.current?.focus(), 50);
  };

  const finishEditing = () => {
    if (editingId) {
      updateField(editingId, { value: editValue });
      setEditingId(null);
    }
  };

  const handleSend = async () => {
    if (!estimate) return;
    setSending(true);
    try {
      const payload = fields.map((f) => ({
        id: f.id, page: f.page, x: f.x, y: f.y,
        font_size: f.font_size, color: f.color, value: f.value, bold: f.bold, width: f.width || 0,
      }));
      await api.saveAndSendEstimate(estimate.id, payload);
      setSent(true);
      setTimeout(() => navigate(`/leads/${id}`), 2500);
    } catch {
      toast.error("Failed to send");
      setSending(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-dvh">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const currentImage = pageImages[currentPage] || null;

  // Editing field position on canvas
  const editingField = editingId ? fields.find((f) => f.id === editingId) : null;
  const editPos = editingField
    ? { x: editingField.x * scaleX, y: editingField.y * scaleY }
    : { x: 0, y: 0 };

  if (sent) {
    return (
      <div className="flex flex-col items-center justify-center h-dvh bg-[#1C2235] px-6">
        <div className="h-20 w-20 rounded-full bg-green-500 flex items-center justify-center mb-6 animate-bounce">
          <Send className="h-8 w-8 text-white" />
        </div>
        <h1 className="text-2xl font-bold text-white">Estimate Sent!</h1>
        <p className="text-white/60 text-sm mt-2">
          {lead?.contact_name ? `${lead.contact_name} will receive it shortly` : "The customer will receive it shortly"}
        </p>
        <p className="text-white/30 text-xs mt-4">Redirecting...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-dvh bg-gray-100">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-white border-b shrink-0 gap-2">
        <button onClick={() => navigate(`/leads/${id}`)} className="p-1.5 rounded-md hover:bg-muted">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-sm font-semibold truncate flex-1 text-center">
          Edit Proposal {lead?.contact_name ? `— ${lead.contact_name}` : ""}
        </h1>
        <Button size="sm" onClick={handleSend} disabled={sending || sent} className="bg-green-600 hover:bg-green-700 text-white">
          <Send className={`h-3.5 w-3.5 mr-1 ${sending ? "animate-spin" : ""}`} />
          {sent ? "Sent!" : sending ? "Sending..." : "Send to Customer"}
        </Button>
      </div>

      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-white border-b shrink-0">
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" disabled={currentPage === 0} onClick={() => { setCurrentPage((p) => p - 1); setSelectedId(null); setEditingId(null); }}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs font-medium w-16 text-center">Page {currentPage + 1}/{pageCount}</span>
          <Button variant="ghost" size="sm" disabled={currentPage >= pageCount - 1} onClick={() => { setCurrentPage((p) => p + 1); setSelectedId(null); setEditingId(null); }}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <Button variant="outline" size="sm" onClick={addCustomField}>
          <Plus className="h-3.5 w-3.5 mr-1" /><Type className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-hidden flex flex-col lg:flex-row">
        {/* Canvas area */}
        <div ref={containerRef} className="flex-1 overflow-auto p-2 sm:p-4 flex justify-center">
          <div className="relative shadow-lg rounded-lg overflow-hidden bg-white" style={{ width: stageSize.width, height: stageSize.height }}>
            <Stage
              width={stageSize.width}
              height={stageSize.height}
              onClick={(e) => {
                if (e.target === e.target.getStage() || e.target.attrs.id === "bg-rect") {
                  setSelectedId(null);
                  if (editingId) finishEditing();
                }
              }}
            >
              <Layer>
                {/* Background */}
                <Rect x={0} y={0} width={stageSize.width} height={stageSize.height} fill="#ffffff" id="bg-rect" />
                {currentImage && (
                  <KonvaImage image={currentImage} x={0} y={0} width={stageSize.width} height={stageSize.height} />
                )}
              </Layer>
              <Layer>
                {/* Text fields */}
                {pageFields.map((field) => {
                  const cx = field.x * scaleX;
                  const cy = field.y * scaleY;
                  const fontSize = field.font_size * scaleX;
                  const isSelected = field.id === selectedId;
                  const isEditing = field.id === editingId;

                  const boxW = (field.width || 0) * scaleX;
                  const isPrice = field.id.endsWith("_price");
                  const exampleText = isPrice ? "$2,115 or $100.57/mo" : field.value || "Example text";
                  return (
                    <React.Fragment key={field.id}>
                      {boxW > 0 && isSelected && (
                        <>
                          <Rect x={cx} y={cy} width={boxW} height={fontSize * 1.4}
                            stroke="#3b82f6" strokeWidth={0.5} dash={[4, 2]} fill="rgba(59,130,246,0.05)" />
                          <KonvaText x={cx} y={cy} text={exampleText}
                            fontSize={fontSize} fontFamily="'Libre Baskerville', Georgia, serif"
                            fontStyle="bold" fill="rgba(100,100,100,0.3)"
                            width={boxW} align="center" listening={false} />
                        </>
                      )}
                      <KonvaText
                        x={boxW > 0 ? cx : cx}
                        y={cy}
                        text={isEditing ? "" : field.value}
                        fontSize={fontSize}
                        fontFamily="'Libre Baskerville', Georgia, serif"
                        fontStyle={field.bold ? "bold" : "normal"}
                        fill={field.color}
                        width={boxW > 0 ? boxW : undefined}
                        align={boxW > 0 ? "center" : "left"}
                        draggable
                        visible={!isEditing}
                        dragBoundFunc={isTouchDevice ? (pos) => ({ x: pos.x, y: pos.y - DRAG_OFFSET_Y }) : undefined}
                        onDragEnd={(e) => handleDragEnd(field.id, e.target.x(), e.target.y())}
                        onClick={() => setSelectedId(field.id)}
                        onTap={() => setSelectedId(field.id)}
                        onDblClick={() => startEditing(field.id)}
                        onDblTap={() => startEditing(field.id)}
                        stroke={isSelected ? "#3b82f6" : undefined}
                        strokeWidth={isSelected ? 0.5 : 0}
                      />
                    </React.Fragment>
                  );
                })}
              </Layer>
            </Stage>

            {/* Textarea overlay for inline editing */}
            {editingField && (
              <textarea
                ref={textareaRef}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={finishEditing}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finishEditing(); } }}
                className="absolute outline-none border-2 border-blue-500 bg-white/90 rounded px-1"
                style={{
                  left: editPos.x,
                  top: editPos.y,
                  fontSize: editingField.font_size * scaleX,
                  fontFamily: "'Libre Baskerville', Georgia, serif",
                  fontWeight: editingField.bold ? "bold" : "normal",
                  color: editingField.color,
                  minWidth: 80,
                  minHeight: 30,
                  resize: "none",
                  lineHeight: 1.2,
                }}
              />
            )}
          </div>
        </div>

        {/* Properties panel */}
        <div className={`shrink-0 bg-white border-t lg:border-t-0 lg:border-l w-full lg:w-56 overflow-y-auto ${selected ? "" : "hidden lg:block"}`}>
          <div className="p-3 space-y-3">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Properties</p>
            {selected ? (
              <>
                <div>
                  <p className="text-xs font-medium mb-0.5">{selected.label}</p>
                  <p className="text-[10px] text-muted-foreground truncate">{selected.value || "(empty)"}</p>
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground block mb-0.5">Size</label>
                  <div className="flex items-center gap-2">
                    <input type="range" min={8} max={80} value={selected.font_size}
                      onChange={(e) => updateField(selected.id, { font_size: Number(e.target.value) })} className="flex-1" />
                    <span className="text-[10px] font-mono w-6 text-right">{selected.font_size}</span>
                  </div>
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground block mb-0.5">Color</label>
                  <ColorPicker value={selected.color} onChange={(c) => updateField(selected.id, { color: c })} />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground block mb-0.5">Box Width (0 = auto)</label>
                  <div className="flex items-center gap-2">
                    <input type="range" min={0} max={400} value={selected.width || 0}
                      onChange={(e) => updateField(selected.id, { width: Number(e.target.value) })} className="flex-1" />
                    <span className="text-[10px] font-mono w-8 text-right">{selected.width || 0}</span>
                  </div>
                </div>
                <div>
                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <input type="checkbox" checked={selected.bold}
                      onChange={(e) => updateField(selected.id, { bold: e.target.checked })} className="rounded" />
                    Bold
                  </label>
                </div>
                <Button variant="outline" size="sm" className="w-full" onClick={() => startEditing(selected.id)}>
                  Edit Text
                </Button>
                <Button variant="destructive" size="sm" className="w-full" onClick={() => deleteField(selected.id)}>
                  <Trash2 className="h-3 w-3 mr-1" /> Delete
                </Button>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                Click a text field to select it. Double-click to edit. Drag to move.
              </p>
            )}

            {/* Field list */}
            <div className="border-t pt-3">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                Fields ({fields.length})
              </p>
              <div className="space-y-0.5 max-h-48 overflow-y-auto">
                {fields.map((f) => (
                  <button key={f.id} onClick={() => { setSelectedId(f.id); setCurrentPage(f.page); }}
                    className={`w-full text-left px-2 py-1 rounded text-[11px] truncate ${
                      f.id === selectedId ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted"
                    }`}>
                    <span className="inline-block h-1.5 w-1.5 rounded-full mr-1.5" style={{ backgroundColor: f.color }} />
                    {f.label} <span className="text-muted-foreground">p{f.page + 1}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
