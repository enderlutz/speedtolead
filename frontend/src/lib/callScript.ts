/**
 * Call-script template engine + render helpers.
 *
 * Supports:
 *   - {{var}}                 — substitute from context
 *   - {{#if X}}...{{/if}}    — show block when X is truthy
 *   - {{#unless X}}...{{/unless}} — show block when X is falsy
 *
 * Plus a tiny markdown-to-React renderer so the script can use ##/###
 * headings, **bold**, *italic*, > blockquotes, and bullet lists without
 * pulling in a 30 KB markdown library.
 */
import type { LeadDetail, EstimateDetail } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";

export const BRAND_NAME = "A&T's Fence Staining";

export interface ScriptContext {
  customer_name: string;
  customer_first_name: string;
  your_name: string;
  brand: string;
  address: string;
  zip_code: string;
  fence_height: string;
  fence_age: string;
  previously_stained: string;
  fence_sides: string;
  linear_feet: string;
  tier_essential: string;
  tier_signature: string;
  tier_legacy: string;

  // Conditionals
  has_address: boolean;
  has_fence_height: boolean;
  has_fence_age: boolean;
  has_previously_stained: boolean;
  has_fence_sides: boolean;
  fence_brand_new: boolean;
  fence_older_than_6mo: boolean;
}

const NA_VALUES = new Set(["", "didn't answer", "didnt answer", "didn't know", "didnt know", "n/a", "na", "unknown"]);

function isPresent(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return !NA_VALUES.has(v.trim().toLowerCase());
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function fenceIsBrandNew(ageRaw: string): boolean {
  const a = (ageRaw || "").toLowerCase();
  if (!a || NA_VALUES.has(a)) return false;
  // Match "less than 6 months", "0-6 months", "brand new", "<6"
  return /less than 6|brand new|0\s*-\s*6|^<\s*6/.test(a);
}

export function buildContext(args: {
  lead: LeadDetail | null;
  estimate?: EstimateDetail | null;
  yourName: string;
}): ScriptContext {
  const { lead, estimate, yourName } = args;
  const fd = (lead?.form_data || {}) as Record<string, unknown>;

  const fenceSidesRaw = fd.fence_sides;
  const fenceSides = Array.isArray(fenceSidesRaw)
    ? fenceSidesRaw.join(", ")
    : (typeof fenceSidesRaw === "string" ? fenceSidesRaw : "");

  const fenceAge = (fd.fence_age as string) || "";
  const tiers = (estimate?.tiers || {}) as Record<string, number>;

  const customerName = lead?.contact_name || "";
  const customerFirst = customerName.trim().split(/\s+/)[0] || "";

  return {
    customer_name: customerName,
    customer_first_name: customerFirst,
    your_name: yourName || "",
    brand: BRAND_NAME,
    address: lead?.address || "",
    zip_code: lead?.zip_code || "",
    fence_height: (fd.fence_height as string) || "",
    fence_age: fenceAge,
    previously_stained: (fd.previously_stained as string) || "",
    fence_sides: fenceSides,
    linear_feet: (fd.linear_feet as string) || "",
    tier_essential: tiers.essential ? formatCurrency(tiers.essential) : "—",
    tier_signature: tiers.signature ? formatCurrency(tiers.signature) : "—",
    tier_legacy: tiers.legacy ? formatCurrency(tiers.legacy) : "—",

    has_address: isPresent(lead?.address),
    has_fence_height: isPresent(fd.fence_height),
    has_fence_age: isPresent(fenceAge),
    has_previously_stained: isPresent(fd.previously_stained),
    has_fence_sides: Array.isArray(fenceSidesRaw) ? fenceSidesRaw.length > 0 : isPresent(fenceSidesRaw),
    fence_brand_new: fenceIsBrandNew(fenceAge),
    fence_older_than_6mo: isPresent(fenceAge) && !fenceIsBrandNew(fenceAge),
  };
}

/** Sample context used by Settings → live preview when no real lead is in scope. */
export function sampleContext(): ScriptContext {
  return {
    customer_name: "Maria Mendez",
    customer_first_name: "Maria",
    your_name: "Olga",
    brand: BRAND_NAME,
    address: "16614 Fiesta Rose Ct",
    zip_code: "77433",
    fence_height: "6ft",
    fence_age: "3-5 years",
    previously_stained: "not",
    fence_sides: "Inside front, Inside left, Inside back, Inside right",
    linear_feet: "120",
    tier_essential: "$1,840",
    tier_signature: "$2,640",
    tier_legacy: "$3,440",
    has_address: true,
    has_fence_height: true,
    has_fence_age: true,
    has_previously_stained: true,
    has_fence_sides: true,
    fence_brand_new: false,
    fence_older_than_6mo: true,
  };
}

/**
 * Substitute variables and process conditional blocks. Order matters:
 * conditionals first (so we don't substitute vars inside skipped blocks),
 * then unless, then plain {{var}}.
 *
 * Conditionals are non-nested in V1 — keeps the regex simple. If we need
 * nesting later, we'll swap to a real parser.
 */
export function renderTemplate(template: string, ctx: ScriptContext): string {
  let result = template;

  // {{#if X}}...{{/if}}
  result = result.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, key: string, body: string) => {
    return (ctx as unknown as Record<string, unknown>)[key] ? body : "";
  });

  // {{#unless X}}...{{/unless}}
  result = result.replace(/\{\{#unless\s+(\w+)\}\}([\s\S]*?)\{\{\/unless\}\}/g, (_, key: string, body: string) => {
    return !(ctx as unknown as Record<string, unknown>)[key] ? body : "";
  });

  // {{var}} — leave the placeholder in if the value is missing so the
  // VA can still see "{{customer_name}}" if she's calling someone whose
  // name we never captured.
  result = result.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const v = (ctx as unknown as Record<string, unknown>)[key];
    if (v === undefined || v === null || v === "") return match;
    return String(v);
  });

  // Collapse 3+ consecutive blank lines that conditional removal can leave behind
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

/** Available-variables cheatsheet shown in the Settings editor side panel. */
export const SCRIPT_VARIABLES: { key: string; description: string }[] = [
  { key: "customer_name", description: "Full name on the lead" },
  { key: "customer_first_name", description: "First word of the name (for greetings)" },
  { key: "your_name", description: "The logged-in VA's display name" },
  { key: "brand", description: "Company name (currently A&T's Fence Staining)" },
  { key: "address", description: "Street address from the lead" },
  { key: "zip_code", description: "ZIP code from the lead" },
  { key: "fence_height", description: "e.g. 6ft" },
  { key: "fence_age", description: "e.g. 3-5 years" },
  { key: "previously_stained", description: "yes/no/not — already-staining status" },
  { key: "fence_sides", description: "Comma-separated list of selected sides" },
  { key: "linear_feet", description: "Reported linear feet of fence" },
  { key: "tier_essential", description: "Essential package price (formatted)" },
  { key: "tier_signature", description: "Signature package price (formatted)" },
  { key: "tier_legacy", description: "Legacy package price (formatted)" },
];

export const SCRIPT_CONDITIONALS: { key: string; description: string }[] = [
  { key: "has_address", description: "Lead has an address on file" },
  { key: "has_fence_height", description: "fence_height is captured" },
  { key: "has_fence_age", description: "fence_age is captured" },
  { key: "has_previously_stained", description: "previously_stained is captured" },
  { key: "has_fence_sides", description: "fence_sides has at least one entry" },
  { key: "fence_brand_new", description: "Fence is ≤ 6 months old (no cleaning fee branch)" },
  { key: "fence_older_than_6mo", description: "Fence is > 6 months old (cleaning fee branch)" },
];
