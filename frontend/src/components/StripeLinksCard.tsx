// Stripe payment links on a lead: make one, copy it, see it get paid.
// The deposit, the balance after the job, extra work, or "job done" for a
// customer who paid up front and only gets the after-the-job screens. The
// link is what gets texted; paying happens on Stripe; the webhook marks it
// paid here. Text sends the link through GHL with the message written for
// its kind; it refuses a do-not-contact lead. The switch at the bottom lets
// the crew's "job complete" text the balance link on its own.
// (Alan's post-payment spec, 2026-10-10.)
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy, Ban, CreditCard, CheckCircle2, Loader2, MessageSquare } from "lucide-react";
import { api, type PayLinkEntry, type PayLinkKind, type PayLinksResponse, type StripeSettings } from "@/lib/api";
import { cn, formatCurrency } from "@/lib/utils";

const KINDS: { kind: PayLinkKind; label: string; hint: string; needsAmount: boolean }[] = [
  { kind: "deposit", label: "Deposit $250", hint: "Books their dates. Card and wallets only.", needsAmount: false },
  { kind: "balance", label: "Balance", hint: "After the job. Card, Klarna or Affirm.", needsAmount: true },
  { kind: "extra", label: "Extra work", hint: "More repairs added on the job.", needsAmount: true },
  { kind: "done", label: "Job done, nothing owed", hint: "Paid up front. Sends only the after-job screens.", needsAmount: false },
];

export function StripeLinksCard({ leadId }: { leadId: string }) {
  const [data, setData] = useState<PayLinksResponse | null>(null);
  const [amount, setAmount] = useState("");
  // The deposit books the sale (Alan, 2026-10-11): which package, and the
  // job total, which defaults to that package's price on the sent estimate.
  const [tier, setTier] = useState("");
  const [jobTotal, setJobTotal] = useState("");
  const [busy, setBusy] = useState<PayLinkKind | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [settings, setSettings] = useState<StripeSettings | null>(null);

  const load = useCallback(() => {
    api.listPayLinks(leadId).then(setData).catch(() => setData(null));
    api.getStripeSettings().then(setSettings).catch(() => setSettings(null));
  }, [leadId]);
  useEffect(() => { load(); }, [load]);

  const make = async (kind: PayLinkKind, needsAmount: boolean) => {
    const amt = needsAmount ? Number(amount) : undefined;
    if (needsAmount && (!amt || amt <= 0)) { toast.error("Type the amount first"); return; }
    if (kind === "deposit" && !tier) { toast.error("Pick the package they're buying first"); return; }
    const total = jobTotal ? Number(jobTotal) : undefined;
    setBusy(kind);
    try {
      const link = await api.createPayLink(leadId, kind === "deposit" ? { kind, tier, job_total: total } : { kind, amount: amt });
      await copy(link);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't make the link");
    } finally {
      setBusy(null);
    }
  };
  const copy = async (link: PayLinkEntry) => {
    try { await navigator.clipboard.writeText(link.url); toast.success("Link copied. Paste it into the text."); }
    catch { toast.message(link.url); }
  };
  const text = async (link: PayLinkEntry) => {
    setSending(link.token);
    try { await api.sendPayLink(link.token); toast.success("Texted to the customer"); load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't text it"); }
    finally { setSending(null); }
  };
  const flipAuto = async (on: boolean) => {
    try { setSettings(await api.updateStripeSettings({ auto_balance_link: on })); toast.success(on ? "The balance link will text itself when a job is marked complete" : "Automatic balance link is off"); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't change that"); }
  };
  const voidLink = async (link: PayLinkEntry) => {
    try { await api.voidPayLink(link.token); toast.success("Link voided"); load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't void it"); }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-semibold"><CreditCard className="h-4 w-4 text-emerald-600" /> Stripe links</p>
        {data ? <span className="text-xs text-muted-foreground">Paid through Stripe: <b className="text-foreground">{formatCurrency(data.paid_total)}</b></span> : null}
      </div>
      {data && !data.configured ? (
        <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900 ring-1 ring-amber-200">Stripe isn't switched on yet. Links can be made, but the pay page tells the customer to call until the keys are in Railway.</p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <select value={tier} onChange={(e) => setTier(e.target.value)} className="h-9 rounded-lg border border-border bg-background px-2 text-sm" title="The package they're buying. The deposit records the sale at this price.">
          <option value="">Package sold…</option>
          <option value="essential">Essential</option>
          <option value="signature">Signature</option>
          <option value="legacy">Legacy</option>
          <option value="custom">Custom</option>
        </select>
        <input value={jobTotal} onChange={(e) => setJobTotal(e.target.value)} inputMode="decimal" placeholder={tier === "custom" ? "Job total" : "Job total (auto)"}
          title="Leave blank to use the package price from the estimate we sent"
          className="h-9 w-32 rounded-lg border border-border bg-background px-2 text-sm tabular-nums" />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="Amount"
          className="h-9 w-24 rounded-lg border border-border bg-background px-2 text-sm tabular-nums" />
        {KINDS.map((k) => (
          <button key={k.kind} type="button" title={k.hint} disabled={busy !== null} onClick={() => make(k.kind, k.needsAmount)}
            className="inline-flex h-9 items-center gap-1 rounded-lg bg-muted px-2.5 text-xs font-semibold hover:bg-muted/70 disabled:opacity-60">
            {busy === k.kind ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}{k.label}
          </button>
        ))}
      </div>
      {data && data.links.length ? (
        <ul className="mt-2 space-y-1">
          {data.links.map((l) => (
            <li key={l.token} className="flex items-center gap-2 rounded-lg bg-muted/40 px-2 py-1.5 text-xs">
              <span className={cn("rounded-full px-1.5 py-0.5 font-bold uppercase tracking-wide",
                l.status === "paid" ? "bg-emerald-100 text-emerald-800" : l.status === "void" ? "bg-stone-200 text-stone-600 line-through" : "bg-amber-100 text-amber-900")}>
                {l.status}
              </span>
              <span className="font-semibold">{l.label}</span>
              <span className="tabular-nums">{l.kind === "done" ? "" : formatCurrency(l.amount)}</span>
              {l.job_total ? <span className="text-muted-foreground">· {l.job_tier} sale {formatCurrency(l.job_total)}</span> : null}
              <span className="ml-auto text-muted-foreground">{l.paid_at && l.kind !== "done" ? `paid ${new Date(l.paid_at).toLocaleDateString()}` : l.sent_at ? `texted ${new Date(l.sent_at).toLocaleDateString()}` : l.created_at ? new Date(l.created_at).toLocaleDateString() : ""}</span>
              {l.status === "paid" && l.answered_at ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-label="Answered the after-payment screens" /> : null}
              {l.status === "open" || l.kind === "done" ? (
                <button type="button" onClick={() => text(l)} disabled={sending === l.token} className="inline-flex h-7 items-center gap-1 rounded-md bg-emerald-600 px-2 text-[11px] font-bold text-white hover:bg-emerald-700 disabled:opacity-60" title="Text the link to the customer">
                  {sending === l.token ? <Loader2 className="h-3 w-3 animate-spin" /> : <MessageSquare className="h-3 w-3" />} {l.sent_at ? "Text again" : "Text"}
                </button>
              ) : null}
              <button type="button" onClick={() => copy(l)} className="rounded-md p-1 hover:bg-background" title="Copy the link"><Copy className="h-3.5 w-3.5" /></button>
              {l.status === "open" ? <button type="button" onClick={() => voidLink(l)} className="rounded-md p-1 hover:bg-background" title="Void this link"><Ban className="h-3.5 w-3.5" /></button> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {settings ? (
        <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-lg bg-muted/40 px-2 py-1.5 text-xs">
          <input type="checkbox" checked={settings.auto_balance_link} onChange={(e) => flipAuto(e.target.checked)} className="mt-0.5 h-3.5 w-3.5 accent-emerald-600" />
          <span><b>Text the balance link by itself</b> when the crew marks a job complete (or the all-paid link when nothing is owed). Applies to every job, not just this one.</span>
        </label>
      ) : null}
    </div>
  );
}
