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
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera, Loader2, Trash2, AlertTriangle, CheckCircle2, Palette,
  Droplets, Users, ShoppingCart, MessageSquare, Send, RotateCcw, ClipboardCheck,
} from "lucide-react";
import { toast } from "sonner";
import {
  api, canSeeRevenue, type CompanyCamPayload, type CompanyCamPhoto,
  type CompanyCamJob, type ColorPlanRow,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { errMessage } from "@/lib/utils";

const PACKAGES = ["essential", "signature", "legacy"] as const;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-semibold text-muted-foreground">{label}</label>
      {children}
      {hint ? <p className="text-[11px] text-muted-foreground/80">{hint}</p> : null}
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
        className="w-full border border-input rounded-md px-2.5 py-2 text-sm bg-background resize-y"
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
    <div className="border rounded-lg overflow-hidden bg-card">
      <div className="relative">
        {src ? (
          <img src={src} alt={photo.side || `Photo ${photo.seq}`}
               className="w-full h-40 object-cover bg-muted" loading="lazy" />
        ) : (
          <div className="w-full h-40 bg-muted flex items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}
        <span className="absolute top-1 left-1 text-[10px] font-semibold bg-black/70 text-white rounded px-1.5 py-0.5">
          #{photo.seq}
        </span>
        {photo.is_damage ? (
          <span className="absolute top-1 right-1 text-[10px] font-semibold bg-red-600 text-white rounded px-1.5 py-0.5">
            DAMAGE
          </span>
        ) : null}
      </div>
      <div className="p-2 space-y-1.5">
        <Input
          defaultValue={photo.side}
          placeholder="Which side? (back, left, front gate…)"
          onBlur={(e) => { if (e.target.value !== photo.side) onPatch({ side: e.target.value }); }}
          className="h-7 text-xs"
        />
        <Input
          defaultValue={photo.note}
          placeholder="Note (optional)"
          onBlur={(e) => { if (e.target.value !== photo.note) onPatch({ note: e.target.value }); }}
          className="h-7 text-xs"
        />
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => onPatch({ is_damage: !photo.is_damage })}
            className={`text-[11px] font-medium inline-flex items-center gap-1 ${
              photo.is_damage ? "text-red-700" : "text-muted-foreground hover:text-foreground"}`}
          >
            <AlertTriangle className="h-3 w-3" />
            {photo.is_damage ? "Marked damage" : "Mark as damage"}
          </button>
          <button type="button" onClick={onDelete}
                  className="text-muted-foreground hover:text-red-600" title="Delete photo">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}


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
        return (
          <div key={i} className="border rounded-lg p-2.5 space-y-2 bg-card">
            <div className="flex gap-1.5 items-start">
              <Input
                defaultValue={row.area}
                placeholder="Which part? e.g. Front gates"
                list="cc-color-areas"
                onBlur={(e) => { if (e.target.value !== row.area) set(i, { area: e.target.value }); }}
                className="h-8 text-sm"
              />
              <button type="button" onClick={() => onChange(plan.filter((_, idx) => idx !== i))}
                      className="text-muted-foreground hover:text-red-600 mt-1.5" title="Remove">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex flex-wrap gap-1">
              {statuses.map((o) => (
                <Button key={o.key} size="sm"
                        variant={row.status === o.key ? "default" : "outline"}
                        className="text-[11px]"
                        onClick={() => set(i, { status: o.key as ColorPlanRow["status"] })}>
                  {o.label}
                </Button>
              ))}
            </div>
            {st ? <p className="text-[11px] text-muted-foreground">{st.hint}</p> : null}
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
                className="h-8 text-sm"
              />
            ) : null}
          </div>
        );
      })}
      <datalist id="cc-color-areas">
        {areas.map((a) => <option key={a} value={a} />)}
      </datalist>
      <Button variant="outline" size="sm"
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
            className={`w-full text-left flex items-start gap-2 rounded-md border px-2.5 py-2 ${
              on ? "border-green-500 bg-green-50" : "bg-card hover:bg-muted"}`}
          >
            {on
              ? <CheckCircle2 className="h-4 w-4 text-green-700 shrink-0 mt-0.5" />
              : <span className="h-4 w-4 rounded border border-input shrink-0 mt-0.5" />}
            <span className="min-w-0">
              <span className={`text-sm ${on ? "text-green-900" : ""}`}>{it.label}</span>
              {it.hint ? (
                <span className="block text-[11px] text-muted-foreground mt-0.5">{it.hint}</span>
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
    return <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading Company Cam…
    </div>;
  }
  if (error || !data) {
    return <div className="text-sm text-red-700 py-8">{error || "No data"}</div>;
  }

  const {
    job, sections, photos, upsell_options, blockers, customer,
    color_statuses, color_areas, cleaner_checklist, stainer_checklist,
    almost_done_default, cleaner_actions,
  } = data;
  const totalPhotos = Object.values(photos).reduce((n, arr) => n + arr.length, 0);
  const damage = Object.values(photos).flat().filter((p) => p.is_damage).length;

  return (
    <div className="space-y-4">
      {/* What still has to happen. A checklist, never a lock — a crew in
          somebody's garden must always be able to save what they have. */}
      {blockers.length > 0 ? (
        <Card className="border-amber-400 bg-amber-50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-amber-900">
              <AlertTriangle className="h-4 w-4" /> Still needed ({blockers.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <ul className="text-xs text-amber-900 space-y-1 list-disc pl-4">
              {blockers.map((b) => <li key={b}>{b}</li>)}
            </ul>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-green-500 bg-green-50">
          <CardContent className="py-3 text-sm text-green-900 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4" />
            Fully documented — {totalPhotos} photos{damage ? `, ${damage} flagged as damage` : ""}.
          </CardContent>
        </Card>
      )}

      {/* The job card: what to bring and what to put on. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Droplets className="h-4 w-4" /> The job
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Square footage"
                 hint={job.sqft_edited ? "Edited by hand" : "From the latest estimate"}>
            <Input type="number" inputMode="decimal" defaultValue={job.sqft || ""}
                   onBlur={(e) => {
                     const v = parseFloat(e.target.value || "0");
                     if (v !== job.sqft) void patch({ sqft: v });
                   }} />
          </Field>
          <Field label="Gallons of stain"
                 hint={job.gallons_edited
                   ? "Overridden — no longer follows the footage"
                   : `${job.sqft_per_gallon} sq ft a gallon, rounded up`}>
            <div className="flex gap-1.5">
              <Input type="number" inputMode="decimal" step="0.5" defaultValue={job.gallons_needed || ""}
                     onBlur={(e) => {
                       const v = parseFloat(e.target.value || "0");
                       if (v !== job.gallons_needed) void patch({ gallons_needed: v });
                     }} />
              {job.gallons_edited ? (
                <Button variant="outline" size="sm" title="Go back to following the square footage"
                        onClick={() => void patch({ recalc_gallons: true })}>
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
              ) : null}
            </div>
          </Field>
          <Field label="Package">
            <div className="flex gap-1">
              {PACKAGES.map((p) => (
                <Button key={p} size="sm"
                        variant={job.package === p ? "default" : "outline"}
                        onClick={() => void patch({ package: job.package === p ? "" : p })}
                        className="flex-1 capitalize text-xs">
                  {p}
                </Button>
              ))}
            </div>
          </Field>
          {/* Price is gated the same way revenue is everywhere else — the
              crew works from this screen and has no business seeing it. */}
          {canSeeRevenue() ? (
            <Field label="Final price" hint="Only visible to you, not the crew">
              <Input type="number" inputMode="decimal" step="1"
                     defaultValue={job.final_price || ""}
                     onBlur={(e) => {
                       const v = parseFloat(e.target.value || "0");
                       if (v !== job.final_price) void patch({ final_price: v });
                     }} />
            </Field>
          ) : null}
        </CardContent>
      </Card>

      {/* Colour, per area. Drives what the cleaner has to settle on site. */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Palette className="h-4 w-4" /> Stain colour — where the customer is
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            A row per part of the fence. They can be at a different stage on
            each — front gates settled while the insides are still between
            three colours is normal.
          </p>
          <ColorPlan
            plan={job.color_plan}
            statuses={color_statuses}
            areas={color_areas}
            onChange={(next) => void patch({ color_plan: next })}
          />

          {cleaner_actions.length > 0 ? (
            <div className="rounded-lg border border-blue-300 bg-blue-50 p-2.5">
              <p className="text-xs font-semibold text-blue-900 mb-1">
                Cleaner, when you arrive:
              </p>
              <ul className="text-xs text-blue-900 space-y-1 list-disc pl-4">
                {cleaner_actions.map((a) => <li key={a}>{a}</li>)}
              </ul>
            </div>
          ) : null}

          <div className="flex items-end gap-2 flex-wrap">
            <div className="flex-1 min-w-[180px]">
              <Field label="Colour they finally went with"
                     hint="Fill in once it's settled — this is the one the stainer uses.">
                <BlurText value={job.final_color} placeholder="e.g. Canyon Brown"
                          onSave={(v) => void patch({ final_color: v })} />
              </Field>
            </div>
            <Button size="sm"
                    variant={job.color_shown_at ? "default" : "outline"}
                    title="Mark that you physically showed the customer the colour"
                    onClick={async () => {
                      try {
                        const r = await api.markCompanyCamColorShown(leadId);
                        setData((d) => (d ? { ...d, job: r.job } : d));
                        toast.success("Logged — colour shown to the customer");
                      } catch (e) { toast.error(errMessage(e, "Couldn't save")); }
                    }}>
              <Palette className="h-3.5 w-3.5 mr-1" />
              {job.color_shown_at ? "Shown to customer" : "I showed them the colour"}
            </Button>
          </div>
          {job.color_shown_at ? (
            <p className="text-[11px] text-muted-foreground">
              Shown by {job.color_shown_by || "crew"}. Show it even when it's
              already confirmed.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* Photos, in the order the job happens. */}
      {sections.map((sec) => {
        const list = photos[sec.key] || [];
        return (
          <Card key={sec.key}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center justify-between gap-2 flex-wrap">
                <span className="flex items-center gap-2">
                  <Camera className="h-4 w-4" /> {sec.label}
                  <Badge variant={list.length ? "secondary" : "outline"} className="text-[11px]">
                    {list.length} photo{list.length === 1 ? "" : "s"}
                  </Badge>
                </span>
                <span className="text-[11px] font-normal text-muted-foreground">{sec.who}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">{sec.hint}</p>

              {sec.key === "fence_scope" && !list.length ? (
                <Field label="No scope drawing — write out the job instead"
                       hint="So the cleaner and stainer know exactly what is and isn't included.">
                  <BlurText rows={3} value={job.scope_explanation}
                            placeholder="e.g. All inside-facing sides plus the outside front. Skip the shared fence with next door."
                            onSave={(v) => void patch({ scope_explanation: v })} />
                </Field>
              ) : null}

              <input
                ref={(el) => { inputs.current[sec.key] = el; }}
                type="file" accept="image/*" multiple capture="environment" hidden
                onChange={(e) => { void upload(sec.key, e.target.files); e.target.value = ""; }}
              />
              <Button variant="outline" size="lg"
                      disabled={uploading === sec.key}
                      onClick={() => inputs.current[sec.key]?.click()}
                      className="w-full sm:w-auto">
                {uploading === sec.key
                  ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Uploading…</>
                  : <><Camera className="h-4 w-4 mr-1.5" /> Add photos</>}
              </Button>

              {list.length ? (
                <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
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
              ) : null}

              {sec.key === "clean_after" ? (
                <>
                  <Field label="Before you leave — cleaner's checklist">
                    <Checklist items={cleaner_checklist} ticked={job.cleaner_checklist}
                               onChange={(next) => void patch({ cleaner_checklist: next })} />
                  </Field>
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
                  <Field label="Before you leave — stainer's checklist">
                    <Checklist items={stainer_checklist} ticked={job.stainer_checklist}
                               onChange={(next) => void patch({ stainer_checklist: next })} />
                  </Field>
                  <Field label="Staining notes"
                       hint="Anything worth knowing before we invoice or follow up.">
                  <BlurText rows={3} value={job.staining_notes}
                            placeholder="How it went, anything left to do…"
                            onSave={(v) => void patch({ staining_notes: v })} />
                  </Field>
                </>
              ) : null}
            </CardContent>
          </Card>
        );
      })}

      {/* Almost finished — catch the customer while the crew is still there. */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <MessageSquare className="h-4 w-4" /> 20–30 minutes from finishing
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Edit this however you like before sending — it goes exactly as written.
          </p>
          {job.almost_done_sent_at ? (
            <div className="flex items-center gap-2 flex-wrap">
              <Badge className="bg-green-100 text-green-800 text-[11px]">
                Sent {job.almost_done_sent_at.slice(0, 16).replace("T", " ")} UTC
                {job.almost_done_sent_by ? ` by ${job.almost_done_sent_by}` : ""}
              </Badge>
              <Button variant="outline" size="sm"
                      onClick={async () => {
                        if (!confirm("Clear this so it can be sent again? Only for a genuine second visit.")) return;
                        try {
                          const r = await api.resetCompanyCamAlmostDone(leadId);
                          setData((d) => (d ? { ...d, job: r.job } : d));
                        } catch (e) { toast.error(errMessage(e, "Couldn't reset")); }
                      }}>
                <RotateCcw className="h-3.5 w-3.5 mr-1" /> Allow again
              </Button>
            </div>
          ) : (
            <>
              <textarea
                value={almostDoneText}
                onChange={(e) => setAlmostDoneText(e.target.value)}
                rows={4}
                className="w-full border border-input rounded-md px-2.5 py-2 text-sm bg-background resize-y"
              />
              <div className="flex items-center gap-2 flex-wrap">
                <Button size="lg" disabled={sending || customer.do_not_contact
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
                  {sending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                           : <Send className="h-4 w-4 mr-1.5" />}
                  Send it
                </Button>
                {almostDoneText !== almost_done_default ? (
                  <Button variant="outline" size="sm"
                          onClick={() => setAlmostDoneText(almost_done_default)}>
                    <RotateCcw className="h-3.5 w-3.5 mr-1" /> Reset wording
                  </Button>
                ) : null}
                <span className="text-[11px] text-muted-foreground ml-auto tabular-nums">
                  {almostDoneText.length} chars
                </span>
              </div>
            </>
          )}
          {customer.do_not_contact ? (
            <p className="text-xs text-red-700">This customer has opted out — nothing will send.</p>
          ) : null}
        </CardContent>
      </Card>

      {/* What the crew heard. */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <ShoppingCart className="h-4 w-4" /> Did the customer mention anything else?
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {upsell_options.map((o) => {
              const on = job.upsells.includes(o.key);
              return (
                <Button key={o.key} size="sm" variant={on ? "default" : "outline"}
                        className="text-xs"
                        onClick={() => void patch({
                          upsells: on ? job.upsells.filter((u) => u !== o.key)
                                      : [...job.upsells, o.key],
                        })}>
                  {on ? <CheckCircle2 className="h-3 w-3 mr-1" /> : null}{o.label}
                </Button>
              );
            })}
          </div>
          <Field label="Notes on what they wanted">
            <BlurText rows={2} value={job.upsell_notes}
                      placeholder="What they actually said…"
                      onSave={(v) => void patch({ upsell_notes: v })} />
          </Field>
        </CardContent>
      </Card>

      {/* What actually happened. The gap from the estimates is the number
          worth having — for pricing, and for the stain inventory. */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <ClipboardCheck className="h-4 w-4" /> End of job — what we actually used
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Fill this in when the job's done. Everything above is the estimate;
            this is the real thing.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Actual square footage"
                   hint={job.sqft ? `Estimated ${Math.round(job.sqft)}` : undefined}>
              <Input type="number" inputMode="decimal" defaultValue={job.actual_sqft || ""}
                     onBlur={(e) => {
                       const v = parseFloat(e.target.value || "0");
                       if (v !== job.actual_sqft) void patch({ actual_sqft: v });
                     }} />
            </Field>
            <Field label="Stain gallons used"
                   hint={job.gallons_needed ? `Planned ${job.gallons_needed}` : undefined}>
              <Input type="number" inputMode="decimal" step="0.5"
                     defaultValue={job.stain_gallons_used || ""}
                     onBlur={(e) => {
                       const v = parseFloat(e.target.value || "0");
                       if (v !== job.stain_gallons_used) void patch({ stain_gallons_used: v });
                     }} />
            </Field>
            <Field label="Stain gallons bought today"
                   hint="Only what was picked up on the way, not what came off the shelf">
              <Input type="number" inputMode="decimal" step="0.5"
                     defaultValue={job.stain_gallons_bought || ""}
                     onBlur={(e) => {
                       const v = parseFloat(e.target.value || "0");
                       if (v !== job.stain_gallons_bought) void patch({ stain_gallons_bought: v });
                     }} />
            </Field>
            <Field label="Bleach gallons used">
              <Input type="number" inputMode="decimal" step="0.5"
                     defaultValue={job.bleach_gallons_used || ""}
                     onBlur={(e) => {
                       const v = parseFloat(e.target.value || "0");
                       if (v !== job.bleach_gallons_used) void patch({ bleach_gallons_used: v });
                     }} />
            </Field>
          </div>
          {job.actual_sqft > 0 && job.sqft > 0
            && Math.abs(job.actual_sqft - job.sqft) / job.sqft > 0.15 ? (
            <p className="text-xs text-amber-800">
              That's {Math.round(Math.abs(job.actual_sqft - job.sqft) / job.sqft * 100)}%
              {job.actual_sqft > job.sqft ? " more" : " less"} than estimated — worth
              knowing why before the next quote like it.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* Neighbours — the cheapest lead source there is. */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Users className="h-4 w-4" /> Any interested neighbours?
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button size="sm" variant={job.neighbor_interested ? "default" : "outline"}
                  onClick={() => void patch({ neighbor_interested: !job.neighbor_interested })}>
            {job.neighbor_interested
              ? <><CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Yes, a neighbour was interested</>
              : "A neighbour asked about us"}
          </Button>
          {!job.neighbor_interested ? (
            <p className="text-xs text-muted-foreground">
              Getting their name and number is the whole job here — Alan calls
              them once this one's finished.
            </p>
          ) : null}
          {job.neighbor_interested ? (
            <div className="space-y-3">
              {/* A referral is a lead, so it's captured like one. All
                  optional — a first name and a number is already enough to
                  make the call. */}
              <div className="grid gap-2 sm:grid-cols-2">
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
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
