import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Pull a human-readable message off an unknown thrown value.
 *
 * A `catch` binding is `unknown` under strict TypeScript — anything can be
 * thrown, not just `Error`. These two helpers narrow it in one place so call
 * sites stay a one-liner instead of each re-typing the catch as `any` and
 * losing the check.
 */
export function errMessage(e: unknown, fallback: string): string {
  if (e instanceof Error) return e.message || fallback;
  if (typeof e === "string") return e || fallback;
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string" && m) return m;
  }
  return fallback;
}

/** The `name` of a thrown value — e.g. a DOMException's "NotAllowedError". */
export function errName(e: unknown): string {
  if (e instanceof Error) return e.name;
  if (e && typeof e === "object" && "name" in e) {
    const n = (e as { name?: unknown }).name;
    if (typeof n === "string") return n;
  }
  return "";
}

/** Always to the cent. The number on the dashboard has to be the number on
 *  the customer's proposal, so whoever is on the phone can read it out
 *  without opening the PDF. Alan asked for this on 2026-10-08 after
 *  $1,253.60 showed up as $1,254. */
export function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** The Affirm financing term the proposal quotes. Mirrors FINANCING_MONTHS
 *  in backend/api/estimates.py — keep the two in step or the dashboard
 *  stops matching the PDF the customer holds. */
export const FINANCING_MONTHS = 36;

/** "$34.82/mo for 36 mo." — the monthly line under a tier price, computed
 *  exactly as the PDF does it (price over the term, rounded UP to the
 *  cent). Empty for a tier with no price. */
export function formatMonthly(price: number): string {
  if (!price || price <= 0) return "";
  const cents = Math.ceil((price / FINANCING_MONTHS) * 100) / 100;
  return `${formatCurrency(cents)}/mo for ${FINANCING_MONTHS} mo.`;
}

export function formatDate(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

export function formatDateTime(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function timeAgo(iso: string): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
