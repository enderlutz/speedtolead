// Repair prices on the Pricing page (Alan, 2026-11-11: "add all the repairs
// that we do into our pricing screen so we can see the price for each kind of
// board", then editable "just to have if we ever decide to adjust them").
// Admin edits with a confirmation step; everyone else reads. The list is kept
// on the server (services/repair_prices.py) and read by every screen through
// lib/repairs.ts. Each row shows the same drawing the customer proposal uses.
import { useState } from "react";
import { toast } from "sonner";
import { Hammer } from "lucide-react";
import { api, getCurrentUser } from "@/lib/api";
import { applyRepairPrices, currentPrices, PARTS, PICKETS, POSTS, useRepairPrices, type RepairPriceKey, REPAIR_PRICE_KEYS } from "@/lib/repairs";
import { FencePart, type FencePartKey } from "@/components/proposal/Repairs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Row = { key: RepairPriceKey; name: string; what: string; art: FencePartKey };

const ROWS: Row[] = [
  ...PICKETS.map((p) => ({ key: p.key as RepairPriceKey, name: `Picket (${p.label})`, what: "One fence board", art: "picket" as FencePartKey })),
  ...PARTS.map((p) => ({ key: p.key as RepairPriceKey, name: p.label, what: p.what, art: p.key as FencePartKey })),
  ...POSTS.map((p) => ({ key: p.key as RepairPriceKey, name: `Post (${p.label})`, what: "Replaced post, set in concrete", art: "post" as FencePartKey })),
];
const NAME: Record<string, string> = Object.fromEntries(ROWS.map((r) => [r.key, r.name]));

const dollars = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
/** A typed price, or null when it isn't one we'd save (blank, 0, over $2,000, fractions of a cent). */
function parsed(s: string): number | null {
  const t = s.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!t || !/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 && n <= 2000 ? n : null;
}

export function RepairPricesCard() {
  useRepairPrices();
  const isAdmin = getCurrentUser()?.role === "admin";
  const live = currentPrices();
  const [draft, setDraft] = useState<Partial<Record<RepairPriceKey, string>>>({});
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);

  const shown = (k: RepairPriceKey) => draft[k] ?? String(live[k]);
  const changes = REPAIR_PRICE_KEYS
    .filter((k) => draft[k] !== undefined && parsed(draft[k]!) !== live[k])
    .map((k) => ({ key: k, from: live[k], to: parsed(draft[k]!) }));
  const bad = changes.filter((c) => c.to === null);
  const dirty = changes.length > 0;

  const save = async () => {
    const next = Object.fromEntries(REPAIR_PRICE_KEYS.map((k) => {
      const v = draft[k] !== undefined ? parsed(draft[k]!) : live[k];
      return [k, Math.round((v ?? live[k]) * 100)];
    })) as Record<string, number>;
    setSaving(true);
    try {
      const r = await api.setRepairPrices(next);
      applyRepairPrices(r.prices);
      setDraft({});
      setConfirm(false);
      toast.success("Repair prices saved");
    } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't save the repair prices"); }
    finally { setSaving(false); }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Hammer className="h-4 w-4" /> Repair Prices
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Per board, tax included. Loose boards get screwed back in for free. Counts are confirmed on cleaning day.
          Everyone pays these prices: new-customer pricing never goes on repairs.
        </p>
        <div className="divide-y rounded-lg border text-sm">
          {ROWS.map((row) => {
            const changed = changes.some((c) => c.key === row.key);
            const invalid = bad.some((c) => c.key === row.key);
            return (
              <div key={row.key} className={cn("flex items-center gap-3 px-3 py-2.5", changed && "bg-amber-50 dark:bg-amber-500/10")}>
                {/* 96×72 like the proposal; smaller on a phone so the price still fits. */}
                <div className="shrink-0 overflow-hidden rounded-lg bg-white ring-1 ring-black/10 [&_svg]:block [&_svg]:h-auto [&_svg]:w-16 sm:[&_svg]:w-24">
                  <FencePart part={row.art} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{row.name}</div>
                  <div className="text-xs text-muted-foreground">{row.what}</div>
                  {changed ? <div className={cn("text-xs font-medium", invalid ? "text-red-600" : "text-amber-700")}>
                    {invalid ? "More than $0, up to $2,000" : `Was ${dollars(live[row.key])}`}
                  </div> : null}
                </div>
                {isAdmin ? (
                  <label className="flex shrink-0 items-center gap-1 font-bold">
                    <span>$</span>
                    <input type="text" inputMode="decimal" aria-label={`${row.name} price`} value={shown(row.key)}
                      onChange={(e) => setDraft({ ...draft, [row.key]: e.target.value })}
                      className={cn("h-11 w-20 rounded-md border bg-background px-2 text-right tabular-nums outline-none focus:ring-2 focus:ring-ring",
                        changed && !invalid && "border-amber-500 ring-1 ring-amber-400", invalid && "border-red-500 ring-1 ring-red-400")} />
                  </label>
                ) : <div className="shrink-0 font-bold tabular-nums">{dollars(live[row.key])}</div>}
              </div>
            );
          })}
        </div>
        {isAdmin ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button className="h-11" disabled={!dirty || bad.length > 0 || saving} onClick={() => setConfirm(true)}>Save repair prices</Button>
            {dirty ? <button type="button" className="min-h-11 text-sm font-medium text-muted-foreground underline" onClick={() => setDraft({})}>Reset</button> : null}
          </div>
        ) : null}
      </CardContent>

      <Dialog open={confirm} onOpenChange={(o) => { if (!saving) setConfirm(o); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change the repair prices?</DialogTitle>
            <DialogDescription>
              New proposals, booking invites and bills use the new prices. Prices already agreed with a customer don't change.
            </DialogDescription>
          </DialogHeader>
          <ul className="space-y-1 text-sm">
            {changes.map((c) => (
              <li key={c.key} className="flex justify-between gap-3">
                <span>{NAME[c.key]}</span>
                <span className="tabular-nums font-semibold">{dollars(c.from)} → {dollars(c.to ?? c.from)}</span>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" className="h-11" disabled={saving} onClick={() => setConfirm(false)}>Cancel</Button>
            <Button className="h-11" disabled={saving} onClick={() => void save()}>{saving ? "Saving..." : "Confirm"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
