// The crew log their own hours at the end of the day (Alan, 2026-11-02:
// "what time they started and what time they finished"). Today or up to a
// week back; saving again changes it. The office reads them on Crew Stats.
//
// Laid out from how the field timesheet apps do it (Alan asked for "extremely
// professional and super easy", 2026-11-02): the times come filled in from
// their own job photos, big preset times plus -15/+15 instead of the phone's
// tiny time wheel (start times are mornings, finish times afternoons, so AM
// and PM can't get mixed up), a big live total, one Save, and a receipt.
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, CheckCircle2, Loader2, Lock, Minus, Moon, Plus, Sun } from "lucide-react";
import { api, type HoursEntry } from "@/lib/api";
import { isSpanish, tr } from "@/lib/i18n";
import { cn, errMessage } from "@/lib/utils";

type PhotoTimes = Record<string, { first: string; last: string }>;

const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  const x = new Date(y, m - 1, d + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};
const asDate = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
const loc = () => (isSpanish() ? "es-US" : "en-US");
const dayWords = (iso: string) => asDate(iso).toLocaleDateString(loc(), { weekday: "short", month: "short", day: "numeric" });
const dayLong = (iso: string) => asDate(iso).toLocaleDateString(loc(), { weekday: "long", month: "long", day: "numeric" });
const clock = (hm: string) => {
  if (!hm) return "";
  const [h, m] = hm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? (isSpanish() ? "a. m." : "AM") : (isSpanish() ? "p. m." : "PM")}`;
};
const span = (mins: number) => `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, "0")} min`;
const minsOf = (hm: string) => { const [h, m] = (hm || "").split(":").map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN; };
const hmOf = (mins: number) => { const x = Math.max(0, Math.min(23 * 60 + 45, mins)); return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`; };
// Photo times rounded to the quarter hour: the start down, the finish up.
const roundDown = (hm: string) => hmOf(Math.floor(minsOf(hm) / 15) * 15);
const roundUp = (hm: string) => hmOf(Math.ceil(minsOf(hm) / 15) * 15);
/** The pay day ending the week `iso` is in; `payDay` is Monday = 0 (the
 *  server's), each worker's own (Alan, 2026-11-02). */
const weekEnd = (iso: string, payDay: number) => addDays(iso, (((payDay + 1) % 7) - asDate(iso).getDay() + 7) % 7);

const START_CHIPS = ["06:00", "06:30", "07:00", "07:30", "08:00", "08:30"];
const END_CHIPS = ["14:00", "15:00", "16:00", "17:00", "18:00", "19:00"];
const LONG_DAY = 14 * 60;

function TimeBlock({ icon: Icon, label, value, onChange, chips, fallback, minAfter }: {
  icon: typeof Sun; label: string; value: string; onChange: (hm: string) => void;
  chips: string[]; fallback: string; minAfter?: string;
}) {
  const [other, setOther] = useState(false);
  const step = (n: number) => onChange(hmOf((Number.isFinite(minsOf(value)) ? minsOf(value) : minsOf(fallback)) + n));
  const blocked = (hm: string) => !!minAfter && Number.isFinite(minsOf(minAfter)) && minsOf(hm) <= minsOf(minAfter);
  return (
    <div className="rounded-2xl bg-white p-3 ring-1 ring-black/10">
      <p className="flex items-center gap-2 text-[15px] font-bold text-black/70"><Icon className="h-5 w-5" /> {tr(label)}</p>
      <div className="mt-2 flex items-center gap-2">
        <button type="button" onClick={() => step(-15)} aria-label="-15"
                className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-[#F4EEE1] ring-1 ring-black/10 active:scale-95">
          <Minus className="h-5 w-5" />
        </button>
        <p className={cn("min-w-0 flex-1 text-center font-heading text-[34px] font-bold tabular-nums leading-none", !value && "text-black/30")}>
          {value ? clock(value) : "– : –"}
        </p>
        <button type="button" onClick={() => step(15)} aria-label="+15"
                className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-[#F4EEE1] ring-1 ring-black/10 active:scale-95">
          <Plus className="h-5 w-5" />
        </button>
      </div>
      <div className="mt-2.5 grid grid-cols-3 gap-1.5">
        {chips.map((c) => (
          <button key={c} type="button" disabled={blocked(c)} onClick={() => onChange(c)}
                  className={cn("min-h-11 rounded-xl text-[15px] font-bold tabular-nums ring-1 disabled:opacity-30",
                    value === c ? "bg-ink text-white ring-ink" : "bg-white ring-black/15")}>
            {clock(c)}
          </button>
        ))}
      </div>
      {other ? (
        <input type="time" value={value} onChange={(e) => onChange(e.target.value)} autoFocus
               className="mt-2 h-12 w-full rounded-xl border-2 border-black/15 bg-white px-3 text-lg font-bold" />
      ) : (
        <button type="button" onClick={() => setOther(true)} className="mt-2 min-h-10 w-full text-[15px] font-semibold text-bronze underline underline-offset-2">
          {tr("Another time")}
        </button>
      )}
    </div>
  );
}

export default function MyHours() {
  const [data, setData] = useState<{ today: string; back_days: number; entries: HoursEntry[]; photo_times?: PhotoTimes;
    week_start?: string; week_end?: string; pay_day?: number } | null>(null);
  const [day, setDay] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [fromPhotos, setFromPhotos] = useState(false);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<HoursEntry | null>(null);
  const load = useCallback(() => {
    api.getMyHours().then((d) => { setData(d); setDay((x) => x || d.today); }).catch((e) => toast.error(errMessage(e, tr("Couldn't load"))));
  }, []);
  useEffect(() => { load(); }, [load]);
  // The day's saved times fill the boxes; a day not logged yet starts from
  // their first and last job photo, when there are any.
  useEffect(() => {
    if (!data || !day) return;
    const e = data.entries.find((x) => x.date === day);
    const ph = data.photo_times?.[day];
    if (e) { setStart(e.start); setEnd(e.end); setFromPhotos(false); }
    else if (ph && ph.first !== ph.last) { setStart(roundDown(ph.first)); setEnd(roundUp(ph.last)); setFromPhotos(true); }
    else { setStart(""); setEnd(""); setFromPhotos(false); }
    setNote(e?.note || ""); setNoteOpen(!!e?.note);
  }, [day, data]);

  const payDay = data?.pay_day ?? 5;
  const weekStart = data?.week_start || (data ? addDays(data.today, -data.back_days) : "");
  const weekTotal = useMemo(() => {
    if (!data) return 0;
    return data.entries.filter((e) => e.date >= weekStart && e.date <= data.today).reduce((t, e) => t + e.minutes, 0);
  }, [data, weekStart]);
  // Every entry grouped by pay week, newest first. Weeks before this one are closed.
  const weeks = useMemo(() => {
    const out: { end: string; total: number; rows: HoursEntry[] }[] = [];
    for (const e of data?.entries || []) {
      const end = weekEnd(e.date, payDay);
      const w = out.find((x) => x.end === end) || (out.push({ end, total: 0, rows: [] }), out[out.length - 1]);
      w.rows.push(e); w.total += e.minutes;
    }
    return out;
  }, [data, payDay]);

  if (!data) return <p className="py-12 text-center text-muted-foreground"><Loader2 className="mr-1 inline h-4 w-4 animate-spin" />{tr("Loading…")}</p>;

  // The whole pay week; days still to come are shown but can't be picked.
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const payName = asDate(weekEnd(data.today, payDay)).toLocaleDateString(loc(), { weekday: "long" });
  const logged = (d: string) => data.entries.some((x) => x.date === d);
  const saved = data.entries.find((x) => x.date === day);
  const mins = minsOf(end) - minsOf(start);
  const ready = !!start && !!end && mins > 0;
  const changed = !saved || saved.start !== start || saved.end !== end || (saved.note || "") !== note.trim();
  const save = async () => {
    if (!ready) { toast.error(tr("The finish time has to be after the start time")); return; }
    setBusy(true);
    try {
      const r = await api.saveMyHours(day, { start, end, note: note.trim() });
      setReceipt(r);
      load();
    } catch (e) { toast.error(errMessage(e, tr("Couldn't save"))); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      {/* The week at a glance: a check on each day that has hours. */}
      <section className="rounded-2xl bg-ink p-4 text-white">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-[15px] font-semibold text-white/70">{tr("This week")} <span className="capitalize">· {tr("pay day")} {payName}</span></p>
          <p className="font-heading text-[26px] font-bold tabular-nums text-gold">{span(weekTotal)}</p>
        </div>
        <div className="mt-3 grid grid-cols-7 gap-1">
          {days.map((d) => {
            const on = d === day, ok = logged(d), isToday = d === data.today, later = d > data.today;
            return (
              <button key={d} type="button" disabled={later} onClick={() => { setDay(d); setReceipt(null); }} aria-pressed={on}
                      className={cn("flex min-h-[64px] flex-col items-center justify-center rounded-xl text-center transition disabled:opacity-35",
                        on ? "bg-gold text-ink" : "bg-white/10 text-white")}>
                <span className="text-[12px] font-bold uppercase">{isToday ? tr("Today").slice(0, 4) : asDate(d).toLocaleDateString(loc(), { weekday: "short" }).slice(0, 3)}</span>
                <span className="text-[17px] font-black tabular-nums">{asDate(d).getDate()}</span>
                {ok ? <Check className={cn("h-4 w-4", on ? "text-ink" : "text-emerald-300")} strokeWidth={3} /> : <span className={cn("h-4 text-[13px] leading-4", on ? "text-ink/50" : "text-white/40")}>·</span>}
              </button>
            );
          })}
        </div>
      </section>

      {receipt && receipt.date === day ? (
        // The receipt: exactly what was saved.
        <section className="rounded-2xl border-2 border-emerald-500 bg-emerald-50 p-4 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-600" />
          <p className="mt-1 text-xl font-black text-emerald-900">{tr("Hours saved")}</p>
          <p className="mt-1 text-[17px] font-semibold capitalize">{dayLong(receipt.date)}</p>
          <p className="text-[17px] tabular-nums">{clock(receipt.start)} – {clock(receipt.end)}</p>
          <p className="mt-1 font-heading text-[28px] font-bold tabular-nums">{span(receipt.minutes)}</p>
          <button type="button" onClick={() => setReceipt(null)} className="mt-2 min-h-11 text-[15px] font-semibold text-emerald-900 underline underline-offset-2">
            {tr("Change it")}
          </button>
        </section>
      ) : (
        <section className="space-y-3 rounded-2xl border-2 border-gold bg-[#FBF3DF] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xl font-black capitalize">{dayLong(day)}</p>
            <span className={cn("rounded-full px-2.5 py-1 text-[13px] font-bold", saved ? "bg-emerald-100 text-emerald-800" : "bg-white text-black/60 ring-1 ring-black/10")}>
              {saved ? `✓ ${tr("Saved")}` : tr("Not logged yet")}
            </span>
          </div>
          {fromPhotos ? <p className="rounded-xl bg-white/70 px-3 py-2 text-[15px]">📷 {tr("Filled in from your job photos. Change it if it's not right.")}</p> : null}

          <TimeBlock icon={Sun} label="I started" value={start} onChange={(v) => { setStart(v); setFromPhotos(false); }} chips={START_CHIPS} fallback="07:00" />
          <TimeBlock icon={Moon} label="I finished" value={end} onChange={(v) => { setEnd(v); setFromPhotos(false); }} chips={END_CHIPS} fallback="17:00" minAfter={start} />

          <div className="rounded-2xl bg-white p-3 text-center ring-1 ring-black/10">
            <p className="text-[15px] font-semibold text-black/60">{tr("Total")}</p>
            <p className={cn("font-heading text-[36px] font-bold tabular-nums leading-tight", !ready && "text-black/30")}>{ready ? span(mins) : "—"}</p>
            <p className="text-[13px] text-black/60">{tr("Lunch is not taken out")}</p>
            {start && end && !(mins > 0) ? <p className="mt-1 text-[15px] font-bold text-rose-700">{tr("The finish time has to be after the start time")}</p> : null}
            {mins > LONG_DAY ? <p className="mt-1 text-[15px] font-bold text-amber-700">{tr("That's a long day. Check the times.")}</p> : null}
          </div>

          {noteOpen ? (
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr("A note (optional)")} autoFocus={!saved?.note}
                   className="h-12 w-full rounded-xl border border-black/15 bg-white px-3 text-base" />
          ) : (
            <button type="button" onClick={() => setNoteOpen(true)} className="min-h-11 text-[15px] font-semibold text-bronze underline underline-offset-2">
              + {tr("Add a note")}
            </button>
          )}

          <button type="button" disabled={busy || !ready || !changed} onClick={() => void save()}
                  className="flex min-h-14 w-full items-center justify-center rounded-2xl bg-ink text-lg font-black text-white disabled:opacity-40">
            {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : saved ? (changed ? tr("Update my hours") : `✓ ${tr("Saved")}`) : tr("Save my hours")}
          </button>
        </section>
      )}

      {weeks.length ? (
        <section className="rounded-2xl border bg-card p-4">
          <p className="text-base font-bold">{tr("Your hours")}</p>
          {weeks.map((w) => {
            const closed = w.end < weekStart;
            return (
            <div key={w.end} className="mt-3">
              <div className="flex items-baseline justify-between gap-2 border-b pb-1">
                <p className="flex items-center gap-1.5 text-[13px] font-bold uppercase tracking-wide text-black/60">
                  {closed ? <Lock className="h-3.5 w-3.5" /> : null}
                  {closed ? tr("Paid week ending") : tr("This week, ends")} {dayWords(w.end)}
                </p>
                <p className="shrink-0 text-[15px] font-black tabular-nums">{span(w.total)}</p>
              </div>
              <ul className="divide-y">
                {w.rows.map((e) => (
                  <li key={e.date}>
                    <button type="button" disabled={closed} onClick={() => { setDay(e.date); setReceipt(null); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                            className="flex min-h-12 w-full items-center justify-between gap-2 py-2 text-left text-[15px] disabled:text-black/70">
                      <span className="min-w-0"><span className="font-semibold capitalize">{dayWords(e.date)}</span><span className="block text-black/60 tabular-nums">{clock(e.start)} – {clock(e.end)}</span></span>
                      <span className="shrink-0 font-bold tabular-nums">{span(e.minutes)}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {closed ? <p className="mt-1 text-[13px] text-black/50">{tr("Closed. Ask the office if something is wrong.")}</p> : null}
            </div>
            );
          })}
        </section>
      ) : null}
    </div>
  );
}
