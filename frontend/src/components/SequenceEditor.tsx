/**
 * SequenceEditor — GHL-style flow canvas for designing a follow-up sequence.
 *
 * Mirrors GoHighLevel's workflow builder so Alan + team transfer in with no
 * learning curve: vertical flow with a trigger card at the top, action +
 * wait cards stacked beneath, branch fork for variant steps, END marker
 * at the bottom. Each card expands inline for editing (no separate panel).
 *
 * Editing modes:
 *   1. Manual: click any card to expand its editor inline.
 *   2. AI: type or speak an instruction; Claude proposes a new plan; admin
 *      reviews a diff before committing.
 *
 * Save semantics: every save bumps the sequence's version via applySequencePlan
 * (delete + recreate all steps). Sequence-level send window + timezone are
 * preserved across saves.
 */
import { useState, useEffect, useCallback } from "react";
import {
  api,
  type FollowUpSequence,
  type FollowUpStep,
  type SequencePlan,
  type SequenceStepPlan,
  type SequenceDiffEntry,
  type FollowUpWaitKind,
  type FollowUpActionKind,
} from "@/lib/api";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import VoiceInput from "@/components/VoiceInput";
import {
  Plus, Trash2, Save, Sparkles, X, MessageSquare, Clock, Tag as TagIcon,
  GitBranch, Zap, Wand2, ChevronDown, ChevronUp, Pencil, ArrowRightLeft,
} from "lucide-react";

// V2 GHL pipeline stages — mirror of LeadsV2 V2_STAGES, kept locally so the
// editor can render a stage picker without an extra round-trip. Keep in sync
// with frontend/src/pages/LeadsV2.tsx if stages are renamed/added.
const PIPELINE_STAGES: { id: string; label: string }[] = [
  { id: "e77fa568-8dd1-4f66-83c3-fa70dbd4d570", label: "New Lead" },
  { id: "616087fa-4144-454e-b3d3-ff3669cb9461", label: "HOT LEAD — Send Estimate" },
  { id: "4ea9bbe0-d763-4440-8026-d0fc88d0358e", label: "Address Follow Up" },
  { id: "dc3600f2-009b-4075-95fa-786823131416", label: "Estimate Sent" },
  { id: "3ed8e7e3-6852-469c-bb72-effc1b6df76c", label: "Estimate — Follow Up Later" },
  { id: "8e1eb2cd-b9db-4eb7-aacf-901945cfca9b", label: "Responded to Estimate" },
  { id: "147bd53b-3848-449d-b7c2-7a2cfad2a5f5", label: "Top Priority — Responded" },
  { id: "f207a600-81c9-4150-941c-e977ea876929", label: "Declined Estimate" },
  { id: "bbebbdac-0011-4253-9ed7-65522bafde02", label: "Deal Closed (Not Scheduled)" },
  { id: "3eed5964-573f-445e-a181-1ee28068f066", label: "Closed & Scheduled" },
  { id: "c77b052f-845c-47e9-bba2-4cdba35a94d0", label: "Completed — Happy" },
  { id: "5f2cea8e-1f10-411b-b5fd-fa7ffa40cdcc", label: "Completed — Unhappy" },
  { id: "d836628c-3094-4a63-b95a-8a5358d251d0", label: "Long Term Nurture" },
  { id: "8e17bd4c-5181-40b9-ba1e-bbe9b0547c01", label: "Responded to Long Term Nurture" },
  { id: "0ca2e2a6-2990-4a5b-8ace-608393e39b5a", label: "Cold Leads (Never Answered)" },
];

function stageLabel(id: string): string {
  return PIPELINE_STAGES.find((s) => s.id === id)?.label || id;
}

const EMPTY_SEND: SequenceStepPlan = {
  position: 0,
  delay_hours: 0,
  channel: "sms",
  message_template: "",
  use_ai_personalization: false,
  wait_kind: "hours",
  action_kind: "send_message",
  tag_value: "",
  branch_field: "",
  variants: {},
};

const EMPTY_TAG: SequenceStepPlan = {
  ...EMPTY_SEND,
  action_kind: "add_tag",
  tag_value: "",
  message_template: "",
};

const EMPTY_MOVE: SequenceStepPlan = {
  ...EMPTY_SEND,
  action_kind: "move_column",
  column_value: "",
  message_template: "",
};

export default function SequenceEditor({ sequenceId, onClose }: { sequenceId: string; onClose: () => void }) {
  const [seq, setSeq] = useState<FollowUpSequence | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [triggerEvent, setTriggerEvent] = useState("");
  const [pauseOnEvents, setPauseOnEvents] = useState("customer_replied");
  const [winStart, setWinStart] = useState(8);
  const [winEnd, setWinEnd] = useState(20);
  const [tz, setTz] = useState("America/Chicago");
  const [steps, setSteps] = useState<SequenceStepPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [metaOpen, setMetaOpen] = useState(false);

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
        setWinStart(r.sequence.send_window_start_hour ?? 8);
        setWinEnd(r.sequence.send_window_end_hour ?? 20);
        setTz(r.sequence.timezone || "America/Chicago");
        setSteps(r.steps.map((s: FollowUpStep) => ({
          position: s.position,
          delay_hours: s.delay_hours,
          channel: s.channel,
          message_template: s.message_template,
          use_ai_personalization: s.use_ai_personalization,
          wait_kind: s.wait_kind || "hours",
          window_start_hour: s.window_start_hour ?? null,
          window_start_minute: s.window_start_minute ?? 0,
          window_end_hour: s.window_end_hour ?? null,
          window_end_minute: s.window_end_minute ?? 0,
          action_kind: s.action_kind || "send_message",
          tag_value: s.tag_value || "",
          column_value: s.column_value || "",
          branch_field: s.branch_field || "",
          variants: s.variants || {},
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
    send_window_start_hour: winStart,
    send_window_end_hour: winEnd,
    timezone: tz,
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

  const updateStep = (i: number, patch: Partial<SequenceStepPlan>) => {
    setSteps((prev) => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s));
  };

  const removeStep = (i: number) => {
    setSteps((prev) => prev.filter((_, idx) => idx !== i).map((s, idx) => ({ ...s, position: idx })));
    if (expandedIdx === i) setExpandedIdx(null);
  };

  const insertStep = (after: number, template: SequenceStepPlan) => {
    setSteps((prev) => {
      const next = [...prev];
      next.splice(after + 1, 0, { ...template });
      return next.map((s, idx) => ({ ...s, position: idx }));
    });
    setExpandedIdx(after + 1);
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
          <header className="px-5 py-4 border-b flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Workflow Builder</p>
              <h2 className="text-lg font-semibold truncate">{name || "(unnamed)"}</h2>
              {seq && (
                <p className="text-[11px] text-muted-foreground">
                  v{seq.version} · {seq.active ? "active" : "inactive"}
                  {triggerEvent && <> · trigger: <span className="font-mono">{triggerEvent}</span></>}
                </p>
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </header>

          {loading ? (
            <div className="p-6 text-sm text-muted-foreground">Loading…</div>
          ) : (
            <div className="px-5 py-4 space-y-5">
              {/* Meta — collapsed by default, expand to edit */}
              <div className="border rounded-md bg-muted/20">
                <button
                  className="w-full px-3 py-2 flex items-center justify-between text-xs font-medium text-muted-foreground hover:bg-muted/30"
                  onClick={() => setMetaOpen((v) => !v)}
                >
                  <span className="flex items-center gap-2">
                    <Pencil className="h-3.5 w-3.5" />
                    Workflow settings
                  </span>
                  {metaOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </button>
                {metaOpen && (
                  <div className="p-3 border-t grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">Name</label>
                      <Input value={name} onChange={(e) => setName(e.target.value)} />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">
                        Trigger event
                      </label>
                      <Input
                        value={triggerEvent}
                        onChange={(e) => setTriggerEvent(e.target.value)}
                        placeholder="tag_added:estimate sent"
                      />
                      <p className="text-[10px] text-muted-foreground mt-1">
                        Format: <code>tag_added:&lt;tag&gt;</code>. Empty = manual only.
                      </p>
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
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">
                        Pause on (comma-separated)
                      </label>
                      <Input
                        value={pauseOnEvents}
                        onChange={(e) => setPauseOnEvents(e.target.value)}
                        placeholder="customer_replied"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">Timezone</label>
                      <Input value={tz} onChange={(e) => setTz(e.target.value)} />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">
                        Send window start (hour, 0-23)
                      </label>
                      <Input
                        type="number"
                        min={0}
                        max={23}
                        value={winStart}
                        onChange={(e) => setWinStart(parseInt(e.target.value) || 0)}
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground block mb-1">
                        Send window end (hour, 0-23)
                      </label>
                      <Input
                        type="number"
                        min={0}
                        max={23}
                        value={winEnd}
                        onChange={(e) => setWinEnd(parseInt(e.target.value) || 0)}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* AI editor */}
              <Card className="border-violet-200/60 bg-violet-50/30">
                <CardContent className="pt-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-violet-600" />
                    <p className="text-xs font-medium uppercase tracking-wide text-violet-700">
                      Edit by typing or voice
                    </p>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Example: <em>"Make Text 1 friendlier and add a sentence about our 5-year warranty."</em>
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

              {/* GHL-style flow canvas */}
              <div className="space-y-0">
                {/* Trigger card */}
                <TriggerCard
                  triggerEvent={triggerEvent}
                  winStart={winStart}
                  winEnd={winEnd}
                  tz={tz}
                />
                <Connector />

                {/* Step flow */}
                {steps.length === 0 ? (
                  <div className="rounded-md border border-dashed bg-muted/10 p-4 text-center">
                    <p className="text-xs text-muted-foreground italic">
                      No steps yet. Click + below to add a message, branch, wait, or tag action.
                    </p>
                    <div className="mt-2 flex justify-center">
                      <AddBetween
                        onAddSend={() => insertStep(-1, EMPTY_SEND)}
                        onAddTag={() => insertStep(-1, EMPTY_TAG)}
                        onAddMove={() => insertStep(-1, EMPTY_MOVE)}
                      />
                    </div>
                  </div>
                ) : (
                  steps.map((s, i) => (
                    <StepBlock
                      key={i}
                      step={s}
                      index={i}
                      expanded={expandedIdx === i}
                      onToggleExpand={() => setExpandedIdx(expandedIdx === i ? null : i)}
                      onUpdate={(patch) => updateStep(i, patch)}
                      onRemove={() => removeStep(i)}
                      onAddBelow={(tpl) => insertStep(i, tpl)}
                    />
                  ))
                )}

                {/* END marker */}
                <div className="flex justify-center pt-2">
                  <div className="px-3 py-1 rounded-full border bg-muted/40 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    END
                  </div>
                </div>
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


// ─── Visual primitives ─────────────────────────────────────────────────

function Connector({ withAdd, onAddSend, onAddTag, onAddMove }: {
  withAdd?: boolean;
  onAddSend?: () => void;
  onAddTag?: () => void;
  onAddMove?: () => void;
}) {
  return (
    <div className="flex flex-col items-center">
      <div className="w-px h-3 bg-border" />
      {withAdd && onAddSend && onAddTag && onAddMove ? (
        <AddBetween onAddSend={onAddSend} onAddTag={onAddTag} onAddMove={onAddMove} />
      ) : (
        <div className="w-2 h-2 rounded-full border bg-background" />
      )}
      <div className="w-px h-3 bg-border" />
    </div>
  );
}

function AddBetween({ onAddSend, onAddTag, onAddMove }: {
  onAddSend: () => void;
  onAddTag: () => void;
  onAddMove: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-6 w-6 rounded-full border border-dashed bg-background hover:bg-muted text-muted-foreground hover:text-foreground flex items-center justify-center"
        title="Add step"
      >
        <Plus className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute left-1/2 -translate-x-1/2 mt-1 z-10 rounded-md border bg-popover shadow-md py-1 min-w-[160px]">
          <button
            className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted flex items-center gap-2"
            onClick={() => { onAddSend(); setOpen(false); }}
          >
            <MessageSquare className="h-3 w-3 text-emerald-600" /> Send message
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted flex items-center gap-2"
            onClick={() => { onAddTag(); setOpen(false); }}
          >
            <TagIcon className="h-3 w-3 text-blue-600" /> Add tag
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted flex items-center gap-2"
            onClick={() => { onAddMove(); setOpen(false); }}
          >
            <ArrowRightLeft className="h-3 w-3 text-purple-600" /> Move column
          </button>
        </div>
      )}
    </div>
  );
}

function TriggerCard({ triggerEvent, winStart, winEnd, tz }: {
  triggerEvent: string;
  winStart: number;
  winEnd: number;
  tz: string;
}) {
  const tag = triggerEvent.toLowerCase().startsWith("tag_added:")
    ? triggerEvent.slice("tag_added:".length).trim()
    : "";
  return (
    <div className="flex justify-center">
      <div className="rounded-lg border-2 border-violet-300 bg-violet-50/60 px-4 py-3 max-w-md w-full">
        <div className="flex items-center gap-2">
          <TagIcon className="h-4 w-4 text-violet-700" />
          <p className="text-xs font-semibold uppercase tracking-wide text-violet-800">Contact Tag</p>
        </div>
        <p className="text-sm mt-0.5">
          {tag ? <>Tag Added includes <span className="font-semibold">"{tag}"</span></> : "No trigger set (manual only)"}
        </p>
        <p className="text-[10px] text-violet-700/70 mt-1">
          Send window: {hourLabel(winStart)} – {hourLabel(winEnd)} · {tz.replace("America/", "")}
        </p>
      </div>
    </div>
  );
}

function StepBlock({
  step, index, expanded, onToggleExpand, onUpdate, onRemove, onAddBelow,
}: {
  step: SequenceStepPlan;
  index: number;
  expanded: boolean;
  onToggleExpand: () => void;
  onUpdate: (patch: Partial<SequenceStepPlan>) => void;
  onRemove: () => void;
  onAddBelow: (tpl: SequenceStepPlan) => void;
}) {
  const isAddTag = step.action_kind === "add_tag";
  const isMoveColumn = step.action_kind === "move_column";
  const isInternalAction = isAddTag || isMoveColumn;
  const hasBranch = Boolean(step.branch_field && Object.keys(step.variants || {}).length > 0);

  // Show wait card if this step has any wait/window > 0 AND is not an
  // internal (non-customer-facing) action like add_tag or move_column.
  const showWait =
    !isInternalAction &&
    ((step.wait_kind === "calendar_day") ||
      (step.delay_hours && step.delay_hours > 0) ||
      step.window_start_hour != null);

  return (
    <>
      {showWait && (
        <>
          <WaitCard step={step} />
          <div className="flex flex-col items-center">
            <div className="w-px h-3 bg-border" />
            <div className="w-2 h-2 rounded-full border bg-background" />
            <div className="w-px h-3 bg-border" />
          </div>
        </>
      )}

      {/* The action card */}
      <div className="flex justify-center">
        <div className="max-w-md w-full">
          {isAddTag ? (
            <ActionCard
              icon={<TagIcon className="h-4 w-4 text-blue-700" />}
              border="border-blue-300"
              bg="bg-blue-50/50"
              kind="Add Tag"
              summary={step.tag_value ? `"${step.tag_value}"` : "(no tag set)"}
              onToggleExpand={onToggleExpand}
              expanded={expanded}
              onRemove={onRemove}
            />
          ) : isMoveColumn ? (
            <ActionCard
              icon={<ArrowRightLeft className="h-4 w-4 text-purple-700" />}
              border="border-purple-300"
              bg="bg-purple-50/50"
              kind="Move Column"
              summary={step.column_value ? `→ ${stageLabel(step.column_value)}` : "(no column set)"}
              onToggleExpand={onToggleExpand}
              expanded={expanded}
              onRemove={onRemove}
            />
          ) : hasBranch ? (
            <ActionCard
              icon={<GitBranch className="h-4 w-4 text-amber-700" />}
              border="border-amber-300"
              bg="bg-amber-50/50"
              kind={`Branch on ${step.branch_field}`}
              summary={`${Object.keys(step.variants || {}).filter((k) => k !== "_default").length} variants + fallback`}
              onToggleExpand={onToggleExpand}
              expanded={expanded}
              onRemove={onRemove}
            />
          ) : (
            <ActionCard
              icon={<MessageSquare className="h-4 w-4 text-emerald-700" />}
              border="border-emerald-300"
              bg="bg-emerald-50/50"
              kind={`SMS ${index + 1}`}
              summary={truncate(step.message_template, 70) || "(empty message)"}
              onToggleExpand={onToggleExpand}
              expanded={expanded}
              onRemove={onRemove}
            />
          )}

          {expanded && (
            <div className="mt-2 rounded-md border bg-background p-3 space-y-3">
              <StepEditor step={step} onUpdate={onUpdate} index={index} />
            </div>
          )}
        </div>
      </div>

      {/* Branch fork visualization when collapsed */}
      {hasBranch && !expanded && (
        <BranchFork step={step} />
      )}

      {/* Connector + add button to next step */}
      <Connector
        withAdd
        onAddSend={() => onAddBelow(EMPTY_SEND)}
        onAddTag={() => onAddBelow(EMPTY_TAG)}
        onAddMove={() => onAddBelow(EMPTY_MOVE)}
      />
    </>
  );
}

function WaitCard({ step }: { step: SequenceStepPlan }) {
  const wk = step.wait_kind || "hours";
  let label = "";
  if (wk === "calendar_day") {
    if (step.window_start_hour != null) {
      label = `Wait → next day at ${formatHM(step.window_start_hour, step.window_start_minute || 0)}`;
      if (step.window_end_hour != null) {
        label += `–${formatHM(step.window_end_hour, step.window_end_minute || 0)}`;
      }
    } else {
      label = "Wait → next day";
    }
  } else if (wk === "minutes") {
    label = `Wait ${step.delay_hours} min → next text`;
  } else if (step.delay_hours > 0) {
    label = `Wait ${step.delay_hours}h → next text`;
  } else if (step.window_start_hour != null) {
    label = `Wait until ${formatHM(step.window_start_hour, step.window_start_minute || 0)}`;
  }
  if (!label) return null;
  return (
    <div className="flex justify-center">
      <div className="rounded-lg border border-purple-200 bg-purple-50/40 px-3 py-2 max-w-md w-full flex items-center gap-2">
        <Clock className="h-4 w-4 text-purple-600 shrink-0" />
        <p className="text-sm text-purple-900">{label}</p>
      </div>
    </div>
  );
}

function ActionCard({
  icon, border, bg, kind, summary, onToggleExpand, expanded, onRemove,
}: {
  icon: React.ReactNode;
  border: string;
  bg: string;
  kind: string;
  summary: string;
  onToggleExpand: () => void;
  expanded: boolean;
  onRemove: () => void;
}) {
  return (
    <div className={`rounded-lg border-2 ${border} ${bg} px-3 py-2.5 hover:shadow-sm transition-shadow`}>
      <div className="flex items-center gap-2">
        {icon}
        <p className="text-xs font-semibold uppercase tracking-wide flex-1">{kind}</p>
        <button onClick={onToggleExpand} className="text-muted-foreground hover:text-foreground p-0.5" title="Edit">
          {expanded ? <ChevronUp className="h-4 w-4" /> : <Pencil className="h-3.5 w-3.5" />}
        </button>
        <button onClick={onRemove} className="text-red-600/70 hover:text-red-700 p-0.5" title="Delete step">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="text-xs text-foreground/80 mt-1 break-words">{summary}</p>
    </div>
  );
}

function BranchFork({ step }: { step: SequenceStepPlan }) {
  const variantKeys = Object.keys(step.variants || {});
  // Show non-default branches in a row; _default rendered separately as fallback
  const branches = variantKeys.filter((k) => k !== "_default");
  if (branches.length === 0) return null;
  return (
    <div className="pt-2 pb-1">
      <div className="flex justify-center">
        <div className="text-[10px] text-amber-700 uppercase tracking-wider mb-1">{step.branch_field} branches</div>
      </div>
      <div className="flex flex-wrap justify-center gap-1.5">
        {branches.map((k) => (
          <div
            key={k}
            className="rounded-md border border-amber-200 bg-amber-50/40 px-2 py-1 text-[10px] text-amber-900"
            title={step.variants?.[k] || ""}
          >
            {k}
          </div>
        ))}
        {variantKeys.includes("_default") && (
          <div
            className="rounded-md border border-amber-200 bg-amber-50/40 px-2 py-1 text-[10px] text-amber-900 italic"
            title={step.variants?.["_default"] || ""}
          >
            fallback
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Inline step editor ────────────────────────────────────────────────

function StepEditor({ step, onUpdate, index }: {
  step: SequenceStepPlan;
  onUpdate: (patch: Partial<SequenceStepPlan>) => void;
  index: number;
}) {
  const isAddTag = step.action_kind === "add_tag";
  const isMoveColumn = step.action_kind === "move_column";

  if (isAddTag) {
    return (
      <div className="space-y-2">
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">Tag value</label>
          <Input
            value={step.tag_value || ""}
            onChange={(e) => onUpdate({ tag_value: e.target.value })}
            placeholder="estimate-followup-continue"
          />
          <p className="text-[10px] text-muted-foreground mt-1">
            This tag will be added to the contact in GHL. No customer-facing message is sent.
          </p>
        </div>
        <ActionKindSwitch value={step.action_kind || "send_message"} onChange={(v) => onUpdate({ action_kind: v })} />
      </div>
    );
  }

  if (isMoveColumn) {
    return (
      <div className="space-y-2">
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">Move to column</label>
          <select
            className="w-full border rounded-md px-2 py-1.5 text-sm bg-background"
            value={step.column_value || ""}
            onChange={(e) => onUpdate({ column_value: e.target.value })}
          >
            <option value="">— select a pipeline stage —</option>
            {PIPELINE_STAGES.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
          <p className="text-[10px] text-muted-foreground mt-1">
            Updates the lead's GHL pipeline stage + mirrors locally. No customer-facing message is sent.
          </p>
        </div>
        <ActionKindSwitch value={step.action_kind || "send_message"} onChange={(v) => onUpdate({ action_kind: v })} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ActionKindSwitch value={step.action_kind || "send_message"} onChange={(v) => onUpdate({ action_kind: v })} />

      {/* Wait/window controls */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">Wait kind</label>
          <select
            className="w-full border rounded-md px-2 py-1.5 text-sm bg-background"
            value={step.wait_kind || "hours"}
            onChange={(e) => onUpdate({ wait_kind: e.target.value as FollowUpWaitKind })}
          >
            <option value="hours">Hours</option>
            <option value="minutes">Minutes</option>
            <option value="calendar_day">Calendar day (next day)</option>
          </select>
        </div>
        {step.wait_kind !== "calendar_day" && (
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">
              Delay ({step.wait_kind === "minutes" ? "min" : "h"})
            </label>
            <Input
              type="number"
              min={0}
              step={step.wait_kind === "minutes" ? 1 : 0.25}
              value={step.delay_hours}
              onChange={(e) => onUpdate({ delay_hours: parseFloat(e.target.value) || 0 })}
            />
          </div>
        )}
      </div>

      {/* Optional per-step window override */}
      <details className="border rounded-md bg-muted/10">
        <summary className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground cursor-pointer">
          Per-step time window override (optional)
        </summary>
        <div className="p-2 grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div>
            <label className="text-[10px] text-muted-foreground block mb-0.5">Start hour</label>
            <Input
              type="number"
              min={0}
              max={23}
              value={step.window_start_hour ?? ""}
              onChange={(e) => onUpdate({
                window_start_hour: e.target.value === "" ? null : parseInt(e.target.value),
              })}
              placeholder="—"
            />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground block mb-0.5">Start min</label>
            <Input
              type="number"
              min={0}
              max={59}
              value={step.window_start_minute ?? 0}
              onChange={(e) => onUpdate({ window_start_minute: parseInt(e.target.value) || 0 })}
            />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground block mb-0.5">End hour</label>
            <Input
              type="number"
              min={0}
              max={23}
              value={step.window_end_hour ?? ""}
              onChange={(e) => onUpdate({
                window_end_hour: e.target.value === "" ? null : parseInt(e.target.value),
              })}
              placeholder="—"
            />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground block mb-0.5">End min</label>
            <Input
              type="number"
              min={0}
              max={59}
              value={step.window_end_minute ?? 0}
              onChange={(e) => onUpdate({ window_end_minute: parseInt(e.target.value) || 0 })}
            />
          </div>
        </div>
      </details>

      {/* Branch on lead field */}
      <div>
        <label className="text-xs font-medium text-muted-foreground block mb-1">
          Branch on lead field (optional)
        </label>
        <Input
          value={step.branch_field || ""}
          onChange={(e) => onUpdate({ branch_field: e.target.value })}
          placeholder="fence_age (leave blank for a single message)"
        />
        <p className="text-[10px] text-muted-foreground mt-1">
          When set, the engine picks the matching variant body below based on the lead's value.
        </p>
      </div>

      {/* Message body / variants */}
      {step.branch_field ? (
        <VariantsEditor
          variants={step.variants || {}}
          onChange={(v) => onUpdate({ variants: v })}
        />
      ) : (
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">Message</label>
          <textarea
            rows={4}
            className="w-full border rounded-md px-3 py-2 text-sm bg-background font-mono"
            value={step.message_template}
            onChange={(e) => onUpdate({ message_template: e.target.value })}
            placeholder="Hey {{customer_first_name}}, …"
          />
        </div>
      )}

      <label className="text-[11px] text-muted-foreground inline-flex items-center gap-1 cursor-pointer">
        <input
          type="checkbox"
          checked={step.use_ai_personalization}
          onChange={(e) => onUpdate({ use_ai_personalization: e.target.checked })}
          className="rounded"
        />
        Run through Claude to personalize before sending
      </label>

      <p className="text-[10px] text-muted-foreground italic">
        Step position: {index + 1}
      </p>
    </div>
  );
}

function ActionKindSwitch({ value, onChange }: {
  value: FollowUpActionKind;
  onChange: (v: FollowUpActionKind) => void;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground block mb-1">Action kind</label>
      <div className="inline-flex rounded-md border overflow-hidden">
        <button
          type="button"
          className={`px-3 py-1.5 text-xs ${value === "send_message" ? "bg-emerald-100 text-emerald-900" : "bg-background hover:bg-muted"}`}
          onClick={() => onChange("send_message")}
        >
          <MessageSquare className="h-3 w-3 inline mr-1" /> Send message
        </button>
        <button
          type="button"
          className={`px-3 py-1.5 text-xs border-l ${value === "add_tag" ? "bg-blue-100 text-blue-900" : "bg-background hover:bg-muted"}`}
          onClick={() => onChange("add_tag")}
        >
          <TagIcon className="h-3 w-3 inline mr-1" /> Add tag
        </button>
        <button
          type="button"
          className={`px-3 py-1.5 text-xs border-l ${value === "move_column" ? "bg-purple-100 text-purple-900" : "bg-background hover:bg-muted"}`}
          onClick={() => onChange("move_column")}
        >
          <ArrowRightLeft className="h-3 w-3 inline mr-1" /> Move column
        </button>
      </div>
    </div>
  );
}

function VariantsEditor({ variants, onChange }: {
  variants: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  const entries = Object.entries(variants);
  const updateKey = (oldKey: string, newKey: string) => {
    if (!newKey || newKey === oldKey) return;
    const next: Record<string, string> = {};
    for (const [k, v] of entries) {
      next[k === oldKey ? newKey : k] = v;
    }
    onChange(next);
  };
  const updateValue = (key: string, value: string) => {
    onChange({ ...variants, [key]: value });
  };
  const removeKey = (key: string) => {
    const next: Record<string, string> = { ...variants };
    delete next[key];
    onChange(next);
  };
  const addRow = () => {
    const baseKey = "new_branch";
    let key = baseKey;
    let i = 2;
    while (Object.prototype.hasOwnProperty.call(variants, key)) {
      key = `${baseKey}_${i++}`;
    }
    onChange({ ...variants, [key]: "" });
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">Variants</label>
        <Button size="sm" variant="outline" onClick={addRow}>
          <Plus className="h-3 w-3 mr-1" /> Add variant
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground">
        Key matches the lead's value (fuzzy, case-insensitive). Use <code>_default</code> as the fallback when nothing matches.
      </p>
      {entries.length === 0 ? (
        <p className="text-[11px] text-muted-foreground italic px-2">No variants yet — add one to start branching.</p>
      ) : (
        <ul className="space-y-1.5">
          {entries.map(([k, v]) => (
            <li key={k} className="rounded-md border bg-muted/10 p-2 space-y-1">
              <div className="flex items-center gap-2">
                <Zap className="h-3 w-3 text-amber-600" />
                <Input
                  value={k}
                  onChange={(e) => updateKey(k, e.target.value)}
                  className="text-xs font-medium"
                />
                <Badge variant="outline" className="text-[10px]">
                  {k === "_default" ? "fallback" : "branch"}
                </Badge>
                <Button size="sm" variant="ghost" className="text-red-600" onClick={() => removeKey(k)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <textarea
                rows={3}
                className="w-full border rounded-md px-2 py-1.5 text-xs bg-background font-mono"
                value={v}
                onChange={(e) => updateValue(k, e.target.value)}
                placeholder="Message body for this branch…"
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Utils ─────────────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function hourLabel(h: number): string {
  const period = h >= 12 ? "PM" : "AM";
  const hh = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${hh} ${period}`;
}

function formatHM(h: number, m: number): string {
  const period = h >= 12 ? "PM" : "AM";
  const hh = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${hh}:${m.toString().padStart(2, "0")} ${period}`;
}

// ─── AI plan diff modal (unchanged from prior version) ────────────────

function DiffModal({
  plan, diff, onCancel, onConfirm, confirming,
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
