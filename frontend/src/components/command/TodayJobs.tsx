// 3. Today's jobs: one card per job on today's crew calendar, problems in
// red. The app keeps a stop order, not a start time, so the order shows.
import { Link } from "react-router-dom";
import { CalendarCheck2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Pill } from "./ui";
import { money } from "./format";
import type { TodayJob, WeekDay } from "./types";

const ORD = ["", "1st stop", "2nd stop", "3rd stop", "4th stop", "5th stop"];

export default function TodayJobs({ jobs, next }: { jobs: TodayJob[]; next?: WeekDay }) {
  if (!jobs.length) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-3 rounded-xl bg-muted/60 p-4">
          <CalendarCheck2 className="h-6 w-6 shrink-0 text-muted-foreground" />
          <p className="text-base">No crew on a job today.</p>
        </div>
        {next && (
          <p className="text-sm text-muted-foreground">
            Next job day: <span className="font-semibold text-foreground">{next.label}</span> · {next.jobs} job{next.jobs === 1 ? "" : "s"}
            {next.crew.length ? ` · ${next.crew.join(", ")}` : ""}
          </p>
        )}
      </div>
    );
  }
  return (
    <ul className="space-y-3">
      {jobs.map((j) => {
        const problem = j.blockers.length > 0 && !j.done;
        return (
          <li key={j.lead_id}>
            <Link
              to={`/company-cam/${j.lead_id}`}
              className={cn(
                "block rounded-xl border p-3 transition hover:border-gold/60",
                problem ? "border-red-300 bg-red-50/60 dark:border-red-900 dark:bg-red-950/30" : "bg-background",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm text-muted-foreground">{ORD[j.order ?? 0] || "Stop not set"}</p>
                  <p className="text-base font-semibold">{j.name}</p>
                  <p className="truncate text-sm text-muted-foreground">{j.address || "No address"}</p>
                </div>
                <Pill tone={j.done ? "green" : problem ? "red" : "blue"}>{j.status}</Pill>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <span>
                  <span className="text-muted-foreground">Crew: </span>
                  {j.crew.map((c) => `${c.person}${c.helper ? " (helper)" : ""}`).join(", ") || "none"}
                </span>
                <span><span className="text-muted-foreground">Work: </span>{[...j.tasks, ...j.services].join(", ") || "—"}</span>
                {j.color && <span><span className="text-muted-foreground">Color: </span>{j.color}</span>}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm tabular-nums">
                <span><span className="text-muted-foreground">Job </span>{money(j.value)}</span>
                <span><span className="text-muted-foreground">Paid </span>{money(j.paid)}</span>
                <span className={cn(j.left ? "font-semibold" : "")}><span className="font-normal text-muted-foreground">Left </span>{money(j.left)}</span>
              </div>
              {problem && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {j.blockers.map((b) => <Pill key={b} tone="red">{b}</Pill>)}
                </div>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
