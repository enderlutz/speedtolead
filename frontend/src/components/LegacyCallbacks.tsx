// Wanted Legacy on a call and didn't pay (Alan, 2026-11-08). Stella flags
// them from the calls; only Alan makes the offer: Legacy for the Signature
// price, if they get on the schedule in the next two weeks. Never on the
// first call, never by a VA. Each offer gets marked so the list shows what
// it closed.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Loader2, Phone } from "lucide-react";
import { api, type LegacyRow } from "@/lib/api";
import { cn, errMessage, formatCurrency, timeAgo } from "@/lib/utils";

type Data = Awaited<ReturnType<typeof api.legacyCallbacks>>;

export default function LegacyCallbacks() {
  const [data, setData] = useState<Data | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const load = useCallback(() => {
    api.legacyCallbacks().then(setData).catch((e) => toast.error(errMessage(e, "Couldn't load the Legacy list")));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (!data) return <p className="text-sm text-muted-foreground"><Loader2 className="mr-1 inline h-4 w-4 animate-spin" />Loading…</p>;
  const rows = showClosed ? data.closed : data.open;
  return (
    <div className="space-y-3">
      <div className="rounded-xl border bg-card p-3">
        <p className="text-base font-semibold">Wanted Legacy, didn't pay</p>
        <p className="text-sm text-muted-foreground">Stella finds them on the calls. You make the offer, nobody else, and never on the first call:</p>
        <p className="mt-1 text-base font-semibold">"{data.offer_line}"</p>
        <p className="mt-1 text-sm text-muted-foreground">The reason: the solid goes on faster for us and lasts longer for them.</p>
        <p className="mt-2 text-sm">
          Offers made: <span className="font-semibold tabular-nums">{data.offers}</span> · closed after an offer: <span className="font-semibold tabular-nums">{data.offers_closed}</span>
        </p>
      </div>
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted/60 p-1" role="tablist">
        {([[false, "To call", data.open.length], [true, "Paid since", data.closed.length]] as const).map(([v, label, n]) => (
          <button key={label} type="button" role="tab" aria-selected={showClosed === v} onClick={() => setShowClosed(v)}
                  className={cn("min-h-11 rounded-lg text-sm font-bold", showClosed === v ? "bg-ink text-white" : "text-muted-foreground")}>
            {label} <span className="tabular-nums">{n}</span>
          </button>
        ))}
      </div>
      <div className="overflow-hidden rounded-xl border bg-card">
        {!rows.length ? <p className="p-6 text-center text-sm text-muted-foreground">{showClosed ? "Nobody yet." : "Nobody to call. Stella is still reading calls if this is the first day."}</p> : null}
        {rows.map((r) => <LegacyCard key={r.lead_id} r={r} outcomes={data.outcomes} open={!showClosed} onChanged={load} />)}
      </div>
    </div>
  );
}

function LegacyCard({ r, outcomes, open, onChanged }: { r: LegacyRow; outcomes: Record<string, string>; open: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const mark = async (outcome: string) => {
    setBusy(true);
    try { await api.legacyOffer(r.lead_id, outcome); toast.success(outcomes[outcome] || "Saved"); onChanged(); }
    catch (e) { toast.error(errMessage(e, "Couldn't save that")); }
    finally { setBusy(false); }
  };
  return (
    <div className="border-b px-3 py-3 last:border-b-0">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Link to={`/leads/${r.lead_id}`} className="text-base font-semibold leading-tight underline-offset-2 hover:underline">{r.name || "No name"}</Link>
          {r.signature || r.legacy ? (
            <p className="text-sm tabular-nums">Signature {formatCurrency(r.signature)} · Legacy {formatCurrency(r.legacy)}</p>
          ) : null}
          {r.quote ? <p className="text-sm leading-snug">"{r.quote}"</p> : null}
          <p className="text-sm text-muted-foreground">{[r.call_at ? `Call ${timeAgo(r.call_at)}` : "", r.address].filter(Boolean).join(" · ")}</p>
          {r.offer ? <p className="text-sm font-semibold">{outcomes[r.offer.outcome] || r.offer.outcome} {timeAgo(r.offer.at)}</p> : null}
        </div>
        {r.phone ? (
          <a href={`tel:${r.phone}`} aria-label={`Call ${r.name}`} title="Call"
             className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white hover:bg-emerald-700">
            <Phone className="h-5 w-5" />
          </a>
        ) : null}
      </div>
      {open ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {Object.entries(outcomes).map(([k, label]) => (
            <button key={k} type="button" disabled={busy || r.offer?.outcome === k} onClick={() => void mark(k)}
                    className={cn("min-h-11 rounded-md px-3 text-sm font-semibold disabled:opacity-50",
                                  r.offer?.outcome === k ? "bg-ink text-white" : "bg-muted hover:bg-muted/70")}>
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
