/**
 * Google's Day-columns layout for 3 days and Week: on a laptop one column per
 * day with the stamp on top and the jobs stacked under it as all-day chips;
 * on a phone the same days top to bottom (never a sideways scroll). Read only:
 * tap a stamp to open that day, tap a chip to open the job.
 */
import type { PmDay } from "@/lib/api";
import { cn } from "@/lib/utils";
import { DayStamp, JobChip, type JobLinkComponent } from "./bits";
import { LINE, MUTED, PAPER, RING, TODAY_WASH } from "./look";
import { rankDay } from "./dates";

export function MultiDayView({ dates, byDay, today, Link, onPickDay, maxChips }: {
  dates: string[]; byDay: Map<string, PmDay[]>; today: string; Link: JobLinkComponent;
  onPickDay: (d: string) => void;
  /** Week shows this many chips a day, then "+N more" (tap → that day). */
  maxChips?: number;
}) {
  const last = dates.length - 1;
  const key = (x: PmDay) => `${x.lead_id}|${x.username}|${x.task}`;
  const moreBtn = "flex min-h-11 w-full items-center rounded-lg px-2 text-left text-[14px] font-bold text-[#8C6224] hover:bg-[#F8F3E7] active:bg-[#E4DCCB]/60";
  return (
    <>
      {/* Laptop: columns. */}
      <div className={cn("hidden overflow-hidden rounded-2xl sm:block", PAPER, RING)}>
        <div className="grid" style={{ gridTemplateColumns: `repeat(${dates.length}, minmax(0, 1fr))` }}>
          {dates.map((d, i) => (
            <div key={d} className={cn("border-b", LINE, i < last && cn("border-r", LINE), d === today && TODAY_WASH)}>
              <DayStamp day={d} today={today} onClick={() => onPickDay(d)} column />
            </div>
          ))}
          {dates.map((d, i) => {
            const ranked = rankDay(byDay.get(d) || []);
            const cap = maxChips ?? ranked.length;
            return (
              <div key={d} className={cn("min-h-[220px] space-y-1.5 p-1.5", i < last && cn("border-r", LINE), d === today && "bg-[#C9972F]/5")}>
                {ranked.slice(0, cap).map(({ x, n }) => <JobChip key={key(x)} x={x} n={n} Link={Link} />)}
                {ranked.length > cap ? <button type="button" onClick={() => onPickDay(d)} className={moreBtn}>+{ranked.length - cap} more</button> : null}
              </div>
            );
          })}
        </div>
      </div>
      {/* Phone: the same days, top to bottom. */}
      <div className={cn("rounded-2xl sm:hidden", PAPER, RING)}>
        {dates.map((d, i) => {
          const ranked = rankDay(byDay.get(d) || []);
          return (
            <div key={d} className={cn("grid grid-cols-[56px_1fr] gap-1.5 px-2 py-1.5", i > 0 && cn("border-t", LINE),
                                         i === 0 && "rounded-t-2xl", i === last && "rounded-b-2xl", d === today && TODAY_WASH)}>
              <DayStamp day={d} today={today} onClick={() => onPickDay(d)} />
              <div className="min-w-0 space-y-1.5 py-1">
                {ranked.length
                  ? ranked.map(({ x, n }) => <JobChip key={key(x)} x={x} n={n} Link={Link} />)
                  : <p className={cn("flex min-h-11 items-center px-1 text-[15px]", MUTED)}>Nothing on.</p>}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
