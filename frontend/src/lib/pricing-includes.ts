const INSIDE_SIDES = ["Inside Front", "Inside Left", "Inside Back", "Inside Right"];
const OUTSIDE_SIDES = ["Outside Front", "Outside Left", "Outside Back", "Outside Right"];

export function generatePricingIncludes(fenceSides: string[]): string {
  const insideChecked = INSIDE_SIDES.filter((s) => fenceSides.includes(s));
  const outsideChecked = OUTSIDE_SIDES.filter((s) => fenceSides.includes(s));

  const parts: string[] = [];

  if (insideChecked.length === 4) parts.push("Inside Facing Fences");
  else parts.push(...insideChecked);

  if (outsideChecked.length === 4) parts.push("Outside Facing Fences");
  else parts.push(...outsideChecked);

  return parts.length > 0 ? parts.join(", ") : "Fence Staining";
}
