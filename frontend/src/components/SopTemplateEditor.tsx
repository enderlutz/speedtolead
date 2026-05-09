import { useEffect, useState } from "react";
import {
  api, type SopTemplate, type SopTemplateStep, type SopCategory,
  SOP_CATEGORIES, type SopStepBody, type SopStepKind, type SopMultiselectConfig,
  type SopReferenceItem, type SopBranch,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { X, ArrowUp, ArrowDown, Plus, Trash2, Camera, Star, Loader2, ListChecks, Save, Pencil, Info, GitBranch, MessageSquare, Bell } from "lucide-react";

const SERVICE_TYPES = [
  { value: "fence_staining", label: "Fence Staining" },
  { value: "power_washing", label: "Power Washing" },
];

const inputCls = "w-full border border-input rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring";
const labelCls = "text-xs font-semibold text-muted-foreground";

interface Props {
  /** Pass null to mean "create new template". */
  initialTemplateId: string | null;
  onClose: () => void;
  onSaved: () => void;
}

/** Full-screen modal for editing one SOP template. Handles meta fields,
 * step CRUD with drag-to-reorder, and the 5-category bucketing. Steps
 * are saved one-at-a-time on edit (so reorder is fast and individual
 * step edits don't require a full template POST). */
export default function SopTemplateEditor({ initialTemplateId, onClose, onSaved }: Props) {
  const [templateId, setTemplateId] = useState<string | null>(initialTemplateId);
  const [, setTpl] = useState<SopTemplate | null>(null);
  const [steps, setSteps] = useState<SopTemplateStep[]>([]);
  const [loading, setLoading] = useState(!!initialTemplateId);
  const [savingMeta, setSavingMeta] = useState(false);
  const [editingStep, setEditingStep] = useState<SopTemplateStep | null>(null);
  const [creatingInCategory, setCreatingInCategory] = useState<SopCategory | null>(null);

  // Local meta state (debounced manual save via the Save button)
  const [name, setName] = useState("");
  const [serviceType, setServiceType] = useState("fence_staining");
  const [description, setDescription] = useState("");
  const [isDefault, setIsDefault] = useState(true);
  const [active, setActive] = useState(true);
  const [referenceData, setReferenceData] = useState<SopReferenceItem[]>([]);
  const [branches, setBranches] = useState<SopBranch[]>([]);

  const load = (id: string) => {
    setLoading(true);
    api.getSopTemplate(id).then((data) => {
      setTpl(data);
      setSteps(data.steps);
      setName(data.name);
      setServiceType(data.service_type);
      setDescription(data.description);
      setIsDefault(data.is_default);
      setActive(data.active);
      setReferenceData(data.reference_data || []);
      setBranches(data.branches || []);
    }).catch(() => toast.error("Failed to load template")).finally(() => setLoading(false));
  };

  useEffect(() => {
    if (initialTemplateId) load(initialTemplateId);
  }, [initialTemplateId]);

  const saveMeta = async () => {
    if (!name.trim()) { toast.error("Name required"); return; }
    setSavingMeta(true);
    try {
      const body = {
        name, service_type: serviceType, description, is_default: isDefault, active,
        reference_data: referenceData.filter((r) => r.label.trim() || r.value.trim()),
        branches: branches.filter((b) => b.key.trim() && b.label.trim()),
      };
      if (!templateId) {
        const created = await api.createSopTemplate(body);
        setTemplateId(created.id);
        setTpl(created);
        setSteps(created.steps);
        toast.success("Template created — now add steps");
      } else {
        const updated = await api.updateSopTemplate(templateId, body);
        setTpl(updated);
        setSteps(updated.steps);
        toast.success("Saved");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingMeta(false);
    }
  };

  const reorderSteps = async (newSteps: SopTemplateStep[]) => {
    if (!templateId) return;
    setSteps(newSteps);  // optimistic
    try {
      await api.reorderSopSteps(templateId, newSteps.map((s) => s.id));
    } catch (e) {
      toast.error("Reorder failed");
      load(templateId);
      throw e;
    }
  };

  /** Move step up/down within its category. Cross-category moves happen
   * via the Edit Step modal's category dropdown. */
  const moveStep = (stepId: string, direction: -1 | 1) => {
    const step = steps.find((s) => s.id === stepId);
    if (!step) return;
    const sameBucket = steps.filter((s) => s.category === step.category)
      .sort((a, b) => a.order_index - b.order_index);
    const idxInBucket = sameBucket.findIndex((s) => s.id === stepId);
    const swapWith = sameBucket[idxInBucket + direction];
    if (!swapWith) return;
    // Swap their positions in the global list
    const aIdx = steps.findIndex((s) => s.id === step.id);
    const bIdx = steps.findIndex((s) => s.id === swapWith.id);
    const next = [...steps];
    [next[aIdx], next[bIdx]] = [next[bIdx], next[aIdx]];
    reorderSteps(next);
  };

  const addStep = async (body: SopStepBody) => {
    if (!templateId) {
      toast.error("Save the template first");
      return;
    }
    try {
      const step = await api.addSopStep(templateId, body);
      setSteps((prev) => [...prev, step].sort((a, b) => a.order_index - b.order_index));
      toast.success("Step added");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add step");
    }
  };

  const updateStep = async (stepId: string, body: SopStepBody) => {
    try {
      const updated = await api.updateSopStep(stepId, body);
      setSteps((prev) => prev.map((s) => s.id === stepId ? updated : s).sort((a, b) => a.order_index - b.order_index));
      toast.success("Saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    }
  };

  const deleteStep = async (stepId: string) => {
    if (!confirm("Delete this step?")) return;
    try {
      await api.deleteSopStep(stepId);
      setSteps((prev) => prev.filter((s) => s.id !== stepId));
      toast.success("Deleted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete");
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-2 sm:p-4" onClick={onClose}>
      <div className="bg-background rounded-lg shadow-xl w-full max-w-3xl max-h-[95vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <ListChecks className="h-5 w-5 text-primary" />
            {initialTemplateId ? "Edit SOP Template" : "Create SOP Template"}
          </h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {loading ? (
            <div className="h-40 grid place-items-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : (
            <>
              {/* Meta */}
              <section className="space-y-3 border-b pb-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className={labelCls}>Template name</label>
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Fence Staining Standard Process" className="mt-1" />
                  </div>
                  <div>
                    <label className={labelCls}>Service type</label>
                    <select value={serviceType} onChange={(e) => setServiceType(e.target.value)} className={`${inputCls} mt-1`}>
                      {SERVICE_TYPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  <label className={labelCls}>Description (optional)</label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={2}
                    placeholder="What is this checklist for? Any context the crew needs."
                    className={`${inputCls} mt-1 resize-none`}
                  />
                </div>
                <div className="flex items-center gap-4 flex-wrap">
                  <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                    <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
                    <Star className="h-3.5 w-3.5 text-amber-500" /> Default for {SERVICE_TYPES.find((s) => s.value === serviceType)?.label || "this service"}
                  </label>
                  <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                    <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active
                  </label>
                  <Button size="sm" onClick={saveMeta} disabled={savingMeta} className="ml-auto">
                    {savingMeta && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                    <Save className="h-3.5 w-3.5 mr-1" />
                    {templateId ? "Save changes" : "Create template"}
                  </Button>
                </div>
                {!templateId && (
                  <p className="text-[11px] text-muted-foreground italic">
                    Save the template first, then add steps.
                  </p>
                )}
              </section>

              {/* Reference data card — Min Temp / Spray Tips / etc */}
              <section className="space-y-2 border-b pb-4">
                <h3 className="text-sm font-bold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
                  <Info className="h-3.5 w-3.5" /> Reference Card
                  <span className="text-[10px] font-normal normal-case text-muted-foreground">
                    Job-spec data shown above the checklist on the worker view (Min Temp, Spray Tips, etc.)
                  </span>
                </h3>
                <div className="space-y-1.5">
                  {referenceData.length === 0 && (
                    <p className="text-xs text-muted-foreground italic">No reference items. Click "Add" to put a value on the worker's job card.</p>
                  )}
                  {referenceData.map((item, i) => (
                    <div key={i} className="grid grid-cols-[1fr_2fr_auto] gap-2 items-center">
                      <Input
                        placeholder="Label (e.g. Min Temp)"
                        value={item.label}
                        onChange={(e) => setReferenceData((prev) => prev.map((r, idx) => idx === i ? { ...r, label: e.target.value } : r))}
                        className="h-8 text-xs"
                      />
                      <Input
                        placeholder="Value (e.g. 40°F)"
                        value={item.value}
                        onChange={(e) => setReferenceData((prev) => prev.map((r, idx) => idx === i ? { ...r, value: e.target.value } : r))}
                        className="h-8 text-xs"
                      />
                      <button
                        onClick={() => setReferenceData((prev) => prev.filter((_, idx) => idx !== i))}
                        className="text-muted-foreground hover:text-red-600 p-1"
                        title="Remove"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
                <Button
                  size="sm" variant="outline"
                  onClick={() => setReferenceData((prev) => [...prev, { label: "", value: "" }])}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add reference item
                </Button>
              </section>

              {/* Branches editor — wash-method picker / mutually-exclusive workflows */}
              <section className="space-y-2 border-b pb-4">
                <h3 className="text-sm font-bold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
                  <GitBranch className="h-3.5 w-3.5" /> Branches
                  <span className="text-[10px] font-normal normal-case text-muted-foreground">
                    Mutually-exclusive paths (e.g. Bleach Wash vs Power Wash). Worker picks one per job.
                  </span>
                </h3>
                <div className="space-y-1.5">
                  {branches.length === 0 && (
                    <p className="text-xs text-muted-foreground italic">No branches — every step shows on every job. Add a branch if you have alternative methods (e.g. bleach vs pressure-wash).</p>
                  )}
                  {branches.map((b, i) => (
                    <div key={i} className="grid grid-cols-[110px_1fr_1fr_auto] gap-2 items-center">
                      <Input
                        placeholder="key"
                        value={b.key}
                        onChange={(e) => setBranches((prev) => prev.map((br, idx) => idx === i ? { ...br, key: e.target.value.replace(/[^a-z0-9_]/gi, "_").toLowerCase() } : br))}
                        className="h-8 text-xs font-mono"
                      />
                      <Input
                        placeholder="Label (e.g. Bleach / Chemical)"
                        value={b.label}
                        onChange={(e) => setBranches((prev) => prev.map((br, idx) => idx === i ? { ...br, label: e.target.value } : br))}
                        className="h-8 text-xs"
                      />
                      <Input
                        placeholder="Subtitle (e.g. Pump sprayer)"
                        value={b.subtitle || ""}
                        onChange={(e) => setBranches((prev) => prev.map((br, idx) => idx === i ? { ...br, subtitle: e.target.value } : br))}
                        className="h-8 text-xs"
                      />
                      <button
                        onClick={() => setBranches((prev) => prev.filter((_, idx) => idx !== i))}
                        className="text-muted-foreground hover:text-red-600 p-1"
                        title="Remove"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
                <Button
                  size="sm" variant="outline"
                  onClick={() => setBranches((prev) => [...prev, { key: "", label: "", subtitle: "" }])}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add branch
                </Button>
              </section>

              {/* Steps grouped by category */}
              {templateId && SOP_CATEGORIES.map((cat) => {
                const inBucket = steps.filter((s) => s.category === cat.key)
                  .sort((a, b) => a.order_index - b.order_index);
                return (
                  <section key={cat.key} className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-bold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
                        <span>{cat.emoji}</span> {cat.label}
                        <span className="text-[10px] font-normal text-muted-foreground">({inBucket.length})</span>
                      </h3>
                      <Button size="sm" variant="ghost" onClick={() => setCreatingInCategory(cat.key)}>
                        <Plus className="h-3.5 w-3.5 mr-1" /> Add step
                      </Button>
                    </div>
                    <div className="space-y-1.5">
                      {inBucket.length === 0 ? (
                        <div className="text-xs text-muted-foreground italic border border-dashed rounded-lg p-3 text-center">
                          No {cat.label.toLowerCase()} steps yet
                        </div>
                      ) : (
                        inBucket.map((s, i) => (
                          <StepRow
                            key={s.id}
                            step={s}
                            isFirst={i === 0}
                            isLast={i === inBucket.length - 1}
                            onMoveUp={() => moveStep(s.id, -1)}
                            onMoveDown={() => moveStep(s.id, 1)}
                            onEdit={() => setEditingStep(s)}
                            onDelete={() => deleteStep(s.id)}
                          />
                        ))
                      )}
                    </div>
                  </section>
                );
              })}
            </>
          )}
        </div>

        <div className="p-3 border-t flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{steps.length} step{steps.length === 1 ? "" : "s"} · {steps.filter((s) => s.required).length} required</span>
          <Button variant="outline" size="sm" onClick={() => { onSaved(); onClose(); }}>Done</Button>
        </div>
      </div>

      {(editingStep || creatingInCategory) && (
        <StepEditModal
          initial={editingStep}
          defaultCategory={creatingInCategory || "execution"}
          branches={branches}
          onClose={() => { setEditingStep(null); setCreatingInCategory(null); }}
          onSubmit={async (body) => {
            if (editingStep) await updateStep(editingStep.id, body);
            else await addStep(body);
            setEditingStep(null);
            setCreatingInCategory(null);
          }}
        />
      )}
    </div>
  );
}


function StepRow({
  step, isFirst, isLast, onMoveUp, onMoveDown, onEdit, onDelete,
}: {
  step: SopTemplateStep;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="border rounded-lg p-2 bg-card flex items-center gap-2 group">
      <div className="flex flex-col gap-0">
        <button onClick={onMoveUp} disabled={isFirst} className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-20 disabled:cursor-not-allowed" title="Move up">
          <ArrowUp className="h-3 w-3" />
        </button>
        <button onClick={onMoveDown} disabled={isLast} className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-20 disabled:cursor-not-allowed" title="Move down">
          <ArrowDown className="h-3 w-3" />
        </button>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm font-medium truncate">{step.title}</span>
          {step.required && <span className="text-[10px] uppercase tracking-wider bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-bold">required</span>}
          {step.kind === "multiselect_alert" && (
            <span className="inline-flex items-center gap-0.5 text-[10px] uppercase tracking-wider bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-bold">
              <Bell className="h-2.5 w-2.5" /> alert
            </span>
          )}
          {step.kind === "checkbox" && step.photo_min_count > 0 && (
            <span className="inline-flex items-center gap-0.5 text-[10px] uppercase tracking-wider bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-bold">
              <Camera className="h-2.5 w-2.5" /> {step.photo_min_count > 1 ? `${step.photo_min_count} photos` : "photo"}
            </span>
          )}
          {step.branch_key && <span className="inline-flex items-center gap-0.5 text-[10px] uppercase tracking-wider bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded font-bold">branch · {step.branch_key}</span>}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          {step.section_name && <span className="text-[10px] text-muted-foreground italic truncate">§ {step.section_name}</span>}
          {step.description && <p className="text-[11px] text-muted-foreground truncate">{step.description}</p>}
        </div>
      </div>
      <button onClick={onEdit} className="p-1.5 text-muted-foreground hover:text-primary opacity-60 sm:opacity-0 sm:group-hover:opacity-100 transition" title="Edit">
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <button onClick={onDelete} className="p-1.5 text-muted-foreground hover:text-red-600 opacity-60 sm:opacity-0 sm:group-hover:opacity-100 transition" title="Delete">
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}


function StepEditModal({
  initial, defaultCategory, branches, onClose, onSubmit,
}: {
  initial: SopTemplateStep | null;
  defaultCategory: SopCategory;
  branches: SopBranch[];
  onClose: () => void;
  onSubmit: (body: SopStepBody) => Promise<void>;
}) {
  const [title, setTitle] = useState(initial?.title || "");
  const [description, setDescription] = useState(initial?.description || "");
  const [required, setRequired] = useState(initial?.required ?? true);
  const [category, setCategory] = useState<SopCategory>(initial?.category || defaultCategory);
  const [sectionName, setSectionName] = useState(initial?.section_name || "");
  const [branchKey, setBranchKey] = useState(initial?.branch_key || "");
  const [kind, setKind] = useState<SopStepKind>(initial?.kind || "checkbox");
  const [photoMinCount, setPhotoMinCount] = useState<number>(initial?.photo_min_count ?? 0);
  // Multiselect config — options as a textarea (one per line) + alert template
  const initialMs = (initial?.config as SopMultiselectConfig) || {};
  const [optionsText, setOptionsText] = useState(
    Array.isArray(initialMs.options) ? initialMs.options.join("\n") : "",
  );
  const [alertText, setAlertText] = useState(
    initialMs.alert_text || "Upsell heads-up at {{customer_name}} ({{address}}) — {{selected}} look dirty. {{lead_url}}"
  );
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!title.trim()) { toast.error("Step title required"); return; }
    if (kind === "multiselect_alert") {
      const opts = optionsText.split("\n").map((s) => s.trim()).filter(Boolean);
      if (opts.length === 0) { toast.error("Add at least one option"); return; }
    }
    setSaving(true);
    try {
      const config: SopMultiselectConfig | Record<string, unknown> =
        kind === "multiselect_alert"
          ? {
              options: optionsText.split("\n").map((s) => s.trim()).filter(Boolean),
              alert_text: alertText.trim(),
            }
          : {};
      await onSubmit({
        title: title.trim(),
        description,
        required,
        photo_required: photoMinCount > 0,
        photo_min_count: Math.max(0, photoMinCount),
        kind,
        config,
        category,
        section_name: sectionName.trim(),
        branch_key: branchKey.trim(),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-background rounded-lg shadow-xl w-full max-w-md max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b flex items-center justify-between">
          <h3 className="text-base font-semibold">{initial ? "Edit Step" : "Add Step"}</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1"><X className="h-4 w-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className={labelCls}>Title</label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Set up tarps along fence line" className="mt-1" />
          </div>
          <div>
            <label className={labelCls}>Description (optional context for the worker)</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
              className={`${inputCls} mt-1 resize-none`}
              placeholder="What does done look like? Any gotchas?" />
          </div>
          <div>
            <label className={labelCls}>Section name <span className="text-muted-foreground/60 normal-case font-normal">(visual heading on the worker view — e.g. "Bleach / Chemical Wash")</span></label>
            <Input value={sectionName} onChange={(e) => setSectionName(e.target.value)} placeholder="(blank = use category label)" className="mt-1" />
          </div>
          <div>
            <label className={labelCls}>Category <span className="text-muted-foreground/60 normal-case font-normal">(used for analytics + grouping)</span></label>
            <select value={category} onChange={(e) => setCategory(e.target.value as SopCategory)} className={`${inputCls} mt-1`}>
              {SOP_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.emoji} {c.label}</option>)}
            </select>
          </div>
          {branches.length > 0 && (
            <div>
              <label className={labelCls}>Branch <span className="text-muted-foreground/60 normal-case font-normal">(only show this step when the worker picks the matching method)</span></label>
              <select value={branchKey} onChange={(e) => setBranchKey(e.target.value)} className={`${inputCls} mt-1`}>
                <option value="">— Always show —</option>
                {branches.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
              </select>
            </div>
          )}

          <div>
            <label className={labelCls}>Step kind</label>
            <div className="grid grid-cols-2 gap-2 mt-1">
              <button
                type="button"
                onClick={() => setKind("checkbox")}
                className={`border rounded-lg p-2 text-left text-xs ${
                  kind === "checkbox" ? "border-primary bg-primary/5" : "border-input"
                }`}
              >
                <div className="font-bold flex items-center gap-1"><MessageSquare className="h-3 w-3" /> Checkbox</div>
                <p className="text-muted-foreground mt-0.5">Worker ticks to mark done. Optional notes + photos.</p>
              </button>
              <button
                type="button"
                onClick={() => setKind("multiselect_alert")}
                className={`border rounded-lg p-2 text-left text-xs ${
                  kind === "multiselect_alert" ? "border-primary bg-primary/5" : "border-input"
                }`}
              >
                <div className="font-bold flex items-center gap-1"><Bell className="h-3 w-3" /> Multiselect alert</div>
                <p className="text-muted-foreground mt-0.5">Worker picks from options. Selecting any SMS-es Alan with the items + a lead link.</p>
              </button>
            </div>
          </div>

          {kind === "checkbox" && (
            <div className="grid grid-cols-2 gap-2 items-end">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
                Required to complete the job
              </label>
              <div>
                <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
                  <Camera className="h-3 w-3 text-blue-600" /> Min photos
                </label>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  value={photoMinCount}
                  onChange={(e) => setPhotoMinCount(Math.max(0, parseInt(e.target.value) || 0))}
                  className="mt-1 h-8 text-sm"
                />
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  0 = no photo. 1 = single. 2+ = multi-photo gallery.
                </p>
              </div>
            </div>
          )}

          {kind === "multiselect_alert" && (
            <>
              <div>
                <label className={labelCls}>Options <span className="text-muted-foreground/60 normal-case font-normal">(one per line)</span></label>
                <textarea
                  value={optionsText}
                  onChange={(e) => setOptionsText(e.target.value)}
                  rows={4}
                  className={`${inputCls} mt-1 resize-none font-mono text-xs`}
                  placeholder={"Windows\nPool deck\nDriveway\nGutters"}
                />
              </div>
              <div>
                <label className={labelCls}>SMS to Alan when any selected</label>
                <textarea
                  value={alertText}
                  onChange={(e) => setAlertText(e.target.value)}
                  rows={3}
                  className={`${inputCls} mt-1 resize-none text-xs`}
                  placeholder="Upsell heads-up at {{customer_name}} ({{address}}) — {{selected}} look dirty. {{lead_url}}"
                />
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Available variables: <code className="px-1 bg-muted rounded">{`{{customer_name}}`}</code> · <code className="px-1 bg-muted rounded">{`{{customer_phone}}`}</code> · <code className="px-1 bg-muted rounded">{`{{address}}`}</code> · <code className="px-1 bg-muted rounded">{`{{selected}}`}</code> · <code className="px-1 bg-muted rounded">{`{{lead_url}}`}</code>
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
                Required to complete the job
              </label>
            </>
          )}
        </div>
        <div className="p-3 border-t flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>
            {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            {initial ? "Save" : "Add"}
          </Button>
        </div>
      </div>
    </div>
  );
}
