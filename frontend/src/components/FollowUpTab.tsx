// FollowUpTab — completed-job customer follow-up brief.
//
// On open, runs Claude over the customer's call transcripts + SMS
// history + estimate to produce structured talking points for a
// follow-up call. The rep can also fire two SMS sends straight from
// this tab:
//   1. Google review request (fixed template, one-tap)
//   2. AI-drafted follow-up message (editable in a dialog before send)
//
// Both SMS buttons are blocked when Training Mode is on, consistent
// with every other customer-contacting button across the dashboard.

import { useEffect, useState } from "react";
import {
  Loader2,
  Sparkles,
  Star,
  MessageSquare,
  AlertTriangle,
  RefreshCw,
  ShoppingCart,
  PhoneCall,
  ThumbsUp,
  Quote,
  Pencil,
} from "lucide-react";
import { toast } from "sonner";
import { api, type FollowUpAnalysis, type LeadDetail } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useTrainingMode } from "@/lib/training_mode_context";

type Props = {
  lead: LeadDetail;
};

export default function FollowUpTab({ lead }: Props) {
  const { trainingModeOn } = useTrainingMode();
  const [analysis, setAnalysis] = useState<FollowUpAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sendingReview, setSendingReview] = useState(false);
  const [sendingFollowUp, setSendingFollowUp] = useState(false);

  // Edit-and-send dialog state. We let the rep tweak the AI draft
  // before firing — common pattern from the corrections flow.
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftText, setDraftText] = useState("");

  const runAnalysis = async (manualRefresh = false) => {
    if (manualRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const result = await api.getFollowUpAnalysis(lead.id);
      setAnalysis(result);
      if (result.status === "error") {
        toast.error(`Analysis failed: ${result.skip_reason || "unknown"}`);
      } else if (manualRefresh) {
        toast.success("Brief refreshed");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load follow-up brief");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    runAnalysis();
    // Intentional — we only auto-run on lead change, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead.id]);

  const handleSendReview = async () => {
    if (trainingModeOn) {
      toast.error("Training Mode is on — customer messages are blocked");
      return;
    }
    setSendingReview(true);
    try {
      const r = await api.sendReviewSms(lead.id);
      toast.success("Review SMS sent");
      // We don't refresh analysis here — the new outbound SMS will
      // show up in the SMS feed but doesn't change the talking points.
      console.info("Review SMS body:", r.message_sent);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't send review SMS");
    } finally {
      setSendingReview(false);
    }
  };

  const openDraftDialog = () => {
    if (trainingModeOn) {
      toast.error("Training Mode is on — customer messages are blocked");
      return;
    }
    setDraftText(analysis?.draft_followup_sms || "");
    setDraftOpen(true);
  };

  const handleSendDraft = async () => {
    const text = draftText.trim();
    if (!text) {
      toast.error("Message is empty");
      return;
    }
    setSendingFollowUp(true);
    try {
      await api.sendFollowUpSms(lead.id, text);
      toast.success("Follow-up SMS sent");
      setDraftOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't send follow-up SMS");
    } finally {
      setSendingFollowUp(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="p-8 flex items-center justify-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          Analyzing customer history…
        </CardContent>
      </Card>
    );
  }

  if (!analysis || analysis.status === "error") {
    return (
      <Card className="border-amber-500/40 bg-amber-500/5">
        <CardContent className="p-6 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0" />
          <div className="space-y-2 text-sm">
            <p className="font-semibold">Couldn't generate the brief</p>
            <p className="text-muted-foreground">
              {analysis?.skip_reason || "Unknown error"}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => runAnalysis(true)}
              disabled={refreshing}
            >
              {refreshing ? (
                <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3 mr-1.5" />
              )}
              Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const upsellPriorityIsExterior =
    (analysis.recommended_upsell.type || "").toLowerCase().includes("exterior");

  return (
    <div className="space-y-4">
      {/* Header card — source summary + refresh */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-sky-600" />
                Follow-up brief
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Based on {analysis.source_summary.transcripts} call transcript
                {analysis.source_summary.transcripts === 1 ? "" : "s"} +{" "}
                {analysis.source_summary.sms} text message
                {analysis.source_summary.sms === 1 ? "" : "s"}
                {analysis.source_summary.has_exterior_photos
                  ? " · exterior photos already on file"
                  : ""}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => runAnalysis(true)}
              disabled={refreshing}
            >
              {refreshing ? (
                <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3 mr-1.5" />
              )}
              Re-run
            </Button>
          </div>
        </CardHeader>
      </Card>

      {/* What they bought */}
      {analysis.what_they_bought && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <ThumbsUp className="h-4 w-4 text-emerald-600" />
              What they bought
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground pt-0">
            {analysis.what_they_bought}
          </CardContent>
        </Card>
      )}

      {/* Pain points raised during the sale */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            Pain points they raised
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {analysis.pain_points.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">
              None surfaced — start with a friendly check-in.
            </p>
          ) : (
            <ul className="space-y-2">
              {analysis.pain_points.map((p, i) => (
                <li key={i} className="text-sm flex gap-2">
                  <Quote className="h-3 w-3 text-amber-600 shrink-0 mt-1" />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Things they mentioned wanting */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <ShoppingCart className="h-4 w-4 text-sky-600" />
            Things they mentioned wanting later
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {analysis.things_mentioned.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">
              Nothing specific in the history.
            </p>
          ) : (
            <ul className="space-y-2">
              {analysis.things_mentioned.map((t, i) => (
                <li key={i} className="text-sm flex gap-2">
                  <Quote className="h-3 w-3 text-sky-600 shrink-0 mt-1" />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Recommended upsell */}
      {analysis.recommended_upsell.type && (
        <Card
          className={
            upsellPriorityIsExterior
              ? "border-sky-500/40 bg-gradient-to-br from-sky-500/5 to-cyan-500/5"
              : "border-slate-300"
          }
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-sky-600" />
              Recommended upsell
              <Badge
                variant="outline"
                className="ml-2 bg-sky-500/10 text-sky-700 border-sky-500/30 text-[10px]"
              >
                {analysis.recommended_upsell.type}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-2 text-sm">
            <p className="text-muted-foreground">
              <span className="font-semibold text-foreground">Why: </span>
              {analysis.recommended_upsell.why}
            </p>
            <p className="text-muted-foreground">
              <span className="font-semibold text-foreground">Hook: </span>
              {analysis.recommended_upsell.hook}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Suggested opening line */}
      {analysis.suggested_opening && (
        <Card className="border-emerald-500/40 bg-emerald-500/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <PhoneCall className="h-4 w-4 text-emerald-600" />
              Suggested opening line
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm pt-0 italic">
            "{analysis.suggested_opening}"
          </CardContent>
        </Card>
      )}

      {/* Action buttons */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Send something now</CardTitle>
        </CardHeader>
        <CardContent className="pt-0 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={handleSendReview}
            disabled={sendingReview || trainingModeOn}
            title={trainingModeOn ? "Training Mode is on" : ""}
          >
            {sendingReview ? (
              <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
            ) : (
              <Star className="h-3 w-3 mr-1.5" />
            )}
            Send Google review SMS
          </Button>
          <Button
            size="sm"
            onClick={openDraftDialog}
            disabled={trainingModeOn || !analysis.draft_followup_sms}
            title={trainingModeOn ? "Training Mode is on" : ""}
          >
            <MessageSquare className="h-3 w-3 mr-1.5" />
            Edit + send follow-up SMS
          </Button>
        </CardContent>
      </Card>

      {/* Draft SMS dialog — simple inline panel (matches the corrections
          flow elsewhere; we don't pull in Dialog primitives just for this). */}
      {draftOpen && (
        <Card className="border-sky-500/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Pencil className="h-4 w-4 text-sky-600" />
              Review + send follow-up SMS
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Edit before sending. {draftText.length} / 1600 characters.
            </p>
          </CardHeader>
          <CardContent className="pt-0 space-y-3">
            <textarea
              className="w-full min-h-[120px] rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              maxLength={1600}
            />
            <div className="flex gap-2 justify-end">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDraftOpen(false)}
                disabled={sendingFollowUp}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSendDraft}
                disabled={sendingFollowUp || !draftText.trim()}
              >
                {sendingFollowUp ? (
                  <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                ) : (
                  <MessageSquare className="h-3 w-3 mr-1.5" />
                )}
                Send to {lead.contact_phone || "customer"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
