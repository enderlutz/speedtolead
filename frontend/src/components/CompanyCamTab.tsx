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
  Droplets, Users, ShoppingCart, MessageSquare, Send, RotateCcw,
} from "lucide-react";
import { toast } from "sonner";
import {
  api, type CompanyCamPayload, type CompanyCamPhoto, type CompanyCamJob,
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
  photo, onPatch, onDelete,
}: {
  photo: CompanyCamPhoto;
  onPatch: (p: { side?: string; note?: string; is_damage?: boolean }) => void;
  onDelete: () => void;
}) {
  return (
    <div className="border rounded-lg overflow-hidden bg-card">
      <div className="relative">
        <img src={photo.url} alt={photo.side || `Photo ${photo.seq}`}
             className="w-full h-40 object-cover bg-muted" loading="lazy" />
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

export default function CompanyCamTab({ leadId }: { leadId: string }) {
  const [data, setData] = useState<CompanyCamPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState<string>("");
  const [sending, setSending] = useState(false);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setData(await api.getCompanyCam(leadId)); }
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

  const { job, sections, photos, upsell_options, blockers, customer } = data;
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
          <Field label="Stain colour"
                 hint={job.color_shown_at
                   ? `Shown to the customer by ${job.color_shown_by || "crew"}`
                   : "Show the customer the colour even when it's confirmed"}>
            <div className="flex gap-1.5">
              <BlurText value={job.color} placeholder="e.g. Canyon Brown"
                        onSave={(v) => void patch({ color: v })} />
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
                <Palette className="h-3.5 w-3.5" />
              </Button>
            </div>
          </Field>
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
                    <PhotoCard key={p.id} photo={p}
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
                <Field label="Cleaning notes"
                       hint="Anything the customer said, or anything management needs to decide on. Fill this in before you leave.">
                  <BlurText rows={3} value={job.cleaning_notes}
                            placeholder="What the customer mentioned, anything unexpected…"
                            onSave={(v) => void patch({ cleaning_notes: v })} />
                </Field>
              ) : null}
              {sec.key === "stain_after" ? (
                <Field label="Staining notes"
                       hint="Anything worth knowing before we invoice or follow up.">
                  <BlurText rows={3} value={job.staining_notes}
                            placeholder="How it went, anything left to do…"
                            onSave={(v) => void patch({ staining_notes: v })} />
                </Field>
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
            Texts {customer.name.split(" ")[0] || "the customer"} that you're nearly done, so they
            can look it over before you leave. If they're out, they can ask for videos.
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
            <Button size="lg" disabled={sending || customer.do_not_contact || !customer.phone}
                    title={customer.do_not_contact
                      ? "This customer asked not to be contacted"
                      : !customer.phone ? "No phone number on this lead" : ""}
                    onClick={async () => {
                      setSending(true);
                      try {
                        const r = await api.sendCompanyCamAlmostDone(leadId);
                        setData((d) => (d ? { ...d, job: r.job } : d));
                        toast.success("Customer texted");
                      } catch (e) { toast.error(errMessage(e, "Couldn't send")); }
                      finally { setSending(false); }
                    }}>
              {sending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                       : <Send className="h-4 w-4 mr-1.5" />}
              Text the customer we're almost done
            </Button>
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
          {job.neighbor_interested ? (
            <Field label="Who, and how do we reach them?"
                   hint="A name, a house, a phone number — whatever you got. Alan calls these once the job is done.">
              <BlurText rows={2} value={job.neighbor_notes}
                        placeholder="e.g. House to the left, grey truck — said to call after 5. 713-555-0101"
                        onSave={(v) => void patch({ neighbor_notes: v })} />
            </Field>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
