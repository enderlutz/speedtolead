// 2. Action Center: everything waiting on a person, worst first. Each row
// says what happened, who, how much, how long it has waited, and the one
// button that moves it.
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ActionLink } from "./ui";
import { DOT, STRIPE, money, waited } from "./format";
import type { ActionItem } from "./types";

const GROUPS: { key: string; label: string; kinds: string[] }[] = [
  { key: "all", label: "All", kinds: [] },
  { key: "leads", label: "Leads", kinds: ["new_lead", "need_address", "price_it", "callback", "follow_up", "requote"] },
  { key: "money", label: "Money", kinds: ["deposit", "balance"] },
  { key: "jobs", label: "Jobs", kinds: ["go_back", "inspect"] },
];
const SHOW = 8;

export default function ActionCenter({ items }: { items: ActionItem[] }) {
  const [group, setGroup] = useState("all");
  const [all, setAll] = useState(false);
  const counts = useMemo(() => Object.fromEntries(GROUPS.map((g) => [
    g.key, g.kinds.length ? items.filter((i) => g.kinds.includes(i.kind)).length : items.length,
  ])), [items]);
  const list = useMemo(() => {
    const g = GROUPS.find((x) => x.key === group)!;
    return g.kinds.length ? items.filter((i) => g.kinds.includes(i.kind)) : items;
  }, [items, group]);
  const red = items.filter((i) => i.priority === "red").length;
  const shown = all ? list : list.slice(0, SHOW);

  if (!items.length) {
    return (
      <div className="flex items-center gap-3 rounded-xl bg-emerald-50 p-4 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
        <CheckCircle2 className="h-6 w-6 shrink-0" />
        <p className="text-base font-medium">Nothing waiting on you. Every lead, payment and job is on track.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {GROUPS.map((g) => (
          <button
            key={g.key}
            type="button"
            onClick={() => { setGroup(g.key); setAll(false); }}
            className={cn(
              "min-h-11 rounded-full px-4 text-sm font-semibold transition",
              group === g.key ? "bg-ink text-white dark:bg-gold dark:text-ink" : "bg-muted text-foreground hover:bg-muted/70",
            )}
          >
            {g.label} <span className="tabular-nums opacity-70">{counts[g.key]}</span>
          </button>
        ))}
        {red > 0 && <span className="ml-auto text-sm font-semibold text-red-700 dark:text-red-400">{red} overdue</span>}
      </div>

      <ul className="space-y-2">
        {shown.map((i, n) => (
          <li
            key={`${i.kind}-${i.lead_id}-${n}`}
            className={cn("flex flex-col gap-3 rounded-xl border border-l-4 bg-background p-3 sm:flex-row sm:items-center", STRIPE[i.priority])}
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", DOT[i.priority])} aria-hidden />
                <span className="text-base font-semibold">{i.who || "—"}</span>
                {i.amount ? <span className="text-sm font-semibold tabular-nums">{money(i.amount)}</span> : null}
              </div>
              <p className="text-sm">{i.title}</p>
              <p className="text-sm text-muted-foreground">
                {i.waiting_hours != null && <>Waiting {waited(i.waiting_hours)}</>}
                {i.waiting_hours != null && i.detail ? " · " : ""}
                {i.detail && <span className="break-words">{i.detail}</span>}
              </p>
            </div>
            {i.href ? (
              <ActionLink to={i.href} tone={i.priority === "red" ? "primary" : "neutral"} className="w-full sm:w-auto">
                {i.action}
              </ActionLink>
            ) : null}
          </li>
        ))}
      </ul>

      {list.length > SHOW && (
        <button type="button" onClick={() => setAll((v) => !v)} className="min-h-11 w-full rounded-lg border text-sm font-semibold hover:bg-muted">
          {all ? "Show fewer" : `Show all ${list.length}`}
        </button>
      )}
      <p className="text-sm text-muted-foreground">
        Older replies and opens stay on <Link to="/on-call" className="underline">On call</Link>; this list shows the last 3 days.
      </p>
    </div>
  );
}
