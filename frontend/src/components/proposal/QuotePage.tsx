// "No date, just getting quotes" (Alan + Olga, 2026-11-05): the customer's
// page when they're shopping around and would hate being booked (a
// customer, Nov 3: "if you guys show up at the property, that's an instant
// way that I won't hire you"). Same link as a booking invite, but no day and
// no booking words anywhere: who they talked to, what our customers say,
// their price, what to check when they compare, and the $250 quietly at the
// bottom for whenever they're ready. Our call-back is never on this page.
//
// Old-person proof: nothing under 12px, body 15px+, every tap 44px+.
import { useEffect, useState } from "react";
import { ArrowLeft, Check, FileText, Lock, MessageSquare, Phone, ShieldCheck, Sparkles, Star } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";
import { COLOR_IN_PERSON } from "@/components/proposal/BookingInvite";

const GOLD = "#C9972F";
const PHONE = "346-589-7877";
const EMAIL = "sterlingfencestaining@gmail.com";
const MAPS = "https://www.google.com/maps/search/?api=1&query=Sterling+Fence+Staining+Houston";

export type QuoteReviews = { rating: number | null; total: number; url?: string; quotes: { author: string; text: string }[] };
export type QuoteSender = { name: string; role: string; photo: string };

export function QuotePage({
  firstName, address, pkgName, pkgOr, color, sides, feet, total, deposit = 250, notes, sender, reviews,
  repairs, services, discount, discountLabel, servicesOnly, proposalHref, paidAmount, onPay, page, onClose,
}: {
  firstName: string; address: string; pkgName: string;
  /** Two packages still open: the job at the other one. */
  pkgOr?: { name: string; total: number };
  color: string; sides: string[]; feet: number; total: number; deposit?: number; notes?: string;
  sender?: QuoteSender | null; reviews?: QuoteReviews | null;
  repairs?: { name: string; qty: number; unit_price: number }[];
  services?: { name: string; price: number; description?: string }[];
  discount?: number; discountLabel?: string; servicesOnly?: boolean; proposalHref?: string;
  /** Already paid the $250: the page says the spot is theirs. */
  paidAmount?: number;
  onPay?: () => Promise<void> | void;
  /** The customer's own page; otherwise a staff preview over the dashboard. */
  page?: boolean; onClose?: () => void;
}) {
  const [paying, setPaying] = useState(false);
  const [err, setErr] = useState("");
  const [photoOk, setPhotoOk] = useState(false);
  useEffect(() => {
    if (!sender?.photo) return;
    const img = new Image();
    img.onload = () => setPhotoOk(true);
    img.onerror = () => setPhotoOk(false);
    img.src = sender.photo;
  }, [sender?.photo]);
  useEffect(() => {
    if (page || !onClose) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page, onClose]);

  const who = (sender?.name || "").split(" ")[0] || "Alan";
  const paid = (paidAmount || 0) > 0;
  const dep = servicesOnly && total > 0 ? Math.min(deposit, total) : deposit;
  const tel = `tel:+1${PHONE.replace(/-/g, "")}`;
  const sms = `sms:+1${PHONE.replace(/-/g, "")}`;
  const pay = async () => {
    if (!onPay) return;
    setErr(""); setPaying(true);
    try { await onPay(); } catch (e) { setErr(e instanceof Error ? e.message : "Couldn't open the payment page. Call or text us."); setPaying(false); }
  };

  return (
    <div className={page ? "min-h-screen bg-[#F8F3E7]" : "fixed inset-0 z-50 flex items-stretch justify-center bg-black/70 sm:items-center sm:p-4"} onClick={page ? undefined : onClose}>
      <div className={cn("relative flex w-full max-w-md flex-col bg-[#F8F3E7] text-[#15130F]", page ? "mx-auto min-h-screen" : "h-full overflow-hidden shadow-2xl sm:h-auto sm:max-h-[94vh] sm:rounded-3xl")} onClick={(e) => e.stopPropagation()}>
        {page ? (
          <div className="flex items-center justify-between bg-[#15130F] px-4 py-3">
            <img src="/sterling-logo-dark.png" alt="Sterling Fence Staining" className="h-7 w-auto" draggable={false} />
            <a href={tel} className="inline-flex h-11 items-center gap-2 rounded-full px-4 text-[15px] font-bold text-[#15130F]" style={{ background: GOLD }}><Phone className="h-4 w-4" /> Call or text</a>
          </div>
        ) : (
          <div className="flex items-center gap-2 bg-[#15130F] px-3 py-2.5" style={{ paddingTop: "max(0.625rem, env(safe-area-inset-top))" }}>
            <button type="button" onClick={onClose} aria-label="Back"
              className="inline-flex h-11 items-center gap-1.5 rounded-xl bg-white/15 px-3.5 text-[15px] font-bold text-white active:scale-[0.97]">
              <ArrowLeft className="h-5 w-5" /> Back
            </button>
            <span className="rounded bg-amber-400/90 px-1.5 py-0.5 text-[12px] font-bold uppercase tracking-wider text-amber-950">Preview · no date</span>
          </div>
        )}

        <div className={cn("flex flex-1 flex-col gap-4 px-5 pb-5 pt-4 [&>*]:shrink-0", page ? "" : "overflow-y-auto")}>
          {/* The person they just talked to, first. */}
          <div className="flex items-center gap-3.5 rounded-3xl bg-[#15130F] px-4 py-4 text-white shadow-md">
            {sender?.photo && photoOk ? (
              <img src={sender.photo} alt={sender.name} className="h-16 w-16 shrink-0 rounded-full object-cover ring-2 ring-[#C9972F]" draggable={false} />
            ) : (
              <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full font-heading text-[28px] font-bold text-[#E3BE63] ring-2 ring-[#C9972F]" aria-hidden>
                {who.charAt(0).toUpperCase()}
              </span>
            )}
            <div className="min-w-0">
              <p className="text-[19px] font-bold leading-tight">Hi {firstName}, it&rsquo;s {who}!</p>
              <p className="mt-0.5 text-[15px] leading-snug text-white/85">Here&rsquo;s your price and what our customers say about us, so you have it next to your other quotes.</p>
              {sender ? <p className="mt-0.5 text-[13px] text-white/60">{sender.name} · {sender.role}</p> : null}
            </div>
          </div>

          {paid ? (
            <div className="flex items-center gap-3 rounded-2xl bg-emerald-700 p-4 text-white shadow-md">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/15"><Check className="h-6 w-6" /></span>
              <div>
                <p className="text-[19px] font-bold leading-tight">Your spot is locked in</p>
                <p className="text-[15px] text-white/90">Paid {formatCurrency(paidAmount || 0)}. We&rsquo;ll call you to pick the day.</p>
              </div>
            </div>
          ) : null}

          {/* What our customers say. */}
          <a href={reviews?.url || MAPS} target="_blank" rel="noopener noreferrer"
            className="block rounded-2xl bg-white p-4 ring-1 ring-[#15130F]/10 active:bg-[#15130F]/5">
            <p className="text-[13px] font-bold uppercase tracking-wide text-[#8C6224]">What our customers say</p>
            <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[17px] font-bold">
              <span className="flex text-[#C9972F]">{[0, 1, 2, 3, 4].map((i) => <Star key={i} className="h-5 w-5 fill-current" />)}</span>
              {reviews && reviews.total > 0 ? `${reviews.rating ? reviews.rating.toFixed(1) : "5.0"} on Google · ${reviews.total} reviews` : "Our reviews on Google"}
            </p>
            {(reviews?.quotes || []).slice(0, 3).map((q) => (
              <p key={q.author + q.text.slice(0, 12)} className="mt-2.5 border-l-2 border-[#C9972F]/50 pl-3 text-[15px] leading-snug">
                &ldquo;{q.text}&rdquo; <span className="text-[#15130F]/60">— {q.author}</span>
              </p>
            ))}
            <p className="mt-3 flex min-h-[44px] items-center text-[15px] font-bold text-[#8C6224] underline underline-offset-2">
              See all {reviews && reviews.total > 0 ? `${reviews.total} ` : ""}reviews on Google ›
            </p>
          </a>

          {/* Their price. */}
          <div className="rounded-2xl bg-white p-4 ring-1 ring-[#15130F]/10">
            <p className="text-[13px] font-bold uppercase tracking-wide text-[#8C6224]">Your price</p>
            <p className="mt-1 font-heading text-[34px] font-bold leading-tight tabular-nums">
              {pkgOr ? `${formatCurrency(pkgOr.total)} or ${formatCurrency(total)}` : formatCurrency(total)}
            </p>
            <p className="text-[15px] text-[#15130F]/75">{servicesOnly ? (services || []).map((s) => s.name).join(", ") : `Fence staining${feet ? ` · ${feet} ft` : ""}`}</p>
            {address ? <p className="text-[14px] text-[#15130F]/70">{address}</p> : null}
            <dl className="mt-3 space-y-2 border-t border-[#15130F]/10 pt-3 text-[15px]">
              {servicesOnly ? null : <>
                <Row k="Package" v={pkgName} />
                {color === COLOR_IN_PERSON ? <Row k="Color" v="We bring samples" /> : color ? <Row k="Color" v={color} /> : null}
                {sides.length ? <Row k="Sides" v={sides.join(", ")} /> : null}
                <Row k="Cleaning, two coats and cleanup" v="Included" />
              </>}
              {discount ? <div className="flex justify-between gap-3 font-semibold text-emerald-700"><dt>Your discount{discountLabel ? ` · ${discountLabel}` : ""}</dt><dd className="tabular-nums">− {formatCurrency(discount)}</dd></div> : null}
              {repairs?.map((r) => <Row key={r.name} k={`${r.name} × ${r.qty}`} v={formatCurrency(r.qty * r.unit_price)} />)}
              {servicesOnly ? null : services?.map((s) => <Row key={s.name} k={s.name} v={formatCurrency(s.price)} />)}
            </dl>
            {proposalHref ? (
              <a href={proposalHref} target="_blank" rel="noreferrer"
                className="mt-3 flex h-12 items-center justify-center gap-2 rounded-xl text-[15px] font-bold ring-1 ring-[#15130F]/15">
                <FileText className="h-4 w-4" style={{ color: GOLD }} /> See all three packages
              </a>
            ) : null}
          </div>

          {/* What to look for, so they compare like with like. */}
          {servicesOnly ? null : (
            <div className="rounded-2xl bg-white p-4 ring-1 ring-[#15130F]/10">
              <p className="text-[13px] font-bold uppercase tracking-wide text-[#8C6224]">When you compare quotes, ask</p>
              <ul className="mt-2 space-y-2.5 text-[15px] leading-snug">
                <li className="flex gap-2.5"><Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-[#8C6224]" /><span><b>Do they clean the fence first?</b> We soft wash it. A pressure washer can hurt the wood.</span></li>
                <li className="flex gap-2.5"><Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-[#8C6224]" /><span><b>How many coats?</b> We do two. One coat is why some quotes are cheaper.</span></li>
                <li className="flex gap-2.5"><Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-[#8C6224]" /><span><b>Do they brush it in?</b> We brush every board so the color comes out even.</span></li>
              </ul>
            </div>
          )}

          {notes?.trim() ? (
            <div className="rounded-2xl bg-[#FFF8E6] p-4 ring-1 ring-[#C9972F]/40">
              <p className="text-[13px] font-bold uppercase tracking-wide text-[#8C6224]">A note from {who}</p>
              <p className="mt-1.5 whitespace-pre-line text-[16px] leading-relaxed">{notes.trim()}</p>
            </div>
          ) : null}

          {/* The $250, quietly, for whenever they're ready. */}
          {paid ? null : (
            <div className="rounded-2xl bg-white p-4 ring-1 ring-[#15130F]/10">
              <p className="text-[13px] font-bold uppercase tracking-wide text-[#8C6224]">Whenever you&rsquo;re ready</p>
              <p className="mt-1 text-[16px] leading-snug">{formatCurrency(dep).replace(".00", "")} locks in your spot. <b>It comes off your total. It&rsquo;s not extra.</b> Then we pick the day together.</p>
              <button type="button" onClick={() => void pay()} disabled={paying || !onPay}
                className="mt-3 flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-[#15130F] text-[17px] font-bold text-[#E3BE63] active:scale-[0.98] disabled:opacity-70">
                <Lock className="h-5 w-5" /> {paying ? "Opening…" : `Lock in my spot · ${formatCurrency(dep).replace(".00", "")}`}
              </button>
              <p className="mt-2 text-center text-[14px] text-[#15130F]/70">Apple Pay, card or bank · secure checkout by Stripe</p>
              {err ? <p className="mt-2 text-center text-[15px] font-semibold text-rose-700">{err}</p> : null}
              <p className="mt-3 flex gap-2.5 text-[15px] leading-snug"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" /><span>Pay with a card and your card company protects you. We&rsquo;ll never ask for gift cards, Zelle or a wire.</span></p>
              <p className="mt-2 text-center text-[13px] text-[#15130F]/60">The deposit isn&rsquo;t refunded if you cancel.</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <a href={sms} className="flex h-12 items-center justify-center gap-2 rounded-xl bg-white text-[15px] font-bold ring-1 ring-[#15130F]/15"><MessageSquare className="h-4 w-4" /> Text us</a>
            <a href={tel} className="flex h-12 items-center justify-center gap-2 rounded-xl bg-white text-[15px] font-bold ring-1 ring-[#15130F]/15"><Phone className="h-4 w-4" /> Call us</a>
          </div>
          <p className="text-center text-[13px] text-[#15130F]/70">Sterling Fence Staining · {PHONE} · {EMAIL}</p>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-[#15130F]/75">{k}</dt>
      <dd className="text-right font-semibold tabular-nums">{v}</dd>
    </div>
  );
}
