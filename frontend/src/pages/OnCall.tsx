// On call for new leads (Alan, 2026-10-19): somebody owns every new lead
// 8 AM–8 PM and calls within 5 minutes. Now = who's on and the leads
// waiting, with a clock; Schedule = the week (changes week to week);
// Scorecard = speed to lead per person; Team = where alerts go (admin).
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Check, ChevronLeft, ChevronRight, Copy, Loader2, MapPin, PhoneCall, Plus, Send, Trash2 } from "lucide-react";
import {
  api, getCurrentUser,
  type OnCallBreak, type OnCallLead, type OnCallLogRow, type OnCallMyShift, type OnCallTodoRow, type OnCallPerson, type OnCallScore, type OnCallShift,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { errMessage } from "@/lib/utils";

type Tab = "now" | "schedule" | "score" | "report" | "team";

const ymd = (d: Date) => d.toLocaleDateString("en-CA");
function monday(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const hhmm = (m: number) => {
  const h = Math.floor(m / 60), mm = m % 60, ap = h >= 12 ? "pm" : "am";
  return `${((h + 11) % 12) + 1}${mm ? `:${String(mm).padStart(2, "0")}` : ""}${ap}`;
};
/** Stretches of 8 AM–8 PM nobody covers, as [start, end] minute pairs. */
function coverageGaps(shifts: { start_min: number; end_min: number }[]): [number, number][] {
  const out: [number, number][] = [];
  let t = 8 * 60;
  for (const s of [...shifts].sort((a, b) => a.start_min - b.start_min)) {
    if (s.start_min > t && t < 20 * 60) out.push([t, Math.min(s.start_min, 20 * 60)]);
    t = Math.max(t, s.end_min);
  }
  if (t < 20 * 60) out.push([t, 20 * 60]);
  return out;
}
const TIMES = Array.from({ length: 33 }, (_, i) => 6 * 60 + i * 30);   // 6am–10pm, half hours

export default function OnCall() {
  const isAdmin = getCurrentUser()?.role === "admin";
  const [tab, setTab] = useState<Tab>("now");
  const btn = (k: Tab, label: string) => (
    <button key={k} type="button" onClick={() => setTab(k)}
            className={`min-h-10 flex-1 rounded-md px-2 text-sm font-semibold ${tab === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>
      {label}
    </button>
  );
  return (
    <div className={`mx-auto space-y-4 p-4 sm:p-6 ${tab === "now" ? "max-w-6xl" : "max-w-3xl"}`}>
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold"><PhoneCall className="h-5 w-5 text-primary" /> On call</h1>
        <p className="text-sm text-muted-foreground">Every new lead 8 AM–8 PM goes to whoever is on call. Call within 5 minutes.</p>
      </div>
      <div className="flex gap-1 rounded-lg bg-muted/50 p-1">
        {btn("now", "Now")}
        {btn("schedule", "Schedule")}
        {isAdmin ? btn("score", "Scorecard") : null}
        {isAdmin ? btn("report", "Report") : null}
        {isAdmin ? btn("team", "Team") : null}
      </div>
      {tab === "now" ? <NowPanel /> : null}
      {tab === "schedule" ? <SchedulePanel isAdmin={isAdmin} /> : null}
      {tab === "score" && isAdmin ? <ScorePanel /> : null}
      {tab === "report" && isAdmin ? <ReportPanel /> : null}
      {tab === "team" && isAdmin ? <TeamPanel /> : null}
    </div>
  );
}

function Clock({ since, now }: { since: string; now: number }) {
  const secs = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  const late = secs >= 300;
  const m = Math.floor(secs / 60), s = secs % 60;
  return (
    <span className={`rounded-lg px-2 py-1 text-sm font-bold tabular-nums ${late ? "bg-rose-600 text-white" : secs >= 180 ? "bg-amber-400 text-amber-950" : "bg-emerald-600 text-white"}`}>
      {m}:{String(s).padStart(2, "0")}
    </span>
  );
}

function NowPanel() {
  const [who, setWho] = useState<{ in_hours: boolean; on_call: OnCallPerson[]; me?: OnCallMyShift } | null>(null);
  const [leads, setLeads] = useState<OnCallLead[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    api.onCallNow().then((r) => { if (live) setWho(r); }).catch(() => {});
    api.onCallQueue().then((r) => { if (live) setLeads(r.leads); }).catch(() => { if (live) setLeads([]); });
    return () => { live = false; };
  }, [tick]);
  useEffect(() => {
    const a = setInterval(() => setNow(Date.now()), 1000);
    const b = setInterval(() => setTick((x) => x + 1), 15000);
    return () => { clearInterval(a); clearInterval(b); };
  }, []);
  const called = async (id: string) => {
    try { await api.onCallCalled(id); setLeads((l) => (l || []).filter((x) => x.lead_id !== id)); toast.success("Clock stopped"); }
    catch (e) { toast.error(errMessage(e, "Couldn't save")); }
  };
  const waitingNow = (leads || []).filter((l) => !l.waiting_for_morning);
  const morning = (leads || []).filter((l) => l.waiting_for_morning);

  return (
    <div className="space-y-3">
      {who?.me ? <MyShift me={who.me} now={now} /> : null}
      <Breaks onCallNow={!!who?.me?.current} tick={tick} onChanged={() => setTick((x) => x + 1)} />
      <div className={`rounded-xl p-3 text-sm font-semibold ${!who ? "bg-muted" : !who.in_hours ? "bg-slate-800 text-white" : who.on_call.length ? "bg-emerald-50 text-emerald-950 ring-1 ring-emerald-200" : "bg-rose-50 text-rose-900 ring-1 ring-rose-200"}`}>
        {!who ? "Loading…" : !who.in_hours ? "After hours. New leads wait for the 8 AM list."
          : who.on_call.length ? `On call now: ${who.on_call.map((p) => p.name).join(" & ")}` : "Nobody is on call right now. Add someone on the Schedule tab."}
      </div>
      {leads === null ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {leads && !leads.length ? <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">Every new lead has been called. 🎉</p> : null}
      {waitingNow.map((l) => (
        <div key={l.lead_id} className={`rounded-xl border p-3 ${l.late_alerted ? "border-rose-300 bg-rose-50/50" : "border-border bg-card"}`}>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <Link to={`/leads/${l.lead_id}`} className="block truncate text-base font-semibold capitalize underline-offset-2 hover:underline">{(l.name || "New lead").toLowerCase()}</Link>
              {l.address ? <p className="flex items-center gap-1 truncate text-xs text-muted-foreground"><MapPin className="h-3 w-3 shrink-0" />{l.address}</p> : null}
              <p className="text-xs text-muted-foreground">
                {[l.fence_height, l.fence_age, l.timeline].filter(Boolean).join(" · ")}{l.on_call ? ` · on call: ${l.on_call}` : ""}
              </p>
            </div>
            {l.clock_started ? <Clock since={l.clock_started} now={now} /> : null}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Link to={`/leads/${l.lead_id}`} className="flex min-h-11 items-center justify-center rounded-lg border text-sm font-semibold">Profile</Link>
            <Button className="min-h-11" onClick={() => called(l.lead_id)}><Check className="mr-1 h-4 w-4" /> I called</Button>
          </div>
        </div>
      ))}
      {morning.length ? (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Waiting for 8 AM ({morning.length})</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {morning.map((l) => (
              <div key={l.lead_id} className="flex items-center gap-2 text-sm">
                <Link to={`/leads/${l.lead_id}`} className="flex-1 truncate font-semibold capitalize underline-offset-2 hover:underline">{(l.name || "Lead").toLowerCase()}</Link>
                <span className="text-xs text-muted-foreground">{l.phone}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
      <TodoLists />
    </div>
  );
}

const fmtMin = (m: number) => {
  const h = Math.floor(m / 60), mm = m % 60, h12 = ((h + 11) % 12) + 1;
  return `${h12}${mm ? `:${String(mm).padStart(2, "0")}` : ""} ${h < 12 || h === 24 ? "AM" : "PM"}`;
};
const fmtLeft = (ms: number) => {
  const mins = Math.max(0, Math.ceil(ms / 60000)), h = Math.floor(mins / 60), m = mins % 60;
  return h ? `${h}h ${m}m` : `${m} min`;
};

/** My shift today and how long is left (Alan, 2026-10-19). */
function MyShift({ me, now }: { me: OnCallMyShift; now: number }) {
  const all = me.shifts.map((s) => `${fmtMin(s.start_min)}–${fmtMin(s.end_min)}`).join(", ");
  if (me.current) {
    const start = new Date(me.current.starts_at).getTime(), end = new Date(me.current.ends_at).getTime();
    const pct = Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100));
    return (
      <div className="rounded-xl bg-primary/10 p-3 ring-1 ring-primary/30">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-semibold">You're on call · {fmtMin(me.current.start_min)}–{fmtMin(me.current.end_min)}</p>
          <p className="text-2xl font-bold tabular-nums text-primary">{fmtLeft(end - now)} <span className="text-sm font-semibold text-muted-foreground">left</span></p>
        </div>
        <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-background">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
        {me.next ? <p className="mt-1.5 text-xs text-muted-foreground">Back on at {fmtMin(me.next.start_min)}.</p> : null}
      </div>
    );
  }
  if (me.next) {
    return (
      <div className="rounded-xl bg-muted p-3 text-sm">
        <span className="font-semibold">Your shift starts at {fmtMin(me.next.start_min)}</span>
        <span className="text-muted-foreground"> · in {fmtLeft(new Date(me.next.starts_at).getTime() - now)} · today: {all}</span>
      </div>
    );
  }
  return (
    <div className="rounded-xl bg-muted p-3 text-sm text-muted-foreground">
      {me.shifts.length ? `Your shift is over for today (${all}).` : "You're not on the schedule today."}
    </div>
  );
}

/** "Can someone cover me?" (Alan, 2026-10-19). Ask for 15–60 minutes; the
 *  team gets a text; whoever taps "I'll take it" is on for the window and
 *  the leads come back to you after it. Until someone takes it, they're yours. */
function Breaks({ onCallNow, tick, onChanged }: { onCallNow: boolean; tick: number; onChanged: () => void }) {
  const me = getCurrentUser()?.sub || "";
  const [rows, setRows] = useState<OnCallBreak[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api.onCallBreaks().then((r) => { if (live) setRows(r.breaks); }).catch(() => {});
    return () => { live = false; };
  }, [tick]);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast.success(ok); onChanged(); }
    catch (e) { toast.error(errMessage(e, "Something went wrong")); } finally { setBusy(false); }
  };
  const mine = rows.find((b) => b.username === me && b.status === "open");
  const mineTaken = rows.find((b) => b.username === me && b.status === "taken");
  const others = rows.filter((b) => b.username !== me && b.status === "open");
  const covering = rows.filter((b) => b.taken_by === me);
  return (
    <>
      {others.map((b) => (
        <div key={b.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-amber-100 p-3 text-amber-950 ring-1 ring-amber-300">
          <p className="flex-1 text-sm font-semibold">{b.name} needs a break. Can you take new leads {fmtMin(b.start_min)}–{fmtMin(b.end_min)}?</p>
          <Button disabled={busy} className="min-h-11" onClick={() => run(() => api.onCallTakeBreak(b.id), `You're on until ${fmtMin(b.end_min)}`)}>
            <Check className="mr-1 h-4 w-4" /> I'll take it
          </Button>
        </div>
      ))}
      {covering.map((b) => (
        <p key={b.id} className="rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-950 ring-1 ring-emerald-200">
          You're covering for {b.name} until {fmtMin(b.end_min)}. New leads come to you.
        </p>
      ))}
      {mineTaken ? (
        <p className="rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-950 ring-1 ring-emerald-200">
          {mineTaken.taken_by_name} is covering you until {fmtMin(mineTaken.end_min)}. Leads come back to you after that.
        </p>
      ) : mine ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-muted p-3">
          <p className="flex-1 text-sm"><span className="font-semibold">Asked for cover {fmtMin(mine.start_min)}–{fmtMin(mine.end_min)}.</span> Waiting for someone to take it. Until then, new leads are still yours.</p>
          <Button variant="outline" disabled={busy} onClick={() => run(() => api.onCallCancelBreak(mine.id), "Break cancelled")}>Cancel</Button>
        </div>
      ) : onCallNow ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed p-3">
          <span className="text-sm font-semibold">Need a break?</span>
          {[15, 25, 30, 60].map((m) => (
            <Button key={m} size="sm" variant="outline" disabled={busy} className="min-h-10"
                    onClick={() => run(() => api.onCallAskBreak(m), "Asked the team to cover you")}>{m} min</Button>
          ))}
        </div>
      ) : null}
    </>
  );
}

const TONE_DOT: Record<string, string> = { hot: "bg-rose-500", warm: "bg-amber-400", cold: "bg-slate-300", off: "bg-slate-300" };

/** Between calls: who needs an estimate (left) and who to follow up with
 *  (right). Same next steps as the Contacts page; last 30 days. */
function TodoLists() {
  const [data, setData] = useState<{ estimates: OnCallTodoRow[]; follow_ups: OnCallTodoRow[] } | null>(null);
  const load = useCallback(() => {
    api.onCallTodo().then(setData).catch((e) => toast.error(errMessage(e, "Couldn't load the to-do lists")));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);
  const drop = (id: string) => setData((d) => d && {
    estimates: d.estimates.filter((r) => r.lead_id !== id), follow_ups: d.follow_ups.filter((r) => r.lead_id !== id),
  });
  if (!data) return <p className="text-sm text-muted-foreground"><Loader2 className="mr-1 inline h-4 w-4 animate-spin" />Loading your to-do lists…</p>;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <TodoColumn title="Need an estimate" sub="Talked but not priced first, then new leads, then no address." rows={data.estimates} accent="border-t-sky-500" onRemoved={drop} />
      <TodoColumn title="Follow up" sub="Call-back days first, then replies, then opened it, then not opened." rows={data.follow_ups} accent="border-t-emerald-500" onRemoved={drop} />
    </div>
  );
}

function FreshTimer({ since, nowMs }: { since: string; nowMs: number }) {
  const sec = Math.max(0, Math.floor((nowMs - new Date(since).getTime()) / 1000));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const text = h ? `${h}h ${m}m` : `${m}:${String(s).padStart(2, "0")}`;
  // Green the first 5 minutes, amber to 15, red after.
  const color = sec < 300 ? "bg-emerald-100 text-emerald-800" : sec < 900 ? "bg-amber-100 text-amber-800" : "bg-rose-100 text-rose-700";
  return <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums ${color}`} title="Since they filled the form">⏱ {text}</span>;
}

function TodoColumn({ title, sub, rows, accent, onRemoved }: {
  title: string; sub: string; rows: OnCallTodoRow[]; accent: string; onRemoved: (id: string) => void;
}) {
  const notALead = async (r: OnCallTodoRow) => {
    if (!window.confirm(`Take ${r.name || "this one"} off the lists? (Not a lead: a worker, a wrong number, spam.)`)) return;
    try { await api.onCallNotALead(r.lead_id); onRemoved(r.lead_id); toast.success("Taken off the lists"); }
    catch (e) { toast.error(errMessage(e, "Couldn't do that")); }
  };
  // The "Just came in" timer ticks every second.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const anyFresh = rows.some((r) => r.key === "fresh");
  useEffect(() => {
    if (!anyFresh) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyFresh]);
  // Grouped by where they are, in the order the server ranked them.
  const groups = useMemo(() => {
    const m = new Map<string, OnCallTodoRow[]>();
    for (const r of rows) { if (!m.has(r.stage)) m.set(r.stage, []); m.get(r.stage)!.push(r); }
    return [...m.entries()];
  }, [rows]);
  return (
    <div className={`flex flex-col rounded-xl border border-t-4 bg-card ${accent}`}>
      <div className="border-b p-3">
        <p className="text-base font-semibold">{title} <span className="text-sm font-normal text-muted-foreground">({rows.length})</span></p>
        <p className="text-xs text-muted-foreground">{sub}</p>
      </div>
      <div className="max-h-[70vh] overflow-y-auto">
        {!rows.length ? <p className="p-6 text-center text-sm text-muted-foreground">Nothing here. 🎉</p> : null}
        {groups.map(([stage, list]) => (
          <div key={stage}>
            <p className="sticky top-0 z-[1] flex items-center gap-1.5 bg-muted/90 px-3 py-1.5 text-xs font-semibold backdrop-blur">
              <span className={`h-2 w-2 rounded-full ${TONE_DOT[list[0].tone] ?? TONE_DOT.cold}`} />{stage} · {list.length}
            </p>
            {list.map((r) => (
              <div key={r.lead_id} className="flex items-center gap-2 border-b px-3 py-2 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Link to={`/leads/${r.lead_id}`} className="truncate text-sm font-semibold underline-offset-2 hover:underline">{r.name || "No name"}</Link>
                    {r.key === "fresh" ? <FreshTimer since={r.came_in} nowMs={nowMs} /> : null}
                    {r.key === "fresh" && r.refill ? <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800">filled again</span> : null}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{r.next}{r.address ? ` · ${r.address}` : ""}</p>
                </div>
                <button type="button" onClick={() => void notALead(r)} title="Not a lead (worker, wrong number, spam)"
                        className="shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold text-muted-foreground hover:bg-muted hover:text-rose-700">
                  Not a lead
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function SchedulePanel({ isAdmin }: { isAdmin: boolean }) {
  const [week, setWeek] = useState(() => monday(new Date()));
  const [shifts, setShifts] = useState<OnCallShift[]>([]);
  const [people, setPeople] = useState<OnCallPerson[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ username: string; start_min: number; end_min: number }[]>([]);
  const [tick, setTick] = useState(0);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(week, i)), [week]);
  const load = useCallback(() => setTick((x) => x + 1), []);
  useEffect(() => {
    let live = true;
    api.onCallSchedule(ymd(days[0]), ymd(days[6])).then((r) => { if (live) { setShifts(r.shifts); setPeople(r.people); } }).catch(() => {});
    return () => { live = false; };
  }, [days, tick]);
  const name = (u: string) => people.find((p) => p.username === u)?.name || u;

  const startEdit = (d: string) => {
    setEditing(d);
    const mine = shifts.filter((s) => s.date === d).map((s) => ({ username: s.username, start_min: s.start_min, end_min: s.end_min }));
    setDraft(mine.length ? mine : [{ username: people[0]?.username || "", start_min: 480, end_min: 1200 }]);
  };
  const saveDay = async () => {
    if (!editing) return;
    try { await api.onCallSetDay(editing, draft.filter((s) => s.username)); setEditing(null); load(); toast.success("Saved"); }
    catch (e) { toast.error(errMessage(e, "Couldn't save")); }
  };
  const copyLast = async () => {
    if (!confirm("Copy last week's schedule onto this week? This week's shifts are replaced.")) return;
    try { const r = await api.onCallCopyWeek(ymd(addDays(week, -7)), ymd(week)); load(); toast.success(`Copied ${r.copied} shifts`); }
    catch (e) { toast.error(errMessage(e, "Couldn't copy")); }
  };
  const sel = "h-10 rounded-md border border-input bg-background px-2 text-sm";

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={() => setWeek(addDays(week, -7))}><ChevronLeft className="h-4 w-4" /></Button>
          <CardTitle className="text-sm">Week of {week.toLocaleDateString([], { month: "short", day: "numeric" })}</CardTitle>
          <Button variant="ghost" size="sm" onClick={() => setWeek(addDays(week, 7))}><ChevronRight className="h-4 w-4" /></Button>
        </div>
        {isAdmin ? <Button variant="outline" size="sm" className="mt-1" onClick={copyLast}><Copy className="mr-1 h-3.5 w-3.5" /> Copy last week</Button> : null}
      </CardHeader>
      <CardContent className="divide-y">
        {days.map((d) => {
          const key = ymd(d);
          const todays = shifts.filter((s) => s.date === key);
          const covered = todays.length > 0;
          const gaps = coverageGaps(todays);
          return (
            <div key={key} className="py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">{d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}</span>
                {isAdmin && editing !== key ? <Button size="sm" variant="ghost" onClick={() => startEdit(key)}>Edit</Button> : null}
              </div>
              {editing === key ? (
                <div className="mt-2 space-y-2">
                  {draft.map((s, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <select className={sel} value={s.username} onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, username: e.target.value } : x)))}>
                        <option value="">Who?</option>
                        {people.map((p) => <option key={p.username} value={p.username}>{p.name}</option>)}
                      </select>
                      <select className={sel} value={s.start_min} onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, start_min: Number(e.target.value) } : x)))}>
                        {TIMES.map((t) => <option key={t} value={t}>{hhmm(t)}</option>)}
                      </select>
                      <span className="text-xs">to</span>
                      <select className={sel} value={s.end_min} onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, end_min: Number(e.target.value) } : x)))}>
                        {TIMES.map((t) => <option key={t} value={t}>{hhmm(t)}</option>)}
                      </select>
                      <button type="button" onClick={() => setDraft(draft.filter((_, j) => j !== i))} className="p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  ))}
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => setDraft([...draft, { username: "", start_min: 840, end_min: 1200 }])}><Plus className="mr-1 h-3.5 w-3.5" /> Add someone</Button>
                    <Button size="sm" onClick={saveDay}>Save day</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                  </div>
                </div>
              ) : covered ? (
                <>
                  <ul className="mt-1 space-y-0.5">
                    {todays.map((s) => <li key={s.id} className="text-sm tabular-nums">{name(s.username)} · {hhmm(s.start_min)}–{hhmm(s.end_min)}</li>)}
                  </ul>
                  {gaps.map(([a, b]) => <p key={a} className="text-sm font-semibold text-rose-700">Gap: nobody on {hhmm(a)}–{hhmm(b)}</p>)}
                </>
              ) : <p className="mt-1 text-sm font-semibold text-rose-700">Nobody on call</p>}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function ScorePanel() {
  const ranges = useMemo(() => {
    const today = new Date(), mon = monday(today);
    return {
      "This week": [ymd(mon), ymd(addDays(mon, 6))],
      "Last week": [ymd(addDays(mon, -7)), ymd(addDays(mon, -1))],
      "This month": [ymd(new Date(today.getFullYear(), today.getMonth(), 1)), ymd(today)],
    } as Record<string, [string, string]>;
  }, []);
  const [pick, setPick] = useState("This week");
  const [rows, setRows] = useState<OnCallScore[] | null>(null);
  useEffect(() => {
    let live = true;
    const [a, b] = ranges[pick];
    api.onCallScorecard(a, b).then((r) => { if (live) setRows(r.rows); }).catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, [pick, ranges]);
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap gap-2">
          {Object.keys(ranges).map((k) => (
            <button key={k} type="button" onClick={() => setPick(k)}
                    className={`min-h-9 rounded-full border px-3 text-sm font-semibold ${pick === k ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}>{k}</button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows === null ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {rows && !rows.length ? <p className="text-sm text-muted-foreground">No leads handed out yet in this range.</p> : null}
        {(rows || []).map((r) => (
          <div key={r.username} className="rounded-xl border p-3">
            <p className="text-base font-semibold">{r.name}</p>
            <div className="mt-2 grid grid-cols-2 gap-2 text-center sm:grid-cols-5">
              {([["Leads", String(r.leads)], ["Called ≤5 min", `${r.within_5_pct}%`], ["Avg to call", r.avg_minutes === null ? "–" : `${r.avg_minutes} min`],
                 ["Missed", String(r.missed)], ["Close rate", `${r.close_pct}%`]] as const).map(([l, v]) => (
                <div key={l} className="rounded-lg bg-muted/50 p-2">
                  <p className="text-[11px] font-semibold uppercase text-muted-foreground">{l}</p>
                  <p className={`text-lg font-bold tabular-nums ${l === "Called ≤5 min" ? (r.within_5_pct >= 80 ? "text-emerald-700" : "text-rose-700") : ""}`}>{v}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">Missed = no call within an hour. Close rate = leads that paid.</p>
      </CardContent>
    </Card>
  );
}

const FLAG: Record<OnCallLogRow["flag"], { label: string; cls: string }> = {
  on_time: { label: "On time", cls: "bg-emerald-100 text-emerald-900" },
  late: { label: "Late", cls: "bg-amber-100 text-amber-900" },
  missed: { label: "Missed", cls: "bg-rose-600 text-white" },
  waiting: { label: "Waiting", cls: "bg-slate-200 text-slate-800" },
};

/** Admin only (Cruz, 2026-10-19): every lead, its time to the first call,
 *  and a flag when it went past 5 minutes, like a drive-thru timer. */
function ReportPanel() {
  const ranges = useMemo(() => {
    const today = new Date(), mon = monday(today);
    return {
      Today: [ymd(today), ymd(today)],
      "This week": [ymd(mon), ymd(addDays(mon, 6))],
      "Last week": [ymd(addDays(mon, -7)), ymd(addDays(mon, -1))],
      "This month": [ymd(new Date(today.getFullYear(), today.getMonth(), 1)), ymd(today)],
    } as Record<string, [string, string]>;
  }, []);
  const [pick, setPick] = useState("Today");
  const [only, setOnly] = useState<"all" | "flagged">("all");
  const [rows, setRows] = useState<OnCallLogRow[] | null>(null);
  useEffect(() => {
    let live = true;
    const [a, b] = ranges[pick];
    api.onCallReport(a, b).then((r) => { if (live) setRows(r.leads); }).catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, [pick, ranges]);
  const counts = useMemo(() => {
    const c = { on_time: 0, late: 0, missed: 0, waiting: 0 };
    for (const r of rows || []) c[r.flag] += 1;
    return c;
  }, [rows]);
  const flaggedBy = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of rows || []) if (r.flag === "late" || r.flag === "missed") m[r.on_call] = (m[r.on_call] || 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [rows]);
  const shown = (rows || []).filter((r) => only === "all" || r.flag === "late" || r.flag === "missed");
  const total = (rows || []).length;
  const when = (iso: string) => (iso ? new Date(iso).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "");

  return (
    <Card>
      <CardHeader className="space-y-2 pb-2">
        <div className="flex flex-wrap gap-2">
          {Object.keys(ranges).map((k) => (
            <button key={k} type="button" onClick={() => setPick(k)}
                    className={`min-h-9 rounded-full border px-3 text-sm font-semibold ${pick === k ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}>{k}</button>
          ))}
        </div>
        <div className="grid grid-cols-4 gap-2 text-center">
          {(["on_time", "late", "missed", "waiting"] as const).map((f) => (
            <div key={f} className={`rounded-lg p-2 ${FLAG[f].cls}`}>
              <p className="text-[11px] font-semibold uppercase">{FLAG[f].label}</p>
              <p className="text-lg font-bold tabular-nums">{counts[f]}</p>
            </div>
          ))}
        </div>
        <p className="text-sm font-semibold">
          {total ? `${Math.round((counts.on_time / total) * 100)}% of ${total} leads called within 5 minutes` : "No leads in this range yet."}
        </p>
        {flaggedBy.length ? (
          <p className="text-sm text-rose-800">Flags: {flaggedBy.map(([who, n]) => `${who} ${n}`).join(" · ")}</p>
        ) : null}
        <div className="flex gap-2">
          {(["all", "flagged"] as const).map((o) => (
            <button key={o} type="button" onClick={() => setOnly(o)}
                    className={`min-h-9 rounded-lg border px-3 text-sm font-semibold ${only === o ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}>
              {o === "all" ? "All leads" : "Only flagged"}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="divide-y">
        {rows === null ? <p className="py-2 text-sm text-muted-foreground">Loading…</p> : null}
        {shown.map((r) => (
          <div key={`${r.lead_id}-${r.came_in}`} className="flex items-center gap-3 py-2">
            <span className={`w-16 shrink-0 rounded-md px-1.5 py-1 text-center text-[11px] font-bold ${FLAG[r.flag].cls}`}>{FLAG[r.flag].label}</span>
            <span className="min-w-0 flex-1">
              <Link to={`/leads/${r.lead_id}`} className="block truncate text-sm font-semibold capitalize underline-offset-2 hover:underline">{(r.name || "Lead").toLowerCase()}</Link>
              <span className="block text-xs text-muted-foreground">
                Came in {when(r.came_in)} · on call: {r.on_call}{r.called_by && r.called_by !== r.on_call ? ` · called by ${r.called_by}` : ""}
              </span>
            </span>
            <span className="shrink-0 text-sm font-bold tabular-nums">{r.minutes === null ? "–" : `${r.minutes} min`}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function TeamPanel() {
  const [people, setPeople] = useState<OnCallPerson[]>([]);
  const [ghl, setGhl] = useState<{ id: string; name: string; email: string }[]>([]);
  const [ghlError, setGhlError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    api.onCallPeople().then((r) => { if (live) setPeople(r.people); }).catch(() => {});
    api.onCallGhlUsers().then((r) => { if (live) { setGhl(r.users); setGhlError(r.error || ""); } }).catch(() => {});
    return () => { live = false; };
  }, [tick]);
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Where each person gets new-lead alerts. The VAs have Honduran numbers, so use WhatsApp. Link their GoHighLevel login so new leads
        are assigned to them in GHL and the GHL app on their phone notifies them too. Everyone keeps getting the usual copy of every lead.
      </p>
      {ghlError ? <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900">{ghlError}</p> : null}
      {people.map((p) => <PersonRow key={p.username} p={p} ghl={ghl} onSaved={() => setTick((x) => x + 1)} />)}
    </div>
  );
}

function PersonRow({ p, ghl, onSaved }: { p: OnCallPerson; ghl: { id: string; name: string; email: string }[]; onSaved: () => void }) {
  const [phone, setPhone] = useState(p.phone);
  const [channel, setChannel] = useState(p.alert_channel || "whatsapp");
  const [ghlId, setGhlId] = useState(p.ghl_user_id);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await api.onCallSetPerson(p.username, { phone, alert_channel: channel, ghl_user_id: ghlId }); toast.success(`${p.name} saved`); onSaved(); }
    catch (e) { toast.error(errMessage(e, "Couldn't save")); } finally { setBusy(false); }
  };
  const test = async () => {
    try { await api.onCallTest(p.username); toast.success(`Test sent to ${p.name}`); }
    catch (e) { toast.error(errMessage(e, "Test didn't go through")); }
  };
  return (
    <Card>
      <CardContent className="space-y-2 pt-4">
        <p className="text-base font-semibold">{p.name} <span className="text-xs font-normal text-muted-foreground">{p.role}</span></p>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs font-semibold text-muted-foreground">Phone (with country code)
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+504 9597 6304" className="mt-1 h-10 text-base" />
          </label>
          <div className="text-xs font-semibold text-muted-foreground">Alert by
            <div className="mt-1 flex gap-2">
              {(["whatsapp", "sms"] as const).map((c) => (
                <button key={c} type="button" onClick={() => setChannel(c)}
                        className={`h-10 flex-1 rounded-lg border text-sm font-semibold ${channel === c ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}>
                  {c === "whatsapp" ? "WhatsApp" : "Text"}
                </button>
              ))}
            </div>
          </div>
        </div>
        <label className="block text-xs font-semibold text-muted-foreground">GoHighLevel login
          {ghl.length ? (
            <select value={ghlId} onChange={(e) => setGhlId(e.target.value)} className="mt-1 h-10 w-full rounded-md border border-input bg-background px-2 text-sm">
              <option value="">Not linked</option>
              {ghl.map((g) => <option key={g.id} value={g.id}>{g.name}{g.email ? ` · ${g.email}` : ""}</option>)}
            </select>
          ) : (
            <Input value={ghlId} onChange={(e) => setGhlId(e.target.value)} placeholder="GHL user ID" className="mt-1 h-10" />
          )}
        </label>
        <div className="flex gap-2">
          <Button size="sm" onClick={save} disabled={busy}>{busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}Save</Button>
          <Button size="sm" variant="outline" onClick={test} disabled={!p.ready}><Send className="mr-1 h-3.5 w-3.5" /> Send a test</Button>
        </div>
      </CardContent>
    </Card>
  );
}
