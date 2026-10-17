// /pay/{token}: the page a customer lands on from a payment text. It shows
// what they're paying and one button, which asks the backend for a fresh
// Stripe Checkout session and sends them to Stripe. Nothing about the card
// ever touches this page. (Alan's post-payment spec, 2026-10-10.)
//
// Raw fetch on purpose: the dashboard's API client bounces a 401 to the
// staff login, which is the wrong place to drop a customer.
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Lock, Phone, ShieldCheck, Star } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { TermsBody } from "@/components/proposal/TermsBody";
import { dueText } from "@/lib/due";

const BASE = import.meta.env.VITE_API_URL || "";
const GOLD = "#C9972F";
const PHONE = "346-589-7877";

export type InvoiceItem = {
  name: string; description: string; amount: number; discount?: number; discount_label?: string; total_discount?: boolean;
  /** Quantity × price each (stored as qty; the builder's preview sends quantity). */
  qty?: number; quantity?: number; unit_price?: number;
};

export type Info = {
  kind: string; label: string; amount: number; description: string; status: string;
  first_name: string; address: string; configured: boolean;
  items?: InvoiceItem[]; credit?: number;
  name?: string; invoice_number?: string; date?: string; financing?: boolean;
  /** YYYY-MM-DD; empty = due upon receipt. */
  due_date?: string | null;
  /** Made by the proposal's Apply for Klarna button: this page walks them through Klarna. */
  klarna?: boolean;
  /** Stripe's public key, so the payment form can show on this page. */
  publishable_key?: string;
};

// Stripe.js, loaded from Stripe when the page needs it.
type StripeJs = { initEmbeddedCheckout: (o: { fetchClientSecret: () => Promise<string> }) => Promise<{ mount: (el: HTMLElement) => void; destroy: () => void }> };
declare global { interface Window { Stripe?: (pk: string) => StripeJs } }
function loadStripeJs(): Promise<void> {
  if (window.Stripe) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src^="https://js.stripe.com/v3"]');
    const tag = existing || Object.assign(document.createElement("script"), { src: "https://js.stripe.com/v3/", async: true });
    tag.addEventListener("load", () => (window.Stripe ? resolve() : reject(new Error("Stripe didn't load"))));
    tag.addEventListener("error", () => reject(new Error("Stripe didn't load")));
    if (!existing) document.head.appendChild(tag);
  });
}

/** Stripe's own payment form, on this page: Apple Pay, Google Pay, the card
 *  fields, Cash App, bank, all visible at once with Stripe's name on it. If
 *  it can't load (an in-app browser, a blocked script), the page falls back
 *  to the one-button jump to Stripe's page. */
function EmbeddedCheckout({ token, pk, preview, onFail }: { token: string; pk: string; preview: boolean; onFail: () => void }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let dead = false;
    let mounted = false;
    let checkout: { destroy: () => void } | null = null;
    const giveUp = setTimeout(() => { if (!dead && !mounted) onFail(); }, 15000);
    (async () => {
      try {
        await loadStripeJs();
        const stripe = window.Stripe!(pk);
        const c = await stripe.initEmbeddedCheckout({
          fetchClientSecret: async () => {
            const r = await fetch(`${BASE}/api/pay/${encodeURIComponent(token)}/session`, {
              method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ embedded: true, preview }),
            });
            const data = (await r.json()) as { client_secret?: string; url?: string; detail?: string };
            if (data.url && !data.client_secret) { window.location.assign(data.url); return ""; }
            if (!r.ok || !data.client_secret) throw new Error(data.detail || "Stripe couldn't start the payment.");
            return data.client_secret;
          },
        });
        if (dead) { c.destroy(); return; }
        checkout = c;
        if (box.current) c.mount(box.current);
        mounted = true;
        setReady(true);
      } catch {
        if (!dead) onFail();
      }
    })();
    return () => { dead = true; clearTimeout(giveUp); checkout?.destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mounts once per link
  }, [token, pk]);
  return (
    <div className="relative min-h-[320px]">
      {!ready && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[15px] text-[#15130F]/70">
          <span className="h-8 w-8 animate-spin rounded-full border-4 border-[#15130F]/10 border-t-[#C9972F]" />
          Loading secure checkout…
        </div>
      )}
      <div ref={box} className={ready ? "" : "opacity-0"} />
    </div>
  );
}

// The ways to pay, so nobody has to guess what the form will offer.
const METHODS: { label: string; cls: string }[] = [
  { label: "VISA", cls: "bg-[#1A1F71] text-white italic tracking-wide" },
  { label: "Mastercard", cls: "bg-[#222] text-white" },
  { label: "AMEX", cls: "bg-[#016FD0] text-white" },
  { label: "Discover", cls: "bg-[#FF6000] text-white" },
  { label: " Pay", cls: "bg-black text-white" },
  { label: "G Pay", cls: "bg-white text-[#3c4043] ring-1 ring-[#dadce0]" },
  { label: "Cash App", cls: "bg-[#00D632] text-white" },
  { label: "Bank", cls: "bg-[#F1EDE3] text-[#15130F] ring-1 ring-[#15130F]/15" },
];

function TrustStrip({ deposit }: { deposit: boolean }) {
  const [reviews, setReviews] = useState<{ rating: number | null; total: number } | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`${BASE}/api/public/reviews`).then((r) => (r.ok ? r.json() : null))
      .then((d: { rating: number | null; total: number } | null) => { if (live && d && d.total) setReviews({ rating: d.rating, total: d.total }); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return (
    <div className="mt-5 space-y-3 text-[14px] text-[#15130F]/80">
      <p className="flex items-start gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#2F5137]" /><span><b className="text-[#15130F]">Your payment is handled by Stripe</b>, the same company behind payments for Amazon, Target and millions of businesses. Your card details go to Stripe, never to us.</span></p>
      {deposit ? <p className="flex items-start gap-2"><Lock className="mt-0.5 h-4 w-4 shrink-0 text-[#2F5137]" /><span><b className="text-[#15130F]">The deposit comes off your total</b> and holds your dates. Once your dates are set it isn't refundable, because we've turned other work away for them.</span></p> : null}
      <p className="flex items-start gap-2"><Star className="mt-0.5 h-4 w-4 shrink-0 text-[#C9972F]" /><span><b className="text-[#15130F]">Sterling Fence Staining</b>, the fence-staining sister company of A&amp;T Pressure Washing, Houston.{reviews ? <> {reviews.rating ? `${reviews.rating.toFixed(1)} stars` : ""} from {reviews.total} Google reviews.</> : null} Call the office any time: {PHONE}.</span></p>
    </div>
  );
}

export default function PayLink() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<Info | "loading" | "gone">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [terms, setTerms] = useState(false);
  // A deposit link lives 7 days; the API says so with a 410 and a sentence.
  const [goneWhy, setGoneWhy] = useState("");
  // Stripe's form on the page; when it can't load, the one-button jump.
  const [embedFailed, setEmbedFailed] = useState(false);
  const isPreview = new URLSearchParams(window.location.search).get("preview") === "1";

  useEffect(() => {
    let alive = true;
    document.title = "Pay Sterling Fence Staining";
    (async () => {
      try {
        // Staff open their own links with ?preview=1 so it never counts as the customer's view.
        const preview = new URLSearchParams(window.location.search).get("preview") === "1" ? "?preview=1" : "";
        const r = await fetch(`${BASE}/api/pay/${encodeURIComponent(token || "")}${preview}`);
        if (!r.ok) {
          if (r.status === 410) {
            const why = (await r.json().catch(() => ({}))) as { detail?: string };
            if (alive) setGoneWhy(why.detail || "");
          }
          throw new Error(String(r.status));
        }
        const data = (await r.json()) as Info;
        if (!alive) return;
        if (data.status === "paid") {
          window.location.replace(`/after/${token}`);
          return;
        }
        setInfo(data);
      } catch {
        if (alive) setInfo("gone");
      }
    })();
    return () => { alive = false; };
  }, [token]);

  const pay = async (method = "") => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`${BASE}/api/pay/${encodeURIComponent(token || "")}/session`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method }),
      });
      const data = (await r.json()) as { url?: string; detail?: string };
      if (!r.ok || !data.url) throw new Error(data.detail || "Stripe couldn't start the payment.");
      window.location.assign(data.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
      setBusy(false);
    }
  };

  if (info === "gone") {
    return (
      <Shell>
        <h1 className="font-heading text-3xl font-bold leading-tight">{goneWhy ? "This link has expired." : "This link isn't active."}</h1>
        <p className="mt-2 text-[17px] text-[#15130F]/80">{goneWhy || "If you were expecting to pay, call or text us and we'll send a fresh one."}</p>
        <Contact />
      </Shell>
    );
  }
  if (info === "loading") {
    return <Shell><p className="text-[17px] font-semibold text-[#15130F]/75">One moment…</p></Shell>;
  }
  const deposit = info.kind === "deposit";
  // Apply for Klarna (Alan, 2026-10-14): Exolei landed on "here's what's due"
  // and never knew Klarna was the next step. This page says it plainly, and
  // Stripe opens with Klarna as the only choice.
  if (info.klarna && info.configured) {
    return (
      <Shell>
        <p className="text-[13px] font-bold uppercase tracking-[0.2em]" style={{ color: "#8C6224" }}>Pay over time</p>
        <h1 className="mt-1 font-heading text-3xl font-bold leading-tight">{info.first_name ? `Hi ${info.first_name}, ` : ""}apply for Klarna.</h1>
        <div className="mt-4 rounded-2xl bg-white p-4 ring-1 ring-[#15130F]/10">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-20 shrink-0 items-center justify-center rounded-md bg-[#FFB3C7] text-[18px] font-black tracking-tight text-black">Klarna.</span>
            <div>
              <p className="text-[15px] text-[#15130F]/75">Your fence, paid over time</p>
              <p className="font-heading text-3xl font-bold leading-none tabular-nums">{formatCurrency(info.amount)}</p>
            </div>
          </div>
          {info.description ? <p className="mt-3 text-[15px] text-[#15130F]/80">{info.description.replace(/, financed on the proposal$/, "")}</p> : null}
          {info.address ? <p className="mt-0.5 text-[15px] text-[#15130F]/80">{info.address}</p> : null}
        </div>
        <ol className="mt-4 space-y-3">
          {[
            ["Tap “Continue to Klarna” below.", "It opens Klarna's secure page."],
            ["Pick 4 payments or a monthly plan.", "Klarna asks a few quick questions."],
            ["See your plan before you agree.", "Checking doesn't affect your credit score. Nothing is charged until you say yes."],
          ].map(([a, b], i) => (
            <li key={a} className="flex items-start gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#15130F] text-[15px] font-bold text-[#E3BE63]">{i + 1}</span>
              <span className="pt-0.5"><span className="block text-[17px] font-bold leading-snug">{a}</span><span className="block text-[15px] leading-snug text-[#15130F]/75">{b}</span></span>
            </li>
          ))}
        </ol>
        <button type="button" onClick={() => void pay("klarna")} disabled={busy}
          className="mt-5 flex h-14 w-full items-center justify-center gap-2 rounded-xl text-[18px] font-bold text-[#15130F] shadow-lg active:scale-[0.98] disabled:opacity-60" style={{ background: GOLD }}>
          {busy ? "Opening Klarna…" : "Continue to Klarna"}
        </button>
        <p className="mt-2 text-center text-[14px] text-[#15130F]/75">Once Klarna says yes, your job is paid and your dates get booked.</p>
        <p className="mt-1 text-center text-[14px] text-[#15130F]/75">By paying, you agree to our <button type="button" onClick={() => setTerms(true)} className="inline-flex min-h-[44px] items-center font-bold text-[#8C6224] underline underline-offset-2">Terms</button>.</p>
        {error ? <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-[15px] font-semibold text-rose-800">{error}</p> : null}
        <button type="button" onClick={() => void pay()} disabled={busy}
          className="mt-4 flex min-h-[44px] w-full items-center justify-center text-[15px] font-semibold text-[#15130F]/80 underline underline-offset-2">
          Rather pay it all now by card?
        </button>
        {terms ? <TermsSheet onClose={() => setTerms(false)} /> : null}
        <p className="mt-6 flex items-center justify-center gap-2 text-[13px] text-[#15130F]/65"><Lock className="h-3.5 w-3.5" /> Secure checkout by Stripe</p>
        <Contact />
      </Shell>
    );
  }
  // Stripe's in-page form showed "Something went wrong" on a customer's
  // phone (Jeff, 2026-10-17) while the hosted page works, so the hosted
  // jump is the default until the form is proven; ?embed=1 tries the form.
  const wantEmbed = new URLSearchParams(window.location.search).get("embed") === "1";
  const canEmbed = wantEmbed && info.configured && !!info.publishable_key && !embedFailed;
  return (
    <Shell>
      <p className="text-[13px] font-bold uppercase tracking-[0.2em]" style={{ color: "#8C6224" }}>{info.label}</p>
      <h1 className="mt-1 font-heading text-3xl font-bold leading-tight">
        {info.first_name ? `Hi ${info.first_name}, ` : ""}{deposit ? "this books your spot." : info.items?.length ? "here's your invoice." : "here's what's due."}
      </h1>
      {!deposit && info.items?.length ? <InvoiceDoc info={info} /> : (
        <div className="mt-4 rounded-2xl bg-white p-4 ring-1 ring-[#15130F]/10">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[15px] text-[#15130F]/75">{deposit ? "Deposit today" : "Due today"}</p>
              <p className="font-heading text-5xl font-bold leading-none tabular-nums">{formatCurrency(info.amount)}</p>
            </div>
            <span className="mt-1 inline-flex shrink-0 items-center gap-1 rounded-full bg-[#E6EEE2] px-2.5 py-1 text-[12px] font-bold text-[#2F5137]"><Lock className="h-3 w-3" /> Secure</span>
          </div>
          {info.address ? <p className="mt-3 text-[15px] text-[#15130F]/80">{info.address}</p> : null}
          {info.description ? <p className="mt-1 text-[15px] text-[#15130F]/80">{info.description}</p> : null}
          {deposit ? <p className="mt-2 text-[14px] text-[#15130F]/70">Comes off your total. Holds your dates.</p> : null}
        </div>
      )}

      {info.configured ? (
        <>
          <div className="mt-4 overflow-hidden rounded-2xl bg-white ring-1 ring-[#15130F]/10">
            <div className="flex items-center justify-between gap-2 border-b border-[#15130F]/10 px-4 py-3">
              <p className="flex items-center gap-2 text-[15px] font-bold"><Lock className="h-4 w-4 text-[#2F5137]" /> Secure checkout</p>
              <span className="text-[13px] font-semibold text-[#15130F]/65">Powered by <span className="font-black text-[#635BFF]">stripe</span></span>
            </div>
            <div className="flex flex-wrap gap-1.5 px-4 pt-3">
              {METHODS.map((m) => <span key={m.label} className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${m.cls}`}>{m.label}</span>)}
              {deposit || info.financing === false ? null : <span className="rounded-md bg-[#FFB3C7] px-2 py-0.5 text-[11px] font-black text-black">Klarna.</span>}
            </div>
            <div className="p-3 sm:p-4">
              {canEmbed ? (
                <>
                  <EmbeddedCheckout key={token} token={token || ""} pk={info.publishable_key!} preview={isPreview} onFail={() => setEmbedFailed(true)} />
                  <button type="button" onClick={() => void pay()} disabled={busy}
                    className="mt-2 flex min-h-[44px] w-full items-center justify-center text-[14px] font-semibold text-[#15130F]/75 underline underline-offset-2">
                    Form not loading? Open the secure payment page instead
                  </button>
                </>
              ) : (
                <>
                  <button type="button" onClick={() => void pay()} disabled={busy}
                    className="flex h-14 w-full items-center justify-center gap-2 rounded-xl text-[18px] font-bold text-[#15130F] shadow-lg active:scale-[0.98] disabled:opacity-60" style={{ background: GOLD }}>
                    <Lock className="h-5 w-5" /> {busy ? "Opening secure checkout…" : `Pay ${formatCurrency(info.amount)}`}
                  </button>
                  <p className="mt-2 text-center text-[14px] text-[#15130F]/75">Opens Stripe's secure payment page. You pick how to pay there.</p>
                  {/* Stripe's page stayed blank on a customer's phone (Jeff, 2026-10-16): say what to do. */}
                  <p className="mt-3 rounded-xl bg-[#FFF7E6] px-3 py-3 text-[14px] text-[#15130F]/85 ring-1 ring-[#C9972F]/40">
                    <b>Payment page stays blank?</b> Open this link in Safari or Chrome (not inside your email or Facebook app), or call or text us at {PHONE} and we'll send another way to pay.
                  </p>
                </>
              )}
            </div>
          </div>
          <p className="mt-3 text-center text-[14px] text-[#15130F]/75">By paying, you agree to our <button type="button" onClick={() => setTerms(true)} className="inline-flex min-h-[44px] items-center font-bold text-[#8C6224] underline underline-offset-2">Terms</button>.</p>
          {terms ? <TermsSheet onClose={() => setTerms(false)} /> : null}
          {error ? <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-[15px] font-semibold text-rose-800">{error}</p> : null}
          <TrustStrip deposit={deposit} />
        </>
      ) : (
        <p className="mt-4 rounded-xl bg-[#FFF7E6] px-3 py-3 text-[15px] ring-1 ring-[#C9972F]/50">Online payments are being set up. Call or text us and we'll take care of it.</p>
      )}
      <Contact />
    </Shell>
  );
}

const money = (n: number) => formatCurrency(n);
const minus = (n: number) => `− ${formatCurrency(Math.abs(n))}`;

/** An itemized invoice laid out like a paper one: who it's from, the number
 *  and date, who it's billed to, the lines, then the totals. A line's own
 *  discount sits right under it in green; a discount on the whole invoice
 *  sits in the totals. */
export function InvoiceDoc({ info, paid = false }: { info: Info; paid?: boolean }) {
  const items = info.items ?? [];
  const lines = items.filter((i) => !i.total_discount);
  const wholeOff = items.filter((i) => i.total_discount);
  const subtotal = lines.reduce((t, i) => t + i.amount, 0);
  const lineOff = lines.reduce((t, i) => t + (i.discount || 0), 0);
  const date = info.date ? new Date(info.date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "";
  return (
    <div className="mt-4 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-[#15130F]/10">
      <div className="flex items-end justify-between gap-3 bg-[#15130F] px-4 py-3 text-white">
        <div>
          <p className="text-[13px] font-bold uppercase tracking-[0.18em]" style={{ color: GOLD }}>Sterling</p>
          <p className="text-[13px] text-white/80">Fence Staining · Houston</p>
        </div>
        <p className="font-heading text-2xl font-bold tracking-wide">{paid ? "RECEIPT" : "INVOICE"}</p>
      </div>
      <div className="grid grid-cols-2 gap-3 border-b border-[#15130F]/10 px-4 py-3 text-[15px]">
        <div>
          <p className="text-[12px] font-bold uppercase tracking-wide text-[#15130F]/60">Bill to</p>
          {info.name ? <p className="font-bold capitalize">{info.name.toLowerCase()}</p> : null}
          {info.address ? <p className="text-[#15130F]/75">{info.address}</p> : null}
        </div>
        <div className="text-right">
          {info.invoice_number ? (<>
            <p className="text-[12px] font-bold uppercase tracking-wide text-[#15130F]/60">Invoice no.</p>
            <p className="font-bold tabular-nums">{info.invoice_number}</p>
          </>) : null}
          {date ? (<>
            <p className="mt-1 text-[12px] font-bold uppercase tracking-wide text-[#15130F]/60">Date</p>
            <p className="tabular-nums">{date}</p>
          </>) : null}
          {!paid ? (<>
            <p className="mt-1 text-[12px] font-bold uppercase tracking-wide text-[#15130F]/60">Due</p>
            <p className="font-bold tabular-nums">{dueText(info.due_date)}</p>
          </>) : null}
        </div>
      </div>
      <div className="flex justify-between bg-[#F8F3E7] px-4 py-2 text-[12px] font-bold uppercase tracking-wide text-[#15130F]/65">
        <span>Description</span><span>Amount</span>
      </div>
      <ul className="divide-y divide-[#15130F]/10 px-4">
        {lines.map((i, n) => (
          <li key={n} className="py-3">
            <div className="flex justify-between gap-3 text-[16px]">
              <div>
                <p className="font-bold">{i.name}</p>
                {(i.qty ?? i.quantity ?? 1) > 1 && i.unit_price ? (
                  <p className="text-[14px] font-semibold text-[#15130F]/75 tabular-nums">{i.qty ?? i.quantity} × {money(i.unit_price)}</p>
                ) : null}
                {i.description ? <p className="text-[14px] text-[#15130F]/70">{i.description}</p> : null}
              </div>
              <p className="shrink-0 font-semibold tabular-nums">{money(i.amount)}</p>
            </div>
            {i.discount ? (
              <div className="mt-1.5 flex justify-between gap-3 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-[15px] font-semibold text-emerald-800">
                <span>{i.discount_label || "Discount"}</span><span className="tabular-nums">{minus(i.discount)}</span>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <dl className="ml-auto space-y-1.5 border-t-2 border-[#15130F]/15 px-4 py-3 text-[15px] sm:w-3/4">
        <div className="flex justify-between gap-3"><dt className="text-[#15130F]/75">Subtotal</dt><dd className="tabular-nums">{money(subtotal)}</dd></div>
        {lineOff ? <div className="flex justify-between gap-3 text-emerald-800"><dt>Discounts</dt><dd className="tabular-nums">{minus(lineOff)}</dd></div> : null}
        {wholeOff.map((i, n) => (
          <div key={n} className="flex justify-between gap-3 text-emerald-800"><dt>{i.name}</dt><dd className="tabular-nums">{minus(i.amount)}</dd></div>
        ))}
        {info.credit ? <div className="flex justify-between gap-3"><dt className="text-[#15130F]/75">Already paid</dt><dd className="tabular-nums">{minus(info.credit)}</dd></div> : null}
      </dl>
      <div className="flex items-center justify-between gap-3 px-4 py-3" style={{ background: "#FBF3DF" }}>
        <span className="text-[17px] font-bold">{paid ? "Total paid" : "Total due"}</span>
        <span className="font-heading text-3xl font-bold tabular-nums">{money(info.amount)}</span>
      </div>
    </div>
  );
}

/** The terms over the pay page, so reading them never leaves checkout. */
function TermsSheet({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener("keydown", onKey); };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4" onClick={onClose}>
      <div className="flex max-h-[92vh] w-full max-w-md flex-col rounded-t-3xl bg-[#F8F3E7] text-[#15130F] shadow-2xl sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="overflow-y-auto p-5">
          <p className="text-[12px] font-bold uppercase tracking-[0.2em] text-[#8C6224]">The fine print, without the fine print</p>
          <h3 className="font-heading text-2xl font-bold leading-tight">Our terms</h3>
          <div className="mt-3 space-y-4 text-[17px] leading-relaxed"><TermsBody /></div>
        </div>
        <div className="border-t border-[#15130F]/10 p-4">
          <button type="button" onClick={onClose} className="h-12 w-full rounded-xl text-base font-bold text-[#15130F]" style={{ background: GOLD }}>Got it</button>
        </div>
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#F8F3E7] text-[#15130F]">
      <div className="mx-auto max-w-md">
        <div className="flex items-center justify-between bg-[#15130F] px-4 py-3">
          <img src="/sterling-logo-dark.png" alt="Sterling Fence Staining" className="h-8 w-auto" draggable={false} />
          <a href={`tel:+1${PHONE.replace(/-/g, "")}`} className="inline-flex h-10 items-center gap-2 rounded-full px-4 text-[15px] font-bold text-[#15130F]" style={{ background: GOLD }}>
            <Phone className="h-4 w-4" /> Call
          </a>
        </div>
        <div className="px-5 py-6"><InAppWarning />{children}</div>
      </div>
    </div>
  );
}

// Facebook, Instagram, Outlook and other apps open links in their own
// built-in browser, where Stripe's page can stay blank (Jeff, 2026-10-16).
const IN_APP = /FBAN|FBAV|FB_IAB|FBIOS|Instagram|Messenger|Line\/|GSA\/|LinkedInApp|Snapchat|Twitter|TikTok|musical_ly|Outlook|; wv\)/i;

function InAppWarning() {
  const [copied, setCopied] = useState(false);
  if (typeof navigator === "undefined" || !IN_APP.test(navigator.userAgent)) return null;
  const android = /Android/i.test(navigator.userAgent);
  const url = window.location.href.replace(/[?&]preview=1/, "");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      window.prompt("Copy this link, then paste it in Safari or Chrome:", url);
    }
  };
  return (
    <div className="mb-5 rounded-2xl bg-[#FFF7E6] p-4 ring-2 ring-[#C9972F]">
      <p className="text-[17px] font-bold leading-snug">Open this page in {android ? "Chrome" : "Safari"} to pay</p>
      <p className="mt-1 text-[15px] text-[#15130F]/80">
        You're inside another app, and the secure payment page may not load here.
        {android ? " Tap the button below." : " Tap ••• or the share button at the top or bottom, then \u201cOpen in Safari\u201d. Or copy the link and paste it in Safari."}
      </p>
      {android ? (
        <a href={`intent://${url.replace(/^https?:\/\//, "")}#Intent;scheme=https;package=com.android.chrome;end`}
          className="mt-3 flex h-12 w-full items-center justify-center rounded-xl text-[17px] font-bold text-[#15130F]" style={{ background: GOLD }}>Open in Chrome</a>
      ) : null}
      <button type="button" onClick={() => void copy()}
        className="mt-3 flex h-12 w-full items-center justify-center rounded-xl bg-white text-[17px] font-bold ring-1 ring-[#15130F]/20">
        {copied ? "Copied. Now paste it in " + (android ? "Chrome" : "Safari") : "Copy the link"}
      </button>
    </div>
  );
}

function Contact() {
  return (
    <p className="mt-6 text-center text-[15px] text-[#15130F]/75">
      Questions? Call or text <a href={`tel:+1${PHONE.replace(/-/g, "")}`} className="font-bold text-[#15130F] underline underline-offset-2">{PHONE}</a>
    </p>
  );
}
