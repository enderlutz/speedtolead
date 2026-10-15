// The Klarna line, shared by the proposal and the booking invite so both
// quote the same "From $X/month" (Alan, 2026-10-10: PlayStation's exact
// shape). Estimated the way Klarna does: the lowest rate over the longest
// plan (7.99% APR over 24 months), rounded up to the dollar. Klarna's own
// page shows the real plans before anyone agrees.
const KLARNA_LOW_APR = 0.0799;
const KLARNA_LONGEST_MONTHS = 24;

export function monthlyFrom(total: number): number {
  const r = KLARNA_LOW_APR / 12;
  return Math.ceil((total * r) / (1 - Math.pow(1 + r, -KLARNA_LONGEST_MONTHS)));
}

export function klarnaLine(total: number): string {
  return `From $${monthlyFrom(total)}/month, or 4 payments at 0% interest with Klarna`;
}
