// FenceScope review queue — staff watch each submitted video, count pickets to
// get linear feet, recalc the estimate, then finish/send on the lead page.
// See fencescope.md. Route: /video-estimates (staff).
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type VideoSubmission } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Loader2, Video, ExternalLink, RotateCcw, CheckCircle2, AlertTriangle, Gauge } from "lucide-react";

const HEIGHTS = ["Didn't answer", "4 feet", "6 feet", "6.5 feet", "7 feet", "8 feet"];
const AGES = ["Didn't answer", "Brand new", "1-3 years", "4-7 years", "8-14 years", "15+ years"];
const DAMAGE_LABELS: Record<string, string> = {
  rotten_boards: "Rotten/cracked boards",
  leaning_posts: "Leaning/broken posts",
  damaged_caps: "Damaged caps/trim",
  loose_rails: "Loose/sagging rails",
};

export default function VideoEstimates() {
  const [subs, setSubs] = useState<VideoSubmission[] | null>(null);

  const load = useCallback(() => {
    api.getVideoQueue().then((r) => setSubs(r.submissions)).catch(() => toast.error("Couldn't load the review queue"));
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Video className="h-6 w-6 text-blue-600" />
        <h1 className="text-2xl font-bold">Video Estimates</h1>
        {subs && <span className="text-sm text-muted-foreground">({subs.length} to review)</span>}
      </div>
      <p className="text-sm text-muted-foreground">
        Watch the walk at 2×, count pickets (cedar picket ≈ 0.458 ft each), type the linear feet, and recalculate. Then open the lead to send the quote.
      </p>

      {!subs ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : subs.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <CheckCircle2 className="h-10 w-10 mx-auto mb-2 text-green-500" />
          Nothing waiting. New submissions land here the moment a customer finishes.
        </div>
      ) : (
        subs.map((s) => <ReviewCard key={s.id} sub={s} onResolved={load} />)
      )}
    </div>
  );
}

function ReviewCard({ sub, onResolved }: { sub: VideoSubmission; onResolved: () => void }) {
  const [linearFeet, setLinearFeet] = useState<string>(sub.ai_linear_feet_draft != null ? String(sub.ai_linear_feet_draft) : "");
  const [height, setHeight] = useState("6 feet");
  const [age, setAge] = useState("Didn't answer");
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tiers, setTiers] = useState<{ essential: number; signature: number; legacy: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [rate, setRate] = useState(1);

  const setSpeed = (r: number) => { setRate(r); if (videoRef.current) videoRef.current.playbackRate = r; };

  const damageEntries = Object.entries(sub.damage || {}).filter(([, n]) => (n || 0) > 0);

  const recalc = async () => {
    const lf = parseFloat(linearFeet);
    if (!lf || lf <= 0) { toast.error("Enter the linear feet you counted first."); return; }
    setSaving(true);
    try {
      const res = await api.updateFormData(sub.lead_id, {
        linear_feet: linearFeet,
        fence_height: height,
        fence_age: age,
      });
      const est = res.estimate || res.estimates?.[0];
      if (est?.tiers) setTiers(est.tiers);
      toast.success("Estimate recalculated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't recalculate");
    } finally {
      setSaving(false);
    }
  };

  const redo = async (unusable: boolean) => {
    if (!window.confirm(unusable ? "Mark this video unusable and ask the customer to redo?" : "Ask the customer to redo this video?")) return;
    setBusy(true);
    try {
      const r = await api.requestVideoRedo(sub.id, unusable);
      toast.success(r.routed_to_estimator ? "Sent back — 2 fails, routed to the estimator" : "Marked for a redo");
      onResolved();
    } catch { toast.error("Couldn't update"); } finally { setBusy(false); }
  };

  const markQuoted = async () => {
    setBusy(true);
    try { await api.markVideoQuoted(sub.id); toast.success("Marked quoted"); onResolved(); }
    catch { toast.error("Couldn't update"); } finally { setBusy(false); }
  };

  return (
    <div className="rounded-xl border bg-background p-4 space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-semibold">{sub.contact_name || "Lead"}</div>
          {sub.address && <div className="text-xs text-muted-foreground">{sub.address}</div>}
        </div>
        <Link to={`/leads/${sub.lead_id}`} className="text-sm text-blue-600 hover:underline inline-flex items-center gap-1 shrink-0">
          Open lead <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </div>

      {sub.both_sides_requested && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 p-2.5 text-sm text-amber-800 flex gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>Customer wants <b>both sides</b> but couldn't film the back — same linear footage, verify back-side condition on arrival.</span>
        </div>
      )}

      {/* Video */}
      {sub.video_purged_at ? (
        <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground text-center">Raw video expired (90-day retention). Measurements kept.</div>
      ) : sub.video_url ? (
        <div>
          <video ref={videoRef} src={sub.video_url} controls playsInline className="w-full rounded-lg bg-black max-h-[60vh]" />
          <div className="flex items-center gap-2 mt-2">
            <Gauge className="h-4 w-4 text-muted-foreground" />
            {[1, 1.5, 2].map((r) => (
              <button key={r} onClick={() => setSpeed(r)} className={`text-xs rounded-md border px-2 py-1 ${rate === r ? "bg-blue-600 text-white border-blue-600" : "bg-background"}`}>{r}×</button>
            ))}
            {sub.video_duration_seconds ? <span className="text-xs text-muted-foreground ml-auto">{Math.round(sub.video_duration_seconds)}s clip</span> : null}
          </div>
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">No video on this submission.</div>
      )}

      {/* Damage */}
      {(damageEntries.length > 0 || sub.damage_photos.length > 0) && (
        <div className="rounded-lg border p-3">
          <div className="text-xs font-semibold text-muted-foreground mb-2">Customer-reported damage (verify against photos → add repair line manually)</div>
          {damageEntries.length > 0 ? (
            <ul className="text-sm space-y-0.5">
              {damageEntries.map(([k, n]) => <li key={k}>• {DAMAGE_LABELS[k] || k}: <b>{n}</b></li>)}
            </ul>
          ) : <div className="text-sm text-muted-foreground">No counts reported.</div>}
          {sub.damage_photos.length > 0 && (
            <div className="flex gap-2 flex-wrap mt-2">
              {sub.damage_photos.map((p) => (
                <a key={p.id} href={p.url} target="_blank" rel="noreferrer"><img src={p.url} alt={p.label || "damage"} className="h-16 w-16 object-cover rounded-md border" /></a>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Measurement → recalc */}
      <div className="rounded-lg border p-3 space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <label className="text-xs font-semibold text-muted-foreground col-span-3 sm:col-span-1">
            Linear feet
            <input type="number" inputMode="decimal" value={linearFeet} onChange={(e) => setLinearFeet(e.target.value)} placeholder="e.g. 180" className="mt-1 w-full border rounded-md px-2 py-1.5 text-sm bg-background" />
          </label>
          <label className="text-xs font-semibold text-muted-foreground">
            Height
            <select value={height} onChange={(e) => setHeight(e.target.value)} className="mt-1 w-full border rounded-md px-2 py-1.5 text-sm bg-background">
              {HEIGHTS.map((h) => <option key={h}>{h}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold text-muted-foreground">
            Fence age
            <select value={age} onChange={(e) => setAge(e.target.value)} className="mt-1 w-full border rounded-md px-2 py-1.5 text-sm bg-background">
              {AGES.map((a) => <option key={a}>{a}</option>)}
            </select>
          </label>
        </div>
        <Button onClick={recalc} disabled={saving} size="sm" className="w-full">
          {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null} Save &amp; recalculate
        </Button>
        {tiers && (
          <div className="flex items-center justify-around rounded-md bg-muted/40 py-2 text-sm">
            <div className="text-center"><div className="text-xs text-muted-foreground">Essential</div><div className="font-semibold">${tiers.essential.toLocaleString()}</div></div>
            <div className="text-center"><div className="text-xs text-muted-foreground">Signature</div><div className="font-semibold">${tiers.signature.toLocaleString()}</div></div>
            <div className="text-center"><div className="text-xs text-muted-foreground">Legacy</div><div className="font-semibold">${tiers.legacy.toLocaleString()}</div></div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        <Link to={`/leads/${sub.lead_id}`} className="flex-1 min-w-[140px] inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground text-sm font-medium h-9 px-3 hover:bg-primary/90">
          Open lead to send quote →
        </Link>
        <Button onClick={markQuoted} disabled={busy} size="sm" variant="outline" className="flex-1 min-w-[120px]">
          <CheckCircle2 className="h-4 w-4 mr-1" /> Mark quoted
        </Button>
        <Button onClick={() => redo(true)} disabled={busy} size="sm" variant="outline" className="text-amber-700 border-amber-300">
          <RotateCcw className="h-4 w-4 mr-1" /> Unusable — redo
        </Button>
      </div>
    </div>
  );
}
