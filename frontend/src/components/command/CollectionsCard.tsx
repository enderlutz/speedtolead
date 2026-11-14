// 7. Payments / collections: deposits to collect, balances out, what's due
// from this week's jobs, and the old QuickBooks balances kept apart (many
// were paid another way and never marked, so they aren't called overdue).
import { useState } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Pill } from "./ui";
import { money } from "./format";
import type { Collections, MoneyRow } from "./types";

type Tab = "deposits" | "balances" | "week" | "qb";

function Row({ r, right }: { r: MoneyRow; right: React.ReactNode }) {
  const body = (
    <div className="flex min-h-11 items-center justify-between gap-3 rounded-lg px-2 py-2 transition hover:bg-muted/60">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold">{r.name || "No name"}</p>
        <div className="text-sm text-muted-foreground">{right}</div>
      </div>
      <span className="shrink-0 text-base font-semibold tabular-nums">{money(r.amount)}</span>
    </div>
  );
  return r.lead_id ? <Link to={`/leads/${r.lead_id}`}>{body}</Link> : body;
}

export default function CollectionsCard({ c }: { c: Collections }) {
  const [tab, setTab] = useState<Tab>("deposits");
  const tabs: { key: Tab; label: string; n: number }[] = [
    { key: "deposits", label: "Deposits due", n: c.deposits.length },
    { key: "balances", label: "Balances out", n: c.balances.length },
    { key: "week", label: "Due this week", n: c.due_this_week.length },
    { key: "qb", label: "QuickBooks", n: c.quickbooks_count },
  ];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Sum label="Deposits due" v={c.deposits_total} />
        <Sum label="Due from this week's jobs" v={c.due_this_week_total} />
        <Sum label="Overdue (7+ days)" v={c.overdue_total} tone={c.overdue_total > 0 ? "red" : undefined} />
        <Sum label="Stripe balances out" v={c.stripe_open_total} />
      </div>
      <p className="text-sm text-muted-foreground">
        Total owed {money(c.owed_total)}, of which {money(c.quickbooks_open_total)} is old QuickBooks balances, many likely paid another way and not marked.
      </p>
      <div className="flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn("min-h-11 rounded-full px-4 text-sm font-semibold transition",
              tab === t.key ? "bg-ink text-white dark:bg-gold dark:text-ink" : "bg-muted hover:bg-muted/70")}
          >
            {t.label} <span className="opacity-70">{t.n}</span>
          </button>
        ))}
      </div>
      <div className="divide-y">
        {tab === "deposits" && (c.deposits.length ? c.deposits.map((r) => (
          <Row key={r.lead_id + r.due} r={r} right={<>Day held {r.due} · job {money(r.job_value)}</>} />
        )) : <Empty />)}
        {tab === "balances" && (c.balances.length ? c.balances.map((r, i) => (
          <Row key={r.lead_id + i} r={r} right={<span className="flex flex-wrap items-center gap-2">
            {r.status} {r.sent ? `· sent ${r.sent}` : ""}{r.days != null ? ` · ${r.days} days` : ""}
            {r.overdue && <Pill tone="red">Overdue</Pill>}
          </span>} />
        )) : <Empty />)}
        {tab === "week" && (c.due_this_week.length ? c.due_this_week.map((r) => (
          <Row key={r.lead_id} r={r} right={<>Job day {r.due} · left to collect</>} />
        )) : <Empty />)}
        {tab === "qb" && (c.quickbooks.length ? <>
          {c.quickbooks.map((r, i) => (
            <Row key={r.name + i} r={r} right={<>Invoice {r.sent}{r.days != null ? ` · ${r.days} days old` : ""}</>} />
          ))}
          {c.quickbooks_count > c.quickbooks.length && (
            <Link to="/money" className="block py-3 text-sm font-semibold underline">All {c.quickbooks_count} on Money</Link>
          )}
        </> : <Empty />)}
      </div>
    </div>
  );
}

function Sum({ label, v, tone }: { label: string; v: number; tone?: "red" }) {
  return (
    <div className={cn("rounded-lg p-3", tone === "red" ? "bg-red-50 dark:bg-red-950/40" : "bg-muted/50")}>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className={cn("text-xl font-bold tabular-nums", tone === "red" && "text-red-700 dark:text-red-300")}>{money(v)}</p>
    </div>
  );
}

function Empty() {
  return <p className="py-3 text-sm text-muted-foreground">Nothing here.</p>;
}
