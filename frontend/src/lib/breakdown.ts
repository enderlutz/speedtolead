// The three prices, from the breakdown lines. Mirrors
// services/estimator.tiers_from_breakdown on the backend so the preview in
// the editor shows exactly what Save will store.
//
// A breakdown is one base line per tier plus surcharges that apply to all
// three — the zone, the small-job uplift, anything added by hand. Each tier
// is its own base line plus every surcharge line. It is not the sum of the
// whole list.
import type { BreakdownItem } from "@/lib/api";

export const TIER_KEYS = ["essential", "signature", "legacy"] as const;
export type TierKey = (typeof TIER_KEYS)[number];
export type Tiers = Record<TierKey, number>;

/** Which tier a line is the base price of, or null for a surcharge. Tagged
 *  lines win; older stored lines are matched on their "Essential:" prefix. */
export function tierOfLine(line: Pick<BreakdownItem, "label" | "tier">): TierKey | null {
  const t = (line.tier || "").trim().toLowerCase();
  if ((TIER_KEYS as readonly string[]).includes(t)) return t as TierKey;
  const head = (line.label || "").trim().toLowerCase().split(":")[0].trim();
  return (TIER_KEYS as readonly string[]).includes(head) ? (head as TierKey) : null;
}

export function tiersFromBreakdown(items: BreakdownItem[], oldTiers: Tiers, oldItems: BreakdownItem[]): Tiers {
  const bases: Partial<Tiers> = {};
  let extras = 0;
  for (const it of items) {
    const t = tierOfLine(it);
    const v = Number(it.value) || 0;
    if (t && bases[t] === undefined) bases[t] = v;
    else extras += v;
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  if (Object.keys(bases).length === 0) {
    const total = items.reduce((s, it) => s + (Number(it.value) || 0), 0);
    const sig = oldTiers.essential > 0 ? oldTiers.signature / oldTiers.essential : 1.16;
    const leg = oldTiers.essential > 0 ? oldTiers.legacy / oldTiers.essential : 1.5;
    return { essential: r2(total), signature: r2(total * sig), legacy: r2(total * leg) };
  }
  const oldExtras = oldItems.reduce((s, it) => s + (tierOfLine(it) === null ? Number(it.value) || 0 : 0), 0);
  const out = {} as Tiers;
  for (const t of TIER_KEYS) {
    const base = bases[t] ?? Math.max(0, (oldTiers[t] || 0) - oldExtras);
    out[t] = r2(base + extras);
  }
  return out;
}
