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


/** "Signature: $0.88/sqft x 894 sqft" → 894. */
export function sqftFromLine(line: Pick<BreakdownItem, "label" | "qty">): number | null {
  if (line.qty != null && line.qty > 0) return line.qty;
  const m = /x\s*([\d,]+(?:\.\d+)?)\s*sq\s*ft/i.exec(line.label || "");
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

/** $0.88 stays "0.88"; $0.719183 becomes "0.7192" — enough decimals that
 *  rate x sqft visibly lands on the price. */
export function formatRate(rate: number): string {
  const four = rate.toFixed(4);
  return four.endsWith("00") ? rate.toFixed(2) : four.replace(/0+$/, "");
}

/**
 * Set a package's FINAL price — what the customer sees — and work backwards.
 *
 * A tier's price is its own line plus every surcharge, so typing the target
 * into the line itself put the surcharge on top a second time (Ehis
 * Osazuwa: line set to 866.45 + 223.50 surcharge = 1,089.95). This takes the
 * target, subtracts the surcharges to get the line, derives the per-sqft
 * rate that produces it, and rewrites the label so the arithmetic on the
 * page is true. Returns the new lines, or an error to show.
 */
export function setTierPrice(items: BreakdownItem[], tier: TierKey, target: number):
  { items: BreakdownItem[] } | { error: string } {
  const idx = items.findIndex((it) => tierOfLine(it) === tier);
  if (idx < 0) return { error: `There's no ${tier} line to change.` };
  const extras = items.reduce((s, it, i) => s + (i !== idx && tierOfLine(it) === null ? Number(it.value) || 0 : 0), 0);
  const base = Math.round((target - extras) * 100) / 100;
  if (!(base > 0)) {
    return { error: `That's less than the surcharges alone ($${extras.toFixed(2)}). Lower or remove a surcharge first.` };
  }
  const line = items[idx];
  const sqft = sqftFromLine(line);
  const name = tier.charAt(0).toUpperCase() + tier.slice(1);
  const next: BreakdownItem = sqft
    ? { ...line, tier, value: base, rate: base / sqft, qty: sqft,
        label: `${name}: $${formatRate(base / sqft)}/sqft x ${Math.round(sqft)} sqft` }
    : { ...line, tier, value: base };
  return { items: items.map((it, i) => (i === idx ? next : it)) };
}
