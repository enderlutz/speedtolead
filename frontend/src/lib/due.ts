// When an invoice is due (Alan, 2026-10-15): upon receipt, or a day picked.

/** "Upon receipt", or the day it's due ("October 24, 2026"). The date is a
 * calendar day, so it's read as local, not UTC midnight. */
export function dueText(due?: string | null) {
  if (!due) return "Upon receipt";
  const [y, m, d] = due.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}
