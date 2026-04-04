import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type SentLogEntry } from "@/lib/api";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Search, FileText, MapPin, Ruler, ChevronDown, ChevronUp, ExternalLink,
} from "lucide-react";

const AGE_LABELS: Record<string, string> = {
  brand_new: "Brand new",
  "1_6yr": "1-6 years",
  "6_15yr": "6-15 years",
  "15plus": "15+ years",
};

const ZONE_COLORS: Record<string, string> = {
  Base: "bg-green-100 text-green-800",
  Blue: "bg-blue-100 text-blue-800",
  Purple: "bg-purple-100 text-purple-800",
  Outside: "bg-red-100 text-red-800",
};

export default function SentLog() {
  const [entries, setEntries] = useState<SentLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    api.getSentLog()
      .then(setEntries)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const filtered = search
    ? entries.filter((e) => {
        const s = search.toLowerCase();
        return (
          e.contact_name.toLowerCase().includes(s) ||
          e.address.toLowerCase().includes(s) ||
          e.contact_phone.includes(s)
        );
      })
    : entries;

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Estimates Sent Log</h1>
        <p className="text-sm text-muted-foreground">{entries.length} estimates sent</p>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by name, phone, or address..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 bg-muted rounded-lg animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            {entries.length === 0 ? "No estimates sent yet" : "No matches found"}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((entry) => (
            <SentLogCard
              key={entry.id}
              entry={entry}
              expanded={expandedId === entry.id}
              onToggle={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SentLogCard({
  entry,
  expanded,
  onToggle,
}: {
  entry: SentLogEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const sqft = Number(entry.sqft) || 0;
  const linearFt = Number(entry.linear_feet) || 0;
  const height = Number(entry.height) || 0;

  return (
    <Card>
      <CardContent className="p-0">
        {/* Summary row — always visible */}
        <button
          onClick={onToggle}
          className="w-full text-left px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 hover:bg-muted/30 transition-colors"
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold">{entry.contact_name || "Unknown"}</span>
              <Badge variant="outline" className="text-[10px]">{entry.location_label}</Badge>
              <Badge className={`text-[10px] ${ZONE_COLORS[entry.zone] || ""}`}>{entry.zone} zone</Badge>
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1 flex-wrap">
              <span className="flex items-center gap-1">
                <MapPin className="h-3 w-3" />{entry.address || "No address"}
              </span>
              <span className="flex items-center gap-1">
                <Ruler className="h-3 w-3" />{sqft.toLocaleString()} sqft
              </span>
            </div>
          </div>

          {/* Tier prices — compact */}
          <div className="flex items-center gap-3 text-xs shrink-0">
            <div className="text-center">
              <p className="text-muted-foreground">Essential</p>
              <p className="font-bold">{formatCurrency(entry.tiers?.essential || 0)}</p>
            </div>
            <div className="text-center">
              <p className="text-primary font-medium">Signature</p>
              <p className="font-bold text-primary">{formatCurrency(entry.tiers?.signature || 0)}</p>
            </div>
            <div className="text-center">
              <p className="text-muted-foreground">Legacy</p>
              <p className="font-bold">{formatCurrency(entry.tiers?.legacy || 0)}</p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-muted-foreground hidden sm:inline">{formatDateTime(entry.sent_at)}</span>
            {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </div>
        </button>

        {/* Expanded: full pricing logic */}
        {expanded && (
          <div className="border-t px-4 py-3 space-y-4 bg-muted/10">
            {/* Pricing inputs */}
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Pricing Inputs</h4>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Linear Feet</p>
                  <p className="font-medium">{linearFt || "—"}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Fence Height</p>
                  <p className="font-medium">{entry.fence_height || "—"} ({height}ft)</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Square Footage</p>
                  <p className="font-bold text-base">{sqft.toLocaleString()} sqft</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Fence Age</p>
                  <p className="font-medium">{AGE_LABELS[entry.age_bracket] || entry.fence_age || "—"}</p>
                </div>
              </div>
            </div>

            {/* Pricing logic */}
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Pricing Logic</h4>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Zone</p>
                  <Badge className={`text-xs ${ZONE_COLORS[entry.zone] || ""}`}>{entry.zone}</Badge>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Zone Surcharge</p>
                  <p className="font-medium">{entry.zone_surcharge ? `+$${entry.zone_surcharge}/sqft` : "None"}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Size Surcharge</p>
                  <p className="font-medium">{entry.size_surcharge_applied ? "+$0.12/sqft" : "None"}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">ZIP Code</p>
                  <p className="font-medium">{entry.zip_code || "—"}</p>
                </div>
              </div>
            </div>

            {/* Breakdown */}
            {entry.breakdown && entry.breakdown.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Cost Breakdown (Signature)</h4>
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
                  <div className="flex justify-between px-3 py-2 text-sm font-bold border-t bg-muted/30">
                    <span>Total (Signature)</span>
                    <span>{formatCurrency(entry.tiers?.signature || 0)}</span>
                  </div>
                </div>
              </div>
            )}

            {/* All 3 tiers with monthly */}
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">All Packages</h4>
              <div className="grid grid-cols-3 gap-2">
                {(["essential", "signature", "legacy"] as const).map((tier) => {
                  const price = entry.tiers?.[tier] || 0;
                  const monthly = Math.round(price / 21);
                  return (
                    <div
                      key={tier}
                      className={`rounded-md border p-3 text-center ${
                        tier === "signature" ? "bg-primary/5 border-primary/20" : "bg-muted/20"
                      }`}
                    >
                      <p className="text-xs font-medium capitalize">{tier}</p>
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
                <Button variant="outline" size="sm" asChild>
                  <a href={`/api/estimates/${entry.id}/pdf`} target="_blank" rel="noopener noreferrer">
                    <FileText className="h-3.5 w-3.5 mr-1" /> PDF
                  </a>
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <Link to={`/leads/${entry.lead_id}`}>
                    <ExternalLink className="h-3.5 w-3.5 mr-1" /> Lead
                  </Link>
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
