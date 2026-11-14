// 4. Sales pipeline: how many leads sit at each step and the money on them,
// with the stuck step called out and a button to work it.
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { ActionLink } from "./ui";
import { money } from "./format";
import type { Pipeline } from "./types";

export default function PipelineCard({ p }: { p: Pipeline }) {
  const max = Math.max(1, ...p.stages.map((s) => s.count));
  return (
    <div className="space-y-4">
      {p.bottleneck && (
        <div className="flex flex-col gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40 sm:flex-row sm:items-center">
          <p className="flex-1 text-sm font-medium text-amber-950 dark:text-amber-100">
            <span className="font-semibold">Stuck here: </span>{p.bottleneck.text}
          </p>
          <ActionLink to={p.bottleneck.href} tone="primary" className="w-full sm:w-auto">{p.bottleneck.action}</ActionLink>
        </div>
      )}
      <ol className="space-y-2">
        {p.stages.map((s) => (
          <li key={s.key}>
            <Link to={s.href} className="block rounded-lg p-2 transition hover:bg-muted/60">
              <div className="flex items-baseline justify-between gap-2">
                <span className={cn("text-sm font-semibold", p.bottleneck?.key === s.key && "text-amber-800 dark:text-amber-300")}>{s.label}</span>
                <span className="text-sm tabular-nums">
                  <span className="font-semibold">{s.count}</span>
                  {s.value > 0 && <span className="text-muted-foreground"> · {money(s.value)}</span>}
                </span>
              </div>
              <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
                <div
                  className={cn("h-full rounded-full", p.bottleneck?.key === s.key ? "bg-amber-500" : s.key === "booked" || s.key === "done" ? "bg-emerald-600" : "bg-ink/70 dark:bg-gold/80")}
                  style={{ width: `${Math.max(2, (s.count / max) * 100)}%` }}
                />
              </div>
              {s.avg_days != null && (
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {s.key === "done" ? "Finished" : "Average"} {s.avg_days} day{s.avg_days === 1 ? "" : "s"} {s.key === "done" ? "ago" : "here"}
                </p>
              )}
            </Link>
          </li>
        ))}
      </ol>
      <p className="text-sm text-muted-foreground">{p.note}</p>
    </div>
  );
}
