// The booking invite: our own page in place of the Google Calendar invite
// (Alan, 2026-10-14). The Google invite came from his personal Gmail, with
// a Meet link on it and "Tentative" typed into the title, and only about one
// customer in five ever tapped Yes on it. This is one link, texted and
// emailed from Sterling, that walks through the whole cycle:
//
//   held      -> a date is held for them, the $250 deposit is still due
//   confirmed -> the deposit is paid and the page confirms by itself
//
// The date is the day we're aiming for, never a promise: rain moves it, so
// the page says that up front. No arrival window yet (Alan, 2026-10-14);
// the customer gets a text the day before.
//
// Mockup only for now: nothing here sends, charges or books anything,
// except "Add to my calendar", which really does hand the phone a calendar
// file, so it can be tried.
import { useEffect, useState } from "react";
import { Check, CalendarPlus, CloudRain, FileText, MessageSquare, Phone, Lock, Clock, MapPin, ArrowLeft, Save } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";
import { klarnaLine } from "@/lib/klarna";

const GOLD = "#C9972F";
const PHONE = "346-589-7877";
const EMAIL = "sterlingfencestaining@gmail.com";
const DEPOSIT = 250;

export type BookingState = "held" | "confirmed";

const STEPS = ["Picked your package", "Date held", "Deposit paid", "Job day", "Final payment"];

/** An all-day calendar file for the target date. Fine for every phone's
 *  calendar; no arrival window yet, so no time on it. */
function icsFile(date: Date, address: string, confirmed: boolean, proposalUrl: string): string {
  const d = (x: Date) => `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, "0")}${String(x.getDate()).padStart(2, "0")}`;
  const next = new Date(date); next.setDate(next.getDate() + 1);
  const esc = (s: string) => s.replace(/[\\,;]/g, (m) => `\\${m}`).replace(/\n/g, "\\n");
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Sterling Fence Staining//Booking//EN", "BEGIN:VEVENT",
    `UID:sterling-${d(date)}-${address.replace(/\W/g, "").slice(0, 20)}@sterlingfencetx.com`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`,
    `DTSTART;VALUE=DATE:${d(date)}`, `DTEND;VALUE=DATE:${d(next)}`,
    `SUMMARY:${esc(`Fence staining with Sterling${confirmed ? "" : " (date held)"}`)}`,
    `LOCATION:${esc(address)}`,
    `DESCRIPTION:${esc(`${confirmed ? "Confirmed." : "Date held. Pay the $250 deposit to confirm."} Weather can move the day; we'll text you if it does.\n\nYour booking: ${proposalUrl}\nQuestions? Call or text ${PHONE}`)}`,
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
}

export function BookingInvite({ firstName, address, pkgName, color, sides, feet, total, date, notes, staff, onClose, page, initial, onPay, proposalHref, holdUntilIso, paidAmount, onSave, saveLabel, klarna, onFinance, discount, discountLabel, repairs, repairsDiscount, repairsDiscountLabel }: {
  firstName: string; address: string; pkgName: string; color: string; sides: string[]; feet: number; total: number;
  /** Alan's note to them, e.g. the pergola price range from the call. */
  notes?: string;
  /** The day we're aiming for. */
  date: Date;
  staff?: boolean;
  onClose?: () => void;
  /** The real thing at /b/{token}: a full page, no overlay, no mockup badge. */
  page?: boolean;
  /** Where it stands when it opens (the real page reads it off the lead). */
  initial?: BookingState | "cancelled";
  /** The real deposit: makes the pay link and goes to it. */
  onPay?: () => Promise<void>;
  proposalHref?: string;
  /** YYYY-MM-DD the hold runs to, from the server. */
  holdUntilIso?: string;
  /** What's been paid (the deposit, or the whole job). */
  paidAmount?: number;
  /** Repairs, one line each; `total` already includes them (Alan, 2026-10-15). */
  repairs?: { name: string; qty: number; unit_price: number }[];
  /** Dollars off the repairs alone; `total` is already after it. */
  repairsDiscount?: number;
  repairsDiscountLabel?: string;
  /** Dollars off the package; `total` is already after it (Alan, 2026-10-15). */
  discount?: number;
  discountLabel?: string;
  /** Offer Klarna for the whole job beside the $250 (Alan, 2026-10-15). */
  klarna?: boolean;
  /** The real Klarna door: makes the full-price link and goes to it. */
  onFinance?: () => Promise<void>;
  /** Staff preview: save the draft from here, without sending. */
  onSave?: () => void;
  saveLabel?: string;
}) {
  const [state, setState] = useState<BookingState | "cancelled">(initial ?? "held");
  const [paying, setPaying] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [behind, setBehind] = useState(false);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 2400); return () => clearTimeout(t); }, [toast]);
  // Escape always gets out of the preview.
  useEffect(() => {
    if (page || !onClose) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page, onClose]);

  const confirmed = state === "confirmed";
  const repairSum = (repairs || []).reduce((t, r) => t + r.qty * r.unit_price, 0);
  const paid = confirmed ? (paidAmount || DEPOSIT) : 0;
  const paidInFull = confirmed && total > 0 && paid >= total;
  const balance = Math.max(0, total - (confirmed ? paid : DEPOSIT));
  const stepNow = confirmed ? 3 : 2; // index of the step they're on
  const weekday = date.toLocaleDateString("en-US", { weekday: "long" });
  const longDate = date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  // Held for 7 days, never past the day before the job itself.
  const [holdUntil] = useState(() => {
    if (holdUntilIso) return new Date(`${holdUntilIso}T12:00:00`);
    const now = new Date();
    const week = new Date(now); week.setDate(week.getDate() + 7);
    const dayBefore = new Date(date); dayBefore.setDate(dayBefore.getDate() - 1);
    return week > dayBefore ? (dayBefore > now ? dayBefore : now) : week;
  });
  const proposalUrl = "estimate.sterlingfencetx.com/p/…";
  const bookingUrl = "estimate.sterlingfencetx.com/b/…";

  // The mockup's deposit: a moment of "paying", then the page confirms by
  // itself, which is what Stripe's paid webhook does on the real one.
  const [financing, setFinancing] = useState(false);
  const finance = async () => {
    if (financing || paying) return;
    if (!onFinance) { setToast("Opens the Klarna page for the whole job"); return; }
    setFinancing(true);
    try { await onFinance(); } catch (e) { setFinancing(false); setToast(e instanceof Error ? e.message : "Couldn't open Klarna. Call or text us."); }
  };
  const pay = async () => {
    if (paying) return;
    setPaying(true);
    if (onPay) {
      try { await onPay(); } catch (e) { setPaying(false); setToast(e instanceof Error ? e.message : "Couldn't open the payment page. Call or text us."); }
      return;
    }
    setTimeout(() => { setPaying(false); setState("confirmed"); setToast("Deposit paid. The page confirmed itself."); }, 900);
  };
  const addToCalendar = () => {
    try {
      const blob = new Blob([icsFile(date, address, confirmed, page ? window.location.href : `https://${proposalUrl}`)], { type: "text/calendar" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "sterling-fence-staining.ics";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setToast("Their phone's calendar opens here"); }
  };

  const textMsg = confirmed
    ? `Hi ${firstName}, you're confirmed! Your deposit is in and ${longDate} is yours. Everything about your job is here: ${bookingUrl}`
    : `Hi ${firstName}, it's Alan with Sterling Fence Staining. I'm holding ${longDate} for your fence. Here's your booking, and the $250 deposit locks it in: ${bookingUrl}`;
  const emailSubject = confirmed
    ? `Confirmed: fence staining on ${longDate}`
    : `Your date is held: fence staining on ${longDate}`;
  const fires = confirmed ? [
    "Stripe: $250 deposit paid (the same deposit link as the proposal's)",
    "This page: flips to Confirmed by itself (nobody touches anything)",
    "The usual deposit alerts, tags and after-payment screens fire",
  ] : [
    "Text from the Sterling number + email through GHL, if they have an email",
    "Opens are tracked on the lead (when, how many times)",
    `Shows the hold to ${holdUntil.toLocaleDateString("en-US", { month: "short", day: "numeric" })} (7 days, never past the day before)`,
    "Pay button: the $250 deposit for this package and price",
  ];

  return (
    <div className={page ? "min-h-screen bg-[#F8F3E7]" : "fixed inset-0 z-50 flex items-stretch justify-center bg-black/70 sm:items-center sm:p-4"} onClick={page ? undefined : onClose}>
      <div className={cn("relative flex w-full max-w-md flex-col bg-[#F8F3E7] text-[#15130F]", page ? "mx-auto min-h-screen" : "h-full overflow-hidden shadow-2xl sm:h-auto sm:max-h-[94vh] sm:rounded-3xl")} onClick={(e) => e.stopPropagation()}>
        {page ? (
          <div className="flex items-center justify-between bg-[#15130F] px-4 py-3">
            <img src="/sterling-logo-dark.png" alt="Sterling Fence Staining" className="h-7 w-auto" draggable={false} />
            <a href={`tel:+1${PHONE.replace(/-/g, "")}`} className="inline-flex h-11 items-center gap-2 rounded-full px-4 text-[15px] font-bold text-[#15130F]" style={{ background: GOLD }}><Phone className="h-4 w-4" /> Call or text</a>
          </div>
        ) : (
          // Staff preview: a big way out, top left, always on screen (Alan,
          // 2026-10-14: "I can't back out of it unless I restart").
          <div className="flex items-center gap-2 bg-[#15130F] px-3 py-2.5" style={{ paddingTop: "max(0.625rem, env(safe-area-inset-top))" }}>
            <button type="button" onClick={onClose} aria-label="Back"
              className="inline-flex h-11 items-center gap-1.5 rounded-xl bg-white/15 px-3.5 text-[15px] font-bold text-white active:scale-[0.97]">
              <ArrowLeft className="h-5 w-5" /> Back
            </button>
            <span className="rounded bg-amber-400/90 px-1.5 py-0.5 text-[12px] font-bold uppercase tracking-wider text-amber-950">{onSave ? "Preview" : "Mockup"}</span>
            {onSave ? (
              <button type="button" onClick={onSave}
                className="ml-auto inline-flex h-11 items-center gap-1.5 rounded-xl px-3.5 text-[15px] font-bold text-[#15130F] active:scale-[0.97]" style={{ background: GOLD }}>
                <Save className="h-4 w-4" /> {saveLabel || "Save draft"}
              </button>
            ) : null}
          </div>
        )}

        {staff && !page ? (
          <div className="flex items-center gap-1.5 border-b border-[#15130F]/10 bg-[#15130F]/5 px-4 py-2">
            <span className="text-[12px] font-bold uppercase tracking-wide text-[#15130F]/70">Show it</span>
            {(["held", "confirmed"] as const).map((s) => (
              <button key={s} type="button" onClick={() => setState(s)}
                className={cn("h-8 rounded-full px-3 text-[12px] font-bold", state === s ? "bg-[#15130F] text-[#E3BE63]" : "bg-white text-[#15130F]/80 ring-1 ring-[#15130F]/15")}>
                {s === "held" ? "Before the deposit" : "After the deposit"}
              </button>
            ))}
          </div>
        ) : null}

        <div className={cn("flex flex-1 flex-col gap-4 px-5 pb-5 pt-4 [&>*]:shrink-0", page ? "" : "overflow-y-auto")}>
          {/* The status, first thing they see. */}
          {state === "cancelled" ? (
            <div className="rounded-2xl bg-white p-4 ring-1 ring-[#15130F]/10">
              <p className="text-[19px] font-bold leading-tight">This booking was cancelled</p>
              <p className="mt-1 text-[15px]">Want to pick a new day? Call or text us at {PHONE} and we'll set you up.</p>
            </div>
          ) : confirmed ? (
            <div className="flex items-center gap-3 rounded-2xl bg-emerald-700 p-4 text-white shadow-md">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/15"><Check className="h-6 w-6" /></span>
              <div>
                <p className="text-[19px] font-bold leading-tight">You're confirmed</p>
                <p className="text-[15px] text-white/90">{paidInFull ? "Paid in full" : "Deposit paid"} · {formatCurrency(paid)}</p>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl bg-[#15130F] p-4 text-white shadow-md">
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full" style={{ background: GOLD }}><Clock className="h-6 w-6 text-[#15130F]" /></span>
                <div>
                  <p className="text-[19px] font-bold leading-tight">Your date is on hold</p>
                  {discount || repairsDiscount ? <p className="mt-0.5 inline-block rounded-full bg-emerald-500/20 px-2 py-0.5 text-[13px] font-bold text-emerald-300">You're saving {formatCurrency((discount || 0) + (repairsDiscount || 0))}{discountLabel && !repairsDiscount ? ` · ${discountLabel}` : ""}</p> : null}
                  <p className="text-[15px] text-white/85">{klarna ? "The $250 deposit or Klarna confirms it" : `${formatCurrency(DEPOSIT)} deposit to confirm`}</p>
                </div>
              </div>
              {klarna ? (
                // The proposal's pair: the $250 in gold, Klarna in its pink.
                <>
                  <p className="mt-3 text-[14px] font-semibold leading-snug" style={{ color: "#E3BE63" }}>{klarnaLine(total)}</p>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <button type="button" onClick={pay} disabled={paying || financing}
                      className="flex h-14 items-center justify-center gap-1.5 rounded-xl text-[16px] font-bold text-[#15130F] shadow-md active:scale-[0.98] disabled:opacity-70" style={{ background: GOLD }}>
                      <Lock className="h-4 w-4" /> {paying ? "Opening…" : `Reserve · ${formatCurrency(DEPOSIT).replace(".00", "")}`}
                    </button>
                    <button type="button" onClick={() => void finance()} disabled={paying || financing}
                      className="flex h-14 items-center justify-center gap-1.5 rounded-xl bg-[#FFB3C7] text-[16px] font-bold text-black shadow-md active:scale-[0.98] disabled:opacity-70">
                      {financing ? "Opening…" : <><span className="font-black tracking-tight">Klarna.</span> Apply</>}
                    </button>
                  </div>
                  <p className="mt-2 text-center text-[13px] text-white/75">Either one confirms your date. Klarna pays the whole job, {formatCurrency(total)}, over time.</p>
                </>
              ) : (
              <button type="button" onClick={pay}
                className="mt-3 flex h-14 w-full items-center justify-center gap-2 rounded-xl text-[17px] font-bold text-[#15130F] shadow-md active:scale-[0.98]" style={{ background: GOLD }}>
                <Lock className="h-5 w-5" /> {paying ? "Paying…" : `Pay ${formatCurrency(DEPOSIT)} to lock in my date`}
              </button>
              )}
              <p className="mt-2 text-center text-[13px] text-white/75">We hold it for you until {holdUntil.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}.</p>
            </div>
          )}

          {state === "cancelled" ? null : <>
          {/* The date, like a calendar invite but ours. */}
          <div className="flex gap-4 rounded-2xl bg-white p-4 ring-1 ring-[#15130F]/10">
            <div className="w-[76px] shrink-0 overflow-hidden rounded-xl text-center ring-1 ring-[#15130F]/15">
              <p className="py-1 text-[12px] font-bold uppercase tracking-wider text-white" style={{ background: confirmed ? "#047857" : GOLD }}>
                {date.toLocaleDateString("en-US", { month: "short" })}
              </p>
              <p className="font-heading text-[34px] font-bold leading-[1.1]">{date.getDate()}</p>
              <p className="pb-1 text-[12px] font-semibold text-[#15130F]/70">{date.toLocaleDateString("en-US", { weekday: "short" })}</p>
            </div>
            <div className="min-w-0">
              <p className="text-[13px] font-bold uppercase tracking-wide text-[#8C6224]">{confirmed ? "Your start date" : "The date we're holding"}</p>
              <p className="font-heading text-[22px] font-bold leading-tight">{longDate}</p>
              <p className="mt-1 text-[15px]">Fence staining{feet ? ` · ${feet} ft` : ""}</p>
              <p className="mt-1 flex items-start gap-1.5 text-[14px] text-[#15130F]/75"><MapPin className="mt-0.5 h-4 w-4 shrink-0" /> {address}</p>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-2xl bg-sky-50 p-3.5 ring-1 ring-sky-200">
            <CloudRain className="mt-0.5 h-5 w-5 shrink-0 text-sky-700" />
            <p className="text-[15px] leading-snug">This is the day we're aiming for. Stain only goes on a dry fence, so if rain is coming we'll text you and pick the next dry day together. We text you the day before, too.</p>
          </div>

          <button type="button" onClick={addToCalendar}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-[#15130F] text-[17px] font-bold text-[#E3BE63] active:scale-[0.98]">
            <CalendarPlus className="h-5 w-5" /> Add to my calendar
          </button>

          {/* Where they are in it. */}
          <div className="rounded-2xl bg-white p-4 ring-1 ring-[#15130F]/10">
            <p className="text-[13px] font-bold uppercase tracking-wide text-[#8C6224]">Where you are</p>
            <ol className="mt-2 space-y-2.5">
              {STEPS.map((s, i) => {
                const done = i < stepNow;
                const now = i === stepNow;
                return (
                  <li key={s} className="flex items-center gap-3 text-[15px]">
                    <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-bold",
                      done ? "bg-emerald-700 text-white" : now ? "text-[#15130F] ring-2 ring-[#C9972F]" : "bg-[#15130F]/10 text-[#15130F]/60")}
                      style={now ? { background: "#F6E7C1" } : undefined}>
                      {done ? <Check className="h-4 w-4" /> : i + 1}
                    </span>
                    <span className={cn(done ? "text-[#15130F]/75" : now ? "font-bold" : "text-[#15130F]/70")}>
                      {s}{now && i === 2 ? ` · ${formatCurrency(DEPOSIT)}` : ""}{now && i === 3 ? ` · ${weekday}` : ""}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>

          {/* What's being done, and the money. */}
          <div className="rounded-2xl bg-white p-4 ring-1 ring-[#15130F]/10">
            <p className="text-[13px] font-bold uppercase tracking-wide text-[#8C6224]">Your job</p>
            <dl className="mt-2 space-y-2 text-[15px]">
              <Row k="Package" v={pkgName} />
              {color ? <Row k="Color" v={color} /> : null}
              {sides.length ? <Row k="Sides" v={sides.join(", ")} /> : null}
              <Row k="Two coats, cleaning, prep and cleanup" v="Included" />
              <div className="border-t border-[#15130F]/10 pt-2">
                {/* The discount spelled out, so the math reads top to bottom. */}
                {discount || repairs?.length ? (
                  <>
                    <Row k={pkgName || "Package"} v={formatCurrency(total + (discount || 0) - repairSum + (repairsDiscount || 0))} />
                    {discount ? <div className="flex justify-between gap-3 font-semibold text-emerald-700">
                      <dt>Your discount{discountLabel ? ` · ${discountLabel}` : ""}</dt>
                      <dd className="whitespace-nowrap text-right tabular-nums">− {formatCurrency(discount || 0)}</dd>
                    </div> : null}
                  </>
                ) : null}
                {/* Each repair on its own line, the way it was agreed on the phone. */}
                {repairs?.map((r) => (
                  <div key={r.name} className="flex justify-between gap-3">
                    <dt className="text-[#15130F]/75">{r.name} <span className="whitespace-nowrap">× {r.qty} @ {formatCurrency(r.unit_price).replace(".00", "")}</span></dt>
                    <dd className="whitespace-nowrap text-right font-semibold tabular-nums">{formatCurrency(r.qty * r.unit_price)}</dd>
                  </div>
                ))}
                {repairsDiscount ? (
                  <div className="flex justify-between gap-3 font-semibold text-emerald-700">
                    <dt>Repairs discount{repairsDiscountLabel ? ` · ${repairsDiscountLabel}` : ""}</dt>
                    <dd className="whitespace-nowrap text-right tabular-nums">− {formatCurrency(repairsDiscount)}</dd>
                  </div>
                ) : null}
                <Row k="Job total" v={formatCurrency(total)} bold={!!(discount || repairs?.length)} />
                <Row k={confirmed ? (paidInFull ? "Paid" : "Deposit paid") : "Deposit to confirm"} v={confirmed ? `− ${formatCurrency(paid)}` : formatCurrency(DEPOSIT)} />
                <Row k="Due after the job" v={formatCurrency(balance)} bold />
              </div>
            </dl>
            {page && !proposalHref ? null : <a href={proposalHref || "#"} target={proposalHref ? "_blank" : undefined} rel="noreferrer"
              onClick={proposalHref ? undefined : (e) => { e.preventDefault(); setToast("Their proposal opens here"); }}
              className="mt-3 flex h-12 items-center justify-center gap-2 rounded-xl text-[15px] font-bold ring-1 ring-[#15130F]/15">
              <FileText className="h-4 w-4" style={{ color: GOLD }} /> See my full proposal
            </a>}
          </div>

          {notes?.trim() ? (
            <div className="rounded-2xl bg-[#FFF8E6] p-4 ring-1 ring-[#C9972F]/40">
              <p className="text-[13px] font-bold uppercase tracking-wide text-[#8C6224]">A note from Alan</p>
              <p className="mt-1.5 whitespace-pre-line text-[16px] leading-relaxed">{notes.trim()}</p>
            </div>
          ) : null}

          {confirmed ? (
            <div className="rounded-2xl bg-white p-4 ring-1 ring-[#15130F]/10">
              <p className="text-[13px] font-bold uppercase tracking-wide text-[#8C6224]">Before we come</p>
              <ul className="mt-2 space-y-1.5 text-[15px]">
                <li>🔓 Gates unlocked, water and power on</li>
                <li>💦 Sprinklers off the day before, the day of and the day after</li>
                <li>🐶 Pets inside while we work</li>
                <li>🏡 Home when we finish? We'll walk the fence with you</li>
              </ul>
            </div>
          ) : null}

          </>}

          <div className="grid grid-cols-2 gap-2">
            <a href={`sms:+1${PHONE.replace(/-/g, "")}`} className="flex h-12 items-center justify-center gap-2 rounded-xl bg-white text-[15px] font-bold ring-1 ring-[#15130F]/15"><MessageSquare className="h-4 w-4" /> Text us</a>
            <a href={`tel:+1${PHONE.replace(/-/g, "")}`} className="flex h-12 items-center justify-center gap-2 rounded-xl bg-white text-[15px] font-bold ring-1 ring-[#15130F]/15"><Phone className="h-4 w-4" /> Call us</a>
          </div>
          {state === "cancelled" ? null : page ? (
            <a href={`sms:+1${PHONE.replace(/-/g, "")}?&body=${encodeURIComponent(`Hi, it's ${firstName}. Can we pick a different day than ${longDate}?`)}`}
              className="flex h-11 items-center justify-center text-[15px] font-semibold underline underline-offset-2">Need a different day?</a>
          ) : (
            <button type="button" onClick={() => setToast(`Opens a text: "Hi, can we pick a different day than ${longDate}?"`)}
              className="h-11 text-[15px] font-semibold underline underline-offset-2">Need a different day?</button>
          )}

          <p className="text-center text-[13px] text-[#15130F]/70">Sterling Fence Staining · {PHONE} · {EMAIL}</p>
        </div>

        {staff ? (
          <div className="border-t border-[#C9972F]/40 bg-[#15130F] text-white">
            <button type="button" onClick={() => setBehind((v) => !v)} className="flex h-10 w-full items-center justify-between px-4 text-[12px] font-bold uppercase tracking-wider text-[#E3BE63]">
              <span>How it's sent · what fires</span><span>{behind ? "Hide" : "Show"}</span>
            </button>
            {behind ? (
              <div className="max-h-56 space-y-2 overflow-y-auto px-4 pb-3 text-[12px]">
                <p className="rounded bg-white/5 px-2 py-1.5"><span className="font-bold text-[#E3BE63]">Text:</span> {textMsg}</p>
                <p className="rounded bg-white/5 px-2 py-1.5"><span className="font-bold text-[#E3BE63]">Email</span> from {EMAIL}: “{emailSubject}”</p>
                <ul className="space-y-1 font-mono text-white/85">
                  {fires.map((f) => <li key={f} className="rounded bg-white/5 px-2 py-1">{f}</li>)}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        {toast ? <p className="absolute inset-x-5 bottom-16 z-20 rounded-xl bg-[#15130F] px-3 py-2.5 text-center text-[14px] text-[#F8F3E7] shadow-lg">{toast}</p> : null}
      </div>
    </div>
  );
}

function Row({ k, v, bold }: { k: string; v: string; bold?: boolean }) {
  return (
    <div className={cn("flex justify-between gap-3", bold && "font-bold")}>
      <dt className="text-[#15130F]/75">{k}</dt>
      <dd className="text-right font-semibold tabular-nums">{v}</dd>
    </div>
  );
}
