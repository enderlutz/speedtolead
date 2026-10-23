// The new pay page, as a mock (Alan, 2026-10-22: the hosted Stripe page
// "looks tacky" and some customers never got through it; "don't change the
// one we have, make a mock first"). Stripe's payment form drawn on our own
// page: Apple Pay or Google Pay on top, then card, Cash App and bank in an
// accordion, then our Pay button. Nothing here is wired to Stripe: every
// field is a picture and Pay only opens the after-payment screens, exactly
// like the old CheckoutMock it replaces. The live page stays /pay/{token}
// (PayLink.tsx) until this is approved.
//
// Second pass, same day: "it needs to look super premium." What the research
// says a billion-dollar brand does on a deposit page, and what this follows:
// - The payment step stays light and quiet. Dark pages read as luxury on a
//   landing page but cost readability right where someone types a card
//   number; the big brands keep the checkout container light. A Black look
//   is here to compare, White is the recommendation.
// - One clean sans for everything (Inter), a serif only for the headline and
//   the amount (Instrument Serif). Loose-tracked small caps for labels.
//   Fewer words: every sentence that isn't needed to pay is gone.
// - The card fields sit inside one soft panel with the lock line right next
//   to them (Baymard: an encapsulated card block with the security cue close
//   by is what lifts perceived security). One black Pay button. Gold is a
//   hairline, not a surface.
import { useEffect, useState } from "react";
import { ArrowLeft, Check, CreditCard, Landmark, Lock, Phone, Star } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";
import type { PayFlow, PayMethod } from "@/components/proposal/AfterPay";
import { InvoiceSheet } from "@/components/InvoiceSheet";

const GOLD = "#C9972F";
const PHONE = "346-589-7877";
const SERIF = "'Instrument Serif', 'Playfair Display Variable', Georgia, serif";
const SANS = "'Inter', 'Geist Variable', system-ui, -apple-system, sans-serif";
const FONTS_URL = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&display=swap";

export type PayLook = "white" | "black";

type Way = "card" | "cashapp" | "bank" | "klarna";

function isApple(): boolean {
  const ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
}

// The two looks, as class strings. Everything that differs between White
// and Black is here, so the markup below reads the same for both.
const LOOKS = {
  white: {
    page: "bg-white text-[#111110]",
    muted: "text-[#6B6963]", faint: "text-[#8F8C84]", rule: "border-[#ECEAE5]",
    panel: "bg-[#F6F5F2]", item: "border-[#E3E1DB] bg-white", itemOn: "border-[#111110] bg-white",
    field: "border-[#D8D5CE] bg-white text-[#9B9890]", label: "text-[#55534D]",
    radioOff: "border-[#B9B6AE]", radioOn: "border-[#111110]", dot: "bg-[#111110]",
    wallet: "bg-black text-white", primary: "bg-[#111110] text-white", lockTone: "text-[#2F5137]",
    chip: "bg-[#F6F5F2] text-[#55534D]",
  },
  black: {
    page: "bg-[#0E0E0D] text-[#F4F1EA]",
    muted: "text-[#A9A59B]", faint: "text-[#7E7B73]", rule: "border-white/10",
    panel: "bg-[#161614]", item: "border-white/12 bg-[#1C1C1A]", itemOn: "border-[#C9972F] bg-[#1C1C1A]",
    field: "border-white/15 bg-[#0E0E0D] text-[#6F6C64]", label: "text-[#A9A59B]",
    radioOff: "border-white/30", radioOn: "border-[#C9972F]", dot: "bg-[#C9972F]",
    wallet: "bg-white text-black", primary: "bg-[#C9972F] text-[#111110]", lockTone: "text-[#C9972F]",
    chip: "bg-white/10 text-[#F4F1EA]",
  },
} as const;

export function PayPageMock({ mode, pkgName, total, firstName, address, onClose, onPaid, onTerms, onOldLook }: {
  mode: PayFlow; pkgName: string; total: number; firstName: string; address: string;
  onClose: () => void; onPaid: (method: PayMethod) => void; onTerms: () => void;
  /** Flip to the old mock (Stripe's hosted page) to compare. */
  onOldLook?: () => void;
}) {
  const deposit = mode === "deposit";
  const balance = Math.max(0, total - 250);
  const amount = deposit ? 250 : mode === "balance" ? balance : total;
  const [look, setLook] = useState<PayLook>("white");
  // The balance page carries the itemized invoice, the paper sheet that went
  // live 2026-10-23.
  const invoiceItems = [
    { name: "Fence staining", description: `${pkgName} package · Pecan`, amount: total, quantity: 1, unit_price: total },
    { name: "Picket replacement (pine)", description: "Counted on site with you", amount: 156, quantity: 13, unit_price: 12 },
  ];
  const invoiceInfo = {
    amount: Math.max(0, total + 156 - 250), items: invoiceItems, credit: 250,
    name: `${firstName} Ebrahimi`, first_name: firstName, address: `${address}, Cypress, TX 77429`,
    invoice_number: "SF-2026-0231", date: new Date().toISOString(), due_date: null,
  };
  const [way, setWay] = useState<Way>("card");
  const [busy, setBusy] = useState(false);
  const t = LOOKS[look];
  const apple = isApple();

  // The page's fonts, from Google Fonts for the mock (the real page bundles them).
  useEffect(() => {
    if (document.getElementById("pay-mock-fonts")) return;
    const link = Object.assign(document.createElement("link"), { id: "pay-mock-fonts", rel: "stylesheet", href: FONTS_URL });
    document.head.appendChild(link);
  }, []);

  const ways: { key: Way; label: string; note?: string }[] = [
    { key: "card", label: "Card" },
    { key: "cashapp", label: "Cash App Pay" },
    { key: "bank", label: "Bank account" },
    ...(deposit ? [] : [{ key: "klarna" as Way, label: "Klarna", note: "4 payments or monthly" }]),
  ];
  const pay = () => {
    if (busy) return;
    setBusy(true);
    // A beat of "Paying…" so the tap feels real, then the after screens.
    setTimeout(() => { setBusy(false); onPaid(way === "klarna" ? "klarna" : "card"); }, 1100);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/70 sm:items-center sm:p-4" onClick={onClose}>
      <div className={cn("flex max-h-[94vh] w-full max-w-md flex-col overflow-hidden rounded-t-3xl shadow-2xl sm:rounded-3xl", t.page)} style={{ fontFamily: SANS }} onClick={(e) => e.stopPropagation()}>
        {/* The page's own header, as the customer sees it; the mock's switches ride on the right. */}
        <div className="flex items-center justify-between gap-2 bg-[#0E0E0D] px-4 py-3">
          <div className="flex items-center gap-3">
            <button type="button" onClick={onClose} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10 text-white" aria-label="Back"><ArrowLeft className="h-4 w-4" /></button>
            <img src="/sterling-logo-dark.png" alt="Sterling Fence Staining" className="h-7 w-auto" draggable={false} />
          </div>
          <div className="flex items-center gap-1.5">
            {mode !== "balance" ? <span className="flex overflow-hidden rounded-md bg-white/10 text-[11px] font-bold">
              {(["white", "black"] as PayLook[]).map((k) => (
                <button key={k} type="button" onClick={() => setLook(k)} className={cn("px-2 py-1 capitalize", look === k ? "bg-[#C9972F] text-[#111110]" : "text-white/80")}>{k}</button>
              ))}
            </span> : null}
            {onOldLook ? <button type="button" onClick={onOldLook} className="whitespace-nowrap rounded-md bg-white/10 px-2 py-1 text-[11px] font-bold text-white/85">Old</button> : null}
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-full" style={{ background: GOLD }} aria-label="Call"><Phone className="h-4 w-4 text-[#111110]" /></span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-8 pt-7">
          <p className={cn("text-[11px] font-semibold uppercase tracking-[0.22em]", t.muted)}>
            {deposit ? "Deposit to reserve your dates" : mode === "balance" ? "Your balance" : "Pay in full"}
          </p>
          <h1 className="mt-2 text-[34px] font-normal leading-[1.1] tracking-[-0.01em]" style={{ fontFamily: SERIF }}>
            Hi {firstName}, {deposit ? "this books your spot." : mode === "balance" ? "here's your invoice." : "here's your total."}
          </h1>

          {mode === "balance" ? <InvoiceSheet info={invoiceInfo} /> : (<>
          {/* The amount, then what it's for. Whitespace and hairlines, no boxes. */}
          <p className="mt-7 text-[60px] leading-none tracking-[-0.02em] tabular-nums" style={{ fontFamily: SERIF }}>{formatCurrency(amount)}</p>
          <p className={cn("mt-2 text-[14px] font-medium", t.muted)}>{deposit ? "Deposit today" : "Due today"}</p>
          <dl className={cn("mt-6 divide-y border-y text-[15px]", t.rule, look === "white" ? "divide-[#ECEAE5]" : "divide-white/10")}>
            <div className="flex justify-between gap-4 py-3"><dt className={t.muted}>Package</dt><dd className="text-right font-medium">{pkgName}</dd></div>
            <div className="flex justify-between gap-4 py-3"><dt className={t.muted}>Property</dt><dd className="text-right font-medium">{address}</dd></div>
            {deposit ? (
              <div className="flex justify-between gap-4 py-3"><dt className={t.muted}>Job total</dt><dd className="text-right font-medium">{formatCurrency(total)}</dd></div>
            ) : null}
          </dl>
          {deposit ? (
            <p className={cn("mt-3 flex items-center gap-2 text-[14px]", t.muted)}>
              <Check className="h-4 w-4 shrink-0" style={{ color: GOLD }} /> Comes off your total. Holds your dates.
            </p>
          ) : null}
          </>)}

          {/* The payment panel: one soft block, the lock line next to the fields. */}
          <div className={cn("mt-7 rounded-2xl p-4", t.panel)}>
            <div className="mb-4 flex items-center justify-between">
              <p className="flex items-center gap-2 text-[15px] font-semibold"><Lock className={cn("h-4 w-4", t.lockTone)} /> Pay securely</p>
              <span className={cn("text-[12px] font-medium", t.faint)}>Secured by Stripe</span>
            </div>
            {/* Apple Pay on an iPhone, Google Pay elsewhere: one tap and done. */}
            <button type="button" onClick={pay} className={cn("flex h-[52px] w-full items-center justify-center rounded-xl text-[19px] font-medium active:scale-[0.98]", t.wallet)}>
              {apple ? <><span className="mr-1 text-[22px] leading-none"></span>Pay</> : <><span className="mr-1.5 text-[18px] font-bold">G</span>Pay</>}
            </button>
            <div className={cn("my-4 flex items-center gap-3 text-[12px] font-medium", t.faint)}>
              <span className={cn("h-px flex-1", look === "white" ? "bg-[#E3E1DB]" : "bg-white/12")} />or<span className={cn("h-px flex-1", look === "white" ? "bg-[#E3E1DB]" : "bg-white/12")} />
            </div>

            {/* Stripe's accordion, in our colours. */}
            <div className="space-y-2">
              {ways.map((w) => {
                const on = way === w.key;
                return (
                  <div key={w.key} className={cn("rounded-xl border transition", on ? t.itemOn : t.item, on && look === "white" && "shadow-[0_1px_2px_rgba(0,0,0,0.04)]")}>
                    <button type="button" onClick={() => setWay(w.key)} className="flex min-h-[50px] w-full items-center gap-3 px-4 py-3 text-left">
                      <span className={cn("flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px]", on ? t.radioOn : t.radioOff)}>
                        {on ? <span className={cn("h-2 w-2 rounded-full", t.dot)} /> : null}
                      </span>
                      {w.key === "card" ? <CreditCard className={cn("h-5 w-5", t.muted)} />
                        : w.key === "cashapp" ? <span className="flex h-5 w-5 items-center justify-center rounded-[5px] bg-[#00D632] text-[12px] font-black text-white">$</span>
                        : w.key === "bank" ? <Landmark className={cn("h-5 w-5", t.muted)} />
                        : <span className="rounded bg-[#FFB3C7] px-1.5 py-0.5 text-[11px] font-black text-black">Klarna.</span>}
                      <span className="flex-1 text-[15px] font-medium">{w.label}</span>
                      {w.key === "card" ? (
                        <span className="flex items-center gap-1">
                          <Brand bg="#1A1F71" text="VISA" italic />
                          <Brand bg="#EB001B" text="MC" />
                          <Brand bg="#016FD0" text="AMEX" />
                          <Brand bg="#FF6000" text="DISC" />
                        </span>
                      ) : w.note ? <span className={cn("text-[12px] font-medium", t.faint)}>{w.note}</span> : null}
                    </button>
                    {on && w.key === "card" ? (
                      <div className="space-y-3 px-4 pb-4">
                        <Field t={t} label="Card number" value="1234 1234 1234 1234" />
                        <div className="grid grid-cols-2 gap-3"><Field t={t} label="Expiration" value="MM / YY" /><Field t={t} label="Security code" value="CVC" /></div>
                        <Field t={t} label="ZIP code" value="77429" />
                      </div>
                    ) : null}
                    {on && w.key === "cashapp" ? <p className={cn("px-4 pb-4 text-[14px] leading-snug", t.muted)}>Tap Pay and a code opens in the Cash App on your phone. Approve it there and you're done.</p> : null}
                    {on && w.key === "bank" ? <p className={cn("px-4 pb-4 text-[14px] leading-snug", t.muted)}>Tap Pay to sign in to your bank through Stripe. No card needed.</p> : null}
                    {on && w.key === "klarna" ? <p className={cn("px-4 pb-4 text-[14px] leading-snug", t.muted)}>Tap Pay to finish on Klarna's page: 4 payments or a monthly plan. Checking doesn't affect your credit score.</p> : null}
                  </div>
                );
              })}
            </div>

            <button type="button" onClick={pay} disabled={busy}
              className={cn("mt-4 flex h-14 w-full items-center justify-center gap-2 rounded-xl text-[17px] font-semibold active:scale-[0.98] disabled:opacity-60", t.primary)}>
              <Lock className="h-4 w-4" /> {busy ? "Paying…" : way === "klarna" ? "Continue to Klarna" : `Pay ${formatCurrency(amount)}`}
            </button>
            <p className={cn("mt-3 text-center text-[12px] leading-relaxed", t.faint)}>
              By paying, you agree to our <button type="button" onClick={onTerms} className="inline-flex min-h-[44px] items-center font-semibold underline underline-offset-2">Terms</button>.
              Your card details go to Stripe, never to us.
            </p>
          </div>

          {/* Who we are: one line of proof, one line of the rule. */}
          <div className={cn("mt-7 flex items-center gap-2 text-[13px]", t.muted)}>
            <span className="flex items-center gap-0.5">{[0, 1, 2, 3, 4].map((i) => <Star key={i} className="h-3.5 w-3.5 fill-[#C9972F] text-[#C9972F]" />)}</span>
            <span><span className="font-semibold">5.0</span> · 40 Google reviews · Sister company of A&amp;T Pressure Washing, Houston</span>
          </div>
          {deposit ? (
            <p className={cn("mt-3 text-[12px] leading-relaxed", t.faint)}>
              The deposit comes off your total and holds your dates. Once your dates are set it isn't refundable, because we've turned other work away for them.
            </p>
          ) : null}
          <p className={cn("mt-7 text-center text-[14px]", t.muted)}>
            Questions? Call or text <span className="font-semibold underline underline-offset-2">{PHONE}</span>
          </p>
        </div>
      </div>
    </div>
  );
}

/** A field as Stripe draws it in our colours: 16px text, 10px corners. */
function Field({ t, label, value }: { t: (typeof LOOKS)[PayLook]; label: string; value: string }) {
  return (
    <label className="block">
      <span className={cn("mb-1.5 block text-[13px] font-medium", t.label)}>{label}</span>
      <span className={cn("flex h-12 items-center rounded-[10px] border px-3.5 text-[16px]", t.field)}>{value}</span>
    </label>
  );
}

function Brand({ bg, text, italic }: { bg: string; text: string; italic?: boolean }) {
  return <span className={cn("rounded-[3px] px-1 text-[8px] font-black leading-[13px] text-white", italic && "italic")} style={{ background: bg }}>{text}</span>;
}
