// Stripe payment links on a lead: make one, copy it, see it get paid.
// The deposit, the balance after the job, extra work, or "job done" for a
// customer who paid up front and only gets the after-the-job screens. The
// link is what gets texted; paying happens on Stripe; the webhook marks it
// paid here. Text sends the link through GHL with the message written for
// its kind; it refuses a do-not-contact lead. The switch at the bottom lets
// the crew's "job complete" text the balance link on its own.
// (Alan's post-payment spec, 2026-10-10.)
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Copy, Ban, Pencil, CreditCard, Zap, Eye, ExternalLink, UserPlus, CheckCircle2, Loader2, MessageSquare, Plus, ReceiptText, RefreshCw, Star, Stethoscope, Trash2, X } from "lucide-react";
import { api, type CompanyCamPhoto, type InvoiceLine, type PayLinkEntry, type PayLinkKind, type PayLinksResponse, type PayLinkContact, type SuggestedInvoice, type StripeHealth, type StripeSettings } from "@/lib/api";
import { cn, formatCurrency } from "@/lib/utils";
import { InvoiceSheet } from "@/components/InvoiceSheet";
import { dueText } from "@/lib/due";

const KINDS: { kind: PayLinkKind; label: string; hint: string; needsAmount: boolean }[] = [
  { kind: "deposit", label: "Deposit $250", hint: "Books their dates. Card and wallets only.", needsAmount: false },
  { kind: "extra", label: "Extra work", hint: "More repairs added on the job.", needsAmount: true },
  { kind: "done", label: "Job done, nothing owed", hint: "Paid up front. Sends only the after-job screens.", needsAmount: false },
];

/** `startInvoice`: open straight on the itemized invoice, filled in (the
 *  Invoice Queue's Make the bill). A balance always goes as an itemized
 *  invoice (Alan, 2026-10-23). */
export function StripeLinksCard({ leadId, startInvoice = false }: { leadId: string; startInvoice?: boolean }) {
  const [data, setData] = useState<PayLinksResponse | null>(null);
  const [amount, setAmount] = useState("");
  // The deposit books the sale (Alan, 2026-10-11): which package, and the
  // job total, which defaults to that package's price on the sent estimate.
  const [tier, setTier] = useState("");
  const [jobTotal, setJobTotal] = useState("");
  const [busy, setBusy] = useState<PayLinkKind | null>(null);
  const [settings, setSettings] = useState<StripeSettings | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  // "Text someone else": which link's form is open, and what's typed in it.
  const [other, setOther] = useState<string | null>(null);
  const [health, setHealth] = useState<StripeHealth | "loading" | null>(null);
  // Ask for a Google review on the thank-you screens of the links made here.
  // On by default; off for someone who already left one, a repeat customer,
  // a job still being walked (Alan, 2026-10-15).
  const [askReview, setAskReview] = useState(true);
  // The invoice being edited in the builder, if any.
  const [editing, setEditing] = useState<PayLinkEntry | null>(null);
  // "Paid by…" open on one link: a check, cash, Zelle (2026-10-23).
  const [marking, setMarking] = useState<string | null>(null);
  const markPaid = async (link: PayLinkEntry, how: string) => {
    try { await api.markPayLinkPaid(link.token, how); toast.success("Marked paid. The receipt is ready to text."); setMarking(null); load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't mark it paid"); }
  };

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
      const link = await api.createPayLink(leadId, kind === "deposit" ? { kind, tier, job_total: total } : { kind, amount: amt, ask_review: askReview });
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
  // One tap for the customer who is ready right now (Alan and Olga,
  // 2026-10-27): no package, no amount, no edit box. The text goes, the
  // link opens straight into Stripe, the day from the call is held.
  const [quick, setQuick] = useState(false);
  const sendQuick = async () => {
    setQuick(true);
    try {
      const out = await api.quickDeposit(leadId);
      toast.success(out.note, { duration: 9000 });
      window.dispatchEvent(new CustomEvent("booking-changed", { detail: { leadId } }));
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't send it");
    } finally {
      setQuick(false);
    }
  };
  // Every text opens in an edit box first (Alan, 2026-10-13).
  const [composing, setComposing] = useState<string | null>(null);
  const text = (link: PayLinkEntry) => { setOther(null); setComposing(composing === link.token ? null : link.token); };
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
  const flipReview = async (link: PayLinkEntry) => {
    const on = link.ask_review === false;
    try { await api.setPayLinkReview(link.token, on); toast.success(on ? "This link will ask for a Google review" : "This link won't ask for a Google review"); load(); }
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
        <span className="flex items-center gap-2">
          {data ? <span className="text-xs text-muted-foreground">Paid: <b className="text-foreground">{formatCurrency(data.paid_total)}</b></span> : null}
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
      <button type="button" onClick={sendQuick} disabled={quick || busy !== null}
        className="mt-2 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-3 text-[15px] font-bold text-white hover:bg-emerald-700 disabled:opacity-60">
        {quick ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />} Send $250 now
      </button>
      <p className="mt-1 text-xs text-muted-foreground">One tap. Texts a link that opens straight into Stripe and holds the day from the call. No package needed. The booking invite above is for the customer who wants it all written out first.</p>
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
      <label className={cn("mt-2 flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 ring-1", askReview ? "bg-amber-50 ring-amber-200" : "bg-muted/40 ring-border")}>
        <input type="checkbox" checked={askReview} onChange={(e) => setAskReview(e.target.checked)} className="h-5 w-5 shrink-0 accent-amber-500" />
        <span className="min-w-0 flex-1 text-xs">
          <span className="block text-sm font-semibold">{askReview ? "Ask for a Google review" : "Don't ask for a Google review"}</span>
          <span className="block text-muted-foreground">{askReview
            ? "After they pay and give 4 or 5 stars, they see this screen. Untick if they already left one."
            : "They skip this screen: stars, then the referral. For new links made here."}</span>
        </span>
        <ReviewPicture on={askReview} />
      </label>
      <InvoiceBuilder leadId={leadId} billTo={data?.bill_to} askReview={askReview} editing={editing} siteExtras={data?.site_extras} bookedServices={data?.booked_services} suggested={data?.suggested_invoice} startOpen={startInvoice} onStopEditing={() => setEditing(null)}
        onMade={async (l) => { if (editing) { toast.success("Invoice updated. Same link, so a text already sent shows the new lines."); setEditing(null); } else await copy(l); load(); setOther(null); setComposing(l.token); }} />
      {data && data.links.length ? (
        <ul className="mt-2 space-y-1">
          {data.links.map((l) => (
            <li key={l.token} className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/40 px-2 py-1.5 text-xs">
              <span className={cn("rounded-full px-1.5 py-0.5 font-bold uppercase tracking-wide",
                l.status === "paid" ? "bg-emerald-100 text-emerald-800" : l.status === "void" ? "bg-stone-200 text-stone-600 line-through" : "bg-amber-100 text-amber-900")}>
                {l.status}
              </span>
              <span className="font-semibold">{l.label}</span>
              <span className="tabular-nums">{l.kind === "done" ? "" : formatCurrency(l.amount)}</span>
              {l.job_total ? <span className="text-muted-foreground">· {l.job_tier} sale {formatCurrency(l.job_total)}</span> : null}
              {l.items?.length ? <span className="truncate text-muted-foreground" title={l.items.map((i) => `${i.name} ${formatCurrency(i.amount)}`).join("\n")}>· {l.items.length} lines{l.credit ? `, less ${formatCurrency(l.credit)} paid` : ""}</span> : null}
              {l.items?.length && l.status === "open" ? <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground">Due {l.due_date ? dueText(l.due_date).replace(/, \d{4}$/, "") : "upon receipt"}</span> : null}
              {l.kind !== "deposit" && l.financing === false ? <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground">No Klarna</span> : null}
              {l.kind !== "deposit" && l.status !== "void" ? (
                <button type="button" onClick={() => flipReview(l)} disabled={!!l.answered_at}
                  title={l.answered_at ? "They already went through the thank-you screens" : "Tap to switch the Google review ask on this link"}
                  className={cn("inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 text-[10px] font-semibold disabled:cursor-default", l.ask_review === false ? "bg-muted text-muted-foreground" : "bg-amber-100 text-amber-900")}>
                  <Star className={cn("h-2.5 w-2.5", l.ask_review === false ? "" : "fill-amber-500 text-amber-500")} />{l.ask_review === false ? "No review ask" : "Asks for review"}
                </button>
              ) : null}
              {l.status === "open" && l.kind !== "done" ? (
                <span className={cn("shrink-0 rounded px-1.5 text-[10px] font-semibold", l.view_count ? "bg-sky-100 text-sky-800" : "bg-muted text-muted-foreground")}
                  title={l.first_viewed_at ? `First opened ${new Date(l.first_viewed_at).toLocaleString()}` : undefined}>
                  {l.view_count ? `Viewed ${l.view_count}× · ${new Date(l.last_viewed_at || "").toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : l.sent_at ? "Not opened yet" : "Not sent"}
                </span>
              ) : null}
              <span className="ml-auto text-muted-foreground">{l.paid_at && l.kind !== "done" ? `paid ${new Date(l.paid_at).toLocaleDateString()}` : l.sent_at ? `texted ${new Date(l.sent_at).toLocaleDateString()}` : l.created_at ? new Date(l.created_at).toLocaleDateString() : ""}</span>
              {l.status === "paid" && l.answered_at ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-label="Answered the after-payment screens" /> : null}
              {l.status === "open" || l.kind === "done" || (l.status === "paid" && l.kind !== "deposit") ? (
                <button type="button" onClick={() => text(l)} className="inline-flex h-7 items-center gap-1 rounded-md bg-emerald-600 px-2 text-[11px] font-bold text-white hover:bg-emerald-700 disabled:opacity-60"
                  title={l.status === "paid" && l.kind !== "done" ? "Text them the receipt (you can edit the text first)" : "Text the link to the customer (you can edit the text first)"}>
                  <MessageSquare className="h-3 w-3" /> {l.status === "paid" && l.kind !== "done" ? "Text receipt" : l.sent_at ? "Text again" : "Text"}
                </button>
              ) : null}
              {l.status === "open" ? (
                <button type="button" onClick={() => { setComposing(null); setOther(null); setMarking(marking === l.token ? null : l.token); }}
                  className="inline-flex h-7 items-center gap-1 rounded-md bg-muted px-2 text-[11px] font-bold hover:bg-background" title="They paid by check, cash, Zelle… Books it and makes the receipt.">
                  <CheckCircle2 className="h-3 w-3" /> Paid by…
                </button>
              ) : null}
              {l.status === "open" && l.opened ? (
                <button type="button" onClick={() => check(l)} disabled={checking === l.token} className="inline-flex h-7 items-center gap-1 rounded-md bg-sky-600 px-2 text-[11px] font-bold text-white hover:bg-sky-700 disabled:opacity-60" title="Ask Stripe whether this was paid, and book it if so">
                  {checking === l.token ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Check with Stripe
                </button>
              ) : null}
              {l.status === "open" && l.items?.length ? (
                <button type="button" onClick={() => setEditing(l)} className="inline-flex h-7 items-center gap-1 rounded-md bg-muted px-2 text-[11px] font-bold hover:bg-background" title="Change the lines, discounts, what they paid or Klarna. Same link.">
                  <Pencil className="h-3 w-3" /> Edit
                </button>
              ) : null}
              {l.status === "open" && l.kind !== "done" ? (
                <button type="button" onClick={() => { setComposing(null); setOther(other === l.token ? null : l.token); }} className="rounded-md p-1 hover:bg-background" title="Text it to someone else, like a husband or wife"><UserPlus className="h-3.5 w-3.5" /></button>
              ) : null}
              <a href={l.status === "paid" && l.kind !== "done" ? l.url.replace("/pay/", "/receipt/") : `${l.url}?preview=1`} target="_blank" rel="noreferrer" className="rounded-md p-1 hover:bg-background"
                title={l.status === "paid" && l.kind !== "done" ? "Open the receipt" : "Open what the customer sees (doesn't count as their view)"}><ExternalLink className="h-3.5 w-3.5" /></a>
              <button type="button" onClick={() => copy(l)} className="rounded-md p-1 hover:bg-background" title="Copy the link"><Copy className="h-3.5 w-3.5" /></button>
              {l.status === "open" ? <button type="button" onClick={() => voidLink(l)} className="rounded-md p-1 hover:bg-background" title="Void this link"><Ban className="h-3.5 w-3.5" /></button> : null}
              {composing === l.token ? (
                <div className="mt-1 basis-full rounded-md bg-background p-2">
                  <Compose token={l.token} who="the customer" onCancel={() => setComposing(null)}
                    onSend={async (message) => { await api.sendPayLink(l.token, message); toast.success("Texted to the customer"); setComposing(null); load(); }} />
                </div>
              ) : null}
              {other === l.token ? <SendToOther token={l.token} onSent={() => { setOther(null); load(); }} onClose={() => setOther(null)} /> : null}
              {marking === l.token ? (
                <div className="mt-1 flex basis-full flex-wrap items-center gap-1.5 rounded-md bg-background p-2">
                  <span className="mr-1 text-[11px] font-semibold text-muted-foreground">They paid {formatCurrency(l.amount)} by</span>
                  {(data?.offline_methods || [{ key: "check", label: "check" }, { key: "cash", label: "cash" }, { key: "zelle", label: "Zelle" }, { key: "other", label: "another way" }]).map((m) => (
                    <button key={m.key} type="button" onClick={() => markPaid(l, m.key)} className="h-8 rounded-md bg-muted px-2.5 text-[11px] font-bold capitalize hover:bg-muted/70">{m.label}</button>
                  ))}
                  <button type="button" onClick={() => setMarking(null)} className="h-8 px-2 text-[11px] font-semibold text-muted-foreground">Cancel</button>
                </div>
              ) : null}
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
// The text, preset filled in, to edit before it goes. The link has to stay
// in it (the backend checks too); Reset puts the preset back.
function Compose({ token, who, other = false, name = "", onSend, onCancel }: {
  token: string; who: string; other?: boolean; name?: string;
  onSend: (message: string | undefined) => Promise<void>; onCancel: () => void;
}) {
  const [preset, setPreset] = useState<{ message: string; link: string } | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.getPayLinkMessage(token, { name, other }).then((p) => { setPreset(p); setMsg(p.message); }).catch(() => toast.error("Couldn't load the text"));
  }, [token, name, other]);
  const missing = !!preset && !msg.includes(preset.link);
  const go = async () => {
    setBusy(true);
    try { await onSend(preset && msg.trim() === preset.message.trim() ? undefined : msg); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't text it"); }
    finally { setBusy(false); }
  };
  if (!preset) return <p className="flex items-center gap-1.5 py-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Loading the text…</p>;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold text-emerald-800">✏️ Text to {who}. Tap in the box to change the words, then Send text.</p>
      <textarea value={msg} onChange={(e) => setMsg(e.target.value)} rows={5} autoFocus className="w-full rounded-md border-2 border-emerald-500/60 bg-background p-2 text-[15px] leading-snug" />
      {missing ? <p className="text-[11px] font-semibold text-rose-600">The pay link is missing from the text. Put it back or tap Reset, or they can't pay.</p> : null}
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground tabular-nums">{msg.length} characters</span>
        {msg !== preset.message ? <button type="button" onClick={() => setMsg(preset.message)} className="h-8 rounded-md px-2 text-xs font-semibold hover:bg-muted">Reset</button> : null}
        <span className="ml-auto flex gap-1.5">
          <button type="button" onClick={onCancel} className="h-8 rounded-md px-2 text-xs font-semibold hover:bg-muted">Cancel</button>
          <button type="button" onClick={go} disabled={busy || missing || !msg.trim()} className="inline-flex h-8 items-center gap-1 rounded-md bg-emerald-600 px-3 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-60">
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <MessageSquare className="h-3 w-3" />} Send text
          </button>
        </span>
      </div>
    </div>
  );
}

// Send a link to someone else on the job (Alan, 2026-10-13: "her husband
// wants the invoice too"). Search contacts by name or number and tap one;
// if nobody has the number, add them as a new contact (made in GHL, shows up
// on the Contacts page) and send in the same tap.
function SendToOther({ token, onSent, onClose }: { token: string; onSent: () => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<PayLinkContact[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      if (q.trim().length < 2) { setHits(null); return; }
      api.payLinkContactSearch(q.trim()).then(setHits).catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  // Picking someone opens the text to edit; Send in there is what sends.
  const [target, setTarget] = useState<{ label: string; name: string; body: Parameters<typeof api.sendPayLinkTo>[1] } | null>(null);
  const send = (key: string, body: Parameters<typeof api.sendPayLinkTo>[1], label: string, name: string) => {
    setBusy(null); setTarget({ label, name, body }); void key;
  };
  const startAdd = () => {
    const digits = q.replace(/\D/g, "");
    setAdding(true);
    if (digits.length >= 10) setPhone(q.trim()); else if (q.trim()) setName(q.trim());
  };
  return (
    <div className="mt-1 basis-full space-y-1.5 rounded-md bg-background p-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-muted-foreground">Send this link to someone else on the job</span>
        <button type="button" onClick={onClose} className="rounded p-0.5 hover:bg-muted" aria-label="Close"><X className="h-3.5 w-3.5" /></button>
      </div>
      {target ? (
        <Compose token={token} who={target.label} other name={target.name} onCancel={() => setTarget(null)}
          onSend={async (message) => { const r = await api.sendPayLinkTo(token, { ...target.body, message }); toast.success(`Texted to ${r.sent_to}`); onSent(); }} />
      ) : !adding ? (
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search contacts by name or phone" autoFocus className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm" />
          {hits?.length ? (
            <ul className="divide-y divide-border rounded-md border border-border">
              {hits.map((c) => (
                <li key={c.id} className="flex items-center gap-2 px-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate"><b>{c.name || "No name"}</b> <span className="text-muted-foreground tabular-nums">{c.phone}</span></span>
                  <button type="button" onClick={() => send(c.id, { contact_id: c.id }, c.name || c.phone, c.name)} disabled={!!busy}
                    className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-emerald-600 px-2 text-[11px] font-bold text-white hover:bg-emerald-700 disabled:opacity-60">
                    {busy === c.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <MessageSquare className="h-3 w-3" />} Pick
                  </button>
                </li>
              ))}
            </ul>
          ) : hits ? <p className="text-[11px] text-muted-foreground">No contact matches “{q.trim()}”.</p> : null}
          <button type="button" onClick={startAdd} className="inline-flex h-8 items-center gap-1 rounded-md px-1.5 text-xs font-semibold text-emerald-700 hover:bg-muted">
            <Plus className="h-3.5 w-3.5" /> New contact
          </button>
        </>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. Sam Smith)" autoFocus className="h-9 min-w-[12rem] flex-1 rounded-md border border-border bg-background px-2 text-sm" />
            <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="Phone" className="h-9 w-40 rounded-md border border-border bg-background px-2 text-sm" />
          </div>
          <p className="text-[11px] text-muted-foreground">Adds them to GHL and your Contacts. If that number is already a contact, it uses that one instead.</p>
          <div className="flex gap-1.5">
            <button type="button" onClick={() => send("new", { phone, name, create: true }, name || phone, name)} disabled={!!busy || phone.replace(/\D/g, "").length < 10}
              className="inline-flex h-8 items-center gap-1 rounded-md bg-emerald-600 px-2.5 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-60">
              {busy === "new" ? <Loader2 className="h-3 w-3 animate-spin" /> : <MessageSquare className="h-3 w-3" />} Next: the text
            </button>
            <button type="button" onClick={() => setAdding(false)} className="h-8 rounded-md px-2 text-xs font-semibold hover:bg-muted">Back to search</button>
          </div>
        </>
      )}
    </div>
  );
}

// `amount` is the price each; the line total is qty × amount (Alan, 2026-10-15:
// "13 quantity, $12 per, and it adds up, like a regular invoicing software").
type Row = { key: number; name: string; description: string; qty: string; amount: string; discount: string | null; discountLabel: string };

const num = (v: string) => Number(String(v).replace(/[$,\s]/g, "")) || 0;
const blankRow = (): Row => ({ key: Math.random(), name: "", description: "", qty: "1", amount: "", discount: null, discountLabel: "" });
// A part is fine: 12.5 rails (Alan, 2026-10-29).
const qtyOf = (r: Row) => { const q = Math.round((Number(r.qty) || 0) * 100) / 100; return q > 0 ? q : 1; };

// Which after photos the customer gets on their job-done page, to save and
// put in their Google review (Alan, 2026-10-29). All on unless unticked; the
// same pick the page uses: after staining, else after cleaning, else a
// washing job's afters. None uploaded: the page shows just the review button.
const PHOTO_CAP = 12;
function SharePhotos({ leadId }: { leadId: string }) {
  const [photos, setPhotos] = useState<CompanyCamPhoto[] | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    const made: string[] = [];
    (async () => {
      try {
        const cc = await api.getCompanyCam(leadId);
        const all = cc.photos || {};
        const key = ["stain_after", "clean_after"].find((k) => (all[k] || []).length);
        const list = key ? all[key] : Object.keys(all).filter((k) => k.startsWith("pw_") && k.endsWith("_after")).flatMap((k) => all[k]);
        if (!alive) return;
        setPhotos(list);
        for (const ph of list) {
          const u = ph.from_storage ? ph.url : await api.fetchCompanyCamPhotoUrl(leadId, ph.id);
          if (!alive) { if (u && !ph.from_storage) URL.revokeObjectURL(u); return; }
          if (u) { if (!ph.from_storage) made.push(u); setThumbs((t) => ({ ...t, [ph.id]: u })); }
        }
      } catch {
        if (alive) setPhotos([]);
      }
    })();
    return () => { alive = false; made.forEach((u) => URL.revokeObjectURL(u)); };
  }, [leadId]);
  const toggle = async (ph: CompanyCamPhoto) => {
    const hide = !ph.customer_hidden;
    setPhotos((ps) => (ps || []).map((x) => (x.id === ph.id ? { ...x, customer_hidden: hide } : x)));
    try {
      await api.updateCompanyCamPhoto(leadId, ph.id, { customer_hidden: hide });
    } catch {
      setPhotos((ps) => (ps || []).map((x) => (x.id === ph.id ? { ...x, customer_hidden: !hide } : x)));
      toast.error("Couldn't save that. Try again.");
    }
  };
  if (photos === null) return null;
  const shown = photos.filter((p) => !p.customer_hidden).slice(0, PHOTO_CAP);
  return (
    <div className="border-t border-border px-3 py-2">
      <p className="text-sm font-semibold">Photos for their Google review</p>
      {photos.length === 0 ? (
        <p className="text-xs text-muted-foreground">No after photos from the crew yet. Their page will show just the Google review button.</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            After paying, they see these and can save them to their phone. Tap one to leave it out. {shown.length} shown{photos.filter((p) => !p.customer_hidden).length > PHOTO_CAP ? ` (the first ${PHOTO_CAP})` : ""}.
          </p>
          <div className="mt-1.5 flex gap-1.5 overflow-x-auto pb-1">
            {photos.map((ph) => (
              <button key={ph.id} type="button" onClick={() => void toggle(ph)} aria-pressed={!ph.customer_hidden}
                className={cn("relative h-16 w-16 shrink-0 overflow-hidden rounded-md ring-2", ph.customer_hidden ? "opacity-35 ring-transparent" : "ring-emerald-500")}>
                {thumbs[ph.id] ? <img src={thumbs[ph.id]} alt="" className="h-full w-full object-cover" /> : <span className="block h-full w-full animate-pulse bg-muted" />}
                <span className={cn("absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold", ph.customer_hidden ? "bg-white/90 text-muted-foreground" : "bg-emerald-500 text-white")}>
                  {ph.customer_hidden ? <X className="h-3 w-3" /> : "✓"}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function InvoiceBuilder({ leadId, billTo, onMade, askReview = true, editing = null, onStopEditing, siteExtras = [], bookedServices = [], suggested, startOpen = false }: {
  leadId: string; billTo?: { name: string; address: string; invoice_number: string }; onMade: (l: PayLinkEntry) => void | Promise<void>; askReview?: boolean;
  /** An unpaid invoice to load back in and change (Alan, 2026-10-15). */
  editing?: PayLinkEntry | null; onStopEditing?: () => void;
  /** Extra repairs the customer agreed to on site (Company Cam), to add as lines. */
  siteExtras?: { name: string; qty: number; unit_price: number }[];
  bookedServices?: { name: string; qty: number; unit_price: number; description?: string }[];
  /** The lines as they should read, from what was sold, counted and paid. */
  suggested?: SuggestedInvoice;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const [preview, setPreview] = useState(false);
  const [rows, setRows] = useState<Row[]>([blankRow()]);
  // A discount on the whole invoice: null until "Discount on the total" is tapped.
  const [whole, setWhole] = useState<{ label: string; amount: string } | null>(null);
  const [credit, setCredit] = useState("");
  // Klarna costs ~3%: off unless Alan turns it on for this one (2026-10-23:
  // "something we can add later", not a preset).
  const [klarna, setKlarna] = useState(false);
  // When it's due: null = upon receipt, else the day picked (YYYY-MM-DD).
  const [dueOn, setDueOn] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<InvoiceLine[]>([]);
  useEffect(() => {
    if (open) api.listSavedLines().then(setSaved).catch(() => {});
  }, [open]);
  // Edit: the invoice's lines, discounts, credit and Klarna back in the boxes.
  useEffect(() => {
    if (!editing) return;
    const items = editing.items || [];
    const lines = items.filter((i) => !i.total_discount);
    const wholeLine = items.find((i) => i.total_discount);
    setRows(lines.length ? lines.map((i) => ({
      key: Math.random(), name: i.name, description: i.description || "",
      qty: String(i.qty || 1), amount: String(i.unit_price ?? i.amount),
      discount: i.discount ? String(i.discount) : null, discountLabel: i.discount_label || "",
    })) : [blankRow()]);
    setWhole(wholeLine ? { label: wholeLine.name, amount: String(Math.abs(wholeLine.amount)) } : null);
    setCredit(editing.credit ? String(editing.credit) : "");
    setKlarna(editing.financing !== false);
    setDueOn(editing.due_date || null);
    setOpen(true);
  }, [editing]);
  const reset = () => { setRows([blankRow()]); setWhole(null); setCredit(""); setKlarna(false); setDueOn(null); setOpen(false); filled.current = false; onStopEditing?.(); };
  // Opened fresh: start from the invoice as it should read (Alan, 2026-10-23:
  // "already itemize it"). Once, and only onto a blank invoice.
  const filled = useRef(false);
  useEffect(() => {
    if (!open || editing || filled.current || !suggested || !suggested.items.length) return;
    filled.current = true;
    setRows((rs) => rs.some((r) => r.name.trim() || num(r.amount)) ? rs : suggested.items.map((i) => ({
      ...blankRow(), name: i.name, description: i.description || "", qty: String(i.qty || 1), amount: String(i.unit_price),
      discount: i.discount ? String(i.discount) : null, discountLabel: i.discount_label || "",
    })));
    setCredit((c) => c || (suggested.credit ? String(suggested.credit) : ""));
    setWhole((w) => w || (suggested.whole_discount ? { label: suggested.whole_discount.label, amount: String(suggested.whole_discount.amount) } : null));
  }, [open, editing, suggested]);

  const lineTotal = (r: Row) => Math.round(qtyOf(r) * num(r.amount) * 100) / 100;
  const subtotal = rows.reduce((t, r) => t + lineTotal(r), 0);
  const lineOff = rows.reduce((t, r) => t + (r.discount !== null ? num(r.discount) : 0), 0);
  const wholeOff = whole ? num(whole.amount) : 0;
  const paid = num(credit);
  const due = subtotal - lineOff - wholeOff - paid;

  const set = (k: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === k ? { ...r, ...patch } : r)));
  // Saved lines keep the name and note only. No price: every job is priced on
  // its own, so the amount is typed each time (Alan, 2026-10-15).
  const isSaved = (r: Row) => saved.some((s) => s.name.toLowerCase() === r.name.trim().toLowerCase() && s.description === r.description.trim());
  const saveLine = async (r: Row) => {
    if (!r.name.trim()) { toast.error("Give the line a name first"); return; }
    try {
      setSaved(await api.saveLine({ name: r.name.trim(), description: r.description.trim(), amount: 0 }));
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
    const fresh = { ...blankRow(), name: s.name, description: s.description, amount: "" };
    const i = rs.findIndex((r) => !r.name.trim() && !num(r.amount));
    return i >= 0 ? rs.map((r, j) => (j === i ? fresh : r)) : [...rs, fresh];
  });

  const buildItems = (): InvoiceLine[] => {
    const items: InvoiceLine[] = rows.filter((r) => r.name.trim() || num(r.amount)).map((r) => ({
      name: r.name.trim(), description: r.description.trim(), amount: lineTotal(r),
      quantity: qtyOf(r), unit_price: num(r.amount),
      ...(r.discount !== null ? { discount: num(r.discount), discount_label: r.discountLabel.trim() || "Discount" } : {}),
    }));
    if (whole) items.push({ name: whole.label.trim() || "Discount", description: "", amount: -wholeOff, total_discount: true });
    return items;
  };
  const make = async () => {
    const used = rows.filter((r) => r.name.trim() || num(r.amount));
    if (!used.length || used.some((r) => !r.name.trim() || num(r.amount) <= 0)) { toast.error("Every line needs a name and a price"); return; }
    const bad = used.find((r) => r.discount !== null && (num(r.discount) <= 0 || num(r.discount) >= lineTotal(r)));
    if (bad) { toast.error(`The discount on ${bad.name.trim()} needs an amount less than its price`); return; }
    if (whole && wholeOff <= 0) { toast.error("Type the discount on the total, or remove it"); return; }
    if (due <= 0) { toast.error("The discounts and payments cover the whole invoice"); return; }
    const items = buildItems();
    setBusy(true);
    try {
      const link = editing
        ? await api.editInvoice(editing.token, { items, credit: paid || undefined, financing: klarna, ask_review: editing.ask_review !== false, due_date: dueOn })
        : await api.createPayLink(leadId, { kind: "balance", items, credit: paid || undefined, financing: klarna, ask_review: askReview, due_date: dueOn });
      await onMade(link);
      reset();
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
        <span className="text-xs font-bold uppercase tracking-[0.18em]">{editing ? `Editing invoice · was ${formatCurrency(editing.amount)}` : "Invoice"}</span>
        <button type="button" onClick={reset} className="rounded p-1 hover:bg-background/15" aria-label="Close"><X className="h-4 w-4" /></button>
      </div>

      {/* The bill follows what they were texted (Alan, 2026-10-29). */}
      {!editing && suggested?.source?.kind === "texted" ? (
        <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Filled in from the total you texted them on {new Date(suggested.source.sent_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}: <b>{formatCurrency(suggested.source.total)}</b>.
          The job record said {formatCurrency(suggested.source.records_total)}, so check the record if that was wrong.
        </div>
      ) : null}

      {saved.length > 0 && (
        <div className="border-b border-border px-3 py-2">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Quick add</p>
          <div className="flex flex-wrap gap-1.5">
            {saved.map((s) => (
              <span key={s.name} className="inline-flex h-8 items-center rounded-full border border-border bg-muted/50 text-xs">
                <button type="button" onClick={() => addSaved(s)} className="h-full rounded-l-full pl-2.5 pr-1 font-medium hover:bg-muted" title={s.description || undefined}>
                  + {s.name}
                </button>
                <button type="button" onClick={() => forget(s.name)} className="h-full rounded-r-full px-1.5 text-muted-foreground hover:bg-muted" aria-label={`Remove saved line ${s.name}`}><X className="h-3 w-3" /></button>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="flex justify-between bg-muted/60 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span>Item</span><span>Qty × price = total</span>
      </div>
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.key} className="px-3 py-2">
            <div className="grid grid-cols-[1fr_3.5rem] items-center gap-1">
              <input value={r.name} onChange={(e) => set(r.key, { name: e.target.value })} placeholder="Item name" className={cn(field, "h-8 text-sm font-semibold")} />
              <span className="flex justify-end">
                <button type="button" onClick={() => saveLine(r)} className="rounded-md p-1 hover:bg-muted" aria-label="Save this line for next time" title="Save this line for next time">
                  <Star className={cn("h-3.5 w-3.5", isSaved(r) ? "fill-amber-400 text-amber-500" : "text-muted-foreground")} />
                </button>
                <button type="button" onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((x) => x.key !== r.key) : [blankRow()]))} className="rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label="Remove line"><Trash2 className="h-3.5 w-3.5" /></button>
              </span>
            </div>
            <input value={r.description} onChange={(e) => set(r.key, { description: e.target.value })} placeholder="Note the customer sees (optional)" className={cn(field, "mt-0.5 h-7 w-full text-xs text-muted-foreground")} />
            {/* Quantity × price each = the line total, like any invoice. */}
            <div className="mt-1 flex items-center gap-1.5 text-sm">
              <label className="flex h-8 items-center gap-1 rounded-md border border-border bg-background px-1.5 focus-within:border-primary">
                <span className="text-[11px] font-semibold uppercase text-muted-foreground">Qty</span>
                <input value={r.qty} onChange={(e) => set(r.key, { qty: e.target.value.replace(/[^0-9.]/g, "") })} inputMode="decimal" aria-label="Quantity"
                  className="w-10 bg-transparent text-right text-sm font-semibold tabular-nums outline-none" />
              </label>
              <span className="text-muted-foreground">×</span>
              <div className="flex h-8 w-28 items-center rounded-md border border-border bg-background px-1.5 focus-within:border-primary">
                <span className="shrink-0 text-sm text-muted-foreground">$</span>
                <input value={r.amount} onChange={(e) => set(r.key, { amount: e.target.value })} inputMode="decimal" placeholder="0.00" aria-label={qtyOf(r) !== 1 ? "Price each" : "Price"}
                  className="min-w-0 w-full bg-transparent text-right text-sm font-semibold tabular-nums outline-none" />
              </div>
              {qtyOf(r) !== 1 ? <span className="text-xs text-muted-foreground">each</span> : null}
              <span className="ml-auto font-bold tabular-nums">{money(lineTotal(r))}</span>
            </div>
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
        {siteExtras.length ? (
          <button type="button" title={siteExtras.map((x) => `${x.qty} × ${x.name} @ ${formatCurrency(x.unit_price)}`).join("\n")}
                  onClick={() => {
                    setRows((rs) => [...rs.filter((r) => r.name.trim() || num(r.amount)),
                      ...siteExtras.map((x) => ({ ...blankRow(), name: x.name, description: "Agreed on site", qty: String(x.qty), amount: String(x.unit_price) }))]);
                    toast.success("Added what they agreed to on site");
                  }}
                  className="inline-flex h-8 items-center gap-1 rounded-md bg-amber-100 px-2 text-xs font-semibold text-amber-900 hover:bg-amber-200">
            <Plus className="h-3.5 w-3.5" /> On-site extras ({siteExtras.reduce((t, x) => t + x.qty, 0)})
          </button>
        ) : null}
        {bookedServices.length ? (
          <button type="button" title={bookedServices.map((x) => `${x.name} ${formatCurrency(x.unit_price)}`).join("\n")}
                  onClick={() => {
                    setRows((rs) => [...rs.filter((r) => r.name.trim() || num(r.amount)),
                      ...bookedServices.map((x) => ({ ...blankRow(), name: x.name, description: x.description || "Booked with the fence", qty: String(x.qty), amount: String(x.unit_price) }))]);
                    toast.success("Added the other services they booked");
                  }}
                  className="inline-flex h-8 items-center gap-1 rounded-md bg-sky-100 px-2 text-xs font-semibold text-sky-900 hover:bg-sky-200">
            <Plus className="h-3.5 w-3.5" /> Booked services ({bookedServices.length})
          </button>
        ) : null}
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
      <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-3 py-2 text-sm">
        <span className="mr-1 font-semibold">Due</span>
        <button type="button" onClick={() => setDueOn(null)}
          className={cn("h-9 rounded-full px-3 text-xs font-semibold ring-1", dueOn === null ? "bg-foreground text-background ring-foreground" : "bg-background ring-border hover:bg-muted")}>
          Upon receipt
        </button>
        <label className={cn("flex h-9 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs font-semibold ring-1", dueOn !== null ? "bg-foreground text-background ring-foreground" : "bg-background ring-border hover:bg-muted")}>
          On a day
          <input type="date" value={dueOn ?? ""} min={todayIso()} onChange={(e) => setDueOn(e.target.value || null)}
            className={cn("h-7 rounded-md border-0 bg-transparent px-1 text-xs tabular-nums outline-none", dueOn !== null ? "text-background [color-scheme:dark]" : "w-[7.5rem] text-muted-foreground")} />
        </label>
      </div>
      <SharePhotos leadId={leadId} />
      <label className={cn("flex cursor-pointer items-center gap-3 border-t border-border px-3 py-2 text-sm", klarna && "bg-[#FFB3C7]/15")}>
        <input type="checkbox" checked={klarna} onChange={(e) => setKlarna(e.target.checked)} className="h-5 w-5 shrink-0 accent-pink-500" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 font-semibold">
            <span className={cn("rounded px-1 text-[12px] font-black tracking-tight", klarna ? "bg-[#FFB3C7] text-black" : "bg-muted text-muted-foreground line-through")}>Klarna.</span>
            {klarna ? "On: they can pay over time" : "Off"}
          </span>
          <span className="block text-xs text-muted-foreground">{klarna ? "The pink Klarna choice shows on their pay page. Klarna takes about 3% from you." : "No Klarna on their pay page: card, Apple Pay, Google Pay, bank account and Cash App only."}</span>
        </span>
        <KlarnaPicture on={klarna} total={Math.max(0, due)} />
      </label>
      <div className="flex justify-end gap-1.5 border-t border-border bg-muted/40 px-3 py-2">
        <button type="button" onClick={reset} className="mr-auto h-9 shrink-0 rounded-md px-2 text-sm font-semibold hover:bg-background">Cancel</button>
        <button type="button" onClick={() => setPreview(true)} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-semibold hover:bg-muted">
          <Eye className="h-3.5 w-3.5" /> Preview
        </button>
        <button type="button" onClick={make} disabled={busy} className="inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-emerald-600 px-3 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-60">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ReceiptText className="h-3.5 w-3.5" />} {editing ? "Save changes" : "Make invoice link"}
        </button>
      </div>
      {preview && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-3 sm:items-center" onClick={() => setPreview(false)}>
          <div className="w-full max-w-[430px] rounded-2xl bg-white p-4 text-[#111110] shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <p className="text-[12px] font-bold uppercase tracking-[0.18em] text-[#8C6224]">Preview · what the customer sees</p>
              <button type="button" onClick={() => setPreview(false)} className="rounded-full p-1.5 hover:bg-black/10" aria-label="Close preview"><X className="h-4 w-4" /></button>
            </div>
            <InvoiceSheet info={{
              amount: Math.max(0, due), items: buildItems(), credit: paid,
              name: billTo?.name || "", address: billTo?.address || "", invoice_number: billTo?.invoice_number || "", date: new Date().toISOString(), due_date: dueOn,
            }} />
            <div className="mt-4 flex h-14 w-full items-center justify-center rounded-xl bg-[#111110] text-[17px] font-semibold text-white opacity-90">
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


// A tiny phone of the screen the switch turns on or off, so the box isn't
// just words (Alan, 2026-10-15).
function MiniPhone({ on, children, label }: { on: boolean; children: ReactNode; label: string }) {
  return (
    <span className="relative shrink-0" aria-hidden>
      <span className={cn("flex h-[92px] w-[56px] flex-col items-center gap-1 rounded-[10px] border-2 border-stone-800 bg-[#FBF8F2] px-1 pb-1 pt-2 transition", !on && "opacity-40 grayscale")}>
        {children}
      </span>
      {!on ? (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="rotate-[-12deg] rounded bg-rose-600 px-1 text-[9px] font-black uppercase tracking-wide text-white shadow">{label}</span>
        </span>
      ) : null}
    </span>
  );
}

function ReviewPicture({ on }: { on: boolean }) {
  return (
    <MiniPhone on={on} label="Skipped">
      <span className="text-[7px] font-bold leading-tight text-stone-800">Thank you!</span>
      <span className="flex gap-px">{[0, 1, 2, 3, 4].map((i) => <Star key={i} className="h-2 w-2 fill-amber-400 text-amber-400" />)}</span>
      <span className="mt-auto flex w-full items-center justify-center gap-0.5 rounded bg-white py-1 text-[7px] font-bold text-stone-800 ring-1 ring-stone-300">
        <span className="font-black"><span className="text-[#4285F4]">G</span></span> Review
      </span>
    </MiniPhone>
  );
}

function KlarnaPicture({ on, total }: { on: boolean; total: number }) {
  return (
    <MiniPhone on={true} label="">
      <span className="text-[7px] font-bold leading-tight text-stone-800">Pay {total ? formatCurrency(total).replace(/\.00$/, "") : ""}</span>
      <span className="mt-auto w-full rounded bg-stone-800 py-1 text-center text-[7px] font-bold text-white">Card</span>
      <span className="relative w-full">
        <span className={cn("block w-full rounded py-1 text-center text-[7px] font-black tracking-tight", on ? "bg-[#FFB3C7] text-black" : "bg-stone-200 text-stone-400 line-through")}>Klarna.</span>
        {!on ? <span className="absolute -right-1 -top-1.5 flex h-3 w-3 items-center justify-center rounded-full bg-rose-600 text-[8px] font-black leading-none text-white">×</span> : null}
      </span>
    </MiniPhone>
  );
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
