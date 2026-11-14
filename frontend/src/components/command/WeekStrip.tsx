// 6. The next 7 days: jobs, crew, money starting, held days still unpaid,
// and the empty days that need selling.
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { NotTracked } from "./ui";
import { money } from "./format";
import type { Week } from "./types";

export default function WeekStrip({ w }: { w: Week }) {
  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {w.days.map((d, i) => {
          const empty = d.empty && !d.sunday;
          return (
            <li key={d.date}>
              <Link
                to="/pm-hq"
                className={cn(
                  "block rounded-xl border p-3 transition hover:border-gold/60",
                  empty ? "border-amber-300 bg-amber-50/70 dark:border-amber-900 dark:bg-amber-950/30" : "bg-background",
                )}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-base font-semibold">{i === 0 ? `Today · ${d.label}` : d.label}</span>
                  <span className="text-sm tabular-nums">
                    {d.jobs ? <><span className="font-semibold">{d.jobs} job{d.jobs === 1 ? "" : "s"}</span>{d.value_starting > 0 && <span className="text-muted-foreground"> · {money(d.value_starting)} starting</span>}</>
                      : <span className={cn(empty ? "font-semibold text-amber-800 dark:text-amber-300" : "text-muted-foreground")}>{empty ? "Nothing booked" : "Off"}</span>}
                  </span>
                </div>
                {(d.crew.length > 0 || d.no_crew.length > 0 || d.held_unpaid.length > 0) && (
                  <div className="mt-1 space-y-0.5 text-sm">
                    {d.crew.length > 0 && <p><span className="text-muted-foreground">Crew: </span>{d.crew.join(", ")}</p>}
                    {d.no_crew.length > 0 && <p className="font-medium text-red-700 dark:text-red-400">No crew yet: {d.no_crew.join(", ")}</p>}
                    {d.held_unpaid.length > 0 && <p className="text-violet-700 dark:text-violet-300">Held, no deposit: {d.held_unpaid.join(", ")}</p>}
                  </div>
                )}
                {d.utilization != null && <p className="mt-1 text-sm text-muted-foreground">{d.utilization}% of daily capacity</p>}
              </Link>
            </li>
          );
        })}
      </ul>
      {!w.capacity_known && <NotTracked>Daily crew capacity isn't set yet, so days show jobs, not % full.</NotTracked>}
    </div>
  );
}
