// The eight sides of a fence.
//
// The same eight strings everywhere: what the estimator saves in
// form_data.fence_sides, what a Company Cam colour row lists, and what the
// backend's FENCE_SIDE_GROUPS names. Front faces the street.
export const FENCE_SIDES = {
  Inside: ["Inside Front", "Inside Left", "Inside Back", "Inside Right"],
  Outside: ["Outside Front", "Outside Left", "Outside Back", "Outside Right"],
} as const;

export type SideGroup = keyof typeof FENCE_SIDES;

export const ALL_SIDES: readonly string[] = [...FENCE_SIDES.Inside, ...FENCE_SIDES.Outside];

/** The sides a customer's own words point at, or null when they don't.
 *  "inside facing" → the four insides; "both" / "all" / "whole" → every
 *  side; "outside" alone → the four outsides. The ad form's "sides?"
 *  question is free text (2026-10-09), so anything else — "yes", "I would
 *  like a quote" — is left for a person to read. A gate mentioned on the
 *  other side is a note, not a second group. */
export function sidesFromAnswer(text: string): string[] | null {
  const v = text.toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!v) return null;
  const inside = /\b(inside|inner|interior|facing)\b/.test(v);
  const outside = /\b(outside|outer|exterior|street)\b/.test(v);
  const gate = /\bgates?\b/.test(v);
  if (/\b(both|all|whole|entire|every)\b/.test(v) || (inside && outside && !gate)) return [...ALL_SIDES];
  if (inside) return [...FENCE_SIDES.Inside];
  if (outside) return [...FENCE_SIDES.Outside];
  return null;
}

/** "All insides", "Inside: Front, Left · Outside: Back", "Whole fence".
 *  Mirrors sides_label() on the backend so the two never disagree. */
export function sidesLabel(sides: string[]): string {
  const chosen = ALL_SIDES.filter((s) => sides.includes(s));
  if (chosen.length === 0) return "";
  if (chosen.length === ALL_SIDES.length) return "Whole fence";
  const parts: string[] = [];
  (Object.keys(FENCE_SIDES) as SideGroup[]).forEach((group) => {
    const names = FENCE_SIDES[group];
    const mine = names.filter((n) => chosen.includes(n));
    if (mine.length === 0) return;
    if (mine.length === names.length) parts.push(`All ${group.toLowerCase()}s`);
    else parts.push(`${group}: ${mine.map((n) => n.replace(`${group} `, "")).join(", ")}`);
  });
  return parts.join(" · ");
}

/** The chips the estimate shows for the chosen sides. All four of a group
 *  collapse to one chip ("Insides of fence"), all eight to "Whole fence"
 *  (Alan, 2026-10-08: four purple pills saying the same thing is "extra
 *  shit"). Anything less lists the sides. */
export function sideChips(sides: string[]): { label: string; group: SideGroup | "all" }[] {
  const chosen = ALL_SIDES.filter((s) => sides.includes(s));
  if (chosen.length === 0) return [];
  if (chosen.length === ALL_SIDES.length) return [{ label: "Whole fence", group: "all" }];
  const out: { label: string; group: SideGroup | "all" }[] = [];
  (Object.keys(FENCE_SIDES) as SideGroup[]).forEach((group) => {
    const names = FENCE_SIDES[group];
    const mine = names.filter((n) => chosen.includes(n));
    if (mine.length === names.length) out.push({ label: `${group}s of fence`, group });
    else mine.forEach((n) => out.push({ label: n, group }));
  });
  return out;
}
