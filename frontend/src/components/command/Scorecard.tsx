// 1. Owner scorecard: seven numbers, big and plain. "vs last month" compares
// against last month up to the same day, so mid-month numbers are fair.
// Tap a number for what it means, what's in it, and where to go next (Alan,
// 2026-11-14: "I want to click that tab and it gives me more context").
import { useState } from "react";
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { money, pctChange } from "./format";
import type { DetailRow, Scorecard as S } from "./types";

type Key = "booked" | "collected" | "goal" | "toward" | "owed" | "jobs" | "avg";

function Change({ now, before }: { now: number; before: number }) {
  const p = pctChange(now, before);
  if (p == null) return <span className="text-sm text-muted-foreground">No last-month number</span>;
  return (
    <span className={cn("text-sm font-medium", p >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400")}>
      {p >= 0 ? "▲" : "▼"} {Math.abs(p)}% vs last month to date
    </span>
  );
}

function Tile({ label, value, children, active, onClick }: {
  label: string; value: React.ReactNode; children?: React.ReactNode; active: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={active}
      className={cn(
        "flex h-full min-h-11 min-w-0 flex-col gap-1 rounded-xl border bg-card p-4 text-left transition hover:border-gold/60",
        active && "border-gold ring-2 ring-gold/30",
      )}
    >
      <p className="text-sm font-medium text-muted-foreground">{label} <span className="text-gold">ⓘ</span></p>
      <p className="text-2xl font-bold tabular-nums tracking-tight sm:text-3xl">{value}</p>
      {children}
    </button>
  );
}

function Rows({ rows, empty }: { rows: DetailRow[]; empty: string }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  const shown = all ? rows : rows.slice(0, 12);
  return (
    <div>
      <ul className="divide-y rounded-lg border bg-background">
        {shown.map((r, i) => {
          const body = (
            <div className="flex min-h-11 items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{r.name || "No name"}</p>
                <p className="text-sm text-muted-foreground">{r.date}{r.note ? ` · ${r.note}` : ""}</p>
              </div>
              <span className="shrink-0 text-sm font-semibold tabular-nums">{money(r.amount)}</span>
            </div>
          );
          return <li key={i}>{r.lead_id ? <Link to={`/leads/${r.lead_id}`} className="block hover:bg-muted/60">{body}</Link> : body}</li>;
        })}
      </ul>
      {rows.length > 12 && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-2 min-h-11 w-full rounded-lg border text-sm font-semibold hover:bg-muted">
          {all ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}

function Detail({ k, s, onClose }: { k: Key; s: S; onClose: () => void }) {
  const goalWords = s.goal_set
    ? `The goal you set for this month: ${money(s.goal)}.`
    : `You haven't set a goal, so the app uses last month (${money(s.last_month)}) plus 25%, rounded: ${money(s.goal)}.`;
  const d: Record<Key, { title: string; what: React.ReactNode; list?: React.ReactNode; to: string; toLabel: string }> = {
    booked: {
      title: "Booked this month",
      what: <>Every customer who <b>paid us anything for the first time this month</b> (a $250 deposit, Klarna, or a bill), counted once at the <b>full job price</b>. It includes jobs not done yet. It does <b>not</b> include held days with no deposit, or jobs nobody has paid on. A deposit in November and the balance in December counts once, in November.</>,
      list: <Rows rows={s.booked_list} empty="Nobody yet this month." />,
      to: "/money", toLabel: "Open Money → Revenue",
    },
    collected: {
      title: "Collected this month",
      what: <>Every dollar that <b>actually came in</b> this month, by the day it landed: Stripe deposits, final balances, Klarna, and payments the office marked "paid another way" (Zelle, cash, check). Stripe {money(s.collected_stripe)} + QuickBooks {money(s.collected_quickbooks)}. <b>Not in it:</b> Zelle or cash nobody marked in the app.</>,
      list: <Rows rows={s.collected_list} empty="No payments yet this month." />,
      to: "/money", toLabel: "Open Money",
    },
    goal: {
      title: "Monthly goal",
      what: <>{goalWords} "Toward goal" compares Booked this month against it.</>,
      to: "/money", toLabel: "Open Money (set the goal there)",
    },
    toward: {
      title: "Toward goal",
      what: <>Booked this month ({money(s.booked)}) ÷ the goal ({money(s.goal)}). <b>Pace</b> = what you've booked per day so far × the days in the month: {money(s.pace)}. {s.pace >= s.goal ? "On pace to hit it." : `Short by about ${money(s.goal - s.pace)} at this pace.`}</>,
      to: "/money", toLabel: "Open Money",
    },
    owed: {
      title: "Customers owe us",
      what: <>Money on jobs we've <b>finished</b> that the customer hasn't paid: open balance or extra links, and QuickBooks balances tied to that customer. <b>Never counted:</b> a $250 deposit link, a financing / pay-in-full link, or a balance on a job we haven't done yet. Never more than what's left on the job. {s.unmatched_quickbooks > 0 && <>Separately, QuickBooks still shows {money(s.unmatched_quickbooks)} on invoices not tied to anyone in the app (old ones and tests). That's not counted; check it in QuickBooks.</>}</>,
      list: <Rows rows={s.owed_list} empty="Nobody owes us on a finished job." />,
      to: "/money", toLabel: "Open Money",
    },
    jobs: {
      title: "Jobs booked",
      what: <>How many customers make up "Booked this month": each one who paid something for the first time this month. Same list as Booked.</>,
      list: <Rows rows={s.booked_list} empty="Nobody yet this month." />,
      to: "/pm-hq", toLabel: "Open Project Manager",
    },
    avg: {
      title: "Average job",
      what: <>Booked this month ÷ jobs booked: {money(s.booked)} ÷ {s.jobs} = {money(s.avg_job)}.</>,
      list: <Rows rows={[...s.booked_list].sort((a, b) => b.amount - a.amount)} empty="Nobody yet this month." />,
      to: "/money", toLabel: "Open Money",
    },
  };
  const x = d[k];
  return (
    <div className="col-span-full rounded-xl border border-gold/50 bg-card p-4 sm:p-5">
      <div className="mb-2 flex items-start justify-between gap-3">
        <h3 className="font-heading text-lg font-semibold">{x.title}: what this means</h3>
        <button type="button" onClick={onClose} aria-label="Close" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-muted">
          <X className="h-5 w-5" />
        </button>
      </div>
      <p className="mb-3 text-base leading-relaxed">{x.what}</p>
      {x.list}
      <Link to={x.to} className="mt-3 inline-flex min-h-11 items-center rounded-lg bg-ink px-4 text-sm font-semibold text-white hover:bg-ink/85 dark:bg-gold dark:text-ink">
        {x.toLabel} →
      </Link>
    </div>
  );
}

export default function Scorecard({ s }: { s: S }) {
  const [open, setOpen] = useState<Key | null>(null);
  const pick = (k: Key) => setOpen((o) => (o === k ? null : k));
  const pct = s.goal_pct ?? 0;
  const onPace = s.pace >= s.goal;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
      <Tile label="Booked this month" value={money(s.booked)} active={open === "booked"} onClick={() => pick("booked")}>
        <Change now={s.booked} before={s.booked_last_to_date} />
      </Tile>
      <Tile label="Collected this month" value={money(s.collected)} active={open === "collected"} onClick={() => pick("collected")}>
        <Change now={s.collected} before={s.collected_last_to_date} />
      </Tile>
      <Tile label="Monthly goal" value={money(s.goal)} active={open === "goal"} onClick={() => pick("goal")}>
        <span className="text-sm text-muted-foreground">{s.goal_set ? "Set by you" : "Auto: last month + 25%"}</span>
      </Tile>
      <Tile label="Toward goal" value={s.goal_pct == null ? "—" : `${Math.round(pct)}%`} active={open === "toward"} onClick={() => pick("toward")}>
        <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full rounded-full bg-gold" style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
        <span className={cn("text-sm", onPace ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400")}>
          Pace: {money(s.pace)} by month end
        </span>
      </Tile>
      <Tile label="Customers owe us" value={money(s.owed)} active={open === "owed"} onClick={() => pick("owed")}>
        <span className="text-sm text-muted-foreground">Finished jobs only</span>
      </Tile>
      <Tile label="Jobs booked" value={s.jobs} active={open === "jobs"} onClick={() => pick("jobs")}>
        <Change now={s.jobs} before={s.jobs_last_to_date} />
      </Tile>
      <Tile label="Average job" value={money(s.avg_job)} active={open === "avg"} onClick={() => pick("avg")}>
        <span className="text-sm text-muted-foreground">Booked ÷ jobs</span>
      </Tile>
      {open && <Detail k={open} s={s} onClose={() => setOpen(null)} />}
    </div>
  );
}
