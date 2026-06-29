import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { api, type SopRun, type SopRunStep, type ScheduledJob, getCurrentUser } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { ArrowLeft, Camera, AlertCircle, RefreshCw, Lock, Clock, MapPin, Droplets, Cloud } from "lucide-react";
import JobPhotosPanel from "@/components/JobPhotosPanel";

const PKG_LABEL: Record<string, string> = {
  essential: "Essential finish",
  signature: "Signature finish",
  legacy: "Legacy finish",
  custom: "Custom finish",
};

function fmtArrival(t?: string): string {
  if (!t) return "—";
  const [hh, mm] = t.split(":").map(Number);
  if (Number.isNaN(hh)) return t;
  const period = hh >= 12 ? "PM" : "AM";
  const h12 = hh % 12 || 12;
  return `${h12}:${String(mm || 0).padStart(2, "0")} ${period}`;
}

// Job-info header shown at the top of the SOP page: who/where/when, the sides,
// weather, package, plus an editable stain color the crew can set if the PM
// didn't assign one. Independent of whether a SOP template exists.
function JobHeader({ job, onSaved }: { job: ScheduledJob; onSaved: (j: ScheduledJob) => void }) {
  const [color, setColor] = useState(job.color_choice || "");
  const [saving, setSaving] = useState(false);
  const initial = useRef(job.color_choice || "");
  useEffect(() => {
    setColor(job.color_choice || "");
    initial.current = job.color_choice || "";
  }, [job.color_choice]);

  const saveColor = async () => {
    if (color === initial.current) return;
    setSaving(true);
    try {
      const updated = await api.updateJobMaterials(job.id, { color_choice: color });
      initial.current = color;
      onSaved(updated);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save color");
    } finally {
      setSaving(false);
    }
  };

  const w = job.weather_today;
  const pkg = job.package_tier ? (PKG_LABEL[job.package_tier] || job.package_tier) : "";

  return (
    <Card>
      <CardContent className="p-3 space-y-2 text-sm">
        <div className="font-semibold text-base">{job.customer_name || "Job"}</div>
        <div className="flex items-center gap-2 text-muted-foreground">
          <Clock className="h-3.5 w-3.5 shrink-0" />
          <span>{job.job_date} · {fmtArrival(job.arrival_time)}</span>
        </div>
        {job.address && (
          <a
            href={`https://maps.google.com/?q=${encodeURIComponent(job.address)}`}
            target="_blank"
            rel="noreferrer"
            className="flex items-start gap-2 text-primary hover:underline"
          >
            <MapPin className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>{job.address}</span>
          </a>
        )}
        {w && w.high_f != null && (
          <div className="flex items-center gap-1.5 text-xs bg-muted/50 rounded px-2 py-1 w-fit">
            {(w.precip_chance_pct || 0) >= 40 ? <Droplets className="h-3.5 w-3.5 text-blue-600" /> : <Cloud className="h-3.5 w-3.5 text-amber-600" />}
            <span>{w.summary || "—"} · {Math.round(w.high_f)}°F · {w.precip_chance_pct ?? 0}% rain</span>
          </div>
        )}
        {job.fence_sides_label && (
          <p><span className="text-muted-foreground">Sides:</span> {job.fence_sides_label}</p>
        )}
        {pkg && (
          <p><span className="text-muted-foreground">Package:</span> {pkg}</p>
        )}
        {job.worker_notes && (
          <div className="bg-blue-50 border border-blue-200 rounded p-2">
            <p className="text-xs font-semibold text-blue-900 mb-0.5">Additional notes</p>
            <p className="text-blue-900 whitespace-pre-wrap">{job.worker_notes}</p>
          </div>
        )}
        <div>
          <label className="text-xs font-semibold text-muted-foreground block mb-0.5">Stain color</label>
          <input
            value={color}
            onChange={(e) => setColor(e.target.value)}
            onBlur={saveColor}
            placeholder="e.g. Cabot Cedar — add if not assigned"
            disabled={saving}
            className="w-full text-sm rounded border bg-background px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>
      </CardContent>
    </Card>
  );
}

// Worker-facing SOP checklist for a single job. Reached via the SOP
// Checklist button on the My Schedule card while a job is in_progress,
// or by tapping any job in the Upcoming/Past tabs. Lean, mobile-first:
// tick steps, leave a note, upload a photo, hit Help.
//
// Read-only mode: workers can only edit SOPs for jobs happening TODAY.
// The backend returns `editable: false` for past/future jobs (and rejects
// writes outright); here we mirror that by disabling every input and
// showing a banner. Admin/VA always get `editable: true`.

export default function JobSops() {
  const { jobId = "" } = useParams<{ jobId: string }>();
  const user = getCurrentUser();
  const [run, setRun] = useState<SopRun | null>(null);
  const [job, setJob] = useState<ScheduledJob | null>(null);
  const [editable, setEditable] = useState(true);
  const [jobDate, setJobDate] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notesDraft, setNotesDraft] = useState<Record<string, string>>({});
  const [showHelp, setShowHelp] = useState<string | null>(null);
  const [helpDraft, setHelpDraft] = useState("");
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const load = useCallback(async () => {
    try {
      const res = await api.getSopRunByJob(jobId);
      setRun(res.run);
      setEditable(res.editable !== false);
      setJobDate(res.job_date || "");
    } catch (e: any) {
      toast.error(e?.message || "Failed to load SOP");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
    // Job header data (address/time/sides/weather/package/color). Fetched
    // independently of the SOP run so the header shows even with no template.
    try {
      setJob(await api.getScheduledJob(jobId));
    } catch {
      /* header just won't render */
    }
  }, [jobId]);

  useEffect(() => { load(); }, [load]);

  // The My Schedule "Photos" button deep-links to /sops/job/:id#photos.
  // Client render means the browser can't honor the hash on its own, so
  // scroll to the Job Photos section once content is on screen.
  useEffect(() => {
    if (!loading && window.location.hash === "#photos") {
      document.getElementById("photos")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [loading]);

  const handleStartRun = async () => {
    if (!run) return;
    try {
      const updated = await api.startSopRun(run.id);
      setRun(updated);
    } catch (e: any) {
      toast.error(e?.message || "Failed to start SOP");
    }
  };

  const handleToggle = async (step: SopRunStep, checked: boolean) => {
    if (!run) return;
    const note = notesDraft[step.step_id] ?? step.note ?? "";
    try {
      const updated = await api.checkSopStep(run.id, step.step_id, checked, note);
      setRun(updated);
    } catch (e: any) {
      toast.error(e?.message || "Failed to update step");
    }
  };

  const handleNoteBlur = async (step: SopRunStep) => {
    if (!run) return;
    const next = notesDraft[step.step_id] ?? "";
    if (next === (step.note || "")) return;
    try {
      const updated = await api.setSopStepNote(run.id, step.step_id, next);
      setRun(updated);
    } catch (e: any) {
      toast.error(e?.message || "Failed to save note");
    }
  };

  const handlePhotoPick = async (step: SopRunStep, file: File | null) => {
    if (!run || !file) return;
    try {
      const updated = await api.uploadSopStepPhoto(run.id, step.step_id, file);
      setRun(updated);
      toast.success("Photo uploaded");
    } catch (e: any) {
      toast.error(e?.message || "Photo upload failed");
    }
  };

  const handleHelpSubmit = async (step: SopRunStep) => {
    if (!run || !helpDraft.trim()) return;
    try {
      const updated = await api.requestSopStepHelp(run.id, step.step_id, helpDraft.trim());
      setRun(updated);
      setShowHelp(null);
      setHelpDraft("");
      toast.success("Help requested — Alan was notified");
    } catch (e: any) {
      toast.error(e?.message || "Failed to request help");
    }
  };

  if (loading) {
    return <div className="p-4 text-center text-muted-foreground">Loading…</div>;
  }

  const backTo = user?.role === "worker" ? "/my-schedule" : "/calendar";

  if (!run) {
    return (
      <div className="p-4 max-w-md mx-auto pb-24">
        <Link to={backTo} className="inline-flex items-center text-sm text-blue-600 mb-3">
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Link>
        {job && <div className="mb-4"><JobHeader job={job} onSaved={setJob} /></div>}
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No SOP configured for this job's service type yet. Ask admin
            to attach a template.
          </CardContent>
        </Card>

        {/* Photo buckets still apply to every job, SOP template or not. */}
        <div id="photos" className="mt-4 scroll-mt-4">
          <JobPhotosPanel jobId={jobId} />
        </div>
      </div>
    );
  }

  const completedCount = run.steps.filter((s) => s.completed).length;
  const totalCount = run.steps.length;
  const pct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  return (
    <div className="p-4 max-w-md mx-auto pb-24">
      <div className="flex items-center justify-between mb-3">
        <Link to={backTo} className="inline-flex items-center text-sm text-blue-600">
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Link>
        <Button variant="ghost" size="sm" onClick={() => { setRefreshing(true); load(); }} disabled={refreshing}>
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {job && <div className="mb-4"><JobHeader job={job} onSaved={setJob} /></div>}

      <h1 className="text-xl font-bold mb-1">{run.template_name_snapshot || "SOP Checklist"}</h1>
      <div className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
        <span>{completedCount} / {totalCount} steps</span>
        <div className="flex-1 h-2 bg-slate-200 rounded-full overflow-hidden">
          <div className="h-full bg-green-600 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-xs font-medium">{pct}%</span>
      </div>

      {!editable && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 mb-4 text-sm text-amber-900">
          <Lock className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            View only — this job is{" "}
            {jobDate && jobDate > new Date().toISOString().slice(0, 10) ? "scheduled for a future date" : "from a past date"}.
            You can review the checklist, but you can only check steps and upload photos on the day of the job.
          </span>
        </div>
      )}

      {run.status === "pending" && editable && (
        <Button className="w-full mb-4 bg-blue-600 hover:bg-blue-700" onClick={handleStartRun}>
          Start SOP
        </Button>
      )}

      <div className="space-y-2">
        {run.steps.map((step) => (
          <Card key={step.step_id} className={step.completed ? "opacity-70" : ""}>
            <CardContent className="p-3 space-y-2">
              <label className={`flex items-start gap-3 ${editable ? "cursor-pointer" : ""}`}>
                <input
                  type="checkbox"
                  checked={step.completed}
                  disabled={!editable}
                  onChange={(e) => handleToggle(step, e.target.checked)}
                  className="mt-1 h-4 w-4 shrink-0 disabled:opacity-50"
                />
                <div className="min-w-0 flex-1">
                  <div className={`text-sm font-medium ${step.completed ? "line-through" : ""}`}>
                    {step.title}
                    {step.required && <span className="text-red-500 ml-1">*</span>}
                  </div>
                  {step.description && (
                    <div className="text-xs text-muted-foreground mt-0.5">{step.description}</div>
                  )}
                </div>
              </label>

              {editable && (
                <div className="flex gap-2 pl-7">
                  <input
                    ref={(el) => { fileInputs.current[step.step_id] = el; }}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                    onChange={(e) => handlePhotoPick(step, e.target.files?.[0] || null)}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fileInputs.current[step.step_id]?.click()}
                  >
                    <Camera className="h-3.5 w-3.5 mr-1" />
                    {step.photo_id ? "Re-upload" : "Photo"}
                    {step.photo_required && !step.photo_id && (
                      <Badge className="ml-1 bg-amber-200 text-amber-900 text-[10px] py-0">required</Badge>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setShowHelp(step.step_id); setHelpDraft(step.help_note || ""); }}
                  >
                    <AlertCircle className="h-3.5 w-3.5 mr-1" /> Help
                  </Button>
                  {step.help_requested_at && (
                    <Badge className="bg-amber-500 text-white text-[10px] self-center">help req'd</Badge>
                  )}
                </div>
              )}

              {/* Photo-required hint stays visible in read-only mode so the
                  worker knows what tomorrow's job will need. */}
              {!editable && step.photo_required && (
                <div className="pl-7 text-[11px] text-amber-700 flex items-center gap-1">
                  <Camera className="h-3 w-3" /> Photo required on job day
                </div>
              )}

              {editable ? (
                <Textarea
                  placeholder="Add a note…"
                  value={notesDraft[step.step_id] ?? step.note ?? ""}
                  onChange={(e) => setNotesDraft((d) => ({ ...d, [step.step_id]: e.target.value }))}
                  onBlur={() => handleNoteBlur(step)}
                  rows={2}
                  className="text-sm ml-7"
                />
              ) : (
                step.note ? (
                  <div className="ml-7 text-xs text-muted-foreground bg-slate-50 rounded px-2 py-1.5 whitespace-pre-wrap">
                    {step.note}
                  </div>
                ) : null
              )}

              {showHelp === step.step_id && (
                <div className="pl-7 space-y-2 border-t pt-2">
                  <Textarea
                    placeholder="What's the problem?"
                    value={helpDraft}
                    onChange={(e) => setHelpDraft(e.target.value)}
                    rows={2}
                    className="text-sm"
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <Button size="sm" className="flex-1" onClick={() => handleHelpSubmit(step)}>
                      Send to Alan
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { setShowHelp(null); setHelpDraft(""); }}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Job photos — inspection / post-cleanup / post-staining buckets the
          crew shoots from their phone. Uploadable any day (the clean→dry→stain
          cycle can span days), independent of the today-only SOP step lock. */}
      <div id="photos" className="mt-6 scroll-mt-4">
        <JobPhotosPanel jobId={jobId} />
      </div>
    </div>
  );
}
