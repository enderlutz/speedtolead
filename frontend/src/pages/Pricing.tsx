import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Save, Plus, X, DollarSign, MapPin, Ruler } from "lucide-react";

interface TierRates {
  essential: number;
  signature: number;
  legacy: number;
}

interface PricingConfig {
  tier_rates: Record<string, TierRates | null>;
  zones: { base: string[]; blue: string[]; purple: string[] };
  zone_surcharges: Record<string, number>;
  surcharge: { rate: number; min_sqft: number; max_sqft: number };
}

const AGE_LABELS: Record<string, string> = {
  brand_new: "Brand New (<6 months)",
  "1_6yr": "1-6 Years",
  "6_15yr": "6-15 Years",
  "15plus": "15+ Years (Manual Review)",
};

export default function Pricing() {
  const [config, setConfig] = useState<PricingConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newZip, setNewZip] = useState({ base: "", blue: "", purple: "" });

  useEffect(() => {
    api.getPricing()
      .then((data) => {
        const cfg = (data as unknown as { config: PricingConfig }).config;
        setConfig(cfg);
      })
      .catch(() => toast.error("Failed to load pricing"))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      await api.updatePricing("fence_staining", config as unknown as Record<string, unknown>);
      toast.success("Pricing saved");
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
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
    if (zip.length !== 5) { toast.error("ZIP must be 5 digits"); return; }
    const zones = { ...config.zones };
    if (zones[zone].includes(zip)) { toast.error("ZIP already in this zone"); return; }
    // Remove from other zones
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
    <div className="p-4 sm:p-6 space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg sm:text-2xl font-semibold tracking-tight">Pricing</h1>
          <p className="text-xs text-muted-foreground">Configure fence staining rates, zones, and surcharges</p>
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
            <DollarSign className="h-4 w-4" /> Tier Rates (per sqft)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="text-left py-2 pr-4 font-medium">Age Bracket</th>
                  <th className="text-center py-2 px-2 font-medium">Essential</th>
                  <th className="text-center py-2 px-2 font-medium">Signature</th>
                  <th className="text-center py-2 px-2 font-medium">Legacy</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(config.tier_rates).map(([bracket, rates]) => (
                  <tr key={bracket} className="border-b">
                    <td className="py-2 pr-4 text-sm font-medium">{AGE_LABELS[bracket] || bracket}</td>
                    {rates ? (
                      <>
                        <td className="py-2 px-2">
                          <Input type="number" step="0.01" value={rates.essential}
                            onChange={(e) => updateRate(bracket, "essential", e.target.value)}
                            className="h-8 text-xs text-center w-20 mx-auto" />
                        </td>
                        <td className="py-2 px-2">
                          <Input type="number" step="0.01" value={rates.signature}
                            onChange={(e) => updateRate(bracket, "signature", e.target.value)}
                            className="h-8 text-xs text-center w-20 mx-auto" />
                        </td>
                        <td className="py-2 px-2">
                          <Input type="number" step="0.01" value={rates.legacy}
                            onChange={(e) => updateRate(bracket, "legacy", e.target.value)}
                            className="h-8 text-xs text-center w-20 mx-auto" />
                        </td>
                      </>
                    ) : (
                      <td colSpan={3} className="py-2 text-center text-xs text-muted-foreground">Manual review required</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Zone ZIP Codes */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <MapPin className="h-4 w-4" /> Zone ZIP Codes
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {(["base", "blue", "purple"] as const).map((zone) => {
            const surcharge = config.zone_surcharges[zone.charAt(0).toUpperCase() + zone.slice(1)] || 0;
            return (
              <div key={zone}>
                <div className="flex items-center gap-2 mb-2">
                  <span className={`h-3 w-3 rounded-full ${
                    zone === "base" ? "bg-green-500" : zone === "blue" ? "bg-blue-500" : "bg-purple-500"
                  }`} />
                  <span className="text-sm font-medium capitalize">{zone} Zone</span>
                  <span className="text-xs text-muted-foreground">
                    ({surcharge > 0 ? `+$${surcharge}/sqft surcharge` : "No surcharge"})
                  </span>
                  <span className="text-xs text-muted-foreground ml-auto">{config.zones[zone].length} zips</span>
                </div>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {config.zones[zone].map((zip) => (
                    <span key={zip} className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-xs bg-muted font-mono">
                      {zip}
                      <button onClick={() => removeZip(zone, zip)} className="hover:text-red-500 ml-0.5">
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-1.5">
                  <Input
                    placeholder="Add ZIP..."
                    value={newZip[zone]}
                    onChange={(e) => setNewZip({ ...newZip, [zone]: e.target.value })}
                    onKeyDown={(e) => e.key === "Enter" && addZip(zone)}
                    className="h-7 text-xs w-28 font-mono"
                    maxLength={5}
                  />
                  <Button variant="outline" size="sm" onClick={() => addZip(zone)}>
                    <Plus className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Size Surcharge */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Ruler className="h-4 w-4" /> Size Surcharge
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Rate ($/sqft)</label>
              <Input
                type="number" step="0.01"
                value={config.surcharge.rate}
                onChange={(e) => setConfig({ ...config, surcharge: { ...config.surcharge, rate: parseFloat(e.target.value) || 0 } })}
                className="h-8 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Min Sqft</label>
              <Input
                type="number"
                value={config.surcharge.min_sqft}
                onChange={(e) => setConfig({ ...config, surcharge: { ...config.surcharge, min_sqft: parseInt(e.target.value) || 0 } })}
                className="h-8 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Max Sqft</label>
              <Input
                type="number"
                value={config.surcharge.max_sqft}
                onChange={(e) => setConfig({ ...config, surcharge: { ...config.surcharge, max_sqft: parseInt(e.target.value) || 0 } })}
                className="h-8 text-sm"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Surcharge of ${config.surcharge.rate}/sqft applied to jobs between {config.surcharge.min_sqft}-{config.surcharge.max_sqft} sqft
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
