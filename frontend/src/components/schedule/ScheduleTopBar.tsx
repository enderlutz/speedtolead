/**
 * Google Calendar's top bar in the brand's black band: Today, ‹ ›, the range
 * ("October 2026", "Oct 19 – 25, 2026", "Wed, Oct 21"), and the view switcher
 * (Today · Day · 3 days · Week · Month · List). On a phone the switcher is a full
 * width segmented control under the arrows, so nothing scrolls sideways.
 */
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { VIEWS, type ScheduleView } from "./dates";

export function ScheduleTopBar({ view, label, loading, onToday, onStep, onView }: {
  view: ScheduleView; label: string; loading?: boolean;
  onToday: () => void; onStep: (n: -1 | 1) => void; onView: (v: ScheduleView) => void;
}) {
  const arrow = "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-white hover:bg-white/10 active:bg-white/20";
  return (
    <div className="rounded-2xl bg-[#15130F] p-2 text-white shadow-lg shadow-black/20 ring-1 ring-[#C9972F]/40 sm:p-2.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <button type="button" onClick={onToday}
                  className="min-h-11 shrink-0 rounded-xl px-3.5 text-[15px] font-bold text-white ring-1 ring-white/30 hover:bg-white/10 active:bg-white/20">
            Today
          </button>
          <button type="button" onClick={() => onStep(-1)} aria-label="Back" className={arrow}><ChevronLeft className="h-6 w-6" /></button>
          <button type="button" onClick={() => onStep(1)} aria-label="Forward" className={arrow}><ChevronRight className="h-6 w-6" /></button>
          <p className="min-w-0 flex-1 truncate pl-1 font-heading text-[18px] font-bold leading-tight text-[#E3BE63] sm:text-[20px]" aria-live="polite">
            {label}
            {loading ? <Loader2 className="ml-2 inline h-4 w-4 animate-spin text-white/70" aria-label="Loading" /> : null}
          </p>
        </div>
        <div className="grid grid-cols-6 gap-0.5 rounded-xl bg-white/10 p-1 sm:flex" role="tablist" aria-label="View">
          {VIEWS.map((v) => (
            <button key={v.key} type="button" role="tab" aria-selected={view === v.key} onClick={() => onView(v.key)}
                    className={cn("min-h-11 rounded-lg px-0.5 text-[14px] font-semibold leading-none tracking-tight transition-colors sm:px-3",
                      view === v.key ? "bg-[#C9972F] text-[#15130F] shadow" : "text-white/85 hover:bg-white/10 active:bg-white/20")}>
              {v.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
