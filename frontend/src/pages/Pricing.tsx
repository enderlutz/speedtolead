import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Save, Plus, X, DollarSign, Ruler, Search } from "lucide-react";

interface TierRates {
  essential: number;
  signature: number;
  legacy: number;
}

interface PricingConfig {
  tier_rates: Record<string, TierRates | null>;
  zones: { base: string[]; blue: string[]; purple: string[] };
  zone_surcharges: Record<string, number>;
  /** "Up to N sq ft adds R per sq ft"; over the last tier adds nothing. */
  size_tiers: { up_to: number; rate: number }[];
  /** The least a job can come to (Essential). */
  min_job_price: number;
}

const AGE_LABELS: Record<string, string> = {
  brand_new: "0-5 mo (Brand New)",
  "1_6yr": "1-6 Years",
  "6_15yr": "6-15 Years",
  "15plus": "15+ Years (Manual Review)",
};

const ZONE_META: { key: "base" | "blue" | "purple"; label: string; desc: string; driveTime: string; dotCls: string; bgCls: string; chipCls: string; surchargeKey: string }[] = [
  { key: "base", label: "Base Zone", desc: "Home base area — Cypress and surrounding. No surcharge applied.", driveTime: "0-30 min drive", dotCls: "bg-green-500", bgCls: "from-green-800 to-green-700", chipCls: "bg-green-700 text-green-100", surchargeKey: "Base" },
  { key: "blue", label: "Blue Zone", desc: "Extended service area — includes The Woodlands, Katy, Memorial area.", driveTime: "30-45 min drive", dotCls: "bg-blue-500", bgCls: "from-blue-800 to-blue-700", chipCls: "bg-blue-700 text-blue-100", surchargeKey: "Blue" },
  { key: "purple", label: "Purple Zone", desc: "Outer service area — Sugar Land, Conroe, inner Houston, Humble/Kingwood.", driveTime: "45-75 min drive", dotCls: "bg-purple-500", bgCls: "from-purple-800 to-purple-700", chipCls: "bg-purple-700 text-purple-100", surchargeKey: "Purple" },
];

export default function Pricing() {
  const [config, setConfig] = useState<PricingConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newZip, setNewZip] = useState({ base: "", blue: "", purple: "" });
  const [zipSearch, setZipSearch] = useState("");

  useEffect(() => {
    api.getPricing()
      .then((data) => setConfig((data as unknown as { config: PricingConfig }).config))
      .catch(() => toast.error("Failed to load pricing"))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      await api.updatePricing("fence_staining", config as unknown as Record<string, unknown>);
      toast.success("Pricing saved");
    } catch { toast.error("Failed to save"); }
    finally { setSaving(false); }
  };

  const updateRate = (bracket: string, tier: string, value: string) => {
    if (!config) return;
    const rates = { ...config.tier_rates };
    if (!rates[bracket]) return;
    rates[bracket] = { ...rates[bracket]!, [tier]: parseFloat(value) || 0 };
    setConfig({ ...config, tier_rates: rates });
  };

  const addZip = (zone: "base" | "blue" | "purple") => {
    if (!config || !newZip[zone].trim()) return;
    const zip = newZip[zone].trim();
    if (zip.length !== 5 || !/^\d{5}$/.test(zip)) { toast.error("ZIP must be 5 digits"); return; }
    const zones = { ...config.zones };
    // Remove from other zones first
    zones.base = zones.base.filter((z) => z !== zip);
    zones.blue = zones.blue.filter((z) => z !== zip);
    zones.purple = zones.purple.filter((z) => z !== zip);
    zones[zone] = [...zones[zone], zip].sort();
    setConfig({ ...config, zones });
    setNewZip({ ...newZip, [zone]: "" });
  };

  const removeZip = (zone: "base" | "blue" | "purple", zip: string) => {
    if (!config) return;
    const zones = { ...config.zones };
    zones[zone] = zones[zone].filter((z) => z !== zip);
    setConfig({ ...config, zones });
  };

  const totalZips = config ? config.zones.base.length + config.zones.blue.length + config.zones.purple.length : 0;

  if (loading || !config) {
    return (
      <div className="p-4 sm:p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 bg-muted rounded" />
          <div className="h-64 bg-muted rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg sm:text-2xl font-semibold tracking-tight">Pricing</h1>
          <p className="text-xs text-muted-foreground">Fence staining rates, zones, and surcharges</p>
        </div>
        <Button onClick={handleSave} disabled={saving}>
          <Save className="h-4 w-4 mr-2" />
          {saving ? "Saving..." : "Save Changes"}
        </Button>
      </div>

      {/* Tier Rates */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <DollarSign className="h-4 w-4" /> Prices Based on Age (per sqft)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="text-left py-2 pr-4 font-medium">Age Bracket</th>
                  <th className="text-center py-2 px-3 font-medium">Essential ($/sqft)</th>
                  <th className="text-center py-2 px-3 font-medium">Signature ($/sqft)</th>
                  <th className="text-center py-2 px-3 font-medium">Legacy ($/sqft)</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(config.tier_rates).map(([bracket, rates]) => (
                  <tr key={bracket} className="border-b last:border-0">
                    <td className="py-3 pr-4 text-sm font-medium">{AGE_LABELS[bracket] || bracket}</td>
                    {rates ? (
                      <>
                        {(["essential", "signature", "legacy"] as const).map((tier) => (
                          <td key={tier} className="py-3 px-3">
                            <div className="flex items-center justify-center gap-1">
                              <span className="text-muted-foreground text-xs">$</span>
                              <Input type="number" step="0.01" value={rates[tier]}
                                onChange={(e) => updateRate(bracket, tier, e.target.value)}
                                className="h-8 text-xs text-center w-20" />
                            </div>
                          </td>
                        ))}
                      </>
                    ) : (
                      <td colSpan={3} className="py-3 text-center text-xs text-red-500 font-medium">Requires Alan's Approval</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Zone Stats Bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl bg-green-800 p-4 text-center text-white">
          <p className="text-2xl font-bold">{config.zones.base.length}</p>
          <p className="text-[10px] uppercase tracking-widest opacity-80">Base Zone</p>
        </div>
        <div className="rounded-xl bg-blue-800 p-4 text-center text-white">
          <p className="text-2xl font-bold">{config.zones.blue.length}</p>
          <p className="text-[10px] uppercase tracking-widest opacity-80">Blue Zone</p>
        </div>
        <div className="rounded-xl bg-purple-800 p-4 text-center text-white">
          <p className="text-2xl font-bold">{config.zones.purple.length}</p>
          <p className="text-[10px] uppercase tracking-widest opacity-80">Purple Zone</p>
        </div>
        <div className="rounded-xl bg-gray-700 p-4 text-center text-white">
          <p className="text-2xl font-bold">{totalZips}</p>
          <p className="text-[10px] uppercase tracking-widest opacity-80">Total Mapped</p>
        </div>
      </div>

      {/* ZIP Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search zip code (e.g. 77429)..."
          value={zipSearch}
          onChange={(e) => setZipSearch(e.target.value)}
          className="pl-9 h-9 font-mono"
        />
      </div>

      {/* Zone ZIP Codes */}
      {ZONE_META.map((zone) => {
        const zips = config.zones[zone.key];
        const surcharge = config.zone_surcharges[zone.surchargeKey] || 0;
        const filtered = zipSearch ? zips.filter((z) => z.includes(zipSearch)) : zips;

        return (
          <Card key={zone.key} className="overflow-hidden border-0">
            <div className={`bg-gradient-to-r ${zone.bgCls} px-5 py-3.5 flex items-center justify-between`}>
              <div className="flex items-center gap-3">
                <span className={`h-3.5 w-3.5 rounded-full ${zone.dotCls} ring-2 ring-white/30`} />
                <h3 className="text-white font-bold text-sm">{zone.label}</h3>
              </div>
              <div className="flex items-center gap-3 text-white/80 text-xs">
                <span>+${surcharge.toFixed(2)}/sqft &middot; {zone.driveTime}</span>
                <span className="bg-white/15 px-2.5 py-0.5 rounded-full font-medium">{zips.length} zips</span>
              </div>
            </div>
            <CardContent className="pt-4 pb-4">
              <div className="flex flex-wrap gap-2 mb-3">
                {filtered.map((zip) => (
                  <span key={zip} className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-mono font-semibold ${zone.chipCls} ${
                    zipSearch && zip.includes(zipSearch) ? "ring-2 ring-yellow-400 scale-105" : ""
                  }`}>
                    {zip}
                    <button onClick={() => removeZip(zone.key, zip)} className="hover:text-red-300 ml-0.5 opacity-60 hover:opacity-100">
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                {filtered.length === 0 && <p className="text-xs text-muted-foreground">No matching zips</p>}
              </div>
              <div className="flex gap-2 items-center">
                <Input
                  placeholder="Add ZIP..."
                  value={newZip[zone.key]}
                  onChange={(e) => setNewZip({ ...newZip, [zone.key]: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && addZip(zone.key)}
                  className="h-7 text-xs w-28 font-mono"
                  maxLength={5}
                />
                <Button variant="outline" size="sm" onClick={() => addZip(zone.key)}>
                  <Plus className="h-3 w-3 mr-1" /> Add
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground mt-2">{zone.desc}</p>
            </CardContent>
          </Card>
        );
      })}

      {/* Outside Zone Info */}
      <Card className="overflow-hidden border-0">
        <div className="bg-gradient-to-r from-red-800 to-red-700 px-5 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="h-3.5 w-3.5 rounded-full bg-red-500 ring-2 ring-white/30" />
            <h3 className="text-white font-bold text-sm">Outside Zone</h3>
          </div>
          <span className="text-white/80 text-xs">Requires Alan's approval</span>
        </div>
        <CardContent className="pt-3 pb-3">
          <p className="text-xs text-muted-foreground">Any zip code not in Base, Blue, or Purple requires manual review and approval.</p>
        </CardContent>
      </Card>

      {/* Size surcharge (Alan, 2026-10-16): steps down as the fence grows,
          plus a minimum job. A bigger fence is never quoted less than a
          smaller one; the engine eases the add-on off at each step. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Ruler className="h-4 w-4" /> Size Surcharge
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Small fences cost the same to set up, wash and drive to, so they pay a bit more per sq ft. Added on top of the package rate.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {(config.size_tiers || []).map((t, i) => {
              const from = i === 0 ? 0 : config.size_tiers[i - 1].up_to;
              const set = (patch: Partial<{ up_to: number; rate: number }>) =>
                setConfig({ ...config, size_tiers: config.size_tiers.map((x, k) => (k === i ? { ...x, ...patch } : x)) });
              return (
                <div key={i} className="rounded-lg border p-3 space-y-2">
                  <div className="text-xs font-semibold">{from === 0 ? "Under" : `${from.toLocaleString()} to`} {t.up_to.toLocaleString()} sq ft</div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-muted-foreground w-16" htmlFor={`tier-rate-${i}`}>+$/sq ft</label>
                    <Input id={`tier-rate-${i}`} type="number" step="0.01" value={t.rate}
                      onChange={(e) => set({ rate: parseFloat(e.target.value) || 0 })} className="h-8 text-sm" />
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-muted-foreground w-16" htmlFor={`tier-upto-${i}`}>Up to</label>
                    <Input id={`tier-upto-${i}`} type="number" step="50" value={t.up_to}
                      onChange={(e) => set({ up_to: parseInt(e.target.value) || 0 })} className="h-8 text-sm" />
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            Over {(config.size_tiers?.[config.size_tiers.length - 1]?.up_to || 0).toLocaleString()} sq ft: no surcharge.
          </p>
          <div className="flex items-center gap-2 max-w-xs">
            <label className="text-xs font-medium text-muted-foreground whitespace-nowrap" htmlFor="min-job">Minimum job ($)</label>
            <Input id="min-job" type="number" step="25" value={config.min_job_price}
              onChange={(e) => setConfig({ ...config, min_job_price: parseFloat(e.target.value) || 0 })} className="h-8 text-sm" />
          </div>
          <p className="text-xs text-muted-foreground">Essential never comes in under this; Signature and Legacy keep their gap above it.</p>
        </CardContent>
      </Card>
    </div>
  );
}
