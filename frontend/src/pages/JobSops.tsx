import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { api, type SopRun, type SopRunStep, getCurrentUser } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { ArrowLeft, Camera, AlertCircle, RefreshCw } from "lucide-react";

// Worker-facing SOP checklist for a single job. Reached via the SOP
// Checklist button on the MyDay card while a job is in_progress. Lean,
// mobile-first: tick steps, leave a note, upload a photo, hit Help.
// Admin can use the same page to monitor live progress.

export default function JobSops() {
  const { jobId = "" } = useParams<{ jobId: string }>();
  const user = getCurrentUser();
  const [run, setRun] = useState<SopRun | null>(null);
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
    } catch (e: any) {
      toast.error(e?.message || "Failed to load SOP");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [jobId]);

  useEffect(() => { load(); }, [load]);

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

  const backTo = user?.role === "worker" ? "/my-day" : "/calendar";

  if (!run) {
    return (
      <div className="p-4 max-w-md mx-auto pb-24">
        <Link to={backTo} className="inline-flex items-center text-sm text-blue-600 mb-3">
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Link>
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No SOP configured for this job's service type yet. Ask admin
            to attach a template.
          </CardContent>
        </Card>
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

      <h1 className="text-xl font-bold mb-1">{run.template_name_snapshot || "SOP Checklist"}</h1>
      <div className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
        <span>{completedCount} / {totalCount} steps</span>
        <div className="flex-1 h-2 bg-slate-200 rounded-full overflow-hidden">
          <div className="h-full bg-green-600 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-xs font-medium">{pct}%</span>
      </div>

      {run.status === "pending" && (
        <Button className="w-full mb-4 bg-blue-600 hover:bg-blue-700" onClick={handleStartRun}>
          Start SOP
        </Button>
      )}

      <div className="space-y-2">
        {run.steps.map((step) => (
          <Card key={step.step_id} className={step.completed ? "opacity-70" : ""}>
            <CardContent className="p-3 space-y-2">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={step.completed}
                  onChange={(e) => handleToggle(step, e.target.checked)}
                  className="mt-1 h-4 w-4 shrink-0"
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

              <Textarea
                placeholder="Add a note…"
                value={notesDraft[step.step_id] ?? step.note ?? ""}
                onChange={(e) => setNotesDraft((d) => ({ ...d, [step.step_id]: e.target.value }))}
                onBlur={() => handleNoteBlur(step)}
                rows={2}
                className="text-sm ml-7"
              />

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
    </div>
  );
}
