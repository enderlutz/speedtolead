import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { api, type EstimateDelayRow } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { AlertTriangle, X, Clock } from "lucide-react";

const REASON_LABELS: Record<string, string> = {
  customer_wants_inperson: "Customer wants in-person quote",
  no_response_from_customer: "No response from customer",
  need_more_info: "Need more info from customer",
  pricing_question_pending: "Pricing question pending",
  address_issue: "Address issue",
  other: "Other (specify)",
};

/**
 * Blocking modal — shown on the dashboard whenever any leads are >24h
 * without an estimate AND no reason has been logged yet. One row at a time;
 * each gets its own card. Dismisses automatically once the reason is in.
 *
 * Sticky pulse: re-fetches every minute (in case background detector creates
 * a new delay while user is sitting on the page).
 */
export function EstimateDelayBlocker() {
  const navigate = useNavigate();
  const [delays, setDelays] = useState<EstimateDelayRow[]>([]);
  const [presetReasons, setPresetReasons] = useState<string[]>([]);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.listOpenDelays()
      .then((r) => {
        // Only show ones that don't yet have a reason logged
        const pending = r.delays.filter((d) => !d.reason_added_at);
        setDelays(pending);
        setPresetReasons(r.preset_reasons || []);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (delays.length === 0) return null;

  const submitReason = async (d: EstimateDelayRow) => {
    const code = picked[d.id];
    if (!code) {
      toast.error("Pick a reason first");
      return;
    }
    if (code === "other" && !(otherText[d.id] || "").trim()) {
      toast.error("Describe the reason in the text box");
      return;
    }
    setSavingId(d.id);
    try {
      await api.setDelayReason(d.lead_id, {
        reason_code: code,
        reason_other_text: code === "other" ? otherText[d.id] : "",
      });
      toast.success("Reason logged. Alan has been texted.");
      refresh();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-background rounded-xl shadow-2xl max-w-lg w-full my-8">
        <div className="p-4 border-b bg-red-50 rounded-t-xl">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-red-600" />
            <h2 className="text-base font-bold text-red-900">
              {delays.length} lead{delays.length === 1 ? "" : "s"} past 24h without an estimate
            </h2>
          </div>
          <p className="text-xs text-red-800 mt-1">
            Internal emergency. Pick a reason so Alan knows what's holding it up. This box won't go away until done.
          </p>
        </div>
        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {delays.map((d) => (
            <div key={d.id} className="border rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <button
                  onClick={() => navigate(`/leads/${d.lead_id}`)}
                  className="text-sm font-semibold text-primary hover:underline truncate"
                >
                  {d.lead_name || "Lead"}
                </button>
                {d.lead_phone && (
                  <span className="text-xs text-muted-foreground font-mono">{d.lead_phone}</span>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Detected {new Date(d.detected_at).toLocaleString()}
              </p>
              <div>
                <label className="text-xs font-semibold text-muted-foreground">Why hasn't this gotten an estimate?</label>
                <select
                  value={picked[d.id] || ""}
                  onChange={(e) => setPicked({ ...picked, [d.id]: e.target.value })}
                  className="w-full mt-1 border border-input rounded-md px-3 py-2 text-sm bg-background"
                >
                  <option value="">— pick a reason —</option>
                  {presetReasons.map((code) => (
                    <option key={code} value={code}>{REASON_LABELS[code] || code}</option>
                  ))}
                </select>
                {picked[d.id] === "other" && (
                  <input
                    value={otherText[d.id] || ""}
                    onChange={(e) => setOtherText({ ...otherText, [d.id]: e.target.value })}
                    placeholder="Describe the reason"
                    className="w-full mt-2 border border-input rounded-md px-3 py-2 text-sm bg-background"
                  />
                )}
              </div>
              <div className="flex justify-end">
                <Button size="sm" onClick={() => submitReason(d)} disabled={savingId === d.id}>
                  {savingId === d.id ? "Saving…" : "Log reason"}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}


/**
 * Lead-detail-page version: shows the badge if a delay is logged for this
 * lead, lets you record/clear the reason inline (no blocking modal). Used
 * inside LeadDetail.
 */
export function LeadDelayPanel({ leadId, onChange }: { leadId: string; onChange?: () => void }) {
  const [delay, setDelay] = useState<EstimateDelayRow | null>(null);
  const [presetReasons, setPresetReasons] = useState<string[]>([]);
  const [reasonCode, setReasonCode] = useState("");
  const [otherText, setOtherText] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(() => {
    api.getLeadDelay(leadId)
      .then((r) => {
        setDelay(r.delay);
        if (r.preset_reasons) setPresetReasons(r.preset_reasons);
        if (r.delay) {
          setReasonCode(r.delay.reason_code || "");
          setOtherText(r.delay.reason_other_text || "");
        }
      })
      .catch(() => {});
  }, [leadId]);

  useEffect(() => { refresh(); }, [refresh]);

  if (!delay || delay.is_resolved) return null;

  const save = async () => {
    if (!reasonCode) { toast.error("Pick a reason"); return; }
    if (reasonCode === "other" && !otherText.trim()) { toast.error("Describe the reason"); return; }
    setSaving(true);
    try {
      await api.setDelayReason(leadId, { reason_code: reasonCode, reason_other_text: otherText });
      toast.success("Reason logged. Alan has been texted.");
      setEditing(false);
      refresh();
      onChange?.();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    if (!confirm("Remove the 24h badge from this lead?")) return;
    try {
      await api.clearDelayBadge(leadId);
      toast.success("Badge removed");
      refresh();
      onChange?.();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  const hasReason = !!delay.reason_added_at;

  return (
    <div className="rounded-lg border-2 border-red-300 bg-red-50 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-red-600 shrink-0" />
        <p className="text-sm font-semibold text-red-900">24h+ without estimate</p>
        <Badge className="bg-red-200 text-red-900 text-[10px]">Internal emergency</Badge>
        <button
          onClick={clear}
          className="ml-auto text-red-800 hover:text-red-900 p-1"
          title="Remove badge (situation resolved)"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {hasReason && !editing ? (
        <div className="text-xs text-red-900">
          <span className="font-semibold">Reason: </span>
          {delay.reason_code === "other"
            ? delay.reason_other_text
            : (REASON_LABELS[delay.reason_code] || delay.reason_code)}
          <button onClick={() => setEditing(true)} className="ml-2 underline text-red-700 hover:text-red-900">
            Change
          </button>
          {delay.reason_added_by && (
            <span className="ml-2 text-red-600">· by {delay.reason_added_by}</span>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <select
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value)}
            className="w-full border border-red-300 rounded-md px-3 py-2 text-sm bg-white"
          >
            <option value="">— pick a reason —</option>
            {presetReasons.map((code) => (
              <option key={code} value={code}>{REASON_LABELS[code] || code}</option>
            ))}
          </select>
          {reasonCode === "other" && (
            <input
              value={otherText}
              onChange={(e) => setOtherText(e.target.value)}
              placeholder="Describe the reason"
              className="w-full border border-red-300 rounded-md px-3 py-2 text-sm bg-white"
            />
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Log reason"}
            </Button>
            {editing && <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
          </div>
        </div>
      )}
    </div>
  );
}
