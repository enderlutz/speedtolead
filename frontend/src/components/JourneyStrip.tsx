// The customer journey: every stage of a lead from "we have an address" to
// "reviewed and paid", as one strip at the top of the estimate page.
//
// Each chip scrolls to the card where that stage happens. The bar fills
// left to right and the current stage is ringed in gold, so the answer to
// "what do I do next on this one?" is there before a single card is read.
//
// On a desktop the chips sit in a grid. On a phone (Alan, 2026-10-08: "on
// iPhone it needs some work") sixteen chips in three columns were five rows
// of buttons before any card — so each row is a swipeable strip instead,
// scrolled so the current step sits in the middle.
import { useEffect, useRef } from "react";
import { Check, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Accent } from "@/lib/accents";

export type JourneyStep = {
  key: string;
  label: string;
  icon: React.ElementType;
  accent: Accent;
  done: boolean;
  /** Element id to scroll to when the chip is tapped. */
  target: string;
  /** One line on what to do, shown for the current step. */
  hint: string;
  /** Not done, and never will be — we moved past it on purpose (sent the
   *  estimate without ever getting a first reply). Shown blank, and never
   *  "You are here". */
  skipped?: boolean;
  /** "sale" — winning the job; "job" — doing it. Drawn as two rows. */
  phase?: "sale" | "job";
  /** Replaces the scroll-to-card tap, for a step marked by hand. */
  onClick?: () => void;
  /** Started but not finished — "Getting cleaned". Pulses in its colour. */
  active?: boolean;
  activeLabel?: string;
  /** A short count under the label, e.g. "2 objections". */
  badge?: string;
};

// Below Tailwind's `sm` the rows swipe; from `sm` up they are grids.
const PHONE = "(max-width: 639px)";

export function JourneyStrip({ steps }: { steps: JourneyStep[] }) {
  const done = steps.filter((s) => s.done).length;
  const current = steps.find((s) => !s.done && !s.skipped);
  const jump = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  // On a phone, bring the current step to the middle of its row. Done with
  // scrollLeft on the row, not scrollIntoView, which would also scroll the
  // page to the strip every time the lead loads.
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const currentRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const chip = currentRef.current;
    if (!chip || !window.matchMedia(PHONE).matches) return;
    const row = chip.parentElement;
    if (!row) return;
    const left = chip.offsetLeft - row.clientWidth / 2 + chip.offsetWidth / 2;
    // Instant, not smooth: this runs as the lead opens, and a strip seen
    // sliding into place on every open reads as something going wrong.
    row.scrollTo({ left: Math.max(0, left) });
  }, [current?.key]);

  return (
    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-stone-900 via-ink to-stone-900 p-3.5 text-white shadow-xl shadow-black/20 ring-1 ring-gold/30 sm:p-4">
      <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-gold/25 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-20 -left-10 h-48 w-48 rounded-full bg-cedar/25 blur-3xl" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-gold-light/70 to-transparent" />

      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-gold-light/90">Customer journey</p>
          <p className="font-heading text-base font-bold leading-tight sm:text-lg">
            {current ? `Next up: ${current.label}` : "Every step done — reviewed and paid"}
          </p>
          <p className="mt-0.5 text-xs text-white/70">
            {current ? current.hint : "A finished customer. Ask for a referral."}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-heading text-2xl font-bold tabular-nums leading-none">
            {done}<span className="text-white/40">/{steps.length}</span>
          </p>
          <p className="mt-1 text-[10px] uppercase tracking-wider text-white/60">steps</p>
        </div>
      </div>

      <div className="relative mt-3 flex gap-1">
        {steps.map((s) => (
          <div
            key={s.key}
            className={cn(
              "h-1.5 flex-1 rounded-full transition-all duration-500",
              s.done ? `bg-gradient-to-r ${s.accent.grad}` : s.skipped ? "bg-white/5" : s === current ? "animate-pulse bg-white/40" : "bg-white/15",
            )}
          />
        ))}
      </div>

      {(["sale", "job"] as const).map((phase) => {
        const row = steps.filter((s) => (s.phase || "sale") === phase);
        if (row.length === 0) return null;
        return (
          <div key={phase} className="relative mt-3">
            {phase === "job" ? (
              <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-white/50">The job</p>
            ) : null}
            {/* Phone: one swipeable row, the current step centred, a fade
                on the right so it reads as "more this way". Desktop: a grid. */}
            <div className="relative">
              <div
                ref={(el) => { rowRefs.current[phase] = el; }}
                className={cn(
                  "relative -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                  "sm:mx-0 sm:grid sm:overflow-visible sm:px-0 sm:pb-0",
                  phase === "sale" ? "sm:grid-cols-9" : "sm:grid-cols-7",
                )}
              >
                {row.map((s) => {
                  const isCurrent = s === current;
                  const Icon = s.icon;
                  // Booked is the win, so it gets a gold star rather than a tick.
                  const won = s.key === "booked" && s.done;
                  return (
                    <button
                      key={s.key}
                      ref={isCurrent ? currentRef : undefined}
                      type="button"
                      onClick={() => (s.onClick ? s.onClick() : jump(s.target))}
                      title={s.hint}
                      className={cn(
                        "flex w-[78px] shrink-0 flex-col items-center gap-1 rounded-xl px-1 py-2 text-center transition active:scale-95 sm:w-auto sm:px-1.5",
                        won ? "bg-amber-300/15 ring-2 ring-amber-300/70 shadow-[0_0_18px_rgba(252,211,77,0.45)] hover:bg-amber-300/20"
                          : s.done ? "bg-white/10 hover:bg-white/15"
                          : s.skipped ? "border border-dashed border-white/25 bg-transparent text-white/45 hover:border-white/40"
                          : s.active ? `bg-white/10 ring-2 ${s.accent.ring} hover:bg-white/15`
                          : isCurrent ? "bg-white/15 ring-2 ring-gold-light/80 hover:bg-white/20"
                          : "bg-white/5 opacity-70 hover:bg-white/10 hover:opacity-100",
                      )}
                    >
                      <span className={cn(
                        "flex h-8 w-8 items-center justify-center rounded-lg",
                        won ? "bg-gradient-to-br from-amber-300 to-yellow-500 text-amber-950 shadow-md shadow-amber-500/40"
                          : s.done ? `bg-gradient-to-br ${s.accent.grad} shadow-md shadow-black/20`
                          : s.skipped ? "border border-dashed border-white/25 bg-transparent"
                          : s.active ? `animate-pulse bg-gradient-to-br ${s.accent.grad} opacity-80`
                          : "bg-white/10",
                      )}>
                        {won ? <Star className="h-4 w-4 fill-current" />
                          : s.done ? <Check className="h-4 w-4" />
                          : <Icon className={cn("h-4 w-4", s.skipped && "opacity-40")} />}
                      </span>
                      <span className={cn("text-[11px] font-semibold leading-tight", s.skipped && "line-through decoration-white/30")}>{s.label}</span>
                      <span className={cn("text-[9px] leading-tight", won ? "font-bold text-amber-200" : "text-white/60")}>
                        {won ? "Booked!" : s.done ? "Done" : s.skipped ? "Skipped"
                          : s.active ? (s.activeLabel || "In progress") : isCurrent ? "You are here" : "Later"}
                      </span>
                      {s.badge ? (
                        <span className="rounded-full bg-amber-300/90 px-1.5 text-[9px] font-bold leading-4 text-amber-950">{s.badge}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              <div className="pointer-events-none absolute inset-y-0 -right-1 w-8 bg-gradient-to-l from-stone-900/90 to-transparent sm:hidden" />
            </div>
          </div>
        );
      })}
    </div>
  );
}
