import type { LeadDetail } from "@/lib/api";

/**
 * Lead-detail prefetch cache, shared by the Leads boards and the detail page.
 *
 * Lives in its own module rather than alongside the Leads page component so
 * editing that page doesn't drop Fast Refresh (a module that exports both
 * components and plain values can't be hot-swapped).
 */
export const leadDetailCache = new Map<string, LeadDetail>();
