// The Invoice Queue (Alan, 2026-10-23): every customer with money in motion,
// in five stages. A job moves on its own: the $250 gets paid, the crew taps
// "I'm finished" (the main trigger: a finished job is Ready for invoice even
// when the $250 never came in), the bill goes out, the bill gets paid. The
// bill is made with the same invoice builder as the lead page, opened right
// here on the card; anything paid another way is closed out by hand.
import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { CheckCircle2, ChevronDown, ChevronUp, ExternalLink, Eye, Hammer, Loader2, Phone, ReceiptText, RefreshCw, RotateCcw, Send, Wallet, X } from "lucide-react";
import { api, type InvoiceQueueResponse, type InvoiceQueueRow, type InvoiceStageKey } from "@/lib/api";
import { StripeLinksCard } from "@/components/StripeLinksCard";
import { cn, errMessage, formatCurrency } from "@/lib/utils";

const STAGES: { key: InvoiceStageKey; label: string; short: string; money: string; empty: string; icon: React.ElementType }[] = [
  { key: "deposit_sent", label: "Deposit sent, not paid", short: "Deposit sent", money: "in jobs", empty: "No $250 links waiting.", icon: Send },
  { key: "deposit_paid", label: "Deposit paid, waiting on the job", short: "Waiting on job", money: "still to collect", empty: "Nobody paid and waiting.", icon: Hammer },
  { key: "ready", label: "Ready for invoice", short: "Ready for invoice", money: "to bill", empty: "No finished jobs waiting on a bill.", icon: ReceiptText },
  { key: "invoice_sent", label: "Invoice sent, waiting on money", short: "Invoice sent", money: "out", empty: "No bills waiting to be paid.", icon: Wallet },
  { key: "closed", label: "Paid & closed (last 60 days)", short: "Paid & closed", money: "collected", empty: "Nothing closed in the last 60 days.", icon: CheckCircle2 },
];

const usd = (n: number) => formatCurrency(Math.round(n));

function ago(iso: string): string {
  const t = new Date(iso).getTime();
  if (!iso || !Number.isFinite(t)) return "";
  const d = Math.floor((Date.now() - t) / 86_400_000);
  if (d <= 0) {
    const h = Math.floor((Date.now() - t) / 3_600_000);
    return h <= 0 ? "just now" : `${h}h ago`;
  }
  return d === 1 ? "yesterday" : `${d} days ago`;
}

function day(ymd: string): string {
  if (!ymd) return "";
  const d = new Date(`${ymd.slice(0, 10)}T12:00:00`);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : ymd;
}

function Chip({ tone, children }: { tone: "ink" | "gold" | "green" | "red" | "muted"; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[13px] font-semibold",
      tone === "ink" && "bg-[#1F1A14] text-white",
      tone === "gold" && "bg-[#C9972F]/15 text-[#8C6224]",
      tone === "green" && "bg-emerald-50 text-emerald-800",
      tone === "red" && "bg-red-50 text-red-700",
      tone === "muted" && "bg-[#F3EEE4] text-[#6B6052]")}>
      {children}
    </span>
  );
}

function Row({ r, closeHow, onChanged }: { r: InvoiceQueueRow; closeHow: { key: string; label: string }[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState("");
  const street = r.address.split(",")[0];

  const close = async (how: string) => {
    setBusy(how);
    try {
      await api.invoiceQueueClose(r.lead_id, how);
      toast.success(`${r.name} moved to Paid & closed`);
      onChanged();
    } catch (e) { toast.error(errMessage(e, "Couldn't close it out")); } finally { setBusy(""); setClosing(false); }
  };
  const reopen = async () => {
    setBusy("reopen");
    try { await api.invoiceQueueReopen(r.lead_id); onChanged(); }
    catch (e) { toast.error(errMessage(e, "Couldn't reopen it")); } finally { setBusy(""); }
  };
  // Not going ahead (Alan, 2026-10-26, Clarence): the $250 link stops
  // working, the held day comes off the calendar, and the card leaves the list.
  const notGoingAhead = async () => {
    if (!r.deposit_link) return;
    if (!window.confirm(`${r.name} isn't going ahead? Their $250 link stops working${r.booked_date ? " and their held day comes off the calendar" : ""}. Nothing is sent to them.`)) return;
    setBusy("void");
    try {
      await api.voidPayLink(r.deposit_link.token);
      if (r.booked_date) await api.cancelBooking(r.lead_id);
      toast.success(`${r.name} taken off the list`);
      onChanged();
    } catch (e) { toast.error(errMessage(e, "Couldn't take it off")); } finally { setBusy(""); }
  };
  const markDone = async () => {
    if (!window.confirm(`Mark ${r.name}'s job as finished? It moves to Ready for invoice and Alan and Olga get the text.`)) return;
    setBusy("done");
    try { await api.markCompanyCamDone(r.lead_id); onChanged(); }
    catch (e) { toast.error(errMessage(e, "Couldn't mark it finished")); } finally { setBusy(""); }
  };

  // The big number on the right and what it means for this stage.
  const [amount, amountLabel] =
    r.stage === "deposit_sent" ? [r.total, r.total_source === "guess" ? "job total, about" : "job total"]
    : r.stage === "closed" ? [r.paid, "collected"]
    : r.stage === "invoice_sent" ? [r.due, "on the bill"]
    : [r.due, r.stage === "ready" ? "left to bill" : "left after the job"];

  const views = (n: number) => n ? <Chip tone="gold"><Eye className="h-3.5 w-3.5" /> Opened {n}×</Chip> : <Chip tone="muted">Not opened yet</Chip>;
  const btn = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-4 text-[15px] font-bold transition-colors disabled:opacity-50";

  return (
    <div className={cn("rounded-2xl border bg-white shadow-sm", r.stage === "ready" ? "border-[#C9972F]/60" : "border-[#E4DCCB]")}>
      <div className="flex items-start gap-3 p-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Link to={`/leads/${r.lead_id}`} className="block truncate text-[17px] font-bold text-[#1F1A14] hover:underline">{r.name}</Link>
          {street ? <p className="truncate text-[15px] text-[#6B6052]">{street}</p> : null}
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {r.stage === "deposit_sent" && r.deposit_link ? (
              <>
                <Chip tone={r.deposit_link.expired ? "red" : "muted"}>
                  {r.deposit_link.expired ? "Link expired" : r.deposit_link.sent_at ? `Texted ${ago(r.deposit_link.sent_at)}` : `Made ${ago(r.deposit_link.created_at)}`}
                </Chip>
                {views(r.deposit_link.view_count)}
                {r.booked_date ? <Chip tone="muted">Aiming for {day(r.booked_date)}</Chip> : null}
              </>
            ) : null}
            {r.quick ? <Chip tone="muted">Quick $250</Chip> : null}
            {r.total_source === "guess" ? <Chip tone="gold">≈ {usd(r.total)} · {r.total_why}</Chip> : null}
            {r.total_source === "texted" ? <Chip tone="ink">{r.total_why}: {usd(r.total)}</Chip> : null}
            {r.stage === "deposit_paid" ? (
              <>
                <Chip tone="green">{r.paid_in_full_up_front ? "Paid in full" : `$250 paid`}</Chip>
                {r.booked_date ? <Chip tone="ink">Job {day(r.booked_date)}</Chip> : <Chip tone="muted">No date yet</Chip>}
              </>
            ) : null}
            {r.stage === "ready" ? (
              <>
                <Chip tone="ink">Finished {ago(r.done_at)}{r.done_by ? ` · ${r.done_by}` : ""}</Chip>
                {r.deposit === "paid" ? <Chip tone="green">$250 paid</Chip> : <Chip tone="red">No deposit paid</Chip>}
                {r.extras ? <Chip tone="gold">Extras {r.extras > 0 ? "+" : "−"}{usd(Math.abs(r.extras))}</Chip> : null}
                {r.bill ? <Chip tone="gold">Bill made {ago(r.bill.created_at)}, not texted</Chip> : null}
              </>
            ) : null}
            {r.stage === "invoice_sent" && r.bill ? (
              <>
                <Chip tone="muted">{r.bill.sent_at ? `Texted ${ago(r.bill.sent_at)}` : `Made ${ago(r.bill.created_at)}, not texted`}</Chip>
                {views(r.bill.view_count)}
              </>
            ) : null}
            {r.stage === "closed" ? (
              <Chip tone="green">
                {r.closed_at ? `Closed ${ago(r.closed_at)} · ${r.closed_how}` : `Paid ${ago(r.when)} · Stripe`}
              </Chip>
            ) : null}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[22px] font-bold tabular-nums text-[#1F1A14]">{amount ? usd(amount) : "—"}</div>
          <div className="text-[13px] text-[#6B6052]">{amount ? amountLabel : "no price on file"}</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-[#E4DCCB] px-4 py-3">
        {r.stage === "ready" || r.stage === "invoice_sent" ? (
          <button type="button" onClick={() => setOpen((v) => !v)}
                  className={cn(btn, "bg-[#1F1A14] text-white hover:bg-[#3A3128]")}>
            <ReceiptText className="h-4 w-4" /> {r.stage === "ready" && !r.bill ? "Make the bill" : "See the bill"}
            {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        ) : null}
        {r.stage === "deposit_paid" ? (
          <button type="button" onClick={markDone} disabled={!!busy}
                  className={cn(btn, "border border-[#E4DCCB] bg-white text-[#1F1A14] hover:bg-[#F8F3E7]")}>
            {busy === "done" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Hammer className="h-4 w-4" />} Job finished
          </button>
        ) : null}
        {r.stage === "deposit_sent" && r.deposit_link ? (
          <button type="button" onClick={notGoingAhead} disabled={!!busy}
                  className={cn(btn, "border border-[#E4DCCB] bg-white text-[#9B2C2C] hover:bg-[#FBEBEB]")}>
            {busy === "void" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Not going ahead
          </button>
        ) : null}
        {r.stage !== "closed" && r.stage !== "deposit_sent" ? (
          <button type="button" onClick={() => setClosing((v) => !v)} disabled={!!busy}
                  className={cn(btn, "border border-[#E4DCCB] bg-white text-[#1F1A14] hover:bg-[#F8F3E7]")}>
            <Wallet className="h-4 w-4" /> Paid another way
          </button>
        ) : null}
        {r.stage === "closed" && r.closed_at ? (
          <button type="button" onClick={reopen} disabled={!!busy}
                  className={cn(btn, "border border-[#E4DCCB] bg-white text-[#1F1A14] hover:bg-[#F8F3E7]")}>
            {busy === "reopen" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} Reopen
          </button>
        ) : null}
        {r.phone ? (
          <a href={`tel:${r.phone}`} className={cn(btn, "border border-[#E4DCCB] bg-white text-[#1F1A14] hover:bg-[#F8F3E7]")}>
            <Phone className="h-4 w-4" /> Call
          </a>
        ) : null}
        <Link to={`/leads/${r.lead_id}`} className={cn(btn, "text-[#8C6224] hover:bg-[#F8F3E7]")}>
          <ExternalLink className="h-4 w-4" /> Lead
        </Link>
      </div>

      {closing ? (
        <div className="space-y-2 border-t border-[#E4DCCB] bg-[#FBF8F2] px-4 py-3">
          <p className="text-[15px] font-semibold text-[#1F1A14]">How did they pay?</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {closeHow.map((h) => (
              <button key={h.key} type="button" onClick={() => close(h.key)} disabled={!!busy}
                      className={cn(btn, "border border-[#E4DCCB] bg-white text-[#1F1A14] hover:bg-[#F8F3E7]")}>
                {busy === h.key ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {h.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {open ? (
        <div className="border-t border-[#E4DCCB] p-3">
          <StripeLinksCard leadId={r.lead_id} startInvoice />
        </div>
      ) : null}
    </div>
  );
}

export default function InvoiceQueue() {
  const [data, setData] = useState<InvoiceQueueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [params, setParams] = useSearchParams();
  const stage = (params.get("stage") as InvoiceStageKey | null) || "ready";

  const load = useCallback(async () => {
    try {
      setData(await api.invoiceQueue());
    } catch (e) {
      toast.error(errMessage(e, "Couldn't load the Invoice Queue"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const pick = (k: InvoiceStageKey) => setParams((p) => { const n = new URLSearchParams(p); n.set("stage", k); return n; }, { replace: true });
  const current = data?.stages.find((s) => s.key === stage);
  const meta = STAGES.find((s) => s.key === stage) || STAGES[2];

  return (
    <div className="mx-auto max-w-5xl space-y-4 bg-[#FBF8F2] px-4 py-5 sm:px-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-bold text-[#1F1A14]">Invoice Queue</h1>
          <p className="text-[15px] text-[#6B6052]">From the $250 to paid in full. A job lands in Ready for invoice the moment the crew taps "I'm finished".</p>
        </div>
        <button type="button" onClick={() => { setLoading(true); load(); }} aria-label="Refresh"
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-[#E4DCCB] bg-white text-[#1F1A14] hover:bg-[#F8F3E7]">
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </button>
      </div>

      {/* The quick $250s live in Deposit sent / Deposit paid with a job total
          guessed from the call; no separate review box (Alan, 2026-10-29). */}

      {/* The five stages, left to right; two to a row on a phone. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {STAGES.map((s, i) => {
          const st = data?.stages.find((x) => x.key === s.key);
          const on = s.key === stage;
          return (
            <button key={s.key} type="button" onClick={() => pick(s.key)}
                    className={cn("flex min-h-[92px] flex-col items-start justify-between rounded-2xl border p-3 text-left transition-colors",
                      i === 4 && "col-span-2 sm:col-span-1",
                      on ? "border-[#1F1A14] bg-[#1F1A14] text-white" : "border-[#E4DCCB] bg-white text-[#1F1A14] hover:bg-[#F8F3E7]",
                      !on && s.key === "ready" && (st?.count || 0) > 0 && "border-[#C9972F] ring-2 ring-[#C9972F]/30")}>
              <span className="flex items-center gap-1.5 text-[14px] font-semibold">
                <s.icon className="h-4 w-4 shrink-0" /> {s.short}
              </span>
              <span className="text-[26px] font-bold leading-none tabular-nums">{st ? st.count : "–"}</span>
              <span className={cn("text-[13px]", on ? "text-white/75" : "text-[#6B6052]")}>{st ? `${usd(st.money)} ${s.money}` : " "}</span>
            </button>
          );
        })}
      </div>

      <h2 className="pt-1 text-[18px] font-bold text-[#1F1A14]">{meta.label}</h2>
      {loading && !data ? (
        <p className="flex items-center gap-2 text-[15px] text-[#6B6052]"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
      ) : !current || current.rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-[#E4DCCB] bg-white p-6 text-center text-[15px] text-[#6B6052]">{meta.empty}</p>
      ) : (
        <div className="space-y-3">
          {current.rows.map((r) => <Row key={r.lead_id} r={r} closeHow={data?.close_how || []} onChanged={load} />)}
        </div>
      )}
    </div>
  );
}
