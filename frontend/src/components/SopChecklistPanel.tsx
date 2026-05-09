import { useEffect, useState, useCallback, useRef } from "react";
import {
  api, type SopRun, type SopRunStep, type SopRunPhotoMeta, type SopMultiselectConfig,
  SOP_CATEGORIES, getCurrentUser,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  ListChecks, Camera, MessageSquare, AlertCircle, Loader2,
  Check, Trash2, ChevronDown, ChevronUp, HelpCircle, ImageIcon,
  Info, Droplets, Zap, GitBranch, Clock, Bell, Send, X as XIcon,
} from "lucide-react";

interface Props {
  scheduledJobId: string;
  /** Worker view shows the interactive checklist; admin view shows
   * read-only progress + flagged help requests. */
  asWorker: boolean;
}

/** SOP checklist UI mounted on the Calendar JobDetailModal.
 *
 * Worker flow:
 *   - On open, fetch the run for this job
 *   - "Start job" sets status=in_progress
 *   - Tap a step to expand → check, add note, attach photo, request help
 *   - Photos are uploaded to /api/sops/runs/{run_id}/steps/{step_id}/photo
 *
 * Admin flow:
 *   - Same expand-on-tap, but check/uncheck still works (admin can correct)
 *   - Help-requested steps show a red flag at the row level
 */
export default function SopChecklistPanel({ scheduledJobId, asWorker }: Props) {
  const user = getCurrentUser();
  const isAdmin = user?.role === "admin" || user?.role === "va";
  const [run, setRun] = useState<SopRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const [logHoursOpen, setLogHoursOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.getSopRunByJob(scheduledJobId)
      .then((r) => setRun(r.run))
      .catch(() => toast.error("Failed to load checklist"))
      .finally(() => setLoading(false));
  }, [scheduledJobId]);

  useEffect(() => { load(); }, [load]);

  const refresh = (updated: SopRun) => setRun(updated);

  const startRun = async () => {
    if (!run) return;
    try {
      const updated = await api.startSopRun(run.id);
      refresh(updated);
      toast.success("Checklist started — let's go");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start");
    }
  };

  const toggleStep = async (step: SopRunStep, completed: boolean) => {
    if (!run) return;
    try {
      const updated = await api.checkSopStep(run.id, step.step_id, completed, step.note);
      refresh(updated);
      // Soft completion celebration when the run flips to "completed"
      if (updated.status === "completed" && run.status !== "completed") {
        toast.success("All required steps done — nice work");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update");
    }
  };

  if (loading) {
    return (
      <div className="border-t pt-3 mt-3">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground mx-auto" />
      </div>
    );
  }

  if (!run) {
    // No template configured for this service yet
    return (
      <div className="border-t pt-3 mt-3 text-center">
        <ListChecks className="h-6 w-6 text-muted-foreground/50 mx-auto mb-1.5" />
        <p className="text-xs text-muted-foreground italic">
          No checklist configured for this service type yet.
        </p>
        {isAdmin && (
          <p className="text-[11px] text-muted-foreground/70 mt-1">
            Create one in Payroll → SOPs.
          </p>
        )}
      </div>
    );
  }

  // Filter to visible steps (branch-aware) and group by section_name
  // (when set) or category bucket otherwise. Sections render in the
  // order their first step appears so admin-defined ordering wins.
  const branchHidesStep = (step: SopRunStep): boolean => {
    if (!step.branch_key) return false;
    if (!run.selected_branch) return true;       // no choice yet → hide branched
    return step.branch_key !== run.selected_branch;
  };
  const visibleSteps = run.steps.filter((s) => !branchHidesStep(s));
  const groups = groupBySection(visibleSteps);

  const helpFlagged = visibleSteps.filter((s) => s.help_requested_at && !s.completed).length;
  const needsMethodPick = run.branches.length > 0 && !run.selected_branch;

  const pickBranch = async (branchKey: string) => {
    try {
      const updated = await api.selectSopBranch(run.id, branchKey);
      refresh(updated);
      toast.success(`Method set: ${run.branches.find((b) => b.key === branchKey)?.label || branchKey}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to set method");
    }
  };

  return (
    <div className="border-t pt-3 mt-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Job Checklist</span>
          <span className="text-[11px] text-muted-foreground truncate">
            {run.template_name_snapshot}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {helpFlagged > 0 && (
            <Badge className="bg-red-100 text-red-800 text-[10px] gap-0.5">
              <AlertCircle className="h-2.5 w-2.5" /> {helpFlagged} help
            </Badge>
          )}
          <Badge className={
            run.status === "completed" ? "bg-emerald-100 text-emerald-800" :
            run.status === "in_progress" ? "bg-blue-100 text-blue-800" :
            "bg-muted text-muted-foreground"
          }>
            {run.completed_steps}/{run.total_steps} done
          </Badge>
        </div>
      </div>

      {/* Reference card — Min Temp / Spray Tips / etc. */}
      {run.reference_data.length > 0 && (
        <div className="bg-muted/40 border rounded-lg p-2.5">
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1 mb-1.5">
            <Info className="h-2.5 w-2.5" /> Job Reference
          </p>
          <div className="grid grid-cols-2 gap-2">
            {run.reference_data.map((r, i) => (
              <div key={i} className="bg-background rounded px-2 py-1.5">
                <p className="text-[9px] uppercase tracking-wider text-muted-foreground">{r.label}</p>
                <p className="text-sm font-bold">{r.value}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Method picker — only when template has branches AND none picked */}
      {needsMethodPick && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5">
          <p className="text-[10px] font-bold uppercase tracking-wider text-amber-900 flex items-center gap-1 mb-2">
            <GitBranch className="h-2.5 w-2.5" /> Pick the method for this job
          </p>
          <div className="grid grid-cols-2 gap-2">
            {run.branches.map((b) => {
              const Icon = b.icon === "Droplets" ? Droplets : b.icon === "Zap" ? Zap : GitBranch;
              return (
                <button
                  key={b.key}
                  onClick={() => pickBranch(b.key)}
                  className="border-2 rounded-lg p-2 text-center hover:border-primary hover:bg-primary/5 transition"
                >
                  <Icon className="h-5 w-5 text-primary mx-auto mb-1" />
                  <p className="text-xs font-bold">{b.label}</p>
                  {b.subtitle && <p className="text-[10px] text-muted-foreground">{b.subtitle}</p>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Selected method indicator (with switch button) */}
      {run.selected_branch && (
        <div className="flex items-center justify-between text-xs bg-primary/5 border border-primary/20 rounded px-2 py-1">
          <span className="flex items-center gap-1 text-primary font-semibold">
            <GitBranch className="h-3 w-3" />
            Method: {run.branches.find((b) => b.key === run.selected_branch)?.label || run.selected_branch}
          </span>
          {asWorker && run.status !== "completed" && (
            <button
              onClick={() => pickBranch("")}
              className="text-[10px] text-primary hover:underline"
            >
              switch
            </button>
          )}
        </div>
      )}

      {/* Progress bar */}
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${
            run.status === "completed" ? "bg-emerald-500" : "bg-primary"
          }`}
          style={{ width: `${run.completion_pct}%` }}
        />
      </div>

      <div className="flex items-center gap-2">
        {asWorker && run.status === "pending" && !needsMethodPick && (
          <Button size="sm" onClick={startRun} className="flex-1">
            Start job
          </Button>
        )}
        {asWorker && user?.employee_id && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setLogHoursOpen(true)}
            className={run.status === "pending" && !needsMethodPick ? "" : "flex-1"}
          >
            <Clock className="h-3.5 w-3.5 mr-1" /> Log my hours
          </Button>
        )}
      </div>

      {logHoursOpen && (
        <LogHoursModal
          runId={run.id}
          customerName={run.template_name_snapshot || "Job"}
          onClose={() => setLogHoursOpen(false)}
        />
      )}

      {/* Steps grouped by section_name (preferred) or category bucket */}
      <div className="space-y-2.5">
        {groups.map((group) => (
          <div key={group.heading} className="space-y-1">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
              {group.emoji && <span>{group.emoji}</span>}
              {group.heading}
              <span className="font-normal normal-case text-muted-foreground/70 ml-auto">
                {group.steps.filter((s) => s.completed).length}/{group.steps.length}
              </span>
            </p>
            {group.steps.map((step) => (
              <StepCard
                key={step.step_id}
                step={step}
                runId={run.id}
                expanded={expandedStep === step.step_id}
                onToggleExpand={() => setExpandedStep((id) => id === step.step_id ? null : step.step_id)}
                onCheck={(checked) => toggleStep(step, checked)}
                onUpdate={refresh}
                asWorker={asWorker}
                canEdit={asWorker || isAdmin}
              />
            ))}
          </div>
        ))}
      </div>

      {run.status === "completed" && (
        <div className="bg-emerald-50 border border-emerald-200 rounded p-2 text-xs text-emerald-900 flex items-center gap-1.5">
          <Check className="h-3.5 w-3.5" /> All required steps complete. Customer can be marked paid.
        </div>
      )}
    </div>
  );
}


/** Group steps preferring section_name (CrewClock-style "Bleach / Chemical
 * Wash") and falling back to the 5-bucket category. Section order = order
 * of first occurrence so admin's step ordering wins. */
function groupBySection(steps: SopRunStep[]): { heading: string; emoji: string; steps: SopRunStep[] }[] {
  const sorted = [...steps].sort((a, b) => a.order_index - b.order_index);
  const out: { heading: string; emoji: string; steps: SopRunStep[] }[] = [];
  const indexByHeading = new Map<string, number>();

  for (const s of sorted) {
    const heading = s.section_name?.trim()
      || (SOP_CATEGORIES.find((c) => c.key === s.category)?.label || s.category);
    const emoji = s.section_name
      ? ""  // custom sections get no emoji — keep clean
      : (SOP_CATEGORIES.find((c) => c.key === s.category)?.emoji || "");
    const idx = indexByHeading.get(heading);
    if (idx !== undefined) {
      out[idx].steps.push(s);
    } else {
      indexByHeading.set(heading, out.length);
      out.push({ heading, emoji, steps: [s] });
    }
  }
  return out;
}


function StepCard({
  step, runId, expanded, onToggleExpand, onCheck, onUpdate, asWorker, canEdit,
}: {
  step: SopRunStep;
  runId: string;
  expanded: boolean;
  onToggleExpand: () => void;
  onCheck: (checked: boolean) => void;
  onUpdate: (run: SopRun) => void;
  asWorker: boolean;
  canEdit: boolean;
}) {
  const isMultiselect = step.kind === "multiselect_alert";
  const photoMin = step.photo_min_count || (step.photo_required ? 1 : 0);
  const isMultiPhoto = photoMin > 1;

  const [note, setNote] = useState(step.note);
  const [helpNote, setHelpNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [savingMultiselect, setSavingMultiselect] = useState(false);
  // multiselect-alert: local picks until submitted
  const [picks, setPicks] = useState<string[]>(step.selected_options || []);
  // Multi-photo gallery
  const [photos, setPhotos] = useState<SopRunPhotoMeta[]>([]);
  const [photoBlobs, setPhotoBlobs] = useState<Record<string, string>>({});
  const [photoLoading, setPhotoLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sync local state if parent run reloads
  useEffect(() => { setNote(step.note); }, [step.note]);
  useEffect(() => { setPicks(step.selected_options || []); }, [step.selected_options]);

  // Load photo gallery when expanded (V3: list all, not just one)
  useEffect(() => {
    let cancelled = false;
    const localBlobs: Record<string, string> = {};
    if (expanded && photoMin > 0 && !isMultiselect) {
      setPhotoLoading(true);
      api.listSopStepPhotos(runId, step.step_id).then(async (r) => {
        if (cancelled) return;
        setPhotos(r.photos);
        // Fetch blob URLs in parallel
        await Promise.all(r.photos.map(async (p) => {
          const url = await api.fetchSopRunPhotoBlobUrl(runId, p.id);
          if (url) localBlobs[p.id] = url;
        }));
        if (!cancelled) setPhotoBlobs(localBlobs);
      }).catch(() => {}).finally(() => { if (!cancelled) setPhotoLoading(false); });
    }
    return () => {
      cancelled = true;
      Object.values(localBlobs).forEach((u) => URL.revokeObjectURL(u));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, runId, step.step_id, photoMin, isMultiselect]);

  const saveNote = async () => {
    setSavingNote(true);
    try {
      const updated = await api.setSopStepNote(runId, step.step_id, note);
      onUpdate(updated);
      toast.success("Note saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setSavingNote(false);
    }
  };

  const requestHelp = async () => {
    if (!helpNote.trim()) {
      toast.error("Tell admin what's blocking you");
      return;
    }
    try {
      const updated = await api.requestSopStepHelp(runId, step.step_id, helpNote);
      onUpdate(updated);
      setHelpNote("");
      toast.success("Help requested — admin notified");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  const uploadPhoto = async (file: File) => {
    try {
      const updated = await api.uploadSopStepPhoto(runId, step.step_id, file);
      onUpdate(updated);
      // Re-fetch the gallery so the new thumbnail appears
      const r = await api.listSopStepPhotos(runId, step.step_id);
      setPhotos(r.photos);
      const newest = r.photos[r.photos.length - 1];
      if (newest) {
        const url = await api.fetchSopRunPhotoBlobUrl(runId, newest.id);
        if (url) setPhotoBlobs((prev) => ({ ...prev, [newest.id]: url }));
      }
      toast.success("Photo uploaded");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    }
  };

  const removePhoto = async (photoId: string) => {
    if (!confirm("Remove this photo?")) return;
    try {
      const updated = await api.deleteSopRunPhoto(runId, photoId);
      onUpdate(updated);
      setPhotos((prev) => prev.filter((p) => p.id !== photoId));
      setPhotoBlobs((prev) => {
        const url = prev[photoId];
        if (url) URL.revokeObjectURL(url);
        const { [photoId]: _, ...rest } = prev;
        return rest;
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  const submitMultiselect = async () => {
    setSavingMultiselect(true);
    try {
      const r = await api.submitSopMultiselect(runId, step.step_id, picks);
      onUpdate(r);
      const alert = r._alert;
      if (alert?.selected.length === 0) {
        toast.success("Logged — nothing flagged");
      } else if (alert?.sms_sent) {
        toast.success(`Texted Alan: ${alert.selected.join(", ")}`);
      } else if (alert?.skipped_reason) {
        toast.warning(`Saved, but SMS skipped: ${alert.skipped_reason}`);
      } else {
        toast.success("Saved");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setSavingMultiselect(false);
    }
  };

  const helpFlagged = !!step.help_requested_at && !step.completed;

  return (
    <div className={`border rounded-lg overflow-hidden transition ${
      step.completed ? "bg-emerald-50/50 border-emerald-200" :
      helpFlagged ? "bg-red-50/50 border-red-200" :
      "bg-card"
    }`}>
      <div className="p-2 flex items-start gap-2">
        {isMultiselect ? (
          // Multiselect-alert steps: an icon instead of a checkbox. Completion
          // happens via the in-step Submit button when expanded.
          <div
            className={`shrink-0 mt-0.5 h-5 w-5 rounded grid place-items-center ${
              step.completed
                ? "bg-emerald-500 text-white"
                : "bg-amber-100 text-amber-700"
            }`}
            title={step.completed ? "Submitted" : "Tap row to answer"}
          >
            {step.completed ? <Check className="h-3 w-3" /> : <Bell className="h-3 w-3" />}
          </div>
        ) : (
          <button
            onClick={() => {
              if (!canEdit) return;
              const photoMin = step.photo_min_count || (step.photo_required ? 1 : 0);
              const haveEnoughPhotos = photos.length >= photoMin;
              if (!step.completed && photoMin > 0 && !haveEnoughPhotos && !expanded) {
                onToggleExpand();
                return;
              }
              onCheck(!step.completed);
            }}
            disabled={!canEdit}
            className={`shrink-0 mt-0.5 h-5 w-5 rounded border-2 grid place-items-center transition ${
              step.completed
                ? "bg-emerald-500 border-emerald-500 text-white"
                : "border-muted-foreground/40 hover:border-primary"
            } ${!canEdit ? "opacity-50 cursor-not-allowed" : ""}`}
            title={step.completed ? "Mark incomplete" : "Mark complete"}
          >
            {step.completed && <Check className="h-3 w-3" />}
          </button>
        )}

        <button
          onClick={onToggleExpand}
          className="flex-1 min-w-0 text-left"
        >
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`text-sm font-medium ${step.completed ? "line-through text-muted-foreground" : ""}`}>
              {step.title}
            </span>
            {step.required && !step.completed && (
              <span className="text-[10px] uppercase tracking-wider bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-bold">required</span>
            )}
            {!isMultiselect && photoMin > 0 && (
              <span className={`inline-flex items-center gap-0.5 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-bold ${
                photos.length >= photoMin ? "bg-emerald-100 text-emerald-800" : "bg-blue-100 text-blue-800"
              }`}>
                <Camera className="h-2.5 w-2.5" />
                {photoMin > 1 ? `${photos.length}/${photoMin}` : (photos.length > 0 ? "photo ✓" : "photo")}
              </span>
            )}
            {isMultiselect && step.selected_options && step.selected_options.length > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[10px] uppercase tracking-wider bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-bold">
                <Bell className="h-2.5 w-2.5" /> {step.selected_options.length} flagged
              </span>
            )}
            {helpFlagged && (
              <span className="inline-flex items-center gap-0.5 text-[10px] uppercase tracking-wider bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-bold">
                <AlertCircle className="h-2.5 w-2.5" /> needs help
              </span>
            )}
            {step.note && !expanded && (
              <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
                <MessageSquare className="h-2.5 w-2.5" /> note
              </span>
            )}
          </div>
          {step.completed_by && (
            <p className="text-[10px] text-muted-foreground mt-0.5">
              ✓ {step.completed_by} · {step.completed_at?.slice(0, 16).replace("T", " ")}
            </p>
          )}
        </button>

        <button onClick={onToggleExpand} className="text-muted-foreground hover:text-foreground p-0.5">
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
      </div>

      {expanded && (
        <div className="border-t bg-background/60 p-2.5 space-y-2.5">
          {step.description && (
            <p className="text-xs text-muted-foreground">{step.description}</p>
          )}

          {/* Note */}
          {canEdit && (
            <div>
              <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1 mb-1">
                <MessageSquare className="h-2.5 w-2.5" /> Note
              </label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="Anything to flag?"
                className="w-full text-xs border border-input rounded px-2 py-1.5 bg-background resize-none"
              />
              <Button size="sm" variant="outline" onClick={saveNote} disabled={savingNote || note === step.note} className="mt-1">
                {savingNote && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                Save note
              </Button>
            </div>
          )}

          {/* Multi-photo gallery (V3) — replaces the legacy single-photo block */}
          {canEdit && photoMin > 0 && !isMultiselect && (
            <div>
              <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1 mb-1">
                <ImageIcon className="h-2.5 w-2.5" /> Photos
                {photoMin > 0 && (
                  <span className={photos.length >= photoMin ? "text-emerald-700 font-bold" : "text-red-600 font-bold"}>
                    {photos.length}/{photoMin} {isMultiPhoto ? "minimum" : "required"}
                  </span>
                )}
              </label>
              {photoLoading && (
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-1">
                  <Loader2 className="h-3 w-3 animate-spin" /> Loading…
                </div>
              )}
              {photos.length > 0 && (
                <div className="grid grid-cols-3 gap-1.5 mb-2">
                  {photos.map((p) => (
                    <div key={p.id} className="relative aspect-square group">
                      {photoBlobs[p.id] ? (
                        <img src={photoBlobs[p.id]} alt="" className="rounded border w-full h-full object-cover" />
                      ) : (
                        <div className="rounded border w-full h-full bg-muted grid place-items-center">
                          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                        </div>
                      )}
                      <button
                        onClick={() => removePhoto(p.id)}
                        className="absolute top-0.5 right-0.5 bg-red-600/90 text-white rounded p-0.5 opacity-0 group-hover:opacity-100 transition"
                        title="Remove photo"
                      >
                        <Trash2 className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                multiple={isMultiPhoto}
                onChange={async (e) => {
                  const files = Array.from(e.target.files || []);
                  for (const f of files) {
                    await uploadPhoto(f);
                  }
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
                className="text-xs"
              />
              {isMultiPhoto && photos.length > 0 && photos.length < photoMin && (
                <p className="text-[10px] text-red-700 mt-1">
                  Need {photoMin - photos.length} more photo{photoMin - photos.length === 1 ? "" : "s"} before this can be marked complete.
                </p>
              )}
            </div>
          )}

          {/* Multiselect-alert UI */}
          {isMultiselect && (
            <div className="bg-amber-50/50 border border-amber-200 rounded p-2.5">
              <p className="text-[10px] font-bold uppercase tracking-wider text-amber-900 flex items-center gap-1 mb-2">
                <Bell className="h-2.5 w-2.5" /> Tap any that apply
              </p>
              {step.completed && step.selected_options !== null ? (
                // Already submitted — read-only summary
                <div>
                  {step.selected_options.length === 0 ? (
                    <p className="text-xs text-emerald-800">
                      ✓ Nothing flagged. ({step.submitted_by} at {step.submitted_at?.slice(11, 16) || "—"})
                    </p>
                  ) : (
                    <>
                      <p className="text-xs text-amber-900 font-semibold mb-1">Flagged for upsell:</p>
                      <ul className="list-disc list-inside text-xs space-y-0.5">
                        {step.selected_options.map((o) => <li key={o}>{o}</li>)}
                      </ul>
                      <p className="text-[10px] text-muted-foreground mt-1.5">
                        Sent to Alan via SMS · {step.submitted_at?.slice(11, 16)}
                      </p>
                    </>
                  )}
                  {asWorker && (
                    <button
                      onClick={() => { setPicks(step.selected_options || []); /* re-enable submit */ onCheck(false); }}
                      className="text-[10px] text-amber-700 hover:underline mt-2"
                    >
                      Re-do answer
                    </button>
                  )}
                </div>
              ) : (
                <>
                  <div className="space-y-1">
                    {((step.config as SopMultiselectConfig)?.options || []).map((opt) => (
                      <label key={opt} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-amber-100/50 rounded px-1 py-0.5">
                        <input
                          type="checkbox"
                          checked={picks.includes(opt)}
                          onChange={(e) => {
                            setPicks((prev) =>
                              e.target.checked
                                ? [...prev, opt]
                                : prev.filter((p) => p !== opt)
                            );
                          }}
                        />
                        {opt}
                      </label>
                    ))}
                  </div>
                  <div className="flex items-center justify-between mt-2">
                    <p className="text-[10px] text-muted-foreground">
                      {picks.length === 0
                        ? "None selected — submitting will mark complete without alerting Alan."
                        : `Will SMS Alan: ${picks.join(", ")}`}
                    </p>
                    <Button size="sm" variant="outline" onClick={submitMultiselect} disabled={savingMultiselect}>
                      {savingMultiselect && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                      <Send className="h-3 w-3 mr-1" /> Submit
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Help request — workers only */}
          {asWorker && !step.completed && (
            <div className="bg-amber-50 border border-amber-200 rounded p-2">
              <label className="text-[10px] font-bold uppercase tracking-wider text-amber-800 flex items-center gap-1 mb-1">
                <HelpCircle className="h-2.5 w-2.5" /> Stuck on this?
              </label>
              {helpFlagged ? (
                <p className="text-xs text-amber-900">
                  Already flagged — admin sees this on their Calendar view.
                  <span className="block text-[10px] mt-1 italic">{step.help_note}</span>
                </p>
              ) : (
                <>
                  <textarea
                    value={helpNote}
                    onChange={(e) => setHelpNote(e.target.value)}
                    rows={2}
                    placeholder="What's blocking you? Admin will see this."
                    className="w-full text-xs border border-amber-300 rounded px-2 py-1.5 bg-white resize-none"
                  />
                  <Button size="sm" variant="outline" onClick={requestHelp} className="mt-1 border-amber-400 text-amber-900">
                    Request admin help
                  </Button>
                </>
              )}
            </div>
          )}

          {/* Admin-only: see help request from worker */}
          {!asWorker && step.help_requested_at && (
            <div className="bg-red-50 border border-red-200 rounded p-2 text-xs">
              <p className="font-semibold text-red-900 flex items-center gap-1 mb-1">
                <AlertCircle className="h-3 w-3" /> Help requested by {step.help_requested_by}
              </p>
              {step.help_note && <p className="text-red-800 italic">{step.help_note}</p>}
              <p className="text-[10px] text-red-700 mt-1">
                {step.help_requested_at.slice(0, 16).replace("T", " ")}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}


function LogHoursModal({ runId, customerName, onClose }: { runId: string; customerName: string; onClose: () => void }) {
  const [hours, setHours] = useState("");
  const [taskName, setTaskName] = useState("Fence staining");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const h = parseFloat(hours);
    if (!h || h <= 0) { toast.error("Enter the hours worked"); return; }
    setSaving(true);
    try {
      const r = await api.logSopHours(runId, { hours: h, task_name: taskName.trim() || "Fence staining", notes });
      toast.success(`Logged ${r.hours_logged}h — today total: ${r.today_total_hours.toFixed(1)}h`);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to log hours");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-background rounded-lg shadow-xl w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b flex items-center justify-between">
          <h3 className="text-base font-semibold flex items-center gap-2">
            <Clock className="h-4 w-4 text-primary" /> Log my hours
          </h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1"><XIcon className="h-4 w-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          <p className="text-xs text-muted-foreground">For: {customerName}</p>
          <div>
            <label className="text-xs font-semibold text-muted-foreground">Hours worked</label>
            <Input
              type="number"
              step="0.25"
              min="0"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              placeholder="e.g. 6.5"
              className="mt-1"
              autoFocus
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-muted-foreground">What did you do?</label>
            <Input value={taskName} onChange={(e) => setTaskName(e.target.value)} className="mt-1" />
          </div>
          <div>
            <label className="text-xs font-semibold text-muted-foreground">Notes (optional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full text-xs border border-input rounded px-2 py-1.5 bg-background resize-none mt-1"
              placeholder="Anything to flag?"
            />
          </div>
        </div>
        <div className="p-3 border-t flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>
            {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Log hours
          </Button>
        </div>
      </div>
    </div>
  );
}
