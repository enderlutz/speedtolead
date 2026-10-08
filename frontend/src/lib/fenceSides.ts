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
