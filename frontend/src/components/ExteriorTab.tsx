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
} from "lucide-react";
import { toast } from "sonner";
import { api, type ExteriorEstimate, type ExteriorPhoto, type LeadDetail } from "@/lib/api";
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
    if (photos.length < 4) {
      toast.error("Need at least 4 photos to run an estimate");
      return;
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
        lastSentBody={lastSentBody}
        onIssue={issueLink}
        onIssueAndSend={issueLinkAndSendSms}
        onCopy={copyLink}
        photosByCustomer={photosByCustomer}
        customerSubmittedAt={estimate.customer_submitted_at}
        hasPhone={!!lead.contact_phone}
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
  lastSentBody,
  onIssue,
  onIssueAndSend,
  onCopy,
  photosByCustomer,
  customerSubmittedAt,
  hasPhone,
}: {
  captureUrl: string | null;
  issuingLink: boolean;
  sendingLink: boolean;
  lastSentBody: string | null;
  onIssue: () => void;
  onIssueAndSend: () => void;
  onCopy: () => void;
  photosByCustomer: number;
  customerSubmittedAt?: string;
  hasPhone: boolean;
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
          </>
        ) : (
          <>
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

            {!lastSentBody && (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onIssueAndSend}
                  disabled={sendingLink || !hasPhone}
                  title={!hasPhone ? "No phone on file" : undefined}
                >
                  {sendingLink ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  Text the link to customer
                </Button>
              </div>
            )}

            <div className="flex items-center gap-3 text-xs">
              <Badge variant="outline" className="text-xs">
                {photosByCustomer} customer photos
              </Badge>
              {customerSubmittedAt && (
                <Badge className="bg-emerald-500/10 text-emerald-700 border-emerald-500/30 text-xs">
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  Customer submitted {new Date(customerSubmittedAt).toLocaleString()}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              The same link stays valid — customer can come back anytime to add more photos.
            </p>
          </>
        )}
      </CardContent>
    </Card>
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
            Run the AI estimator after the customer sends enough photos.{" "}
            {photoCount > 0 ? `(${photoCount} on file)` : "(no photos yet)"}
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
          <Button onClick={onRun} disabled={running || photoCount < 4}>
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
