/**
 * Google Calendar's top bar in the brand's black band: Today, ‹ ›, the range
 * ("October 2026", "Oct 19 – 25, 2026", "Wed, Oct 21"), and the view switcher
 * (Live · Day · 3 days · Week · Month · List). On a phone the switcher is a
 * row of chips under the arrows that scrolls sideways if it ever runs out of
 * room, so the page itself never does.
 *
 * Alan, 2026-11-02: "Today" showed twice (the button and the first view).
 * The button stays (back to today in the view you're on); the live board of
 * today's jobs is the "Live" view.
 */
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { VIEWS, type ScheduleView } from "./dates";

const viewLabel = (v: { key: ScheduleView; label: string }) => (v.key === "today" ? "Live" : v.label);

export function ScheduleTopBar({ view, label, loading, onToday, onStep, onView }: {
  view: ScheduleView; label: string; loading?: boolean;
  onToday: () => void; onStep: (n: -1 | 1) => void; onView: (v: ScheduleView) => void;
}) {
  const arrow = "flex h-11 w-10 shrink-0 items-center justify-center rounded-xl text-white hover:bg-white/10 active:bg-white/20 sm:w-11";
  return (
    <div className="rounded-2xl bg-[#15130F] p-2 text-white shadow-lg shadow-black/20 ring-1 ring-[#C9972F]/40 sm:p-2.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 sm:gap-1">
          <button type="button" onClick={onToday}
                  className="min-h-11 shrink-0 whitespace-nowrap rounded-xl px-3 text-[15px] font-bold text-white ring-1 ring-white/30 hover:bg-white/10 active:bg-white/20">
            Today
          </button>
          <button type="button" onClick={() => onStep(-1)} aria-label="Back" className={arrow}><ChevronLeft className="h-6 w-6" /></button>
          <button type="button" onClick={() => onStep(1)} aria-label="Forward" className={arrow}><ChevronRight className="h-6 w-6" /></button>
          <p className="min-w-0 flex-1 truncate whitespace-nowrap pl-1 font-heading text-[18px] font-bold leading-tight text-[#E3BE63] sm:text-[20px]" aria-live="polite">
            {label}
            {loading ? <Loader2 className="ml-2 inline h-4 w-4 animate-spin text-white/70" aria-label="Loading" /> : null}
          </p>
        </div>
        <div className="flex snap-x gap-0.5 overflow-x-auto rounded-xl bg-white/10 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist" aria-label="View">
          {VIEWS.map((v) => (
            <button key={v.key} type="button" role="tab" aria-selected={view === v.key} onClick={() => onView(v.key)}
                    className={cn("min-h-11 flex-1 shrink-0 snap-start whitespace-nowrap rounded-lg px-2.5 text-[14px] font-semibold leading-none transition-colors sm:flex-none sm:px-3",
                      view === v.key ? "bg-[#C9972F] text-[#15130F] shadow" : "text-white/85 hover:bg-white/10 active:bg-white/20")}>
              {viewLabel(v)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
