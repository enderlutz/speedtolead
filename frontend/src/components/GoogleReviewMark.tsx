// Did they leave the Google review? (Alan, 2026-10-31: "I just like to mark
// if that customer left a review or not", and the second ask is a button,
// "Remind for review", with a text he edits before it goes. Never automatic:
// "if it's done on a certain basis, it's gonna not be done right".)
// Sits on the Paid & closed card in the Invoice Queue and on the lead page.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Loader2, Send, Star, X } from "lucide-react";
import { api, type GoogleReviewState, type GoogleReviewStatus, type GoogleReviewSummary } from "@/lib/api";
import { cn, errMessage } from "@/lib/utils";

function ago(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" });
}

export function GoogleReviewMark({ leadId, summary, onChanged, compact }: {
  leadId: string;
  /** What the list already knows, so the row shows without a fetch. */
  summary?: GoogleReviewSummary | null;
  onChanged?: () => void;
  /** Tighter chips for the queue card. */
  compact?: boolean;
}) {
  const [s, setS] = useState<GoogleReviewState | null>(null);
  const [status, setStatus] = useState<GoogleReviewStatus>(summary?.status || "");
  const [reminded, setReminded] = useState(summary?.reminded || 0);
  const [clicked, setClicked] = useState(!!summary?.clicked);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState("");

  const load = async () => {
    const r = await api.reviewState(leadId);
    setS(r); setStatus(r.status); setReminded(r.reminders.length); setClicked(r.clicked);
    return r;
  };
  useEffect(() => {
    if (summary) { setStatus(summary.status); setReminded(summary.reminded); setClicked(summary.clicked); return; }
    load().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  const mark = async (next: GoogleReviewStatus) => {
    const to = status === next ? "" : next;
    setBusy(next || "clear");
    try {
      const r = await api.setReviewStatus(leadId, to);
      setS(r); setStatus(r.status);
      if (to === "posted") setOpen(false);
      onChanged?.();
    } catch (e) { toast.error(errMessage(e, "Couldn't save the mark")); } finally { setBusy(""); }
  };

  const openRemind = async () => {
    if (open) { setOpen(false); return; }
    setBusy("open");
    try {
      const r = s ?? await load();
      setText(r.draft);
      setOpen(true);
    } catch (e) { toast.error(errMessage(e, "Couldn't load the text")); } finally { setBusy(""); }
  };

  const send = async () => {
    setBusy("send");
    try {
      const r = await api.sendReviewReminder(leadId, text);
      setS(r); setReminded(r.reminders.length);
      toast.success("Review reminder sent");
      setOpen(false);
      onChanged?.();
    } catch (e) { toast.error(errMessage(e, "Couldn't send it")); } finally { setBusy(""); }
  };

  const chip = "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold transition-colors disabled:opacity-50";
  return (
    <div className={cn("space-y-2", compact ? "" : "rounded-xl border border-border bg-background p-3")}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-[#6B6052]"><Star className="h-3.5 w-3.5" /> Google review</span>
        <button type="button" onClick={() => mark("posted")} disabled={!!busy}
                className={cn(chip, status === "posted" ? "border-emerald-600 bg-emerald-600 text-white" : "border-[#E4DCCB] bg-white text-[#1F1A14] hover:bg-[#F8F3E7]")}>
          {busy === "posted" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Left a review
        </button>
        <button type="button" onClick={() => mark("not_yet")} disabled={!!busy}
                className={cn(chip, status === "not_yet" ? "border-amber-500 bg-amber-500 text-white" : "border-[#E4DCCB] bg-white text-[#1F1A14] hover:bg-[#F8F3E7]")}>
          {busy === "not_yet" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />} Not yet
        </button>
        {status !== "posted" ? (
          <button type="button" onClick={openRemind} disabled={!!busy}
                  className={cn(chip, "border-[#1F1A14] bg-[#1F1A14] text-white hover:bg-[#3A3128]")}>
            {busy === "open" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Remind for review
          </button>
        ) : null}
        <span className="text-[12px] text-[#6B6052]">
          {clicked ? "Tapped the Google button" : "Hasn't tapped the Google button"}
          {reminded ? ` · reminded ${reminded}×` : ""}
          {status && s?.marked_at ? ` · marked ${ago(s.marked_at)}${s.marked_by ? ` by ${s.marked_by.split(" ")[0]}` : ""}` : ""}
        </span>
      </div>
      {open ? (
        <div className="space-y-2 rounded-xl border border-[#E4DCCB] bg-[#FBF8F2] p-3">
          <p className="text-[14px] font-semibold text-[#1F1A14]">Your text. Change anything, then send.</p>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4}
                    className="w-full resize-y rounded-lg border border-[#E4DCCB] bg-white px-3 py-2 text-[15px] text-[#1F1A14]" />
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={send} disabled={!!busy || !text.trim()}
                    className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-[#1F1A14] px-4 text-[14px] font-bold text-white hover:bg-[#3A3128] disabled:opacity-50">
              {busy === "send" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send the text
            </button>
            <button type="button" onClick={() => setOpen(false)} disabled={busy === "send"}
                    className="inline-flex min-h-10 items-center rounded-xl border border-[#E4DCCB] bg-white px-4 text-[14px] font-semibold text-[#1F1A14] hover:bg-[#F8F3E7]">Cancel</button>
          </div>
          {!s?.after_url ? <p className="text-[12px] text-amber-700">No paid final bill on this job, so the text has no photos link. It still sends.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
