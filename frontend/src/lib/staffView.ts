// A logged-in team member's own phone or laptop opening a customer page
// (proposal, booking): send the dashboard login so the server never counts it
// as the customer's view (Alan, 2026-11-12: testing a proposal made it look
// like the customer opened it). Customers have no login, so nothing changes
// for them. Kept apart from lib/api.ts so customer pages stay small.
export function staffHeaders(): Record<string, string> {
  if (typeof document === "undefined") return {};
  const match = document.cookie.match(/(?:^|;\s*)at_auth=([^;]*)/);
  return match && match[1] ? { Authorization: `Bearer ${decodeURIComponent(match[1])}` } : {};
}
