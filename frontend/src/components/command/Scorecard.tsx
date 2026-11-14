// 1. Owner scorecard: seven numbers, big and plain. "vs last month" compares
// against last month up to the same day, so mid-month numbers are fair.
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { money, pctChange } from "./format";
import type { Scorecard as S } from "./types";

function Change({ now, before, unit = "" }: { now: number; before: number; unit?: string }) {
  const p = pctChange(now, before);
  if (p == null) return <span className="text-sm text-muted-foreground">No last-month number</span>;
  return (
    <span className={cn("text-sm font-medium", p >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400")}>
      {p >= 0 ? "▲" : "▼"} {Math.abs(p)}% vs last month to date{unit}
    </span>
  );
}

function Tile({ label, value, children, to, wide }: {
  label: string; value: React.ReactNode; children?: React.ReactNode; to?: string; wide?: boolean;
}) {
  const body = (
    <div className={cn("flex h-full min-w-0 flex-col gap-1 rounded-xl border bg-card p-4", to && "transition hover:border-gold/60", wide && "col-span-2")}>
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold tabular-nums tracking-tight sm:text-3xl">{value}</p>
      {children}
    </div>
  );
  return to ? <Link to={to} className="contents">{body}</Link> : body;
}

export default function Scorecard({ s }: { s: S }) {
  const pct = s.goal_pct ?? 0;
  const onPace = s.pace >= s.goal;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
      <Tile label="Booked this month" value={money(s.booked)} to="/money">
        <Change now={s.booked} before={s.booked_last_to_date} />
      </Tile>
      <Tile label="Collected this month" value={money(s.collected)} to="/money">
        <Change now={s.collected} before={s.collected_last_to_date} />
      </Tile>
      <Tile label="Monthly goal" value={money(s.goal)}>
        <span className="text-sm text-muted-foreground">
          {s.goal_set ? "Set by you" : "Auto: last month + 25% (no goal set)"}
        </span>
      </Tile>
      <Tile label="Toward goal" value={s.goal_pct == null ? "—" : `${Math.round(pct)}%`}>
        <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full rounded-full bg-gold" style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
        <span className={cn("text-sm", onPace ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400")}>
          Pace: {money(s.pace)} by month end
        </span>
      </Tile>
      <Tile label="Customers owe us" value={money(s.owed)} to="/money">
        <span className="text-sm text-muted-foreground">Open bills, Stripe + QuickBooks</span>
      </Tile>
      <Tile label="Jobs booked" value={s.jobs}>
        <Change now={s.jobs} before={s.jobs_last_to_date} />
      </Tile>
      <Tile label="Average job" value={money(s.avg_job)}>
        <span className="text-sm text-muted-foreground">Booked ÷ jobs, this month</span>
      </Tile>
    </div>
  );
}
