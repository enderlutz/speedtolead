// Internal Exterior tab on LeadDetail — VA workflow for the photo-based
// stucco/brick painting estimate.
//
// Three top-level sections in order:
//   1. Capture link card  — issue + copy + SMS the customer link.
//   2. Photo gallery      — what the customer has uploaded so far.
//   3. AI estimate card   — run/adjust/apply the AI-generated sqft.

import { useEffect, useMemo, useState } from "react";
import {
  Camera,
  Link as LinkIcon,
  Copy,
  Loader2,
  Sparkles,
  RefreshCw,
  ImageIcon,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  Pencil,
  Send,
  MessageSquare,
  XCircle,
  Eye,
  Upload,
  PauseCircle,
} from "lucide-react";
import { toast } from "sonner";
import { api, type ExteriorEstimate, type ExteriorPhoto, type LeadDetail, type ExteriorActivity } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

type Props = {
  lead: LeadDetail;
  onChange: (lead: LeadDetail) => void;
};

export default function ExteriorTab({ lead, onChange }: Props) {
  const [captureUrl, setCaptureUrl] = useState<string | null>(null);
  const [issuingLink, setIssuingLink] = useState(false);
  const [sendingLink, setSendingLink] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [lastSentBody, setLastSentBody] = useState<string | null>(null);
  const [runningEstimate, setRunningEstimate] = useState(false);
  const [savingOverride, setSavingOverride] = useState(false);
  const [overrideDraft, setOverrideDraft] = useState<{
    perimeter_ft?: number;
    wall_height_ft?: number;
    opening_sqft?: number;
  }>({});

  const photos: ExteriorPhoto[] = lead.exterior_photos || [];
  const estimate: ExteriorEstimate = lead.exterior_estimate || ({} as ExteriorEstimate);
  const activity: ExteriorActivity = lead.exterior_activity || {};
  const photosByCustomer = photos.filter((p) => p.source === "customer").length;

  useEffect(() => {
    if (lead.exterior_capture_token) {
      // Compose the public URL from the same base the customer would receive
      const base =
        (import.meta.env.VITE_PUBLIC_URL as string) || window.location.origin;
      setCaptureUrl(`${base.replace(/\/$/, "")}/capture/${lead.exterior_capture_token}`);
    }
  }, [lead.exterior_capture_token]);

  // ---------- Capture link actions ----------

  const issueLink = async () => {
    setIssuingLink(true);
    try {
      const r = await api.issueExteriorCaptureLink(lead.id);
      setCaptureUrl(r.url);
      onChange({ ...lead, exterior_capture_token: r.token });
      toast.success("Capture link ready");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't issue link");
    } finally {
      setIssuingLink(false);
    }
  };

  const issueLinkAndSendSms = async () => {
    if (!lead.contact_phone) {
      toast.error("No phone on file for this lead — generate the link manually instead.");
      return;
    }
    setSendingLink(true);
    try {
      const r = await api.issueExteriorCaptureLinkAndSendSms(lead.id);
      setCaptureUrl(r.url);
      setLastSentBody(r.body);
      onChange({ ...lead, exterior_capture_token: r.token });
      toast.success(`Text sent to ${lead.contact_name || "customer"}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't text the customer");
    } finally {
      setSendingLink(false);
    }
  };

  const cancelLink = async () => {
    if (
      !confirm(
        `Cancel the current capture link and permanently delete all ${photos.length} uploaded photo(s)?\n\n` +
          "The customer's current link will stop working. You can issue a fresh link right after.",
      )
    ) {
      return;
    }
    setCanceling(true);
    try {
      const r = await api.cancelExteriorCaptureLink(lead.id);
      setCaptureUrl(null);
      setLastSentBody(null);
      onChange({
        ...lead,
        exterior_capture_token: "",
        exterior_photos: [],
        exterior_estimate: {} as ExteriorEstimate,
        exterior_activity: {},
      });
      toast.success(
        r.photos_removed > 0
          ? `Link canceled — ${r.photos_removed} photo${r.photos_removed === 1 ? "" : "s"} deleted`
          : "Link canceled",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't cancel link");
    } finally {
      setCanceling(false);
    }
  };

  const copyLink = async () => {
    if (!captureUrl) return;
    try {
      await navigator.clipboard.writeText(captureUrl);
      toast.success("Copied — paste it into your text to the customer");
    } catch {
      toast.error("Couldn't copy automatically. Long-press the link to copy.");
    }
  };

  // ---------- Photo actions ----------

  const handleDeletePhoto = async (photoId: string) => {
    if (!confirm("Delete this photo?")) return;
    try {
      const r = await api.deleteExteriorPhoto(lead.id, photoId);
      onChange({ ...lead, exterior_photos: r.photos });
      toast.success("Photo removed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't delete");
    }
  };

  // ---------- Estimator actions ----------

  const runEstimate = async () => {
    if (photos.length === 0) {
      toast.error("Need at least 1 photo to run an estimate");
      return;
    }
    // Soft warning when running with very few photos — the AI will
    // still produce a number, just with a wider confidence band.
    if (photos.length < 4) {
      const ok = confirm(
        `Only ${photos.length} photo${photos.length === 1 ? "" : "s"} uploaded — the AI can still produce an estimate but the confidence will be low and the range wide. Continue?`,
      );
      if (!ok) return;
    }
    setRunningEstimate(true);
    try {
      const r = await api.runExteriorEstimate(lead.id);
      onChange({ ...lead, exterior_estimate: r });
      if (r.status === "skipped") {
        toast.warning(r.skip_reason || "Estimate skipped");
      } else {
        toast.success("AI estimate ready");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Estimate failed");
    } finally {
      setRunningEstimate(false);
    }
  };

  const applyOverride = async () => {
    setSavingOverride(true);
    try {
      const r = await api.updateExteriorOverrides(lead.id, overrideDraft);
      onChange({ ...lead, exterior_estimate: r });
      setOverrideDraft({});
      toast.success("Updated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't update");
    } finally {
      setSavingOverride(false);
    }
  };

  return (
    <div className="space-y-4">
      <CaptureLinkCard
        captureUrl={captureUrl}
        issuingLink={issuingLink}
        sendingLink={sendingLink}
        canceling={canceling}
        lastSentBody={lastSentBody}
        onIssue={issueLink}
        onIssueAndSend={issueLinkAndSendSms}
        onCancel={cancelLink}
        onCopy={copyLink}
        photosByCustomer={photosByCustomer}
        customerSubmittedAt={estimate.customer_submitted_at}
        hasPhone={!!lead.contact_phone}
        activity={activity}
      />

      {photos.length > 0 && (
        <PhotoGalleryCard photos={photos} onDelete={handleDeletePhoto} />
      )}

      <EstimateCard
        estimate={estimate}
        photoCount={photos.length}
        running={runningEstimate}
        onRun={runEstimate}
        overrideDraft={overrideDraft}
        setOverrideDraft={setOverrideDraft}
        savingOverride={savingOverride}
        applyOverride={applyOverride}
      />
    </div>
  );
}

// ----- Subcomponents -----

function CaptureLinkCard({
  captureUrl,
  issuingLink,
  sendingLink,
  canceling,
  lastSentBody,
  onIssue,
  onIssueAndSend,
  onCancel,
  onCopy,
  photosByCustomer,
  customerSubmittedAt,
  hasPhone,
  activity,
}: {
  captureUrl: string | null;
  issuingLink: boolean;
  sendingLink: boolean;
  canceling: boolean;
  lastSentBody: string | null;
  onIssue: () => void;
  onIssueAndSend: () => void;
  onCancel: () => void;
  onCopy: () => void;
  photosByCustomer: number;
  customerSubmittedAt?: string;
  hasPhone: boolean;
  activity: ExteriorActivity;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Camera className="h-4 w-4" />
          Photo capture link
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!captureUrl ? (
          <>
            <p className="text-sm text-muted-foreground">
              Send the customer a link they tap on their phone to send photos. They get a
              guided experience with tips — no app to download.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={onIssue} variant="outline" disabled={issuingLink || sendingLink}>
                {issuingLink ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <LinkIcon className="h-4 w-4 mr-2" />
                )}
                Generate link
              </Button>
              <Button
                onClick={onIssueAndSend}
                disabled={issuingLink || sendingLink || !hasPhone}
                title={!hasPhone ? "No phone on file" : undefined}
              >
                {sendingLink ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Send className="h-4 w-4 mr-2" />
                )}
                Generate &amp; Text
              </Button>
            </div>
            {!hasPhone && (
              <p className="text-xs text-amber-700">
                No phone on file for this lead — only the manual "Generate link" path will work.
              </p>
            )}
            {activity?.canceled_at && (
              <p className="text-xs text-muted-foreground italic">
                Previous link canceled {new Date(activity.canceled_at).toLocaleString()}
                {activity.canceled_by ? ` by ${activity.canceled_by}` : ""}.
              </p>
            )}
          </>
        ) : (
          <>
            <StatusPill activity={activity} photoCount={photosByCustomer} />

            <div className="rounded-lg bg-muted/40 border p-3 flex items-center gap-2">
              <LinkIcon className="h-4 w-4 text-muted-foreground shrink-0" />
              <code className="text-xs flex-1 truncate select-all">{captureUrl}</code>
              <Button size="sm" variant="outline" onClick={onCopy}>
                <Copy className="h-3.5 w-3.5 mr-1" />
                Copy
              </Button>
            </div>

            {lastSentBody && (
              <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-xs text-emerald-800 flex gap-2">
                <MessageSquare className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="font-semibold mb-1">Text just sent:</p>
                  <p className="leading-relaxed whitespace-pre-wrap">{lastSentBody}</p>
                </div>
              </div>
            )}

            <ActivityTimeline activity={activity} submittedAt={customerSubmittedAt} />

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={onIssueAndSend}
                disabled={sendingLink || !hasPhone}
                title={!hasPhone ? "No phone on file" : "Re-send the link to the customer"}
              >
                {sendingLink ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5 mr-1.5" />
                )}
                {(activity.link_sent_count ?? 0) > 0 ? "Re-send the link" : "Text the link"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={onCancel}
                disabled={canceling}
                className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                title="Invalidate the link and delete uploaded photos"
              >
                {canceling ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <XCircle className="h-3.5 w-3.5 mr-1.5" />
                )}
                Cancel &amp; start over
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              Same link stays valid — customer can return anytime to add more photos.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ----- Activity sub-components -----

function relativeShort(iso: string | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function StatusPill({
  activity,
  photoCount,
}: {
  activity: ExteriorActivity;
  photoCount: number;
}) {
  // Status priority: submitted > stalled > uploading > opened > sent
  const submitted = !!activity.submitted_at;
  const lastUploadIso = activity.last_upload_at;
  const lastOpenIso = activity.last_opened_at;
  const firstUploadIso = activity.first_upload_at;
  const sentAt = activity.link_sent_at;

  let kind: "submitted" | "stalled" | "uploading" | "opened" | "sent" | "unsent";
  let icon: React.ReactNode;
  let text: string;
  let cls: string;

  if (submitted) {
    kind = "submitted";
    icon = <CheckCircle2 className="h-3.5 w-3.5" />;
    text = `Submitted · ${photoCount} photo${photoCount === 1 ? "" : "s"}`;
    cls = "bg-emerald-500/10 text-emerald-700 border-emerald-500/30";
  } else if (firstUploadIso) {
    const lastUpMs = lastUploadIso ? Date.now() - Date.parse(lastUploadIso) : Infinity;
    if (lastUpMs > 30 * 60 * 1000) {
      kind = "stalled";
      icon = <PauseCircle className="h-3.5 w-3.5" />;
      text = `Stalled · ${photoCount} photo${photoCount === 1 ? "" : "s"} · last ${relativeShort(lastUploadIso)}`;
      cls = "bg-amber-500/10 text-amber-700 border-amber-500/30";
    } else {
      kind = "uploading";
      icon = <Upload className="h-3.5 w-3.5" />;
      text = `Uploading · ${photoCount} so far · last ${relativeShort(lastUploadIso)}`;
      cls = "bg-blue-500/10 text-blue-700 border-blue-500/30";
    }
  } else if (lastOpenIso) {
    kind = "opened";
    icon = <Eye className="h-3.5 w-3.5" />;
    text = `Opened · no photos yet · ${relativeShort(lastOpenIso)}`;
    cls = "bg-violet-500/10 text-violet-700 border-violet-500/30";
  } else if (sentAt) {
    kind = "sent";
    icon = <Send className="h-3.5 w-3.5" />;
    text = `Sent · waiting on customer · ${relativeShort(sentAt)}`;
    cls = "bg-slate-500/10 text-slate-700 border-slate-400/30";
  } else {
    kind = "unsent";
    icon = <Send className="h-3.5 w-3.5" />;
    text = "Link generated · not texted yet";
    cls = "bg-slate-500/10 text-slate-700 border-slate-400/30";
  }

  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${cls}`}
      data-status={kind}
    >
      {icon}
      {text}
    </div>
  );
}

function ActivityTimeline({
  activity,
  submittedAt,
}: {
  activity: ExteriorActivity;
  submittedAt?: string;
}) {
  const rows: { label: string; iso?: string; suffix?: string }[] = [
    { label: "Link sent", iso: activity.link_sent_at, suffix: activity.link_sent_count && activity.link_sent_count > 1 ? `(${activity.link_sent_count}× total)` : undefined },
    { label: "Customer opened", iso: activity.first_opened_at },
    { label: "First photo", iso: activity.first_upload_at },
    { label: "Last photo", iso: activity.last_upload_at, suffix: activity.upload_count ? `(${activity.upload_count} total)` : undefined },
    { label: "Submitted", iso: activity.submitted_at || submittedAt },
  ].filter((r) => !!r.iso);

  if (rows.length === 0) return null;

  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <p className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground mb-2">
        Activity
      </p>
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.label} className="flex items-baseline gap-2 text-xs">
            <span className="text-muted-foreground w-24 shrink-0">{r.label}</span>
            <span className="font-medium">{new Date(r.iso!).toLocaleString()}</span>
            {r.suffix && <span className="text-muted-foreground">{r.suffix}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PhotoGalleryCard({
  photos,
  onDelete,
}: {
  photos: ExteriorPhoto[];
  onDelete: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <ImageIcon className="h-4 w-4" />
          Photos ({photos.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
          {photos.map((p) => (
            <a
              key={p.id}
              href={p.url}
              target="_blank"
              rel="noreferrer"
              className="relative group block rounded-lg overflow-hidden border bg-muted aspect-square"
            >
              <img src={p.url} alt={p.label} className="w-full h-full object-cover" />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-end p-1.5">
                <p className="text-[10px] text-white opacity-0 group-hover:opacity-100 truncate">
                  {p.label || p.source}
                </p>
              </div>
              <button
                onClick={(e) => {
                  e.preventDefault();
                  onDelete(p.id);
                }}
                className="absolute top-1 right-1 bg-black/60 hover:bg-rose-600 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                aria-label="Delete"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </a>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function EstimateCard({
  estimate,
  photoCount,
  running,
  onRun,
  overrideDraft,
  setOverrideDraft,
  savingOverride,
  applyOverride,
}: {
  estimate: ExteriorEstimate;
  photoCount: number;
  running: boolean;
  onRun: () => void;
  overrideDraft: {
    perimeter_ft?: number;
    wall_height_ft?: number;
    opening_sqft?: number;
  };
  setOverrideDraft: (d: typeof overrideDraft) => void;
  savingOverride: boolean;
  applyOverride: () => void;
}) {
  const ready = estimate?.status === "ok";
  const skipped = estimate?.status === "skipped";

  const perimeter = overrideDraft.perimeter_ft ?? estimate.perimeter_ft;
  const height = overrideDraft.wall_height_ft ?? estimate.wall_height_ft;
  const opening = overrideDraft.opening_sqft ?? estimate.opening_sqft;
  const liveApplied = useMemo(() => {
    if (!perimeter || !height) return null;
    return Math.max(0, perimeter * height - (opening || 0));
  }, [perimeter, height, opening]);

  const confidenceColor =
    estimate.confidence === "high"
      ? "bg-emerald-500/10 text-emerald-700 border-emerald-500/30"
      : estimate.confidence === "low"
      ? "bg-amber-500/10 text-amber-700 border-amber-500/30"
      : "bg-blue-500/10 text-blue-700 border-blue-500/30";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          AI exterior estimate
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!ready && !skipped && (
          <div className="text-sm text-muted-foreground">
            {photoCount === 0
              ? "Waiting on photos — the customer hasn't uploaded anything yet."
              : photoCount < 4
              ? `${photoCount} photo${photoCount === 1 ? "" : "s"} on file. You can still run the estimator but the range will be wide — more photos = tighter range.`
              : `${photoCount} photos on file. Ready to run when you are.`}
          </div>
        )}

        {skipped && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 flex gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold mb-0.5">Estimator skipped</p>
              <p>{estimate.skip_reason || "No reason recorded"}</p>
            </div>
          </div>
        )}

        {ready && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="rounded-lg border bg-card p-3">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Paintable sqft
                </p>
                <p className="text-2xl font-bold">
                  {liveApplied?.toLocaleString() ?? estimate.applied_sqft?.toLocaleString() ?? "—"}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Range: {estimate.sqft_min?.toLocaleString()}–
                  {estimate.sqft_max?.toLocaleString()}
                </p>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Confidence
                </p>
                <Badge variant="outline" className={`mt-1 ${confidenceColor}`}>
                  {(estimate.confidence || "—").toUpperCase()}
                </Badge>
                <p className="text-[10px] text-muted-foreground mt-2">
                  {estimate.windows_count ?? 0} windows · {estimate.doors_count ?? 0} doors
                </p>
              </div>
              {estimate.satellite_url && (
                <a
                  href={estimate.satellite_url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border bg-card overflow-hidden block aspect-[4/3] sm:aspect-auto"
                >
                  <img
                    src={estimate.satellite_url}
                    alt="Property footprint"
                    className="w-full h-full object-cover"
                  />
                </a>
              )}
            </div>

            {/* Override controls */}
            <div className="rounded-lg border bg-muted/30 p-3 space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Pencil className="h-3 w-3" />
                Adjust if needed
              </div>
              <div className="grid grid-cols-3 gap-2">
                <OverrideField
                  label="Perimeter (ft)"
                  defaultValue={estimate.perimeter_ft}
                  value={overrideDraft.perimeter_ft}
                  onChange={(v) =>
                    setOverrideDraft({ ...overrideDraft, perimeter_ft: v })
                  }
                />
                <OverrideField
                  label="Wall height (ft)"
                  defaultValue={estimate.wall_height_ft}
                  value={overrideDraft.wall_height_ft}
                  onChange={(v) =>
                    setOverrideDraft({ ...overrideDraft, wall_height_ft: v })
                  }
                />
                <OverrideField
                  label="Openings (sqft)"
                  defaultValue={estimate.opening_sqft}
                  value={overrideDraft.opening_sqft}
                  onChange={(v) =>
                    setOverrideDraft({ ...overrideDraft, opening_sqft: v })
                  }
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={applyOverride}
                disabled={
                  savingOverride ||
                  (overrideDraft.perimeter_ft === undefined &&
                    overrideDraft.wall_height_ft === undefined &&
                    overrideDraft.opening_sqft === undefined)
                }
              >
                {savingOverride ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
                )}
                Apply override
              </Button>
            </div>

            {estimate.vision_notes && (
              <div className="rounded-lg border bg-card p-3 text-xs text-muted-foreground leading-relaxed">
                <p className="font-semibold text-foreground mb-1">AI notes</p>
                {estimate.vision_notes}
              </div>
            )}
          </>
        )}

        <div className="flex items-center gap-2 pt-2 border-t">
          <Button onClick={onRun} disabled={running || photoCount === 0}>
            {running ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            {ready ? "Re-run estimate" : "Run AI estimate"}
          </Button>
          {ready && (
            <p className="text-[11px] text-muted-foreground">
              Last run {new Date(estimate.generated_at || "").toLocaleString()}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function OverrideField({
  label,
  defaultValue,
  value,
  onChange,
}: {
  label: string;
  defaultValue?: number;
  value?: number;
  onChange: (v: number | undefined) => void;
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
        {label}
      </p>
      <Input
        type="number"
        placeholder={defaultValue?.toString() || ""}
        value={value === undefined ? "" : value}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "" ? undefined : Number(v));
        }}
        className="h-8 text-sm"
      />
    </div>
  );
}
