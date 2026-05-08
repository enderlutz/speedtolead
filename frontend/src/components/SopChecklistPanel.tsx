import { useEffect, useState, useCallback, useRef } from "react";
import {
  api, type SopRun, type SopRunStep, SOP_CATEGORIES, getCurrentUser,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  ListChecks, Camera, MessageSquare, AlertCircle, Loader2,
  Check, Trash2, ChevronDown, ChevronUp, HelpCircle, ImageIcon,
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

  const helpFlagged = run.steps.filter((s) => s.help_requested_at && !s.completed).length;

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

      {/* Progress bar */}
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${
            run.status === "completed" ? "bg-emerald-500" : "bg-primary"
          }`}
          style={{ width: `${run.completion_pct}%` }}
        />
      </div>

      {asWorker && run.status === "pending" && (
        <Button size="sm" onClick={startRun} className="w-full">
          Start job
        </Button>
      )}

      {/* Steps grouped by category */}
      <div className="space-y-2.5">
        {SOP_CATEGORIES.map((cat) => {
          const inBucket = run.steps
            .filter((s) => s.category === cat.key)
            .sort((a, b) => a.order_index - b.order_index);
          if (inBucket.length === 0) return null;
          return (
            <div key={cat.key} className="space-y-1">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                <span>{cat.emoji}</span> {cat.label}
              </p>
              {inBucket.map((step) => (
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
          );
        })}
      </div>

      {run.status === "completed" && (
        <div className="bg-emerald-50 border border-emerald-200 rounded p-2 text-xs text-emerald-900 flex items-center gap-1.5">
          <Check className="h-3.5 w-3.5" /> All required steps complete. Customer can be marked paid.
        </div>
      )}
    </div>
  );
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
  const [note, setNote] = useState(step.note);
  const [helpNote, setHelpNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sync local note state if parent run reloads
  useEffect(() => { setNote(step.note); }, [step.note]);

  // Fetch photo blob URL when expanded + has photo
  useEffect(() => {
    let revoked = false;
    if (expanded && step.photo_id) {
      api.fetchSopStepPhotoBlobUrl(runId, step.step_id).then((url) => {
        if (revoked) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        setPhotoUrl(url);
      });
    } else if (!step.photo_id) {
      setPhotoUrl(null);
    }
    return () => {
      revoked = true;
      if (photoUrl) URL.revokeObjectURL(photoUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, step.photo_id, runId, step.step_id]);

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
      toast.success("Photo uploaded");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    }
  };

  const removePhoto = async () => {
    if (!confirm("Remove this photo?")) return;
    try {
      const updated = await api.deleteSopStepPhoto(runId, step.step_id);
      onUpdate(updated);
      setPhotoUrl(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
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
        <button
          onClick={() => canEdit && onCheck(!step.completed)}
          disabled={!canEdit || (step.photo_required && !step.completed && !step.photo_id)}
          className={`shrink-0 mt-0.5 h-5 w-5 rounded border-2 grid place-items-center transition ${
            step.completed
              ? "bg-emerald-500 border-emerald-500 text-white"
              : "border-muted-foreground/40 hover:border-primary"
          } ${(!canEdit || (step.photo_required && !step.completed && !step.photo_id)) ? "opacity-50 cursor-not-allowed" : ""}`}
          title={
            step.photo_required && !step.completed && !step.photo_id
              ? "Photo required before completing this step"
              : step.completed ? "Mark incomplete" : "Mark complete"
          }
        >
          {step.completed && <Check className="h-3 w-3" />}
        </button>

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
            {step.photo_required && (
              <span className={`inline-flex items-center gap-0.5 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-bold ${
                step.photo_id ? "bg-emerald-100 text-emerald-800" : "bg-blue-100 text-blue-800"
              }`}>
                <Camera className="h-2.5 w-2.5" /> {step.photo_id ? "photo ✓" : "photo"}
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

          {/* Photo */}
          {canEdit && (
            <div>
              <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1 mb-1">
                <ImageIcon className="h-2.5 w-2.5" /> Photo {step.photo_required && <span className="text-red-600 font-bold">required</span>}
              </label>
              {photoUrl ? (
                <div className="relative group">
                  <img src={photoUrl} alt="step" className="rounded border max-h-48 w-full object-cover" />
                  <button
                    onClick={removePhoto}
                    className="absolute top-1 right-1 bg-red-600/90 text-white rounded p-1 opacity-0 group-hover:opacity-100 transition"
                    title="Remove photo"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ) : (
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) uploadPhoto(f);
                  }}
                  className="text-xs"
                />
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
