// Plain helpers for the command center: money and waiting-time words, and
// the urgency colors (red = overdue or serious, amber = soon, green = fine,
// everything else neutral).
import type { Priority } from "./types";

export function money(v: number | null | undefined, empty = "—"): string {
  if (v == null || Number.isNaN(v)) return empty;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(v);
}

export function waited(hours: number | null | undefined): string {
  if (hours == null) return "";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} days`;
}

export function pctChange(now: number, before: number): number | null {
  if (!before) return null;
  return Math.round(((now - before) / before) * 100);
}

export const DOT: Record<Priority, string> = {
  red: "bg-red-600",
  amber: "bg-amber-500",
  green: "bg-emerald-600",
  blue: "bg-slate-400",
};

export const STRIPE: Record<Priority, string> = {
  red: "border-l-red-600",
  amber: "border-l-amber-500",
  green: "border-l-emerald-600",
  blue: "border-l-slate-300 dark:border-l-slate-600",
};

export const PILL: Record<Priority, string> = {
  red: "bg-red-50 text-red-800 ring-red-200 dark:bg-red-950/50 dark:text-red-200 dark:ring-red-900",
  amber: "bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900",
  green: "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-900",
  blue: "bg-muted text-muted-foreground ring-border",
};
