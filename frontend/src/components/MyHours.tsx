// The crew log their own hours at the end of the day (Alan, 2026-11-02:
// "what time they started and what time they finished"). Today or up to a
// week back; saving again changes it. The office reads them on Crew Stats.
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Clock, Loader2 } from "lucide-react";
import { api, type HoursEntry } from "@/lib/api";
import { isSpanish, tr } from "@/lib/i18n";
import { cn, errMessage } from "@/lib/utils";

const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  const x = new Date(y, m - 1, d + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};
const dayWords = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(isSpanish() ? "es-US" : "en-US", { weekday: "short", month: "short", day: "numeric" });
};
const clock = (hm: string) => {
  if (!hm) return "";
  const [h, m] = hm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
const span = (mins: number) => `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
const minsOf = (hm: string) => { const [h, m] = (hm || "").split(":").map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN; };

export default function MyHours() {
  const [data, setData] = useState<{ today: string; back_days: number; entries: HoursEntry[] } | null>(null);
  const [day, setDay] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api.getMyHours().then((d) => { setData(d); setDay((x) => x || d.today); }).catch((e) => toast.error(errMessage(e, tr("Couldn't load"))));
  }, []);
  useEffect(() => { load(); }, [load]);
  // The day's saved times fill the boxes, so a change starts from them.
  useEffect(() => {
    const e = data?.entries.find((x) => x.date === day);
    setStart(e?.start || ""); setEnd(e?.end || ""); setNote(e?.note || "");
  }, [day, data]);
  if (!data) return <p className="py-12 text-center text-muted-foreground"><Loader2 className="mr-1 inline h-4 w-4 animate-spin" />{tr("Loading…")}</p>;

  const days = Array.from({ length: data.back_days + 1 }, (_, i) => addDays(data.today, -i));
  const mins = minsOf(end) - minsOf(start);
  const saved = data.entries.find((x) => x.date === day);
  const save = async () => {
    if (!start || !end) { toast.error(tr("Put the time you started and the time you finished")); return; }
    if (!(mins > 0)) { toast.error(tr("The finish time has to be after the start time")); return; }
    setBusy(true);
    try { await api.saveMyHours(day, { start, end, note }); toast.success(tr("Hours saved")); load(); }
    catch (e) { toast.error(errMessage(e, tr("Couldn't save"))); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4">
      <section className="rounded-2xl border-2 border-gold bg-[#FBF3DF] p-4">
        <p className="flex items-center gap-2 text-lg font-black"><Clock className="h-5 w-5" /> {tr("Log your hours")}</p>
        <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1">
          {days.map((d, i) => (
            <button key={d} type="button" onClick={() => setDay(d)}
                    className={cn("min-h-11 shrink-0 rounded-xl px-3 text-[15px] font-bold ring-1",
                      day === d ? "bg-ink text-white ring-ink" : "bg-white ring-black/15")}>
              {i === 0 ? tr("Today") : i === 1 ? tr("Yesterday") : dayWords(d)}
              {data.entries.some((x) => x.date === d) ? " ✓" : ""}
            </button>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-[15px] font-semibold">{tr("I started")}</span>
            <input type="time" value={start} onChange={(e) => setStart(e.target.value)}
                   className="mt-1 h-14 w-full rounded-xl border-2 border-black/15 bg-white px-3 text-xl font-bold tabular-nums" />
          </label>
          <label className="block">
            <span className="text-[15px] font-semibold">{tr("I finished")}</span>
            <input type="time" value={end} onChange={(e) => setEnd(e.target.value)}
                   className="mt-1 h-14 w-full rounded-xl border-2 border-black/15 bg-white px-3 text-xl font-bold tabular-nums" />
          </label>
        </div>
        {mins > 0 ? <p className="mt-2 text-center text-xl font-black tabular-nums">{span(mins)}</p> : null}
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr("A note (optional)")}
               className="mt-2 h-12 w-full rounded-xl border border-black/15 bg-white px-3 text-base" />
        <button type="button" disabled={busy} onClick={() => void save()}
                className="mt-3 flex min-h-14 w-full items-center justify-center rounded-2xl bg-emerald-600 text-lg font-black text-white disabled:opacity-50">
          {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : saved ? tr("Save the change") : tr("Save my hours")}
        </button>
      </section>
      {data.entries.length ? (
        <section className="rounded-2xl border bg-card p-4">
          <p className="text-base font-bold">{tr("Your hours")}</p>
          <ul className="mt-1 divide-y">
            {data.entries.map((e) => (
              <li key={e.date} className="flex items-center justify-between gap-2 py-2 text-[15px]">
                <span><span className="font-semibold">{dayWords(e.date)}</span> · {clock(e.start)} – {clock(e.end)}</span>
                <span className="font-bold tabular-nums">{span(e.minutes)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
