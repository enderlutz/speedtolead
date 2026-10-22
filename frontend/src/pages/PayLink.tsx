// /pay/{token}: the page a customer lands on from a payment text. Stripe's
// payment form sits on our own page (Apple Pay or Google Pay on top, then
// card, Cash App and bank), under our own Pay button. The card fields are
// Stripe's iframes; nothing about the card ever touches this page. If the
// form can't load (an in-app browser, a blocked script, a server without
// this mode yet), the one-button jump to Stripe's hosted page takes over.
//
// The look (Alan, 2026-10-22, approved on the mockup page): white, Inter
// for everything, a serif only for the headline and the amount, hairline
// rows instead of boxes, the fields inside one soft panel with "Secured by
// Stripe" beside them, one black Pay button, gold as a hairline. The
// research behind it is in components/proposal/PayPageMock.tsx.
//
// Raw fetch on purpose: the dashboard's API client bounces a 401 to the
// staff login, which is the wrong place to drop a customer.
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Check, Lock, Phone, Star } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { TermsBody } from "@/components/proposal/TermsBody";
import { dueText } from "@/lib/due";

import { API_BASE as BASE } from "@/lib/apiBase";
const GOLD = "#C9972F";
const INK = "#111110";
const PHONE = "346-589-7877";
const SERIF = "'Instrument Serif', Georgia, 'Times New Roman', serif";
const SANS = "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif";
// Google Fonts serves the page and Stripe's iframes alike (Stripe takes a
// stylesheet address, so no font file of ours needs a CORS header).
const FONTS_URL = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&display=swap";

function useFonts() {
  useEffect(() => {
    if (document.getElementById("pay-fonts")) return;
    document.head.appendChild(Object.assign(document.createElement("link"), { id: "pay-fonts", rel: "stylesheet", href: FONTS_URL }));
  }, []);
}

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
  /** The lead has an email for the receipt; when not, the form asks for one. */
  has_email?: boolean;
  /** The whole job, so a deposit page can show what it comes off. */
  job_total?: number;
};

// Stripe.js, loaded from Stripe when the page needs it. Only the parts this
// page calls (the Checkout Elements SDK: a Checkout Session drawn with the
// Payment Element and the Express Checkout buttons on our own page).
type StripeEl = { mount: (el: HTMLElement) => void; destroy: () => void; on: (ev: string, cb: (e: never) => void) => void };
type ConfirmResult = { type: "success" } | { type: "error"; error: { message: string } };
type CheckoutActions = { confirm: (o?: Record<string, unknown>) => Promise<ConfirmResult> };
type CheckoutSession = { total?: { total?: { amount?: string } }; canConfirm?: boolean };
type CheckoutSdk = {
  on: (ev: "change", cb: (session: CheckoutSession) => void) => void;
  createPaymentElement: (o?: Record<string, unknown>) => StripeEl;
  createExpressCheckoutElement: (o?: Record<string, unknown>) => StripeEl;
  loadActions: () => Promise<{ type: "success"; actions: CheckoutActions } | { type: "error"; error: { message: string } }>;
};
type StripeJs = {
  initCheckoutElementsSdk: (o: { clientSecret: Promise<string> | string; elementsOptions?: Record<string, unknown> }) => CheckoutSdk;
};
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

// How Stripe's fields are drawn, in Stripe's Appearance API names: Inter,
// 16px inputs (no zoom on a phone), 10px corners, a hairline border that
// turns black on the field being typed in, the accordion items as quiet
// white rows. The primary colour is ink, so radios and focus rings match
// the Pay button; gold stays a hairline on the page itself.
const APPEARANCE = {
  theme: "stripe",
  variables: {
    colorPrimary: INK, colorBackground: "#FFFFFF", colorText: INK, colorTextSecondary: "#6B6963",
    colorTextPlaceholder: "#9B9890", colorDanger: "#B3261E", colorIcon: "#6B6963",
    fontFamily: SANS, fontSizeBase: "16px", fontWeightNormal: "500", borderRadius: "10px", spacingUnit: "4px",
    focusBoxShadow: `0 0 0 1px ${INK}`, focusOutline: "none",
  },
  rules: {
    ".Input": { border: "1px solid #D8D5CE", boxShadow: "none", padding: "13px 14px" },
    ".Input:focus": { border: `1px solid ${INK}`, boxShadow: `0 0 0 1px ${INK}` },
    ".Input--invalid": { border: "1px solid #B3261E", boxShadow: "none" },
    ".Label": { fontSize: "13px", fontWeight: "500", color: "#55534D", marginBottom: "6px" },
    ".AccordionItem": { border: "1px solid #E3E1DB", boxShadow: "none", padding: "13px 16px", fontWeight: "500", backgroundColor: "#FFFFFF" },
    ".AccordionItem--selected": { border: `1px solid ${INK}`, boxShadow: "0 1px 2px rgba(0,0,0,0.04)", color: INK },
    ".Tab": { border: "1px solid #E3E1DB", boxShadow: "none", fontWeight: "500" },
    ".Tab--selected": { border: `1px solid ${INK}`, boxShadow: "none", color: INK },
    ".Block": { border: "1px solid #E3E1DB", boxShadow: "none" },
    ".Error": { fontSize: "13px", fontWeight: "500" },
    ".TermsText": { fontSize: "12px", color: "#8F8C84" },
  },
};

const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Stripe's payment form on this page: the Apple Pay, Google Pay and Link
 *  buttons on top when the phone has them, then the card fields, Cash App
 *  and bank in an accordion, then our own Pay button. The server makes a
 *  Checkout Session in `elements` mode; paying goes to the same after page
 *  and the same webhook as the hosted page. If any of it can't load,
 *  `onFail` hands the page back to the one-button jump. */
function StripeForm({ token, pk, preview, amount, needEmail, onFail, onTerms }: {
  token: string; pk: string; preview: boolean; amount: number; needEmail: boolean; onFail: () => void; onTerms: () => void;
}) {
  const walletBox = useRef<HTMLDivElement | null>(null);
  const formBox = useRef<HTMLDivElement | null>(null);
  const actions = useRef<CheckoutActions | null>(null);
  const emailRef = useRef("");
  const [ready, setReady] = useState(false);
  const [wallets, setWallets] = useState(false);
  const [total, setTotal] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  emailRef.current = email;

  // The moment they mean to pay, so the office's NOT PAID YET alert still
  // fires if nothing lands; the typed email is kept on the lead.
  const tapped = () => {
    void fetch(`${BASE}/api/pay/${encodeURIComponent(token)}/tapped`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preview, email: emailRef.current.trim() }), keepalive: true,
    }).catch(() => {});
  };

  useEffect(() => {
    let dead = false;
    let mounted = false;
    let pay: StripeEl | null = null;
    let express: StripeEl | null = null;
    const giveUp = setTimeout(() => { if (!dead && !mounted) onFail(); }, 20000);
    const fetchSecret = async (): Promise<string> => {
      let r: Response | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          r = await fetch(`${BASE}/api/pay/${encodeURIComponent(token)}/session`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ elements: true, preview }),
          });
          if (r.status < 500) break;
        } catch { r = null; }
        await new Promise((res) => setTimeout(res, 2000));
      }
      const data = (r ? await r.json().catch(() => ({})) : {}) as { client_secret?: string; url?: string; paid?: boolean };
      if (data.paid && data.url) { window.location.assign(data.url); return ""; }
      if (!r || !r.ok || !data.client_secret) {
        // A server without this mode yet answers with the hosted address;
        // the button takes over instead of Stripe's own error.
        onFail();
        // The form is being torn down; leave Stripe waiting rather than
        // surfacing an error of its own.
        return new Promise<string>(() => {});
      }
      return data.client_secret;
    };
    (async () => {
      try {
        await loadStripeJs();
        const stripe = window.Stripe!(pk);
        const checkout = stripe.initCheckoutElementsSdk({
          clientSecret: fetchSecret(), elementsOptions: { appearance: APPEARANCE, fonts: [{ cssSrc: FONTS_URL }], loader: "auto" },
        });
        // Stripe insists the page shows the session's own total.
        checkout.on("change", (s: CheckoutSession) => { const a = s?.total?.total?.amount; if (a && !dead) setTotal(a); });
        if (dead) return;
        express = checkout.createExpressCheckoutElement({
          buttonHeight: 52, buttonType: { applePay: "plain", googlePay: "plain" },
          layout: { maxColumns: 1, maxRows: 3, overflow: "never" }, emailRequired: needEmail,
        });
        express.on("availablepaymentmethodschange", (e: never) => {
          const { paymentMethods } = e as unknown as { paymentMethods: Record<string, boolean> | undefined };
          if (!dead) setWallets(!!paymentMethods);
        });
        if (walletBox.current) express.mount(walletBox.current);
        pay = checkout.createPaymentElement({
          layout: { type: "accordion", radios: "if_multiple", spacedAccordionItems: true, visibleAccordionItemsCount: 0 },
        });
        pay.on("ready", () => { mounted = true; if (!dead) setReady(true); });
        pay.on("loaderror", () => { if (!dead) onFail(); });
        if (formBox.current) pay.mount(formBox.current);
        const loaded = await checkout.loadActions();
        if (loaded.type !== "success") throw new Error(loaded.error.message);
        actions.current = loaded.actions;
        express.on("confirm", (ev: never) => {
          tapped();
          const mail = emailRef.current.trim();
          void loaded.actions.confirm({ expressCheckoutConfirmEvent: ev, ...(mail ? { email: mail } : {}) })
            .then((res) => { if (res.type === "error" && !dead) setError(res.error.message); });
        });
      } catch {
        if (!dead) onFail();
      }
    })();
    return () => { dead = true; clearTimeout(giveUp); pay?.destroy(); express?.destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mounts once per link
  }, [token, pk]);

  const payNow = async () => {
    if (busy || !actions.current) return;
    const mail = email.trim();
    if (needEmail && !EMAIL_OK.test(mail)) { setError("Type the email for your receipt."); return; }
    setBusy(true);
    setError("");
    tapped();
    try {
      const res = await actions.current.confirm(mail ? { email: mail } : {});
      // Paid: Stripe sends them to the after page. Only an error comes back here.
      if (res.type === "error") { setError(res.error.message); setBusy(false); }
    } catch {
      setError("Something went wrong. Try again, or call us.");
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      {!ready && (
        <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 text-[14px] font-medium text-[#6B6963]">
          <span className="h-8 w-8 animate-spin rounded-full border-[3px] border-[#E3E1DB] border-t-[#111110]" />
          Loading secure payment…
        </div>
      )}
      <div className={ready ? "" : "h-0 overflow-hidden opacity-0"}>
        {/* Apple Pay, Google Pay, Link: only when this phone has one. */}
        <div className={wallets ? "" : "hidden"}>
          <div ref={walletBox} />
          <div className="my-4 flex items-center gap-3 text-[12px] font-medium text-[#8F8C84]">
            <span className="h-px flex-1 bg-[#E3E1DB]" />or<span className="h-px flex-1 bg-[#E3E1DB]" />
          </div>
        </div>
        <div ref={formBox} />
        {needEmail ? (
          <label className="mt-4 block">
            <span className="mb-1.5 block text-[13px] font-medium text-[#55534D]">Email for your receipt</span>
            <input type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com"
              className="h-12 w-full rounded-[10px] border border-[#D8D5CE] bg-white px-3.5 text-[16px] font-medium text-[#111110] outline-none placeholder:text-[#9B9890] focus:border-[#111110] focus:ring-1 focus:ring-[#111110]" />
          </label>
        ) : null}
        <button type="button" onClick={() => void payNow()} disabled={busy}
          className="mt-4 flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-[#111110] text-[17px] font-semibold text-white active:scale-[0.98] disabled:opacity-60">
          <Lock className="h-4 w-4" /> {busy ? "Paying…" : `Pay ${total || formatCurrency(amount)}`}
        </button>
        {error ? <p className="mt-3 rounded-[10px] bg-rose-50 px-3 py-2 text-[14px] font-medium text-rose-800">{error}</p> : null}
        <p className="mt-3 text-center text-[12px] leading-relaxed text-[#8F8C84]">
          By paying, you agree to our <button type="button" onClick={onTerms} className="inline-flex min-h-[44px] items-center font-semibold underline underline-offset-2">Terms</button>.
          Your card details go to Stripe, never to us.
        </p>
      </div>
    </div>
  );
}

/** One line of proof: the stars, the reviews, who we are. */
function ProofLine() {
  const [reviews, setReviews] = useState<{ rating: number | null; total: number } | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`${BASE}/api/public/reviews`).then((r) => (r.ok ? r.json() : null))
      .then((d: { rating: number | null; total: number } | null) => { if (live && d && d.total) setReviews({ rating: d.rating, total: d.total }); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return (
    <div className="mt-7 flex items-center gap-2 text-[13px] text-[#6B6963]">
      <span className="flex items-center gap-0.5">{[0, 1, 2, 3, 4].map((i) => <Star key={i} className="h-3.5 w-3.5 fill-[#C9972F] text-[#C9972F]" />)}</span>
      <span>
        {reviews ? <><span className="font-semibold text-[#111110]">{reviews.rating ? reviews.rating.toFixed(1) : "5.0"}</span> · {reviews.total} Google reviews · </> : null}
        Sister company of A&amp;T Pressure Washing, Houston
      </span>
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
  useFonts();

  useEffect(() => {
    let alive = true;
    document.title = "Pay Sterling Fence Staining";
    (async () => {
      try {
        // Staff open their own links with ?preview=1 so it never counts as the customer's view.
        const preview = new URLSearchParams(window.location.search).get("preview") === "1" ? "?preview=1" : "";
        // A server restart (a deploy) takes about a minute. Keep trying
        // through it instead of telling the customer the link is dead
        // (Alan hit exactly that on Jeff's link, 2026-10-17). Only a real
        // 404 or 410 is final.
        let r: Response | null = null;
        for (let attempt = 0; attempt < 8 && alive; attempt++) {
          try {
            r = await fetch(`${BASE}/api/pay/${encodeURIComponent(token || "")}${preview}`);
            if (r.ok || r.status === 404 || r.status === 410) break;
          } catch { r = null; }
          await new Promise((res) => setTimeout(res, 1500 + attempt * 1500));
        }
        if (!r) throw new Error("offline");
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
      // Same patience on the Pay tap: a restart mid-tap retries, not errors.
      let r: Response | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          r = await fetch(`${BASE}/api/pay/${encodeURIComponent(token || "")}/session`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method, preview: isPreview }),
          });
          if (r.status < 500) break;
        } catch { r = null; }
        await new Promise((res) => setTimeout(res, 2000));
      }
      if (!r) throw new Error("Can't reach the server right now. Give it a few seconds and tap again.");
      const data = (await r.json().catch(() => ({}))) as { url?: string; detail?: string };
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
    return <Shell><p className="flex items-center gap-2 text-[17px] font-semibold text-[#15130F]/75"><span className="h-5 w-5 animate-spin rounded-full border-[3px] border-[#15130F]/10 border-t-[#C9972F]" /> Loading your secure payment page…</p></Shell>;
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
          className="mt-5 flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-[#111110] text-[17px] font-semibold text-white active:scale-[0.98] disabled:opacity-60">
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
  // The form on the page is the default; ?hosted=1 forces the old one-button
  // jump to Stripe's page (for tracing a phone that can't load the form).
  const wantHosted = new URLSearchParams(window.location.search).get("hosted") === "1";
  const useForm = !wantHosted && info.configured && !!info.publishable_key && !embedFailed;
  const invoice = !deposit && !!info.items?.length;
  return (
    <Shell>
      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#6B6963]">{info.label}</p>
      <h1 className="mt-2 text-[34px] font-normal leading-[1.1] tracking-[-0.01em]" style={{ fontFamily: SERIF }}>
        {info.first_name ? `Hi ${info.first_name}, ` : ""}{deposit ? "this books your spot." : invoice ? "here's your invoice." : "here's what's due."}
      </h1>
      {invoice ? <InvoiceDoc info={info} /> : (
        <>
          {/* The amount, then what it's for. Whitespace and hairlines, no boxes. */}
          <p className="mt-7 text-[60px] leading-none tracking-[-0.02em] tabular-nums" style={{ fontFamily: SERIF }}>{formatCurrency(info.amount)}</p>
          <p className="mt-2 text-[14px] font-medium text-[#6B6963]">{deposit ? "Deposit today" : "Due today"}</p>
          <dl className="mt-6 divide-y divide-[#ECEAE5] border-y border-[#ECEAE5] text-[15px]">
            {info.description ? <div className="flex justify-between gap-4 py-3"><dt className="text-[#6B6963]">For</dt><dd className="text-right font-medium">{info.description.replace(/, reserved on the proposal$/, "")}</dd></div> : null}
            {info.address ? <div className="flex justify-between gap-4 py-3"><dt className="text-[#6B6963]">Property</dt><dd className="text-right font-medium">{info.address}</dd></div> : null}
            {deposit && info.job_total ? <div className="flex justify-between gap-4 py-3"><dt className="text-[#6B6963]">Job total</dt><dd className="text-right font-medium">{formatCurrency(info.job_total)}</dd></div> : null}
          </dl>
          {deposit ? (
            <p className="mt-3 flex items-center gap-2 text-[14px] text-[#6B6963]">
              <Check className="h-4 w-4 shrink-0" style={{ color: GOLD }} /> Comes off your total. Holds your dates.
            </p>
          ) : null}
        </>
      )}

      {info.configured ? (
        <>
          {/* The payment panel: one soft block, the lock line next to the fields. */}
          <div className="mt-7 rounded-2xl bg-[#F6F5F2] p-4">
            <div className="mb-4 flex items-center justify-between">
              <p className="flex items-center gap-2 text-[15px] font-semibold"><Lock className="h-4 w-4 text-[#2F5137]" /> Pay securely</p>
              <span className="text-[12px] font-medium text-[#8F8C84]">Secured by Stripe</span>
            </div>
            {useForm ? (
              <StripeForm key={token} token={token || ""} pk={info.publishable_key!} preview={isPreview} amount={info.amount}
                needEmail={info.has_email === false} onFail={() => setEmbedFailed(true)} onTerms={() => setTerms(true)} />
            ) : (
              <>
                <button type="button" onClick={() => void pay()} disabled={busy}
                  className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-[#111110] text-[17px] font-semibold text-white active:scale-[0.98] disabled:opacity-60">
                  <Lock className="h-4 w-4" /> {busy ? "Opening secure checkout…" : `Pay ${formatCurrency(info.amount)}`}
                </button>
                <p className="mt-3 text-center text-[13px] text-[#6B6963]">Opens Stripe's secure payment page: Apple Pay, Google Pay, card, Cash App or bank.</p>
                <p className="mt-2 text-center text-[12px] leading-relaxed text-[#8F8C84]">
                  By paying, you agree to our <button type="button" onClick={() => setTerms(true)} className="inline-flex min-h-[44px] items-center font-semibold underline underline-offset-2">Terms</button>.
                  Your card details go to Stripe, never to us.
                </p>
                {/* Stripe's page stayed blank on a customer's phone (Jeff, 2026-10-16): say what to do. */}
                <p className="mt-3 rounded-[10px] bg-white px-3 py-3 text-[13px] text-[#55534D] ring-1 ring-[#E3E1DB]">
                  <b className="text-[#111110]">Payment page stays blank?</b> Open this link in Safari or Chrome (not inside your email or Facebook app), or call or text us at {PHONE} and we'll send another way to pay.
                </p>
                {error ? <p className="mt-3 rounded-[10px] bg-rose-50 px-3 py-2 text-[14px] font-medium text-rose-800">{error}</p> : null}
              </>
            )}
          </div>
          {terms ? <TermsSheet onClose={() => setTerms(false)} /> : null}
          <ProofLine />
          {deposit ? (
            <p className="mt-3 text-[12px] leading-relaxed text-[#8F8C84]">
              The deposit comes off your total and holds your dates. Once your dates are set it isn't refundable, because we've turned other work away for them.
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-6 rounded-[10px] bg-[#F6F5F2] px-3 py-3 text-[15px]">Online payments are being set up. Call or text us and we'll take care of it.</p>
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
      <div className="flex max-h-[92vh] w-full max-w-md flex-col rounded-t-3xl bg-white text-[#111110] shadow-2xl sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="overflow-y-auto p-5">
          <p className="text-[12px] font-bold uppercase tracking-[0.2em] text-[#8C6224]">The fine print, without the fine print</p>
          <h3 className="font-heading text-2xl font-bold leading-tight">Our terms</h3>
          <div className="mt-3 space-y-4 text-[17px] leading-relaxed"><TermsBody /></div>
        </div>
        <div className="border-t border-[#15130F]/10 p-4">
          <button type="button" onClick={onClose} className="h-12 w-full rounded-xl bg-[#111110] text-base font-semibold text-white">Got it</button>
        </div>
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-white text-[#111110]" style={{ fontFamily: SANS }}>
      <div className="mx-auto max-w-md">
        <div className="flex items-center justify-between bg-[#0E0E0D] px-4 py-3">
          <img src="/sterling-logo-dark.png" alt="Sterling Fence Staining" className="h-7 w-auto" draggable={false} />
          <a href={`tel:+1${PHONE.replace(/-/g, "")}`} className="inline-flex h-10 items-center gap-2 rounded-full px-4 text-[14px] font-semibold text-[#111110]" style={{ background: GOLD }}>
            <Phone className="h-4 w-4" /> Call
          </a>
        </div>
        <div className="px-6 pb-8 pt-7"><InAppWarning />{children}</div>
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
