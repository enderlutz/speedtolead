// CompanyCamTab — the job-site record for one customer.
//
// Everything a cleaner or stainer needs standing at the fence, and everything
// management needs back before they drive away: the scope, before/after photos
// of every side, the stain quantity, the colour, and what the crew heard while
// they were there.
//
// Built for a phone held in one hand in somebody's back garden, so: big tap
// targets, every field saves on blur rather than behind a Save button, and
// nothing blocks a crew from recording what they have.
//
// The look is doing a job, not decoration. A crew member opens this filthy,
// in sunlight, one-handed, and needs to answer "what do I still owe?" in a
// second. So the top of the page is a progress ring and four tappable steps,
// and each stage of the job carries its own colour the whole way down —
// scope is violet, before-cleaning amber, after-cleaning cyan, after-staining
// green. Done is always green, missing is always amber, damage is always red.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera, Loader2, Trash2, AlertTriangle, CheckCircle2, Palette,
  Droplets, Users, ShoppingCart, MessageSquare, Send, RotateCcw, ClipboardCheck,
  Ruler, Sparkles, Paintbrush, MapPin, Phone, Check, Ban, ImagePlus,
  CircleDollarSign, Package, Hash,
} from "lucide-react";
import { toast } from "sonner";
import {
  api, canSeeRevenue, type CompanyCamPayload, type CompanyCamPhoto,
  type CompanyCamJob, type ColorPlanRow,
} from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, errMessage } from "@/lib/utils";

const PACKAGES = ["essential", "signature", "legacy"] as const;

/** One accent per stage of the job, so a crew member learns the colour rather
 *  than reading the heading. `grad` paints the icon chip, `band` the header
 *  wash behind it. */
type Accent = { grad: string; band: string };

const ACCENT: Record<string, Accent> = {
  violet:  { grad: "from-violet-500 to-indigo-600",   band: "from-violet-500/10 to-indigo-500/5" },
  amber:   { grad: "from-amber-500 to-orange-600",    band: "from-amber-500/10 to-orange-500/5" },
  cyan:    { grad: "from-cyan-500 to-sky-600",        band: "from-cyan-500/10 to-sky-500/5" },
  emerald: { grad: "from-emerald-500 to-teal-600",    band: "from-emerald-500/10 to-teal-500/5" },
  blue:    { grad: "from-blue-500 to-indigo-600",     band: "from-blue-500/10 to-indigo-500/5" },
  fuchsia: { grad: "from-fuchsia-500 to-purple-600",  band: "from-fuchsia-500/10 to-purple-500/5" },
  rose:    { grad: "from-rose-500 to-pink-600",       band: "from-rose-500/10 to-pink-500/5" },
  slate:   { grad: "from-slate-500 to-slate-700",     band: "from-slate-500/10 to-slate-500/5" },
};

/** Icon + accent per photo section. Keyed on the backend's section keys; an
 *  unknown key still renders, just in grey with a camera. */
const SECTION_LOOK: Record<string, { icon: React.ElementType; accent: Accent }> = {
  fence_scope:  { icon: Ruler,      accent: ACCENT.violet },
  clean_before: { icon: Camera,     accent: ACCENT.amber },
  clean_after:  { icon: Sparkles,   accent: ACCENT.cyan },
  stain_after:  { icon: Paintbrush, accent: ACCENT.emerald },
};

const sectionLook = (key: string) =>
  SECTION_LOOK[key] || { icon: Camera, accent: ACCENT.slate };

/** A card with a coloured header band. Replaces CardHeader/CardContent here
 *  because the band has to run the full width, under the icon chip. */
function Panel({
  id, icon: Icon, title, sub, right, accent, className, children,
}: {
  id?: string;
  icon: React.ElementType;
  title: string;
  sub?: string;
  right?: React.ReactNode;
  accent: Accent;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card id={id} className={cn("gap-0 py-0", className)}>
      <div className={`flex items-center gap-3 border-b bg-gradient-to-r ${accent.band} px-3.5 py-3`}>
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${accent.grad} shadow-sm shadow-black/10`}>
          <Icon className="h-4 w-4 text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-heading text-sm font-semibold leading-tight">{title}</p>
          {sub ? <p className="truncate text-[11px] text-muted-foreground">{sub}</p> : null}
        </div>
        {right}
      </div>
      <div className="space-y-3 p-3.5">{children}</div>
    </Card>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      {children}
      {hint ? <p className="text-[11px] leading-snug text-muted-foreground/80">{hint}</p> : null}
    </div>
  );
}

/** A number with its own icon chip, so the four things a crew loads the van
 *  with read as four things and not as a form. */
function StatTile({
  icon: Icon, label, accent, hint, children,
}: {
  icon: React.ElementType;
  label: string;
  accent: Accent;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${accent.grad} shadow-sm`}>
          <Icon className="h-3.5 w-3.5 text-white" />
        </div>
      </div>
      {children}
      {hint ? <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** How much of the job is on file. Reads at arm's length in sunlight, which a
 *  row of numbers does not. */
function Donut({ pct }: { pct: number }) {
  const r = 26;
  const circ = 2 * Math.PI * r;
  return (
    <div className="relative h-16 w-16 shrink-0">
      <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" strokeWidth="6" className="stroke-white/15" />
        <circle
          cx="32" cy="32" r={r} fill="none" strokeWidth="6" strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - Math.max(0, Math.min(100, pct)) / 100)}
          className={cn("transition-all duration-700",
                        pct >= 100 ? "stroke-emerald-400" : "stroke-sky-400")}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-sm font-bold tabular-nums">
        {pct}%
      </span>
    </div>
  );
}

/** Saves on blur, not on every keystroke — a crew on a phone shouldn't fire a
 *  request per character, and shouldn't have to find a Save button either. */
function BlurText({
  value, onSave, placeholder, rows,
}: { value: string; onSave: (v: string) => void; placeholder?: string; rows?: number }) {
  const [local, setLocal] = useState(value);
  useEffect(() => { setLocal(value); }, [value]);
  const commit = () => { if (local !== value) onSave(local); };
  if (rows) {
    return (
      <textarea
        value={local}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none transition focus:border-ring focus:ring-3 focus:ring-ring/30"
      />
    );
  }
  return (
    <Input value={local} placeholder={placeholder}
           onChange={(e) => setLocal(e.target.value)} onBlur={commit} />
  );
}

function PhotoCard({
  leadId, photo, onPatch, onDelete,
}: {
  leadId: string;
  photo: CompanyCamPhoto;
  onPatch: (p: { side?: string; note?: string; is_damage?: boolean }) => void;
  onDelete: () => void;
}) {
  // A Storage photo is a public CDN url and renders directly. Anything else
  // comes through our own authenticated endpoint, and an <img src> sends no
  // Authorization header — so pointing <img> at it 401s and renders broken.
  // That is why the imported fence-scope drawing showed its caption and no
  // picture. Fetch it with the token and hand <img> a blob url instead.
  const [blobUrl, setBlobUrl] = useState("");
  // Derived, not stored: a Storage photo needs no fetch at all, so putting it
  // through state would mean setting state inside an effect for no reason.
  const src = photo.from_storage ? photo.url : blobUrl;
  useEffect(() => {
    if (photo.from_storage) return;
    let url = "";
    let dead = false;
    void api.fetchCompanyCamPhotoUrl(leadId, photo.id).then((u) => {
      if (dead || !u) return;
      url = u;
      setBlobUrl(u);
    });
    return () => { dead = true; if (url) URL.revokeObjectURL(url); };
  }, [leadId, photo.id, photo.from_storage]);

  return (
    <div className={cn(
      "overflow-hidden rounded-xl border bg-card shadow-sm transition hover:shadow-md",
      photo.is_damage && "border-red-300 ring-1 ring-red-200",
    )}>
      <div className="relative">
        {src ? (
          <img src={src} alt={photo.side || `Photo ${photo.seq}`}
               className="h-36 w-full bg-muted object-cover sm:h-40" loading="lazy" />
        ) : (
          <div className="flex h-36 w-full items-center justify-center bg-gradient-to-br from-muted to-muted/50 sm:h-40">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-black/45 to-transparent" />
        <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-0.5 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm">
          <Hash className="h-2.5 w-2.5" />{photo.seq}
        </span>
        {photo.is_damage ? (
          <span className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded-md bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white shadow-sm">
            <AlertTriangle className="h-2.5 w-2.5" /> DAMAGE
          </span>
        ) : null}
        {photo.side ? (
          <span className="absolute bottom-1.5 left-1.5 max-w-[90%] truncate rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
            {photo.side}
          </span>
        ) : null}
      </div>
      <div className="space-y-1.5 p-2">
        <Input
          defaultValue={photo.side}
          placeholder="Which side? (back, left, front gate…)"
          onBlur={(e) => { if (e.target.value !== photo.side) onPatch({ side: e.target.value }); }}
          className="h-8 text-xs"
        />
        <Input
          defaultValue={photo.note}
          placeholder="Note (optional)"
          onBlur={(e) => { if (e.target.value !== photo.note) onPatch({ note: e.target.value }); }}
          className="h-8 text-xs"
        />
        <div className="flex items-center justify-between gap-1">
          <button
            type="button"
            onClick={() => onPatch({ is_damage: !photo.is_damage })}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-semibold transition",
              photo.is_damage
                ? "bg-red-50 text-red-700 hover:bg-red-100"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <AlertTriangle className="h-3 w-3" />
            {photo.is_damage ? "Marked damage" : "Mark damage"}
          </button>
          <button type="button" onClick={onDelete}
                  className="rounded-md p-1.5 text-muted-foreground transition hover:bg-red-50 hover:text-red-600"
                  title="Delete photo">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Green when settled, amber while they're still deciding, grey when nobody
 *  has asked. The same three colours the rest of the page uses. */
const STATUS_TONE: Record<string, { bar: string; on: string; text: string }> = {
  confirmed:  { bar: "bg-emerald-500", on: "bg-emerald-600 text-white hover:bg-emerald-600", text: "text-emerald-700" },
  choosing:   { bar: "bg-amber-500",   on: "bg-amber-500 text-white hover:bg-amber-500",     text: "text-amber-700" },
  not_chosen: { bar: "bg-slate-300",   on: "bg-slate-600 text-white hover:bg-slate-600",     text: "text-slate-600" },
};

/**
 * Where the customer is on colour, per area of the fence.
 *
 * One colour field could not say "front gates settled, insides still between
 * three", which is the normal case: photos don't do the colours justice, so
 * the cleaner holds samples up at the fence. Each row therefore carries an
 * area, a status, and the colours in play — and the statuses are what
 * generate the cleaner's to-do list on arrival.
 */
function ColorPlan({
  plan, statuses, areas, onChange,
}: {
  plan: ColorPlanRow[];
  statuses: { key: string; label: string; hint: string; wants_colors: number }[];
  areas: string[];
  onChange: (next: ColorPlanRow[]) => void;
}) {
  const set = (i: number, patch: Partial<ColorPlanRow>) =>
    onChange(plan.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  return (
    <div className="space-y-2">
      {plan.map((row, i) => {
        const st = statuses.find((x) => x.key === row.status);
        const tone = STATUS_TONE[row.status] || STATUS_TONE.not_chosen;
        return (
          <div key={i} className="relative overflow-hidden rounded-xl border bg-card pl-3">
            <div className={`absolute inset-y-0 left-0 w-1.5 ${tone.bar}`} />
            <div className="space-y-2 p-2.5">
              <div className="flex items-start gap-1.5">
                <Input
                  defaultValue={row.area}
                  placeholder="Which part? e.g. Front gates"
                  list="cc-color-areas"
                  onBlur={(e) => { if (e.target.value !== row.area) set(i, { area: e.target.value }); }}
                  className="h-9 text-sm font-medium"
                />
                <button type="button" onClick={() => onChange(plan.filter((_, idx) => idx !== i))}
                        className="mt-1 rounded-md p-1.5 text-muted-foreground transition hover:bg-red-50 hover:text-red-600"
                        title="Remove">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {statuses.map((o) => {
                  const on = row.status === o.key;
                  const t = STATUS_TONE[o.key] || STATUS_TONE.not_chosen;
                  return (
                    <Button key={o.key} size="sm"
                            variant={on ? "default" : "outline"}
                            className={cn("h-8 text-[11px] font-semibold", on && t.on)}
                            onClick={() => set(i, { status: o.key as ColorPlanRow["status"] })}>
                      {on ? <Check className="mr-1 h-3 w-3" /> : null}{o.label}
                    </Button>
                  );
                })}
              </div>
              {st ? <p className="text-[11px] leading-snug text-muted-foreground">{st.hint}</p> : null}
              {row.status !== "not_chosen" ? (
                <Input
                  defaultValue={row.colors.join(", ")}
                  placeholder={row.status === "choosing"
                    ? "Every colour in play, comma separated"
                    : "The colour"}
                  onBlur={(e) => {
                    const next = e.target.value.split(",").map((c) => c.trim()).filter(Boolean);
                    if (next.join(",") !== row.colors.join(",")) set(i, { colors: next });
                  }}
                  className="h-9 text-sm"
                />
              ) : null}
            </div>
          </div>
        );
      })}
      <datalist id="cc-color-areas">
        {areas.map((a) => <option key={a} value={a} />)}
      </datalist>
      <Button variant="outline" size="sm" className="h-9 w-full border-dashed sm:w-auto"
              onClick={() => onChange([...plan, { area: "", status: "not_chosen", colors: [] }])}>
        + Add a part of the fence
      </Button>
    </div>
  );
}

/** A tick list. Exists because the crew is moving to a flat rate per job, so
 *  what "done properly" means has to be written down, not assumed. */
function Checklist({
  items, ticked, onChange,
}: {
  items: { key: string; label: string; hint?: string }[];
  ticked: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="space-y-1.5">
      {items.map((it) => {
        const on = ticked.includes(it.key);
        return (
          <button
            key={it.key}
            type="button"
            onClick={() => onChange(on ? ticked.filter((k) => k !== it.key) : [...ticked, it.key])}
            className={cn(
              "flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition",
              on
                ? "border-emerald-300 bg-gradient-to-r from-emerald-50 to-teal-50 shadow-sm"
                : "bg-card hover:border-input hover:bg-muted/60",
            )}
          >
            {on ? (
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 shadow-sm">
                <Check className="h-3 w-3 text-white" />
              </span>
            ) : (
              <span className="mt-0.5 h-5 w-5 shrink-0 rounded-full border-2 border-input" />
            )}
            <span className="min-w-0">
              <span className={cn("text-sm font-medium", on && "text-emerald-900")}>{it.label}</span>
              {it.hint ? (
                <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{it.hint}</span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** "3 of 4" — a checklist with nothing showing its own progress gets half
 *  filled in and abandoned. */
function ProgressPill({ done, total }: { done: number; total: number }) {
  const all = total > 0 && done === total;
  return (
    <span className={cn(
      "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums",
      all ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground",
    )}>
      {all ? <Check className="h-2.5 w-2.5" /> : null}{done} of {total}
    </span>
  );
}

export default function CompanyCamTab({ leadId }: { leadId: string }) {
  const [data, setData] = useState<CompanyCamPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState<string>("");
  const [sending, setSending] = useState(false);
  // The preset text, editable right before it goes. The crew adjusts the
  // wording for the customer in front of them, so what they approved is what
  // gets sent.
  const [almostDoneText, setAlmostDoneText] = useState("");
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const d = await api.getCompanyCam(leadId);
      setData(d);
      setAlmostDoneText((t) => t || d.almost_done_default);
    }
    catch (e) { setError(errMessage(e, "Couldn't load Company Cam")); }
    finally { setLoading(false); }
  }, [leadId]);

  useEffect(() => { void load(); }, [load]);

  const patch = async (
    p: Partial<CompanyCamJob> & { upsells?: string[]; recalc_gallons?: boolean },
  ) => {
    if (!data) return;
    // Optimistic, because a crew on bad signal should see their typing stick.
    setData({ ...data, job: { ...data.job, ...p } as CompanyCamJob });
    try {
      const r = await api.updateCompanyCam(leadId, p);
      setData((d) => (d ? { ...d, job: r.job, blockers: r.blockers } : d));
    } catch (e) {
      toast.error(errMessage(e, "Couldn't save"));
      void load();
    }
  };

  const upload = async (section: string, files: FileList | null) => {
    if (!files?.length) return;
    setUploading(section);
    let ok = 0;
    try {
      for (const f of Array.from(files)) {
        await api.uploadCompanyCamPhoto(leadId, f, { section });
        ok += 1;
      }
      toast.success(`${ok} photo${ok === 1 ? "" : "s"} added`);
      await load();
    } catch (e) {
      toast.error(errMessage(e, "Upload failed"));
      if (ok) await load();
    } finally { setUploading(""); }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading Company Cam…
      </div>
    );
  }
  if (error || !data) {
    return (
      <Card className="border-red-300 py-0">
        <div className="flex items-start gap-3 bg-gradient-to-r from-red-500/10 to-rose-500/5 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
          <div>
            <p className="text-sm font-semibold text-red-900">Couldn't load Company Cam</p>
            <p className="text-xs text-red-800">{error || "No data came back."}</p>
          </div>
        </div>
      </Card>
    );
  }

  const {
    job, sections, photos, upsell_options, blockers, customer,
    color_statuses, color_areas, cleaner_checklist, stainer_checklist,
    almost_done_default, cleaner_actions,
  } = data;
  const totalPhotos = Object.values(photos).reduce((n, arr) => n + arr.length, 0);
  const damage = Object.values(photos).flat().filter((p) => p.is_damage).length;

  // Progress across the four stages. The scope stage counts as done when the
  // job is written out instead, because that is the agreed substitute for a
  // drawing — every other stage needs an actual photo.
  const steps = sections.map((sec) => {
    const n = (photos[sec.key] || []).length;
    const written = sec.key === "fence_scope" && !!job.scope_explanation.trim();
    return { ...sec, ...sectionLook(sec.key), n, done: n > 0 || written, written };
  });
  const donePct = steps.length
    ? Math.round((steps.filter((s) => s.done).length / steps.length) * 100)
    : 0;

  const jump = (key: string) =>
    document.getElementById(`cc-${key}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="space-y-3.5">
      {/* Who, where, and how much of the job is on file. */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-indigo-950 p-4 text-white ring-1 ring-white/10 sm:p-5">
        <div className="pointer-events-none absolute -right-16 -top-24 h-56 w-56 rounded-full bg-indigo-500/25 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -left-12 h-56 w-56 rounded-full bg-emerald-500/15 blur-3xl" />

        <div className="relative flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/50">
              Company Cam
            </p>
            <h2 className="font-heading truncate text-xl font-semibold sm:text-2xl">
              {customer.name || "This job"}
            </h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-white/70">
              {customer.address ? (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="h-3 w-3" />{customer.address}
                </span>
              ) : null}
              {customer.phone ? (
                <span className="inline-flex items-center gap-1 tabular-nums">
                  <Phone className="h-3 w-3" />{customer.phone}
                </span>
              ) : null}
              {customer.do_not_contact ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-red-500/25 px-2 py-0.5 font-semibold text-red-100">
                  <Ban className="h-3 w-3" /> Do not contact
                </span>
              ) : null}
            </div>
          </div>
          <Donut pct={donePct} />
        </div>

        {/* Tap a stage to jump to it. */}
        <div className="relative mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {steps.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => jump(s.key)}
              className={cn(
                "flex items-center gap-2 rounded-xl px-2.5 py-2 text-left ring-1 transition",
                s.done
                  ? "bg-emerald-400/15 ring-emerald-400/30 hover:bg-emerald-400/25"
                  : "bg-white/5 ring-white/10 hover:bg-white/10",
              )}
            >
              <span className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                s.done ? "bg-emerald-400 text-slate-900" : "bg-white/10 text-white/70",
              )}>
                {s.done ? <Check className="h-4 w-4" /> : <s.icon className="h-3.5 w-3.5" />}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[11px] font-semibold leading-tight">
                  {s.label}
                </span>
                <span className="block text-[10px] text-white/50">
                  {s.n ? `${s.n} photo${s.n === 1 ? "" : "s"}`
                       : s.written ? "written out" : "nothing yet"}
                </span>
              </span>
            </button>
          ))}
        </div>

        <p className="relative mt-3 text-[11px] text-white/55">
          {totalPhotos} photo{totalPhotos === 1 ? "" : "s"} on file
          {damage ? ` · ${damage} flagged as damage` : ""}
        </p>
      </div>

      {/* What still has to happen. A checklist, never a lock — a crew in
          somebody's garden must always be able to save what they have. */}
      {blockers.length > 0 ? (
        <Card className="border-amber-300 py-0">
          <div className="flex items-start gap-3 bg-gradient-to-r from-amber-500/15 to-orange-500/5 p-3.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 shadow-sm">
              <AlertTriangle className="h-4 w-4 text-white" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-amber-900">
                Still needed ({blockers.length})
              </p>
              <ul className="mt-1 space-y-1">
                {blockers.map((b) => (
                  <li key={b} className="flex items-start gap-1.5 text-xs text-amber-900">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                    {b}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Card>
      ) : (
        <Card className="border-emerald-300 py-0">
          <div className="flex items-center gap-3 bg-gradient-to-r from-emerald-500/15 to-teal-500/5 p-3.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-sm">
              <CheckCircle2 className="h-4 w-4 text-white" />
            </div>
            <div>
              <p className="text-sm font-semibold text-emerald-900">Fully documented</p>
              <p className="text-xs text-emerald-800">
                {totalPhotos} photo{totalPhotos === 1 ? "" : "s"}
                {damage ? `, ${damage} flagged as damage` : ""}. Nothing outstanding.
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* The job card: what to bring and what to put on. */}
      <Panel icon={Droplets} accent={ACCENT.blue} title="The job"
             sub="What to load the van with">
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile icon={Ruler} label="Square footage" accent={ACCENT.blue}
                    hint={job.sqft_edited ? "Edited by hand" : "From the latest estimate"}>
            <Input type="number" inputMode="decimal" defaultValue={job.sqft || ""}
                   className="h-10 text-base font-semibold tabular-nums"
                   onBlur={(e) => {
                     const v = parseFloat(e.target.value || "0");
                     if (v !== job.sqft) void patch({ sqft: v });
                   }} />
          </StatTile>

          <StatTile icon={Droplets} label="Gallons of stain" accent={ACCENT.cyan}
                    hint={job.gallons_edited
                      ? "Overridden — no longer follows the footage"
                      : `${job.sqft_per_gallon} sq ft a gallon, rounded up`}>
            <div className="flex gap-1.5">
              <Input type="number" inputMode="decimal" step="0.5" defaultValue={job.gallons_needed || ""}
                     className="h-10 text-base font-semibold tabular-nums"
                     onBlur={(e) => {
                       const v = parseFloat(e.target.value || "0");
                       if (v !== job.gallons_needed) void patch({ gallons_needed: v });
                     }} />
              {job.gallons_edited ? (
                <Button variant="outline" size="icon" className="h-10 w-10 shrink-0"
                        title="Go back to following the square footage"
                        onClick={() => void patch({ recalc_gallons: true })}>
                  <RotateCcw className="h-4 w-4" />
                </Button>
              ) : null}
            </div>
          </StatTile>

          <StatTile icon={Package} label="Package" accent={ACCENT.violet}>
            <div className="flex gap-1">
              {PACKAGES.map((p) => (
                <Button key={p} size="sm"
                        variant={job.package === p ? "default" : "outline"}
                        onClick={() => void patch({ package: job.package === p ? "" : p })}
                        className="h-10 flex-1 text-[11px] font-semibold capitalize">
                  {p}
                </Button>
              ))}
            </div>
          </StatTile>

          {/* Price is gated the same way revenue is everywhere else — the
              crew works from this screen and has no business seeing it. */}
          {canSeeRevenue() ? (
            <StatTile icon={CircleDollarSign} label="Final price" accent={ACCENT.emerald}
                      hint="Only visible to you, not the crew">
              <Input type="number" inputMode="decimal" step="1"
                     defaultValue={job.final_price || ""}
                     className="h-10 text-base font-semibold tabular-nums"
                     onBlur={(e) => {
                       const v = parseFloat(e.target.value || "0");
                       if (v !== job.final_price) void patch({ final_price: v });
                     }} />
            </StatTile>
          ) : null}
        </div>
      </Panel>

      {/* Colour, per area. Drives what the cleaner has to settle on site. */}
      <Panel icon={Palette} accent={ACCENT.fuchsia}
             title="Stain colour — where the customer is"
             sub="A row per part of the fence">
        <p className="text-xs leading-relaxed text-muted-foreground">
          They can be at a different stage on each — front gates settled while
          the insides are still between three colours is normal.
        </p>
        <ColorPlan
          plan={job.color_plan}
          statuses={color_statuses}
          areas={color_areas}
          onChange={(next) => void patch({ color_plan: next })}
        />

        {cleaner_actions.length > 0 ? (
          <div className="overflow-hidden rounded-xl border border-sky-300 bg-gradient-to-br from-sky-50 to-cyan-50">
            <p className="flex items-center gap-2 border-b border-sky-200/70 bg-sky-500/10 px-3 py-2 text-xs font-bold uppercase tracking-wide text-sky-900">
              <Palette className="h-3.5 w-3.5" /> Cleaner, when you arrive
            </p>
            <ul className="space-y-1.5 p-3">
              {cleaner_actions.map((a) => (
                <li key={a} className="flex items-start gap-2 text-xs text-sky-900">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500" />
                  {a}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-wrap items-end gap-2 rounded-xl border bg-muted/30 p-3">
          <div className="min-w-[180px] flex-1">
            <Field label="Colour they finally went with"
                   hint="Fill in once it's settled — this is the one the stainer uses.">
              <BlurText value={job.final_color} placeholder="e.g. Canyon Brown"
                        onSave={(v) => void patch({ final_color: v })} />
            </Field>
          </div>
          <Button size="lg"
                  variant={job.color_shown_at ? "default" : "outline"}
                  className={cn("h-10", job.color_shown_at && "bg-emerald-600 hover:bg-emerald-600")}
                  title="Mark that you physically showed the customer the colour"
                  onClick={async () => {
                    try {
                      const r = await api.markCompanyCamColorShown(leadId);
                      setData((d) => (d ? { ...d, job: r.job } : d));
                      toast.success("Logged — colour shown to the customer");
                    } catch (e) { toast.error(errMessage(e, "Couldn't save")); }
                  }}>
            {job.color_shown_at
              ? <><Check className="mr-1.5 h-4 w-4" /> Shown to customer</>
              : <><Palette className="mr-1.5 h-4 w-4" /> I showed them the colour</>}
          </Button>
        </div>
        {job.color_shown_at ? (
          <p className="text-[11px] text-muted-foreground">
            Shown by {job.color_shown_by || "crew"}. Show it even when it's
            already confirmed.
          </p>
        ) : null}
      </Panel>

      {/* Photos, in the order the job happens. */}
      {steps.map((sec) => {
        const list = photos[sec.key] || [];
        const busy = uploading === sec.key;
        return (
          <Panel
            key={sec.key}
            id={`cc-${sec.key}`}
            icon={sec.icon}
            accent={sec.accent}
            title={sec.label}
            sub={sec.who}
            right={
              <span className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums",
                list.length ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground",
              )}>
                {list.length ? <Check className="h-2.5 w-2.5" /> : null}
                {list.length} photo{list.length === 1 ? "" : "s"}
              </span>
            }
          >
            <p className="text-xs leading-relaxed text-muted-foreground">{sec.hint}</p>

            {sec.key === "fence_scope" && !list.length ? (
              <div className="rounded-xl border border-violet-200 bg-violet-50/50 p-3">
                <Field label="No scope drawing — write out the job instead"
                       hint="So the cleaner and stainer know exactly what is and isn't included.">
                  <BlurText rows={3} value={job.scope_explanation}
                            placeholder="e.g. All inside-facing sides plus the outside front. Skip the shared fence with next door."
                            onSave={(v) => void patch({ scope_explanation: v })} />
                </Field>
              </div>
            ) : null}

            <input
              ref={(el) => { inputs.current[sec.key] = el; }}
              type="file" accept="image/*" multiple capture="environment" hidden
              onChange={(e) => { void upload(sec.key, e.target.files); e.target.value = ""; }}
            />

            {list.length ? (
              <>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  {list.map((p) => (
                    <PhotoCard key={p.id} leadId={leadId} photo={p}
                      onPatch={async (pp) => {
                        try {
                          await api.updateCompanyCamPhoto(leadId, p.id, pp);
                          await load();
                        } catch (e) { toast.error(errMessage(e, "Couldn't save")); }
                      }}
                      onDelete={async () => {
                        if (!confirm("Delete this photo?")) return;
                        try {
                          await api.deleteCompanyCamPhoto(leadId, p.id);
                          await load();
                        } catch (e) { toast.error(errMessage(e, "Couldn't delete")); }
                      }} />
                  ))}
                </div>
                <Button variant="outline" size="lg" disabled={busy}
                        onClick={() => inputs.current[sec.key]?.click()}
                        className="h-11 w-full sm:w-auto">
                  {busy
                    ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Uploading…</>
                    : <><Camera className="mr-1.5 h-4 w-4" /> Add more photos</>}
                </Button>
              </>
            ) : (
              // A big dashed target, because on a phone this is the one thing
              // the crew is here to do.
              <button
                type="button"
                disabled={busy}
                onClick={() => inputs.current[sec.key]?.click()}
                className="flex w-full flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-input bg-muted/30 py-7 text-muted-foreground transition hover:border-primary/50 hover:bg-primary/5 hover:text-foreground disabled:opacity-60"
              >
                {busy
                  ? <Loader2 className="h-7 w-7 animate-spin" />
                  : <ImagePlus className="h-7 w-7" />}
                <span className="text-sm font-semibold">
                  {busy ? "Uploading…" : "Take or add photos"}
                </span>
                <span className="text-[11px]">{sec.who}</span>
              </button>
            )}

            {sec.key === "clean_after" ? (
              <>
                <div className="flex items-center justify-between gap-2 pt-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Before you leave — cleaner's checklist
                  </span>
                  <ProgressPill done={job.cleaner_checklist.length} total={cleaner_checklist.length} />
                </div>
                <Checklist items={cleaner_checklist} ticked={job.cleaner_checklist}
                           onChange={(next) => void patch({ cleaner_checklist: next })} />
                <Field label="Cleaning notes"
                       hint="Anything the customer said, or anything management needs to decide on. Fill this in before you leave.">
                  <BlurText rows={3} value={job.cleaning_notes}
                            placeholder="What the customer mentioned, anything unexpected…"
                            onSave={(v) => void patch({ cleaning_notes: v })} />
                </Field>
              </>
            ) : null}

            {sec.key === "stain_after" ? (
              <>
                <div className="flex items-center justify-between gap-2 pt-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Before you leave — stainer's checklist
                  </span>
                  <ProgressPill done={job.stainer_checklist.length} total={stainer_checklist.length} />
                </div>
                <Checklist items={stainer_checklist} ticked={job.stainer_checklist}
                           onChange={(next) => void patch({ stainer_checklist: next })} />
                <Field label="Staining notes"
                       hint="Anything worth knowing before we invoice or follow up.">
                  <BlurText rows={3} value={job.staining_notes}
                            placeholder="How it went, anything left to do…"
                            onSave={(v) => void patch({ staining_notes: v })} />
                </Field>
              </>
            ) : null}
          </Panel>
        );
      })}

      {/* Almost finished — catch the customer while the crew is still there. */}
      <Panel icon={MessageSquare} accent={ACCENT.cyan}
             title="20–30 minutes from finishing"
             sub="Text the customer before you pack up">
        {job.almost_done_sent_at ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-emerald-300 bg-gradient-to-r from-emerald-50 to-teal-50 p-3">
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-900">
              <CheckCircle2 className="h-4 w-4" /> Sent
            </span>
            <span className="text-xs text-emerald-800">
              {job.almost_done_sent_at.slice(0, 16).replace("T", " ")} UTC
              {job.almost_done_sent_by ? ` by ${job.almost_done_sent_by}` : ""}
            </span>
            <Button variant="outline" size="sm" className="ml-auto h-8"
                    onClick={async () => {
                      if (!confirm("Clear this so it can be sent again? Only for a genuine second visit.")) return;
                      try {
                        const r = await api.resetCompanyCamAlmostDone(leadId);
                        setData((d) => (d ? { ...d, job: r.job } : d));
                      } catch (e) { toast.error(errMessage(e, "Couldn't reset")); }
                    }}>
              <RotateCcw className="mr-1 h-3.5 w-3.5" /> Allow again
            </Button>
          </div>
        ) : (
          <>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Edit this however you like before sending — it goes exactly as written.
            </p>
            <div className="relative">
              <textarea
                value={almostDoneText}
                onChange={(e) => setAlmostDoneText(e.target.value)}
                rows={4}
                className="w-full resize-y rounded-xl border border-input bg-background px-3 py-2.5 text-sm leading-relaxed shadow-sm outline-none transition focus:border-ring focus:ring-3 focus:ring-ring/30"
              />
              <span className="absolute bottom-2 right-2.5 text-[10px] tabular-nums text-muted-foreground">
                {almostDoneText.length} chars
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="lg"
                      className="h-11 flex-1 bg-gradient-to-r from-cyan-600 to-sky-600 text-base font-semibold hover:from-cyan-600 hover:to-sky-700 sm:flex-none sm:px-6"
                      disabled={sending || customer.do_not_contact
                                || !customer.phone || !almostDoneText.trim()}
                      title={customer.do_not_contact
                        ? "This customer asked not to be contacted"
                        : !customer.phone ? "No phone number on this lead" : ""}
                      onClick={async () => {
                        setSending(true);
                        try {
                          const r = await api.sendCompanyCamAlmostDone(leadId, almostDoneText);
                          setData((d) => (d ? { ...d, job: r.job } : d));
                          toast.success("Customer texted");
                        } catch (e) { toast.error(errMessage(e, "Couldn't send")); }
                        finally { setSending(false); }
                      }}>
                {sending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                         : <Send className="mr-1.5 h-4 w-4" />}
                Send it
              </Button>
              {almostDoneText !== almost_done_default ? (
                <Button variant="ghost" size="sm" className="h-9"
                        onClick={() => setAlmostDoneText(almost_done_default)}>
                  <RotateCcw className="mr-1 h-3.5 w-3.5" /> Reset wording
                </Button>
              ) : null}
            </div>
          </>
        )}
        {customer.do_not_contact ? (
          <p className="flex items-center gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-800">
            <Ban className="h-3.5 w-3.5 shrink-0" />
            This customer has opted out — nothing will send.
          </p>
        ) : null}
      </Panel>

      {/* What the crew heard. */}
      <Panel icon={ShoppingCart} accent={ACCENT.violet}
             title="Did the customer mention anything else?"
             sub="Tick anything they brought up">
        <div className="flex flex-wrap gap-1.5">
          {upsell_options.map((o) => {
            const on = job.upsells.includes(o.key);
            return (
              <Button key={o.key} size="sm"
                      variant={on ? "default" : "outline"}
                      className={cn("h-9 text-xs font-medium",
                                    on && "bg-gradient-to-r from-fuchsia-600 to-purple-600 hover:from-fuchsia-600 hover:to-purple-700")}
                      onClick={() => void patch({
                        upsells: on ? job.upsells.filter((u) => u !== o.key)
                                    : [...job.upsells, o.key],
                      })}>
                {on ? <Check className="mr-1 h-3 w-3" /> : null}{o.label}
              </Button>
            );
          })}
        </div>
        <Field label="Notes on what they wanted">
          <BlurText rows={2} value={job.upsell_notes}
                    placeholder="What they actually said…"
                    onSave={(v) => void patch({ upsell_notes: v })} />
        </Field>
      </Panel>

      {/* What actually happened. The gap from the estimates is the number
          worth having — for pricing, and for the stain inventory. */}
      <Panel icon={ClipboardCheck} accent={ACCENT.slate}
             title="End of job — what we actually used"
             sub="Everything above is the estimate; this is the real thing">
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile icon={Ruler} label="Actual square footage" accent={ACCENT.slate}
                    hint={job.sqft ? `Estimated ${Math.round(job.sqft)}` : undefined}>
            <Input type="number" inputMode="decimal" defaultValue={job.actual_sqft || ""}
                   className="h-10 text-base font-semibold tabular-nums"
                   onBlur={(e) => {
                     const v = parseFloat(e.target.value || "0");
                     if (v !== job.actual_sqft) void patch({ actual_sqft: v });
                   }} />
          </StatTile>
          <StatTile icon={Droplets} label="Stain gallons used" accent={ACCENT.emerald}
                    hint={job.gallons_needed ? `Planned ${job.gallons_needed}` : undefined}>
            <Input type="number" inputMode="decimal" step="0.5"
                   defaultValue={job.stain_gallons_used || ""}
                   className="h-10 text-base font-semibold tabular-nums"
                   onBlur={(e) => {
                     const v = parseFloat(e.target.value || "0");
                     if (v !== job.stain_gallons_used) void patch({ stain_gallons_used: v });
                   }} />
          </StatTile>
          <StatTile icon={ShoppingCart} label="Stain gallons bought today" accent={ACCENT.amber}
                    hint="Only what was picked up on the way, not what came off the shelf">
            <Input type="number" inputMode="decimal" step="0.5"
                   defaultValue={job.stain_gallons_bought || ""}
                   className="h-10 text-base font-semibold tabular-nums"
                   onBlur={(e) => {
                     const v = parseFloat(e.target.value || "0");
                     if (v !== job.stain_gallons_bought) void patch({ stain_gallons_bought: v });
                   }} />
          </StatTile>
          <StatTile icon={Sparkles} label="Bleach gallons used" accent={ACCENT.cyan}>
            <Input type="number" inputMode="decimal" step="0.5"
                   defaultValue={job.bleach_gallons_used || ""}
                   className="h-10 text-base font-semibold tabular-nums"
                   onBlur={(e) => {
                     const v = parseFloat(e.target.value || "0");
                     if (v !== job.bleach_gallons_used) void patch({ bleach_gallons_used: v });
                   }} />
          </StatTile>
        </div>
        {job.actual_sqft > 0 && job.sqft > 0
          && Math.abs(job.actual_sqft - job.sqft) / job.sqft > 0.15 ? (
          <p className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              That's {Math.round(Math.abs(job.actual_sqft - job.sqft) / job.sqft * 100)}%
              {job.actual_sqft > job.sqft ? " more" : " less"} than estimated — worth
              knowing why before the next quote like it.
            </span>
          </p>
        ) : null}
      </Panel>

      {/* Neighbours — the cheapest lead source there is. */}
      <Panel icon={Users} accent={ACCENT.rose}
             title="Any interested neighbours?"
             sub="The cheapest lead there is">
        <Button size="lg"
                variant={job.neighbor_interested ? "default" : "outline"}
                className={cn("h-11 w-full sm:w-auto",
                              job.neighbor_interested
                                && "bg-gradient-to-r from-rose-600 to-pink-600 hover:from-rose-600 hover:to-pink-700")}
                onClick={() => void patch({ neighbor_interested: !job.neighbor_interested })}>
          {job.neighbor_interested
            ? <><CheckCircle2 className="mr-1.5 h-4 w-4" /> Yes, a neighbour was interested</>
            : <><Users className="mr-1.5 h-4 w-4" /> A neighbour asked about us</>}
        </Button>
        {!job.neighbor_interested ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Getting their name and number is the whole job here — Alan calls
            them once this one's finished.
          </p>
        ) : (
          <div className="space-y-3 rounded-xl border border-rose-200 bg-rose-50/40 p-3">
            {/* A referral is a lead, so it's captured like one. All optional —
                a first name and a number is already enough to make the call. */}
            <div className="grid gap-2.5 sm:grid-cols-2">
              <Field label="First name">
                <BlurText value={job.neighbor_first_name} placeholder="First"
                          onSave={(v) => void patch({ neighbor_first_name: v })} />
              </Field>
              <Field label="Last name">
                <BlurText value={job.neighbor_last_name} placeholder="Last"
                          onSave={(v) => void patch({ neighbor_last_name: v })} />
              </Field>
              <Field label="Phone number" hint="The one thing that makes this callable">
                <BlurText value={job.neighbor_phone} placeholder="(713) 555-0101"
                          onSave={(v) => void patch({ neighbor_phone: v })} />
              </Field>
              <Field label="What do they want doing?">
                <BlurText value={job.neighbor_project}
                          placeholder="e.g. back fence, maybe the gates too"
                          onSave={(v) => void patch({ neighbor_project: v })} />
              </Field>
            </div>
            <Field label="Anything else"
                   hint="Which house, best time to call, what they said.">
              <BlurText rows={2} value={job.neighbor_notes}
                        placeholder="e.g. House to the left, grey truck — said to call after 5."
                        onSave={(v) => void patch({ neighbor_notes: v })} />
            </Field>
          </div>
        )}
      </Panel>
    </div>
  );
}
