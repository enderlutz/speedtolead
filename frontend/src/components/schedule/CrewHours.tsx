// Crew hours on Project Manager (Alan, 2026-11-03: "add the tab for the
// workers' hours so I can see all the workers' hours"). A week at a time, one
// card per worker: their total, then each day with start, finish and hours.
// A day they worked (job photos) with no hours logged shows in amber with
// the photo times, so nobody's day goes missing. Cards, not a table: Alan
// reads this on his phone.
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Clock, Loader2 } from "lucide-react";
import { api, type HoursEntry } from "@/lib/api";
import { cn } from "@/lib/utils";
import { addDays, fmt, startOfWeek, toIso } from "./dates";

type Missing = { username: string; name: string; date: string; first: string; last: string };
/** Flat-pay jobs that day (2026-11-05): a day paid only in flats isn't missing. */
type Flat = { username: string; name: string; date: string; total: number; lines: { job: string; task: string; pay: number }[] };
type Data = { start: string; end: string; entries: HoursEntry[]; missing?: Missing[]; flat?: Flat[]; pay_days?: Record<string, string> };
const TASK: Record<string, string> = { cleaning: "cleaning", staining: "staining", repairs: "repairs", pressure_washing: "washing" };
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

const PAY: Record<string, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const clock = (hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
const dayWords = (iso: string) => fmt(iso, { weekday: "short", month: "short", day: "numeric" });
const hrs = (n: number) => `${n % 1 ? n.toFixed(2).replace(/0$/, "") : n} h`;

export function CrewHours() {
  const today = toIso(new Date());
  const [start, setStart] = useState(() => startOfWeek(today));
  const end = addDays(start, 6);
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true;
    setD(null); setErr(false);
    api.getCrewHours(start, end).then((x) => { if (live) setD(x); }).catch(() => { if (live) setErr(true); });
    return () => { live = false; };
  }, [start, end]);

  // One card per worker: logged days and days missing, newest first.
  const people = useMemo(() => {
    if (!d) return [];
    const by = new Map<string, { username: string; name: string; total: number; flat: number; flats: Map<string, Flat>;
      days: (HoursEntry | (Missing & { missing: true }) | (Flat & { flatOnly: true }))[] }>();
    const get = (username: string, name: string) => {
      const k = username.toLowerCase();
      if (!by.has(k)) by.set(k, { username, name, total: 0, flat: 0, flats: new Map(), days: [] });
      return by.get(k)!;
    };
    for (const e of d.entries) { const p = get(e.username, e.name); p.total += e.hours; p.days.push(e); }
    for (const m of d.missing || []) get(m.username, m.name).days.push({ ...m, missing: true });
    for (const f of d.flat || []) {
      const p = get(f.username, f.name);
      p.flat += f.total; p.flats.set(f.date, f);
      if (!p.days.some((x) => x.date === f.date)) p.days.push({ ...f, flatOnly: true });
    }
    const out = [...by.values()];
    for (const p of out) { p.total = Math.round(p.total * 100) / 100; p.days.sort((a, b) => b.date.localeCompare(a.date)); }
    return out.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  }, [d]);
  const weekTotal = people.reduce((t, p) => t + p.total, 0);
  const thisWeek = start === startOfWeek(today);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button type="button" aria-label="Week before" onClick={() => setStart(addDays(start, -7))}
                className="flex h-11 w-11 items-center justify-center rounded-xl border bg-background"><ChevronLeft className="h-5 w-5" /></button>
        <div className="min-w-0 flex-1 text-center">
          <p className="text-base font-bold">{dayWords(start)} – {dayWords(end)}</p>
          <p className="text-sm text-muted-foreground">{thisWeek ? "This week · " : ""}Mon to Sun · {d ? `${hrs(Math.round(weekTotal * 100) / 100)} logged` : "…"}</p>
        </div>
        <button type="button" aria-label="Week after" onClick={() => setStart(addDays(start, 7))} disabled={thisWeek}
                className="flex h-11 w-11 items-center justify-center rounded-xl border bg-background disabled:opacity-30"><ChevronRight className="h-5 w-5" /></button>
      </div>
      <p className="text-sm text-muted-foreground">What each worker typed in on My Hours. Each person's pay week ends on their own pay day.</p>

      {err ? <p className="rounded-xl bg-rose-50 p-3 text-base text-rose-800">Couldn't load the hours. Pull down to refresh.</p>
        : !d ? <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
        : !people.length ? <p className="rounded-xl border bg-background p-4 text-base text-muted-foreground">Nobody logged hours or took job photos this week.</p>
        : people.map((p) => (
          <section key={p.username} className="rounded-2xl border bg-background p-3.5 shadow-sm">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-lg font-bold">{p.name}</p>
              <p className="text-2xl font-black tabular-nums">{hrs(p.total)}</p>
            </div>
            {p.flat ? <p className="text-base font-bold text-emerald-800">+ {usd(Math.round(p.flat * 100) / 100)} flat pay</p> : null}
            {d.pay_days?.[p.username] ? <p className="text-sm text-muted-foreground">Pay day {PAY[d.pay_days[p.username]] || d.pay_days[p.username]}</p> : null}
            <ul className="mt-2 divide-y">
              {p.days.map((x) => "flatOnly" in x ? (
                <li key={`f-${x.date}`} className="flex items-start justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <span className="block text-[15px] font-semibold">{dayWords(x.date)}</span>
                    <FlatLines f={x} />
                  </span>
                  <span className="text-lg font-bold tabular-nums text-emerald-800">{usd(x.total)}</span>
                </li>
              ) : "missing" in x ? (
                <li key={`m-${x.date}`} className="flex items-center justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <span className="block text-[15px] font-semibold">{dayWords(x.date)}</span>
                    <span className="block text-[14px] text-amber-800">Photos {clock(x.first)} – {clock(x.last)} · no hours logged</span>
                  </span>
                  <span className="rounded-lg bg-amber-100 px-2 py-1 text-sm font-bold text-amber-900">Missing</span>
                </li>
              ) : (
                <li key={x.date} className="flex items-center justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <span className="block text-[15px] font-semibold">{dayWords(x.date)}</span>
                    <span className="flex items-center gap-1 text-[14px] text-muted-foreground"><Clock className="h-3.5 w-3.5" />{clock(x.start)} – {clock(x.end)}</span>
                    {x.note ? <span className="block text-[14px] text-muted-foreground">“{x.note}”</span> : null}
                    {p.flats.get(x.date) ? <FlatLines f={p.flats.get(x.date)!} /> : null}
                  </span>
                  <span className={cn("text-lg font-bold tabular-nums")}>{hrs(x.hours)}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}

/** "Flat pay: House A cleaning $60 · House B staining $65" */
function FlatLines({ f }: { f: Flat }) {
  return (
    <span className="block text-[14px] text-emerald-800">
      Flat pay: {f.lines.map((l) => `${l.job} ${TASK[l.task] || l.task} ${usd(l.pay)}`).join(" · ")}
    </span>
  );
}
