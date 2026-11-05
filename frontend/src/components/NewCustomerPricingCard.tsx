// New-customer pricing (Alan, 2026-11-04): a brand-new person pays N% more on
// everything; anyone already in the system keeps today's prices. This card is
// the guide for the office: both columns side by side, so a VA quoting on the
// phone reads the right one. The lead page shows which one a lead is on.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import { api, getCurrentUser } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PARTS, PICKETS, POSTS, withUplift } from "@/lib/repairs";

type Rates = { essential: number; signature: number; legacy: number };

const AGES: [string, string][] = [["brand_new", "Brand new"], ["1_6yr", "1-6 years"], ["6_15yr", "6-15 years"]];
const money = (n: number, cents = true) => `$${n.toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 })}`;

export function NewCustomerPricingCard({ tierRates, minJob }: { tierRates: Record<string, Rates | null>; minJob: number }) {
  const [pct, setPct] = useState<number | null>(null);
  const [count, setCount] = useState(0);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const isAdmin = getCurrentUser()?.role === "admin";

  useEffect(() => {
    api.getNewCustomerPricing()
      .then((r) => { setPct(r.percent); setCount(r.leads_on_new_pricing); setDraft(String(r.percent)); })
      .catch(() => setPct(10));
  }, []);

  const save = async () => {
    const n = Number(draft);
    if (!Number.isFinite(n) || n < 0 || n > 50) { toast.error("Pick a percent between 0 and 50"); return; }
    setSaving(true);
    try { const r = await api.setNewCustomerPricing(n); setPct(r.percent); toast.success(r.percent ? `New customers now get +${r.percent}%` : "New-customer pricing is off for new leads"); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't save"); }
    finally { setSaving(false); }
  };

  const p = pct ?? 10;
  const up = (n: number) => withUplift(n, p);
  const rate = (n: number) => `$${n.toFixed(2)}`;

  return (
    <Card className="border-amber-300">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-600" /> New customer pricing {p > 0 ? `(+${p}%)` : "(off)"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          Only for a <b>brand-new person</b>: nobody with their phone or email was ever in our system (no form, text, call or old estimate).
          Everyone already in the system, like the old leads Gioconda calls back, keeps <b>today's prices</b>. The lead page shows a
          "New customer pricing" tag on the ones who get it, and their estimates already include it. {count} lead{count === 1 ? "" : "s"} on it so far.
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="py-2 pr-3 text-left font-medium">Per sq ft</th>
                <th className="py-2 pr-3 text-right font-medium">Today's prices</th>
                <th className="py-2 text-right font-medium text-amber-700">New customers</th>
              </tr>
            </thead>
            <tbody>
              {AGES.map(([key, label]) => {
                const r = tierRates[key];
                if (!r) return null;
                return (["essential", "signature", "legacy"] as const).map((t, i) => (
                  <tr key={`${key}-${t}`} className={i === 2 ? "border-b" : ""}>
                    <td className="py-1.5 pr-3">{i === 0 ? <b>{label}</b> : null} <span className="capitalize text-muted-foreground">{t}</span></td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{rate(r[t])}</td>
                    <td className="py-1.5 text-right font-semibold tabular-nums text-amber-700">{rate(r[t] * (1 + p / 100))}</td>
                  </tr>
                ));
              })}
              <tr className="border-b">
                <td className="py-1.5 pr-3"><b>Minimum job</b></td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{money(minJob, false)}</td>
                <td className="py-1.5 text-right font-semibold tabular-nums text-amber-700">{money(up(minJob), false)}</td>
              </tr>
              {[...PICKETS.map((x) => [`Picket (${x.label})`, x.price] as const),
                ...PARTS.map((x) => [x.label, x.price] as const),
                ...POSTS.map((x) => [`Post (${x.label})`, x.price] as const)].map(([label, price]) => (
                <tr key={label}>
                  <td className="py-1.5 pr-3">{label}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{money(price)}</td>
                  <td className="py-1.5 text-right font-semibold tabular-nums text-amber-700">{money(up(price))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted-foreground">Zone and small-job surcharges go up by the same percent.</p>
        </div>

        {isAdmin ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Percent for new customers from now on:</span>
            <Input value={draft} onChange={(e) => setDraft(e.target.value)} inputMode="decimal" className="h-11 w-20" aria-label="Percent" />
            <Button className="h-11" onClick={() => void save()} disabled={saving || draft === String(pct)}>Save</Button>
            <span className="text-xs text-muted-foreground">0 turns it off. Leads already priced keep what they came in with.</span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
