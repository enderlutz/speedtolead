/**
 * What to buy (Alan, 2026-10-26): "every single morning we'll have to stop
 * by Lowe's… an hour times two workers." Everything the coming days need,
 * bought ahead in one trip and kept in the storage unit: stain by colour
 * (less what's on the shelf) and the repair wood, with a box to tick once
 * it's bought or set aside. A job with no colour picked is flagged first,
 * because that's what forces a morning run. No prices.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { AlertTriangle, Check, Copy, Loader2, ShoppingCart } from "lucide-react";
import { api, type PmShopJob, type PmShopLine, type PmShopping } from "@/lib/api";
import { cn, errMessage } from "@/lib/utils";
import { addDays } from "@/components/schedule/dates";

const TASK: Record<string, string> = { staining: "Staining", repairs: "Repairs" };
const fmt = (s: string) => new Date(s + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const first = (n: string) => n.split(/\s+/)[0];

function until(day: string, today: string): string {
  const n = Math.round((new Date(day + "T12:00:00").getTime() - new Date(today + "T12:00:00").getTime()) / 86400000);
  return n <= 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`;
}

export function WhatToBuy() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<PmShopping | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    const start = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    api.getPmHqShopping(start, addDays(start, days))
      .then((r) => { if (live) setData(r); })
      .catch((e) => toast.error(errMessage(e, "Couldn't load the list")));
    return () => { live = false; };
  }, [days, tick]);

  if (!data) return <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  const lines = data.jobs.flatMap((j) => j.lines);
  const left = lines.filter((l) => !l.have && !l.blocked).length;
  const noColor = data.jobs.filter((j) => j.lines.some((l) => l.key === "stain" && l.blocked));

  const flip = async (j: PmShopJob, l: PmShopLine) => {
    const have = !l.have;
    setData((d) => d && { ...d, jobs: d.jobs.map((x) => x.lead_id !== j.lead_id ? x : { ...x, lines: x.lines.map((y) => y.key === l.key ? { ...y, have } : y) }) });
    try { await api.pmHqShoppingHave({ lead_id: j.lead_id, key: l.key, label: l.label, have }); }
    catch (e) { toast.error(errMessage(e, "Couldn't save")); }
    setTick((t) => t + 1);
  };

  const copy = async () => {
    const text = "Sterling Fence Staining order:\n" + data.week_list.map((x) => `- ${x.label}`).join("\n");
    try { await navigator.clipboard.writeText(text); toast.success("List copied. Paste it in a text to Lowe's."); }
    catch { toast.error("Couldn't copy"); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="flex items-center gap-2 text-lg font-semibold"><ShoppingCart className="h-5 w-5 text-primary" />What to buy</p>
          <p className="text-[15px] text-muted-foreground">
            Buy it ahead, keep it in the storage unit, and nobody waits at Lowe's in the morning.
          </p>
        </div>
        <div className="flex gap-1 rounded-lg bg-muted/50 p-1">
          {[7, 14].map((n) => (
            <button key={n} type="button" onClick={() => setDays(n)}
                    className={cn("min-h-10 rounded-md px-3 text-sm font-medium", days === n ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}>
              Next {n} days
            </button>
          ))}
        </div>
      </div>

      {!data.jobs.length ? <p className="rounded-xl border bg-card p-4 text-[15px] text-muted-foreground">No staining or repair days coming up.</p> : (
        <p className={cn("rounded-xl px-4 py-3 text-[15px] font-semibold", left ? "bg-amber-50 text-amber-950 ring-1 ring-amber-200" : "bg-green-50 text-green-900 ring-1 ring-green-200")}>
          {left ? `${left} thing${left === 1 ? "" : "s"} still to buy` : "Everything is bought ✓"}
        </p>
      )}

      {noColor.length ? (
        <div className="space-y-1.5 rounded-xl border-l-4 border-l-red-600 bg-red-50 p-3">
          <p className="flex items-center gap-1.5 font-semibold text-red-900"><AlertTriangle className="h-4 w-4" />Pick these colors so the stain can be bought ahead</p>
          {noColor.map((j) => {
            const l = j.lines.find((x) => x.key === "stain")!;
            return (
              <p key={j.lead_id} className="text-[15px] text-red-950">
                <Link to={`/company-cam/${j.lead_id}?view=manager&from=pm-hq`} className="font-semibold underline">{j.name}</Link>
                {" "}stains {fmt(l.need_by)} ({until(l.need_by, data.today)}){l.label.includes("(") ? `: ${l.label.slice(l.label.indexOf("(") + 1, l.label.indexOf(")"))}` : ""}
              </p>
            );
          })}
        </div>
      ) : null}

      {data.week_list.length ? (
        <div className="space-y-2 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold">One trip for everything left</p>
            <button type="button" onClick={() => void copy()}
                    className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium hover:bg-muted">
              <Copy className="h-4 w-4" />Copy for Lowe's
            </button>
          </div>
          <ul className="ml-5 list-disc space-y-0.5 text-[15px]">
            {data.week_list.map((x) => <li key={x.label}>{x.label}</li>)}
          </ul>
        </div>
      ) : null}

      {data.jobs.map((j) => (
        <div key={j.lead_id} className="space-y-2 rounded-xl border bg-card p-4">
          <div>
            <Link to={`/company-cam/${j.lead_id}?view=manager&from=pm-hq`} className="text-base font-semibold hover:underline">{j.name}</Link>
            <p className="text-sm text-muted-foreground">
              {j.days.map((d) => `${fmt(d.date)} · ${TASK[d.task] || d.task}${d.people.length ? ` · ${d.people.map(first).join(" & ")}` : ""}`).join("   |   ")}
            </p>
          </div>
          {j.lines.length ? (
            <ul className="space-y-1.5">
              {j.lines.map((l) => {
                const soon = !l.have && l.need_by <= addDays(data.today, 1);
                return (
                  <li key={l.key}>
                    <button type="button" disabled={l.blocked} onClick={() => void flip(j, l)} aria-pressed={l.have}
                            className={cn("flex min-h-11 w-full items-start gap-3 rounded-lg px-3 py-2 text-left ring-1 transition-colors",
                              l.blocked ? "bg-red-50 ring-red-200" : l.have ? "bg-green-50 ring-green-200" : "bg-background ring-border hover:bg-muted")}>
                      <span className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2",
                        l.have ? "border-green-700 bg-green-700 text-white" : l.blocked ? "border-red-300" : "border-stone-400")}>
                        {l.have ? <Check className="h-4 w-4" /> : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={cn("block text-[15px] font-medium", l.have && "text-green-900 line-through decoration-green-700/50")}>{l.label}</span>
                        <span className="block text-sm text-muted-foreground">
                          {l.have ? `Got it${l.have_by ? ` · ${l.have_by}` : ""}` : [l.note, `needed ${fmt(l.need_by)}`].filter(Boolean).join(" · ")}
                          {soon && !l.blocked ? <b className="text-red-700"> · buy today</b> : null}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : <p className="text-sm text-muted-foreground">Nothing to buy for this one.</p>}
        </div>
      ))}
    </div>
  );
}
