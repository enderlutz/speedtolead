// Each worker checks in and out of each job, every day (Alan, 2026-11-02:
// "everybody that gets to the job, even if they're going together, they need
// to both submit before pictures, and they need to both submit after
// pictures… it's gonna give us timestamps"). Five before photos = I'm here;
// five after photos plus why they're leaving = I'm leaving. Taken live, so
// the times are real; forgot? add them from your photos and type the time,
// and check out later with the time you left. Typed times show as typed. The job is done when the last worker on a staining or
// repair day leaves with Finished. The stainer and the repair worker get the
// cleaner's notes on top.
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Camera, CheckCircle2, Images, Loader2, LogOut } from "lucide-react";
import { api, type CompanyCamJob, type JobVisit, type JobVisitsPayload } from "@/lib/api";
import { tr } from "@/lib/i18n";
import { cn, errMessage } from "@/lib/utils";
import { photoTakenAt } from "@/lib/photoTime";

const fmt = (iso: string) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
const TASKS: { key: string; label: string }[] = [
  { key: "cleaning", label: "Cleaning" }, { key: "staining", label: "Staining" }, { key: "repairs", label: "Repairs" },
];
const famOf = (task: string) => (task === "cleaning" ? "clean" : task === "pressure_washing" ? "pw" : task ? "stain" : "");
// Several tasks in a day, kept as "cleaning,staining" (Alan, 2026-11-02): the
// before photos are the first task's, the after photos the last's.
const ORDER = ["cleaning", "repairs", "staining", "pressure_washing"];
const tasksOf = (t: string) => ORDER.filter((k) => (t || "").split(",").includes(k));
const beforeSec = (v: JobVisitsPayload, t: string) => v.before_section || (tasksOf(t)[0] ? `${famOf(tasksOf(t)[0])}_before` : "");
const afterSec = (v: JobVisitsPayload, t: string) => v.after_section || (tasksOf(t).length ? `${famOf(tasksOf(t)[tasksOf(t).length - 1])}_after` : "");
type Upload = (section: string, files: FileList | File[] | null, typedAt?: string) => Promise<void>;
/** Queued photos in a section, on a day (today when none). */
type Pending = (section: string, day?: string) => number;

// Typed times (Alan, 2026-11-02): a day up to a week back and a time, on this phone's clock.
const pad = (n: number) => String(n).padStart(2, "0");
const dayOf = (d: Date) => d.toLocaleDateString("en-CA");
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const weekAgo = () => dayOf(new Date(Date.now() - 6 * 86_400_000));
const toIso = (day: string, time: string) => {
  const d = new Date(`${day}T${time}`);
  return day && time && !Number.isNaN(d.getTime()) ? d.toISOString() : "";
};
const shortDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

function WhenFields({ day, time, setDay, setTime }: { day: string; time: string; setDay: (d: string) => void; setTime: (t: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="text-base font-semibold">{tr("Day")}
        <input type="date" min={weekAgo()} max={dayOf(new Date())} value={day} onChange={(e) => setDay(e.target.value)}
               className="mt-1 h-12 w-full rounded-xl border bg-white px-2 text-base" />
      </label>
      <label className="text-base font-semibold">{tr("Time")}
        <input type="time" value={time} onChange={(e) => setTime(e.target.value)}
               className="mt-1 h-12 w-full rounded-xl border bg-white px-2 text-base" />
      </label>
    </div>
  );
}

/** Forgot to take them? Pick them from the phone's photos and say when
 *  (Alan, 2026-11-02). The phone's time fills in when the photo has one. */
export function ForgotButton({ onFiles, day: forDay }: { onFiles: (files: File[], at: string) => void; day?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [day, setDay] = useState("");
  const [time, setTime] = useState("");
  const pick = async (list: FileList | null) => {
    const fs = Array.from(list || []);
    if (!fs.length) return;
    const raw = await photoTakenAt(fs[0]);
    const d = raw ? new Date(raw) : null;
    const ok = !!d && dayOf(d) >= weekAgo() && d.getTime() <= Date.now() && (!forDay || dayOf(d) === forDay);
    setDay(ok && d ? dayOf(d) : forDay || dayOf(new Date()));
    setTime(ok && d ? hhmm(d) : "");
    setFiles(fs);
  };
  const at = toIso(day, time);
  const future = !!at && new Date(at).getTime() > Date.now() + 5 * 60_000;
  return (
    <>
      <input ref={ref} type="file" accept="image/*" multiple hidden onChange={(e) => { void pick(e.target.files); e.target.value = ""; }} />
      <button type="button" onClick={() => ref.current?.click()}
              className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-white text-base font-bold ring-1 ring-black/15">
        <Images className="h-5 w-5" /> {tr("I forgot · add from my photos")}
      </button>
      {files.length ? (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 sm:items-center" onClick={() => setFiles([])}>
          <div className="w-full max-w-lg rounded-t-3xl bg-ivory p-4 pb-[max(env(safe-area-inset-bottom),16px)] sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
            <p className="text-lg font-bold leading-snug">{tr("When did you take these?")}</p>
            <p className="mb-3 text-base text-black/60">{files.length} {tr(files.length === 1 ? "photo" : "photos")} · {tr("Change it if it's wrong.")}</p>
            <WhenFields day={day} time={time} setDay={setDay} setTime={setTime} />
            {future ? <p className="mt-2 text-base font-semibold text-rose-700">{tr("That time hasn't happened yet.")}</p> : null}
            <div className="mt-3 grid grid-cols-[1fr_2fr] gap-2">
              <button type="button" onClick={() => setFiles([])} className="min-h-14 rounded-2xl bg-white text-base font-bold ring-1 ring-black/15">{tr("Cancel")}</button>
              <button type="button" disabled={!at || future} onClick={() => { onFiles(files, at); setFiles([]); }}
                      className="min-h-14 rounded-2xl bg-ink text-lg font-black text-white disabled:opacity-40">
                {tr("Add the photos")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function useJobVisits(leadId: string, on: boolean) {
  const [data, setData] = useState<JobVisitsPayload | null>(null);
  const load = useCallback(() => { if (on) api.getJobVisits(leadId).then(setData).catch(() => { /* the job page still works */ }); }, [leadId, on]);
  useEffect(() => {
    load();
    if (!on) return;
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load, on]);
  return { data, reload: load };
}

/** The camera button: opens the camera, never the gallery. */
function CameraButton({ label, onFiles, busy }: { label: string; onFiles: (f: FileList | null) => void; busy?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={ref} type="file" accept="image/*" capture="environment" hidden
             onChange={(e) => { onFiles(e.target.files); e.target.value = ""; }} />
      <button type="button" disabled={busy} onClick={() => ref.current?.click()}
              className="flex h-16 w-full items-center justify-center gap-2 rounded-2xl bg-ink text-lg font-black text-white shadow active:scale-[0.98] disabled:opacity-60">
        {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : <Camera className="h-6 w-6" />} {tr(label)}
      </button>
    </>
  );
}

function Count({ n, need }: { n: number; need: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: need }).map((_, i) => (
        <span key={i} className={cn("h-3 flex-1 rounded-full", i < n ? "bg-emerald-500" : "bg-black/10")} />
      ))}
      <span className="ml-1 text-base font-black tabular-nums">{Math.min(n, need)}/{need}</span>
    </div>
  );
}

/** Step 1, at the top of the job: I'm here. */
export function CheckInCard({ v, pending, task, setTask, upload, uploading }: {
  v: JobVisitsPayload; pending: Pending; task: string; setTask: (t: string) => void;
  upload: Upload; uploading: string;
}) {
  const fam = v.family || famOf(tasksOf(task)[0] || "");
  if (fam === "pw") return null;   // a washing day keeps its own steps
  const section = beforeSec(v, task);
  // Pick as many as they're doing today.
  const toggle = (k: string) => {
    const on = tasksOf(task);
    setTask((on.includes(k) ? on.filter((x) => x !== k) : [...on, k]).join(","));
  };
  const n = (v.me?.before || 0) + (section ? pending(section) : 0);
  const done = n >= v.need;
  return (
    <section id="check-in" className={cn("rounded-2xl border-2 p-4", done ? "border-emerald-500 bg-emerald-50" : "border-gold bg-[#FBF3DF]")}>
      {done ? (
        <p className="flex items-center gap-2 text-lg font-black text-emerald-800">
          <CheckCircle2 className="h-6 w-6" /> {tr("You're checked in")}{v.me?.arrived_at ? ` · ${tr("Got here")} ${fmt(v.me.arrived_at)}${v.me.arrived_typed ? ` (${tr("typed")})` : ""}` : ""}
        </p>
      ) : (
        <>
          <p className="text-sm font-bold uppercase tracking-[0.12em] text-bronze">1 · {tr("I'm here")}</p>
          <p className="mt-0.5 text-lg font-bold leading-snug">{tr("Take 5 photos of the fence before you start.")}</p>
          {!v.task ? (
            <div className="mt-3">
              <p className="mb-1.5 text-base font-semibold">{tr("What are you doing today?")} <span className="font-normal text-black/60">{tr("Pick all that apply")}</span></p>
              <div className="grid grid-cols-3 gap-1.5">
                {TASKS.map((t) => (
                  <button key={t.key} type="button" onClick={() => toggle(t.key)} aria-pressed={tasksOf(task).includes(t.key)}
                          className={cn("min-h-12 rounded-xl text-base font-bold ring-1", tasksOf(task).includes(t.key) ? "bg-ink text-white ring-ink" : "bg-white ring-black/15")}>
                    {tasksOf(task).includes(t.key) ? "✓ " : ""}{tr(t.label)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {section ? (
            <div className="mt-3 space-y-2">
              <Count n={n} need={v.need} />
              <CameraButton label="Take a before photo" busy={uploading === section} onFiles={(f) => void upload(section, f)} />
              <ForgotButton onFiles={(f, at) => void upload(section, f, at)} />
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

/** For the stainer and the repair worker: the cleaner's notes on top. */
export function FromTheCleaner({ job, task, onPhotos }: { job: CompanyCamJob; task: string; onPhotos: () => void }) {
  // The stainer or repair worker, on a day the cleaning was done before.
  const ts = tasksOf(task);
  if (!ts.length || ts.includes("cleaning") || !(ts.includes("staining") || ts.includes("repairs")) || job.no_cleaning) return null;
  const notes = (job.cleaning_notes || "").trim();
  const color = job.final_color || job.color || "";
  return (
    <section className="rounded-2xl border-2 border-sky-300 bg-sky-50 p-4">
      <p className="text-sm font-bold uppercase tracking-[0.12em] text-sky-800">{tr("From the cleaner")}</p>
      <div className="mt-1 space-y-1 text-base">
        {notes ? <p><span className="font-semibold">{tr("Cleaner's notes")}:</span> {notes}</p> : null}
        {job.pickets_marked_at ? <p>✅ {tr("Pickets marked")}{job.pickets_marked_by ? ` · ${job.pickets_marked_by}` : ""}</p> : null}
        {color ? <p>🎨 {color}</p> : null}
      </div>
      <button type="button" onClick={onPhotos} className="mt-2 min-h-11 rounded-xl bg-white px-3 text-base font-bold ring-1 ring-sky-300">
        {tr("See the cleaner's photos")}
      </button>
    </section>
  );
}

/** The last tap: I'm leaving, with the after photos and why. Forgot to
 *  check out? Pick "Earlier", the day and the time you left (2026-11-02). */
export function LeaveBar({ leadId, v, job, task, pending, upload, uploading, onLeft }: {
  leadId: string; v: JobVisitsPayload; job: CompanyCamJob; task: string; pending: Pending;
  upload: Upload; uploading: string; onLeft: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [done, setDone] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [earlier, setEarlier] = useState(false);
  const [lday, setLday] = useState(v.today);
  const [ltime, setLtime] = useState("");
  const fam = v.family || famOf(tasksOf(task)[0] || "");
  if (fam === "pw") return null;
  const bSec = beforeSec(v, task), aSec = afterSec(v, task);
  const me: JobVisit | null = v.me;
  // The day being checked out: today, or one they forgot this week.
  const day = earlier ? lday : v.today;
  const dv = day === v.today ? me : (v.earlier || []).find((x) => x.date === day) || null;
  const before = (dv?.before || 0) + (bSec ? pending(bSec, day) : 0);
  const after = (dv?.after || 0) + (aSec ? pending(aSec, day) : 0);
  const todayBefore = (me?.before || 0) + (bSec ? pending(bSec) : 0);
  const leftAt = earlier ? toIso(lday, ltime) : "";
  const future = !!leftAt && new Date(leftAt).getTime() > Date.now() + 5 * 60_000;
  // Days this week they started and never checked out.
  const forgot = (v.earlier || []).filter((x) => x.before && !x.left_at);
  // What could get done today: the repairs planned on the job.
  const planned = Object.entries({ ...(job.repairs?.counts || {}), ...(job.extras?.counts || {}) }).filter(([, n]) => n > 0).map(([k]) => k);
  const openFor = (d?: string) => { setEarlier(!!d); if (d) { setLday(d); setLtime(""); } setOpen(true); };

  const send = async () => {
    if (!reason) { toast.error(tr("Why are you leaving?")); return; }
    if (reason === "other" && !note.trim()) { toast.error(tr("Write a few words")); return; }
    if (earlier && !leftAt) { toast.error(tr("What time did you leave?")); return; }
    setBusy(true);
    try {
      const r = await api.leaveJob(leadId, { reason, note, done, task: v.task ? undefined : task, left_at: leftAt || undefined });
      toast.success(r.job_done ? tr("Job done. Alan's been told. Nice work!") : `${tr("You left")} · ${tr(v.reasons[reason] || "")}`);
      setOpen(false);
      onLeft();
    } catch (e) { toast.error(errMessage(e, tr("Couldn't save"))); } finally { setBusy(false); }
  };

  let bar;
  if (job.completed_at || me?.left_at) {
    bar = (
      <p className="flex min-h-14 items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-3 text-lg font-bold text-white">
        <CheckCircle2 className="h-6 w-6" />
        {me?.left_at ? `${tr("You left")} ${fmt(me.left_at)}${me.left_typed ? ` (${tr("typed")})` : ""} · ${tr(me.reason_label)}` : `${tr("Job done")} · ${fmt(job.completed_at || "")}`}
      </p>
    );
  } else if (todayBefore < v.need) {
    bar = (
      <button type="button" onClick={() => document.getElementById("check-in")?.scrollIntoView({ behavior: "smooth", block: "center" })}
              className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-gold px-3 text-xl font-black text-ink">
        <Camera className="h-6 w-6" /> {tr("I'm here")} · {tr("Take 5 before photos first")}
      </button>
    );
  } else {
    bar = (
      <button type="button" onClick={() => openFor()}
              className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-ink px-3 text-xl font-black text-white">
        <LogOut className="h-6 w-6" /> {tr("I'm leaving")}
      </button>
    );
  }
  return (
    <>
      {bar}
      {!job.completed_at && forgot.length ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {forgot.map((x) => (
            <button key={x.date} type="button" onClick={() => openFor(x.date)}
                    className="min-h-11 flex-1 rounded-xl bg-amber-100 px-3 text-base font-bold text-amber-900 ring-1 ring-amber-300">
              {tr("Forgot to check out")} · {shortDay(x.date)}
            </button>
          ))}
        </div>
      ) : null}
      {open ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" onClick={() => setOpen(false)}>
          <div className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-ivory p-4 pb-[max(env(safe-area-inset-bottom),16px)] sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-bold uppercase tracking-[0.12em] text-bronze">2 · {tr("I'm leaving")}</p>
            <p className="mb-1.5 mt-1 text-base font-semibold">{tr("When did you leave?")}</p>
            <div className="grid grid-cols-2 gap-1.5">
              {[false, true].map((e) => (
                <button key={String(e)} type="button" onClick={() => { setEarlier(e); if (e && !lday) setLday(v.today); }}
                        className={cn("min-h-12 rounded-xl text-base font-bold ring-1", earlier === e ? "bg-ink text-white ring-ink" : "bg-white ring-black/15")}>
                  {e ? tr("Earlier (I forgot)") : tr("Now")}
                </button>
              ))}
            </div>
            {earlier ? (
              <div className="mt-2">
                <WhenFields day={lday} time={ltime} setDay={setLday} setTime={setLtime} />
                {future ? <p className="mt-2 text-base font-semibold text-rose-700">{tr("That time hasn't happened yet.")}</p> : null}
                {before < v.need ? (
                  <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-base text-amber-900 ring-1 ring-amber-200">
                    {tr("Before photos that day")}: {before}/{v.need}
                  </p>
                ) : null}
                {before < v.need && bSec ? (
                  <div className="mt-2"><ForgotButton day={lday} onFiles={(f, at) => void upload(bSec, f, at)} /></div>
                ) : null}
              </div>
            ) : null}
            <p className="mt-4 text-lg font-bold leading-snug">{tr("Take 5 photos of what you did before you leave.")}</p>
            <div className="mt-2 space-y-2">
              <Count n={after} need={v.need} />
              {earlier && lday !== v.today ? null
                : <CameraButton label="Take an after photo" busy={uploading === aSec} onFiles={(f) => void upload(aSec, f)} />}
              <ForgotButton day={earlier ? lday : undefined} onFiles={(f, at) => void upload(aSec, f, at)} />
            </div>
            <p className="mb-1.5 mt-4 text-base font-semibold">{tr("Why are you leaving?")}</p>
            <div className="grid gap-1.5">
              {Object.entries(v.reasons).map(([k, label]) => (
                <button key={k} type="button" onClick={() => setReason(k)}
                        className={cn("min-h-12 rounded-xl px-3 text-left text-base font-bold ring-1",
                          reason === k ? "bg-ink text-white ring-ink" : "bg-white ring-black/15")}>
                  {k === "finished" ? "✅ " : k === "rain" ? "🌧 " : k === "scope" ? "🔁 " : k === "early" ? "🚪 " : "✏️ "}{tr(label)}
                </button>
              ))}
            </div>
            {planned.length ? (
              <div className="mt-4">
                <p className="mb-1.5 text-base font-semibold">{tr("What got done today")}</p>
                {planned.map((k) => (
                  <label key={k} className="mb-1.5 flex items-center justify-between gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-black/10">
                    <span className="text-base font-semibold capitalize">{tr(k)} {tr("replaced")}</span>
                    <input type="number" inputMode="numeric" min={0} value={done[k] ?? ""} placeholder="0"
                           onChange={(e) => setDone((d) => ({ ...d, [k]: Math.max(0, Number(e.target.value) || 0) }))}
                           className="h-11 w-20 rounded-lg border px-2 text-right text-lg font-bold tabular-nums" />
                  </label>
                ))}
              </div>
            ) : null}
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                      placeholder={tr(reason === "other" ? "Write a few words" : "A few words (optional)")}
                      className="mt-3 w-full rounded-xl border p-3 text-base" />
            <div className="mt-3 grid grid-cols-[1fr_2fr] gap-2">
              <button type="button" onClick={() => setOpen(false)} className="min-h-14 rounded-2xl bg-white text-base font-bold ring-1 ring-black/15">{tr("Cancel")}</button>
              <button type="button" disabled={busy || before < v.need || after < v.need || !reason || (earlier && (!leftAt || future))} onClick={() => void send()}
                      className="min-h-14 rounded-2xl bg-emerald-600 text-lg font-black text-white disabled:opacity-40">
                {busy ? <Loader2 className="mx-auto h-6 w-6 animate-spin" /> : tr("Check out")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** The office: every worker's day on this job. */
export function WhoWasHere({ v }: { v: JobVisitsPayload | null }) {
  if (!v || !v.visits.length) return null;
  return (
    <section className="rounded-2xl border bg-card p-4">
      <p className="text-base font-bold">{tr("Who was here")}</p>
      {v.needs_another_day ? (
        <p className="mt-1 rounded-lg bg-rose-100 px-2.5 py-1.5 text-sm font-semibold text-rose-900">
          🌧 Needs another day · {v.needs_another_day.label} ({v.needs_another_day.by})
        </p>
      ) : null}
      <ul className="mt-2 divide-y">
        {v.visits.map((x) => {
          const did = Object.entries(x.done || {}).map(([k, n]) => `${n} ${k}`).join(", ");
          return (
            <li key={`${x.username}-${x.date}`} className="py-2 text-sm">
              <p className="font-semibold">{x.name} · {new Date(`${x.date}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}{x.task ? ` · ${x.task.split(",").join(" + ")}` : ""}</p>
              <p className="text-muted-foreground">
                {x.arrived_at ? `Got here ${fmt(x.arrived_at)}${x.arrived_typed ? " (typed)" : ""}` : "No before photos"}
                {x.left_at ? ` · left ${fmt(x.left_at)}${x.left_typed ? " (typed)" : ""} (${x.reason_label})` : x.last_photo_at ? ` · last photo ${fmt(x.last_photo_at)}, no check-out` : ""}
                {` · ${x.before} before, ${x.after} after`}
                {x.typed ? ` · ${x.typed} photo${x.typed === 1 ? "" : "s"} with a typed time` : ""}
                {did ? ` · done: ${did}` : ""}{x.note ? ` · "${x.note}"` : ""}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
