/**
 * Deep links into the GHL / LeadConnector web app.
 *
 * The contact detail page IS the conversation thread — confirmed 2026-10-03
 * from Alan's own Safari address bar while he was sitting in a customer's
 * chat. So there is no separate conversation id to fetch or store, and the
 * two ids we already hold on every lead are enough.
 *
 * The domain is the part that matters. app.leadconnectorhq.com and
 * app.gohighlevel.com serve a byte-identical app (same SHA-256 on the shell)
 * but each sets its session cookie on its own domain, and neither redirects
 * to the other. A link to the door you are not signed in at drops you on a
 * login screen that then forgets where you were going — which is exactly how
 * this looked broken for twenty minutes while we worked it out.
 *
 * Alan signs in at LeadConnector, so that is the door we use. Anyone signed
 * in at GoHighLevel instead just logs in here once; the two sessions coexist
 * and nobody has to change where they normally work.
 */
const GHL_APP_ORIGIN = "https://app.leadconnectorhq.com";

/** Opens straight to the customer's conversation. Empty string when either
 *  id is missing, so callers can hide the control rather than link nowhere. */
export function ghlContactUrl(locationId: string, contactId: string): string {
  const loc = (locationId || "").trim();
  const contact = (contactId || "").trim();
  if (!loc || !contact) return "";
  return `${GHL_APP_ORIGIN}/v2/location/${encodeURIComponent(loc)}/contacts/detail/${encodeURIComponent(contact)}`;
}

/** The office's call button (Alan, 2026-10-19): open the customer in
 *  GoHighLevel and call from there, so it goes out on the business line
 *  (346-589-7877) and lands in the call log, not from a personal phone.
 *  Falls back to the phone's dialer only when the lead isn't in GHL. */
export function officeCallLink(phone: string, locationId: string, contactId: string): { href: string; ghl: boolean } {
  const url = ghlContactUrl(locationId, contactId);
  if (url) return { href: url, ghl: true };
  return { href: phone ? `tel:${phone.replace(/[^\d+]/g, "")}` : "", ghl: false };
}
