// The first thing on the Dashboard: everyone who hasn't had an estimate
// since they last came in. Alan (2026-10-11): "the goal is for every lead to
// have an estimate by the end of the day… the first thing all the teams
// see." Same list as Contacts filtered to "never sent", newest first (Alan's
// call), with the attack order printed above it.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ClipboardList, MapPin, MessageSquare, Phone, ChevronDown, ChevronUp, ArrowUpDown } from "lucide-react";
import { api, type ContactRow } from "@/lib/api";
import { cn } from "@/lib/utils";

const STEPS: { t: string; d: string }[] = [
  { t: "Confirm the address", d: "Nothing gets measured until we know the house." },
  { t: "Replied?", d: "Any extra info helps, but never wait on it." },
  { t: "Discovery call", d: "Send the scope of work as you dial so they see we found their property. Walk them through the process." },
  { t: "No answer", d: "Send the scope of work, calculate, send the estimate anyway." },
  { t: "No sides answer", d: "Price the inside faces. A price beats no price; the scope is easy to fix later." },
  { t: "Can't see the house", d: "Check Apple Maps, Google Earth and HAR.com. Overbid the footage a little. Scope only if a fence image exists. Ask for a video." },
];

function waited(iso: string): { label: string; days: number } {
  const t = new Date(iso).getTime();
  if (!t) return { label: "", days: 0 };
  const h = Math.max(0, (Date.now() - t) / 36e5);
  const days = Math.floor(h / 24);
  return { label: h < 1 ? "just now" : h < 24 ? `${Math.floor(h)}h` : `${days}d`, days };
}

export function NoEstimateQueue() {
  const [rows, setRows] = useState<ContactRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [oldestFirst, setOldestFirst] = useState(false);
  const [showSteps, setShowSteps] = useState(true);
  // Days back by when they last filled the form; 0 = everyone ever.
  const [days, setDays] = useState(14);
  const [loadedAt, setLoadedAt] = useState(0);

  const load = useCallback(() => {
    api.listContacts({ estimate: "not_sent", customers_only: true, limit: 500 })
      .then((p) => { setRows(p.contacts); setTotal(p.total); setLoadedAt(Date.now()); })
      .catch(() => setRows([]));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [load]);

  const sorted = useMemo(() => {
    const r = [...(rows || [])];
    const cutoff = days && loadedAt ? loadedAt - days * 864e5 : 0;
    const inWindow = r.filter((c) => !cutoff || new Date(c.last_intake_at || c.date_added || 0).getTime() >= cutoff);
    r.length = 0; r.push(...inWindow);
    r.sort((a, b) => (a.last_intake_at || a.date_added || "").localeCompare(b.last_intake_at || b.date_added || ""));
    return oldestFirst ? r : r.reverse();
  }, [rows, oldestFirst, days, loadedAt]);

  return (
    <div className="overflow-hidden rounded-2xl border-2 border-amber-300 bg-card shadow-sm">
      <div className="flex flex-wrap items-center gap-3 bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-3 text-white">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/20"><ClipboardList className="h-5 w-5" /></div>
        <div className="min-w-0 flex-1">
          <p className="text-lg font-bold leading-tight">
            {rows === null ? "Loading…" : `${sorted.length} ${sorted.length === 1 ? "person needs" : "people need"} an estimate`}
          </p>
          <p className="text-xs text-white/90">Every lead priced by the end of the day. {days ? `Form fills from the last ${days} days` : `All ${total} ever`}.</p>
        </div>
        <div className="flex rounded-lg bg-white/20 p-0.5 text-xs font-semibold">
          {[7, 14, 30, 0].map((d) => (
            <button key={d} type="button" onClick={() => setDays(d)}
              className={cn("h-7 rounded-md px-2", days === d ? "bg-white text-orange-700" : "hover:bg-white/20")}>
              {d ? `${d}d` : "All"}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setOldestFirst((v) => !v)}
          className="inline-flex h-8 items-center gap-1 rounded-lg bg-white/20 px-2.5 text-xs font-semibold hover:bg-white/30">
          <ArrowUpDown className="h-3.5 w-3.5" /> {oldestFirst ? "Oldest first" : "Newest first"}
        </button>
        <Link to="/contacts" className="inline-flex h-8 items-center rounded-lg bg-white px-2.5 text-xs font-bold text-orange-700 hover:bg-white/90">Contacts</Link>
      </div>

      {/* The attack order. Same for every lead. */}
      <div className="border-b border-border bg-amber-50/60 px-4 py-2">
        <button type="button" onClick={() => setShowSteps((v) => !v)} className="flex w-full items-center justify-between text-xs font-bold uppercase tracking-wider text-amber-800">
          How we work every lead {showSteps ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
        {showSteps ? (
          <ol className="mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.t} className="flex gap-2 rounded-lg bg-white px-2.5 py-1.5 text-xs ring-1 ring-amber-200">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500 text-[11px] font-bold text-white">{i + 1}</span>
                <span><b className="text-foreground">{s.t}.</b> <span className="text-muted-foreground">{s.d}</span></span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>

      {rows && rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm font-semibold text-emerald-700">Everyone has an estimate. Nice work.</p>
      ) : (
        <ul className="max-h-[560px] divide-y divide-border overflow-y-auto">
          {sorted.map((c, i) => {
            const w = waited(c.last_intake_at || c.date_added);
            const dials = c.attempt_count || 0;
            const href = c.lead_id ? `/leads/${c.lead_id}` : `/contacts?q=${encodeURIComponent(c.phone || c.name || "")}`;
            return (
              <li key={c.id}>
                <Link to={href} className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40">
                  <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">
                      {c.name || c.phone || c.email || "Unknown"}
                      {c.intake_count > 1 ? <span className="ml-2 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold text-violet-700">came back ×{c.intake_count}</span> : null}
                      {c.opted_out ? <span className="ml-2 rounded bg-stone-200 px-1.5 py-0.5 text-[10px] font-bold text-stone-600">no texts</span> : null}
                    </p>
                    <p className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                      {c.address
                        ? <span className="inline-flex items-center gap-1 truncate"><MapPin className="h-3 w-3" />{c.address}</span>
                        : <span className="inline-flex items-center gap-1 font-semibold text-rose-600"><MapPin className="h-3 w-3" />No address</span>}
                      {c.phone ? <span>{c.phone}</span> : <span className="font-semibold text-rose-600">No phone</span>}
                    </p>
                  </div>
                  <div className="hidden shrink-0 items-center gap-3 text-xs text-muted-foreground sm:flex">
                    <span className="inline-flex items-center gap-1" title="Texts (from them)"><MessageSquare className="h-3 w-3" />{c.message_count}{c.inbound_count ? <b className="text-foreground">({c.inbound_count} in)</b> : null}</span>
                    <span className="inline-flex items-center gap-1" title="Talked / dials"><Phone className="h-3 w-3" />{c.conversation_count}/{dials}</span>
                    <span className="w-28 truncate" title="Pipeline stage">{c.stage || "not on a board"}</span>
                  </div>
                  <span className={cn("w-14 shrink-0 rounded-full px-2 py-0.5 text-center text-xs font-bold tabular-nums",
                    w.days >= 3 ? "bg-rose-100 text-rose-700" : w.days >= 1 ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-700")}
                    title="Waiting since they last came in">
                    {w.label}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
