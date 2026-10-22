// The new pay page, as a mock (Alan, 2026-10-22: the hosted Stripe page
// "looks tacky" and some customers never got through it; "don't change the
// one we have, make a mock first"). Stripe's payment form drawn on our own
// page in Sterling's colours: Apple Pay or Google Pay on top, then card,
// Cash App and bank in an accordion, then our gold Pay button. Nothing here
// is wired to Stripe: every field is a picture and Pay only opens the
// after-payment screens, exactly like the old CheckoutMock it replaces.
// The live page stays /pay/{token} (PayLink.tsx) until this is approved.
import { useState } from "react";
import { ArrowLeft, Check, CreditCard, Landmark, Lock, Phone, ShieldCheck, Star } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";
import type { PayFlow, PayMethod } from "@/components/proposal/AfterPay";

const GOLD = "#C9972F";
const PHONE = "346-589-7877";

type Way = "card" | "cashapp" | "bank" | "klarna";

function isApple(): boolean {
  const ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
}

export function PayPageMock({ mode, pkgName, total, firstName, address, onClose, onPaid, onTerms, onOldLook }: {
  mode: PayFlow; pkgName: string; total: number; firstName: string; address: string;
  onClose: () => void; onPaid: (method: PayMethod) => void; onTerms: () => void;
  /** Flip to the old mock (Stripe's hosted page) to compare. */
  onOldLook?: () => void;
}) {
  const deposit = mode === "deposit";
  const balance = Math.max(0, total - 250);
  const amount = deposit ? 250 : mode === "balance" ? balance : total;
  const [way, setWay] = useState<Way>("card");
  const [busy, setBusy] = useState(false);
  const apple = isApple();
  const ways: { key: Way; label: string; note?: string }[] = [
    { key: "card", label: "Card" },
    { key: "cashapp", label: "Cash App Pay" },
    { key: "bank", label: "Bank account", note: "No fee" },
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
      <div className="flex max-h-[94vh] w-full max-w-md flex-col overflow-hidden rounded-t-3xl bg-[#F8F3E7] text-[#15130F] shadow-2xl sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        {/* The page's own header, as the customer sees it. */}
        <div className="flex items-center justify-between bg-[#15130F] px-4 py-3">
          <div className="flex items-center gap-3">
            <button type="button" onClick={onClose} className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white" aria-label="Back"><ArrowLeft className="h-4 w-4" /></button>
            <img src="/sterling-logo-dark.png" alt="Sterling Fence Staining" className="h-7 w-auto" draggable={false} />
          </div>
          <div className="flex items-center gap-2">
            {onOldLook ? (
              <button type="button" onClick={onOldLook} className="whitespace-nowrap rounded-md bg-white/10 px-2 py-1 text-[11px] font-bold text-white/85">Old look</button>
            ) : null}
            <span className="rounded bg-amber-400/90 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-amber-950">Mockup</span>
            <span className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[14px] font-bold text-[#15130F]" style={{ background: GOLD }}><Phone className="h-3.5 w-3.5" /> Call</span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-6">
          <p className="text-[13px] font-bold uppercase tracking-[0.2em]" style={{ color: "#8C6224" }}>
            {deposit ? "Deposit to reserve your dates" : mode === "balance" ? "Your balance" : "Pay in full"}
          </p>
          <h1 className="mt-1 font-heading text-3xl font-bold leading-tight">
            Hi {firstName}, {deposit ? "this books your spot." : mode === "balance" ? "here's what's due." : "here's your total."}
          </h1>

          {/* What they're paying: one card, the amount big, the gold bar on top. */}
          <div className="mt-5 overflow-hidden rounded-3xl bg-white shadow-[0_8px_30px_rgba(21,19,15,0.08)] ring-1 ring-[#15130F]/10">
            <div className="h-1.5" style={{ background: GOLD }} />
            <div className="p-5">
              <p className="text-[13px] font-bold uppercase tracking-[0.18em] text-[#15130F]/60">{deposit ? "Deposit today" : "Due today"}</p>
              <p className="mt-1 font-heading text-[44px] font-bold leading-none tabular-nums">{formatCurrency(amount)}</p>
              <p className="mt-3 text-[15px] font-semibold text-[#15130F]/85">{address}</p>
              <p className="mt-0.5 text-[15px] text-[#15130F]/70">{pkgName}{deposit ? ", reserved on the proposal" : ` · ${formatCurrency(total)} total`}</p>
              {deposit ? (
                <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-1.5 border-t border-[#15130F]/10 pt-4 text-[14px] font-semibold text-[#15130F]/85">
                  <li className="flex items-center gap-1.5"><Check className="h-4 w-4 shrink-0" style={{ color: GOLD }} /> Comes off your total</li>
                  <li className="flex items-center gap-1.5"><Check className="h-4 w-4 shrink-0" style={{ color: GOLD }} /> Holds your dates</li>
                </ul>
              ) : mode === "balance" ? (
                <p className="mt-4 border-t border-[#15130F]/10 pt-4 text-[14px] font-semibold text-[#15130F]/85">{formatCurrency(total)} total, less your {formatCurrency(250)} deposit.</p>
              ) : null}
            </div>
          </div>

          {/* The payment form, on the page. */}
          <div className="mt-4 overflow-hidden rounded-3xl bg-white shadow-[0_8px_30px_rgba(21,19,15,0.08)] ring-1 ring-[#15130F]/10">
            <div className="flex items-center justify-between gap-2 px-5 pt-5">
              <p className="flex items-center gap-2 text-[16px] font-bold"><Lock className="h-4 w-4 text-[#2F5137]" /> Pay securely</p>
              <span className="text-[13px] font-semibold text-[#15130F]/60">Secured by Stripe</span>
            </div>
            <div className="px-5 pb-5 pt-4">
              {/* Apple Pay on an iPhone, Google Pay elsewhere: one tap and done. */}
              <button type="button" onClick={pay} className="flex h-[50px] w-full items-center justify-center rounded-xl bg-black text-[19px] font-semibold text-white active:scale-[0.98]">
                {apple ? <><span className="mr-1 text-[22px] leading-none"></span>Pay</> : <><span className="mr-1.5 text-[18px] font-bold">G</span>Pay</>}
              </button>
              <div className="my-4 flex items-center gap-3 text-[13px] font-bold uppercase tracking-[0.16em] text-[#15130F]/50">
                <span className="h-px flex-1 bg-[#15130F]/12" />or pay another way<span className="h-px flex-1 bg-[#15130F]/12" />
              </div>

              {/* Stripe's accordion, in our colours. */}
              <div className="space-y-2.5">
                {ways.map((w) => {
                  const on = way === w.key;
                  return (
                    <div key={w.key} className={cn("rounded-xl border bg-white transition", on ? "border-[#C9972F] shadow-[0_0_0_3px_rgba(201,151,47,0.20)]" : "border-[#15130F]/14")}>
                      <button type="button" onClick={() => setWay(w.key)} className="flex min-h-[52px] w-full items-center gap-3 px-4 py-3 text-left">
                        <span className={cn("flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2", on ? "border-[#C9972F]" : "border-[#15130F]/35")}>
                          {on ? <span className="h-2 w-2 rounded-full" style={{ background: GOLD }} /> : null}
                        </span>
                        {w.key === "card" ? <CreditCard className="h-5 w-5 text-[#15130F]/75" />
                          : w.key === "cashapp" ? <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#00D632] text-[13px] font-black text-white">$</span>
                          : w.key === "bank" ? <Landmark className="h-5 w-5 text-[#15130F]/75" />
                          : <span className="rounded bg-[#FFB3C7] px-1.5 py-0.5 text-[12px] font-black text-black">Klarna.</span>}
                        <span className="flex-1 text-[16px] font-semibold">{w.label}</span>
                        {w.key === "card" ? (
                          <span className="flex items-center gap-1">
                            <Brand bg="#1A1F71" text="VISA" italic />
                            <Brand bg="#EB001B" text="MC" />
                            <Brand bg="#016FD0" text="AMEX" />
                            <Brand bg="#FF6000" text="DISC" />
                          </span>
                        ) : w.note ? <span className="text-[13px] font-semibold text-[#15130F]/60">{w.note}</span> : null}
                      </button>
                      {on && w.key === "card" ? (
                        <div className="space-y-3 px-4 pb-4">
                          <Field label="Card number" value="1234 1234 1234 1234" />
                          <div className="grid grid-cols-2 gap-3"><Field label="Expiration" value="MM / YY" /><Field label="Security code" value="CVC" /></div>
                          <Field label="ZIP code" value="77429" />
                        </div>
                      ) : null}
                      {on && w.key === "cashapp" ? (
                        <p className="px-4 pb-4 text-[15px] leading-snug text-[#15130F]/75">Tap Pay and a code opens in the Cash App on your phone. Approve it there and you're done.</p>
                      ) : null}
                      {on && w.key === "bank" ? (
                        <p className="px-4 pb-4 text-[15px] leading-snug text-[#15130F]/75">Tap Pay to sign in to your bank through Stripe. No card, no fee.</p>
                      ) : null}
                      {on && w.key === "klarna" ? (
                        <p className="px-4 pb-4 text-[15px] leading-snug text-[#15130F]/75">Tap Pay to finish on Klarna's page: pick 4 payments or a monthly plan. Checking doesn't affect your credit score.</p>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              <button type="button" onClick={pay} disabled={busy}
                className="mt-5 flex h-14 w-full items-center justify-center gap-2 rounded-xl text-[18px] font-bold text-[#15130F] shadow-[0_6px_18px_rgba(201,151,47,0.35)] active:scale-[0.98] disabled:opacity-60" style={{ background: GOLD }}>
                <Lock className="h-5 w-5" /> {busy ? "Paying…" : way === "klarna" ? "Continue to Klarna" : `Pay ${formatCurrency(amount)}`}
              </button>
              <p className="mt-3 text-center text-[14px] text-[#15130F]/75">
                By paying, you agree to our <button type="button" onClick={onTerms} className="inline-flex min-h-[44px] items-center font-bold text-[#8C6224] underline underline-offset-2">Terms</button>.
              </p>
              <p className="flex items-center justify-center gap-1.5 text-[13px] text-[#15130F]/60"><Lock className="h-3.5 w-3.5" /> Encrypted by Stripe. Your card number never touches our servers.</p>
            </div>
          </div>

          {/* Who we are, in three short rows. */}
          <div className="mt-5 space-y-3 text-[14px] leading-snug text-[#15130F]/80">
            <p className="flex items-start gap-2"><Star className="mt-0.5 h-4 w-4 shrink-0 fill-[#C9972F] text-[#C9972F]" /><span>
              <b className="text-[#15130F]">5.0 stars from 40 Google reviews.</b> The fence-staining sister company of A&amp;T Pressure Washing, Houston.
            </span></p>
            <p className="flex items-start gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#2F5137]" /><span>
              <b className="text-[#15130F]">Payments run through Stripe</b>, the same company behind payments for Amazon and Target. Your card details go to Stripe, never to us.
            </span></p>
            {deposit ? <p className="flex items-start gap-2"><Lock className="mt-0.5 h-4 w-4 shrink-0 text-[#2F5137]" /><span>
              <b className="text-[#15130F]">The deposit comes off your total</b> and holds your dates. Once your dates are set it isn't refundable, because we've turned other work away for them.
            </span></p> : null}
          </div>
          <p className="mt-6 text-center text-[15px] text-[#15130F]/75">
            Questions? Call or text <span className="font-bold text-[#15130F] underline underline-offset-2">{PHONE}</span>
          </p>
        </div>
      </div>
    </div>
  );
}

/** A field as Stripe draws it in our colours: 16px text, 12px corners. */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[14px] font-semibold text-[#5F594E]">{label}</span>
      <span className="flex h-12 items-center rounded-xl border border-[#15130F]/18 bg-white px-3.5 text-[16px] font-medium text-[#9A9388]">{value}</span>
    </label>
  );
}

function Brand({ bg, text, italic }: { bg: string; text: string; italic?: boolean }) {
  return <span className={cn("rounded-[3px] px-1 text-[9px] font-black leading-[14px] text-white", italic && "italic")} style={{ background: bg }}>{text}</span>;
}
