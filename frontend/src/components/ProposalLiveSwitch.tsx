// The lead's latest proposal as the interactive page: the per-send switch
// (admin only, Alan and Fragne), the link, the 30-day price window, and
// the "extend the quoted price" button the office uses when they decide to
// give a late customer the old price (Alan, 2026-10-11: "your decision,
// per customer, logged").
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy, Sparkles, CalendarPlus, Eye } from "lucide-react";
import { api, getCurrentUser, type ProposalLiveState } from "@/lib/api";
import { cn } from "@/lib/utils";

function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function ProposalLiveSwitch({ leadId }: { leadId: string }) {
  const [state, setState] = useState<ProposalLiveState | null>(null);
  const [busy, setBusy] = useState(false);
  const isAdmin = getCurrentUser()?.role === "admin";

  const load = useCallback(() => {
    api.getProposalLive(leadId).then(setState).catch(() => setState(null));
  }, [leadId]);
  useEffect(() => { load(); }, [load]);

  const p = state?.proposal;
  if (!p) return null;

  const flip = async () => {
    setBusy(true);
    try {
      setState(await api.setProposalInteractive(leadId, !p.interactive));
      toast.success(p.interactive ? "Back to the PDF proposal" : "Their link now opens the interactive proposal");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't switch");
    } finally {
      setBusy(false);
    }
  };
  const extend = async () => {
    setBusy(true);
    try {
      const next = await api.extendProposalPrice(leadId, 7);
      setState(next);
      toast.success(`Quoted price now good through ${when(next.proposal?.good_through)}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't extend");
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(p.url);
      toast.success("Proposal link copied");
    } catch {
      toast.error("Couldn't copy. The link is in the address bar when you open it.");
    }
  };

  return (
    <div className={cn("rounded-xl p-3 ring-1", p.interactive ? "bg-amber-50 ring-amber-300" : "bg-muted/40 ring-border")}>
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className={cn("h-4 w-4", p.interactive ? "text-amber-600" : "text-muted-foreground")} />
        <p className="text-sm font-semibold">
          {p.interactive ? "Interactive proposal is on" : "PDF proposal"}
          <span className="ml-2 text-xs font-normal text-muted-foreground">{p.number}</span>
        </p>
        <div className="ml-auto flex items-center gap-1.5">
          {p.interactive ? (
            <button type="button" onClick={copy} className="inline-flex h-7 items-center gap-1 rounded-md bg-white px-2 text-xs font-semibold ring-1 ring-border hover:bg-muted">
              <Copy className="h-3 w-3" /> Copy link
            </button>
          ) : null}
          {isAdmin ? (
            <button type="button" onClick={flip} disabled={busy}
              className={cn("h-7 rounded-md px-2.5 text-xs font-bold", p.interactive ? "bg-white text-amber-800 ring-1 ring-amber-300 hover:bg-amber-100" : "bg-amber-500 text-white hover:bg-amber-600")}>
              {p.interactive ? "Switch to PDF" : "Switch to interactive"}
            </button>
          ) : null}
        </div>
      </div>
      {p.interactive ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className={cn("font-semibold", p.expired ? "text-rose-600" : "text-emerald-700")}>
            {p.expired ? `Quoted price ended ${when(p.good_through)}` : `Quoted price good through ${when(p.good_through)}`}
            {p.extended_until ? " (extended)" : ""}
          </span>
          <span className="inline-flex items-center gap-1"><Eye className="h-3 w-3" /> {p.view_count} {p.view_count === 1 ? "view" : "views"}{p.last_viewed_at ? `, last ${when(p.last_viewed_at)}` : ""}</span>
          <button type="button" onClick={extend} disabled={busy} className="inline-flex h-7 items-center gap-1 rounded-md bg-white px-2 font-semibold text-foreground ring-1 ring-border hover:bg-muted">
            <CalendarPlus className="h-3 w-3" /> Extend quoted price 7 days
          </button>
        </div>
      ) : null}
    </div>
  );
}
