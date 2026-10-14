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
import { Check, CalendarPlus, CloudRain, FileText, MessageSquare, Phone, Lock, Clock, MapPin } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";

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

export function BookingInvite({ firstName, address, pkgName, color, sides, feet, total, date, staff, onClose }: {
  firstName: string; address: string; pkgName: string; color: string; sides: string[]; feet: number; total: number;
  /** The day we're aiming for. */
  date: Date;
  staff?: boolean;
  onClose: () => void;
}) {
  const [state, setState] = useState<BookingState>("held");
  const [paying, setPaying] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [behind, setBehind] = useState(false);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 2400); return () => clearTimeout(t); }, [toast]);

  const confirmed = state === "confirmed";
  const balance = Math.max(0, total - DEPOSIT);
  const stepNow = confirmed ? 3 : 2; // index of the step they're on
  const weekday = date.toLocaleDateString("en-US", { weekday: "long" });
  const longDate = date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  // Held for 7 days, never past the day before the job itself.
  const [holdUntil] = useState(() => {
    const now = new Date();
    const week = new Date(now); week.setDate(week.getDate() + 7);
    const dayBefore = new Date(date); dayBefore.setDate(dayBefore.getDate() - 1);
    return week > dayBefore ? (dayBefore > now ? dayBefore : now) : week;
  });
  const proposalUrl = "estimate.sterlingfencetx.com/p/…";
  const bookingUrl = "estimate.sterlingfencetx.com/b/…";

  // The mockup's deposit: a moment of "paying", then the page confirms by
  // itself, which is what Stripe's paid webhook does on the real one.
  const pay = () => {
    if (paying) return;
    setPaying(true);
    setTimeout(() => { setPaying(false); setState("confirmed"); setToast("Deposit paid. The page confirmed itself."); }, 900);
  };
  const addToCalendar = () => {
    try {
      const blob = new Blob([icsFile(date, address, confirmed, `https://${proposalUrl}`)], { type: "text/calendar" });
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
    "Stripe: $250 deposit paid",
    "This page: flips to Confirmed by itself (nobody touches anything)",
    `Text + email to ${firstName}: "You're confirmed"`,
    "Dashboard calendar: job turns from Held to Confirmed",
    "GHL tag: deposit_paid · pipeline: Scheduling",
  ] : [
    `Text from the Sterling number + email from ${EMAIL}`,
    "Dashboard calendar: job shows as Held on this date",
    `Hold ends ${holdUntil.toLocaleDateString("en-US", { month: "short", day: "numeric" })} if no deposit (7 days); Alan is told the day before`,
    "Opens are tracked like the proposal (when, how many times)",
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4" onClick={onClose}>
      <div className="relative flex max-h-[94vh] w-full max-w-md flex-col overflow-hidden rounded-t-3xl bg-[#F8F3E7] text-[#15130F] shadow-2xl sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between bg-[#15130F] px-4 py-3">
          <img src="/sterling-logo-dark.png" alt="Sterling Fence Staining" className="h-7 w-auto" draggable={false} />
          <div className="flex items-center gap-2">
            <span className="rounded bg-amber-400/90 px-1.5 py-0.5 text-[12px] font-bold uppercase tracking-wider text-amber-950">Mockup</span>
            <button type="button" onClick={onClose} className="h-9 rounded-lg bg-white/10 px-3 text-[13px] font-semibold text-white">Close</button>
          </div>
        </div>

        {staff ? (
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

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5 pt-4">
          {/* The status, first thing they see. */}
          {confirmed ? (
            <div className="flex items-center gap-3 rounded-2xl bg-emerald-700 p-4 text-white shadow-md">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/15"><Check className="h-6 w-6" /></span>
              <div>
                <p className="text-[19px] font-bold leading-tight">You're confirmed</p>
                <p className="text-[15px] text-white/90">Deposit paid · {formatCurrency(DEPOSIT)}</p>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl bg-[#15130F] p-4 text-white shadow-md">
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full" style={{ background: GOLD }}><Clock className="h-6 w-6 text-[#15130F]" /></span>
                <div>
                  <p className="text-[19px] font-bold leading-tight">Your date is on hold</p>
                  <p className="text-[15px] text-white/85">{formatCurrency(DEPOSIT)} deposit to confirm</p>
                </div>
              </div>
              <button type="button" onClick={pay}
                className="mt-3 flex h-14 w-full items-center justify-center gap-2 rounded-xl text-[17px] font-bold text-[#15130F] shadow-md active:scale-[0.98]" style={{ background: GOLD }}>
                <Lock className="h-5 w-5" /> {paying ? "Paying…" : `Pay ${formatCurrency(DEPOSIT)} to lock in my date`}
              </button>
              <p className="mt-2 text-center text-[13px] text-white/75">We hold it for you until {holdUntil.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}.</p>
            </div>
          )}

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
                <Row k="Job total" v={formatCurrency(total)} />
                <Row k={confirmed ? "Deposit paid" : "Deposit to confirm"} v={confirmed ? `− ${formatCurrency(DEPOSIT)}` : formatCurrency(DEPOSIT)} />
                <Row k="Due after the job" v={formatCurrency(balance)} bold />
              </div>
            </dl>
            <a href="#" onClick={(e) => { e.preventDefault(); setToast("Their proposal opens here"); }}
              className="mt-3 flex h-12 items-center justify-center gap-2 rounded-xl text-[15px] font-bold ring-1 ring-[#15130F]/15">
              <FileText className="h-4 w-4" style={{ color: GOLD }} /> See my full proposal
            </a>
          </div>

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

          <div className="grid grid-cols-2 gap-2">
            <a href={`sms:+1${PHONE.replace(/-/g, "")}`} className="flex h-12 items-center justify-center gap-2 rounded-xl bg-white text-[15px] font-bold ring-1 ring-[#15130F]/15"><MessageSquare className="h-4 w-4" /> Text us</a>
            <a href={`tel:+1${PHONE.replace(/-/g, "")}`} className="flex h-12 items-center justify-center gap-2 rounded-xl bg-white text-[15px] font-bold ring-1 ring-[#15130F]/15"><Phone className="h-4 w-4" /> Call us</a>
          </div>
          <button type="button" onClick={() => setToast(`Opens a text: "Hi, can we pick a different day than ${longDate}?"`)}
            className="h-11 text-[15px] font-semibold underline underline-offset-2">Need a different day?</button>

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
