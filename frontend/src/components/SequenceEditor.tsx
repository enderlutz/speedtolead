/**
 * SequenceEditor — full-page modal for designing a follow-up sequence.
 *
 * Two ways to edit:
 *   1. Manual: click on a step to inline-edit its delay + message body.
 *   2. AI: type or speak a natural-language instruction; Claude proposes
 *      a complete new plan; admin reviews a diff before committing.
 *
 * Save semantics: every save bumps the sequence's version. Steps are
 * fully replaced on save (delete + recreate) — simpler than tracking
 * per-step IDs and matches how the compiler's `apply-plan` endpoint works.
 */
import { useState, useEffect, useCallback } from "react";
import { api, type FollowUpSequence, type FollowUpStep, type SequencePlan, type SequenceStepPlan, type SequenceDiffEntry } from "@/lib/api";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import VoiceInput from "@/components/VoiceInput";
import { Plus, Trash2, Save, Sparkles, X, Clock, Wand2, ChevronUp, ChevronDown } from "lucide-react";

const EMPTY_STEP: SequenceStepPlan = {
  position: 0,
  delay_hours: 24,
  channel: "sms",
  message_template: "",
  use_ai_personalization: false,
};

export default function SequenceEditor({ sequenceId, onClose }: { sequenceId: string; onClose: () => void }) {
  const [seq, setSeq] = useState<FollowUpSequence | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [triggerEvent, setTriggerEvent] = useState("");
  const [pauseOnEvents, setPauseOnEvents] = useState("customer_replied");
  const [steps, setSteps] = useState<SequenceStepPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // AI editor state
  const [instruction, setInstruction] = useState("");
  const [compiling, setCompiling] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<SequencePlan | null>(null);
  const [pendingDiff, setPendingDiff] = useState<SequenceDiffEntry[]>([]);

  const refresh = useCallback(() => {
    setLoading(true);
    api.getFollowupSequence(sequenceId)
      .then((r) => {
        setSeq(r.sequence);
        setName(r.sequence.name);
        setDescription(r.sequence.description);
        setTriggerEvent(r.sequence.trigger_event);
        setPauseOnEvents(r.sequence.pause_on_events);
        setSteps(r.steps.map((s: FollowUpStep) => ({
          position: s.position,
          delay_hours: s.delay_hours,
          channel: s.channel,
          message_template: s.message_template,
          use_ai_personalization: s.use_ai_personalization,
        })));
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : "Failed to load sequence"))
      .finally(() => setLoading(false));
  }, [sequenceId]);

  useEffect(() => { refresh(); }, [refresh]);

  const currentPlan = (): SequencePlan => ({
    sequence_name: name,
    sequence_description: description,
    trigger_event: triggerEvent,
    pause_on_events: pauseOnEvents,
    steps: steps.map((s, i) => ({ ...s, position: i })),
  });

  const saveManual = async () => {
    setSaving(true);
    try {
      await api.applySequencePlan(sequenceId, currentPlan());
      toast.success("Saved");
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const moveStep = (i: number, delta: -1 | 1) => {
    const next = [...steps];
    const target = i + delta;
    if (target < 0 || target >= next.length) return;
    [next[i], next[target]] = [next[target], next[i]];
    setSteps(next.map((s, idx) => ({ ...s, position: idx })));
  };

  const updateStep = (i: number, patch: Partial<SequenceStepPlan>) => {
    setSteps((prev) => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s));
  };

  const removeStep = (i: number) => {
    setSteps((prev) => prev.filter((_, idx) => idx !== i).map((s, idx) => ({ ...s, position: idx })));
  };

  const addStep = () => {
    setSteps((prev) => [...prev, { ...EMPTY_STEP, position: prev.length }]);
  };

  // AI compile flow
  const compile = async () => {
    if (!instruction.trim()) {
      toast.error("Type or speak an instruction first.");
      return;
    }
    setCompiling(true);
    try {
      const r = await api.compileSequenceInstruction(sequenceId, instruction);
      if (r.proposed._compiler_unavailable) {
        toast.error("AI compiler is offline (no ANTHROPIC_API_KEY).");
        return;
      }
      setPendingPlan(r.proposed);
      setPendingDiff(r.diff);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Compile failed");
    } finally {
      setCompiling(false);
    }
  };

  const confirmPlan = async () => {
    if (!pendingPlan) return;
    setSaving(true);
    try {
      await api.applySequencePlan(sequenceId, pendingPlan);
      toast.success("Applied AI plan");
      setPendingPlan(null);
      setPendingDiff([]);
      setInstruction("");
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Apply failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 overflow-y-auto" onClick={onClose}>
      <div
        className="min-h-full flex items-start justify-center p-4 sm:p-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bg-card border rounded-lg max-w-3xl w-full">
          <header className="px-5 py-4 border-b flex items-center justify-between">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Sequence editor</p>
              <h2 className="text-lg font-semibold">{name || "(unnamed)"}</h2>
              {seq && <p className="text-[11px] text-muted-foreground">v{seq.version} · {seq.active ? "active" : "inactive"}</p>}
            </div>
            <Button variant="ghost" size="sm" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </header>

          {loading ? (
            <div className="p-6 text-sm text-muted-foreground">Loading…</div>
          ) : (
            <div className="px-5 py-4 space-y-5">
              {/* Meta */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground block mb-1">Name</label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground block mb-1">Trigger event</label>
                  <Input value={triggerEvent} onChange={(e) => setTriggerEvent(e.target.value)} placeholder="empty = manual only" />
                </div>
                <div className="sm:col-span-2">
                  <label className="text-xs font-medium text-muted-foreground block mb-1">Description</label>
                  <textarea
                    rows={2}
                    className="w-full border rounded-md px-3 py-2 text-sm bg-background"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="text-xs font-medium text-muted-foreground block mb-1">Pause on (comma-separated)</label>
                  <Input value={pauseOnEvents} onChange={(e) => setPauseOnEvents(e.target.value)} placeholder="customer_replied" />
                </div>
              </div>

              {/* AI editor */}
              <Card className="border-violet-200/60 bg-violet-50/30">
                <CardContent className="pt-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-violet-600" />
                    <p className="text-xs font-medium uppercase tracking-wide text-violet-700">Edit by typing or voice</p>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Example: <em>"After 24 hours with no reply, send a casual nudge using their first name and the estimate range. Personalize it."</em>
                  </p>
                  <div className="flex gap-2 items-start">
                    <textarea
                      rows={2}
                      className="flex-1 border rounded-md px-3 py-2 text-sm bg-background"
                      value={instruction}
                      onChange={(e) => setInstruction(e.target.value)}
                      placeholder="Describe what you want to change…"
                    />
                    <div className="flex flex-col gap-1.5 shrink-0">
                      <VoiceInput onText={setInstruction} initialText={instruction} disabled={compiling} />
                      <Button size="sm" onClick={compile} disabled={compiling || !instruction.trim()}>
                        <Wand2 className="h-3.5 w-3.5 mr-1" />
                        {compiling ? "…" : "Plan"}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Steps */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Steps</p>
                  <Button size="sm" variant="outline" onClick={addStep}>
                    <Plus className="h-3.5 w-3.5 mr-1" /> Add step
                  </Button>
                </div>
                {steps.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">No steps yet. Add one or describe what you want.</p>
                ) : (
                  <ul className="space-y-2">
                    {steps.map((s, i) => (
                      <li key={i} className="rounded-md border bg-background p-3 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant="outline" className="text-[10px]">step {i + 1}</Badge>
                          <div className="flex items-center gap-1 text-xs">
                            <Clock className="h-3 w-3 text-muted-foreground" />
                            <input
                              type="number"
                              min={0}
                              step={0.25}
                              className="w-16 border rounded px-1.5 py-0.5 text-xs bg-background"
                              value={s.delay_hours}
                              onChange={(e) => updateStep(i, { delay_hours: parseFloat(e.target.value) || 0 })}
                            />
                            <span className="text-muted-foreground">h after {i === 0 ? "start" : `step ${i}`}</span>
                          </div>
                          <label className="text-[11px] text-muted-foreground inline-flex items-center gap-1 cursor-pointer ml-auto">
                            <input
                              type="checkbox"
                              checked={s.use_ai_personalization}
                              onChange={(e) => updateStep(i, { use_ai_personalization: e.target.checked })}
                              className="rounded"
                            />
                            AI personalize
                          </label>
                          <div className="flex items-center gap-0.5">
                            <Button size="sm" variant="ghost" onClick={() => moveStep(i, -1)} disabled={i === 0}>
                              <ChevronUp className="h-3.5 w-3.5" />
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => moveStep(i, 1)} disabled={i === steps.length - 1}>
                              <ChevronDown className="h-3.5 w-3.5" />
                            </Button>
                            <Button size="sm" variant="ghost" className="text-red-600" onClick={() => removeStep(i)}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                        <textarea
                          rows={3}
                          className="w-full border rounded-md px-3 py-2 text-sm bg-background font-mono"
                          value={s.message_template}
                          onChange={(e) => updateStep(i, { message_template: e.target.value })}
                          placeholder="Hey {{customer_first_name}}, …"
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          <footer className="px-5 py-3 border-t flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>Close</Button>
            <Button onClick={saveManual} disabled={loading || saving}>
              <Save className="h-3.5 w-3.5 mr-1" /> {saving ? "Saving…" : "Save"}
            </Button>
          </footer>
        </div>
      </div>

      {/* AI plan diff confirmation */}
      {pendingPlan && (
        <DiffModal
          plan={pendingPlan}
          diff={pendingDiff}
          onCancel={() => { setPendingPlan(null); setPendingDiff([]); }}
          onConfirm={confirmPlan}
          confirming={saving}
        />
      )}
    </div>
  );
}


function DiffModal({
  plan,
  diff,
  onCancel,
  onConfirm,
  confirming,
}: {
  plan: SequencePlan;
  diff: SequenceDiffEntry[];
  onCancel: () => void;
  onConfirm: () => void;
  confirming: boolean;
}) {
  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-card border rounded-lg max-w-2xl w-full max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Proposed changes</p>
          <h2 className="text-lg font-semibold">Review AI plan</h2>
          {plan.reasoning && <p className="text-xs text-muted-foreground mt-1">{plan.reasoning}</p>}
        </header>
        <div className="px-5 py-4 space-y-3">
          {diff.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No changes proposed.</p>
          ) : (
            <ul className="space-y-2">
              {diff.map((d, i) => <DiffRow key={i} entry={d} />)}
            </ul>
          )}
        </div>
        <footer className="px-5 py-3 border-t flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={onConfirm} disabled={confirming || diff.length === 0}>
            {confirming ? "Applying…" : "Apply plan"}
          </Button>
        </footer>
      </div>
    </div>
  );
}


function DiffRow({ entry }: { entry: SequenceDiffEntry }) {
  if (entry.kind === "meta") {
    const changes = entry.changes || [];
    return (
      <li className="rounded-md border border-blue-300 bg-blue-50/40 p-3">
        <p className="text-[10px] uppercase tracking-wide text-blue-700 mb-1">Sequence metadata</p>
        <ul className="text-xs space-y-1">
          {changes.map((k) => (
            <li key={k}>
              <span className="font-medium">{k}:</span>{" "}
              <span className="line-through text-muted-foreground">{String((entry.before as Record<string, string>)[k] || "—")}</span>{" → "}
              <span className="text-blue-700">{String((entry.after as Record<string, string>)[k] || "—")}</span>
            </li>
          ))}
        </ul>
      </li>
    );
  }
  if (entry.kind === "unchanged") {
    const s = entry.after as SequenceStepPlan;
    return (
      <li className="rounded-md border bg-muted/20 p-2 text-[11px] text-muted-foreground italic">
        Step {(entry.position ?? 0) + 1} — unchanged ({s.delay_hours}h, {s.message_template.slice(0, 60)}{s.message_template.length > 60 ? "…" : ""})
      </li>
    );
  }
  if (entry.kind === "added") {
    const s = entry.after as SequenceStepPlan;
    return (
      <li className="rounded-md border border-emerald-300 bg-emerald-50/50 p-3">
        <p className="text-[10px] uppercase tracking-wide text-emerald-700 mb-1">+ Added — Step {(entry.position ?? 0) + 1}</p>
        <p className="text-xs"><span className="font-medium">delay:</span> {s.delay_hours}h{s.use_ai_personalization && " · AI personalize"}</p>
        <p className="text-xs font-mono whitespace-pre-wrap mt-1">{s.message_template}</p>
      </li>
    );
  }
  if (entry.kind === "removed") {
    const s = entry.before as SequenceStepPlan;
    return (
      <li className="rounded-md border border-red-300 bg-red-50/40 p-3">
        <p className="text-[10px] uppercase tracking-wide text-red-700 mb-1">– Removed — Step {(entry.position ?? 0) + 1}</p>
        <p className="text-xs font-mono whitespace-pre-wrap line-through opacity-70">{s.message_template}</p>
      </li>
    );
  }
  // changed
  const before = entry.before as SequenceStepPlan;
  const after = entry.after as SequenceStepPlan;
  const changes = entry.changes || [];
  return (
    <li className="rounded-md border border-amber-300 bg-amber-50/40 p-3">
      <p className="text-[10px] uppercase tracking-wide text-amber-700 mb-1">~ Changed — Step {(entry.position ?? 0) + 1}</p>
      <ul className="text-xs space-y-1">
        {changes.map((k) => (
          <li key={k}>
            <span className="font-medium">{k}:</span>{" "}
            <span className="line-through text-muted-foreground">{String(before[k as keyof SequenceStepPlan] ?? "")}</span>{" → "}
            <span className="text-amber-800">{String(after[k as keyof SequenceStepPlan] ?? "")}</span>
          </li>
        ))}
      </ul>
    </li>
  );
}
