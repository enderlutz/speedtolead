// Every priced lead in one of five buckets (Alan, 2026-11-01: "the big
// thing here is the bucket"). Call today = texted back or opened it in the
// last 14 days and nobody has talked to them since; Warm = priced in the
// last 60 days (one call, then a text with two real days); Cold = older (a
// reason-based text a month); Done = said no, did it themselves, hired
// someone, STOP; Customers = paid. A "looks done" read of their last text
// waits for a tap, never moves anyone by itself.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Loader2, Phone } from "lucide-react";
import { api, type BucketRow } from "@/lib/api";
import { cn, errMessage, formatCurrency, timeAgo } from "@/lib/utils";

type Key = "a" | "b" | "c" | "d" | "customers";
const TABS: { key: Key; short: string; title: string; sub: string; dot: string }[] = [
  { key: "a", short: "Call today", title: "Call today", sub: "Texted back or opened it in the last 14 days, and nobody has talked to them since. Texts first.", dot: "bg-rose-500" },
  { key: "b", short: "Warm", title: "Warm", sub: "Priced in the last 60 days. One call, then a text with two real days.", dot: "bg-amber-400" },
  { key: "c", short: "Cold", title: "Cold", sub: "Priced over 60 days ago. One text a month with a reason. A reply puts them in Call today.", dot: "bg-sky-400" },
  { key: "d", short: "Done", title: "Done", sub: "Said no, did it themselves, hired someone, or texted STOP. Never texted again.", dot: "bg-slate-400" },
  { key: "customers", short: "Paid", title: "Customers", sub: "Paid us. Review, then referral.", dot: "bg-emerald-500" },
];
const PAGE = 30;

export default function LeadBuckets() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.onCallBuckets>> | null>(null);
  const [tab, setTab] = useState<Key>(() => {
    try { const v = sessionStorage.getItem("oncall:bucket") as Key | null; return v && TABS.some((t) => t.key === v) ? v : "a"; } catch { return "a"; }
  });
  const [shown, setShown] = useState(PAGE);
  useEffect(() => { try { sessionStorage.setItem("oncall:bucket", tab); } catch { /* private mode */ } setShown(PAGE); }, [tab]);
  const load = useCallback(() => {
    api.onCallBuckets().then(setData).catch((e) => toast.error(errMessage(e, "Couldn't load the buckets")));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);
  if (!data) return <p className="text-sm text-muted-foreground"><Loader2 className="mr-1 inline h-4 w-4 animate-spin" />Sorting every lead…</p>;
  const t = TABS.find((x) => x.key === tab)!;
  const rows = data[tab];
  const hints = tab === "d" || tab === "customers" ? 0 : rows.filter((r) => r.hint).length;
  return (
    <div>
      <div className="mb-3 grid grid-cols-5 gap-1 rounded-xl bg-muted/60 p-1" role="tablist" aria-label="Buckets">
        {TABS.map((x) => (
          <button key={x.key} type="button" role="tab" aria-selected={tab === x.key} onClick={() => setTab(x.key)}
                  className={cn("flex min-h-12 flex-col items-center justify-center rounded-lg px-1 leading-tight", tab === x.key ? "bg-ink text-white shadow-sm" : "text-muted-foreground")}>
            <span className="text-sm font-bold">{x.short}</span>
            <span className={cn("text-sm tabular-nums", tab === x.key && "text-gold-light")}>{data[x.key].length}</span>
          </button>
        ))}
      </div>
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="border-b p-3">
          <p className="flex items-center gap-2 text-base font-semibold"><span className={cn("h-2.5 w-2.5 rounded-full", t.dot)} />{t.title} <span className="text-sm font-normal text-muted-foreground">({rows.length})</span></p>
          <p className="text-sm text-muted-foreground">{t.sub}</p>
          {hints ? <p className="mt-1 text-sm font-semibold text-amber-800">{hints} look done from their last text. Check those below.</p> : null}
        </div>
        {!rows.length ? <p className="p-6 text-center text-sm text-muted-foreground">Nothing here.</p> : null}
        {rows.slice(0, shown).map((r) => <BucketCard key={r.lead_id} r={r} bucket={tab} reasons={data.reasons} onChanged={load} />)}
        {rows.length > shown ? (
          <button type="button" onClick={() => setShown((n) => n + PAGE)} className="min-h-12 w-full border-t text-sm font-semibold text-primary hover:bg-muted">
            Show {Math.min(PAGE, rows.length - shown)} more ({rows.length - shown} left)
          </button>
        ) : null}
      </div>
    </div>
  );
}

function BucketCard({ r, bucket, reasons, onChanged }: { r: BucketRow; bucket: Key; reasons: Record<string, string>; onChanged: () => void }) {
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast.success(ok); onChanged(); }
    catch (e) { toast.error(errMessage(e, "Couldn't save that")); }
    finally { setBusy(false); setPicking(false); }
  };
  const open = bucket !== "d" && bucket !== "customers";
  return (
    <div className={cn("border-b px-3 py-3 last:border-b-0", r.hint && open && "bg-amber-50/70 dark:bg-amber-950/20")}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <Link to={`/leads/${r.lead_id}`} className="text-base font-semibold leading-tight underline-offset-2 hover:underline">{r.name || "No name"}</Link>
            {r.price ? <span className="text-sm font-semibold tabular-nums text-muted-foreground">{formatCurrency(r.price)}</span> : null}
          </div>
          <p className="text-sm font-semibold">{r.why}</p>
          {r.last_text ? (
            <p className="text-sm leading-snug text-muted-foreground">
              Last text {timeAgo(r.last_text_at)}: <span className="text-foreground">"{r.last_text}"</span>
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            {[r.sent_at ? `Priced ${timeAgo(r.sent_at)}` : "", r.viewed_at ? `opened ${timeAgo(r.viewed_at)}${r.views > 1 ? ` (${r.views}×)` : ""}` : "",
              r.last_talk ? `last talk ${timeAgo(r.last_talk)}` : "never talked", r.address].filter(Boolean).join(" · ")}
          </p>
          {bucket === "customers" ? (
            <p className="text-sm text-muted-foreground">Google review: {r.review === "posted" ? "✓ left one" : r.review === "not_yet" ? "not yet" : "not marked"}</p>
          ) : null}
        </div>
        {r.phone ? (
          <a href={`tel:${r.phone}`} aria-label={`Call ${r.name}`} title="Call"
             className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white hover:bg-emerald-700">
            <Phone className="h-5 w-5" />
          </a>
        ) : null}
      </div>

      {open && r.hint ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-amber-100/80 px-2.5 py-2 text-sm dark:bg-amber-900/30">
          <span className="font-semibold text-amber-900 dark:text-amber-200">Looks done: {reasons[r.hint] || "said no"}</span>
          <button type="button" disabled={busy} onClick={() => void act(() => api.bucketDone(r.lead_id, r.hint), "Moved to Done")}
                  className="min-h-11 rounded-md bg-ink px-3 font-bold text-white disabled:opacity-50">Yes, Done</button>
          <button type="button" disabled={busy} onClick={() => void act(() => api.bucketNotDone(r.lead_id, r.last_text_at), "Kept")}
                  className="min-h-11 rounded-md bg-white px-3 font-semibold ring-1 ring-border disabled:opacity-50 dark:bg-transparent">No, keep</button>
        </div>
      ) : null}

      {open && !r.hint ? (
        picking ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {Object.entries(reasons).map(([k, label]) => (
              <button key={k} type="button" disabled={busy} onClick={() => void act(() => api.bucketDone(r.lead_id, k), "Moved to Done")}
                      className="min-h-11 rounded-md bg-muted px-3 text-sm font-semibold hover:bg-muted/70 disabled:opacity-50">{label}</button>
            ))}
            <button type="button" onClick={() => setPicking(false)} className="min-h-11 px-2 text-sm text-muted-foreground">Cancel</button>
          </div>
        ) : (
          <button type="button" onClick={() => setPicking(true)} className="mt-1 min-h-11 text-sm font-semibold text-muted-foreground hover:text-foreground">Done with them…</button>
        )
      ) : null}

      {bucket === "d" && r.done && r.done.reason !== "stop" ? (
        <button type="button" disabled={busy} onClick={() => void act(() => api.bucketNotDone(r.lead_id), "Back in the lists")}
                className="mt-1 min-h-11 text-sm font-semibold text-muted-foreground hover:text-foreground disabled:opacity-50">
          Not done after all{r.done.by ? ` (marked by ${r.done.by})` : ""}
        </button>
      ) : null}
    </div>
  );
}
