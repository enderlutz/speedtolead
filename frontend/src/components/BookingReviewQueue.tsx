/**
 * The quick $250s, for a look-over (Alan, 2026-10-27): "we'll go in and
 * just review it and make sure everything's correct." Every one Olga sends
 * lands here, paid or not, with the day, package and colour the call gave
 * us and what's still missing. Looks right takes it off the list; paying
 * brings it back once, so someone sees what went to the customer. Hidden
 * when there's nothing to review.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { CalendarCheck, Check, Loader2 } from "lucide-react";
import { api, type BookingReviewRow } from "@/lib/api";
import { cn, errMessage, formatCurrency } from "@/lib/utils";

function ago(iso: string): string {
  const t = new Date(iso).getTime();
  if (!iso || !Number.isFinite(t)) return "";
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 60) return m <= 1 ? "just now" : `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export function BookingReviewQueue() {
  const [rows, setRows] = useState<BookingReviewRow[] | null>(null);
  const [busy, setBusy] = useState("");
  const load = useCallback(() => api.getBookingReviewQueue().then((r) => setRows(r.rows)).catch(() => setRows([])), []);
  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(id);
  }, [load]);
  const ok = async (r: BookingReviewRow) => {
    setBusy(r.lead_id);
    try { await api.markBookingReviewed(r.lead_id, true); toast.success(`${r.name || "That one"}: looks right`); await load(); }
    catch (e) { toast.error(errMessage(e, "Couldn't save that")); }
    finally { setBusy(""); }
  };
  if (!rows?.length) return null;

  return (
    <section className="space-y-3 rounded-2xl border border-[#C9972F]/50 bg-white p-4" aria-label="Quick $250s to review">
      <div>
        <p className="flex items-center gap-2 text-[17px] font-bold text-[#1F1A14]">
          <CalendarCheck className="h-5 w-5 text-[#8C6224]" />Quick $250s to review
          <span className="rounded-full bg-[#C9972F]/20 px-2 text-[13px] font-bold text-[#8C6224]">{rows.length}</span>
        </p>
        <p className="text-[14px] text-[#6B6052]">The one-tap $250s. Check the day, package and colour on each. When they pay, the calendar invite goes to the customer by itself.</p>
      </div>
      <div className="space-y-2">
        {rows.map((r) => {
          const paid = r.status === "paid";
          const held = r.held;
          return (
            <div key={r.lead_id} className="flex flex-wrap items-start gap-3 rounded-xl bg-[#FBF8F2] p-3 ring-1 ring-[#E4DCCB]">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="flex flex-wrap items-center gap-2">
                  <Link to={`/leads/${r.lead_id}`} className="text-[16px] font-bold text-[#1F1A14] hover:underline">{r.name || "(no name)"}</Link>
                  <span className={cn("rounded-full px-2 py-0.5 text-[12px] font-bold uppercase tracking-wide",
                    paid ? "bg-emerald-100 text-emerald-800" : "bg-[#C9972F]/20 text-[#8C6224]")}>
                    {paid ? `Paid ${ago(r.paid_at)}` : `$250 sent ${ago(r.sent_at)}`}
                  </span>
                  {r.sent_by ? <span className="text-[13px] text-[#6B6052]">by {r.sent_by}</span> : null}
                </p>
                <p className="text-[15px] text-[#1F1A14]">
                  {held
                    ? <>Holding <b>{held.day}</b>{held.tier ? ` · ${held.tier}` : ""}{held.color ? ` · ${held.color}` : ""}{held.total ? ` · ${formatCurrency(held.total)}` : ""}</>
                    : "No day held yet"}
                </p>
                {r.missing.length ? <p className="text-[14px] font-semibold text-amber-800">Still needs: {r.missing.join(", ")}. Set it on the lead's booking card.</p> : null}
                {paid ? (
                  <p className="text-[14px] text-[#6B6052]">
                    {held?.shared ? "Confirmed. Their invite and booking page went out." : r.missing.length ? "Paid; the invite goes out once the day and package are set." : "Paid; confirmation on its way."}
                    {r.no_email ? " No email on file, so the calendar invite can't reach them; they got the text." : ""}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Link to={`/leads/${r.lead_id}`} className="inline-flex min-h-11 items-center rounded-xl border border-[#E4DCCB] bg-white px-3 text-[14px] font-bold text-[#1F1A14] hover:bg-[#F8F3E7]">Open the lead</Link>
                <button type="button" disabled={busy === r.lead_id} onClick={() => void ok(r)}
                        className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-[#1F1A14] px-3 text-[14px] font-bold text-white hover:bg-black disabled:opacity-50">
                  {busy === r.lead_id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Looks right
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
