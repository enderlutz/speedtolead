import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type SentLogEntry } from "@/lib/api";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  Search, FileText, MapPin, Ruler, ChevronDown, ChevronUp, ExternalLink,
  CheckCircle2, DollarSign, Clock, Eye, Plus, X, PhoneCall,
} from "lucide-react";

const AGE_LABELS: Record<string, string> = {
  brand_new: "Brand new",
  "1_6yr": "1-6 years",
  "6_15yr": "6-15 years",
  "15plus": "15+ years",
};

const DISCOUNT_REASONS = [
  "Military", "Referral", "Repeat Customer", "Negotiation", "Bundle", "Neighbor",
] as const;

function formatMins(mins: number | null): string {
  if (mins === null || mins === undefined) return "—";
  if (mins < 1) return "<1m";
  if (mins < 60) return `${Math.round(mins)}m`;
  if (mins < 1440) return `${(mins / 60).toFixed(1)}h`;
  return `${(mins / 1440).toFixed(1)}d`;
}

const ZONE_COLORS: Record<string, string> = {
  Base: "bg-green-100 text-green-800",
  Blue: "bg-blue-100 text-blue-800",
  Purple: "bg-purple-100 text-purple-800",
  Outside: "bg-red-100 text-red-800",
};

function getClosedPrice(e: SentLogEntry): number {
  if (e.closed_price != null) return e.closed_price;
  if (e.closed_tier && e.tiers) return e.tiers[e.closed_tier as keyof typeof e.tiers] || 0;
  return 0;
}

export default function SentLog() {
  const [entries, setEntries] = useState<SentLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadEntries = () => {
    api.getSentLog()
      .then(setEntries)
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadEntries(); }, []);

  const filtered = search
    ? entries.filter((e) => {
        const s = search.toLowerCase();
        return e.contact_name.toLowerCase().includes(s) || e.address.toLowerCase().includes(s) || e.contact_phone.includes(s);
      })
    : entries;

  const closedCount = entries.filter((e) => e.closed_tier).length;
  const totalRevenue = entries.reduce((sum, e) => {
    if (e.closed_tier) return sum + getClosedPrice(e);
    return sum;
  }, 0);

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Estimates Sent</h1>
          <p className="text-sm text-muted-foreground">{entries.length} sent &middot; {closedCount} closed</p>
        </div>
        {totalRevenue > 0 && (
          <div className="text-right shrink-0">
            <p className="text-xs text-muted-foreground">Closed Revenue</p>
            <p className="text-lg font-bold text-green-600">{formatCurrency(totalRevenue)}</p>
          </div>
        )}
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input placeholder="Search by name, phone, or address..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
      </div>

      {loading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <div key={i} className="h-24 bg-muted rounded-lg animate-pulse" />)}</div>
      ) : filtered.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-muted-foreground">{entries.length === 0 ? "No estimates sent yet" : "No matches found"}</CardContent></Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((entry) => (
            <SentLogCard key={entry.id} entry={entry} expanded={expandedId === entry.id}
              onToggle={() => setExpandedId(expandedId === entry.id ? null : entry.id)} onUpdate={loadEntries} />
          ))}
        </div>
      )}
    </div>
  );
}

interface DiscountRow {
  amount: string;
  type: "dollar" | "percent";
  reason: string;
  customReason: string;
}

function SentLogCard({ entry, expanded, onToggle, onUpdate }: {
  entry: SentLogEntry; expanded: boolean; onToggle: () => void; onUpdate: () => void;
}) {
  const [closing, setClosing] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [editing, setEditing] = useState(false);
  const [selectedTier, setSelectedTier] = useState<string | null>(entry.closed_tier || null);
  const [closedDate, setClosedDate] = useState(entry.closed_at ? entry.closed_at.slice(0, 10) : new Date().toISOString().slice(0, 10));
  const [closedPrice, setClosedPrice] = useState(entry.closed_price != null ? String(entry.closed_price) : "");
  const [actualSqft, setActualSqft] = useState(String(entry.closed_actual_sqft ?? (Number(entry.sqft) || 0)));
  const [upsellPerSqft, setUpsellPerSqft] = useState(entry.closed_upsell_per_sqft != null ? String(entry.closed_upsell_per_sqft) : "");
  const [discounts, setDiscounts] = useState<DiscountRow[]>(
    (entry.closed_discounts || []).map((d) => {
      const isPreset = (DISCOUNT_REASONS as readonly string[]).includes(d.reason);
      return { amount: String(d.amount), type: d.type, reason: isPreset ? d.reason : "Custom", customReason: isPreset ? "" : d.reason };
    })
  );
  const [upsellNotes, setUpsellNotes] = useState(entry.closed_upsell_notes || "");
  const [closeNotes, setCloseNotes] = useState(entry.closed_notes || "");

  const sqft = Number(entry.sqft) || 0;
  const linearFt = Number(entry.linear_feet) || 0;
  const height = Number(entry.height) || 0;
  const isClosed = !!entry.closed_tier;

  const handleTierSelect = (tier: string) => {
    setSelectedTier(tier);
    if (tier === "custom") {
      setClosedPrice("");
    } else {
      const price = entry.tiers?.[tier as keyof typeof entry.tiers] || 0;
      setClosedPrice(String(price));
    }
  };

  const addDiscount = () => {
    setDiscounts((prev) => [...prev, { amount: "", type: "dollar", reason: "", customReason: "" }]);
  };

  const updateDiscount = (i: number, field: keyof DiscountRow, value: string) => {
    setDiscounts((prev) => prev.map((d, idx) => idx === i ? { ...d, [field]: value } : d));
  };

  const removeDiscount = (i: number) => {
    setDiscounts((prev) => prev.filter((_, idx) => idx !== i));
  };

  const handleClose = async () => {
    if (!selectedTier) { toast.error("Select a package"); return; }
    const price = parseFloat(closedPrice);
    if (!price || price <= 0) { toast.error("Enter a valid price"); return; }
    setClosing(true);
    try {
      await api.closeEstimate(entry.id, {
        tier: selectedTier,
        closed_at: closedDate,
        closed_price: price,
        actual_sqft: actualSqft ? parseFloat(actualSqft) : undefined,
        upsell_per_sqft: upsellPerSqft ? parseFloat(upsellPerSqft) : undefined,
        discounts: discounts
          .filter((d) => d.amount && (d.reason || d.customReason))
          .map((d) => ({
            amount: parseFloat(d.amount),
            type: d.type,
            reason: d.reason === "Custom" ? d.customReason : d.reason,
          })),
        upsell_notes: upsellNotes || undefined,
        close_notes: closeNotes || undefined,
      });
      const label = selectedTier === "custom" ? "Custom" : selectedTier.charAt(0).toUpperCase() + selectedTier.slice(1);
      toast.success(`${editing ? "Updated" : "Closed"} — ${label} — ${formatCurrency(price)}`);
      setEditing(false);
      onUpdate();
    } catch { toast.error("Failed to save"); }
    finally { setClosing(false); }
  };

  const handleReopen = async () => {
    setReopening(true);
    try {
      await api.reopenEstimate(entry.id);
      toast.success("Deal reopened");
      setEditing(false);
      onUpdate();
    } catch { toast.error("Failed to reopen"); }
    finally { setReopening(false); }
  };

  const showForm = !isClosed || editing;

  return (
    <Card className={isClosed ? "border-green-200 bg-green-50/30" : ""}>
      <CardContent className="p-0">
        <button onClick={onToggle}
          className="w-full text-left px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 hover:bg-muted/30 transition-colors">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {isClosed && <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />}
              <span className="text-sm font-semibold">{entry.contact_name || "Unknown"}</span>
              <Badge variant="outline" className="text-[10px]">{entry.location_label}</Badge>
              <Badge className={`text-[10px] ${ZONE_COLORS[entry.zone] || ""}`}>{entry.zone}</Badge>
              {isClosed && (
                <Badge className="text-[10px] bg-green-100 text-green-800 capitalize">{entry.closed_tier}</Badge>
              )}
              {entry.precall_done ? (
                <Badge className="text-[10px] bg-amber-100 text-amber-800"><PhoneCall className="h-2.5 w-2.5 mr-0.5 inline" />Pre-call</Badge>
              ) : (
                <Badge variant="outline" className="text-[10px] text-muted-foreground">No pre-call</Badge>
              )}
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1 flex-wrap">
              <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{entry.address || "No address"}</span>
              <span className="flex items-center gap-1"><Ruler className="h-3 w-3" />{sqft.toLocaleString()} sqft</span>
              {entry.precall_done && entry.time_to_call_minutes != null && (
                <span className="flex items-center gap-1"><PhoneCall className="h-3 w-3" />Called in {formatMins(entry.time_to_call_minutes)}</span>
              )}
              <span className="flex items-center gap-1"><Clock className="h-3 w-3" />Sent in {formatMins(entry.time_to_send_minutes)}</span>
              <span className="flex items-center gap-1"><Eye className="h-3 w-3" />{entry.proposal_viewed ? `Viewed in ${formatMins(entry.time_to_view_minutes)}` : "Not viewed"}</span>
            </div>
          </div>

          <div className="flex items-center gap-3 text-xs shrink-0">
            {isClosed ? (
              <div className="text-center">
                <p className="text-green-600 font-medium capitalize">{entry.closed_tier}</p>
                <p className="font-bold text-green-700 text-base">{formatCurrency(getClosedPrice(entry))}</p>
              </div>
            ) : (
              <>
                <div className="text-center"><p className="text-muted-foreground">Ess.</p><p className="font-bold">{formatCurrency(entry.tiers?.essential || 0)}</p></div>
                <div className="text-center"><p className="text-primary font-medium">Sig.</p><p className="font-bold text-primary">{formatCurrency(entry.tiers?.signature || 0)}</p></div>
                <div className="text-center"><p className="text-muted-foreground">Leg.</p><p className="font-bold">{formatCurrency(entry.tiers?.legacy || 0)}</p></div>
              </>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-muted-foreground hidden sm:inline">{formatDateTime(entry.sent_at)}</span>
            {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </div>
        </button>

        {expanded && (
          <div className="border-t px-4 py-3 space-y-4 bg-muted/10">
            {/* Close Deal Form */}
            {showForm && (
              <div className="rounded-lg border-2 border-dashed border-green-300 bg-green-50/50 p-4 space-y-4">
                <h4 className="text-xs font-semibold text-green-800 uppercase tracking-wider flex items-center gap-1.5">
                  <DollarSign className="h-3.5 w-3.5" /> {editing ? "Edit Close Details" : "Close This Deal"}
                </h4>

                {/* 1. Package selection */}
                <div>
                  <label className="text-[10px] font-medium text-muted-foreground mb-1.5 block uppercase tracking-wider">1. Select Package</label>
                  <div className="grid grid-cols-4 gap-2">
                    {(["essential", "signature", "legacy"] as const).map((tier) => {
                      const price = entry.tiers?.[tier] || 0;
                      const isSelected = selectedTier === tier;
                      return (
                        <button key={tier} onClick={() => handleTierSelect(tier)}
                          className={`rounded-lg border-2 p-2.5 text-center transition-all ${
                            isSelected ? "border-green-500 bg-green-100 ring-1 ring-green-300" : "border-gray-200 hover:border-green-300"
                          }`}>
                          <p className="text-[10px] font-medium capitalize text-muted-foreground">{tier}</p>
                          <p className="text-sm font-bold">{formatCurrency(price)}</p>
                        </button>
                      );
                    })}
                    <button onClick={() => handleTierSelect("custom")}
                      className={`rounded-lg border-2 p-2.5 text-center transition-all ${
                        selectedTier === "custom" ? "border-green-500 bg-green-100 ring-1 ring-green-300" : "border-gray-200 hover:border-green-300 border-dashed"
                      }`}>
                      <p className="text-[10px] font-medium text-muted-foreground">Custom</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Type price</p>
                    </button>
                  </div>
                </div>

                {/* 2. Final Price */}
                <div>
                  <label className="text-[10px] font-medium text-muted-foreground mb-1.5 block uppercase tracking-wider">2. Final Closed Price</label>
                  <div className="relative max-w-[200px]">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                    <Input type="number" step="0.01" min="0" value={closedPrice}
                      onChange={(e) => setClosedPrice(e.target.value)}
                      placeholder="0.00" className="h-8 text-sm pl-7" />
                  </div>
                </div>

                {/* 3. Actual Sqft & Upsell */}
                <div>
                  <label className="text-[10px] font-medium text-muted-foreground mb-1.5 block uppercase tracking-wider">3. Actual Sqft & Upsell</label>
                  <div className="grid grid-cols-2 gap-3 max-w-sm">
                    <div>
                      <label className="text-[10px] text-muted-foreground mb-0.5 block">Actual Sqft</label>
                      <Input type="number" min="0" value={actualSqft}
                        onChange={(e) => setActualSqft(e.target.value)} className="h-8 text-sm" />
                    </div>
                    <div>
                      <label className="text-[10px] text-muted-foreground mb-0.5 block">Upsell $/sqft</label>
                      <Input type="number" step="0.01" min="0" value={upsellPerSqft}
                        onChange={(e) => setUpsellPerSqft(e.target.value)}
                        placeholder="0.00" className="h-8 text-sm" />
                    </div>
                  </div>
                </div>

                {/* 4. Discounts */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">4. Discounts</label>
                    <Button variant="outline" size="sm" onClick={addDiscount} className="h-6 text-[10px] px-2">
                      <Plus className="h-3 w-3 mr-0.5" /> Add
                    </Button>
                  </div>
                  {discounts.length === 0 && (
                    <p className="text-xs text-muted-foreground">No discounts applied</p>
                  )}
                  <div className="space-y-2">
                    {discounts.map((d, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <div className="relative w-20">
                          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
                            {d.type === "dollar" ? "$" : "%"}
                          </span>
                          <Input type="number" step="0.01" min="0" value={d.amount}
                            onChange={(e) => updateDiscount(i, "amount", e.target.value)}
                            className="h-7 text-xs pl-5" />
                        </div>
                        <div className="flex rounded-md border overflow-hidden h-7">
                          <button onClick={() => updateDiscount(i, "type", "dollar")}
                            className={`px-2 text-[10px] font-medium transition-colors ${d.type === "dollar" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}>
                            $
                          </button>
                          <button onClick={() => updateDiscount(i, "type", "percent")}
                            className={`px-2 text-[10px] font-medium transition-colors ${d.type === "percent" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}>
                            %
                          </button>
                        </div>
                        <select value={d.reason}
                          onChange={(e) => updateDiscount(i, "reason", e.target.value)}
                          className="h-7 text-xs border rounded-md px-2 bg-background flex-1 min-w-0">
                          <option value="">Select reason...</option>
                          {DISCOUNT_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                          <option value="Custom">Custom...</option>
                        </select>
                        {d.reason === "Custom" && (
                          <Input value={d.customReason}
                            onChange={(e) => updateDiscount(i, "customReason", e.target.value)}
                            placeholder="Reason" className="h-7 text-xs flex-1 min-w-0" />
                        )}
                        <button onClick={() => removeDiscount(i)} className="text-red-400 hover:text-red-600 shrink-0">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 5. Notes */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground mb-0.5 block">Upsell Notes</label>
                    <textarea value={upsellNotes} onChange={(e) => setUpsellNotes(e.target.value)}
                      placeholder="What was upsold?"
                      className="w-full border rounded-md px-3 py-1.5 text-xs bg-background resize-none h-16" />
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground mb-0.5 block">Close Notes</label>
                    <textarea value={closeNotes} onChange={(e) => setCloseNotes(e.target.value)}
                      placeholder="General notes..."
                      className="w-full border rounded-md px-3 py-1.5 text-xs bg-background resize-none h-16" />
                  </div>
                </div>

                {/* Footer: date + buttons */}
                <div className="flex items-end gap-3 pt-1">
                  <div className="flex-1 max-w-[180px]">
                    <label className="text-[10px] font-medium text-muted-foreground mb-0.5 block">Close Date</label>
                    <Input type="date" value={closedDate} onChange={(e) => setClosedDate(e.target.value)} className="h-8 text-sm" />
                  </div>
                  <div className="flex gap-2">
                    {editing && (
                      <Button variant="outline" onClick={() => setEditing(false)} className="h-8 text-sm">
                        Cancel
                      </Button>
                    )}
                    <Button onClick={handleClose} disabled={closing || !selectedTier || !closedPrice}
                      className="bg-green-600 hover:bg-green-700 text-white h-8">
                      <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                      {closing ? "Saving..." : editing ? "Save Changes" : "Close Deal"}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* Closed Deal Info */}
            {isClosed && !editing && entry.closed_at && (
              <div className="rounded-lg bg-green-50 border border-green-200 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    <span className="text-sm font-medium text-green-800">
                      Closed with <span className="capitalize">{entry.closed_tier}</span> — {formatCurrency(getClosedPrice(entry))}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-green-600">{formatDateTime(entry.closed_at)}</span>
                    <Button variant="outline" size="sm" onClick={() => setEditing(true)} className="h-6 text-[10px] px-2">
                      Edit
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleReopen} disabled={reopening}
                      className="h-6 text-[10px] px-2 text-red-600 hover:text-red-700 hover:bg-red-50">
                      {reopening ? "..." : "Reopen"}
                    </Button>
                  </div>
                </div>
                {/* Extra close details */}
                {(entry.closed_actual_sqft || entry.closed_upsell_per_sqft || (entry.closed_discounts && entry.closed_discounts.length > 0) || entry.closed_upsell_notes || entry.closed_notes) && (
                  <div className="text-xs text-green-700 space-y-0.5 pl-6">
                    {(entry.closed_actual_sqft != null || entry.closed_upsell_per_sqft != null) && (
                      <p>
                        {entry.closed_actual_sqft != null && <span>Actual: {entry.closed_actual_sqft.toLocaleString()} sqft</span>}
                        {entry.closed_actual_sqft != null && entry.closed_upsell_per_sqft != null && <span> | </span>}
                        {entry.closed_upsell_per_sqft != null && <span>Upsell: ${entry.closed_upsell_per_sqft}/sqft</span>}
                      </p>
                    )}
                    {entry.closed_discounts && entry.closed_discounts.length > 0 && (
                      <p>Discounts: {entry.closed_discounts.map((d, i) => (
                        <span key={i}>
                          {i > 0 && ", "}
                          {d.type === "dollar" ? `$${d.amount}` : `${d.amount}%`} {d.reason}
                        </span>
                      ))}</p>
                    )}
                    {entry.closed_upsell_notes && <p>Upsell: {entry.closed_upsell_notes}</p>}
                    {entry.closed_notes && <p>Notes: {entry.closed_notes}</p>}
                  </div>
                )}
              </div>
            )}

            {/* Pricing inputs */}
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Pricing Inputs</h4>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div><p className="text-xs text-muted-foreground">Linear Feet</p><p className="font-medium">{linearFt || "—"}</p></div>
                <div><p className="text-xs text-muted-foreground">Fence Height</p><p className="font-medium">{entry.fence_height || "—"} ({height}ft)</p></div>
                <div><p className="text-xs text-muted-foreground">Square Footage</p><p className="font-bold text-base">{sqft.toLocaleString()} sqft</p></div>
                <div><p className="text-xs text-muted-foreground">Fence Age</p><p className="font-medium">{AGE_LABELS[entry.age_bracket] || entry.fence_age || "—"}</p></div>
              </div>
            </div>

            {/* Pricing logic */}
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Pricing Logic</h4>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div><p className="text-xs text-muted-foreground">Zone</p><Badge className={`text-xs ${ZONE_COLORS[entry.zone] || ""}`}>{entry.zone}</Badge></div>
                <div><p className="text-xs text-muted-foreground">Zone Surcharge</p><p className="font-medium">{entry.zone_surcharge ? `+$${entry.zone_surcharge}/sqft` : "None"}</p></div>
                <div><p className="text-xs text-muted-foreground">Size Surcharge</p><p className="font-medium">{entry.size_surcharge_applied ? "+$0.12/sqft" : "None"}</p></div>
                <div><p className="text-xs text-muted-foreground">ZIP Code</p><p className="font-medium">{entry.zip_code || "—"}</p></div>
              </div>
            </div>

            {/* Breakdown */}
            {entry.breakdown && entry.breakdown.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Cost Breakdown</h4>
                <div className="rounded-md border overflow-hidden">
                  {entry.breakdown.map((item, i) => (
                    <div key={i} className={`flex justify-between px-3 py-2 text-sm ${i % 2 === 0 ? "bg-muted/20" : ""}`}>
                      <div>
                        <span>{item.label}</span>
                        {item.note && <span className="text-xs text-muted-foreground ml-2">({item.note})</span>}
                      </div>
                      <span className="font-medium">{formatCurrency(item.value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* All 3 tiers */}
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">All Packages</h4>
              <div className="grid grid-cols-3 gap-2">
                {(["essential", "signature", "legacy"] as const).map((tier) => {
                  const price = entry.tiers?.[tier] || 0;
                  const monthly = Math.round(price / 21);
                  const isWon = entry.closed_tier === tier;
                  return (
                    <div key={tier} className={`rounded-md border p-3 text-center ${
                      isWon ? "bg-green-50 border-green-300 ring-1 ring-green-200" : tier === "signature" ? "bg-primary/5 border-primary/20" : "bg-muted/20"
                    }`}>
                      <p className="text-xs font-medium capitalize">{tier} {isWon && "✓"}</p>
                      <p className="text-lg font-bold">{formatCurrency(price)}</p>
                      <p className="text-xs text-muted-foreground">~${monthly}/mo</p>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Footer actions */}
            <div className="flex items-center justify-between pt-2 border-t">
              <span className="text-xs text-muted-foreground">Sent {formatDateTime(entry.sent_at)}</span>
              <div className="flex gap-2">
                <a href={`/api/estimates/${entry.id}/pdf`} target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm"><FileText className="h-3.5 w-3.5 mr-1" /> PDF</Button>
                </a>
                <Link to={`/leads/${entry.lead_id}`}>
                  <Button variant="outline" size="sm"><ExternalLink className="h-3.5 w-3.5 mr-1" /> Lead</Button>
                </Link>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
