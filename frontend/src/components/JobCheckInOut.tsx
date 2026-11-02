// Each worker checks in and out of each job, every day (Alan, 2026-11-02:
// "everybody that gets to the job, even if they're going together, they need
// to both submit before pictures, and they need to both submit after
// pictures… it's gonna give us timestamps"). Five before photos = I'm here;
// five after photos plus why they're leaving = I'm leaving. Camera only, so
// the times are real. The job is done when the last worker on a staining or
// repair day leaves with Finished. The stainer and the repair worker get the
// cleaner's notes on top.
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Camera, CheckCircle2, Loader2, LogOut } from "lucide-react";
import { api, type CompanyCamJob, type JobVisit, type JobVisitsPayload } from "@/lib/api";
import { tr } from "@/lib/i18n";
import { cn, errMessage } from "@/lib/utils";

const fmt = (iso: string) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
const TASKS: { key: string; label: string }[] = [
  { key: "cleaning", label: "Cleaning" }, { key: "staining", label: "Staining" }, { key: "repairs", label: "Repairs" },
];
const famOf = (task: string) => (task === "cleaning" ? "clean" : task ? "stain" : "");

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
  v: JobVisitsPayload; pending: (section: string) => number; task: string; setTask: (t: string) => void;
  upload: (section: string, files: FileList | null) => Promise<void>; uploading: string;
}) {
  const fam = v.family || famOf(task);
  if (fam === "pw") return null;   // a washing day keeps its own steps
  const section = fam ? `${fam}_before` : "";
  const n = (v.me?.before || 0) + (section ? pending(section) : 0);
  const done = n >= v.need;
  return (
    <section id="check-in" className={cn("rounded-2xl border-2 p-4", done ? "border-emerald-500 bg-emerald-50" : "border-gold bg-[#FBF3DF]")}>
      {done ? (
        <p className="flex items-center gap-2 text-lg font-black text-emerald-800">
          <CheckCircle2 className="h-6 w-6" /> {tr("You're checked in")}{v.me?.arrived_at ? ` · ${tr("Got here")} ${fmt(v.me.arrived_at)}` : ""}
        </p>
      ) : (
        <>
          <p className="text-sm font-bold uppercase tracking-[0.12em] text-bronze">1 · {tr("I'm here")}</p>
          <p className="mt-0.5 text-lg font-bold leading-snug">{tr("Take 5 photos of the fence before you start.")}</p>
          {!v.task ? (
            <div className="mt-3">
              <p className="mb-1.5 text-base font-semibold">{tr("What are you doing today?")}</p>
              <div className="grid grid-cols-3 gap-1.5">
                {TASKS.map((t) => (
                  <button key={t.key} type="button" onClick={() => setTask(t.key)}
                          className={cn("min-h-12 rounded-xl text-base font-bold ring-1", task === t.key ? "bg-ink text-white ring-ink" : "bg-white ring-black/15")}>
                    {tr(t.label)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {section ? (
            <div className="mt-3 space-y-2">
              <Count n={n} need={v.need} />
              <CameraButton label="Take a before photo" busy={uploading === section} onFiles={(f) => void upload(section, f)} />
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

/** For the stainer and the repair worker: the cleaner's notes on top. */
export function FromTheCleaner({ job, task, onPhotos }: { job: CompanyCamJob; task: string; onPhotos: () => void }) {
  if (!task || task === "cleaning" || task === "pressure_washing" || job.no_cleaning) return null;
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

/** The last tap: I'm leaving, with the after photos and why. */
export function LeaveBar({ leadId, v, job, task, pending, upload, uploading, onLeft }: {
  leadId: string; v: JobVisitsPayload; job: CompanyCamJob; task: string; pending: (section: string) => number;
  upload: (section: string, files: FileList | null) => Promise<void>; uploading: string; onLeft: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [done, setDone] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const fam = v.family || famOf(task);
  if (fam === "pw") return null;
  const before = (v.me?.before || 0) + (fam ? pending(`${fam}_before`) : 0);
  const after = (v.me?.after || 0) + (fam ? pending(`${fam}_after`) : 0);
  const me: JobVisit | null = v.me;
  // What could get done today: the repairs planned on the job.
  const planned = Object.entries({ ...(job.repairs?.counts || {}), ...(job.extras?.counts || {}) }).filter(([, n]) => n > 0).map(([k]) => k);

  if (job.completed_at || me?.left_at) {
    return (
      <p className="flex min-h-14 items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-3 text-lg font-bold text-white">
        <CheckCircle2 className="h-6 w-6" />
        {me?.left_at ? `${tr("You left")} ${fmt(me.left_at)} · ${tr(me.reason_label)}` : `${tr("Job done")} · ${fmt(job.completed_at || "")}`}
      </p>
    );
  }
  if (before < v.need) {
    return (
      <button type="button" onClick={() => document.getElementById("check-in")?.scrollIntoView({ behavior: "smooth", block: "center" })}
              className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-gold px-3 text-xl font-black text-ink">
        <Camera className="h-6 w-6" /> {tr("I'm here")} · {tr("Take 5 before photos first")}
      </button>
    );
  }
  const send = async () => {
    if (!reason) { toast.error(tr("Why are you leaving?")); return; }
    if (reason === "other" && !note.trim()) { toast.error(tr("Write a few words")); return; }
    setBusy(true);
    try {
      const r = await api.leaveJob(leadId, { reason, note, done, task: v.task ? undefined : task });
      toast.success(r.job_done ? tr("Job done. Alan's been told. Nice work!") : `${tr("You left")} · ${tr(v.reasons[reason] || "")}`);
      setOpen(false);
      onLeft();
    } catch (e) { toast.error(errMessage(e, tr("Couldn't save"))); } finally { setBusy(false); }
  };
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
              className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-ink px-3 text-xl font-black text-white">
        <LogOut className="h-6 w-6" /> {tr("I'm leaving")}
      </button>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" onClick={() => setOpen(false)}>
          <div className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-ivory p-4 pb-[max(env(safe-area-inset-bottom),16px)] sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-bold uppercase tracking-[0.12em] text-bronze">2 · {tr("I'm leaving")}</p>
            <p className="mt-0.5 text-lg font-bold leading-snug">{tr("Take 5 photos of what you did before you leave.")}</p>
            <div className="mt-3 space-y-2">
              <Count n={after} need={v.need} />
              <CameraButton label="Take an after photo" busy={uploading === `${fam}_after`} onFiles={(f) => void upload(`${fam}_after`, f)} />
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
              <button type="button" disabled={busy || after < v.need || !reason} onClick={() => void send()}
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
              <p className="font-semibold">{x.name} · {new Date(`${x.date}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}{x.task ? ` · ${x.task}` : ""}</p>
              <p className="text-muted-foreground">
                {x.arrived_at ? `Got here ${fmt(x.arrived_at)}` : "No before photos"}
                {x.left_at ? ` · left ${fmt(x.left_at)} (${x.reason_label})` : x.last_photo_at ? ` · last photo ${fmt(x.last_photo_at)}, no check-out` : ""}
                {` · ${x.before} before, ${x.after} after`}
                {did ? ` · done: ${did}` : ""}{x.note ? ` · "${x.note}"` : ""}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
