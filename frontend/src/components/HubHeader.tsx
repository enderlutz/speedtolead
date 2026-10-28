/**
 * The header every hub page shares (Design Lab, Money): the black card with
 * the page's name, its sections across the top, and a second row that is
 * always there at the same height — the section's views, or one line on
 * what's below — so nothing jumps when moving around (Alan, 2026-10-27:
 * "I want everything to stay the same size"). The page owns the address
 * (?tab=…&view=…); this only draws it.
 */
import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";

export type HubTab<K extends string = string> = { key: K; label: string; icon: ElementType; hint?: string; count?: number };
export type HubView = { key: string; label: string; hint?: string };

export function HubHeader<K extends string>({ icon: Icon, title, subtitle, tabs, tab, onTab, views, view, onView, note, action }: {
  icon: ElementType; title: string; subtitle: string;
  tabs: HubTab<K>[]; tab: K; onTab: (k: K) => void;
  /** The second row: the section's views to pick from… */
  views?: HubView[]; view?: string; onView?: (v: string) => void;
  /** …or, when it has none, one line on what's below. */
  note?: string;
  /** A button on the right of the title, like Full screen. */
  action?: ReactNode;
}) {
  const current = tabs.find((t) => t.key === tab);
  return (
    <div className="overflow-hidden rounded-2xl bg-ink text-ivory shadow-lg">
      <div className="flex flex-wrap items-center gap-3 px-5 py-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-gold to-bronze shadow-sm">
          <Icon className="h-5 w-5 text-ink" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="font-heading text-xl font-bold leading-tight">{title}</h1>
          <p className="text-xs text-ivory/70">{subtitle}</p>
        </div>
        {action}
      </div>
      {/* The sections, across the top. */}
      <div className="flex flex-wrap gap-1 border-t border-white/10 px-3 py-2">
        {tabs.map((t) => (
          <button key={t.key} type="button" onClick={() => onTab(t.key)} title={t.hint}
            className={cn("inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl px-3.5 text-[14px] font-bold transition",
              tab === t.key ? "bg-gold text-ink shadow-sm" : "text-ivory/80 hover:bg-white/10")}>
            <t.icon className="h-4 w-4" /> {t.label}
            {t.count ? <span className={cn("rounded-full px-1.5 text-[11px]", tab === t.key ? "bg-ink/15" : "bg-white/10")}>{t.count}</span> : null}
          </button>
        ))}
      </div>
      {/* The section's own row: its views, or one line on what's below. Always the same height. */}
      <div className="flex min-h-[52px] flex-wrap items-center gap-1 border-t border-white/10 bg-white/5 px-3 py-1.5">
        <span className="mr-2 text-[11px] font-bold uppercase tracking-wider text-ivory/50">{current?.label}</span>
        {views?.length ? views.map((s) => (
          <button key={s.key} type="button" onClick={() => onView?.(s.key)} title={s.hint}
            className={cn("inline-flex min-h-10 shrink-0 items-center rounded-lg px-3 text-[14px] font-semibold transition",
              view === s.key ? "bg-white/15 text-gold" : "text-ivory/75 hover:bg-white/10")}>
            {s.label}
          </button>
        )) : <span className="text-[13px] text-ivory/70">{note}</span>}
      </div>
    </div>
  );
}
