/**
 * Per-run, per-face measurements on a confirmed job (Alan, 2026-11-23).
 *
 * Each physical fence run is traced once (label, length, height); each face
 * (inside / outside) is coated with one exact stain, left out, or has its
 * finish pending. Both faces coated = the same area counted once per face.
 * The office picks the finishes; the cleaner can correct lengths and heights
 * on site and verify them, separately from the finish being confirmed.
 *
 * Never on lead intake, estimating, quoting or booking, and never touches
 * the price. A job with only the single total keeps working without this.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, Plus, Trash2, Ruler } from "lucide-react";
import { api, type CompanyCamJob, type JobRun, type JobRunsPayload, type RunFace, type StainOption } from "@/lib/api";
import { cn, errMessage } from "@/lib/utils";
import { tr, isSpanish } from "@/lib/i18n";

const GROUPS: JobRun["group"][] = ["Front", "Back", "Left", "Right", "Other"];
const FACES = ["inside", "outside"] as const;

function newRun(height: number): JobRun {
  return {
    id: Math.random().toString(36).slice(2, 12), label: "", group: "Back",
    length_ft: 0, height_ft: height, gate_in_length: false,
    faces: { inside: { state: "pending", stain_id: "" }, outside: { state: "skip", stain_id: "" } },
  };
}

function faceValue(f: RunFace): string {
  return f.state === "coat" ? `s:${f.stain_id}` : f.state;
}

function faceFrom(v: string): RunFace {
  if (v.startsWith("s:")) return { state: "coat", stain_id: v.slice(2) };
  return { state: v === "skip" ? "skip" : "pending", stain_id: "" };
}

function when(iso: string): string {
  return iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
}

export function JobRunsSummaryView({ p }: { p: JobRunsPayload }) {
  const s = p.summary;
  if (!s) return null;
  const es = isSpanish();
  const sq = es ? "pies²" : "sq ft";
  return (
    <div className="space-y-2">
      <p className="text-[15px] font-bold">
        {tr("Coated area")}: {s.total_sqft.toLocaleString()} {sq}
      </p>
      {s.materials.map((m) => (
        <div key={m.stain_id} className="rounded-xl bg-white/70 p-3 ring-1 ring-black/10">
          <p className="text-[15px] font-bold">{m.label}</p>
          <p className="text-[15px] tabular-nums">
            {m.sqft.toLocaleString()} {sq} ·{" "}
            {m.gallons != null
              ? (es ? `unos ${m.gallons} gal` : `about ${m.gallons} gal`)
              : <span className="font-semibold text-amber-800">{tr("gallons unknown, see what's missing")}</span>}
          </p>
          <p className="text-sm text-muted-foreground">{m.faces.join(", ")}</p>
        </div>
      ))}
      {s.pending.faces.length ? (
        <div className="rounded-xl bg-amber-50 p-3 ring-1 ring-amber-300">
          <p className="text-[15px] font-bold text-amber-950">{tr("Finish not picked")}: {s.pending.sqft.toLocaleString()} {sq}</p>
          <p className="text-sm text-amber-900">{s.pending.faces.join(", ")}</p>
        </div>
      ) : null}
      {s.missing.length ? (
        <div className="rounded-xl bg-amber-50 p-3 ring-1 ring-amber-300">
          <p className="text-[15px] font-bold text-amber-950">{tr("Missing before gallons are known")}</p>
          <ul className="list-disc pl-5 text-sm text-amber-900">
            {s.missing.map((x) => <li key={x}>{x}</li>)}
          </ul>
        </div>
      ) : null}
      <p className={cn("rounded-xl px-3 py-2 text-[15px] font-bold",
        p.ready_to_load ? "bg-emerald-50 text-emerald-900 ring-1 ring-emerald-300" : "bg-muted text-muted-foreground")}>
        {p.ready_to_load
          ? `✓ ${tr("Material list ready to load")}${s.gallons_total != null ? ` · ${s.gallons_total} gal` : ""}`
          : tr("Material list not ready to load yet")}
      </p>
    </div>
  );
}

export default function JobRunsCard({
  leadId, payload, stains, manager, startHeight, onSaved,
}: {
  leadId: string;
  payload: JobRunsPayload;
  stains: StainOption[];
  /** Office: picks finishes and confirms them. Crew: lengths/heights + verify. */
  manager: boolean;
  startHeight: number;
  onSaved: (p: JobRunsPayload, job: CompanyCamJob) => void;
}) {
  const [runs, setRuns] = useState<JobRun[]>(payload.runs);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRuns(payload.runs); }, [payload.runs]);
  const dirty = useMemo(() => JSON.stringify(runs) !== JSON.stringify(payload.runs), [runs, payload.runs]);
  const stainChoices = useMemo(() => stains.filter((s) => s.active || runs.some((r) => FACES.some((f) => r.faces[f].stain_id === s.id))), [stains, runs]);
  const es = isSpanish();

  if (!payload.job_confirmed) return null;

  const set = (i: number, patch: Partial<JobRun>) => setRuns((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setFace = (i: number, f: (typeof FACES)[number], v: string) =>
    setRuns((rs) => rs.map((r, j) => (j === i ? { ...r, faces: { ...r.faces, [f]: faceFrom(v) } } : r)));

  const save = async (extra: { verify?: boolean; confirm_finish?: boolean } = {}) => {
    setBusy(true);
    try {
      const r = await api.saveJobRuns(leadId, { ...(dirty ? { runs } : {}), ...extra });
      onSaved(r.runs, r.job);
      toast.success(extra.verify ? tr("Measurements verified") : extra.confirm_finish ? "Finish confirmed" : tr("Saved"));
    } catch (e) {
      toast.error(errMessage(e, tr("Couldn't save")));
    } finally {
      setBusy(false);
    }
  };

  const faceLabel = (f: RunFace) => f.state === "skip" ? tr("Not coated") : f.state === "pending" ? tr("Finish not picked")
    : stains.find((s) => s.id === f.stain_id)?.label || tr("Unknown stain");

  return (
    <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-base font-bold"><Ruler className="h-5 w-5" />{tr("Runs and finishes")}</p>
        <div className="flex flex-wrap gap-2 text-sm font-semibold">
          <span className={cn("rounded-full px-3 py-1", payload.verified_at ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900")}>
            {payload.verified_at ? `✓ ${tr("Measurements verified")} · ${payload.verified_by} ${when(payload.verified_at)}` : tr("Measurements not verified")}
          </span>
          <span className={cn("rounded-full px-3 py-1", payload.finish_confirmed_at ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900")}>
            {payload.finish_confirmed_at ? `✓ ${tr("Finish confirmed")} · ${payload.finish_confirmed_by} ${when(payload.finish_confirmed_at)}` : tr("Finish not confirmed")}
          </span>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        {manager
          ? "Trace each run once. If both faces get coated, set both faces; don't add the run twice. A gate already inside the run's length isn't added again."
          : tr("Check each length and height on site. Fix any that are wrong, then tap Measurements are right.")}
      </p>

      {runs.map((r, i) => (
        <div key={r.id} className="space-y-2 rounded-xl bg-muted/40 p-3 ring-1 ring-border">
          <div className="flex flex-wrap items-center gap-2">
            {manager ? (
              <>
                <select value={r.group} onChange={(e) => set(i, { group: e.target.value as JobRun["group"] })} aria-label="Side"
                        className="h-11 rounded-lg border border-border bg-background px-2 text-[15px] font-semibold">
                  {GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
                <input value={r.label} onChange={(e) => set(i, { label: e.target.value })} placeholder="Label, e.g. Front left gate"
                       className="h-11 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-[15px]" />
                <button type="button" onClick={() => setRuns((rs) => rs.filter((_, j) => j !== i))} aria-label="Remove run"
                        className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground ring-1 ring-border hover:text-destructive">
                  <Trash2 className="h-4 w-4" />
                </button>
              </>
            ) : <p className="text-[15px] font-bold">{r.label} <span className="font-normal text-muted-foreground">· {r.group}</span></p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 text-[15px]">
              <input type="number" inputMode="decimal" value={r.length_ft || ""} onChange={(e) => set(i, { length_ft: parseFloat(e.target.value) || 0 })}
                     className="h-11 w-24 rounded-lg border border-border bg-background px-2 text-[15px] font-semibold tabular-nums" aria-label="Length in feet" />
              {es ? "pies de largo" : "ft long"}
            </label>
            <span>×</span>
            <label className="flex items-center gap-1 text-[15px]">
              <input type="number" inputMode="decimal" step="0.5" value={r.height_ft || ""} onChange={(e) => set(i, { height_ft: parseFloat(e.target.value) || 0 })}
                     className="h-11 w-20 rounded-lg border border-border bg-background px-2 text-[15px] font-semibold tabular-nums" aria-label="Height in feet" />
              {es ? "pies de alto" : "ft tall"}
            </label>
            <span className="text-[15px] font-bold tabular-nums">= {Math.round(r.length_ft * r.height_ft).toLocaleString()} {es ? "pies²" : "sq ft"} {tr("per face")}</span>
          </div>
          {manager ? (
            <label className="flex min-h-11 items-center gap-2 text-[15px]">
              <input type="checkbox" className="h-5 w-5" checked={r.gate_in_length} onChange={(e) => set(i, { gate_in_length: e.target.checked })} />
              Gate is inside this length (not added again)
            </label>
          ) : r.gate_in_length ? <p className="text-sm text-muted-foreground">{tr("Gate is inside this length")}</p> : null}
          <div className="grid gap-2 sm:grid-cols-2">
            {FACES.map((f) => (
              <div key={f}>
                <p className="text-sm font-semibold capitalize">{f === "inside" ? tr("Inside") : tr("Outside")}</p>
                {manager ? (
                  <select value={faceValue(r.faces[f])} onChange={(e) => setFace(i, f, e.target.value)} aria-label={`${r.label || r.group} ${f}`}
                          className="h-11 w-full rounded-lg border border-border bg-background px-2 text-[15px]">
                    <option value="skip">Not coated</option>
                    <option value="pending">Coated, finish not picked yet</option>
                    {stainChoices.map((s) => <option key={s.id} value={`s:${s.id}`}>{s.label}{s.active ? "" : " (inactive)"}</option>)}
                  </select>
                ) : <p className="text-[15px]">{faceLabel(r.faces[f])}</p>}
              </div>
            ))}
          </div>
        </div>
      ))}

      {manager ? (
        <button type="button" onClick={() => setRuns((rs) => [...rs, newRun(rs[rs.length - 1]?.height_ft || startHeight)])}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-[15px] font-semibold ring-1 ring-border hover:bg-muted">
          <Plus className="h-4 w-4" />Add a run
        </button>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {manager && dirty ? (
          <button type="button" disabled={busy} onClick={() => void save()}
                  className="min-h-11 rounded-lg bg-primary px-4 text-[15px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            Save runs
          </button>
        ) : null}
        {runs.length ? (
          <button type="button" disabled={busy || (!dirty && !!payload.verified_at)} onClick={() => void save({ verify: true })}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-emerald-700 px-4 text-[15px] font-semibold text-white hover:bg-emerald-800 disabled:opacity-50">
            <Check className="h-4 w-4" />{dirty ? tr("Save and verify measurements") : tr("Measurements are right")}
          </button>
        ) : null}
        {manager && payload.runs.length && !dirty ? (
          payload.finish_confirmed_at ? (
            <button type="button" disabled={busy} onClick={() => void save({ confirm_finish: false })}
                    className="min-h-11 rounded-lg px-4 text-[15px] font-semibold ring-1 ring-border hover:bg-muted">
              Undo finish confirmed
            </button>
          ) : (
            <button type="button" disabled={busy || !!payload.summary?.pending.faces.length} onClick={() => void save({ confirm_finish: true })}
                    title={payload.summary?.pending.faces.length ? "Pick the stain for every coated face first" : undefined}
                    className="min-h-11 rounded-lg bg-foreground px-4 text-[15px] font-semibold text-background disabled:opacity-50">
              Confirm finish
            </button>
          )
        ) : null}
      </div>

      {payload.summary && !dirty ? <JobRunsSummaryView p={payload} /> : null}
      {dirty ? <p className="text-sm font-semibold text-amber-800">{tr("Not saved yet")}</p> : null}
    </div>
  );
}
