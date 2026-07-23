// FenceScope — per-lead card on the Lead Detail page: send/copy the customer
// capture link, watch the status timeline, and jump to submissions. See
// fencescope.md. Staff-facing.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type VideoCaptureActivity, type VideoSubmission } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Video, Copy, Send, RotateCcw, Loader2, CheckCircle2, ExternalLink } from "lucide-react";

function shortTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

const STEPS: { key: keyof VideoCaptureActivity; label: string }[] = [
  { key: "link_sent_at", label: "Sent" },
  { key: "first_opened_at", label: "Opened" },
  { key: "recording_started_at", label: "Recording" },
  { key: "submitted_at", label: "Submitted" },
  { key: "quoted_at", label: "Quoted" },
];

export default function VideoEstimateCard({ leadId }: { leadId: string }) {
  const [data, setData] = useState<{ url: string; activity: VideoCaptureActivity; submissions: VideoSubmission[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.getLeadVideoCapture(leadId).then((r) => setData({ url: r.url, activity: r.activity || {}, submissions: r.submissions || [] })).catch(() => {});
  }, [leadId]);
  useEffect(() => { load(); }, [load]);

  const send = async () => {
    setBusy(true);
    try {
      await api.sendVideoLink(leadId);
      toast.success("Video link texted to the customer");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message.replace(/^\d+:\s*/, "") : "Couldn't send");
    } finally { setBusy(false); }
  };

  const copy = async () => {
    setBusy(true);
    try {
      const r = await api.issueVideoLink(leadId);
      await navigator.clipboard.writeText(r.url);
      toast.success("Link copied — paste it to the customer");
      load();
    } catch { toast.error("Couldn't create the link"); } finally { setBusy(false); }
  };

  const reissue = async () => {
    if (!window.confirm("Start a fresh link? The old one stops working and the timeline resets.")) return;
    setBusy(true);
    try { await api.reissueVideoLink(leadId); toast.success("New link issued"); load(); }
    catch { toast.error("Couldn't reissue"); } finally { setBusy(false); }
  };

  const act = data?.activity || {};
  const submissions = data?.submissions || [];

  return (
    <div className="rounded-xl border bg-background p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Video className="h-5 w-5 text-blue-600" />
        <h3 className="font-semibold">Video Estimate</h3>
        <span className="text-xs text-muted-foreground">FenceScope</span>
      </div>
      <p className="text-xs text-muted-foreground">Text the customer a link to record a guided video of their fence — quote it without a site visit.</p>

      {/* Status timeline */}
      <div className="flex items-center gap-1 overflow-x-auto py-1">
        {STEPS.map((s, i) => {
          const done = !!act[s.key];
          return (
            <div key={s.key} className="flex items-center gap-1 shrink-0">
              <div className="flex flex-col items-center">
                <div className={`h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-bold ${done ? "bg-green-500 text-white" : "bg-muted text-muted-foreground"}`}>
                  {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : i + 1}
                </div>
                <span className={`text-[10px] mt-0.5 ${done ? "text-foreground font-medium" : "text-muted-foreground"}`}>{s.label}</span>
                {done && <span className="text-[9px] text-muted-foreground leading-none">{shortTime(act[s.key] as string)}</span>}
              </div>
              {i < STEPS.length - 1 && <div className={`h-0.5 w-4 ${done ? "bg-green-400" : "bg-muted"}`} />}
            </div>
          );
        })}
      </div>
      {typeof act.link_sent_count === "number" && act.link_sent_count > 1 && (
        <div className="text-[11px] text-muted-foreground">Sent {act.link_sent_count}× · latest {shortTime(act.link_sent_at)}</div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        <Button onClick={send} disabled={busy} size="sm" className="flex-1 min-w-[130px]">
          {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Send className="h-4 w-4 mr-1" />} Text the link
        </Button>
        <Button onClick={copy} disabled={busy} size="sm" variant="outline" className="flex-1 min-w-[110px]">
          <Copy className="h-4 w-4 mr-1" /> Copy link
        </Button>
        {data?.url && (
          <Button onClick={reissue} disabled={busy} size="sm" variant="ghost" className="text-muted-foreground">
            <RotateCcw className="h-4 w-4 mr-1" /> New link
          </Button>
        )}
      </div>

      {/* Submissions */}
      {submissions.length > 0 && (
        <div className="border-t pt-2 space-y-1">
          <div className="text-xs font-semibold text-muted-foreground">Submissions</div>
          {submissions.map((s) => (
            <div key={s.id} className="flex items-center justify-between text-sm">
              <span>{shortTime(s.created_at)} · <span className="capitalize">{s.status.replace("_", " ")}</span>{s.video_duration_seconds ? ` · ${Math.round(s.video_duration_seconds)}s` : ""}</span>
              {s.status === "submitted" && (
                <Link to="/video-estimates" className="text-blue-600 hover:underline inline-flex items-center gap-1 text-xs">Review <ExternalLink className="h-3 w-3" /></Link>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
