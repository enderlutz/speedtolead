/**
 * Google's Month grid, Monday first: a weekday row, then six rows of cells
 * with the number top-left (today in a gold circle). A laptop cell shows two
 * tiny chips and "+N"; a phone cell shows an icon per job. The whole cell is
 * the tap target and opens that day.
 */
import type { FixJob, PmDay } from "@/lib/api";
import { cn } from "@/lib/utils";
import { JobChip } from "./bits";
import { FixChip } from "./FixJobs";
import { INK, IVORY, LINE, MUTED, PAPER, RING, TASK_ICON, isDone } from "./look";
import { dayNumber, fmt, groupJobs, monthGrid, monthKey } from "./dates";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function MonthView({ anchor, byDay, today, onPickDay, fixesByDay }: {
  anchor: string; byDay: Map<string, PmDay[]>; today: string; onPickDay: (d: string) => void;
  /** The jobs to fix on each day (Alan, 2026-10-27), after the real jobs. */
  fixesByDay?: Map<string, FixJob[]>;
}) {
  const grid = monthGrid(anchor);
  const month = monthKey(anchor);
  return (
    <div className={cn("overflow-hidden rounded-2xl", PAPER, RING)}>
      <div className={cn("grid grid-cols-7 border-b text-center text-[12px] font-bold uppercase tracking-[0.1em]", LINE, IVORY, MUTED)}>
        {WEEKDAYS.map((w) => <div key={w} className="py-2"><span className="sm:hidden">{w[0]}</span><span className="hidden sm:inline">{w}</span></div>)}
      </div>
      <div className="grid grid-cols-7">
        {grid.map((d, i) => {
          const ranked = groupJobs(byDay.get(d) || []);
          const fixes = fixesByDay?.get(d) || [];
          // Real jobs first, then the go-backs; a phone cell shows marks, a laptop cell chips.
          const marks = [...ranked.map((g) => (g.rows.every(isDone) ? "✓" : g.tasks.map((t) => TASK_ICON[t] ?? "•").join(""))), ...fixes.map((f) => (f.done_at ? "✓" : "🔧"))];
          const chips = [...ranked.map((g, k) => <JobChip key={`j${k}`} g={g} tiny />), ...fixes.map((f) => <FixChip key={f.id} f={f} tiny />)];
          const inMonth = monthKey(d) === month;
          const col = i % 7, row = Math.floor(i / 7);
          return (
            <button key={d} type="button" onClick={() => onPickDay(d)} aria-label={`Open ${fmt(d, { weekday: "long", month: "long", day: "numeric" })}`}
                    className={cn("min-h-[68px] p-1 text-left align-top transition-colors hover:bg-[#F8F3E7] active:bg-[#E4DCCB]/60 sm:min-h-[124px] sm:p-1.5",
                      row < 5 && cn("border-b", LINE), col < 6 && cn("border-r", LINE), !inMonth && "bg-[#F8F3E7]/70")}>
              <span className={cn("flex h-7 w-7 items-center justify-center rounded-full text-[14px] font-bold tabular-nums",
                d === today ? "bg-[#C9972F] text-[#15130F]" : inMonth ? INK : MUTED)}>{dayNumber(d)}</span>
              <span className="mt-1 flex flex-wrap items-center gap-0.5 sm:hidden">
                {marks.slice(0, 3).map((m, k) => <span key={k} className="text-[14px] leading-none" aria-hidden>{m}</span>)}
                {marks.length > 3 ? <span className={cn("text-[12px] font-bold", MUTED)}>+{marks.length - 3}</span> : null}
              </span>
              <span className="mt-1 hidden space-y-1 sm:block">
                {chips.slice(0, 2)}
                {chips.length > 2 ? <span className={cn("block px-1.5 text-[14px] font-bold", MUTED)}>+{chips.length - 2}</span> : null}
              </span>
              {marks.length ? <span className="sr-only">{marks.length} on this day</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
