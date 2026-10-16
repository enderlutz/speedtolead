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
  Droplets, Hammer, Search, Send, Users, ShoppingCart, MessageSquare, RotateCcw, ClipboardCheck,
  Ruler, Sparkles, Paintbrush, MapPin, Phone, Check, Ban, ImagePlus,
  Package, Hash, Hourglass, Images, Plus, X, Eye,
} from "lucide-react";
import { toast } from "sonner";
import {
  api, canSeeRevenue, STAIN_FINISH_TYPES, type CompanyCamPayload, type CoverageStats, type StainOption, type CompanyCamPhoto,
  type CompanyCamJob, type ColorPlanRow,
} from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, errMessage, formatCurrency } from "@/lib/utils";
import { ACCENT, type Accent } from "@/lib/accents";
import { Panel, Field, StatTile, ProgressPill, Pill } from "@/components/Panel";
import { SidesPicker } from "@/components/SidesPicker";
import { Chips, Counter, FencePart, type FencePartKey } from "@/components/proposal/Repairs";
import { PARTS, PICKETS, POSTS } from "@/lib/repairs";
import { sidesLabel } from "@/lib/fenceSides";

const PACKAGES = ["essential", "signature", "legacy"] as const;

/** Icon + accent per photo section. Keyed on the backend's section keys; an
 *  unknown key still renders, just in grey with a camera. */
const SECTION_LOOK: Record<string, { icon: React.ElementType; accent: Accent }> = {
  fence_scope:  { icon: Ruler,      accent: ACCENT.violet },
  clean_before: { icon: Camera,     accent: ACCENT.amber },
  clean_after:  { icon: Sparkles,   accent: ACCENT.cyan },
  stain_before: { icon: Eye,        accent: ACCENT.blue },
  stain_after:  { icon: Paintbrush, accent: ACCENT.emerald },
};

const sectionLook = (key: string) =>
  SECTION_LOOK[key] || { icon: Camera, accent: ACCENT.slate };

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
  const [state, setState] = useState<"" | "typing" | "saved">("");
  // Saves a second after typing stops, and on leaving the box: a crew that
  // types a note and pockets the phone keeps it (Alan, 2026-10-15).
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ local, value, onSave });
  useEffect(() => { latest.current = { local, value, onSave }; });
  // The saved text coming back from the server, unless they're mid-typing:
  // a reply to an earlier save mustn't wipe the letters typed since.
  const [seen, setSeen] = useState(value);
  if (value !== seen && state !== "typing") { setSeen(value); setLocal(value); }
  const commit = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const { local: l, value: v, onSave: save } = latest.current;
    if (l !== v) { save(l); setState("saved"); }
  }, []);
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); commit(); } }, [commit]);
  const change = (v: string) => {
    setLocal(v);
    setState("typing");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(commit, 1000);
  };
  const note = state ? (
    <p className={cn("mt-0.5 text-xs font-semibold", state === "saved" ? "text-emerald-700" : "text-muted-foreground")}>
      {state === "saved" ? "✓ Saved" : "Saving…"}
    </p>
  ) : null;
  if (rows) {
    return (
      <>
        <textarea
          value={local}
          rows={rows}
          placeholder={placeholder}
          onChange={(e) => change(e.target.value)}
          onBlur={commit}
          className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-base shadow-sm outline-none transition focus:border-ring focus:ring-3 focus:ring-ring/30 sm:text-sm"
        />
        {note}
      </>
    );
  }
  return (
    <>
      <Input value={local} placeholder={placeholder}
             onChange={(e) => change(e.target.value)} onBlur={commit} />
      {note}
    </>
  );
}

function PhotoCard({
  leadId, photo, onPatch, onDelete, bare = false,
}: {
  leadId: string;
  photo: CompanyCamPhoto;
  /** Just the picture, full width, nothing to fill in (the crew's scope). */
  bare?: boolean;
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

  if (bare) {
    // Tap to open it full size, to zoom in on a side.
    return src ? (
      <a href={src} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl border bg-muted">
        <img src={src} alt="The fence scope" className="max-h-[75vh] w-full object-contain" />
      </a>
    ) : (
      <div className="flex h-56 items-center justify-center rounded-xl bg-muted"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
    );
  }
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
        <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-0.5 rounded-md bg-black/55 px-1.5 py-0.5 text-xs font-bold text-white backdrop-blur-sm">
          <Hash className="h-2.5 w-2.5" />{photo.seq}
        </span>
        {photo.is_damage ? (
          <span className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded-md bg-red-600 px-1.5 py-0.5 text-xs font-bold text-white shadow-sm">
            <AlertTriangle className="h-2.5 w-2.5" /> DAMAGE
          </span>
        ) : null}
        {photo.side ? (
          <span className="absolute bottom-1.5 left-1.5 max-w-[90%] truncate rounded-md bg-black/55 px-1.5 py-0.5 text-xs font-medium text-white backdrop-blur-sm">
            {photo.side}
          </span>
        ) : null}
      </div>
      <div className="space-y-1.5 p-2">
        <Input
          defaultValue={photo.side}
          placeholder="Which side? (back, left, front gate…)"
          onBlur={(e) => { if (e.target.value !== photo.side) onPatch({ side: e.target.value }); }}
          className="h-10 text-base sm:h-8 sm:text-xs"
        />
        <Input
          defaultValue={photo.note}
          placeholder="Note (optional)"
          onBlur={(e) => { if (e.target.value !== photo.note) onPatch({ note: e.target.value }); }}
          className="h-10 text-base sm:h-8 sm:text-xs"
        />
        <div className="flex items-center justify-between gap-1">
          <button
            type="button"
            onClick={() => onPatch({ is_damage: !photo.is_damage })}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-semibold transition",
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

/** The one free-text box in a colour row. Uncontrolled like the rest of this
 *  screen: saves on blur or Enter, and remounts (via `key`) when the saved
 *  value changes underneath it. */
function CommitInput({
  value, onCommit, placeholder, className,
}: {
  value: string;
  onCommit: (next: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <Input
      key={value}
      defaultValue={value}
      placeholder={placeholder}
      className={className}
      onBlur={(e) => { const v = e.target.value.trim(); if (v !== value) onCommit(v); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
    />
  );
}

/** "Other / HOA colour". Adds on Enter or blur, then clears itself. */
function AddColorBox({ onAdd }: { onAdd: (color: string) => void }) {
  const commit = (el: HTMLInputElement) => {
    const v = el.value.trim();
    if (v) { onAdd(v); el.value = ""; }
  };
  return (
    <Input
      placeholder="Other / HOA colour — type it, then Enter"
      className="h-9 text-sm"
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(e.currentTarget); } }}
      onBlur={(e) => commit(e.currentTarget)}
    />
  );
}

const EMPTY_ROW: ColorPlanRow = { area: "", sides: [], status: "not_chosen", colors: [], leaning: "" };

/** One colour: the sides it covers, where the customer is on it, and the
 *  colours in play. */
function ColorRow({
  row, statuses, colorOptions, estimateSides, elsewhere, isDraft, onChange, onRemove,
}: {
  row: ColorPlanRow;
  statuses: { key: string; label: string; hint: string; wants_colors: number }[];
  colorOptions: string[];
  estimateSides: string[];
  elsewhere: string[];
  isDraft?: boolean;
  onChange: (patch: Partial<ColorPlanRow>) => void;
  onRemove: () => void;
}) {
  const st = statuses.find((x) => x.key === row.status);
  const tone = STATUS_TONE[row.status] || STATUS_TONE.not_chosen;
  const label = row.sides.length ? sidesLabel(row.sides) : row.area;
  const single = row.status === "confirmed";
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const has = (c: string) => row.colors.some((x) => same(x, c));
  const toggleColor = (c: string) => {
    if (single) onChange({ colors: has(c) ? [] : [c] });
    else onChange({ colors: has(c) ? row.colors.filter((x) => !same(x, c)) : [...row.colors, c] });
  };
  const custom = row.colors.filter((c) => !colorOptions.some((o) => same(o, c)));
  const chipCls = (on: boolean) => cn(
    "inline-flex h-8 items-center gap-1 rounded-lg border px-2.5 text-xs font-semibold transition active:scale-95",
    on
      ? "border-transparent bg-gradient-to-br from-fuchsia-500 to-purple-600 text-white shadow-sm"
      : "border-input bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground",
  );

  return (
    <div className="relative overflow-hidden rounded-xl border bg-card pl-3">
      <div className={`absolute inset-y-0 left-0 w-1.5 ${tone.bar}`} />
      <div className="space-y-2.5 p-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className={cn("text-sm font-semibold leading-tight", !label && "text-muted-foreground")}>
              {label || "Which sides get this colour?"}
            </p>
            <p className="text-xs text-muted-foreground">
              {row.sides.length
                ? `${row.sides.length} of 8 sides`
                : isDraft
                  ? "Tap the sides below — it saves as soon as you pick one."
                  : "Written before the sides map. Tap the sides to place it."}
            </p>
          </div>
          <button type="button" onClick={onRemove}
                  className="rounded-md p-1.5 text-muted-foreground transition hover:bg-red-50 hover:text-red-600"
                  title="Remove">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>

        <SidesPicker
          compact
          value={row.sides}
          highlight={estimateSides}
          elsewhere={elsewhere}
          onChange={(sides) => onChange({ sides })}
        />

        <div className="flex flex-wrap gap-1.5">
          {statuses.map((o) => {
            const on = row.status === o.key;
            const t = STATUS_TONE[o.key] || STATUS_TONE.not_chosen;
            return (
              <Button key={o.key} size="sm"
                      variant={on ? "default" : "outline"}
                      className={cn("h-8 text-xs font-semibold", on && t.on)}
                      onClick={() => onChange({ status: o.key as ColorPlanRow["status"] })}>
                {on ? <Check className="mr-1 h-3 w-3" /> : null}{o.label}
              </Button>
            );
          })}
        </div>
        {st ? <p className="text-xs leading-snug text-muted-foreground">{st.hint}</p> : null}

        {row.status !== "not_chosen" ? (
          <div className="space-y-1.5">
            <div className="flex flex-wrap gap-1.5">
              {colorOptions.map((c) => (
                <button key={c} type="button" aria-pressed={has(c)} onClick={() => toggleColor(c)} className={chipCls(has(c))}>
                  {has(c) ? <Check className="h-3 w-3" /> : null}{c}
                </button>
              ))}
              {custom.map((c) => (
                <button key={`custom-${c}`} type="button" aria-pressed onClick={() => toggleColor(c)}
                        className={chipCls(true)} title="Tap to remove">
                  <Check className="h-3 w-3" />{c}<X className="h-3 w-3 opacity-80" />
                </button>
              ))}
            </div>
            <AddColorBox onAdd={(c) => onChange({ colors: single ? [c] : (has(c) ? row.colors : [...row.colors, c]) })} />
            <p className="text-xs text-muted-foreground">
              {single ? "One colour — tapping another swaps it." : "Tap every colour still in play."}
            </p>
          </div>
        ) : (
          <CommitInput
            value={row.leaning}
            onCommit={(v) => onChange({ leaning: v })}
            placeholder="Leaning a direction? e.g. browns, nothing reddish"
            className="h-9 text-sm"
          />
        )}
      </div>
    </div>
  );
}

/**
 * Where the customer is on colour, per part of the fence.
 *
 * One colour field could not say "insides settled, outsides still between
 * three", which is the normal case: photos don't do the colours justice, so
 * the cleaner holds samples up at the fence. Each row is therefore a set of
 * sides — the same eight the estimator uses — with a status and the colours
 * in play. The statuses generate the cleaner's to-do list on arrival.
 *
 * A side belongs to one row. Tapping it in another row moves it.
 */
function ColorPlan({
  plan, statuses, colorOptions, estimateSides, onChange, scopePhoto = false,
}: {
  plan: ColorPlanRow[];
  statuses: { key: string; label: string; hint: string; wants_colors: number }[];
  colorOptions: string[];
  estimateSides: string[];
  /** A scope photo is on file: it shows the sides, so tapping them is optional. */
  scopePhoto?: boolean;
  onChange: (next: ColorPlanRow[]) => void;
}) {
  // "Add a part of the fence" opens a row here first. It goes to the server
  // the moment it has a side or a colour. Before that the server has nothing
  // to keep — and saving it anyway is exactly how the old version lost every
  // new row before anybody could touch it.
  const [drafts, setDrafts] = useState<ColorPlanRow[]>([]);

  const strip = (rows: ColorPlanRow[], taken: Set<string>) =>
    rows.map((r) => ({ ...r, sides: r.sides.filter((s) => !taken.has(s)) }));

  const claimedExcept = (skip: { saved?: number; draft?: number }) => {
    const out: string[] = [];
    plan.forEach((r, i) => { if (i !== skip.saved) out.push(...r.sides); });
    drafts.forEach((r, i) => { if (i !== skip.draft) out.push(...r.sides); });
    return out;
  };

  const setSaved = (i: number, patch: Partial<ColorPlanRow>) => {
    let next = plan.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    if (patch.sides) {
      const mine = new Set(patch.sides);
      next = next.map((r, idx) => (idx === i ? r : { ...r, sides: r.sides.filter((s) => !mine.has(s)) }));
      setDrafts((d) => strip(d, mine));
    }
    onChange(next);
  };

  const setDraft = (i: number, patch: Partial<ColorPlanRow>) => {
    const row = { ...drafts[i], ...patch };
    if (row.sides.length || row.colors.length) {
      const mine = new Set(row.sides);
      setDrafts((d) => strip(d.filter((_, idx) => idx !== i), mine));
      onChange([...strip(plan, mine), row]);
    } else {
      setDrafts((d) => d.map((r, idx) => (idx === i ? row : r)));
    }
  };

  const covered = new Set([...plan, ...drafts].flatMap((r) => r.sides));
  const uncovered = estimateSides.filter((s) => !covered.has(s));

  return (
    <div className="space-y-2">
      {plan.map((row, i) => (
        <ColorRow
          key={`saved-${i}`}
          row={row}
          statuses={statuses}
          colorOptions={colorOptions}
          estimateSides={estimateSides}
          elsewhere={claimedExcept({ saved: i })}
          onChange={(p) => setSaved(i, p)}
          onRemove={() => onChange(plan.filter((_, idx) => idx !== i))}
        />
      ))}
      {drafts.map((row, i) => (
        <ColorRow
          key={`draft-${i}`}
          row={row}
          statuses={statuses}
          colorOptions={colorOptions}
          estimateSides={estimateSides}
          elsewhere={claimedExcept({ draft: i })}
          isDraft
          onChange={(p) => setDraft(i, p)}
          onRemove={() => setDrafts((d) => d.filter((_, idx) => idx !== i))}
        />
      ))}
      {scopePhoto ? (
        <p className="flex items-start gap-1.5 rounded-xl border border-violet-200 bg-violet-50/60 px-2.5 py-2 text-xs text-violet-900">
          <Check className="mt-0.5 h-3 w-3 shrink-0" />
          <span><b>The scope photo shows which sides we're staining.</b> Just pick the colour. Tapping sides is optional.</span>
        </p>
      ) : null}
      {uncovered.length > 0 && !scopePhoto ? (
        <div className="flex flex-wrap items-center gap-1 rounded-xl border border-amber-200 bg-amber-50/60 px-2.5 py-2 text-xs text-amber-900">
          <AlertTriangle className="mr-0.5 h-3 w-3 shrink-0" />
          <span className="font-semibold">On the estimate, no colour yet:</span>
          {uncovered.map((s) => <Pill key={s} accent={ACCENT.amber}>{s}</Pill>)}
        </div>
      ) : null}
      <Button variant="outline" size="sm" className="h-10 w-full border-dashed"
              onClick={() => setDrafts((d) => [...d, { ...EMPTY_ROW }])}>
        <Plus className="mr-1 h-3.5 w-3.5" /> Add a part of the fence
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
                <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{it.hint}</span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default function CompanyCamTab({ leadId }: { leadId: string }) {
  const [data, setData] = useState<CompanyCamPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState<string>("");
  // The section the "Pick from our photos" sheet is adding to, if open.
  const [picking, setPicking] = useState<string | null>(null);
  // Management view or employee view (Alan, 2026-10-15): office staff can
  // flip to exactly what the crew sees. The crew only ever gets employee view.
  const canManage = canSeeRevenue();
  const [view, setViewState] = useState<"manager" | "employee">(() => {
    try { return localStorage.getItem("cc_view") === "employee" ? "employee" : "manager"; } catch { return "manager"; }
  });
  const setView = (v: "manager" | "employee") => { setViewState(v); try { localStorage.setItem("cc_view", v); } catch { /* private mode */ } };
  const manager = canManage && view === "manager";
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
    p: Partial<CompanyCamJob> & { upsells?: string[]; recalc_gallons?: boolean; pickets_marked?: boolean; extras_confirmed?: boolean; neighbor_send?: boolean; crew?: string[] },
  ) => {
    if (!data) return;
    // Optimistic, because a crew on bad signal should see their typing stick.
    setData((d) => (d ? { ...d, job: { ...d.job, ...p } as CompanyCamJob } : d));
    try {
      const r = await api.updateCompanyCam(leadId, p);
      setData((d) => (d ? { ...d, job: r.job, blockers: r.blockers } : d));
    } catch (e) {
      toast.error(errMessage(e, "Couldn't save"));
      void load();
    }
  };

  // The office changing the sides from here (Alan, 2026-10-15: "why doesn't
  // it let me add the outside left"). Saved on the lead with the estimate's.
  const saveSides = async (next: string[]) => {
    setData((d) => (d ? { ...d, estimate_sides: next } : d));
    try {
      const r = await api.updateCompanyCam(leadId, { fence_sides: next });
      setData((d) => (d ? { ...d, job: r.job, blockers: r.blockers, estimate_sides: r.estimate_sides ?? next } : d));
    } catch (e) {
      toast.error(errMessage(e, "Couldn't save the sides"));
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
    color_statuses, color_options, estimate_sides, cleaner_checklist, stainer_checklist,
    almost_done_default, cleaner_actions,
  } = data;
  const totalPhotos = Object.values(photos).reduce((n, arr) => n + arr.length, 0);
  const chosenStain = (data.stain_options || []).find((o) => o.id === job.final_stain_id)?.label || (job.final_stain_id ? job.final_color : "");
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

  const renderStep = (key: string) => {
    const sec = steps.find((x) => x.key === key);
    if (!sec) return null;

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
                "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold tabular-nums",
                list.length ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground",
              )}>
                {list.length ? <Check className="h-2.5 w-2.5" /> : null}
                {list.length} photo{list.length === 1 ? "" : "s"}
              </span>
            }
          >
            {manager || sec.key !== "fence_scope" ? <p className="text-xs leading-relaxed text-muted-foreground">{sec.hint}</p> : null}

            {sec.key === "fence_scope" && !manager && job.scope_explanation.trim() ? (
              <p className="whitespace-pre-wrap rounded-xl bg-violet-50 px-3 py-2.5 text-base">{job.scope_explanation}</p>
            ) : null}
            {sec.key === "fence_scope" && manager && !list.length ? (
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

            {/* The sides, the same map as the estimate, next to the scope photo
                so nobody can stain the wrong side (Alan, 2026-10-15). */}
            {sec.key === "fence_scope" ? (
              <div className="rounded-xl border border-violet-200 bg-violet-50/40 p-2.5">
                <p className="mb-1.5 text-sm font-bold">The sides we're staining</p>
                {manager ? (
                  <SidesPicker value={estimate_sides} onChange={(next) => void saveSides(next)} />
                ) : estimate_sides.length ? (
                  <SidesPicker value={estimate_sides} readOnly />
                ) : (
                  <p className="text-xs text-muted-foreground">No sides on the estimate yet.</p>
                )}
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {manager
                    ? "Tap a side to add or remove it. Saved for this customer (the Estimate tab shows the same sides). Front faces the street."
                    : "Coloured = we stain it. Crossed out = don't touch it. Front faces the street."}
                </p>
              </div>
            ) : null}

            {sec.key === "fence_scope" ? (
              <div className="rounded-xl border border-violet-200 bg-violet-50/40 p-2.5">
                <p className="text-sm font-bold">Has this fence been stained before?</p>
                <p className="text-xs text-muted-foreground">
                  The customer said: <b className="text-foreground">{data.customer_previously_stained || "nothing"}</b>
                  {job.previously_stained ? " · ✓ confirmed" : manager ? " · tap to confirm" : ""}
                </p>
                {manager ? (
                  <div className="mt-1.5 flex gap-1.5">
                    {([["no", "Not stained before"], ["yes", "Stained before"]] as const).map(([v, label]) => (
                      <Button key={v} size="lg" variant={job.previously_stained === v ? "default" : "outline"}
                              onClick={() => void patch({ previously_stained: job.previously_stained === v ? "" : v })}
                              className="h-auto min-h-11 flex-1 whitespace-normal py-2 text-sm font-semibold leading-tight">
                        {job.previously_stained === v ? <Check className="mr-1 h-4 w-4" /> : null}{label}
                      </Button>
                    ))}
                  </div>
                ) : job.previously_stained ? (
                  <ReadValue>{job.previously_stained === "yes" ? "Stained before" : "Not stained before"}</ReadValue>
                ) : null}
              </div>
            ) : null}

            {/* Alan picks the scope photo; the crew only sees it (2026-10-15). */}
            {sec.key === "fence_scope" && manager ? (
              <Button variant="outline" size="lg" onClick={() => setPicking(sec.key)}
                      className="h-11 w-full border-violet-300 text-violet-800 hover:bg-violet-50 sm:w-auto">
                <Images className="mr-1.5 h-4 w-4" /> Pick from our photos
              </Button>
            ) : null}

            {/* The crew's scope: just the picture, big, nothing to fill in. */}
            {sec.key === "fence_scope" && !manager ? (
              list.length ? (
                <div className="space-y-2">
                  {list.map((p) => <PhotoCard key={p.id} leadId={leadId} photo={p} bare onPatch={() => {}} onDelete={() => {}} />)}
                </div>
              ) : !job.scope_explanation.trim() ? (
                <p className="rounded-xl bg-muted/50 px-3 py-3 text-sm text-muted-foreground">The office hasn't added the scope yet. Call the office before you start.</p>
              ) : null
            ) : list.length ? (
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
                <span className="text-xs">{sec.who}</span>
              </button>
            )}

            {/* The cleaner checks the wood on arrival (Alan, 2026-10-15): pine
                and cedar take stain differently, so it goes in the coverage file. */}
            {sec.key === "clean_before" ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-2.5">
                <p className="text-sm font-bold">Cleaner: what's the fence made of?</p>
                <div className="mt-1.5 flex gap-1.5">
                  {([["pine", "Pine"], ["cedar", "Cedar"], ["other", "Something else"]] as const).map(([v, label]) => (
                    <Button key={v} size="lg" variant={job.wood_type === v ? "default" : "outline"}
                            onClick={() => void patch({ wood_type: job.wood_type === v ? "" : v })}
                            className="h-auto min-h-11 flex-1 whitespace-normal py-2 text-sm font-semibold leading-tight">
                      {job.wood_type === v ? <Check className="mr-1 h-4 w-4" /> : null}{label}
                    </Button>
                  ))}
                </div>
                {!job.wood_type ? <p className="mt-1 text-xs text-muted-foreground">Not sure? Cedar is reddish and smells like cedar. Pine is pale yellow-white.</p> : null}
              </div>
            ) : null}

            {sec.key === "clean_after" ? (
              <>
                <StatTile icon={Sparkles} label="Bleach gallons used" accent={ACCENT.cyan}>
                  <Input key={job.bleach_gallons_used} type="number" inputMode="decimal" step="0.5" placeholder="Gallons"
                         defaultValue={job.bleach_gallons_used || ""}
                         className="h-11 text-base font-semibold tabular-nums"
                         onBlur={(e) => {
                           const v = parseFloat(e.target.value || "0");
                           if (v !== job.bleach_gallons_used) void patch({ bleach_gallons_used: v });
                         }} />
                </StatTile>
                <div className="flex items-center justify-between gap-2 pt-1">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
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
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
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
  };

  return (
    <div className="space-y-3.5">
      {canManage ? (
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-xl bg-muted p-1" role="tablist" aria-label="View">
            {(["manager", "employee"] as const).map((v) => (
              <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}
                      className={cn("h-9 whitespace-nowrap rounded-lg px-3 text-sm font-semibold transition",
                        view === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                {v === "manager" ? "Management" : "Employee"}
              </button>
            ))}
          </div>
          {view === "employee" ? <span className="text-xs text-muted-foreground">Exactly what the crew sees.</span> : null}
        </div>
      ) : null}

      {/* Who's on this job (Alan, 2026-10-16): the crew sees only the jobs
          they're on, nothing else, even by searching. */}
      {manager ? (
        <div className="rounded-2xl border border-border bg-card p-3">
          <p className="text-sm font-bold">Who's on this job?</p>
          <p className="text-xs text-muted-foreground">They'll see this customer on their Company Cam. Crew only see the jobs they're on.</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(data.crew_options || []).map((c) => {
              const on = (job.crew || []).some((x) => x.toLowerCase() === c.username.toLowerCase());
              return (
                <button key={c.username} type="button"
                        onClick={() => void patch({ crew: on ? (job.crew || []).filter((x) => x.toLowerCase() !== c.username.toLowerCase()) : [...(job.crew || []), c.username] })}
                        className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold ring-1",
                          on ? "bg-emerald-600 text-white ring-emerald-600" : "bg-background ring-border hover:bg-muted")}>
                  {on ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}{c.name}
                </button>
              );
            })}
            {!(data.crew_options || []).length ? <p className="text-xs text-muted-foreground">No crew accounts yet. Make one in Settings → Permissions.</p> : null}
          </div>
        </div>
      ) : null}

      {/* Who, where, and how much of the job is on file. */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-indigo-950 p-4 text-white ring-1 ring-white/10 sm:p-5">
        <div className="pointer-events-none absolute -right-16 -top-24 h-56 w-56 rounded-full bg-indigo-500/25 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -left-12 h-56 w-56 rounded-full bg-emerald-500/15 blur-3xl" />

        <div className="relative flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-white/50">
              Company Cam
            </p>
            <h2 className="font-heading truncate text-xl font-semibold sm:text-2xl">
              {customer.name || "This job"}
            </h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/70">
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
        <div className="relative mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
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
                <span className="block truncate text-xs font-semibold leading-tight">
                  {s.label}
                </span>
                <span className="block text-xs text-white/50">
                  {s.n ? `${s.n} photo${s.n === 1 ? "" : "s"}`
                       : s.written ? "written out" : "nothing yet"}
                </span>
              </span>
            </button>
          ))}
        </div>

        <p className="relative mt-3 text-xs text-white/55">
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

      {/* The job card (Alan, 2026-10-15): the real footage, the gallons the
          crew actually used, the package and the fence's age. Together they
          teach us what a gallon covers on each kind of fence. No price: the
          crew works from this screen. */}
      <Panel icon={Droplets} accent={ACCENT.blue} title="The job"
             sub="What we're doing and what to bring">
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          <StatTile icon={Ruler} label="Square footage" accent={ACCENT.blue}
                    hint={!manager ? undefined : job.sqft_edited ? "✓ Set for this job" : "From the latest sent estimate. Pick one below or type it."}>
            {manager ? (<>
            <Input key={job.sqft} type="number" inputMode="decimal" defaultValue={job.sqft || ""}
                   className="h-10 text-base font-semibold tabular-nums"
                   onBlur={(e) => {
                     const v = parseFloat(e.target.value || "0");
                     if (v !== job.sqft) void patch({ sqft: v });
                   }} />
            <FootageChoices sqft={job.sqft} estimates={data.estimate_options || []} measure={data.measure_options}
                            onPick={(v) => void patch({ sqft: v })} />
            </>) : <ReadValue>{job.sqft ? `${Math.round(job.sqft).toLocaleString()} sq ft` : "Not set yet"}</ReadValue>}
          </StatTile>

          <StatTile icon={Droplets} label="Gallons of stain to bring" accent={ACCENT.cyan}
                    hint={!manager ? undefined : job.gallons_edited
                      ? "Typed in by hand, not following the footage"
                      : `Square footage ÷ ${job.sqft_per_gallon}, rounded up${job.sqft_per_gallon === 175 ? " (solid stain goes further)" : ""}`}>
            {manager ? <div className="flex gap-1.5">
              <Input key={job.gallons_needed} type="number" inputMode="decimal" step="0.5" defaultValue={job.gallons_needed || ""}
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
            </div> : <ReadValue>{job.gallons_needed ? `${job.gallons_needed} gallons` : "Not set yet"}</ReadValue>}
          </StatTile>

          <StatTile icon={Sparkles} label="Gallons of bleach to bring" accent={ACCENT.cyan}
                    hint={manager ? "For the cleaner. Your call for this job." : "For the cleaner"}>
            {manager ? (
              <Input key={job.bleach_gallons_to_bring} type="number" inputMode="decimal" step="0.5" placeholder="Gallons"
                     defaultValue={job.bleach_gallons_to_bring || ""}
                     className="h-10 text-base font-semibold tabular-nums"
                     onBlur={(e) => {
                       const v = parseFloat(e.target.value || "0");
                       if (v !== (job.bleach_gallons_to_bring || 0)) void patch({ bleach_gallons_to_bring: v });
                     }} />
            ) : (
              <ReadValue>{job.bleach_gallons_to_bring ? `${job.bleach_gallons_to_bring} gallons` : "Not set yet"}</ReadValue>
            )}
          </StatTile>

          <StatTile icon={Package} label="Package" accent={ACCENT.violet}
                    hint={!manager ? undefined : job.package ? "From what they paid the deposit on, or picked here" : "Tap the one they bought"}>
            {!manager ? <ReadValue>{job.package ? job.package[0].toUpperCase() + job.package.slice(1) : "Not set yet"}</ReadValue> : <div className="flex gap-1">
              {PACKAGES.map((p) => (
                <Button key={p} size="sm"
                        variant={job.package === p ? "default" : "outline"}
                        onClick={() => void patch({ package: job.package === p ? "" : p })}
                        className="h-10 flex-1 text-xs font-semibold capitalize">
                  {p}
                </Button>
              ))}
            </div>}
          </StatTile>

          <StatTile icon={Hourglass} label="Age of the fence" accent={ACCENT.amber}
                    hint="From the estimate">
            <p className="flex h-10 items-center text-base font-semibold">{ageLabel(data.fence_age)}</p>
          </StatTile>

          <StatTile icon={Palette} label="Stain they went with" accent={ACCENT.fuchsia}
                    hint={manager ? "From Stain Inventory. Type to search." : undefined}>
            {manager ? (
              <StainPicker options={data.stain_options || []} value={job.final_stain_id}
                           onPick={(id) => void patch({ final_stain_id: id })} onAdded={() => void load()} />
            ) : (
              <ReadValue>{(data.stain_options || []).find((o) => o.id === job.final_stain_id)?.label || job.final_color || "Not picked yet"}</ReadValue>
            )}
          </StatTile>
        </div>
        <WhatToBring job={job} stain={chosenStain} />
      </Panel>

      {/* Repairs (Alan, 2026-10-15): the office counts them; the crew sees them
          only when there are some, without prices. */}
      <RepairsPanel job={job} manager={manager} onPatch={(p) => void patch(p)} />

      {/* Colour, per area. Drives what the cleaner has to settle on site. */}
      <Panel icon={Palette} accent={ACCENT.fuchsia}
             title="Stain colour"
             sub="What they chose, and where it goes">
        {/* One stain, picked once, always with brand and opacity: a colour
            name alone exists in other brands and opacities (Alan, 2026-10-15).
            Same field as "Stain they went with" in The job. */}
        <Field label="What stain did they choose?"
               hint={manager ? "Colour, brand and opacity, from Stain Inventory. Still deciding? Leave it and use the rows below." : undefined}>
          {manager ? (
            <StainPicker options={data.stain_options || []} value={job.final_stain_id}
                         onPick={(id) => void patch({ final_stain_id: id })} onAdded={() => void load()} />
          ) : (
            <ReadValue>{chosenStain || "Not chosen yet"}</ReadValue>
          )}
        </Field>

        {chosenStain ? (
          <div className="space-y-2 rounded-xl border border-fuchsia-200 bg-fuchsia-50/40 p-2.5">
            {manager || !job.color_all_sides ? (
              <p className="text-sm font-bold">Does {chosenStain} go on every side in the fence scope?</p>
            ) : null}
            {manager ? (
              <div className="flex gap-1.5">
                {([["yes", "Yes, every side"], ["no", "No, some are different"]] as const).map(([v, label]) => (
                  <Button key={v} size="lg" variant={job.color_all_sides === v ? "default" : "outline"}
                          onClick={() => void patch({ color_all_sides: job.color_all_sides === v ? "" : v })}
                          className="h-auto min-h-11 flex-1 whitespace-normal py-2 text-sm font-semibold leading-tight">
                    {job.color_all_sides === v ? <Check className="mr-1 h-4 w-4" /> : null}{label}
                  </Button>
                ))}
              </div>
            ) : null}
            {job.color_all_sides === "yes" ? (
              <p className="flex items-start gap-1.5 text-sm font-semibold text-emerald-800"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> {chosenStain} on every side in the fence scope. Nothing else to settle.</p>
            ) : job.color_all_sides === "no" ? (
              <p className="text-xs text-muted-foreground">{manager ? "Add a row for each part that gets a different stain, and tap its sides." : `${chosenStain}, except the parts below.`}</p>
            ) : null}
          </div>
        ) : null}

        {!chosenStain || job.color_all_sides === "no" ? (
          <>
            {!chosenStain ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                Not settled yet? A row per part of the fence: where the customer is, and the stains they're between.
              </p>
            ) : null}
            <ColorPlan
              plan={job.color_plan}
              statuses={color_statuses}
              colorOptions={color_options}
              estimateSides={estimate_sides}
              scopePhoto={(photos.fence_scope || []).length > 0}
              onChange={(next) => void patch({ color_plan: next })}
            />
          </>
        ) : null}

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

        {/* Shown once is enough (Alan, 2026-10-16): when the office already
            settled it with the customer, the crew is told not to show it again. */}
        {job.color_shown_at ? (
          <p className="flex items-start gap-1.5 rounded-xl bg-emerald-50 px-3 py-2.5 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-200">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            Confirmed with the customer by {job.color_shown_by || "the office"}. No need to show it to them again.
          </p>
        ) : (
          <Button size="lg" variant="outline" className="h-auto min-h-11 w-full whitespace-normal py-2 sm:w-auto"
                  title={manager ? "You already settled the colour with them: the crew won't need to show it" : "Mark that you showed the customer the colour"}
                  onClick={async () => {
                    try {
                      const r = await api.markCompanyCamColorShown(leadId);
                      setData((d) => (d ? { ...d, job: r.job } : d));
                      toast.success(manager ? "Marked: the colour's confirmed, the crew won't show it" : "Logged: colour shown to the customer");
                    } catch (e) { toast.error(errMessage(e, "Couldn't save")); }
                  }}>
            <Palette className="mr-1.5 h-4 w-4" />
            {manager ? "Already confirmed with the customer (no need to show it)" : "I showed them the colour"}
          </Button>
        )}
      </Panel>

      {/* The office's part first, then the cleaner's and the stainer's, each
          boxed together so each person sees their part as one (Alan, 2026-10-16). */}
      {renderStep("fence_scope")}
      <RoleGroup who="cleaner">
        {renderStep("clean_before")}
        {renderStep("clean_after")}
      </RoleGroup>
      <RoleGroup who="stainer">
        {renderStep("stain_before")}
        {renderStep("stain_after")}

      {/* Almost finished — catch the customer while the crew is still there.
          Either they're home and the crew walks it with them, or the crew
          texts them from their own phone: the crew can't see GHL, so nothing
          sends from here (Alan, 2026-10-15). */}
      <Panel icon={MessageSquare} accent={ACCENT.cyan}
             title="20–30 minutes from finishing"
             sub="Show the customer before you pack up">
        {job.almost_done_sent_at ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-emerald-300 bg-gradient-to-r from-emerald-50 to-teal-50 p-3">
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-900">
              <CheckCircle2 className="h-4 w-4" />
              {job.almost_done_how === "walked" ? "Walked it with the customer" : job.almost_done_how === "texted" ? "Texted the customer" : "Sent"}
            </span>
            <span className="text-xs text-emerald-800">
              {new Date(job.almost_done_sent_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              {job.almost_done_sent_by ? ` by ${job.almost_done_sent_by}` : ""}
            </span>
            <Button variant="outline" size="sm" className="ml-auto h-8"
                    onClick={async () => {
                      if (!confirm("Undo this? Only if it was tapped by mistake or there's a second visit.")) return;
                      try {
                        const r = await api.resetCompanyCamAlmostDone(leadId);
                        setData((d) => (d ? { ...d, job: r.job } : d));
                      } catch (e) { toast.error(errMessage(e, "Couldn't reset")); }
                    }}>
              <RotateCcw className="mr-1 h-3.5 w-3.5" /> Undo
            </Button>
          </div>
        ) : (
          <AlmostDone text={almostDoneText} defaultText={almost_done_default} onText={setAlmostDoneText}
                      phone={customer.phone} blocked={customer.do_not_contact}
                      onMark={async (how) => {
                        try {
                          const r = await api.markCompanyCamAlmostDone(leadId, how);
                          setData((d) => (d ? { ...d, job: r.job } : d));
                          toast.success(how === "walked" ? "Marked: walked it with them" : "Marked: texted them");
                        } catch (e) { toast.error(errMessage(e, "Couldn't save")); }
                      }} />
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
             sub="The crew fills this in before they leave">
        <div className="grid gap-2.5 sm:grid-cols-3">
          <StatTile icon={Droplets} label="Gallons of stain used" accent={ACCENT.emerald}
                    hint={job.stain_gallons_used ? "✓ Recorded" : `Brought about ${job.gallons_needed || "?"}`}>
            <Input type="number" inputMode="decimal" step="0.5" placeholder="Gallons"
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
          <StatTile icon={Sparkles} label="Bleach gallons used" accent={ACCENT.cyan} hint="The cleaner fills this in under After cleaning">
            <ReadValue>{job.bleach_gallons_used ? `${job.bleach_gallons_used} gallons` : "Not yet"}</ReadValue>
          </StatTile>
        </div>
        <Coverage sqft={job.sqft} gallons={job.stain_gallons_used} age={data.fence_age} stats={data.coverage}
                  stain={(data.stain_options || []).find((o) => o.id === job.final_stain_id)?.label} wood={job.wood_type} />
      </Panel>

      </RoleGroup>

      {/* Neighbours and friends — the cheapest lead there is. Made so simple
          it can't go wrong (Alan, 2026-10-16): one question, three answers. */}
      <Panel icon={Users} accent={ACCENT.rose}
             title="Any neighbour or friend interested?"
             sub="Ask the customer before you leave">
        <p className="text-sm font-semibold">Does anyone else want a quote? A neighbour, a friend, family?</p>
        <div className="grid gap-2">
          {([
            ["none", "No one"],
            ["details", "Yes, and I got their name and number"],
            ["no_details", "Yes, but I didn't get their info"],
          ] as const).map(([v, label]) => (
            <Button key={v} size="lg" variant={(job.neighbor_status || "") === v ? "default" : "outline"}
                    className={cn("h-auto min-h-12 w-full justify-start whitespace-normal py-2.5 text-left text-base font-semibold",
                      (job.neighbor_status || "") === v && v !== "none" && "bg-gradient-to-r from-rose-600 to-pink-600 hover:from-rose-600 hover:to-pink-700")}
                    onClick={() => void patch({ neighbor_status: job.neighbor_status === v ? "" : v })}>
              {(job.neighbor_status || "") === v ? <CheckCircle2 className="mr-2 h-5 w-5 shrink-0" /> : <span className="mr-2 h-5 w-5 shrink-0 rounded-full border-2 border-current opacity-40" />}
              {label}
            </Button>
          ))}
        </div>
        {job.neighbor_status === "no_details" ? (
          <p className="flex items-start gap-1.5 rounded-xl bg-emerald-50 px-3 py-2.5 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-200">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> Alan's been told. He'll call the customer to find out who. Nothing else to do.
          </p>
        ) : null}
        {job.neighbor_status === "details" ? (
          <div className="space-y-3 rounded-xl border border-rose-200 bg-rose-50/40 p-3">
            <div className="grid gap-2.5 sm:grid-cols-2">
              <Field label="Their name">
                <BlurText value={job.neighbor_first_name} placeholder="First name"
                          onSave={(v) => void patch({ neighbor_first_name: v })} />
              </Field>
              <Field label="Last name (if they gave it)">
                <BlurText value={job.neighbor_last_name} placeholder="Last name"
                          onSave={(v) => void patch({ neighbor_last_name: v })} />
              </Field>
              <Field label="Phone number">
                <BlurText value={job.neighbor_phone} placeholder="(713) 555-0101"
                          onSave={(v) => void patch({ neighbor_phone: v })} />
              </Field>
              <Field label="What do they want done?">
                <BlurText value={job.neighbor_project}
                          placeholder="e.g. their back fence"
                          onSave={(v) => void patch({ neighbor_project: v })} />
              </Field>
            </div>
            <Field label="Anything else (optional)" hint="Which house, best time to call.">
              <BlurText rows={2} value={job.neighbor_notes}
                        placeholder="e.g. House to the left. Call after 5."
                        onSave={(v) => void patch({ neighbor_notes: v })} />
            </Field>
            {job.neighbor_sent_at ? (
              <p className="flex items-start gap-1.5 text-sm font-semibold text-emerald-800">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> Sent to Alan. He'll take it from here.
              </p>
            ) : (
              <Button size="lg" className="h-12 w-full text-base font-semibold"
                      onClick={() => {
                        // A note still being typed saves on blur; give it a beat.
                        (document.activeElement as HTMLElement | null)?.blur?.();
                        setTimeout(() => void patch({ neighbor_send: true }), 350);
                      }}>
                <Send className="mr-1.5 h-4 w-4" /> Send to Alan
              </Button>
            )}
          </div>
        ) : null}
      </Panel>
      {picking ? (
        <LibraryPicker leadId={leadId} section={picking} onClose={() => setPicking(null)} onAdded={() => void load()} />
      ) : null}
    </div>
  );
}

/** "6-15 years" reads as "6-15 years old"; nothing said reads as such. */
function ageLabel(v?: string) {
  const t = (v || "").trim();
  if (!t) return "They didn't say";
  if (/new/i.test(t)) return "Brand new";
  if (/not sure/i.test(t)) return "Not sure";
  return /old$/i.test(t) ? t : `${t} old`;
}

/** What a gallon covered on this job, next to our average overall and on
 *  fences this old. Each job with gallons recorded adds to the averages. */
function Coverage({ sqft, gallons, age, stats, stain, wood }: {
  sqft: number; gallons: number; age?: string; stats?: CoverageStats; stain?: string; wood?: string;
}) {
  const rate = sqft > 0 && gallons > 0 ? Math.round(sqft / gallons) : null;
  return (
    <div className="mt-2.5 rounded-xl bg-muted/50 px-3 py-2.5 text-sm">
      {rate ? (
        <p><b className="tabular-nums">{Math.round(sqft).toLocaleString()} sq ft ÷ {gallons} gallons = {rate} sq ft a gallon</b> on this job.</p>
      ) : (
        <p className="text-muted-foreground">Put in the square footage and the gallons used, and this shows how far a gallon went.</p>
      )}
      {stain && stats?.match_jobs ? (
        <p className="mt-0.5 text-xs font-semibold tabular-nums">
          {stain}{wood ? `, ${wood}` : ""}, {ageLabel(age).toLowerCase()}: {stats.match_avg} sq ft a gallon over {stats.match_jobs} {stats.match_jobs === 1 ? "job" : "jobs"}
        </p>
      ) : null}
      {!stain && rate ? <p className="mt-0.5 text-xs text-amber-700">Pick the stain they went with in The job, so this counts in the coverage file.</p> : null}
      {stats && stats.all_jobs > 0 ? (
        <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
          Our average: {stats.all_avg} sq ft a gallon over {stats.all_jobs} {stats.all_jobs === 1 ? "job" : "jobs"}
          {age && stats.age_jobs > 0 ? ` · on ${ageLabel(age).toLowerCase()} fences: ${stats.age_avg} (${stats.age_jobs} ${stats.age_jobs === 1 ? "job" : "jobs"})` : ""}
        </p>
      ) : null}
    </div>
  );
}

/** Every picture we already hold for this customer, to drop into a section
 *  instead of taking a new one (Alan, 2026-10-15: "pull them all"). */
function LibraryPicker({ leadId, section, onClose, onAdded }: {
  leadId: string; section: string; onClose: () => void; onAdded: () => void;
}) {
  const [items, setItems] = useState<{ key: string; label: string; group: string }[] | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    api.getCompanyCamLibrary(leadId).then(setItems).catch(() => setItems([]));
  }, [leadId]);
  const add = async (key: string) => {
    setBusy(key);
    try {
      await api.addCompanyCamFromLibrary(leadId, key, section);
      setAdded((a) => [...a, key]);
      onAdded();
      toast.success("Added");
    } catch (e) { toast.error(errMessage(e, "Couldn't add it")); }
    finally { setBusy(null); }
  };
  const groups = [...new Set((items || []).map((i) => i.group))];
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center" onClick={onClose}>
      <div className="max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl bg-background p-4 shadow-2xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2">
          <p className="font-heading text-lg font-bold">Pick from our photos</p>
          <button type="button" onClick={onClose} className="rounded-full p-2 hover:bg-muted" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        <p className="text-xs text-muted-foreground">Tap a picture to add it. Tap as many as you want.</p>
        {items === null ? (
          <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
        ) : !items.length ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No pictures on file for this customer yet. Draw the fence scope or use Measure &amp; capture first.</p>
        ) : groups.map((g) => (
          <div key={g} className="mt-3">
            <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{g}</p>
            <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {items.filter((i) => i.group === g).map((i) => (
                <LibraryThumb key={i.key} leadId={leadId} item={i} added={added.includes(i.key)} busy={busy === i.key} onPick={() => void add(i.key)} />
              ))}
            </div>
          </div>
        ))}
        <Button size="lg" className="mt-4 h-11 w-full" onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}

function LibraryThumb({ leadId, item, added, busy, onPick }: {
  leadId: string; item: { key: string; label: string }; added: boolean; busy: boolean; onPick: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let live = true;
    api.fetchCompanyCamLibraryImage(leadId, item.key).then((u) => { url = u; if (live) setSrc(u); });
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [leadId, item.key]);
  return (
    <button type="button" onClick={onPick} disabled={busy}
            className={cn("relative overflow-hidden rounded-xl text-left ring-2 transition active:scale-[0.98]", added ? "ring-emerald-500" : "ring-border hover:ring-violet-400")}>
      <span className="block aspect-[4/3] bg-muted">
        {src ? <img src={src} alt="" className="h-full w-full object-cover" /> : <span className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></span>}
      </span>
      <span className="block px-2 py-1.5 text-xs font-semibold">{item.label}</span>
      {added || busy ? (
        <span className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-emerald-600 text-white shadow">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
        </span>
      ) : null}
    </button>
  );
}

const HEIGHTS = [6, 6.5, 7, 8];

/** Where the job's footage can come from (Alan, 2026-10-15): each estimate,
 *  sent or only saved, and the Measure & capture feet × a height he taps. */
function FootageChoices({ sqft, estimates, measure, onPick }: {
  sqft: number;
  estimates: { id: string; sent: boolean; when: string; sqft: number; linear_feet: number | null; height: string }[];
  measure?: { captures: { id: string; label: string; linear_feet: number }[]; height_ft: number };
  onPick: (sqft: number) => void;
}) {
  const [height, setHeight] = useState(measure?.height_ft || 6);
  const captures = measure?.captures || [];
  const totalFt = captures.reduce((t, c) => t + c.linear_feet, 0);
  const chip = (on: boolean) => cn("min-h-10 rounded-full px-3 py-2 text-left text-xs font-semibold tabular-nums ring-1",
    on ? "bg-blue-600 text-white ring-blue-600" : "bg-background ring-border hover:bg-muted");
  const day = (iso: string) => (iso ? new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" }) : "");
  const n = estimates.length;
  // Only sent estimates get a number, oldest first: the customer saw 1, 2, 3.
  const sentNo: Record<string, number> = {};
  estimates.filter((o) => o.sent).reverse().forEach((o, i) => { sentNo[o.id] = i + 1; });
  return (
    <div className="mt-1.5 space-y-1.5">
      {n ? (
        <div className="flex flex-wrap gap-1">
          {estimates.map((o, i) => (
            <button key={o.id} type="button" onClick={() => onPick(o.sqft)} className={chip(Math.round(sqft) === o.sqft)}
                    title={o.linear_feet ? `${o.linear_feet} ft × ${o.height}` : undefined}>
              {o.sent ? `Estimate ${sentNo[o.id]} · sent ${day(o.when)}` : `Not sent · saved ${day(o.when)}`} · {o.sqft.toLocaleString()} sq ft{i === 0 ? " · newest" : ""}
            </button>
          ))}
        </div>
      ) : null}
      {captures.length ? (
        <div className="rounded-lg bg-muted/50 p-1.5">
          <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Measure &amp; capture × fence height</p>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {HEIGHTS.map((h) => (
              <button key={h} type="button" onClick={() => setHeight(h)}
                      className={cn("h-10 min-w-12 rounded-lg px-3 text-sm font-bold ring-1", height === h ? "bg-foreground text-background ring-foreground" : "bg-background ring-border")}>
                {h} ft
              </button>
            ))}
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {captures.map((c) => {
              const v = Math.round(c.linear_feet * height);
              return (
                <button key={c.id} type="button" onClick={() => onPick(v)} className={chip(Math.round(sqft) === v)}>
                  {c.label} · {c.linear_feet} ft × {height} ft = {v.toLocaleString()} sq ft
                </button>
              );
            })}
            {captures.length > 1 ? (
              <button type="button" onClick={() => onPick(Math.round(totalFt * height))} className={chip(Math.round(sqft) === Math.round(totalFt * height))}>
                All photos · {totalFt} ft × {height} ft = {Math.round(totalFt * height).toLocaleString()} sq ft
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A number the crew reads but doesn't change (employee view). */
function ReadValue({ children }: { children: React.ReactNode }) {
  return <p className="flex h-10 items-center text-base font-semibold tabular-nums">{children}</p>;
}

/** Search Stain Inventory and pick the stain they went with. */
function StainPicker({ options, value, onPick, onAdded }: { options: StainOption[]; value: string; onPick: (id: string) => void; onAdded?: () => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  // A stain we've never used (Alan, 2026-10-16: "Whiteout"): add it to Stain
  // Inventory right here, with its brand and opacity, then it's picked.
  const [adding, setAdding] = useState<{ name: string; brand: string; finish: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const brands = [...new Set(options.map((o) => o.brand).filter(Boolean))].sort();
  const addNew = async () => {
    if (!adding) return;
    if (!adding.name.trim() || !adding.brand.trim() || !adding.finish) { toast.error("Fill in the name, brand and opacity"); return; }
    setSaving(true);
    try {
      const made = await api.createStain({ brand: adding.brand.trim(), finish_type: adding.finish, color_name: adding.name.trim(), gallons: 0, note: "Added from Company Cam" });
      onPick(made.id);
      onAdded?.();
      toast.success(`${made.color_name} added to Stain Inventory`);
      setAdding(null); setOpen(false);
    } catch (e) { toast.error(errMessage(e, "Couldn't add the stain")); }
    finally { setSaving(false); }
  };
  const picked = options.find((o) => o.id === value);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = options.filter((o) => words.every((w) => o.label.toLowerCase().includes(w))).slice(0, 40);
  if (!open) {
    return (
      <button type="button" onClick={() => { setOpen(true); setQ(""); }}
              className={cn("flex h-10 w-full items-center justify-between gap-2 rounded-lg border px-3 text-left text-sm font-semibold",
                picked ? "border-input bg-background" : "border-dashed border-input bg-muted/30 text-muted-foreground")}>
        <span className="truncate">{picked ? picked.label : "Pick the stain…"}</span>
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
    );
  }
  return (
    <div className="space-y-1">
      <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="October Brown, Valspar, solid…" className="h-10 text-base sm:text-sm"
             onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }} />
      <div className="max-h-56 overflow-y-auto rounded-lg border border-border bg-background">
        {hits.length ? hits.map((o) => (
          <button key={o.id} type="button" onClick={() => { onPick(o.id); setOpen(false); }}
                  className={cn("flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-muted", o.id === value && "bg-muted font-semibold")}>
            {o.id === value ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
            <span className="truncate">{o.label}</span>
            {!o.active ? <span className="ml-auto shrink-0 text-xs text-muted-foreground">off the shelf</span> : null}
          </button>
        )) : <p className="px-3 py-2 text-xs text-muted-foreground">No stain matches.</p>}
      </div>
      {adding ? (
        <div className="space-y-2 rounded-lg border border-fuchsia-200 bg-fuchsia-50/50 p-2.5">
          <p className="text-sm font-bold">New stain for Stain Inventory</p>
          <Input value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} placeholder="Stain name, e.g. Whiteout" className="h-10 text-base sm:text-sm" />
          <Input value={adding.brand} onChange={(e) => setAdding({ ...adding, brand: e.target.value })} placeholder="Brand, e.g. Valspar" list="cc-brands" className="h-10 text-base sm:text-sm" />
          <datalist id="cc-brands">{brands.map((b) => <option key={b} value={b} />)}</datalist>
          <div className="flex flex-wrap gap-1">
            {STAIN_FINISH_TYPES.map((f) => (
              <button key={f.value} type="button" onClick={() => setAdding({ ...adding, finish: f.value })}
                      className={cn("min-h-10 rounded-lg px-3 text-sm font-semibold ring-1", adding.finish === f.value ? "bg-foreground text-background ring-foreground" : "bg-background ring-border")}>
                {f.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <Button size="lg" className="h-11 flex-1" disabled={saving} onClick={() => void addNew()}>
              {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />} Add and pick it
            </Button>
            <Button size="lg" variant="outline" className="h-11" onClick={() => setAdding(null)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" size="lg" className="h-11 w-full border-dashed"
                onClick={() => setAdding({ name: q.trim().replace(/\b\w/g, (c) => c.toUpperCase()), brand: "", finish: "" })}>
          <Plus className="mr-1.5 h-4 w-4" /> {q.trim() && !hits.length ? `Add "${q.trim()}" as a new stain` : "Add a stain we've never used"}
        </Button>
      )}
      <div className="flex justify-between">
        {value ? <button type="button" onClick={() => { onPick(""); setOpen(false); }} className="min-h-10 px-1 text-sm font-semibold text-muted-foreground underline">Clear</button> : <span />}
        <button type="button" onClick={() => setOpen(false)} className="min-h-10 px-1 text-sm font-semibold text-muted-foreground underline">Cancel</button>
      </div>
    </div>
  );
}

/** Customer home: walk it with them. Not home: copy the text into your own
 *  phone and send it yourself, then say so. */
function AlmostDone({ text, defaultText, onText, phone, blocked, onMark }: {
  text: string; defaultText: string; onText: (t: string) => void; phone: string; blocked: boolean;
  onMark: (how: "walked" | "texted") => void;
}) {
  const [mode, setMode] = useState<"" | "text">("");
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); toast.success("Copied. Paste it into your text to the customer."); }
    catch { toast.error("Couldn't copy. Press and hold the text to copy it."); }
  };
  const sms = phone ? `sms:${phone}${/iPhone|iPad|Mac/.test(navigator.userAgent) ? "&" : "?"}body=${encodeURIComponent(text)}` : "";
  if (!mode) {
    return (
      <div className="grid gap-2 sm:grid-cols-2">
        <Button size="lg" className="h-auto min-h-14 flex-col gap-0.5 bg-gradient-to-r from-emerald-600 to-teal-600 py-2.5 text-base font-semibold hover:from-emerald-600 hover:to-teal-700"
                onClick={() => onMark("walked")}>
          <span className="flex items-center gap-1.5"><Users className="h-4 w-4" /> The customer's home</span>
          <span className="text-xs font-normal opacity-90">I'll walk the fence with them in person</span>
        </Button>
        <Button size="lg" variant="outline" className="h-auto min-h-14 flex-col gap-0.5 py-2.5 text-base font-semibold"
                disabled={blocked} onClick={() => setMode("text")}>
          <span className="flex items-center gap-1.5"><MessageSquare className="h-4 w-4" /> They're not home</span>
          <span className="text-xs font-normal text-muted-foreground">I'll text them from my phone</span>
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold">Copy this and text it to the customer from your phone{phone ? ` (${phone})` : ""}. You can change the words first.</p>
      <textarea value={text} onChange={(e) => onText(e.target.value)} rows={8}
                className="w-full resize-y rounded-xl border border-input bg-background px-3 py-2.5 text-base leading-relaxed shadow-sm outline-none focus:border-ring focus:ring-3 focus:ring-ring/30" />
      <div className="grid gap-2 sm:grid-cols-2">
        <Button size="lg" className="h-12 text-base font-semibold" onClick={() => void copy()}>
          {copied ? <Check className="mr-1.5 h-4 w-4" /> : null}{copied ? "Copied" : "1. Copy the text"}
        </Button>
        {sms ? (
          <a href={sms} className="inline-flex h-12 items-center justify-center rounded-md border border-input bg-background text-base font-semibold hover:bg-muted">
            <Phone className="mr-1.5 h-4 w-4" /> Or open my texts with it filled in
          </a>
        ) : null}
      </div>
      <Button size="lg" className="h-12 w-full bg-gradient-to-r from-cyan-600 to-sky-600 text-base font-semibold hover:from-cyan-600 hover:to-sky-700"
              onClick={() => onMark("texted")}>
        <CheckCircle2 className="mr-1.5 h-4 w-4" /> 2. I sent it
      </Button>
      <div className="flex justify-between">
        <button type="button" onClick={() => setMode("")} className="min-h-10 px-1 text-sm font-semibold text-muted-foreground underline">Back</button>
        {text !== defaultText ? <button type="button" onClick={() => onText(defaultText)} className="min-h-10 px-1 text-sm font-semibold text-muted-foreground underline">Reset wording</button> : null}
      </div>
    </div>
  );
}

type Repairs = { counts: Record<string, number>; picket_type: string; post_type: string };
const NO_REPAIRS: Repairs = { counts: {}, picket_type: "pine", post_type: "post6" };

function hasRepairs(job: CompanyCamJob) {
  return Object.values(job.repairs?.counts || {}).some((n) => n > 0) || !!(job.repair_notes || "").trim();
}

/** "15 pine pickets", "2 rot boards", "1 post (7 ft fence)": the crew's
 *  words, no prices. */
function repairWords(r: Repairs): string[] {
  const c = r.counts || {};
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const wood = (PICKETS.find((p) => p.key === r.picket_type) || PICKETS[0]).label.toLowerCase();
  const post = (POSTS.find((p) => p.key === r.post_type) || POSTS[0]).label;
  const out: string[] = [];
  if (c.pickets) out.push(plural(c.pickets, `${wood} picket`, `${wood} pickets`));
  if (c.rotboard) out.push(plural(c.rotboard, "rot board", "rot boards"));
  if (c.cap) out.push(plural(c.cap, "cap", "caps"));
  if (c.rail) out.push(plural(c.rail, "rail", "rails"));
  if (c.posts) out.push(`${plural(c.posts, "post", "posts")} (${post})`);
  return out;
}

/** What each person loads before driving out, split by who (Alan,
 *  2026-10-16). The cleaner: bleach, and spray paint when there are pickets
 *  to mark. The stainer: stain, every picket (planned + agreed on site), four
 *  screw nails a picket, a saw, and the office's repair note. */
function WhatToBring({ job, stain }: { job: CompanyCamJob; stain: string }) {
  const planned = job.repairs || NO_REPAIRS;
  const extras: Repairs = job.extras_confirmed_at ? (job.extras || NO_REPAIRS) : NO_REPAIRS;
  const sum: Repairs = { ...planned, counts: Object.fromEntries(["pickets", "rotboard", "cap", "rail", "posts"].map((k) => [k, (planned.counts[k] || 0) + (extras.counts[k] || 0)])) };
  const pickets = sum.counts.pickets || 0;
  const cleaner = [
    job.bleach_gallons_to_bring ? `${job.bleach_gallons_to_bring} gallons of bleach` : "",
    planned.counts.pickets ? "Spray paint, to mark the pickets with the customer" : "",
  ].filter(Boolean);
  const stainer = [
    job.gallons_needed ? `${job.gallons_needed} gallons of ${stain || "stain (colour not picked yet)"}` : "",
    ...repairWords(sum).map((w, i) => (i === 0 && pickets && extras.counts.pickets ? `${w} (${planned.counts.pickets || 0} planned + ${extras.counts.pickets} added on site)` : w)),
    pickets ? `${pickets * 4} screw nails (4 a picket)` : "",
    pickets || sum.counts.rotboard || sum.counts.cap || sum.counts.rail ? "A saw, to cut pickets and boards to size" : "",
  ].filter(Boolean);
  if (!cleaner.length && !stainer.length) return null;
  const list = (title: string, items: string[], tone: string, Icon: typeof Sparkles, extra?: React.ReactNode) => (
    <div className={cn("rounded-xl border px-3 py-2.5", tone)}>
      <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide"><Icon className="h-3.5 w-3.5" /> {title}</p>
      {items.length ? (
        <ul className="mt-1 space-y-0.5 text-sm font-semibold">
          {items.map((t) => <li key={t} className="flex items-start gap-1.5"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />{t}</li>)}
        </ul>
      ) : <p className="mt-1 text-sm text-muted-foreground">Nothing set yet.</p>}
      {extra}
    </div>
  );
  return (
    <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
      {list("The cleaner brings", cleaner, "border-sky-200 bg-sky-50/60 text-sky-950", Sparkles)}
      {list("The stainer brings", stainer, "border-emerald-200 bg-emerald-50/60 text-emerald-950", Paintbrush, <>
        {pickets && job.pickets_marked_at ? <p className="mt-1 text-xs">The pickets to replace are marked with spray paint.</p> : null}
        {(job.repair_notes || "").trim() ? (
          <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-white/70 px-2 py-1.5 text-xs text-foreground"><b>Repair note:</b> {job.repair_notes}</p>
        ) : null}
      </>)}
    </div>
  );
}

function RepairsPanel({ job, manager, onPatch }: {
  job: CompanyCamJob; manager: boolean;
  onPatch: (p: Partial<CompanyCamJob> & { pickets_marked?: boolean; extras_confirmed?: boolean }) => void;
}) {
  const r = job.repairs || NO_REPAIRS;
  const planned = hasRepairs(job);
  const set = (patch: Partial<Repairs>) => onPatch({ repairs: { ...r, ...patch, counts: { ...r.counts, ...(patch.counts || {}) } } });
  const bump = (key: string, d: number) => set({ counts: { [key]: Math.max(0, (r.counts[key] || 0) + d) } });
  const words = repairWords(r);
  const pickets = r.counts.pickets || 0;
  return (
    <Panel icon={Hammer} accent={ACCENT.amber} title="Repairs"
           sub={manager ? "Fill in what we're fixing. The crew sees it only if something's here." : planned ? "What we're fixing on this job" : "No repairs planned. Add any the customer asks for below."}>
      {manager ? (
        <div className="space-y-2">
          <Counter stack label="Pickets" what="The upright boards" unit="picket" price={(PICKETS.find((p) => p.key === r.picket_type) || PICKETS[0]).price}
                   art={<FencePart part="picket" />} n={pickets} onChange={(d) => bump("pickets", d)}>
            <Chips options={PICKETS} value={r.picket_type} onChange={(k) => set({ picket_type: k })} />
          </Counter>
          {PARTS.map((part) => (
            <Counter stack key={part.key} label={part.label} what={part.what} unit={part.unit} price={part.price}
                     art={<FencePart part={part.key as FencePartKey} />} n={r.counts[part.key] || 0} onChange={(d) => bump(part.key, d)} />
          ))}
          <Counter stack label="Post replacement" what="The thick posts set in the ground" unit="post" price={(POSTS.find((p) => p.key === r.post_type) || POSTS[0]).price}
                   art={<FencePart part="post" />} n={r.counts.posts || 0} onChange={(d) => bump("posts", d)}>
            <Chips options={POSTS} value={r.post_type} onChange={(k) => set({ post_type: k })} />
          </Counter>
          <Field label="Additional notes for the crew" hint="Only shows to the crew when you write something. e.g. a 2x4 on the back needs screwing back in.">
            <BlurText rows={3} value={job.repair_notes || ""} placeholder="Anything else to fix, and how…"
                      onSave={(v) => onPatch({ repair_notes: v })} />
          </Field>
        </div>
      ) : (
        <div className="space-y-2">
          {words.length ? (
            <ul className="space-y-1 rounded-xl bg-amber-50 px-3 py-2.5 ring-1 ring-amber-200">
              <li className="text-xs font-bold uppercase tracking-wide text-amber-900">Planned by the office</li>
              {words.map((w) => <li key={w} className="text-base font-bold">{w}</li>)}
            </ul>
          ) : null}
          {(job.repair_notes || "").trim() ? (
            <div className="rounded-xl bg-muted/50 px-3 py-2.5">
              <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">From the office</p>
              <p className="whitespace-pre-wrap text-sm">{job.repair_notes}</p>
            </div>
          ) : null}
        </div>
      )}
      {pickets > 0 ? (
        <div className={cn("rounded-xl border p-2.5", job.pickets_marked_at ? "border-emerald-300 bg-emerald-50" : "border-amber-300 bg-amber-50/60")}>
          <p className="text-sm font-bold">Cleaner: mark the {pickets} pickets with the customer</p>
          <p className="mt-0.5 text-xs leading-relaxed">
            Walk the fence with the customer and agree on exactly which {pickets} pickets get replaced. Put a quick spray-paint mark on each one,
            so the stainer replaces the right ones. If they want more than {pickets}, tell the office before you leave.
          </p>
          <Button size="lg" variant={job.pickets_marked_at ? "default" : "outline"}
                  className={cn("mt-2 h-auto min-h-11 w-full whitespace-normal py-2 text-sm font-semibold leading-tight", job.pickets_marked_at && "bg-emerald-600 hover:bg-emerald-600")}
                  onClick={() => onPatch({ pickets_marked: !job.pickets_marked_at })}>
            {job.pickets_marked_at
              ? <><CheckCircle2 className="mr-1.5 h-4 w-4" /> Agreed with the customer and marked{job.pickets_marked_by ? ` · ${job.pickets_marked_by}` : ""}</>
              : <>Agreed with the customer and marked all {pickets}</>}
          </Button>
        </div>
      ) : null}
      <SiteExtras job={job} onPatch={onPatch} afterPlanned={pickets > 0 && !job.pickets_marked_at} />
    </Panel>
  );
}

/** The customer wants more fixed (Alan, 2026-10-15): the cleaner counts it
 *  with them at the fence, the price list does the math out loud, and
 *  "Customer agreed" adds it to the job, the calendar and Alan's invoice. */
function SiteExtras({ job, onPatch, afterPlanned }: {
  job: CompanyCamJob; afterPlanned: boolean;
  onPatch: (p: Partial<CompanyCamJob> & { extras_confirmed?: boolean }) => void;
}) {
  const e = job.extras || NO_REPAIRS;
  const confirmed = !!job.extras_confirmed_at;
  const set = (patch: Partial<Repairs>) => onPatch({ extras: { ...e, ...patch, counts: { ...e.counts, ...(patch.counts || {}) } } });
  const bump = (key: string, d: number) => set({ counts: { [key]: Math.max(0, (e.counts[key] || 0) + d) } });
  const picket = PICKETS.find((p) => p.key === e.picket_type) || PICKETS[0];
  const post = POSTS.find((p) => p.key === e.post_type) || POSTS[0];
  const lines = [
    { n: e.counts.pickets || 0, what: `${picket.label.toLowerCase()} picket`, price: picket.price },
    ...PARTS.map((p) => ({ n: e.counts[p.key] || 0, what: p.label.toLowerCase(), price: p.price })),
    { n: e.counts.posts || 0, what: `post (${post.label})`, price: post.price },
  ].filter((l) => l.n > 0);
  const total = lines.reduce((t, l) => t + l.n * l.price, 0);
  const [open, setOpen] = useState(lines.length > 0);
  const [editing, setEditing] = useState(false);
  if (!open) {
    return (
      <Button variant="outline" size="lg" className="h-11 w-full border-dashed" onClick={() => setOpen(true)}>
        <Plus className="mr-1.5 h-4 w-4" /> The customer wants more fixed
      </Button>
    );
  }
  return (
    <div className={cn("space-y-2 rounded-xl border p-2.5", confirmed ? "border-emerald-300 bg-emerald-50/60" : "border-border bg-background")}>
      <p className="text-sm font-bold">Extra repairs the customer wants</p>
      {afterPlanned ? <p className="text-xs text-amber-800">Mark the planned pickets with the customer first, then add any extras.</p> : null}
      {!confirmed || editing ? (<>
      <p className="text-xs text-muted-foreground">Show them the price as you count. Tap + once for each one.</p>
        <Counter stack label="Pickets" what="The upright boards" unit="picket" price={picket.price}
                 art={<FencePart part="picket" />} n={e.counts.pickets || 0} onChange={(d) => bump("pickets", d)}>
          <Chips options={PICKETS} value={e.picket_type} onChange={(k) => set({ picket_type: k })} />
        </Counter>
        {PARTS.map((part) => (
          <Counter stack key={part.key} label={part.label} what={part.what} unit={part.unit} price={part.price}
                   art={<FencePart part={part.key as FencePartKey} />} n={e.counts[part.key] || 0} onChange={(d) => bump(part.key, d)} />
        ))}
        <Counter stack label="Post replacement" what="The thick posts set in the ground" unit="post" price={post.price}
                 art={<FencePart part="post" />} n={e.counts.posts || 0} onChange={(d) => bump("posts", d)}>
          <Chips options={POSTS} value={e.post_type} onChange={(k) => set({ post_type: k })} />
        </Counter>
      </>) : null}
      {lines.length ? (
        <div className="rounded-xl bg-[#15130F] px-3 py-2.5 text-white">
          {lines.map((l) => (
            <p key={l.what} className="flex justify-between gap-2 text-sm tabular-nums">
              <span>{l.n} {l.what}{l.n === 1 ? "" : "s"} × {formatCurrency(l.price).replace(".00", "")}</span>
              <span>{formatCurrency(l.n * l.price).replace(".00", "")}</span>
            </p>
          ))}
          <p className="mt-1 flex justify-between border-t border-white/20 pt-1 text-lg font-bold tabular-nums">
            <span>Added to their total</span><span>{formatCurrency(total).replace(".00", "")}</span>
          </p>
        </div>
      ) : null}
      {lines.length && !confirmed ? (
        <Button size="lg" className="h-auto min-h-12 w-full whitespace-normal py-2 text-base font-semibold"
                onClick={() => { onPatch({ extras_confirmed: true }); setEditing(false); }}>
          The customer agreed: add {formatCurrency(total).replace(".00", "")}
        </Button>
      ) : null}
      {confirmed ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="flex flex-1 items-center gap-1.5 text-sm font-semibold text-emerald-800">
            <CheckCircle2 className="h-4 w-4 shrink-0" /> Customer agreed{job.extras_confirmed_by ? ` · ${job.extras_confirmed_by}` : ""}. Added to the job. Mark the extra pickets too.
          </p>
          {!editing ? <Button variant="outline" size="sm" className="h-9" onClick={() => setEditing(true)}>Change</Button> : null}
        </div>
      ) : null}
      {confirmed && editing ? <p className="text-xs text-muted-foreground">Changing a count needs the customer's yes again.</p> : null}
    </div>
  );
}

/** The cleaner's steps or the stainer's, boxed together under one banner so
 *  each person sees their part of the job as one (Alan, 2026-10-16). */
function RoleGroup({ who, children }: { who: "cleaner" | "stainer"; children: React.ReactNode }) {
  const look = who === "cleaner"
    ? { title: "The cleaner's part", sub: "Before cleaning and after cleaning", Icon: Sparkles, ring: "ring-sky-200", band: "from-sky-600 to-cyan-600", bg: "bg-sky-50/40" }
    : { title: "The stainer's part", sub: "Before staining, after staining, and finishing up", Icon: Paintbrush, ring: "ring-emerald-200", band: "from-emerald-600 to-teal-600", bg: "bg-emerald-50/40" };
  return (
    <section className={cn("overflow-hidden rounded-2xl ring-2", look.ring, look.bg)}>
      <div className={cn("flex items-center gap-3 bg-gradient-to-r px-4 py-3 text-white", look.band)}>
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/20"><look.Icon className="h-5 w-5" /></span>
        <span>
          <span className="block font-heading text-lg font-bold leading-tight">{look.title}</span>
          <span className="block text-xs text-white/85">{look.sub}</span>
        </span>
      </div>
      <div className="space-y-3.5 p-2 sm:p-3">{children}</div>
    </section>
  );
}
