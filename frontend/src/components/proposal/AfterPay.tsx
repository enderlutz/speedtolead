// The screens after a payment, for the proposal mockup. Alan's spec and
// prototype (2026-10-10) set the two flows: A after the $250 deposit (job not
// done, no survey), B after the final payment (score, referral, Google
// review, other services). This is the mockup of that in the proposal's own
// look, with the financing cases worked in:
//
//   deposit by card            -> Flow A, balance due after the job
//   whole job through Klarna/
//   Affirm or by card up front -> Flow A, "paid in full", nothing due to us;
//                                 the balance link never goes out. Flow B is
//                                 sent when the crew marks the job done.
//   balance after the job      -> Flow B. Card, Klarna or Affirm all work
//                                 here too (Stripe Checkout offers them).
//
// Nothing here sends, saves or tags anything. The "What fires" strip under
// the screen shows staff the tags and tasks the real version would fire.
// Rules kept from the spec: one idea per screen, Skip on every screen but
// the confirmations, and the Google review button is the same for every
// score. The review ask is never tied to the referral reward.
import { useEffect, useMemo, useState } from "react";
import { Check, Copy, MessageSquare, Share2, Phone, ExternalLink, ArrowLeft, ReceiptText, Star } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";

export type PayFlow = "deposit" | "full" | "balance";
export type PayMethod = "card" | "klarna" | "affirm";

const GOLD = "#C9972F";
const PHONE = "346-589-7877";
// Already the review link the dashboard texts customers (api/customer_upsell.py).
const REVIEW_URL = "https://g.page/r/CSqFYMG3SFFFEBM/review";
// Alan's list in the spec, minus fence repairs: "if we've already stained
// their fence it's too late now, usually" (2026-10-10).
const SERVICES = ["House wash", "Driveway & concrete", "Window cleaning", "Roof washing", "Gutter cleaning", "Sprinkler repair", "Landscaping", "Other"];
// What to know before we come, fun but plain (Alan, 2026-10-13). He'd
// rather the customer be home: the crew does a better job with someone to
// walk the fence with at the end. But plenty never are, and that's fine.
const PREP: [string, string, string][] = [
  ["🏡", "Home on job day? Even better.", "If you're home when we finish, we'll walk the fence with you so nothing gets missed. Can't be home? No problem. We photograph the whole job and send you the photos."],
  ["🔓", "Gates unlocked, water and power on", "Leave the gates unlocked. An outside spigot and one outlet is all we need."],
  // Moving things is part of the job: about a third of our customers are
  // older and hired us because they can't (Alan, 2026-10-13). Ask only
  // for the easy things, and say plainly the crew does the rest.
  ["🪴", "Things near the fence", "We move what's in the way and put it back. If you'd like, move small things like pots or chairs. No need to lift anything heavy."],
  ["💦", "Sprinklers off", "The day before, the day of, and the day after. The stain needs to dry."],
  ["🐶", "Pets inside on job days", "Gates will be open while we work."],
  ["🌧️", "Rain in the forecast?", "We move your day and let you know. Stain only goes on a dry fence."],
];

type Screen = "locked" | "prep" | "neighbor" | "doneA" | "paid" | "score" | "sorry" | "referral" | "review" | "next" | "doneB";
const FLOW_A: Screen[] = ["locked", "prep", "neighbor", "doneA"];
// Flow B by the stars (Alan, 2026-10-15): 4–5 go to the Google review, then
// referral and services; 1–3 hear "Alan will call you today" (the review
// link is still there for them, small: asking only happy customers is
// against Google's rules), then referral and services. A link sent with the
// review switched off skips the review ask for everyone.
// The photo version (Alan, 2026-10-29): no star screen. Customers tapped 5
// stars and thought that was their Google review, and only the happy ones
// were sent on to Google (gating). Now the first screen is their fence's
// after photos, Save your photos, and one big Write us a Google review,
// the same for everyone; anyone unhappy has a small "Tell Alan" right there.
function flowB(stars: number | null, askReview: boolean, photoReview?: boolean): Screen[] {
  if (photoReview) return ["paid", "referral", "next", "doneB"];
  const unhappy = stars !== null && stars <= 3;
  return ["paid", "score", ...(unhappy ? ["sorry" as Screen] : askReview ? ["review" as Screen] : []), "referral", "next", "doneB"];
}
const NO_SKIP = new Set<Screen>(["locked", "paid", "doneA", "doneB"]);
const NAMES: Record<Screen, string> = {
  locked: "Locked in", prep: "Prep checklist", neighbor: "Friends and neighbors", doneA: "Done",
  paid: "Paid in full", score: "How did we do?", sorry: "We'll make it right", referral: "Referral", review: "Google review", next: "Other services", doneB: "Done",
};

export function AfterPay({ flow, method, paidUpFront, firstName, address, pkgName, feet, total, repairs, amount: amountProp, staff, page, initial, onAnswer, onClose, receiptUrl, onScreen, askReview, referralUrl, onReferFriend, photos, photoReview }: {
  flow: PayFlow; method: PayMethod; paidUpFront?: boolean;
  firstName: string; address: string; pkgName: string; feet: number; total: number; repairs: number;
  /** What was just paid. The mockup derives it from the flow; the real page knows it. */
  amount?: number;
  staff?: boolean;
  /** The real thing: a full page, no overlay, no close, no mockup badge. */
  page?: boolean;
  /** Answers already saved, so closing the page midway loses nothing. */
  initial?: Record<string, unknown>;
  /** Called the moment an answer is given. The real page posts it. */
  onAnswer?: (field: string, value: unknown) => void;
  onClose?: () => void;
  /** The paid receipt (save, share, text). None when nothing was paid here. */
  receiptUrl?: string;
  /** Called as each screen shows (step is 1-based), so staff can see how far they got. */
  onScreen?: (step: number, of: number, name: string) => void;
  /** False: the link was sent with the Google review ask switched off. */
  askReview?: boolean;
  /** Their own referral link, a real page. The mockup makes one up. */
  referralUrl?: string;
  /** Send us a friend's name and number; Alan's welcome text goes out. */
  onReferFriend?: (name: string, phone: string) => Promise<void>;
  /** The job's after photos the office picked, shown on the paid screen. */
  photos?: string[];
  /** The photo version of the job-done screens (mockup until Alan says go). */
  photoReview?: boolean;
}) {
  const init = initial || {};
  const [stars, setStars] = useState<number | null>(typeof init.stars === "number" ? init.stars : null);
  const screens = useMemo(() => (flow === "balance" ? flowB(stars, askReview !== false, photoReview) : FLOW_A), [flow, stars, askReview, photoReview]);
  const savedServices = Array.isArray(init.services_interested) ? (init.services_interested as string[]) : [];
  const [step, setStep] = useState(0);
  const [prep, setPrep] = useState(init.prep_acknowledged === true);
  const [share, setShare] = useState({ text: false, copy: false, share: false });
  const [sheet, setSheet] = useState(false);
  // The old 0–10 score, read for answers saved before the stars.
  const [score] = useState<number | null>(typeof init.score === "number" ? init.score : null);
  const [comment, setComment] = useState(typeof init.comment === "string" ? init.comment : "");
  const [review, setReview] = useState(init.review_clicked === true);
  const [callback, setCallback] = useState(init.callback_requested === true);
  const [services, setServices] = useState<Record<string, boolean>>(Object.fromEntries(savedServices.filter((s) => SERVICES.includes(s)).map((s) => [s, true])));
  const [other, setOther] = useState(savedServices.find((s) => s.startsWith("Other: "))?.slice(7) || "");
  const [feature, setFeature] = useState(init.feature_permission === true);
  const [skipped, setSkipped] = useState<string[]>([]);
  const answer = (field: string, value: unknown) => { if (onAnswer) onAnswer(field, value); };
  const [toast, setToast] = useState<string | null>(null);
  // A friend typed in here rather than shared a link to (Alan, 2026-10-15).
  const [friend, setFriend] = useState({ name: "", phone: "", ok: false });
  const [friendBusy, setFriendBusy] = useState(false);
  const [friendsSent, setFriendsSent] = useState<string[]>([]);
  const sendFriend = async () => {
    if (friendBusy || !friend.name.trim() || !friend.phone.trim() || !friend.ok) return;
    setFriendBusy(true);
    try {
      if (onReferFriend) await onReferFriend(friend.name.trim(), friend.phone.trim());
      setFriendsSent((f) => [...f, friend.name.trim().split(" ")[0]]);
      setFriend({ name: "", phone: "", ok: false });
      setToast(onReferFriend ? "Sent! Alan just texted them." : "Alan's welcome text goes to them here");
      answer("referral_shared", ["friend form"]);
    } catch (e) {
      setToast(e instanceof Error ? e.message : "That didn't go through. Try again.");
    } finally {
      setFriendBusy(false);
    }
  };
  const [behind, setBehind] = useState(false);
  const [saved, setSaved] = useState(init.photos_saved === true);
  const [saving, setSaving] = useState(false);
  const [tell, setTell] = useState(false);
  const [told, setTold] = useState(init.callback_requested === true);
  const [big, setBig] = useState<number | null>(null);
  // One tap → the phone's share sheet with every photo, where "Save to
  // Photos" puts them all in the camera roll. A web page can't save to the
  // camera roll by itself; where sharing files isn't possible, they open
  // one by one to press and hold.
  const savePhotos = async () => {
    if (!photos?.length || saving) return;
    setSaving(true);
    try {
      const files = await Promise.all(photos.map(async (u, i) => {
        const b = await (await fetch(u)).blob();
        return new File([b], `sterling-fence-${i + 1}.jpg`, { type: b.type || "image/jpeg" });
      }));
      if (navigator.canShare?.({ files })) {
        await navigator.share({ files });
      } else {
        setBig(0);
        setToast("Press and hold a photo, then tap Save");
      }
      setSaved(true);
      answer("photos_saved", true);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) { setBig(0); setToast("Press and hold a photo, then tap Save"); }
    } finally {
      setSaving(false);
    }
  };
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 2200); return () => clearTimeout(t); }, [toast]);

  const screen = screens[step];
  useEffect(() => { onScreen?.(step + 1, screens.length, NAMES[screens[step]]); }, [step, screens, onScreen]);
  const lender = method === "klarna" ? "Klarna" : method === "affirm" ? "Affirm" : null;
  const amount = amountProp ?? (flow === "deposit" ? 250 : flow === "full" ? total : Math.max(0, total - 250));
  const balance = total > 0 ? Math.max(0, total - amount) : 0;
  const financed = flow === "full" && !!lender;
  const code = referralUrl ? referralUrl.split("/").pop() || "" : `${firstName.toUpperCase().replace(/[^A-Z]/g, "") || "FRIEND"}14`;
  const link = referralUrl ? referralUrl.replace(/^https?:\/\//, "") : `estimate.sterlingfencetx.com/r/${code}`;
  const smsText = flow === "balance"
    ? `Sterling just stained our fence and it looks brand new. Use my link and you get $100 off yours: ${link}`
    : `Hey! We're getting our fence stained by Sterling Fence Staining soon. They'll take $100 off yours if you book through my link: ${link}`;
  const go = (n: number) => {
    setSheet(false);
    const to = Math.min(n, screens.length - 1);
    setStep(to);
    if (to === screens.length - 1) answer("finished", true);
  };
  const skip = () => {
    const next = [...skipped, NAMES[screen]];
    setSkipped(next);
    answer("skipped_screens", next);
    go(step + 1);
  };
  const band = stars !== null ? (stars === 5 ? "promoter" : stars === 4 ? "passive" : "detractor")
    : score === null ? null : score >= 9 ? "promoter" : score >= 7 ? "passive" : "detractor";
  const sharedHow = [share.text && "text", share.copy && "copy link", share.share && "share sheet"].filter(Boolean).join(", ");

  const shared = (how: "text" | "copy" | "share") => {
    const next = { ...share, [how]: true };
    setShare(next);
    answer("referral_shared", Object.entries(next).filter(([, v]) => v).map(([k]) => k));
  };
  const copyLink = () => {
    shared("copy");
    try { void navigator.clipboard?.writeText(`https://${link}`); } catch { /* the mockup doesn't care */ }
    setToast("Link copied");
  };
  const shareLink = async () => {
    shared("share");
    const nav = navigator as Navigator & { share?: (d: { text: string }) => Promise<void> };
    if (nav.share) { try { await nav.share({ text: smsText }); return; } catch { /* closed */ } }
    setToast("Your phone's share menu opens here");
  };

  // What the real version fires, for staff. Names are placeholders to map
  // onto the live GHL tags, pipelines and stages.
  const fires: string[] = [];
  if (flow !== "balance" || !paidUpFront) fires.push(`Stripe: payment succeeded ${formatCurrency(flow === "deposit" ? 250 : flow === "full" ? total : balance)}${lender ? ` through ${lender}` : ""}`, "QuickBooks: invoice marked paid (books only, customer never sees it)");
  if (flow !== "balance") {
    fires.push(financed ? "GHL tag: paid_in_full_upfront (balance link never goes out)" : flow === "full" ? "GHL tag: paid_in_full_upfront" : "GHL tag: deposit_paid", "GHL pipeline: moved to Scheduling", "Task: call to set the start day (text if no answer)");
    if (prep) fires.push("GHL tag: prep_confirmed");
    if (sharedHow) fires.push("GHL tag: referral_shared", `Referral: watch ${code}, each friend who books gets $100 off`, financed ? `Rule: ${firstName}'s $100 comes back as a refund, once (decision open)` : `Rule: first booking takes $100 off ${firstName}'s balance, once only`);
  } else {
    fires.push("GHL tag: paid_in_full", "GHL pipeline: moved to Complete");
    if (band) fires.push(`GHL tag: nps_${band}`);
    if (band === "detractor") fires.push(`Alert: text Alan, ${stars ?? score}${stars !== null ? "/5 stars" : "/10"} from ${firstName}: call today`);
    if (askReview === false) fires.push("Google review: not asked on this link (switched off)");
    if (comment.trim()) fires.push(`Note on the contact: "${comment.trim()}"`);
    if (review) fires.push("GHL tag: review_link_clicked");
    if (callback) fires.push(photoReview ? `Alert: text Alan, ${firstName} says something's not right: call today` : "Task: Alan calls the customer");
    if (saved) fires.push("Their fence photos saved to their phone");
    if (sharedHow) fires.push("GHL tag: referral_shared", `Referral: watch ${code}, $100 off for the friend, $100 to ${firstName} when their job is done`);
    SERVICES.filter((s) => services[s]).forEach((s) => fires.push(`Lead created: ${s === "Other" && other.trim() ? `Other ("${other.trim()}")` : s}`));
    if (feature) fires.push("GHL tag: testimonial_permission");
  }
  if (skipped.length) fires.push(`Skipped: ${skipped.join(", ")}`);

  const shareBlock = (
    <div className="space-y-2">
      <button type="button" onClick={() => setSheet(true)} className="flex h-14 w-full items-center justify-center gap-2 rounded-xl text-[17px] font-bold text-[#15130F] shadow-md active:scale-[0.98]" style={{ background: GOLD }}>
        <MessageSquare className="h-5 w-5" /> {share.text ? "Text sent ✓ Text another" : "Text a friend"}
      </button>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={copyLink} className="flex h-12 items-center justify-center gap-2 rounded-xl border-2 border-[#15130F] bg-white text-[15px] font-bold"><Copy className="h-4 w-4" /> {share.copy ? "Copied ✓" : "Copy link"}</button>
        <button type="button" onClick={shareLink} className="flex h-12 items-center justify-center gap-2 rounded-xl border-2 border-[#15130F] bg-white text-[15px] font-bold"><Share2 className="h-4 w-4" /> {share.share ? "Shared ✓" : "Share"}</button>
      </div>
      <p className="select-all rounded-xl border border-dashed border-[#C9972F] bg-white px-3 py-2.5 text-center text-[14px] font-semibold tracking-wide">{link}</p>
    </div>
  );
  const offer = (a: string, b: string) => (
    <div className="grid grid-cols-2 gap-2">
      {[a, b].map((t) => (
        <div key={t} className="rounded-2xl bg-white p-3 text-center ring-1 ring-[#15130F]/10">
          <p className="font-heading text-3xl font-bold leading-none" style={{ color: "#8C6224" }}>$100</p>
          <p className="mt-1 text-[14px] font-semibold text-[#15130F]/80">{t}</p>
        </div>
      ))}
    </div>
  );
  const contact = (
    <div className="rounded-2xl bg-white p-4 ring-1 ring-[#15130F]/10">
      <p className="text-[14px] font-semibold text-[#15130F]/75">Call or text us any time</p>
      <a href={`tel:+1${PHONE.replace(/-/g, "")}`} className="mt-1 flex items-center gap-2 font-heading text-2xl font-bold"><Phone className="h-5 w-5" style={{ color: GOLD }} /> {PHONE}</a>
    </div>
  );
  // On the mockup there's no real receipt yet, so the button just says so.
  const receipt = paidUpFront ? null : (
    <a href={receiptUrl || undefined} target={receiptUrl ? "_blank" : undefined} rel="noreferrer"
      onClick={receiptUrl ? undefined : (e) => { e.preventDefault(); setToast("Their receipt opens here: save, share or text it"); }}
      className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-white text-[17px] font-bold ring-1 ring-[#15130F]/15">
      <ReceiptText className="h-5 w-5" style={{ color: GOLD }} /> Your receipt
    </a>
  );
  const tick = <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[#15130F] text-[#E3BE63] ring-4 ring-[#C9972F]/50"><Check className="h-8 w-8" /></span>;

  let body: React.ReactNode = null;
  let foot: React.ReactNode = null;
  const next = (label: string, ghost?: boolean) => (
    <button type="button" onClick={() => go(step + 1)}
      className={cn("flex h-14 w-full items-center justify-center rounded-xl text-[17px] font-bold active:scale-[0.98]", ghost ? "border-2 border-[#15130F] bg-white text-[#15130F]" : "bg-[#15130F] text-[#E3BE63]")}>
      {label}
    </button>
  );

  switch (screen) {
    case "locked":
      body = (
        <>
          {tick}
          <h2 className="font-heading text-3xl font-bold leading-tight">You're on the schedule, {firstName}! 🎉</h2>
          <p className="text-[17px]">Your backyard is about to look brand new. We'll call you shortly to pick your start day. If we miss you, we'll text.</p>
          <p className="text-[15px] text-[#15130F]/80">First we clean the fence if it needs it. Then, once it's dry, we stain it.</p>
          <div className="rounded-2xl bg-white p-4 ring-1 ring-[#15130F]/10">
            <dl className="space-y-2 text-[15px]">
              {financed ? (
                <Row k={`Paid in full through ${lender}`} v={formatCurrency(amount)} />
              ) : flow === "full" ? (
                <Row k="Paid in full" v={formatCurrency(amount)} />
              ) : (
                <Row k="Deposit paid" v={formatCurrency(amount)} />
              )}
              {pkgName ? <Row k="Package" v={pkgName + (repairs ? " + repairs" : "")} /> : null}
              {address ? <Row k="Address" v={address} /> : null}
              {flow === "deposit" ? (
                <div className="border-t border-[#15130F]/10 pt-2">
                  <Row k="Due after the job" v={total > 0 ? formatCurrency(balance) : "The rest"} bold />
                  <p className="mt-1 text-[13px] text-[#15130F]/75">Pay it then by card, or split it with Klarna.</p>
                </div>
              ) : (
                <div className="border-t border-[#15130F]/10 pt-2">
                  <Row k="Due after the job" v="$0" bold />
                  {financed ? <p className="mt-1 text-[13px] text-[#15130F]/75">Your payments go to {lender}. They'll remind you before each one. Nothing more is due to us.</p> : null}
                </div>
              )}
            </dl>
          </div>
        </>
      );
      foot = next("Continue");
      break;
    case "prep":
      body = (
        <>
          <h2 className="font-heading text-3xl font-bold leading-tight">Before we show up 👋</h2>
          <ol className="space-y-2">
            {PREP.map(([icon, t, d]) => (
              <li key={t} className="flex gap-3 rounded-2xl bg-white p-3.5 ring-1 ring-[#15130F]/10">
                <span aria-hidden className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#F8F3E7] text-[22px] ring-1 ring-[#C9972F]/40">{icon}</span>
                <div><p className="text-[16px] font-bold leading-snug">{t}</p><p className="mt-0.5 text-[14px] leading-snug text-[#15130F]/75">{d}</p></div>
              </li>
            ))}
          </ol>
        </>
      );
      foot = <button type="button" onClick={() => { setPrep(true); answer("prep_acknowledged", true); go(step + 1); }} className="flex h-14 w-full items-center justify-center rounded-xl bg-[#15130F] text-[17px] font-bold text-[#E3BE63] active:scale-[0.98]">Got it</button>;
      break;
    case "neighbor":
      body = (
        <>
          <h2 className="font-heading text-3xl font-bold leading-tight">Your neighbors' fences are aging too.</h2>
          <p className="text-[16px]">Let your friends and neighbors know. Anyone who books through your link gets $100 off their fence, and you get $100 off yours.</p>
          {offer("off for you", "off for your friend")}
          {shareBlock}
          <p className="text-[14px] text-[#15130F]/75">Share it with as many people as you like. Your $100 off applies once.</p>
        </>
      );
      foot = next("Done", true);
      break;
    case "doneA":
      body = (
        <>
          {tick}
          <h2 className="font-heading text-3xl font-bold leading-tight">That's it. We'll take it from here.</h2>
          <p className="text-[17px]">We'll call you shortly to pick your start day. If we miss you, we'll text. Anything changes on your end? Just reply to our text.</p>
          {receipt}
          {contact}
          <p className="text-[14px] text-[#15130F]/75">You can close this page.</p>
        </>
      );
      break;
    case "paid":
      if (photoReview) {
        body = (
          <>
            <h2 className="font-heading text-3xl font-bold leading-tight">Paid in full. Thank you, {firstName}.</h2>
            <p className="-mt-2 text-[15px] text-[#15130F]/75">{formatCurrency(amount)} paid today{lender ? ` through ${lender}` : ""}. {receiptUrl || !page ? "Your receipt is at the end." : ""}</p>
            {photos?.length ? (
              <>
                <p className="text-[17px] font-bold">Here's your fence 🎉</p>
                <div className="-mx-5 flex snap-x snap-mandatory gap-2 overflow-x-auto px-5 pb-1">
                  {photos.map((u, i) => (
                    <button key={u} type="button" onClick={() => setBig(i)} className="shrink-0 snap-start overflow-hidden rounded-2xl ring-1 ring-[#15130F]/10">
                      <img src={u} alt={`Your fence, photo ${i + 1}`} className="h-56 w-64 object-cover" draggable={false} />
                    </button>
                  ))}
                </div>
                <p className="-mt-2 text-[13px] text-[#15130F]/70">{photos.length} photo{photos.length === 1 ? "" : "s"} · swipe to see them all</p>
              </>
            ) : null}
            {askReview !== false ? (
              <div className="rounded-2xl bg-white p-4 ring-1 ring-[#15130F]/10">
                <p className="text-[17px] font-bold leading-snug">Would you show your fence off on Google?</p>
                <p className="mt-1 text-[15px] text-[#15130F]/80">It's how most Houston homeowners find us. Say whatever is true for you.</p>
                <ol className="mt-3 space-y-3">
                  {photos?.length ? (
                    <li className="flex gap-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#15130F] text-[15px] font-bold text-[#E3BE63]">1</span>
                      <button type="button" onClick={() => void savePhotos()} disabled={saving}
                        className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl border-2 border-[#15130F] bg-white text-[16px] font-bold active:scale-[0.98] disabled:opacity-60">
                        {saving ? "Getting your photos…" : saved ? "Photos saved ✓" : "Save your photos"}
                      </button>
                    </li>
                  ) : null}
                  <li className="flex gap-3">
                    {photos?.length ? <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#15130F] text-[15px] font-bold text-[#E3BE63]">2</span> : null}
                    <div className="flex-1">
                      {/* Identical for everyone, by law. Never gated or hidden. */}
                      <a href={REVIEW_URL} target="_blank" rel="noreferrer" onClick={() => { setReview(true); answer("review_clicked", true); }}
                        className="flex h-16 w-full items-center justify-center gap-2 rounded-xl text-[18px] font-bold text-[#15130F] shadow-md active:scale-[0.98]" style={{ background: GOLD }}>
                        <Star className="h-5 w-5 fill-[#15130F]" /> {review ? "Opened Google ✓" : "Write us a Google review"}
                      </a>
                      {photos?.length ? <p className="mt-1.5 text-[14px] text-[#15130F]/75">In Google, tap the camera 📷 to add your photos.</p> : null}
                    </div>
                  </li>
                </ol>
              </div>
            ) : null}
            {told ? (
              <p className="rounded-2xl border border-[#C9972F] bg-[#FFF7E6] p-3.5 text-[15px] font-semibold">Thank you for telling us. Alan will call you today.</p>
            ) : tell ? (
              <div className="rounded-2xl bg-white p-4 ring-1 ring-[#15130F]/10">
                <label className="block text-[15px] font-bold">What's not right?
                  <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} autoFocus className="mt-1 w-full resize-none rounded-xl border border-[#15130F]/15 bg-white px-3 py-2.5 text-[16px] font-normal" />
                </label>
                <button type="button" onClick={() => { setTold(true); setCallback(true); answer("callback_requested", true); if (comment.trim()) answer("comment", comment.trim()); }}
                  className="mt-2 flex h-12 w-full items-center justify-center rounded-xl bg-[#15130F] text-[16px] font-bold text-[#E3BE63]">Send to Alan</button>
              </div>
            ) : (
              <button type="button" onClick={() => setTell(true)} className="min-h-[44px] text-center text-[15px] text-[#15130F]/75 underline underline-offset-2">Something not right? Tell Alan</button>
            )}
          </>
        );
        foot = next("Continue", true);
        break;
      }
      body = (
        <>
          {tick}
          <h2 className="font-heading text-3xl font-bold leading-tight">Paid in full. Thank you, {firstName}.</h2>
          <div className="rounded-2xl bg-white p-4 ring-1 ring-[#15130F]/10">
            <dl className="space-y-2 text-[15px]">
              {paidUpFront ? (
                <Row k={`Paid in full through ${lender || "your card"}, before the job`} v={formatCurrency(total || amount)} />
              ) : (
                <>
                  {total - amount > 0 ? <Row k="Paid before" v={formatCurrency(total - amount)} /> : null}
                  <Row k={`Paid today${lender ? ` through ${lender}` : ""}`} v={formatCurrency(amount)} />
                </>
              )}
              <div className="border-t border-[#15130F]/10 pt-2"><Row k={`${pkgName || "Fence staining"}${feet ? `, ${feet} ft` : ""}${repairs ? ", repairs" : ""}`} v={formatCurrency(total || amount)} bold /></div>
              {page ? null : <Row k="Receipt" v="#SFS-20419" />}
            </dl>
          </div>
        </>
      );
      foot = next("Continue");
      break;
    case "score":
      body = (
        <>
          <h2 className="font-heading text-3xl font-bold leading-tight">How did we do?</h2>
          <p className="text-[16px]">Tap a star: 5 is the best. Then press Send.</p>
          <div className="flex justify-between gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" aria-label={`${n} star${n === 1 ? "" : "s"}`}
                onClick={() => { setStars(n); if (n > 3) setCallback(false); }}
                className="flex h-16 flex-1 items-center justify-center rounded-xl bg-white ring-1 ring-[#15130F]/15 active:scale-95">
                <Star className={cn("h-10 w-10", stars !== null && n <= stars ? "fill-[#C9972F] text-[#C9972F]" : "text-[#15130F]/25")} />
              </button>
            ))}
          </div>
          <p className="min-h-[20px] text-center text-[15px] font-semibold text-[#15130F]/80">
            {stars === null ? "" : ["", "We're sorry.", "We're sorry.", "Thank you for telling us.", "Thank you!", "Thank you so much!"][stars]}
          </p>
          <label className="block text-[14px] font-semibold text-[#15130F]/80">{stars !== null && stars <= 3 ? "What went wrong? (optional)" : "Anything we could do better? (optional)"}
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} onBlur={() => answer("comment", comment.trim())} rows={3} className="mt-1 w-full resize-none rounded-xl border border-[#15130F]/15 bg-white px-3 py-2.5 text-[16px] font-normal text-[#15130F]" />
          </label>
        </>
      );
      // Nothing is saved until Send (Alan, 2026-10-19): a single stray tap on
      // the first star had texted Alan a 1-star "call them" for a happy customer.
      foot = (
        <button type="button" disabled={stars === null}
          onClick={() => { if (stars === null) return; answer("stars", stars); if (comment.trim()) answer("comment", comment.trim()); go(step + 1); }}
          className="flex h-14 w-full items-center justify-center rounded-xl bg-[#15130F] text-[17px] font-bold text-[#E3BE63] active:scale-[0.98] disabled:opacity-40">
          {stars === null ? "Tap a star first" : `Send ${stars} star${stars === 1 ? "" : "s"}`}
        </button>
      );
      break;
    case "sorry":
      body = (
        <>
          <h2 className="font-heading text-3xl font-bold leading-tight">We're sorry, {firstName}.</h2>
          <p className="text-[17px]">Thank you for telling us. I own Sterling, and I'll call you today to hear what happened and make it right.</p>
          <div className="rounded-2xl border border-[#C9972F] bg-[#FFF7E6] p-4">
            <p className="text-[15px] font-semibold">Alan has your message and your number.</p>
            <p className="mt-1 text-[15px] text-[#15130F]/80">Rather talk now? Call or text {PHONE}.</p>
          </div>
          {askReview !== false ? (
            // Still offered to everyone (Google's rules), just not pushed here.
            <a href={REVIEW_URL} target="_blank" rel="noreferrer" onClick={() => { setReview(true); answer("review_clicked", true); }}
              className="mt-2 text-center text-[14px] text-[#15130F]/70 underline underline-offset-2">You can also share your experience on Google</a>
          ) : null}
        </>
      );
      foot = next("Continue");
      break;
    case "referral":
      body = (
        <>
          <h2 className="font-heading text-3xl font-bold leading-tight">Know someone whose fence needs this?</h2>
          {offer("off for them", "to you when their job is done")}
          {shareBlock}
          {/* Or just give us their name and number. */}
          <div className="rounded-2xl bg-white p-4 ring-1 ring-[#15130F]/10">
            <p className="text-[16px] font-bold">Or tell us who, and Alan will text them</p>
            {friendsSent.length ? <p className="mt-1 text-[14px] font-semibold text-emerald-700">✓ Sent: {friendsSent.join(", ")}. Add another?</p> : null}
            <input value={friend.name} onChange={(e) => setFriend({ ...friend, name: e.target.value })} placeholder="Their name" autoComplete="off"
              className="mt-2 h-12 w-full rounded-xl border border-[#15130F]/20 bg-[#F8F3E7] px-3 text-[16px]" />
            <input value={friend.phone} onChange={(e) => setFriend({ ...friend, phone: e.target.value })} placeholder="Their mobile number" inputMode="tel" autoComplete="off"
              className="mt-2 h-12 w-full rounded-xl border border-[#15130F]/20 bg-[#F8F3E7] px-3 text-[16px]" />
            <label className="mt-2 flex items-start gap-2 text-[15px]">
              <input type="checkbox" checked={friend.ok} onChange={(e) => setFriend({ ...friend, ok: e.target.checked })} className="mt-1 h-5 w-5 accent-[#15130F]" />
              <span>They said it's OK for Alan to text them</span>
            </label>
            <button type="button" onClick={() => void sendFriend()} disabled={friendBusy || !friend.name.trim() || !friend.phone.trim() || !friend.ok}
              className="mt-3 flex h-12 w-full items-center justify-center rounded-xl bg-[#15130F] text-[16px] font-bold text-[#E3BE63] disabled:opacity-50">
              {friendBusy ? "Sending…" : "Send them $100 off"}
            </button>
          </div>
        </>
      );
      foot = next("Continue", true);
      break;
    case "review":
      body = (
        <>
          <h2 className="font-heading text-3xl font-bold leading-tight">Would you share your experience on Google?</h2>
          <p className="text-[16px]">It takes about a minute, and it's how most Houston homeowners find us. Say whatever is true for you.</p>
          {/* Identical for every score, by law. Never gated, hidden or reordered. */}
          <a href={REVIEW_URL} target="_blank" rel="noreferrer" onClick={() => { setReview(true); answer("review_clicked", true); }}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-xl text-[17px] font-bold text-[#15130F] shadow-md active:scale-[0.98]" style={{ background: GOLD }}>
            <ExternalLink className="h-5 w-5" /> {review ? "Opened Google ✓" : "Leave a Google review"}
          </a>

        </>
      );
      foot = next("Continue", true);
      break;
    case "next":
      body = (
        <>
          <h2 className="font-heading text-3xl font-bold leading-tight">Anything else we can help with?</h2>
          <p className="text-[15px] text-[#15130F]/75">Tap anything you'd like a quote on.</p>
          <div className="flex flex-wrap gap-2">
            {SERVICES.map((s) => (
              <button key={s} type="button" onClick={() => { const v = { ...services, [s]: !services[s] }; setServices(v); answer("services_interested", SERVICES.filter((x) => v[x]).map((x) => x === "Other" && other.trim() ? `Other: ${other.trim()}` : x)); }}
                className={cn("h-12 rounded-full px-4 text-[15px] font-semibold ring-1 transition", services[s] ? "bg-[#15130F] text-[#E3BE63] ring-[#15130F]" : "bg-white ring-[#15130F]/15")}>{s}</button>
            ))}
          </div>
          {services.Other ? (
            <label className="block text-[14px] font-semibold text-[#15130F]/80">What do you need?
              <input value={other} onChange={(e) => setOther(e.target.value)} onBlur={() => answer("services_interested", SERVICES.filter((x) => services[x]).map((x) => x === "Other" && other.trim() ? `Other: ${other.trim()}` : x))} className="mt-1 h-12 w-full rounded-xl border border-[#15130F]/15 bg-white px-3 text-[16px] font-normal" />
            </label>
          ) : null}
        </>
      );
      foot = next("Finish");
      break;
    case "doneB":
      body = (
        <>
          {tick}
          <h2 className="font-heading text-3xl font-bold leading-tight">Enjoy the fence, {firstName}.</h2>
          {/* No touch-up stain line until leaving a can is a set step on every
              job (Alan, 2026-10-13). */}
          <p className="text-[17px]">Thank you so much for your business. We truly value it, and we're glad we got to take care of your fence.</p>
          {receipt}
          {contact}
          {comment.trim() ? (
            <label className="flex items-start gap-3 rounded-2xl bg-white p-3.5 text-[15px] ring-1 ring-[#15130F]/10">
              <input type="checkbox" checked={feature} onChange={(e) => { setFeature(e.target.checked); answer("feature_permission", e.target.checked); }} className="mt-0.5 h-5 w-5 accent-[#15130F]" />
              <span>OK to feature my comment on our site?</span>
            </label>
          ) : null}
          <p className="text-[14px] text-[#15130F]/75">You can close this page.</p>
        </>
      );
      break;
  }

  return (
    <div className={page ? "min-h-screen bg-[#F8F3E7]" : "fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4"} onClick={page ? undefined : onClose}>
      <div className={cn("relative flex w-full max-w-md flex-col bg-[#F8F3E7] text-[#15130F]", page ? "mx-auto min-h-screen" : "max-h-[94vh] overflow-hidden rounded-t-3xl shadow-2xl sm:rounded-3xl")} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between bg-[#15130F] px-4 py-3">
          <img src="/sterling-logo-dark.png" alt="Sterling Fence Staining" className="h-7 w-auto" draggable={false} />
          <div className="flex items-center gap-2">
            {page ? null : <span className="rounded bg-amber-400/90 px-1.5 py-0.5 text-[12px] font-bold uppercase tracking-wider text-amber-950">Mockup</span>}
            {NO_SKIP.has(screen)
              ? (step === screens.length - 1 && !page ? <button type="button" onClick={onClose} className="inline-flex h-9 items-center gap-1 rounded-lg bg-white/10 px-2.5 text-[13px] font-semibold text-white"><ArrowLeft className="h-3.5 w-3.5" /> Proposal</button> : null)
              : <button type="button" onClick={skip} className="h-9 px-2 text-[15px] font-semibold text-white/85 underline underline-offset-2">Skip</button>}
          </div>
        </div>
        <div className="flex gap-1.5 px-4 pt-3">
          {screens.map((s, i) => <span key={s} className={cn("h-1.5 flex-1 rounded-full", i <= step ? "bg-[#C9972F]" : "bg-[#15130F]/15")} />)}
        </div>
        <div key={screen} className={cn("flex flex-1 flex-col gap-4 px-5 pb-4 pt-5", page ? "" : "overflow-y-auto")}>{body}</div>
        {foot ? <div className="px-5 pb-5 pt-2">{foot}</div> : null}

        {staff && !page ? (
          <div className="border-t border-[#C9972F]/40 bg-[#15130F] text-white">
            <button type="button" onClick={() => setBehind((v) => !v)} className="flex h-10 w-full items-center justify-between px-4 text-[12px] font-bold uppercase tracking-wider text-[#E3BE63]">
              <span>What fires behind this screen · {fires.length}</span><span>{behind ? "Hide" : "Show"}</span>
            </button>
            {behind ? (
              <ul className="max-h-40 space-y-1 overflow-y-auto px-4 pb-3 font-mono text-[12px] text-white/85">
                {fires.map((f) => <li key={f} className="rounded bg-white/5 px-2 py-1">{f}</li>)}
              </ul>
            ) : null}
          </div>
        ) : null}

        {sheet ? (
          <div className="absolute inset-0 z-10 flex items-end bg-black/45" onClick={() => setSheet(false)}>
            <div className="w-full rounded-t-3xl bg-white p-4 text-black" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between text-[15px] font-bold"><button type="button" onClick={() => setSheet(false)} className="font-semibold text-[#1f8bff]">Cancel</button><span>New Message</span><span className="w-12" /></div>
              <p className="mt-2 border-b border-black/10 pb-2 text-[14px] text-black/60">To: a friend from their contacts</p>
              <p className="ml-auto mt-3 max-w-[88%] rounded-2xl rounded-br-md bg-[#1f8bff] px-3.5 py-2.5 text-[15px] text-white">{smsText}</p>
              {page ? (
                <a href={`sms:?&body=${encodeURIComponent(smsText)}`} onClick={() => { setSheet(false); shared("text"); }} className="ml-auto mt-3 flex h-11 items-center rounded-full bg-[#1f8bff] px-5 text-[15px] font-bold text-white">Open Messages</a>
              ) : (
                <button type="button" onClick={() => { setSheet(false); shared("text"); setToast("Text sent (pretend)"); }} className="ml-auto mt-3 flex h-11 items-center rounded-full bg-[#1f8bff] px-5 text-[15px] font-bold text-white">Send</button>
              )}
              <p className="mt-2 text-[12px] text-black/60">{page ? "Your Messages app opens with this written. Pick who to send it to." : "On a real phone this opens Messages with the text already written."}</p>
            </div>
          </div>
        ) : null}
        {big !== null && photos?.[big] ? (
          <div className="absolute inset-0 z-10 flex flex-col bg-black/90" onClick={() => setBig(null)}>
            <p className="px-4 pt-4 text-center text-[15px] text-white/85">Press and hold the photo, then tap Save to Photos</p>
            <img src={photos[big]} alt={`Your fence, photo ${big + 1}`} className="m-auto max-h-[75%] max-w-full object-contain" onClick={(e) => e.stopPropagation()} />
            <div className="flex items-center justify-between px-4 pb-5 text-white" onClick={(e) => e.stopPropagation()}>
              <button type="button" disabled={big === 0} onClick={() => setBig(big - 1)} className="h-12 rounded-xl bg-white/15 px-4 text-[16px] font-bold disabled:opacity-30">Back</button>
              <span className="text-[15px] tabular-nums">{big + 1} of {photos.length}</span>
              {big < photos.length - 1
                ? <button type="button" onClick={() => setBig(big + 1)} className="h-12 rounded-xl bg-white/15 px-4 text-[16px] font-bold">Next</button>
                : <button type="button" onClick={() => setBig(null)} className="h-12 rounded-xl bg-white/15 px-4 text-[16px] font-bold">Close</button>}
            </div>
          </div>
        ) : null}
        {toast ? <p className="absolute inset-x-5 bottom-24 z-20 rounded-xl bg-[#15130F] px-3 py-2.5 text-center text-[14px] text-[#F8F3E7] shadow-lg">{toast}</p> : null}
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
