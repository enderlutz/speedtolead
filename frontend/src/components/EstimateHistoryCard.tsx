import { useEffect, useState, useCallback } from "react";
import { api, type EstimateHistoryItem } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { toast } from "sonner";
import { History, Pencil, Check, X, FileText, ChevronDown, ChevronUp } from "lucide-react";

interface Props {
  leadId: string;
  /** Bumps when a new estimate is sent so we re-fetch. */
  refreshKey?: number;
}

const fmtDate = (s: string | null | undefined) => {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleString(undefined, {
      month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit",
    });
  } catch {
    return s.slice(0, 10);
  }
};

const fmtVal = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  return String(v);
};

const SIDES_PRETTY = (sides: unknown): string => {
  if (Array.isArray(sides)) return sides.length ? sides.join(", ") : "—";
  if (typeof sides === "string" && sides.trim()) return sides;
  return "—";
};

export default function EstimateHistoryCard({ leadId, refreshKey = 0 }: Props) {
  const [items, setItems] = useState<EstimateHistoryItem[] | null>(null);
  const [open, setOpen] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = useCallback(() => {
    api.getEstimateHistory(leadId)
      .then((r) => setItems(r.history))
      .catch(() => setItems([]));
  }, [leadId]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const startEdit = (it: EstimateHistoryItem) => {
    setEditingId(it.id);
    setLabelDraft(it.label || "");
  };
  const cancelEdit = () => { setEditingId(null); setLabelDraft(""); };
  const saveLabel = async (id: string) => {
    try {
      await api.updateEstimateLabel(id, labelDraft);
      toast.success("Label saved");
      setEditingId(null);
      load();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save label");
    }
  };

  const toggleRow = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  if (items === null) return null; // initial load
  if (items.length === 0) return null; // no sent estimates yet — hide entirely

  return (
    <Card>
      <CardHeader className="pb-2 cursor-pointer" onClick={() => setOpen((v) => !v)}>
        <CardTitle className="text-sm flex items-center gap-2">
          <History className="h-4 w-4 text-primary" /> Estimate History
          <span className="text-xs font-normal text-muted-foreground ml-1">
            {items.length} sent
          </span>
          <span className="ml-auto">
            {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </span>
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent className="space-y-2">
          {items.slice().reverse().map((it) => {
            const inputs = (it.inputs || {}) as Record<string, unknown>;
            const tiers = it.tiers || { essential: 0, signature: 0, legacy: 0 };
            const isExpanded = !!expanded[it.id];
            const isEditing = editingId === it.id;
            return (
              <div key={it.id} className="border rounded-md overflow-hidden">
                {/* Row header */}
                <div className="px-3 py-2 bg-muted/30 flex items-center gap-2 flex-wrap">
                  <Badge className="bg-primary text-primary-foreground text-[10px]">
                    Estimate #{it.estimate_number}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    Sent {fmtDate(it.sent_at || it.created_at)}
                  </span>
                  <span className="ml-auto text-sm font-semibold">
                    {formatCurrency(tiers.signature || it.estimate_low || 0)}
                    <span className="text-[10px] text-muted-foreground ml-1">(signature)</span>
                  </span>
                </div>

                {/* Label row */}
                <div className="px-3 py-1.5 flex items-center gap-2 text-xs border-b bg-background">
                  <span className="text-muted-foreground shrink-0">Label:</span>
                  {isEditing ? (
                    <>
                      <Input
                        value={labelDraft}
                        onChange={(e) => setLabelDraft(e.target.value)}
                        placeholder="e.g. v1 — 6ft cedar, after Olga discount"
                        className="h-7 text-xs flex-1"
                        autoFocus
                      />
                      <button onClick={() => saveLabel(it.id)} className="text-emerald-600 hover:text-emerald-800 p-1" title="Save">
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={cancelEdit} className="text-muted-foreground hover:text-foreground p-1" title="Cancel">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className={`flex-1 truncate ${it.label ? "font-medium" : "italic text-muted-foreground"}`}>
                        {it.label || "no label — click pencil to add"}
                      </span>
                      <button onClick={() => startEdit(it)} className="text-muted-foreground hover:text-primary p-1" title="Edit label">
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </div>

                {/* Toggle inputs / detail */}
                <button
                  onClick={() => toggleRow(it.id)}
                  className="w-full text-left px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-muted/30 flex items-center gap-1"
                >
                  {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  {isExpanded ? "Hide inputs" : "Show inputs"}
                </button>

                {isExpanded && (
                  <div className="px-3 py-2 text-xs grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1 bg-muted/10 border-t">
                    <div><span className="text-muted-foreground">Linear feet:</span> {fmtVal(inputs.linear_feet)}</div>
                    <div><span className="text-muted-foreground">Fence height:</span> {fmtVal(inputs.fence_height)}</div>
                    <div><span className="text-muted-foreground">Fence age:</span> {fmtVal(inputs.fence_age)}</div>
                    <div><span className="text-muted-foreground">Previously stained:</span> {fmtVal(inputs.previously_stained)}</div>
                    <div><span className="text-muted-foreground">Sqft:</span> {fmtVal(inputs._sqft)}</div>
                    <div><span className="text-muted-foreground">Zone:</span> {fmtVal(inputs._zone)}</div>
                    <div className="col-span-full">
                      <span className="text-muted-foreground">Sides included:</span> {SIDES_PRETTY(inputs.fence_sides)}
                    </div>
                    <div><span className="text-muted-foreground">Essential:</span> {formatCurrency(tiers.essential || 0)}</div>
                    <div><span className="text-muted-foreground">Signature:</span> {formatCurrency(tiers.signature || 0)}</div>
                    <div><span className="text-muted-foreground">Legacy:</span> {formatCurrency(tiers.legacy || 0)}</div>
                    <div className="col-span-full pt-1">
                      <a href={api.getEstimatePdfUrl(it.id)} target="_blank" rel="noreferrer">
                        <Button size="sm" variant="outline" className="h-7 text-xs">
                          <FileText className="h-3 w-3 mr-1" /> View PDF
                        </Button>
                      </a>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      )}
    </Card>
  );
}
