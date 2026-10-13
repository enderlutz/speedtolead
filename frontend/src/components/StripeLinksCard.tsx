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
import { Copy, Ban, CreditCard, Eye, CheckCircle2, Loader2, MessageSquare, Plus, ReceiptText, RefreshCw, Star, Stethoscope, Trash2, X } from "lucide-react";
import { api, type InvoiceLine, type PayLinkEntry, type PayLinkKind, type PayLinksResponse, type StripeHealth, type StripeSettings } from "@/lib/api";
import { cn, formatCurrency } from "@/lib/utils";
import { InvoiceDoc } from "@/pages/PayLink";

const KINDS: { kind: PayLinkKind; label: string; hint: string; needsAmount: boolean }[] = [
  { kind: "deposit", label: "Deposit $250", hint: "Books their dates. Card and wallets only.", needsAmount: false },
  { kind: "balance", label: "Balance", hint: "After the job. Card or Klarna.", needsAmount: true },
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
  const [checking, setChecking] = useState<string | null>(null);
  const [health, setHealth] = useState<StripeHealth | "loading" | null>(null);

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
  // Alan's $1 test (2026-10-12) paid on Stripe and sat open here. This asks
  // Stripe about the session and books it, or says what Stripe said.
  const check = async (link: PayLinkEntry) => {
    setChecking(link.token);
    try {
      const out = await api.checkPayLink(link.token);
      if (out.error) toast.error(out.error, { duration: 12000 });
      else if (out.link.status === "paid") toast.success(`Stripe says paid${out.stripe?.livemode === false ? " (test mode)" : ""}. Booked here.`);
      else toast.message(`Stripe sees the session as "${out.stripe?.payment_status || "unknown"}", not paid yet.`);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't ask Stripe");
    } finally {
      setChecking(null);
    }
  };
  const showHealth = async () => {
    setHealth("loading");
    try { setHealth(await api.getStripeHealth()); }
    catch (e) { setHealth(null); toast.error(e instanceof Error ? e.message : "Couldn't ask Stripe"); }
  };
  const voidLink = async (link: PayLinkEntry) => {
    try { await api.voidPayLink(link.token); toast.success("Link voided"); load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't void it"); }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-semibold"><CreditCard className="h-4 w-4 text-emerald-600" /> Stripe links</p>
        <span className="flex items-center gap-2">
          {data ? <span className="text-xs text-muted-foreground">Paid through Stripe: <b className="text-foreground">{formatCurrency(data.paid_total)}</b></span> : null}
          <button type="button" onClick={showHealth} disabled={health === "loading"} title="What Stripe says about our webhook, payment methods and the last payments"
            className="inline-flex h-7 items-center gap-1 rounded-md bg-muted px-2 text-[11px] font-semibold hover:bg-muted/70 disabled:opacity-60">
            {health === "loading" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Stethoscope className="h-3 w-3" />} Check setup
          </button>
        </span>
      </div>
      {health && health !== "loading" ? <HealthPanel h={health} onClose={() => setHealth(null)} /> : null}
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
      <InvoiceBuilder leadId={leadId} billTo={data?.bill_to} onMade={async (l) => { await copy(l); load(); }} />
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
              {l.items?.length ? <span className="truncate text-muted-foreground" title={l.items.map((i) => `${i.name} ${formatCurrency(i.amount)}`).join("\n")}>· {l.items.length} lines{l.credit ? `, less ${formatCurrency(l.credit)} paid` : ""}</span> : null}
              {l.kind !== "deposit" && l.financing === false ? <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground">No Klarna</span> : null}
              <span className="ml-auto text-muted-foreground">{l.paid_at && l.kind !== "done" ? `paid ${new Date(l.paid_at).toLocaleDateString()}` : l.sent_at ? `texted ${new Date(l.sent_at).toLocaleDateString()}` : l.created_at ? new Date(l.created_at).toLocaleDateString() : ""}</span>
              {l.status === "paid" && l.answered_at ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-label="Answered the after-payment screens" /> : null}
              {l.status === "open" || l.kind === "done" ? (
                <button type="button" onClick={() => text(l)} disabled={sending === l.token} className="inline-flex h-7 items-center gap-1 rounded-md bg-emerald-600 px-2 text-[11px] font-bold text-white hover:bg-emerald-700 disabled:opacity-60" title="Text the link to the customer">
                  {sending === l.token ? <Loader2 className="h-3 w-3 animate-spin" /> : <MessageSquare className="h-3 w-3" />} {l.sent_at ? "Text again" : "Text"}
                </button>
              ) : null}
              {l.status === "open" && l.opened ? (
                <button type="button" onClick={() => check(l)} disabled={checking === l.token} className="inline-flex h-7 items-center gap-1 rounded-md bg-sky-600 px-2 text-[11px] font-bold text-white hover:bg-sky-700 disabled:opacity-60" title="Ask Stripe whether this was paid, and book it if so">
                  {checking === l.token ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Check with Stripe
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

// An itemized invoice (Alan, 2026-10-13): each line with a short note, less
// what they already paid. Becomes a balance link; the pay page and Stripe's
// checkout list the lines.
type Row = { key: number; name: string; description: string; amount: string; discount: string | null; discountLabel: string };

const num = (v: string) => Number(String(v).replace(/[$,\s]/g, "")) || 0;
const blankRow = (): Row => ({ key: Math.random(), name: "", description: "", amount: "", discount: null, discountLabel: "" });

function InvoiceBuilder({ leadId, billTo, onMade }: { leadId: string; billTo?: { name: string; address: string; invoice_number: string }; onMade: (l: PayLinkEntry) => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const [rows, setRows] = useState<Row[]>([blankRow()]);
  // A discount on the whole invoice: null until "Discount on the total" is tapped.
  const [whole, setWhole] = useState<{ label: string; amount: string } | null>(null);
  const [credit, setCredit] = useState("");
  // Klarna costs ~3%; Alan turns it off when nobody asked to finance.
  const [klarna, setKlarna] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<InvoiceLine[]>([]);
  useEffect(() => {
    if (open) api.listSavedLines().then(setSaved).catch(() => {});
  }, [open]);

  const subtotal = rows.reduce((t, r) => t + num(r.amount), 0);
  const lineOff = rows.reduce((t, r) => t + (r.discount !== null ? num(r.discount) : 0), 0);
  const wholeOff = whole ? num(whole.amount) : 0;
  const paid = num(credit);
  const due = subtotal - lineOff - wholeOff - paid;

  const set = (k: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === k ? { ...r, ...patch } : r)));
  const isSaved = (r: Row) => saved.some((s) => s.name.toLowerCase() === r.name.trim().toLowerCase() && s.amount === num(r.amount) && s.description === r.description.trim());
  const saveLine = async (r: Row) => {
    if (!r.name.trim() || !num(r.amount)) { toast.error("Give the line a name and a price first"); return; }
    try {
      setSaved(await api.saveLine({ name: r.name.trim(), description: r.description.trim(), amount: num(r.amount) }));
      toast.success(`Saved "${r.name.trim()}" for next time`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save the line");
    }
  };
  const forget = async (name: string) => {
    try { setSaved(await api.deleteSavedLine(name)); } catch { toast.error("Couldn't remove it"); }
  };
  // A saved chip fills the first empty line, or adds a new one.
  const addSaved = (s: InvoiceLine) => setRows((rs) => {
    const fresh = { ...blankRow(), name: s.name, description: s.description, amount: String(s.amount) };
    const i = rs.findIndex((r) => !r.name.trim() && !num(r.amount));
    return i >= 0 ? rs.map((r, j) => (j === i ? fresh : r)) : [...rs, fresh];
  });

  const buildItems = (): InvoiceLine[] => {
    const items: InvoiceLine[] = rows.filter((r) => r.name.trim() || num(r.amount)).map((r) => ({
      name: r.name.trim(), description: r.description.trim(), amount: num(r.amount),
      ...(r.discount !== null ? { discount: num(r.discount), discount_label: r.discountLabel.trim() || "Discount" } : {}),
    }));
    if (whole) items.push({ name: whole.label.trim() || "Discount", description: "", amount: -wholeOff, total_discount: true });
    return items;
  };
  const make = async () => {
    const used = rows.filter((r) => r.name.trim() || num(r.amount));
    if (!used.length || used.some((r) => !r.name.trim() || num(r.amount) <= 0)) { toast.error("Every line needs a name and a price"); return; }
    const bad = used.find((r) => r.discount !== null && (num(r.discount) <= 0 || num(r.discount) >= num(r.amount)));
    if (bad) { toast.error(`The discount on ${bad.name.trim()} needs an amount less than its price`); return; }
    if (whole && wholeOff <= 0) { toast.error("Type the discount on the total, or remove it"); return; }
    if (due <= 0) { toast.error("The discounts and payments cover the whole invoice"); return; }
    const items = buildItems();
    setBusy(true);
    try {
      const link = await api.createPayLink(leadId, { kind: "balance", items, credit: paid || undefined, financing: klarna });
      await onMade(link);
      setRows([blankRow()]); setWhole(null); setCredit(""); setKlarna(true); setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't make the invoice");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-1.5 inline-flex h-9 items-center gap-1.5 rounded-lg bg-muted px-2.5 text-xs font-semibold hover:bg-muted/70">
        <ReceiptText className="h-3.5 w-3.5" /> Itemized invoice
      </button>
    );
  }
  const money = (n: number) => (n < 0 ? `− ${formatCurrency(-n)}` : formatCurrency(n));
  const field = "rounded-md border border-transparent bg-transparent px-1.5 outline-none hover:border-border focus:border-primary focus:bg-background";
  return (
    <div className="mt-2 overflow-hidden rounded-xl border border-border bg-background shadow-sm">
      <div className="flex items-center justify-between bg-foreground px-3 py-2 text-background">
        <span className="text-xs font-bold uppercase tracking-[0.18em]">Invoice</span>
        <button type="button" onClick={() => setOpen(false)} className="rounded p-1 hover:bg-background/15" aria-label="Close"><X className="h-4 w-4" /></button>
      </div>

      {saved.length > 0 && (
        <div className="border-b border-border px-3 py-2">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Quick add</p>
          <div className="flex flex-wrap gap-1.5">
            {saved.map((s) => (
              <span key={s.name} className="inline-flex h-8 items-center rounded-full border border-border bg-muted/50 text-xs">
                <button type="button" onClick={() => addSaved(s)} className="h-full rounded-l-full pl-2.5 pr-1 font-medium hover:bg-muted" title={s.description || undefined}>
                  + {s.name} <span className="tabular-nums text-muted-foreground">{money(s.amount)}</span>
                </button>
                <button type="button" onClick={() => forget(s.name)} className="h-full rounded-r-full px-1.5 text-muted-foreground hover:bg-muted" aria-label={`Remove saved line ${s.name}`}><X className="h-3 w-3" /></button>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-[1fr_7rem_3.5rem] bg-muted/60 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span>Item</span><span className="text-right">Amount</span><span />
      </div>
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.key} className="px-3 py-2">
            <div className="grid grid-cols-[1fr_7rem_3.5rem] items-center gap-1">
              <input value={r.name} onChange={(e) => set(r.key, { name: e.target.value })} placeholder="Item name" className={cn(field, "h-8 text-sm font-semibold")} />
              <div className="flex h-8 items-center rounded-md border border-border bg-background px-1.5 focus-within:border-primary">
                <span className="shrink-0 text-sm text-muted-foreground">$</span>
                <input value={r.amount} onChange={(e) => set(r.key, { amount: e.target.value })} inputMode="decimal" placeholder="0.00" className="min-w-0 w-full bg-transparent text-right text-sm font-semibold tabular-nums outline-none" />
              </div>
              <span className="flex justify-end">
                <button type="button" onClick={() => saveLine(r)} className="rounded-md p-1 hover:bg-muted" aria-label="Save this line for next time" title="Save this line for next time">
                  <Star className={cn("h-3.5 w-3.5", isSaved(r) ? "fill-amber-400 text-amber-500" : "text-muted-foreground")} />
                </button>
                <button type="button" onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((x) => x.key !== r.key) : [blankRow()]))} className="rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label="Remove line"><Trash2 className="h-3.5 w-3.5" /></button>
              </span>
            </div>
            <input value={r.description} onChange={(e) => set(r.key, { description: e.target.value })} placeholder="Note the customer sees (optional)" className={cn(field, "mt-0.5 h-7 w-[calc(100%-10.5rem)] text-xs text-muted-foreground")} />
            {r.discount !== null ? (
              <div className="mt-1 grid grid-cols-[1fr_7rem_3.5rem] items-center gap-1 rounded-md bg-emerald-50 py-1 pl-1 dark:bg-emerald-950/40">
                <input value={r.discountLabel} onChange={(e) => set(r.key, { discountLabel: e.target.value })} placeholder="Discount name (e.g. Package discount)" className={cn(field, "h-7 text-xs font-medium text-emerald-800 dark:text-emerald-300")} />
                <div className="flex h-7 items-center rounded-md border border-emerald-300 bg-background px-1.5 dark:border-emerald-800">
                  <span className="shrink-0 whitespace-nowrap text-xs font-semibold text-emerald-700">−$</span>
                  <input value={r.discount} onChange={(e) => set(r.key, { discount: e.target.value })} inputMode="decimal" placeholder="0.00" autoFocus className="min-w-0 w-full bg-transparent text-right text-xs font-semibold tabular-nums text-emerald-800 outline-none dark:text-emerald-300" />
                </div>
                <span className="flex justify-end">
                  <button type="button" onClick={() => set(r.key, { discount: null, discountLabel: "" })} className="rounded-md p-1 text-muted-foreground hover:bg-background" aria-label="Remove discount"><X className="h-3.5 w-3.5" /></button>
                </span>
              </div>
            ) : (
              <button type="button" onClick={() => set(r.key, { discount: "", discountLabel: "Package discount" })} className="mt-0.5 px-1.5 text-[11px] font-semibold text-emerald-700 hover:underline">+ Discount on this line</button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-1 border-t border-border px-2 py-1.5">
        <button type="button" onClick={() => setRows((rs) => [...rs, blankRow()])} className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-semibold hover:bg-muted"><Plus className="h-3.5 w-3.5" /> Add line</button>
        {!whole && (
          <button type="button" onClick={() => setWhole({ label: "Discount", amount: "" })} className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-semibold text-emerald-700 hover:bg-muted"><Plus className="h-3.5 w-3.5" /> Discount on the total</button>
        )}
      </div>

      <dl className="ml-auto space-y-1 border-t-2 border-border px-3 py-2 text-sm sm:w-80">
        <div className="flex justify-between"><dt className="text-muted-foreground">Subtotal</dt><dd className="tabular-nums">{formatCurrency(subtotal)}</dd></div>
        {lineOff > 0 && <div className="flex justify-between text-emerald-700"><dt>Line discounts</dt><dd className="tabular-nums">{money(-lineOff)}</dd></div>}
        {whole && (
          <div className="flex items-center justify-between gap-2 text-emerald-700">
            <input value={whole.label} onChange={(e) => setWhole({ ...whole, label: e.target.value })} className={cn(field, "h-7 min-w-0 flex-1 text-sm")} aria-label="Name of the discount on the total" />
            <span className="flex h-7 w-24 items-center rounded-md border border-emerald-300 bg-background px-1.5 dark:border-emerald-800">
              <span className="shrink-0 whitespace-nowrap text-xs font-semibold">−$</span>
              <input value={whole.amount} onChange={(e) => setWhole({ ...whole, amount: e.target.value })} inputMode="decimal" placeholder="0.00" autoFocus className="min-w-0 w-full bg-transparent text-right text-sm tabular-nums outline-none" />
            </span>
            <button type="button" onClick={() => setWhole(null)} className="rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label="Remove discount on the total"><X className="h-3.5 w-3.5" /></button>
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Already paid</dt>
          <span className="flex h-7 w-24 items-center rounded-md border border-border bg-background px-1.5">
            <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">−$</span>
            <input value={credit} onChange={(e) => setCredit(e.target.value)} inputMode="decimal" placeholder="0.00" className="min-w-0 w-full bg-transparent text-right text-sm tabular-nums outline-none" />
          </span>
        </div>
        <div className="flex items-baseline justify-between border-t border-border pt-1.5">
          <dt className="font-bold">Total due</dt>
          <dd className={cn("text-xl font-bold tabular-nums", due < 0 && "text-rose-600")}>{formatCurrency(Math.max(0, due))}</dd>
        </div>
      </dl>
      <label className="flex cursor-pointer items-center justify-between gap-3 border-t border-border px-3 py-2 text-sm">
        <span>
          <span className="font-semibold">Offer Klarna</span>
          <span className="block text-xs text-muted-foreground">{klarna ? "They can pay over time. Klarna takes about 3% from you." : "Off: card, Apple Pay, Google Pay, bank account and Cash App only."}</span>
        </span>
        <input type="checkbox" checked={klarna} onChange={(e) => setKlarna(e.target.checked)} className="h-5 w-5 shrink-0 accent-emerald-600" />
      </label>
      <div className="flex justify-end gap-1.5 border-t border-border bg-muted/40 px-3 py-2">
        <button type="button" onClick={() => setOpen(false)} className="h-9 rounded-md px-3 text-sm font-semibold hover:bg-background">Cancel</button>
        <button type="button" onClick={() => setPreview(true)} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-semibold hover:bg-muted">
          <Eye className="h-3.5 w-3.5" /> Preview
        </button>
        <button type="button" onClick={make} disabled={busy} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-emerald-600 px-3 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-60">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ReceiptText className="h-3.5 w-3.5" />} Make invoice link
        </button>
      </div>
      {preview && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-3 sm:items-center" onClick={() => setPreview(false)}>
          <div className="w-full max-w-[430px] rounded-2xl bg-[#F8F3E7] p-4 text-[#15130F] shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <p className="text-[12px] font-bold uppercase tracking-[0.18em] text-[#8C6224]">Preview · what the customer sees</p>
              <button type="button" onClick={() => setPreview(false)} className="rounded-full p-1.5 hover:bg-black/10" aria-label="Close preview"><X className="h-4 w-4" /></button>
            </div>
            <InvoiceDoc info={{
              kind: "balance", label: "Balance", amount: Math.max(0, due), description: "", status: "open",
              first_name: (billTo?.name || "").split(" ")[0], address: billTo?.address || "", configured: true,
              items: buildItems(), credit: paid, financing: klarna, name: billTo?.name || "", invoice_number: billTo?.invoice_number || "", date: new Date().toISOString(),
            }} />
            <div className="mt-4 flex h-14 w-full items-center justify-center rounded-xl text-[18px] font-bold text-[#15130F] opacity-90" style={{ background: "#C9972F" }}>
              Pay {formatCurrency(Math.max(0, due))}
            </div>
            <p className="mt-2 text-center text-[13px] text-[#15130F]/70">Nothing is made or sent until you tap Make invoice link.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function HealthPanel({ h, onClose }: { h: StripeHealth; onClose: () => void }) {
  const when = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(); };
  const shortUrl = (u: string) => u.replace(/^https?:\/\//, "");
  return (
    <div className="mt-2 space-y-2 rounded-lg bg-muted/40 p-2.5 text-xs">
      <div className="flex items-center justify-between">
        <p className="font-semibold">What Stripe says about our setup</p>
        <button type="button" onClick={onClose} className="rounded-md p-1 hover:bg-background" aria-label="Close"><X className="h-3.5 w-3.5" /></button>
      </div>
      {h.errors.map((e) => <p key={e} className="rounded-md bg-rose-50 px-2 py-1 text-rose-800 ring-1 ring-rose-200">{e}</p>)}
      <div>
        <p className={cn("font-bold", h.webhook_ok ? "text-emerald-700" : "text-rose-700")}>
          {h.webhook_ok ? "Webhook: Stripe has our live address and the right events." : "Webhook: Stripe has no live, enabled destination at our address with the right events."}
        </p>
        {h.webhooks.length === 0 ? <p className="text-muted-foreground">No webhook destinations on this account.</p> : (
          <ul className="mt-1 space-y-0.5">
            {h.webhooks.map((w) => (
              <li key={w.url + String(w.livemode)} className="flex flex-wrap items-center gap-1.5">
                <span className={cn("rounded-full px-1.5 py-0.5 font-bold uppercase", w.livemode ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900")}>{w.livemode ? "live" : "test"}</span>
                <span className={cn("rounded-full px-1.5 py-0.5 font-bold uppercase", w.status === "enabled" ? "bg-emerald-100 text-emerald-800" : "bg-stone-200 text-stone-600")}>{w.status}</span>
                <span className={cn("font-mono", w.ours ? "text-foreground" : "text-muted-foreground")}>{shortUrl(w.url)}</span>
                <span className={w.events_ok ? "text-emerald-700" : "text-rose-700"}>{w.events_ok ? "events ok" : `events: ${w.events.join(", ") || "none"}`}</span>
                {w.api_version ? <span className="text-muted-foreground">{w.api_version}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="font-bold">Payment methods</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {h.methods.length === 0 ? <span className="text-muted-foreground">Stripe didn't list any.</span> : h.methods.map((m) => (
            <span key={m.name} className={cn("rounded-full px-2 py-0.5 font-semibold", m.on ? "bg-emerald-100 text-emerald-800" : m.available ? "bg-stone-200 text-stone-600" : "bg-stone-100 text-stone-400 line-through")} title={m.on ? "On" : m.available ? "Off. Switch it on in Stripe, Settings, Payment methods." : "Not available on this account"}>
              {m.name.replace(/_/g, " ")} {m.on ? "on" : "off"}
            </span>
          ))}
        </div>
      </div>
      <div>
        <p className="font-bold">Last Checkout events Stripe tried to tell us about</p>
        {h.events.length === 0 ? <p className="text-muted-foreground">None yet.</p> : (
          <ul className="mt-1 space-y-0.5">
            {h.events.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted-foreground">{when(e.created)}</span>
                <span className="font-semibold">{e.type.replace("checkout.session.", "")}</span>
                <span className="tabular-nums">{formatCurrency(e.amount)}</span>
                <span>{e.payment_status}</span>
                {e.pay_link ? <span className="font-mono text-muted-foreground">{e.pay_link.slice(0, 8)}…</span> : <span className="text-muted-foreground">no link tag</span>}
                <span className={cn("rounded-full px-1.5 py-0.5 font-bold", e.pending_webhooks > 0 ? "bg-rose-100 text-rose-800" : "bg-emerald-100 text-emerald-800")}>
                  {e.pending_webhooks > 0 ? `${e.pending_webhooks} delivery still failing` : "delivered"}
                </span>
                {!e.livemode ? <span className="rounded-full bg-amber-100 px-1.5 py-0.5 font-bold uppercase text-amber-900">test</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
