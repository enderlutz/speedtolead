// JobRunsPanel — per-run, per-face measurements on a confirmed job.
//
// Part of the job page's measurement step, shown only once the job is
// confirmed (closed, deposit paid or waived, or paid). Never part of lead
// intake, estimating, quoting or booking, and never needed to book a job.
//
// Each physical fence run is traced once: a label, a length, a height. Two
// runs can share a group ("Front") and still keep their own measurement.
// Each run has an inside and an outside face; each face is coated with an
// exact product (finish + color), coated with the finish still pending, or
// not coated. A run coated on both faces counts its area once per face, with
// no second line.
//
// "Measurements verified" (the cleaner checked them on site) is separate
// from "Finishes confirmed" (every face has its product), so the cleaner can
// finish measuring before the customer picks a color. The backend
// (services/job_runs.py) clears each stamp when what it vouches for changes.
import { useEffect, useMemo, useState } from "react";
import { Check, Plus, Ruler, Trash2, AlertTriangle, DoorOpen } from "lucide-react";
import type { CompanyCamJob, JobMaterials, JobRun, JobRunFace, StainOption } from "@/lib/api";
import { Panel } from "@/components/Panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ACCENT } from "@/lib/accents";
import { cn } from "@/lib/utils";
import { tr } from "@/lib/i18n";

const FACES = ["inside", "outside"] as const;
type Face = typeof FACES[number];

const newRun = (height: number): JobRun => ({
  id: Math.random().toString(36).slice(2, 14),
  label: "", group: "", length_ft: 0, height_ft: height, includes_gate: false,
  faces: { inside: { state: "pending" }, outside: { state: "excluded" } },
});

/** The select's value for a face: "excluded", "pending", or a stain id. */
const faceValue = (f: JobRunFace) => (f.state === "coat" && f.stain_id ? f.stain_id : f.state === "coat" ? "pending" : f.state);
const faceFrom = (v: string): JobRunFace =>
  v === "excluded" || v === "pending" ? { state: v } : { state: "coat", stain_id: v };

const stamp = (by?: string, at?: string) =>
  at ? `${by || "the office"}, ${new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "";

export default function JobRunsPanel({ job, materials, stainOptions, startHeight, onSave }: {
  job: CompanyCamJob;
  materials?: JobMaterials;
  stainOptions: StainOption[];
  startHeight: number;
  onSave: (p: { runs?: JobRun[]; runs_verified?: boolean; finishes_confirmed?: boolean }) => Promise<void>;
}) {
  const saved = job.runs || [];
  const [draft, setDraft] = useState<JobRun[]>(saved);
  const [busy, setBusy] = useState(false);
  const savedKey = JSON.stringify(saved);
  useEffect(() => { setDraft(JSON.parse(savedKey)); }, [savedKey]);
  const dirty = JSON.stringify(draft) !== savedKey;

  // Active stains, plus any inactive one a face already names, so a saved
  // choice never silently disappears from its select.
  const used = useMemo(() => new Set(draft.flatMap((r) => FACES.map((f) => r.faces[f].stain_id || ""))), [draft]);
  const options = stainOptions.filter((o) => o.active || used.has(o.id));

  const setRun = (i: number, p: Partial<JobRun>) => setDraft((d) => d.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const setFace = (i: number, f: Face, v: string) =>
    setDraft((d) => d.map((r, j) => (j === i ? { ...r, faces: { ...r.faces, [f]: faceFrom(v) } } : r)));

  const run = async (p: Parameters<typeof onSave>[0]) => {
    setBusy(true);
    try { await onSave(p); } finally { setBusy(false); }
  };

  const verified = !!job.runs_verified_at;
  const finished = !!job.finishes_confirmed_at;

  return (
    <Panel icon={Ruler} accent={ACCENT.cedar} title={tr("Fence runs and finishes")}
           sub={tr("Trace each run once. Pick what goes on each face. The crew card adds it up per product.")}>
      {!saved.length && (job.sqft || 0) > 0 ? (
        <p className="mb-3 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
          {tr("This job uses the single total")} ({Math.round(job.sqft).toLocaleString()} sq ft). {tr("Add runs only if the faces get different finishes or you want a per-product list. Nothing has to be remeasured.")}
        </p>
      ) : null}

      <div className="space-y-3">
        {draft.map((r, i) => {
          const area = r.length_ft && r.height_ft ? Math.round(r.length_ft * r.height_ft) : 0;
          return (
            <div key={r.id} className="rounded-xl border border-border p-3">
              <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-40 flex-1">
                  <span className="text-xs font-semibold text-muted-foreground">{tr("Run")}</span>
                  <Input value={r.label} placeholder={tr("e.g. Front left gate/run")} className="h-11 text-base"
                         onChange={(e) => setRun(i, { label: e.target.value })} />
                </label>
                <label className="w-28">
                  <span className="text-xs font-semibold text-muted-foreground">{tr("Group")}</span>
                  <Input value={r.group} placeholder={tr("Front")} className="h-11 text-base"
                         onChange={(e) => setRun(i, { group: e.target.value })} />
                </label>
                <label className="w-24">
                  <span className="text-xs font-semibold text-muted-foreground">{tr("Length (ft)")}</span>
                  <Input type="number" inputMode="decimal" min="0" value={r.length_ft || ""} className="h-11 text-base tabular-nums"
                         onChange={(e) => setRun(i, { length_ft: parseFloat(e.target.value || "0") || 0 })} />
                </label>
                <label className="w-24">
                  <span className="text-xs font-semibold text-muted-foreground">{tr("Height (ft)")}</span>
                  <Input type="number" inputMode="decimal" min="0" step="0.5" value={r.height_ft || ""} className="h-11 text-base tabular-nums"
                         onChange={(e) => setRun(i, { height_ft: parseFloat(e.target.value || "0") || 0 })} />
                </label>
                <button type="button" aria-label={tr("Remove run")} onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
                        className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-red-600">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <label className="mt-2 flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" className="h-5 w-5" checked={r.includes_gate}
                       onChange={(e) => setRun(i, { includes_gate: e.target.checked })} />
                <DoorOpen className="h-4 w-4 text-muted-foreground" />
                {tr("The gate is already in this length (don't add it again)")}
              </label>
              <div className="mt-1 grid gap-2 sm:grid-cols-2">
                {FACES.map((f) => (
                  <label key={f} className="block">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{f === "inside" ? tr("Inside") : tr("Outside")}</span>
                    <select value={faceValue(r.faces[f])} onChange={(e) => setFace(i, f, e.target.value)}
                            aria-label={f === "inside" ? tr("Inside") : tr("Outside")}
                            className={cn("h-11 w-full rounded-md border border-input bg-background px-2 text-base",
                              r.faces[f].state === "pending" && "border-amber-400 bg-amber-50 dark:bg-amber-950/30")}>
                      <option value="excluded">{tr("Not coated")}</option>
                      <option value="pending">{tr("Coated, finish pending")}</option>
                      {options.map((o) => <option key={o.id} value={o.id}>{o.label}{o.active ? "" : " (inactive)"}</option>)}
                    </select>
                  </label>
                ))}
              </div>
              <p className="mt-1.5 text-sm text-muted-foreground tabular-nums">
                {area ? `${r.length_ft} ft × ${r.height_ft} ft = ${area.toLocaleString()} sq ft a face` : tr("Length and height needed")}
                {area ? ` · ${FACES.filter((f) => r.faces[f].state !== "excluded").length} ${tr("coated face(s)")}` : ""}
              </p>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" variant="outline" className="min-h-11" onClick={() => setDraft((d) => [...d, newRun(d[d.length - 1]?.height_ft || startHeight)])}>
          <Plus className="mr-1 h-4 w-4" />{tr("Add a run")}
        </Button>
        {dirty ? (
          <>
            <Button type="button" className="min-h-11" disabled={busy} onClick={() => void run({ runs: draft })}>
              <Check className="mr-1 h-4 w-4" />{tr("Save runs")}
            </Button>
            <Button type="button" variant="ghost" className="min-h-11" disabled={busy} onClick={() => setDraft(JSON.parse(savedKey))}>
              {tr("Undo changes")}
            </Button>
          </>
        ) : null}
      </div>

      {saved.length ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <StampBox done={verified} title={tr("Measurements verified")} who={stamp(job.runs_verified_by, job.runs_verified_at)}
                    hint={tr("The cleaner checked every length and height on site.")}
                    disabled={busy || dirty} onDo={() => void run({ runs_verified: true })} onUndo={() => void run({ runs_verified: false })}
                    doLabel={tr("Mark measurements verified")} />
          <StampBox done={finished} title={tr("Finishes confirmed")} who={stamp(job.finishes_confirmed_by, job.finishes_confirmed_at)}
                    hint={tr("Every coated face has its exact product and color.")}
                    disabled={busy || dirty} onDo={() => void run({ finishes_confirmed: true })} onUndo={() => void run({ finishes_confirmed: false })}
                    doLabel={tr("Confirm finishes")} />
        </div>
      ) : null}
      {dirty && saved.length ? <p className="mt-2 text-sm text-muted-foreground">{tr("Save the runs first.")}</p> : null}
      {materials?.has_runs && !materials.ready && materials.missing.length ? (
        <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950 ring-1 ring-amber-200 dark:bg-amber-950/30 dark:text-amber-100">
          <p className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="h-4 w-4" />{tr("Material list not ready to load")}</p>
          <ul className="mt-1 list-disc pl-5">{materials.missing.map((m) => <li key={m}>{m}</li>)}</ul>
        </div>
      ) : null}
    </Panel>
  );
}

function StampBox({ done, title, who, hint, disabled, onDo, onUndo, doLabel }: {
  done: boolean; title: string; who: string; hint: string; disabled: boolean;
  onDo: () => void; onUndo: () => void; doLabel: string;
}) {
  return (
    <div className={cn("rounded-xl p-3 ring-1", done ? "bg-emerald-50 ring-emerald-200 dark:bg-emerald-950/30" : "bg-card ring-border")}>
      <p className={cn("text-sm font-bold", done && "text-emerald-900 dark:text-emerald-200")}>{done ? "✓ " : ""}{title}</p>
      <p className="text-sm text-muted-foreground">{done ? who : hint}</p>
      {done ? (
        <button type="button" disabled={disabled} onClick={onUndo} className="mt-1 min-h-11 text-sm font-semibold text-muted-foreground underline">{tr("Undo")}</button>
      ) : (
        <Button type="button" disabled={disabled} onClick={onDo} className="mt-2 min-h-11 w-full">{doLabel}</Button>
      )}
    </div>
  );
}

/** The crew card's material lines: total coated sq ft, then per product the
 *  sq ft, gallons and faces. Shows what's missing instead of guessing. */
export function MaterialsBrief({ m }: { m: JobMaterials }) {
  return (
    <div className="space-y-2 py-2.5">
      <div className="flex items-start gap-3">
        <span className="w-8 shrink-0 text-center text-xl leading-7" aria-hidden>📏</span>
        <span className="w-20 shrink-0 pt-0.5 text-sm text-muted-foreground">{tr("Coated")}</span>
        <span className="min-w-0 flex-1 text-base font-bold leading-snug">
          {m.total_sqft != null ? `${m.total_sqft.toLocaleString()} sq ft` : tr("Not complete")}
          {m.measurements_verified ? " ✓" : <span className="block text-sm font-normal">{tr("Measurements not verified on site yet")}</span>}
        </span>
      </div>
      <div className="flex items-start gap-3">
        <span className="w-8 shrink-0 text-center text-xl leading-7" aria-hidden>🪣</span>
        <span className="w-20 shrink-0 pt-0.5 text-sm text-muted-foreground">{tr("Materials")}</span>
        <div className="min-w-0 flex-1 space-y-2">
          <p className={cn("inline-block rounded-md px-2 py-0.5 text-xs font-bold uppercase tracking-wide",
                           m.ready ? "bg-emerald-600 text-white" : "bg-amber-500 text-black")}>
            {m.ready ? tr("Ready to load") : tr("Not ready to load")}
          </p>
          {m.lines.map((l) => (
            <div key={l.stain_id} className="text-base leading-snug">
              <p className="font-bold">{l.label}</p>
              <p className="tabular-nums">
                {l.sqft != null ? `${l.sqft.toLocaleString()} sq ft` : tr("sq ft missing")}
                {" · "}
                {l.gallons != null ? `${l.gallons} gal (${l.sqft_per_gallon} sq ft/gal)` : tr("gallons not worked out")}
              </p>
              <p className="text-sm text-black/60">{l.faces.join(", ")}</p>
              {l.missing.map((x) => <p key={x} className="text-sm font-semibold text-amber-800">⚠ {x}</p>)}
            </div>
          ))}
          {m.pending.length ? (
            <div className="text-base leading-snug">
              <p className="font-bold">{tr("Finish pending")}</p>
              <p className="text-sm text-black/60">
                {m.pending.map((p) => `${p.face}${p.sqft != null ? ` (${p.sqft.toLocaleString()} sq ft)` : ""}`).join(", ")}
              </p>
            </div>
          ) : null}
          {!m.ready && m.missing.length ? (
            <ul className="list-disc pl-5 text-sm text-amber-900">{m.missing.map((x) => <li key={x}>{x}</li>)}</ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}
