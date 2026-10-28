// The first mockup of the interactive proposal (2026-10-09, second pass
// 2026-10-10).
//
// A staff-only page under the New Proposal tab. Nothing here is wired to a
// lead, a send, or a payment: every number is a sample and every button
// changes only this page. It exists so Alan can tap through the shape of
// the thing on his phone before anything real is built on the
// proposal-v2 branch (notes: src/content/proposal-v2.md).
//
// Written at a fifth-grade reading level on purpose: pictures first, few
// words, one thing to do per screen (Alan, 2026-10-09).
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { createPortal } from "react-dom";
import { TermsBody } from "@/components/proposal/TermsBody";
import {
  Phone, Check, Shield, Droplets, Sparkles, Paintbrush, Sun, Star, Hammer, Minus, Plus,
  FileText, MapPin, Calendar, UserRound, Leaf, Home, Smartphone, Monitor,
  Users, Lightbulb, ArrowLeft, Eye, MessageSquare, CreditCard, Lock, ChevronDown, Gem, X, ChevronLeft, ChevronRight, Share2, Link2, Wrench,
} from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";
import { PayPageMock } from "@/components/proposal/PayPageMock";
import { api } from "@/lib/api";
import { sidesInWords } from "@/lib/fenceSides";
import { klarnaLine, monthlyFrom, fourPayments } from "@/lib/klarna";
import { AfterPay, type PayFlow, type PayMethod } from "@/components/proposal/AfterPay";
import { BookingInvite } from "@/components/proposal/BookingInvite";
import { Chips, Counter, FencePart, type FencePartKey } from "@/components/proposal/Repairs";
import { PICKETS, PARTS, POSTS } from "@/lib/repairs";

// A real lead to dress the mockup in (Alan, 2026-10-10: "pull in her scope
// of work, her address, the linear foot… pretend she's a mock-up
// customer"). Only the id lives here: the name, address, feet, prices and
// the sent scope drawing are read through the logged-in API, so nothing
// about her ships in this file, and nothing is ever sent to her.
const LIVE_LEAD_ID = "f7fd4ad8-fde8-4f50-a4a2-2bfc0fff2922";

export type Live = {
  name: string; address: string; feet: number; sides: string[];
  tiers: Record<PkgKey, number> | null; scopeUrl: string | null; sentOn: string;
  // The real page only: the proposal number, when the quoted price ends,
  // whether it has, the regular (pre-discount) prices, and whether this job
  // is already reserved (a paid deposit or a financed job).
  number?: string; goodThrough?: string; priceDays?: number; expired?: boolean;
  regular?: Record<PkgKey, number> | null;
  reserved?: { kind: string; tier: PkgKey | ""; afterUrl: string; optionId?: string } | null;
  // More than one priced choice on one proposal (Alan, 2026-10-13). Each
  // carries its own frozen prices, feet, sides and drawing.
  options?: LiveOption[];
};

export type LiveOption = {
  id: string; label: string; note: string; feet: number; sides: string[];
  tiers: Record<PkgKey, number> | null; regular: Record<PkgKey, number> | null; scopeUrl: string | null;
};

export type PkgKey = "essential" | "signature" | "legacy";

/** The real Google reviews, from /api/public/reviews: five-star with
 *  words, newest first. The counts come along but the page no longer
 *  prints them (Alan, 2026-10-12: "remove the number of reviews"). Null
 *  until fetched; sample cards show until then and when there are none. */
type Reviews = { rating: number | null; total: number; five_star: number; reviews: { id: string; author: string; photo: string; rating: number; text: string; when: string; photos?: string[] }[] };
import { API_BASE } from "@/lib/apiBase";

function Avatar({ name, photo }: { name: string; photo: string }) {
  const [broken, setBroken] = useState(false);
  const initial = (name.trim()[0] || "G").toUpperCase();
  return photo && !broken
    ? <img src={photo} alt="" onError={() => setBroken(true)} className="h-8 w-8 shrink-0 rounded-full object-cover" draggable={false} />
    : <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[15px] font-bold text-[#15130F]" style={{ background: GOLD }}>{initial}</span>;
}

/** The grid shows a small copy of each photo; the pop-up gets the big one.
 *  Google's image URLs take a size suffix. */
const thumb = (src: string) => src.replace(/=(w\d+-h\d+(-p)?|s\d+)-k-no$/, "=w480-h360-p-k-no");

/** A customer's photo in a pop-up over the page: not the whole screen,
 *  a big X and a Close button, and a tap outside closes it too (Alan,
 *  2026-10-12: "really easy to get in and out"). Rendered on the body so
 *  nothing around the card can clip or shift it. */
function PhotoModal({ photos, index, onClose, onIndex }: { photos: string[]; index: number; onClose: () => void; onIndex: (i: number) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight" && index < photos.length - 1) onIndex(index + 1);
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [index, photos.length, onClose, onIndex]);
  const many = photos.length > 1;
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Customer photo" onClick={(e) => { e.stopPropagation(); onClose(); }}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[#15130F]/80 p-4">
      <div onClick={(e) => e.stopPropagation()} className="relative w-full max-w-[560px] overflow-hidden rounded-2xl bg-[#F8F3E7] shadow-2xl ring-1 ring-white/20">
        <img src={photos[index]} alt="" className="block max-h-[65vh] w-full bg-[#15130F] object-contain" draggable={false} />
        <button type="button" onClick={onClose} aria-label="Close"
          className="absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-full bg-white text-[#15130F] shadow-lg ring-1 ring-[#15130F]/15">
          <X className="h-6 w-6" />
        </button>
        <div className="flex items-center gap-2 px-3 py-2">
          {many ? (
            <>
              <button type="button" onClick={() => onIndex(index - 1)} disabled={index === 0} aria-label="Previous photo"
                className="flex h-11 w-11 items-center justify-center rounded-full bg-white ring-1 ring-[#15130F]/15 disabled:opacity-30">
                <ChevronLeft className="h-6 w-6" />
              </button>
              <span className="text-[15px] font-semibold tabular-nums">{index + 1} of {photos.length}</span>
              <button type="button" onClick={() => onIndex(index + 1)} disabled={index === photos.length - 1} aria-label="Next photo"
                className="flex h-11 w-11 items-center justify-center rounded-full bg-white ring-1 ring-[#15130F]/15 disabled:opacity-30">
                <ChevronRight className="h-6 w-6" />
              </button>
            </>
          ) : <span className="text-[15px] text-[#15130F]/75">Their fence, their photo.</span>}
          <button type="button" onClick={onClose} className="ml-auto flex h-11 items-center rounded-full bg-[#15130F] px-5 text-[15px] font-bold text-[#E3BE63]">Close</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** "14606 wynbourn waw" → "14606 Wynbourn Waw": an address typed all in
 *  lower case gets capitals; one with any capitals is left as typed. A
 *  two-letter state stays upper case. */
function tidyAddress(a: string): string {
  if (!a || a !== a.toLowerCase()) return a;
  return a.replace(/\b([a-z])([a-z]*)/g, (_, f: string, r: string) => f.toUpperCase() + r)
    .replace(/\b(Tx|Ca|Fl|Ny)\b/g, (m) => m.toUpperCase());
}

/** "Let me talk to my wife" is the most common stall: wife or husband is
 *  72% of every "talk to my ___" in 3,239 calls and 8,157 texts (counted
 *  2026-10-13). So the page hands them the words and the link. A text
 *  opens Messages with it written; Share opens the phone's own share
 *  sheet; Copy is for anything else. iPhone wants "sms:&body=", Android
 *  and Samsung want "sms:?body="; one form on the wrong phone opens an
 *  empty text. */
const SHARE_TEXT = "Sterling Fence Staining sent over a proposal to stain and restore our fence. Take a look and tell me which one you'd pick! Our fence is about to look brand new 😄";

function isApplePhone(): boolean {
  const ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
}

function smsHref(body: string): string {
  return `sms:${isApplePhone() ? "&" : "?"}body=${encodeURIComponent(body)}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older phones and in-app browsers: the textarea trick still works.
    try {
      const t = document.createElement("textarea");
      t.value = text;
      t.setAttribute("readonly", "");
      t.style.position = "fixed";
      t.style.opacity = "0";
      document.body.appendChild(t);
      t.select();
      t.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      document.body.removeChild(t);
      return ok;
    } catch {
      return false;
    }
  }
}

function ShareCard({ onShared }: { onShared?: (how: ShareHow) => void }) {
  const url = typeof window !== "undefined" ? window.location.href.split("#")[0] : "";
  const [copied, setCopied] = useState<null | "ok" | "fail">(null);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const share = async () => {
    try {
      await navigator.share({ title: "Our fence proposal", text: SHARE_TEXT, url });
      onShared?.("share");
    } catch { /* closed the sheet */ }
  };
  const copy = async () => {
    const ok = await copyText(url);
    setCopied(ok ? "ok" : "fail");
    if (ok) onShared?.("copy");
    window.setTimeout(() => setCopied(null), 4000);
  };
  return (
    <div>
      <p className="text-center text-[16px] font-semibold text-[#15130F]/80">Send this to someone</p>
      <div className={cn("mt-2 grid gap-2", canShare ? "grid-cols-3" : "grid-cols-2")}>
        <a href={smsHref(`${SHARE_TEXT}\n${url}`)} onClick={() => onShared?.("text")}
          className="flex h-12 items-center justify-center gap-1.5 rounded-xl bg-white text-[15px] font-semibold text-[#15130F] ring-1 ring-[#15130F]/20 active:scale-[0.98]">
          <MessageSquare className="h-5 w-5" /> Text it
        </a>
        {canShare ? (
          <button type="button" onClick={() => void share()}
            className="flex h-12 items-center justify-center gap-1.5 rounded-xl bg-white text-[15px] font-semibold ring-1 ring-[#15130F]/20 active:scale-[0.98]">
            <Share2 className="h-5 w-5" /> Share
          </button>
        ) : null}
        <button type="button" onClick={() => void copy()}
          className="flex h-12 items-center justify-center gap-1.5 rounded-xl bg-white text-[15px] font-semibold ring-1 ring-[#15130F]/20 active:scale-[0.98]">
          {copied === "ok" ? <><Check className="h-5 w-5" /> Copied</> : <><Link2 className="h-5 w-5" /> Copy link</>}
        </button>
      </div>
      {copied === "ok" ? <p className="mt-2 text-center text-[15px] text-[#15130F]/80">Link copied. Paste it anywhere.</p> : null}
      {copied === "fail" ? <p className="mt-2 break-all text-center text-[15px] text-[#15130F]/80">Press and hold to copy: {url}</p> : null}
    </div>
  );
}

/** One review card. Long ones are clamped and open on a tap: the page is
 *  read on a phone, and one wall of text would hide the others. */
function ReviewCard({ author, photo, text, when, photos, phone }: { author: string; photo: string; text: string; when: string; photos?: string[]; phone: boolean }) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<number | null>(null);
  const long = text.length > 220;
  const pics = (photos || []).slice(0, 3);
  return (
    <blockquote onClick={() => long && setOpen((v) => !v)} className={cn("rounded-2xl bg-[#F8F3E7] p-3 ring-1 ring-[#15130F]/10", phone && "w-[82%] shrink-0 snap-start", long && "cursor-pointer")}>
      <div className="flex items-center gap-2">
        <Avatar name={author} photo={photo} />
        <div className="min-w-0">
          <p className="truncate text-[15px] font-bold leading-tight">{author}</p>
          <p className="text-[13px] text-[#15130F]/75">{when}</p>
        </div>
      </div>
      <p className="mt-1.5 flex gap-0.5">{[0, 1, 2, 3, 4].map((n) => <Star key={n} className="h-3.5 w-3.5 fill-current" style={{ color: GOLD }} />)}</p>
      <p className={cn("mt-1.5 whitespace-pre-line text-[15px] leading-relaxed", long && !open && "line-clamp-6")}>{text}</p>
      {long ? <p className="mt-1 py-2 text-[15px] font-bold text-[#8C6224]">{open ? "Less" : "Read more"}</p> : null}
      {/* The photos they attached: their own fence, their own yard. */}
      {pics.length ? (
        <div className={cn("mt-2 grid gap-1.5", pics.length === 1 ? "grid-cols-1" : pics.length === 2 ? "grid-cols-2" : "grid-cols-3")}>
          {pics.map((src, i) => (
            <button key={src} type="button" onClick={(e) => { e.stopPropagation(); setShown(i); }} aria-label="See the photo bigger"
              className="block w-full overflow-hidden rounded-lg ring-1 ring-[#15130F]/10">
              <img src={thumb(src)} alt="" loading="lazy" className={cn("w-full object-cover", pics.length === 1 ? "aspect-[4/3]" : "aspect-square")} draggable={false} />
            </button>
          ))}
        </div>
      ) : null}
      {shown !== null ? <PhotoModal photos={pics} index={shown} onClose={() => setShown(null)} onIndex={setShown} /> : null}
    </blockquote>
  );
}

/** The two doors on the real page. Each returns the pay page to send the
 *  customer to; the mockup's fake checkout is used when these are absent. */
export type ShareHow = "text" | "share" | "copy";
export type Doors = { reserve: (tier: PkgKey, optionId?: string) => Promise<string>; finance: (tier: PkgKey, optionId?: string) => Promise<string>; shared?: (how: ShareHow) => void };

// ── Sample data ────────────────────────────────────────────────────────
// A made-up customer. Never a real one: this page ships inside the
// dashboard bundle.
const CUSTOMER = {
  name: "Jordan Miller",
  address: "12345 Cypress Creek Dr, Cypress, TX 77429",
  date: "October 10, 2026",
  number: "SF-2026-05481",
  goodThrough: "November 9",
  priceDays: 30,
  sides: ["Inside facing sides", "Outside facing: front"],
  feet: 280,
};

const PACKAGES: {
  key: PkgKey; name: string; short: string; tag: string; lasts: string; photos: string[]; captions?: string[];
  best: string; lines: { icon: React.ElementType; text: string }[]; regular: number; price: number; popular?: boolean;
}[] = [
  {
    key: "essential", name: "Essential Seal", short: "Essential", tag: "Clear, no color", lasts: "1–2 yrs",
    // The PDF's own photos, pulled out of the file: the clear pine fence
    // for Essential, the lighter and darker cedar pair for Signature, the
    // orange and dark brown pair for Legacy that Alan sent on 2026-10-10,
    // split down the middle so the two stack like Signature's.
    photos: ["/proposal-mockup/pkg-essential.jpg"],
    best: "Newer fences in good shape",
    // The printed proposal's own lines (Alan, 2026-10-28).
    lines: [
      { icon: Sparkles, text: "Refresh for newer fences without adding color" },
      { icon: Droplets, text: "Slows early moisture damage" },
    ],
    regular: 1579.50, price: 1263.60,
  },
  {
    key: "signature", name: "Signature Finish", short: "Signature", tag: "Semi-transparent", lasts: "3–4 yrs",
    photos: ["/proposal-mockup/pkg-signature-a.jpg", "/proposal-mockup/pkg-signature-b.jpg"], popular: true,
    best: "Weathered fences you still want to see the grain on",
    lines: [
      { icon: Leaf, text: "Natural finish showing the wood grains" },
      { icon: Shield, text: "Protects against sun, moisture & aging" },
    ],
    regular: 1813.50, price: 1450.80,
  },
  {
    key: "legacy", name: "Legacy Finish", short: "Legacy", tag: "Solid color", lasts: "4–7 yrs",
    // The orange is extended with its own panels at the real post spacing
    // (the next posts fall off the edge); the dark one's boards continue
    // along the slope of its rail. The ?v= changes whenever the files do,
    // so a phone that cached an earlier cut loads the new one.
    photos: ["/proposal-mockup/pkg-legacy-wide-a.jpg?v=3", "/proposal-mockup/pkg-legacy-wide-b.jpg?v=3"],
    best: "Older fences that need full coverage",
    // "Solid color" is already the tag, so the first line is the bold finish.
    lines: [
      { icon: Paintbrush, text: "Bold finish" },
      { icon: Sparkles, text: "Hides imperfections & aging" },
      { icon: Sun, text: "Maximum sun protection (Texas-grade)" },
    ],
    regular: 2301.00, price: 1840.80,
  },
];

// The three tiers wear three different coats, the way the printed proposal
// does: Essential on light clear wood, Signature in gold, Legacy in black
// inside a gold frame. Same rows, same sizes on all three so the names and
// prices still line up; the colours and the badge are what tell them apart
// (Alan, 2026-10-11: "the legacy needs to seem really premium, the signature
// very popular, the essential the very minimum you'd at least get").
const SKINS: Record<PkgKey, {
  badge: string; icon: "leaf" | "star" | "gem";
  card: React.CSSProperties; ring: string; onRing: string; frame?: boolean;
  name: string; text: string; muted: string; price: string; rule: string; accent: string;
  badgeStyle: React.CSSProperties; priceBox: React.CSSProperties; offChip: React.CSSProperties;
}> = {
  essential: {
    badge: "Entry", icon: "leaf",
    card: { background: "linear-gradient(180deg, #FBF6EA 0%, #EDE1C7 100%)" },
    ring: "ring-[#C9B38A]/80", onRing: "ring-[#C9972F] shadow-[#C9972F]/40",
    name: "#2F5137", text: "#15130F", muted: "#5B5243", price: "#2F5137", rule: "#C9B38A", accent: "#2F5137",
    badgeStyle: { background: "#E6EEE2", color: "#2F5137", boxShadow: "inset 0 0 0 1px #9DB59A" },
    priceBox: { background: "#FFFDF8", boxShadow: "inset 0 0 0 1px #C9B38A", color: "#15130F" },
    offChip: { background: "#2F5137", color: "#FFFFFF" },
  },
  signature: {
    badge: "Most popular", icon: "star",
    card: { background: "linear-gradient(165deg, #F3DC8F 0%, #D9AF48 45%, #B9872C 100%)" },
    ring: "ring-[#8C6224]/50", onRing: "ring-[#15130F] shadow-[#C9972F]/50",
    name: "#3B2A12", text: "#2A1E0E", muted: "#5A4120", price: "#3B2A12", rule: "#8C6224", accent: "#8C6224",
    badgeStyle: { background: "#4A3415", color: "#F3DC8F" },
    priceBox: { background: "#FFF8E6", boxShadow: "inset 0 0 0 1px #B9872C", color: "#2A1E0E" },
    offChip: { background: "#4A3415", color: "#F3DC8F" },
  },
  legacy: {
    badge: "Premium", icon: "gem", frame: true,
    card: { background: "linear-gradient(180deg, #1E1B16 0%, #0B0A08 100%)" },
    ring: "ring-[#C9972F]/60", onRing: "ring-[#C9972F] shadow-[#C9972F]/50",
    name: "#E3BE63", text: "#FFFFFF", muted: "rgba(255,255,255,.82)", price: "#E3BE63", rule: "#C9972F", accent: "#8C6224",
    badgeStyle: { background: "linear-gradient(90deg, #F3DC8F, #C9972F)", color: "#15130F" },
    priceBox: { background: "#15130F", boxShadow: "inset 0 0 0 1px #C9972F", color: "#FFFFFF" },
    offChip: { background: "#E3BE63", color: "#15130F" },
  },
};

// The phone's compare table (mock, 2026-10-28): the three packages as the
// column heads — photo, name, price, Pick — and the details as short rows
// under them that line up, the way a pricing table reads on a phone, instead
// of three sentences wrapping inside three narrow columns. The laptop cards
// keep Alan's full lines.
const COMPARE_ROWS: { label: string; cells: Record<PkgKey, string> }[] = [
  { label: "How long it lasts", cells: { essential: "1–2 years", signature: "3–4 years", legacy: "4–7 years" } },
  { label: "The look", cells: { essential: "Clear, no color", signature: "See the wood grain", legacy: "Solid, bold color" } },
  { label: "Protects against", cells: { essential: "Early moisture damage", signature: "Sun, moisture & aging", legacy: "Maximum sun, Texas-grade" } },
  { label: "Hides imperfections & aging", cells: { essential: "—", signature: "—", legacy: "Yes" } },
  { label: "Best for", cells: { essential: "Newer fences", signature: "Most fences", legacy: "Older, weathered fences" } },
];

/** The tier's badge: Entry, Most popular, Premium. On a small tile the
 *  middle one shortens to "Popular" so it fits. */
function TierBadge({ pkg, small, className }: { pkg: PkgKey; small?: boolean; className?: string }) {
  const s = SKINS[pkg];
  const Icon = s.icon === "leaf" ? Leaf : s.icon === "star" ? Star : Gem;
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full font-bold uppercase tracking-wider shadow", small ? "px-1.5 py-0.5 text-[12px]" : "px-2.5 py-1 text-[12px]", className)} style={s.badgeStyle}>
      <Icon className={cn(small ? "h-2.5 w-2.5" : "h-3 w-3", s.icon === "star" && "fill-current")} />
      {small && pkg === "signature" ? "Popular" : s.badge}
    </span>
  );
}

/** The thin gold line inside the Legacy card's edge, the printed proposal's
 *  double frame. Sits above the photos, catches no taps. */
function GoldFrame({ inset = 3 }: { inset?: number }) {
  return <span className="pointer-events-none absolute z-10 rounded-[13px] ring-1 ring-[#C9972F]/75" style={{ inset }} />;
}

// Repairs, priced from Alan's list (2026-10-09; posts by fence height,
// 2026-10-10). Pickets are just pine or cedar, one price each: the height
// "adds too much variability" and confused people (Alan, 2026-10-11).
// Signature colours with a real job photo (cropped from Alan's page in
// progress). The rest of the chart arrives through the photo library.
const SIGNATURE_PHOTOS = [
  { name: "Redwood Naturaltone", src: "/proposal-mockup/stain-redwood-naturaltone.jpg" },
  { name: "Cedar Naturaltone", src: "/proposal-mockup/stain-cedar-naturaltone.jpg" },
  // Also a Legacy solid; the note here is the semi-transparent one (Alan, 2026-10-22).
  { name: "Simply Cedar", src: "/proposal-mockup/stain-simply-cedar.jpg", note: "Classic cedar orange-brown with the grain showing through. The colour most people picture when they say \"stained fence\"." },
  { name: "Pecan", src: "/proposal-mockup/stain-pecan.jpg" },
  { name: "Redwood", src: "/proposal-mockup/stain-redwood.jpg" },
  { name: "Cottage Gray", src: "/proposal-mockup/stain-cottage-gray.jpg" },
  { name: "Monticello Tan", src: "/proposal-mockup/stain-monticello-tan.jpg" },
  // Alan's photo of a gate run (2026-10-22) in place of the first one.
  { name: "Dark Walnut", src: "/proposal-mockup/stain-dark-walnut.jpg", full: "/proposal-mockup/stain-dark-walnut-full.jpg" },
  { name: "Chocolate Chips", src: "/proposal-mockup/stain-chocolate-chips.jpg" },
];
// Legacy solid colours: the best photo of each from the dashboard's Fence
// Photos (Valspar solid line), one per colour, as Alan picked the rule
// (2026-10-10). Served straight from the photo storage. Cedar Naturaltone
// and Midnight Gray have no photo yet.
const LEGACY_PHOTOS: { name: string; src: string; full: string }[] = [
  // Alan's photo (2026-10-25) in place of the library one.
  { name: "Simply Cedar", src: "/proposal-mockup/legacy-simply-cedar.jpg", full: "/proposal-mockup/legacy-simply-cedar-full.jpg" },
  { name: "Pine Bark", src: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/35fd7c95-2407-4bb8-ab12-c530ce523f02/cf591159-dadc-4bf8-bfce-e96984b906e8_thumb.jpg", full: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/35fd7c95-2407-4bb8-ab12-c530ce523f02/cf591159-dadc-4bf8-bfce-e96984b906e8.jpg" },
  { name: "October Brown", src: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/bb52bae5-9222-42b1-bd6a-2aa01cf4e22a/8231b4c2-0f42-459a-b568-631b81d2e1b4_thumb.jpg", full: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/bb52bae5-9222-42b1-bd6a-2aa01cf4e22a/8231b4c2-0f42-459a-b568-631b81d2e1b4.jpg" },
  // Alan's cleaner photo (2026-10-22) in place of the library one.
  { name: "Potato Skin", src: "/proposal-mockup/legacy-potato-skin.jpg", full: "/proposal-mockup/legacy-potato-skin-full.jpg" },
  { name: "Chocolate Chip", src: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/ad73d243-da98-4448-8158-646f436f0070/3a3a2501-207a-4c97-be2e-1fda6dba0bc3_thumb.jpg", full: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/ad73d243-da98-4448-8158-646f436f0070/3a3a2501-207a-4c97-be2e-1fda6dba0bc3.jpg" },
  // Alan's photo (2026-10-25) in place of the library one.
  { name: "Classic Mahogany", src: "/proposal-mockup/legacy-classic-mahogany.jpg", full: "/proposal-mockup/legacy-classic-mahogany-full.jpg" },
  // Alan's cleaner photo (2026-10-22) in place of the library one.
  { name: "Plymouth Red", src: "/proposal-mockup/legacy-plymouth-red.jpg", full: "/proposal-mockup/legacy-plymouth-red-full.jpg" },
  { name: "Galapagos Grey", src: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/573f331f-c1b8-4aa5-b301-c6ca83300c8f/bcc20eac-8ae7-418f-a333-da5613a3e06d_thumb.jpg", full: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/573f331f-c1b8-4aa5-b301-c6ca83300c8f/bcc20eac-8ae7-418f-a333-da5613a3e06d.jpg" },
  { name: "Silver Mine", src: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/0ad80f7d-f86e-4ace-9f18-466daf8efbe6/cf7043e7-45cc-4b04-8538-1aada511ca11_thumb.jpg", full: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/0ad80f7d-f86e-4ace-9f18-466daf8efbe6/cf7043e7-45cc-4b04-8538-1aada511ca11.jpg" },
  { name: "Darkest Night", src: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/3fdbff10-04d9-44a1-b878-f51f3e0ae197/49241180-35a4-48f5-91a9-52fa7c664ab9_thumb.jpg", full: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/3fdbff10-04d9-44a1-b878-f51f3e0ae197/49241180-35a4-48f5-91a9-52fa7c664ab9.jpg" },
];
const LEGACY_NO_PHOTO = ["Cedar Naturaltone", "Midnight Gray"];

// Affirm is archived: Stripe doesn't support it for this business, so
// Klarna is the only pay-over-time door (Alan, 2026-10-13). Flip this to
// bring the Affirm row, help screen and checkout option back.
const AFFIRM_ON = false;

// Affirm, the other door at checkout, in the same plain words. Numbers are
// Affirm's own published US terms; the real page links to affirm.com.
const AFFIRM_FAQ: [string, string][] = [
  ["What is Affirm?", "A way to pay for your fence over time. Smaller amounts can be split into 4 interest-free payments; bigger ones get a monthly plan. Affirm pays us in full; you pay Affirm. Manage it in the Affirm app."],
  ["How do I use it here?", "Tap \"Apply for Klarna\", choose Affirm at checkout, and answer a few questions. You see your plans and the exact rate before you agree to anything."],
  ["What do I need?", "To be 18 or older, a US mobile number, and a US address. Affirm may ask for the last four digits of your Social Security number to check eligibility."],
  ["Does checking affect my credit?", "No. Seeing your options is a soft check with no effect on your credit score. If you take a monthly plan, Affirm may report it to the credit bureaus, which can help or hurt your score depending on how you pay."],
  ["What are the plans?", "4 interest-free payments on smaller amounts, or monthly plans from 3 to 36 months. Rates run from 0% to 36% APR based on your credit, and some plans are 0% APR. A down payment may be required."],
  ["Are there fees?", "No late fees, no prepayment fees, no hidden fees. What you see at checkout is what you pay, and paying early never costs extra."],
  ["What if something changes on the job?", "You paid the whole job through Affirm. If the job ends up costing more, we text you a payment link for the extra when the work is done, and you pay it any way you like: card, Apple Pay, Klarna or Affirm. If it ends up costing less, we refund the difference through Affirm and your loan is adjusted."],
  ["Is this a Sterling loan?", "No. Affirm's lending partners (listed at affirm.com/lenders) are the lenders, and Sterling Fence Staining is paid in full at checkout. Your agreement, statements and privacy are with Affirm."],
];

// The two side by side, so people can read and compare (Alan, 2026-10-10).
const LENDER_COMPARE: [string, string, string][] = [
  ["4 interest-free payments", "Yes, every 2 weeks", "Yes, every 2 weeks"],
  ["Monthly plans", "6 to 24 months, from 7.99% APR", "3 to 36 months, 0% to 36% APR"],
  ["Checking affects credit?", "No (soft check)", "No (soft check)"],
  ["Late fees", "Up to $7 on 4 payments; none on monthly", "None, ever"],
  ["Who lends", "Klarna / WebBank", "Affirm's partner banks"],
];

// A few words on each colour, read when a customer taps one (the
// competitor's page does this well, Alan, 2026-10-10). First draft; Alan
// edits from here.
const COLOR_NOTES: Record<string, string> = {
  "Redwood Naturaltone": "Warm red-brown that lets the grain show through. The classic cedar-fence look.",
  "Cedar Naturaltone": "Honey cedar, light and natural. Brightens a backyard and hides very little.",
  "Pecan": "Golden brown with a touch of red. Rich without going dark.",
  "Redwood": "Deeper and redder than Naturaltone. Bold on a sunny lot.",
  "Cottage Gray": "Soft grey that still shows the wood. Calm and modern, and it hides weathering well.",
  "Monticello Tan": "A quiet taupe. Sits well with brick and stone, and stays cool-looking in the sun.",
  "Dark Walnut": "Deep brown, close to black in the shade. Dramatic, and it hides a lot.",
  "Chocolate Chips": "Dark chocolate brown. Even colour on boards that have seen some weather.",
  "Simply Cedar": "Solid cedar orange-brown. Full coverage that looks like new wood.",
  "Pine Bark": "Medium brown, even and matte. Hides patched and replaced boards.",
  "October Brown": "Dark brown with a hint of grey. Low-key, goes with any house.",
  "Potato Skin": "Earthy red-brown. Warm against a green lawn.",
  "Chocolate Chip": "Rich dark brown. Our most popular solid.",
  "Classic Mahogany": "Deep red-brown with some polish to it. Great against white brick.",
  "Plymouth Red": "Barn red. Stands out, and covers everything underneath.",
  "Galapagos Grey": "Mid grey, modern. Cools down a bright yard.",
  "Silver Mine": "Pale grey, almost driftwood. Light and clean.",
  "Darkest Night": "Near-black. Makes greenery pop; the boldest look we do.",
};

// The questions customers actually text us most, once price, sides, colour,
// paying and the warranty are answered by the page itself (read 2026-10-10
// from every inbound text on file). Answers are drafts for Alan to confirm.
// Alan's answers, 2026-10-12, in plain words.
const FAQ: [string, string][] = [
  ["What about overspray on my neighbor's side, or through the gaps?", "We use spray tips matched to the stain, so overspray is close to zero. We shield the top of the fence when it's needed. We spray straight onto the boards, not into the gaps, so nothing bleeds through to the neighbor's side. And we put tarps down over anything that needs covering."],
  ["How long does it take?", "Two days. Day one we clean the fence, if it needs it. Day two we stain it, which takes most of the day. We text you when we're on the way."],
  ["Will I know the repair price before you start?", "Yes. Anything you count above is priced on this page before you book. If we spot more bad pickets on the day, we mark them and show you, and you say yes or no. We don't do anything without your approval."],
  ["Does my HOA need to approve the color?", "Some do. Tell us your HOA and we'll send the exact stain name and color for approval, or match their approved list. Most of the time it goes like this: the inside of your fence is any color you like, and any outside faces we stain are matched to your neighborhood's HOA color, so it looks consistent from the street."],
];

// The payment line the way PlayStation shows it with Klarna (Alan,
// 2026-10-10): "From $40/month, or 4 payments at 0% interest with Klarna.
// Learn more". Nobody at Sony works out the $40: Klarna's messaging returns
// it from Klarna's real plans for the exact amount, and on the real page
// Stripe's Payment Method Messaging Element does the same for us. Here it
// is estimated the way Klarna does: the lowest rate over the longest plan
// (7.99% APR over 24 months), rounded up to the dollar. Pay in 4 tops out
// around $2,000 a purchase.
function payLine(total: number): { text: string; lender: "klarna" } {
  // PlayStation's exact shape, every time: "From $40/month, or 4 payments
  // at 0% interest with Klarna". Both halves always show (Alan,
  // 2026-10-10); on the real page Stripe's messaging element decides what
  // the customer qualifies for at that amount.
  return { text: klarnaLine(total), lender: "klarna" };
}

// Klarna's FAQ, rewritten for a fence (PlayStation's is the model, Alan,
// 2026-10-10). Numbers are Klarna's own published US terms; the real page
// links to Klarna's terms for the current ones.
const KLARNA_FAQ: [string, string][] = [
  ["What is Klarna?", "A way to pay for your fence over time. Split it into 4 interest-free payments, or pick a monthly plan. Klarna pays us in full; you pay Klarna. See every payment in the Klarna app."],
  ["How do I use it here?", "Pick your package, tap \"Apply for Klarna\", then pick 4 payments or a monthly plan and enter a debit or credit card. You see your plan before you agree. Your dates get booked the same as paying the deposit."],
  ["What do I need?", "A US-issued debit or credit card, to be 18 or older, a phone that gets texts, and a US home address."],
  ["How do the 4 payments work?", "The first payment comes off your card today at checkout. The other three come off automatically 14, 28 and 42 days later. No interest. Klarna emails you the schedule, and may ask some customers for a larger first payment."],
  ["Is there a fee for 4 payments?", "No fee when you pay on schedule. If a payment doesn't go through, Klarna tries again; if it still fails, a late fee of up to $7 plus the missed amount is added to the next payment."],
  ["Will Klarna check my credit?", "For 4 payments, Klarna may do a soft check. It doesn't affect your credit score and doesn't show as a hard inquiry."],
  ["What are the monthly plans?", "For jobs of $200 and up. Apply at checkout and get an instant decision; applying is a soft check with no effect on your credit. Rates run from 7.99% to 29.99% APR, a down payment may be required, and late payments may be reported to the credit bureaus. No application, late or early-payoff fees. Plans are issued by WebBank, member FDIC."],
  ["What if something changes on the job?", "You paid the whole job through Klarna, so there's no deposit to think about. If the job ends up costing more (say, boards we find rotten on the day), we text you a payment link for the extra when the work is done, and you pay it any way you like: card, Apple Pay or Klarna. If it ends up costing less, we refund the difference through Klarna and Klarna lowers what you owe on its own; allow 8 to 10 business days."],
  ["Is this a Sterling loan?", "No. Klarna is the lender and Sterling Fence Staining is paid in full when you check out. Your agreement, statements and privacy are with Klarna, not with us."],
];

const GOLD = "#C9972F";

// `preview` is the no-login copy at /preview/proposal/<token>: sample
// customer only, no staff bar, no phone frame on a phone, and no call to
// the API (an unauthenticated call would bounce the page to the login).
// `dressed` is the lead the no-login preview page already fetched through
// the public endpoint; with it the page never calls the logged-in API.
/** One button per after-payment screen set, so staff can see and check
 *  exactly what a customer gets. Mockup only: nothing is paid or sent. */
function AfterPayButtons({ open, className }: { open: (v: { flow: PayFlow; method: PayMethod; paidUpFront?: boolean }) => void; className: string }) {
  return (
    <>
      <button type="button" className={className} title="After the $250 deposit: you're on the schedule, what to know before we come"
        onClick={() => open({ flow: "deposit", method: "card" })}>After deposit</button>
      <button type="button" className={className} title="Paid the whole job through Klarna: same 'you're booked' screens, nothing more due to us"
        onClick={() => open({ flow: "full", method: "klarna" })}>After Klarna</button>
      <button type="button" className={className} title="After the final invoice is paid: thank you, how did we do, review, referral, other services"
        onClick={() => open({ flow: "balance", method: "card" })}>After final invoice</button>
      <button type="button" className={className} title="Financed up front, so nothing is owed at the end: the job-done screens come with the receipt"
        onClick={() => open({ flow: "balance", method: "klarna", paidUpFront: true })}>Financed, job done</button>
    </>
  );
}

/** A lead's saved draft options (or, once sent, the frozen ones), each with
 *  its own drawing, for the staff preview. Blob URLs go into `urls` so the
 *  caller can revoke them. */
async function previewOptions(leadId: string, urls: string[]): Promise<LiveOption[] | undefined> {
  try {
    const st = await api.listProposalOptions(leadId);
    const list = st.drafts.length ? st.drafts : st.sent;
    if (list.length < 2) return undefined;
    return await Promise.all(list.map(async (o) => {
      const scopeUrl = o.has_scope ? await api.fetchProposalOptionScopeUrl(leadId, o.id) : null;
      if (scopeUrl) urls.push(scopeUrl);
      const regular = o.tiers ? { essential: Math.round((o.tiers.essential / 0.8) * 100) / 100, signature: Math.round((o.tiers.signature / 0.8) * 100) / 100, legacy: Math.round((o.tiers.legacy / 0.8) * 100) / 100 } : null;
      return { id: o.id, label: o.label, note: o.note, feet: o.feet, sides: sidesInWords(o.sides), tiers: o.tiers, regular, scopeUrl };
    }));
  } catch {
    return undefined;
  }
}

/** `embedded`: inside Design Lab (Alan, 2026-10-27), whose header already
 *  says nothing here is sent and has its own way to the notes, so the staff
 *  bar keeps only the screen buttons and whose estimate it's dressed in. */
export default function ProposalMockup({ preview = false, dressed, doors, staffPeek = false, embedded = false }: { preview?: boolean; dressed?: Live; doors?: Doors; staffPeek?: boolean; embedded?: boolean } = {}) {
  const [base, setLive] = useState<Live | null>(dressed ?? null);
  // Which option she's looking at. A reserved job opens on the option it was
  // reserved under. Everything below reads `live`, which is the proposal
  // with the picked option's prices, feet, sides and drawing laid over it.
  const opts = base?.options && base.options.length > 1 ? base.options : [];
  const [optIdx, setOptIdx] = useState(() => Math.max(0, opts.findIndex((o) => o.id === dressed?.reserved?.optionId)));
  const option = opts[optIdx] ?? null;
  const live = useMemo<Live | null>(() => (base && option ? {
    ...base, feet: option.feet || base.feet, sides: option.sides.length ? option.sides : base.sides,
    tiers: option.tiers, regular: option.regular, scopeUrl: option.scopeUrl,
  } : base), [base, option]);
  // ?lead=<id>: the lead page's "Edit & preview interactive proposal".
  // Dressed in that lead's unsent estimate, its current drawing and its
  // saved options, exactly as the customer would get them on send.
  const [params] = useSearchParams();
  const previewLead = preview ? "" : params.get("lead") || "";
  useEffect(() => {
    if (preview) return;
    let url: string | null = null;
    const optUrls: string[] = [];
    const leadId = previewLead || LIVE_LEAD_ID;
    (async () => {
      try {
        const lead = await api.getLead(leadId);
        const ests = [...(lead.estimates || [])].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
        // Before a send, the newest estimate is what goes out.
        const est = previewLead ? ests[0] : ests.find((e) => e.status === "sent") || ests[0];
        const t = est?.tiers as Record<string, number> | undefined;
        const fd = (lead.form_data || {}) as Record<string, unknown>;
        const rawSides = fd.fence_sides;
        const sides = Array.isArray(rawSides) ? (rawSides as string[]) : rawSides ? String(rawSides).split(",").map((v) => v.trim()) : [];
        let scopeUrl: string | null = null;
        try {
          // The drawing that was texted is the lead's active scope until it
          // is revised; only then does it move into the versions list.
          const { versions, active_sent_at } = await api.getFenceScopeVersions(leadId);
          // A preview shows the lead's current drawing even before it's texted.
          if (active_sent_at || previewLead) {
            url = await api.fetchFenceScopeExportBlobUrl(leadId);
          }
          if (!url) {
            const v = [...versions].filter((x) => x.has_image && x.sent_at)
              .sort((a, b) => (b.sent_at || "").localeCompare(a.sent_at || ""))[0];
            if (v) url = await api.fetchFenceScopeVersionBlobUrl(leadId, v.id);
          }
          scopeUrl = url;
        } catch { /* no drawing: the sides list shows instead */ }
        setLive({
          name: lead.contact_name || "",
          address: lead.address || "",
          feet: Number(fd.linear_feet) || 0,
          sides: sidesInWords(sides),
          tiers: t && t.essential && t.signature && t.legacy ? { essential: t.essential, signature: t.signature, legacy: t.legacy } : null,
          scopeUrl,
          sentOn: est?.sent_at || lead.created_at || "",
          options: previewLead ? await previewOptions(leadId, optUrls) : undefined,
        });
      } catch { /* the sample customer stays */ }
    })();
    return () => { if (url) URL.revokeObjectURL(url); optUrls.forEach((u) => URL.revokeObjectURL(u)); };
  }, [preview, previewLead]);

  const customer = useMemo(() => live ? {
    ...CUSTOMER,
    name: live.name || CUSTOMER.name,
    address: live.address || CUSTOMER.address,
    feet: live.feet || CUSTOMER.feet,
    sides: live.sides,
    date: live.sentOn ? new Date(live.sentOn).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : CUSTOMER.date,
    number: live.number || CUSTOMER.number,
    goodThrough: live.goodThrough ? new Date(live.goodThrough).toLocaleDateString("en-US", { month: "long", day: "numeric" }) : CUSTOMER.goodThrough,
    priceDays: live.priceDays || CUSTOMER.priceDays,
  } : CUSTOMER, [live]);
  // Her prices are the 20%-off prices on her estimate; the regular price is
  // what they were before the discount. Once the quoted price has ended the
  // regular prices are the prices, and nothing is crossed out (the deadline
  // is real, Alan, 2026-10-11).
  const expired = !!live?.expired;
  const discount = !expired;
  const packages = useMemo(() => PACKAGES.map((p) => {
    if (!live?.tiers) return p;
    const regular = live.regular?.[p.key] ?? Math.round((live.tiers[p.key] / 0.8) * 100) / 100;
    return live.expired ? { ...p, price: regular, regular } : { ...p, price: live.tiers[p.key], regular };
  }), [live]);
  const reserved = live?.reserved ?? null;

  // The staff mockup has a Phone/Full toggle. The customer's page follows
  // their real screen: a phone stacks the packages, a laptop or tablet
  // spreads them out like a website (Alan, 2026-10-17: "it can't be so
  // vertical").
  const [phoneToggle, setPhone] = useState(true);
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const on = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const phone = preview ? narrow : phoneToggle;
  const [reviews, setReviews] = useState<Reviews | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/api/public/reviews`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive && d) setReviews(d as Reviews); }).catch(() => { /* the sample cards stay */ });
    return () => { alive = false; };
  }, []);
  const realReviews = reviews && reviews.reviews.length > 0 ? reviews : null;
  const ratingText = realReviews?.rating ? realReviews.rating.toFixed(1) : "5.0";
  // Footage shows on the invite and the after-pay screens only when a
  // drawing backs it up.
  const hasDrawing = preview ? !!dressed?.scopeUrl : true;
  const [pkg, setPkg] = useState<PkgKey | null>(dressed?.reserved?.tier || null);
  const [palette, setPalette] = useState<"signature" | "legacy">("signature");
  // Colours to look at, both sets out, no Signature/Legacy buttons (Alan,
  // 2026-10-28: customers weren't finding the Legacy colours; 33 calls in two
  // weeks walked someone there). Mock first: only the sample page in Design
  // Lab shows it until Alan says go; a real customer's page keeps the tabs.
  const colorsV2 = !live;
  // How the three columns are drawn on the phone (Alan, 2026-10-28: "you
  // could do way better with the design of these packages on mobile… get
  // creative"). Always three next to each other, 1-2-3. Mock first: the
  // sample page opens on the table with the others a tap away; a real
  // customer's page keeps the columns until Alan picks.
  const [phoneLook, setPhoneLook] = useState<"columns" | "table" | "poster">(live ? "columns" : "table");
  const [colorOpen, setColorOpen] = useState<{ name: string; src: string; full?: string; finish: string; note?: string } | null>(null);
  const [picketType, setPicketType] = useState(PICKETS[0].key);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [colorAsk, setColorAsk] = useState("");
  const [colorSent, setColorSent] = useState(false);
  const [terms, setTerms] = useState(false);
  const [faqOpen, setFaqOpen] = useState<number | null>(null);
  // The Stripe Checkout page, as the customer sees it: the deposit, or the
  // whole job with Klarna and Affirm on it (Alan, 2026-10-10).
  const [checkout, setCheckout] = useState<null | PayFlow>(null);
  // The pay page mock: the new look (Stripe's form on our page, Alan
  // 2026-10-22) by default, the old hosted-page mock a tap away to compare.
  const [payLook, setPayLook] = useState<"page" | "stripe">("page");
  // The screens after a payment (Alan's spec, 2026-10-10). "balance" is the
  // link texted after the job; paidUpFront is the financed customer who
  // owes nothing then and only gets the after-the-job screens.
  const [afterPay, setAfterPay] = useState<null | { flow: PayFlow; method: PayMethod; paidUpFront?: boolean }>(null);
  const [payFaq, setPayFaq] = useState<null | "klarna" | "affirm">(null);
  // Our own booking invite in place of the Google Calendar one (Alan,
  // 2026-10-14). The mockup holds the next Thursday.
  const [invite, setInvite] = useState(false);
  const inviteDate = useMemo(() => { const d = new Date(); d.setDate(d.getDate() + (((4 - d.getDay() + 7) % 7) || 7)); return d; }, []);
  const [postType, setPostType] = useState(POSTS[0].key);

  const chosen = packages.find((p) => p.key === pkg) || null;
  const repairs = useMemo(() => {
    const picket = PICKETS.find((p) => p.key === picketType)!;
    const post = POSTS.find((p) => p.key === postType)!;
    let total = (counts.pickets || 0) * picket.price + (counts.posts || 0) * post.price;
    for (const part of PARTS) total += (counts[part.key] || 0) * part.price;
    return total;
  }, [counts, picketType, postType]);
  const total = (chosen?.price || 0) + repairs;
  const pay = payLine(total || packages[1].price);
  const bump = (key: string, by: number) =>
    setCounts((c) => ({ ...c, [key]: Math.max(0, (c[key] || 0) + by) }));

  const choose = (key: PkgKey) => {
    setPkg(key);
    if (key !== "essential") setPalette(key);
  };

  // The two doors. On the real page they make the pay link for the package
  // picked and send the customer to it; the mockup opens its fake checkout.
  const [doorBusy, setDoorBusy] = useState<null | "reserve" | "finance">(null);
  const [doorError, setDoorError] = useState("");
  // No package yet: ask which one, then carry on (Alan, 2026-10-14: "if we
  // don't know what package you want, we can't send you the link").
  const [askPick, setAskPick] = useState<null | "reserve" | "finance" | "pick">(null);
  // "You haven't picked a package yet" waits until they've scrolled past the
  // packages (Alan, 2026-10-14: on opening it's too soon, they haven't
  // seen them). Once past, it stays.
  const [pastPackages, setPastPackages] = useState(false);
  useEffect(() => {
    if (pastPackages) return;
    const check = () => {
      const el = document.getElementById("mock-packages");
      if (el && el.getBoundingClientRect().bottom < window.innerHeight * 0.35) setPastPackages(true);
    };
    window.addEventListener("scroll", check, { passive: true, capture: true });
    return () => window.removeEventListener("scroll", check, { capture: true });
  }, [pastPackages]);
  const openDoor = async (which: "reserve" | "finance", key?: PkgKey) => {
    if (reserved?.afterUrl) { window.location.assign(reserved.afterUrl); return; }
    const pickKey = key || chosen?.key;
    if (!pickKey) { setAskPick(which); return; }
    if (!doors) { setCheckout(which === "reserve" ? "deposit" : "full"); return; }
    if (doorBusy) return;
    setDoorBusy(which);
    setDoorError("");
    try {
      window.location.assign(await doors[which](pickKey, option?.id));
    } catch (e) {
      setDoorError(e instanceof Error ? e.message : "Couldn't open the payment page. Call or text us.");
      setDoorBusy(null);
    }
  };

  return (
    <div className={cn("min-h-full pb-10", preview ? "bg-[#F8F3E7] sm:bg-stone-200/70" : "bg-stone-200/70")}>
      <style>{SHINE_CSS}</style>
      {/* Staff bar. Never part of the customer's page. */}
      {preview ? null : <div className="sticky top-0 z-30 flex flex-wrap items-center gap-2 bg-ink px-3 py-2 text-ivory shadow-md">
        {previewLead ? (
          // Big on purpose (Alan, 2026-10-14): the way back to the send has to be obvious.
          <Link to={`/leads/${previewLead}`} className="inline-flex h-12 items-center gap-2 rounded-xl px-5 text-base font-bold text-[#15130F] shadow-lg" style={{ background: GOLD }}>
            <ArrowLeft className="h-5 w-5" /> Back to the lead
          </Link>
        ) : embedded ? null : (
          <Link to="/new-proposal" className="inline-flex items-center gap-1 rounded-lg bg-white/10 px-2 py-1 text-xs font-semibold hover:bg-white/20">
            <ArrowLeft className="h-3.5 w-3.5" /> Notes
          </Link>
        )}
        {embedded && !previewLead ? null : (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-500/20 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-rose-200 ring-1 ring-rose-400/40">
            <Lightbulb className="h-3 w-3" /> {previewLead ? "Preview · what they get when you send · nothing is sent" : "Mockup · nothing here is sent to anyone"}
          </span>
        )}
        <span className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-ivory/80">
          {live ? `Dressed in ${live.name}'s real estimate` : "Sample customer"}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={() => setPhone((v) => !v)} title="Phone or full width"
            className="inline-flex items-center gap-1 rounded-lg bg-white/10 px-2 py-1 text-[11px] font-semibold hover:bg-white/20">
            {phone ? <Smartphone className="h-3.5 w-3.5" /> : <Monitor className="h-3.5 w-3.5" />}
            {phone ? "Phone" : "Full"}
          </button>
          <button type="button" onClick={() => setInvite(true)} title="Our own calendar invite: date held until the $250 deposit, then confirmed by itself"
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold text-[#15130F] hover:opacity-90" style={{ background: GOLD }}>
            <Calendar className="h-3.5 w-3.5" /> Booking invite
          </button>
          <button type="button" onClick={() => { setPayLook("page"); setCheckout("deposit"); }} title="The new pay page: Stripe's form on our own page, in Sterling's colours"
            className="rounded-lg bg-white/10 px-2 py-1 text-[11px] font-semibold hover:bg-white/20">Pay page</button>
          <span className="ml-1 text-[11px] text-ivory/60">After the job:</span>
          <button type="button" onClick={() => setCheckout("balance")} title="The text with the balance link, after the crew marks the job done"
            className="rounded-lg bg-white/10 px-2 py-1 text-[11px] font-semibold hover:bg-white/20">Balance link</button>
          <AfterPayButtons open={setAfterPay} className="rounded-lg bg-white/10 px-2 py-1 text-[11px] font-semibold hover:bg-white/20" />
        </div>
      </div>}

      {preview && staffPeek ? (
        <div className="sticky top-0 z-30 flex flex-wrap items-center gap-1.5 bg-[#15130F] px-3 py-2 text-white shadow-md">
          <span className="text-[12px] font-bold uppercase tracking-wide text-[#E3BE63]">Staff view</span>
          <span className="text-[12px] text-white/70">See what {dressed?.name?.split(" ")[0] || "they"} get after paying:</span>
          <AfterPayButtons open={setAfterPay} className="rounded-lg bg-white/10 px-2.5 py-1.5 text-[12px] font-semibold hover:bg-white/20" />
        </div>
      ) : null}

      {previewLead ? (
        <Link to={`/leads/${previewLead}`} className="fixed bottom-24 left-4 z-40 inline-flex h-14 items-center gap-2 rounded-full px-6 text-base font-bold text-[#15130F] shadow-2xl ring-4 ring-black/20" style={{ background: GOLD }}>
          <ArrowLeft className="h-5 w-5" /> Back to the lead
        </Link>
      ) : null}

      {/* The customer's page. Explicit colours so the dashboard's dark mode
          can never change it. On the preview link a real phone gets the page
          edge to edge; the drawn phone frame only shows on a bigger screen. */}
      <div className={cn("mx-auto bg-[#F8F3E7] text-[#15130F]",
        preview
          // A phone gets it edge to edge; a bigger screen gets a wide page
          // with room to breathe, not a drawn phone (Alan, 2026-10-17).
          ? (phone ? "max-w-[430px]" : "mt-4 max-w-3xl overflow-hidden rounded-2xl shadow-2xl shadow-black/30")
          : cn("mt-4 overflow-hidden shadow-2xl shadow-black/30", phone ? "max-w-[430px] rounded-[2rem] ring-8 ring-stone-800" : "max-w-3xl rounded-2xl"))}>
        {/* Top bar */}
        <div className="flex items-center justify-between gap-3 bg-[#15130F] px-4 py-3">
          <img src="/sterling-logo-dark.png" alt="Sterling Fence Staining" className="h-8 w-auto" draggable={false} />
          <a href="tel:+13465897877" className="inline-flex h-12 items-center gap-2 rounded-full px-5 text-[16px] font-bold text-[#15130F] shadow-md" style={{ background: GOLD }}>
            <Phone className="h-4 w-4" /> Call or text
          </a>
        </div>

        {/* Cover */}
        <section className="relative">
          <img src="/proposal-mockup/hero-family.jpg" alt="" className="h-60 w-full object-cover" draggable={false} />
          <div className="absolute inset-0 bg-gradient-to-t from-[#15130F] via-[#15130F]/40 to-transparent" />
          <div className="absolute inset-x-0 bottom-0 p-4 text-white">
            <p className="text-[13px] font-bold uppercase tracking-[0.2em]" style={{ color: "#E3BE63" }}>Fence restoration proposal</p>
            <h1 className="font-heading text-3xl font-bold leading-tight">Hi {customer.name.split(" ")[0]}, here's your fence restoration plan.</h1>
          </div>
        </section>
        <section className="grid grid-cols-2 gap-x-3 gap-y-2 border-b border-[#15130F]/10 px-4 py-3 text-sm">
          <Fact icon={UserRound} label="Prepared for">{customer.name}</Fact>
          <Fact icon={Calendar} label="Date">{customer.date}</Fact>
          <Fact icon={MapPin} label="Property" wide>{tidyAddress(customer.address)}</Fact>
          <Fact icon={Eye} wide label={expired ? "Quoted price ended" : `Price good for ${customer.priceDays} days`}>{expired ? customer.goodThrough : `Through ${customer.goodThrough}`}</Fact>
        </section>
        {expired && !reserved ? (
          <section className="flex items-start gap-2.5 bg-[#15130F] px-4 py-3 text-white">
            <Calendar className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "#E3BE63" }} />
            <p className="text-[15px] leading-snug"><span className="font-bold" style={{ color: "#E3BE63" }}>Your quoted price ended {customer.goodThrough}.</span> Our regular pricing is below. Call or text us with any questions.</p>
          </section>
        ) : null}

        {/* More than one option: she flips between them here, and the drawing,
            the feet and every price below follow. */}
        {opts.length > 1 ? (
          <section className="border-b border-[#15130F]/10 bg-[#FBF3DF] px-4 py-4">
            <p className="text-[13px] font-bold uppercase tracking-[0.18em]" style={{ color: "#8C6224" }}>You asked for {opts.length} options</p>
            <p className="mt-0.5 text-[15px] text-[#15130F]/80">Tap one to see what we'd stain and its prices.</p>
            <div className="mt-3 grid gap-2" role="radiogroup" aria-label="Options">
              {opts.map((o, i) => {
                const on = i === optIdx;
                return (
                  <button key={o.id} type="button" role="radio" aria-checked={on} onClick={() => setOptIdx(i)}
                    className={cn("flex min-h-[64px] w-full items-center gap-3 rounded-2xl px-3.5 py-3 text-left transition",
                      on ? "bg-white shadow-md ring-2" : "bg-white/60 ring-1 ring-[#15130F]/15")}
                    style={on ? { boxShadow: `0 0 0 2px ${GOLD}` } : undefined}>
                    <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2", on ? "border-[#15130F] bg-[#15130F]" : "border-[#15130F]/40")}>
                      {on ? <span className="h-2.5 w-2.5 rounded-full" style={{ background: GOLD }} /> : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-bold uppercase tracking-wide text-[#15130F]/60">Option {i + 1}</span>
                      <span className="block text-[17px] font-bold leading-tight">{o.label}</span>
                      {o.note ? <span className="block text-[14px] text-[#15130F]/70">{o.note}</span> : null}
                    </span>
                    {o.tiers ? (
                      <span className="shrink-0 text-right">
                        <span className="block text-[12px] text-[#15130F]/65">from</span>
                        <span className="block font-heading text-xl font-bold tabular-nums">{formatCurrency(live?.expired && o.regular ? o.regular.essential : o.tiers.essential)}</span>
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}

        {/* What's included: the sides, in words. The drawing and the footage
            came off (Alan, 2026-10-17): they already have a photo of their
            own fence, and the drawing made the page feel like work. No
            footage either: a fence we couldn't see is bid on the safe side,
            and a number next to it invites the wrong conversation (Alan,
            2026-10-10). */}
        <section className="px-4 pt-5 pb-1">
          <div className="rounded-2xl bg-white p-4 ring-1 ring-[#15130F]/10">
            <p className="text-[13px] font-bold uppercase tracking-wider text-[#8C6224]">Sides of fence included in the price</p>
            <ul className="mt-1.5 space-y-1.5">
              {customer.sides.map((s) => (
                <li key={s} className="flex items-center gap-2 text-base font-semibold"><Check className="h-4 w-4" style={{ color: GOLD }} /> {s}</li>
              ))}
            </ul>
          </div>
        </section>

        {/* Packages. All three on one screen, no scrolling (Alan,
            2026-10-10). On a phone that is a compare grid: the photos across
            the top, then short rows that line up — lasts, price, best for,
            what you get — and three Pick buttons. At full width, three cards
            that each carry the whole story, the way a pricing page does. */}
        <section id="mock-packages" className="scroll-mt-14 bg-white px-1 py-6 sm:px-4">
          <div className="px-1">
            <SectionTitle kicker="Step 1 of 3" title="Choose 1 of these 3" sub="Higher ones last longer. Cleaning is included with all three." />
          </div>
          {phone && !live ? (
            <div className="mb-3 flex items-center gap-1 rounded-full bg-[#15130F]/5 p-1 text-[13px] font-bold" aria-label="Mock-up: three ways to draw the columns">
              {([["table", "Table"], ["poster", "Poster"], ["columns", "Today"]] as const).map(([k, label]) => (
                <button key={k} type="button" onClick={() => setPhoneLook(k)}
                  className={cn("min-h-9 flex-1 rounded-full px-3", phoneLook === k ? "bg-[#15130F] text-white" : "text-[#15130F]/70")}>{label}</button>
              ))}
            </div>
          ) : null}

          {phone ? (
            // Three columns, side by side, like the printed proposal (Alan,
            // 2026-10-17: "they can't be on top of each other, they need to be
            // next to each other, 1, 2, 3"). Each column carries its whole
            // story — photo, name, what it is, the two benefits, 20% off, the
            // price as the biggest thing, the monthly — so nothing hides
            // behind a tap. The tap only picks. Same rows in the same order
            // on all three so the names and the prices line up.
            phoneLook === "table" ? (
            // The decision up top — photo, name, price, Pick — three across,
            // then the details as rows that line up under the same three
            // columns. Tapping anywhere in a column picks it and the whole
            // column lights up.
            <div>
              <div className="grid grid-cols-3 gap-1">
                {packages.map((p) => {
                  const on = pkg === p.key;
                  const s = SKINS[p.key];
                  return (
                    <button key={p.key} type="button" onClick={() => choose(p.key)} aria-pressed={on}
                      className={cn("relative flex flex-col overflow-hidden rounded-2xl text-left shadow-md transition duration-200 active:scale-[0.98]",
                        on ? cn("ring-4 shadow-xl", s.onRing) : cn(p.popular ? "ring-2" : "ring-1", s.ring))}
                      style={{ ...s.card, color: s.text }}>
                      {s.frame ? <GoldFrame /> : null}
                      <div className="relative h-[84px] w-full" style={{ background: s.rule }}>
                        <img src={p.photos[p.photos.length - 1]} alt="" className="h-full w-full object-cover" draggable={false} />
                        <TierBadge pkg={p.key} small className="absolute left-1 top-1 z-20" />
                      </div>
                      <div className="flex flex-1 flex-col px-1 pb-1.5 pt-1.5">
                        <p className="font-heading text-[24px] font-bold leading-[26px]" style={{ color: s.name }}>{p.short}</p>
                        <p className="mt-0.5 text-[12px] font-bold uppercase leading-[14px] tracking-[0.02em]" style={{ color: s.muted }}>{p.tag}</p>
                        <div className="mt-1.5 rounded-lg px-1 py-1.5 text-center" style={s.priceBox}>
                          {discount ? <p className="text-[12px] leading-[14px] opacity-75"><s>{formatCurrency(p.regular)}</s></p> : <p className="text-[12px] leading-[14px] opacity-75">Regular price</p>}
                          <p className="mt-0.5 font-heading text-[26px] font-bold leading-none tabular-nums" style={{ color: s.price }}>{formatCurrency(p.price)}</p>
                          {discount ? <span className="mt-1 inline-block rounded px-1.5 py-px text-[11px] font-bold uppercase" style={s.offChip}>20% off</span> : null}
                          <p className="mt-1 text-[12px] font-semibold leading-[14px] opacity-85">4 × {formatCurrency(fourPayments(p.price))}</p>
                        </div>
                        <p className="mt-1.5 flex min-h-[40px] items-center justify-center gap-1.5 rounded-full text-[13px] font-bold leading-[14px]"
                          style={on ? { background: "#15130F", color: "#E3BE63", boxShadow: "0 0 0 2px #C9972F" } : { background: "rgba(255,255,255,.8)", color: s.name, boxShadow: `inset 0 0 0 2px ${s.muted}` }}>
                          {on ? <><Check className="h-4 w-4" /> Picked</> : "Pick"}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 overflow-hidden rounded-2xl bg-white ring-1 ring-[#15130F]/10">
                {COMPARE_ROWS.map((row, ri) => (
                  <div key={row.label} className={cn(ri > 0 && "border-t border-[#15130F]/10")}>
                    <p className="px-2 pt-2 text-[12px] font-bold uppercase tracking-wider text-[#15130F]/60">{row.label}</p>
                    <div className="grid grid-cols-3 gap-1 px-1 pb-2 pt-1">
                      {packages.map((p) => {
                        const on = pkg === p.key;
                        const s = SKINS[p.key];
                        return (
                          <button key={p.key} type="button" onClick={() => choose(p.key)}
                            className={cn("min-h-[44px] rounded-lg px-1 py-1.5 text-center text-[13px] font-semibold leading-[16px] transition", on && "ring-2")}
                            style={on ? { ...s.card, color: s.text, boxShadow: `0 0 0 2px ${s.rule}` } : { background: "#F8F3E7", color: "#15130F" }}>
                            {row.cells[p.key] === "Yes" ? <Check className="mx-auto h-5 w-5" style={{ color: on ? s.name : "#2F5137" }} /> : row.cells[p.key]}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            ) : phoneLook === "poster" ? (
            // The photo is the card: it fills the column top to bottom and the
            // words sit over its lower half on the package's own dark, so the
            // picture isn't a strip above a tower of text.
            <div className="grid grid-cols-3 gap-1">
              {packages.map((p) => {
                const on = pkg === p.key;
                const s = SKINS[p.key];
                const dark = p.key === "essential" ? "#2F5137" : p.key === "signature" ? "#3B2A12" : "#0B0A08";
                return (
                  <button key={p.key} type="button" onClick={() => choose(p.key)} aria-pressed={on}
                    className={cn("relative flex h-[360px] flex-col justify-end overflow-hidden rounded-2xl text-left text-white shadow-md transition duration-200 active:scale-[0.98]",
                      on ? cn("ring-4 shadow-xl", s.onRing) : cn(p.popular ? "ring-2" : "ring-1", s.ring))}
                    style={{ background: dark }}>
                    <img src={p.photos[p.photos.length - 1]} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />
                    <div className="absolute inset-0" style={{ background: `linear-gradient(180deg, rgba(0,0,0,0) 18%, ${dark} 52%)` }} />
                    {s.frame ? <GoldFrame /> : null}
                    <TierBadge pkg={p.key} small className="absolute left-1 top-1 z-20" />
                    <div className="relative px-1.5 pb-1.5">
                      <p className="font-heading text-[24px] font-bold leading-[26px]" style={{ color: p.key === "essential" ? "#FFFFFF" : "#F3DC8F", textShadow: "0 1px 2px rgba(0,0,0,.5)" }}>{p.short}</p>
                      <p className="text-[12px] font-bold uppercase leading-[14px] tracking-[0.02em] text-white/85">{p.tag}</p>
                      <p className="text-[12px] font-semibold leading-[14px] text-white/85">Lasts {p.lasts}*</p>
                      <ul className="mt-1 space-y-0.5">
                        {p.lines.slice(0, 2).map((l) => (
                          <li key={l.text} className="flex items-start gap-1 text-[12px] font-medium leading-[14px] text-white/95"><Check className="mt-0.5 h-3 w-3 shrink-0 text-[#E3BE63]" />{l.text}</li>
                        ))}
                      </ul>
                      <div className="mt-1.5 rounded-lg bg-white px-1 py-1 text-center text-[#15130F]">
                        {discount ? <p className="text-[12px] leading-[14px] opacity-75"><s>{formatCurrency(p.regular)}</s> <span className="rounded px-1 text-[11px] font-bold uppercase" style={s.offChip}>20% off</span></p> : null}
                        <p className="mt-0.5 font-heading text-[24px] font-bold leading-none tabular-nums" style={{ color: dark }}>{formatCurrency(p.price)}</p>
                        <p className="mt-0.5 text-[12px] font-semibold leading-[14px] opacity-85">4 × {formatCurrency(fourPayments(p.price))}</p>
                      </div>
                      <p className="mt-1.5 flex min-h-[36px] items-center justify-center gap-1.5 rounded-full text-[13px] font-bold"
                        style={on ? { background: "#E3BE63", color: "#15130F" } : { background: "rgba(255,255,255,.18)", color: "#FFFFFF", boxShadow: "inset 0 0 0 1.5px rgba(255,255,255,.7)" }}>
                        {on ? <><Check className="h-4 w-4" /> Picked</> : "Pick"}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
            ) : (
            // Every pixel to the cards, and shorter cards (Alan, 2026-10-28:
            // "too vertical… wider, while keeping them next to each other"):
            // thinner gaps and edges, a shorter photo, tighter rows, the
            // price a size up. Text never under 12px.
            <div className="grid grid-cols-3 gap-1">
              {packages.map((p) => {
                const on = pkg === p.key;
                const s = SKINS[p.key];
                return (
                  <button key={p.key} type="button" onClick={() => choose(p.key)} aria-pressed={on}
                    className={cn("relative flex flex-col overflow-hidden rounded-2xl text-left shadow-md transition duration-200 active:scale-[0.98]",
                      on ? cn("ring-4 shadow-xl", s.onRing) : cn(p.popular ? "ring-2" : "ring-1", s.ring))}
                    style={{ ...s.card, color: s.text }}>
                    {s.frame ? <GoldFrame /> : null}
                    <div className={cn("relative grid w-full", p.photos.length > 1 && "grid-rows-2 gap-[2px]")} style={{ background: s.rule }}>
                      {p.photos.map((src) => (
                        <img key={src} src={src} alt="" className={cn("w-full object-cover", p.photos.length > 1 ? "h-[44px]" : "h-[90px]")} draggable={false} />
                      ))}
                      <TierBadge pkg={p.key} small className="absolute left-1 top-1 z-20" />
                      {colorsV2 ? <span className="absolute bottom-1 right-1 z-20 rounded-md bg-black/65 px-1.5 py-0.5 text-[12px] font-bold text-white">Example</span> : null}
                    </div>
                    <div className="flex flex-1 flex-col px-1 pb-1.5 pt-1">
                      <p className="font-heading text-[22px] font-bold leading-[24px]" style={{ color: s.name }}>{p.short}</p>
                      <p className="mt-0.5 text-[12px] font-bold uppercase leading-[14px] tracking-[0.02em]" style={{ color: s.muted }}>{p.tag}</p>
                      <p className="text-[12px] font-semibold leading-[14px]" style={{ color: s.muted }}>Lasts {p.lasts}*</p>
                      <ul className="mt-1 flex-1 space-y-0.5">
                        {p.lines.map((l) => (
                          <li key={l.text} className="flex items-start gap-1 text-[12px] font-medium leading-[15px]"><Check className="mt-0.5 h-3 w-3 shrink-0" style={{ color: p.key === "legacy" ? s.name : s.accent }} />{l.text}</li>
                        ))}
                      </ul>
                      <div className="mt-1 rounded-lg px-1 py-1" style={s.priceBox}>
                        {discount ? (
                          <p className="flex flex-wrap items-center gap-1 text-[12px] leading-[14px]">
                            <span className="rounded px-1 py-px text-[11px] font-bold uppercase" style={s.offChip}>20% off</span>
                            <s className="opacity-75">{formatCurrency(p.regular)}</s>
                          </p>
                        ) : <p className="text-[12px] leading-[14px] opacity-75">Regular price</p>}
                        <p className="mt-0.5 font-heading text-[24px] font-bold leading-none tabular-nums" style={{ color: s.price }}>{formatCurrency(p.price)}</p>
                        <p className="mt-1 text-[12px] font-semibold leading-[14px] opacity-85">or 4 payments of {formatCurrency(fourPayments(p.price))}</p>
                      </div>
                      {/* The tick means picked, never just "open" (Alan, 2026-10-14). */}
                      <p className="mt-1 flex items-center gap-1.5 text-[12px] font-bold leading-[14px]" style={{ color: s.name }}>
                        {on
                          ? <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#15130F] text-[#E3BE63] ring-2 ring-[#C9972F]"><Check className="h-3.5 w-3.5" /></span>
                          : <span className="h-6 w-6 shrink-0 rounded-full border-2 bg-white/80" style={{ borderColor: s.muted }} />}
                        {on ? "Picked" : "Tap to pick"}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
            )
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
              {packages.map((p) => {
                const on = pkg === p.key;
                const line = payLine(p.price);
                const s = SKINS[p.key];
                return (
                  <div key={p.key} className={cn("relative flex flex-col overflow-hidden rounded-2xl shadow-md transition duration-200",
                    on ? cn("scale-[1.02] ring-4 shadow-2xl", s.onRing)
                      : pkg ? cn("opacity-60 saturate-50 ring-1", s.ring)
                      : cn(p.popular ? "ring-2" : "ring-1", s.ring))}
                    style={{ ...s.card, color: s.text }}>
                    {s.frame ? <GoldFrame inset={4} /> : null}
                    {/* Name and badge first, the way the printed proposal
                        heads each column. */}
                    <div className="px-4 pb-3 pt-4 text-center">
                      <h3 className="font-heading text-[26px] font-bold leading-tight" style={{ color: s.name }}>{p.name}</h3>
                      <div className="mt-1.5 flex justify-center"><TierBadge pkg={p.key} /></div>
                    </div>
                    <div className="relative px-3">
                      <div className={cn("grid gap-0.5 overflow-hidden rounded-lg", p.photos.length > 1 && "grid-cols-2")} style={{ background: s.rule }}>
                        {p.photos.map((src, i) => (
                          <div key={src} className="relative">
                            <img src={src} alt="" className="h-40 w-full object-cover" draggable={false} />
                            {p.captions?.[i] ? (
                              <span className="absolute bottom-1.5 left-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[12px] font-bold uppercase tracking-wider text-white">{p.captions[i]}</span>
                            ) : null}
                            {colorsV2 && i === 0 ? (
                              <span className="absolute right-1.5 top-1.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[12px] font-bold text-white">Example · all colors below</span>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="flex flex-1 flex-col p-4">
                      <p className="text-center text-[14px] font-bold uppercase tracking-[0.1em]" style={{ color: s.muted }}>{p.tag}<br /><span className="whitespace-nowrap">Usually lasts {p.lasts}*</span></p>
                      <ul className="mt-3 flex-1 space-y-1.5">
                        {p.lines.map((l) => (
                          <li key={l.text} className="flex items-start gap-2 text-[15px] font-medium"><Check className="mt-0.5 h-4 w-4 shrink-0" style={{ color: p.key === "legacy" ? s.name : s.accent }} />{l.text}</li>
                        ))}
                      </ul>
                      <div className="mt-3 rounded-xl bg-[#FBF7EE] px-3 py-2 text-[#15130F] ring-1 ring-[#C9972F]/30">
                        <p className="text-[12px] font-bold uppercase tracking-wider text-[#8C6224]">Best for</p>
                        <p className="text-[15px] font-semibold leading-snug">{p.best}</p>
                      </div>
                      <div className="mt-3 rounded-xl px-3 py-2.5 text-center" style={s.priceBox}>
                        {discount ? (
                          <p className="flex flex-wrap items-center justify-center gap-1.5 text-[15px]">
                            <span className="rounded px-1.5 py-0.5 font-bold uppercase" style={s.offChip}>20% off</span>
                            <s className="text-[15px] opacity-75">{formatCurrency(p.regular)}</s>
                          </p>
                        ) : <p className="text-[12px] opacity-75">Regular price</p>}
                        <p className="mt-1 font-heading text-3xl font-bold leading-none" style={{ color: s.price }}>{formatCurrency(p.price)}</p>
                        <p className="mt-0.5 text-[14px] font-semibold opacity-80">Tax included</p>
                        <p className="mt-1.5 flex items-center justify-center gap-1.5 text-sm font-semibold">
                          {line.lender === "klarna"
                            ? <span className="rounded bg-[#FFB3C7] px-1 text-[12px] font-black text-black">Klarna.</span>
                            : <span className="rounded bg-[#15130F] px-1 py-0.5"><img src="/affirm-white.png" alt="Affirm" className="h-2.5 w-auto" draggable={false} /></span>}
                          {line.text} <LearnMore onClick={() => setPayFaq("klarna")} dark={p.key === "legacy"} />
                        </p>
                      </div>
                      <button type="button" onClick={() => choose(p.key)}
                        className={cn("mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-xl text-base font-bold transition active:scale-[0.98]",
                          on ? "bg-[#15130F] text-[#E3BE63] ring-1 ring-[#C9972F]" : "text-[#15130F] shadow-md")}
                        style={on ? undefined : { background: GOLD }}>
                        {on ? <><Check className="h-5 w-5" /> {p.short} is your pick</> : `I want ${p.short}`}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <p className="mt-3 text-center text-sm text-[#15130F]/75">Every price includes tax. Every package: two coats of stain and a 1-year warranty on our work. Choose based on the condition of your wood and the look you want.</p>
        </section>

        {/* Colours: a gallery to look at, not a decision to make here. Tap
            one and it opens big with a few words about it; the choice gets
            made with us on the phone (Alan, 2026-10-10, after a competitor's
            page did it this way). */}
        <section id="mock-color" className="scroll-mt-14 px-4 py-6">
          {colorsV2 ? (
            <>
              <SectionTitle kicker="Step 2 of 3" title="See the colors" sub="Just to look. Tap any color to see it up close. When you've found the one you like, tell us on the phone or by text and we'll put it on your job." />
              <p className="mb-4 rounded-xl bg-white px-3 py-2.5 text-[15px] font-semibold ring-1 ring-[#15130F]/10">
                {SIGNATURE_PHOTOS.length} Signature colors first, then {LEGACY_PHOTOS.length} Legacy colors below them. Keep scrolling to see them all.
              </p>
              {([
                { key: "signature" as const, title: "Signature colors", what: "Semi-transparent. You still see the wood grain.", colors: SIGNATURE_PHOTOS as { name: string; src: string; full?: string; note?: string }[], finish: "Signature · semi-transparent", foot: "Real fences we stained." },
                { key: "legacy" as const, title: "Legacy colors", what: "Solid. One even color that covers the wood.", colors: LEGACY_PHOTOS as { name: string; src: string; full?: string; note?: string }[], finish: "Legacy · solid color", foot: "Real fences we stained. Midnight Gray: photo coming." },
              ]).map((g) => (
                <div key={g.key} className={cn(g.key === "legacy" && "mt-6")}>
                  <div className="mb-2 flex items-center gap-2">
                    <TierBadge pkg={g.key} />
                    <div className="min-w-0">
                      <h3 className="font-heading text-[22px] font-bold leading-tight">{g.title}</h3>
                      <p className="text-[15px] text-[#15130F]/75">{g.what}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {g.colors.map((c) => (
                      <button key={c.name} type="button"
                        onClick={() => setColorOpen({ name: c.name, src: c.src, full: c.full, note: c.note, finish: g.finish })}
                        className="relative aspect-[4/3] overflow-hidden rounded-2xl bg-[#15130F] text-left shadow-md ring-1 ring-[#15130F]/10 transition active:scale-[0.98]">
                        <img src={c.src} alt={c.name} className="h-full w-full object-cover" loading="lazy" draggable={false} />
                        <span className="absolute left-1.5 top-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[12px] font-bold text-white">{g.key === "signature" ? "Signature" : "Legacy"}</span>
                        <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-3 pb-2.5 pt-8 text-[15px] font-bold text-white">{c.name}</span>
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-[15px] text-[#15130F]/75">{g.foot}</p>
                </div>
              ))}
            </>
          ) : (<>
          <SectionTitle kicker="Step 2 of 3" title="See the colors" sub="Tap any color to see it up close and read about it. We'll help you choose." />
          {/* The two tabs are the two packages, not two words: the package's
              own photo behind the name, the first few colours fanned out, and
              the one that's open shines (Alan, 2026-10-10: "give it a little
              more branding… a little twinkle"). */}
          <div className="mb-3 grid grid-cols-2 gap-2">
            {(["signature", "legacy"] as const).map((k) => {
              const on = palette === k;
              const p = packages.find((x) => x.key === k)!;
              const colors = k === "signature" ? SIGNATURE_PHOTOS : LEGACY_PHOTOS;
              return (
                <button key={k} type="button" onClick={() => setPalette(k)} aria-pressed={on}
                  className={cn("relative h-[76px] overflow-hidden rounded-2xl text-left transition duration-300",
                    on ? "scale-[1.02] text-white shadow-xl shadow-[#C9972F]/30 ring-2 ring-[#C9972F]" : "bg-white text-[#15130F] ring-1 ring-[#15130F]/10 active:scale-[0.98]")}>
                  {on ? (
                    <>
                      <img src={p.photos[0]} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />
                      <div className="absolute inset-0 bg-gradient-to-r from-[#15130F] via-[#15130F]/85 to-[#15130F]/45" />
                      <span className="mock-shine" aria-hidden />
                      <Sparkles className="mock-twinkle absolute right-2 top-2 h-5 w-5" style={{ color: "#E3BE63" }} aria-hidden />
                    </>
                  ) : null}
                  <span className="relative flex h-full flex-col justify-center px-3">
                    <span className="flex items-center gap-2">
                      <span className="flex shrink-0 -space-x-2">
                        {colors.slice(0, 3).map((c) => (
                          <img key={c.name} src={c.src} alt="" loading="lazy" draggable={false}
                            className={cn("h-7 w-7 rounded-full object-cover ring-2", on ? "ring-[#15130F]" : "ring-white")} />
                        ))}
                      </span>
                      <span className={cn("font-heading text-[17px] font-bold leading-tight", on && "text-[#E3BE63]")}>{p.short}</span>
                    </span>
                    <span className={cn("mt-1 text-[12px] font-semibold", on ? "text-white/90" : "text-[#15130F]/75")}>
                      {colors.length} colors · {k === "signature" ? "see the grain" : "solid color"}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(palette === "signature" ? SIGNATURE_PHOTOS : LEGACY_PHOTOS).map((c) => (
              <button key={c.name} type="button"
                onClick={() => setColorOpen({ name: c.name, src: c.src, full: "full" in c ? (c as { full: string }).full : undefined, note: "note" in c ? (c as { note: string }).note : undefined, finish: palette === "signature" ? "Signature · semi-transparent" : "Legacy · solid color" })}
                className="relative aspect-[4/3] overflow-hidden rounded-2xl bg-[#15130F] text-left shadow-md ring-1 ring-[#15130F]/10 transition active:scale-[0.98]">
                <img src={c.src} alt={c.name} className="h-full w-full object-cover" loading="lazy" draggable={false} />
                <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-3 pb-2.5 pt-8 text-[15px] font-bold text-white">{c.name}</span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-[15px] text-[#15130F]/75">
            {palette === "signature" ? "Real fences we stained. More colors as photos are added." : `Real fences we stained. ${LEGACY_NO_PHOTO.join(" and ")}: photos coming.`}
          </p>
          </>)}

          {/* The colour they want isn't here. */}
          <div className="mt-4 rounded-2xl bg-white p-3 ring-1 ring-[#15130F]/10">
            <p className="flex items-center gap-2 text-[15px] font-bold"><MessageSquare className="h-4 w-4" style={{ color: "#8C6224" }} /> Don't see your color?</p>
            <p className="mt-0.5 text-sm text-[#15130F]/75">Tell us what you have in mind and we'll find it for you.</p>
            {colorSent ? (
              <p className="mt-2 rounded-xl bg-emerald-50 px-3 py-2 text-[15px] font-semibold text-emerald-800"><Check className="mr-1 inline h-4 w-4" /> Got it. We'll text you some options.</p>
            ) : (
              <div className="mt-2 flex gap-2">
                <input value={colorAsk} onChange={(e) => setColorAsk(e.target.value)} placeholder="A gray-brown like my neighbor's…"
                  className="h-11 min-w-0 flex-1 rounded-xl border border-[#15130F]/15 bg-[#F8F3E7] px-3 text-[15px]" />
                <button type="button" onClick={() => colorAsk.trim() && setColorSent(true)} className="h-11 rounded-xl px-4 text-[15px] font-bold text-[#15130F]" style={{ background: GOLD }}>Send</button>
              </div>
            )}
          </div>
        </section>

        {/* Repairs */}
        <section className="bg-white px-4 py-6">
          <SectionTitle kicker="Optional" title="Anything need replacing?" sub="Count it up. We bring the wood." />
          <div className="space-y-2.5">
            <Counter label="Pickets" what="The upright boards" unit="picket" art={<FencePart part="picket" />} price={PICKETS.find((p) => p.key === picketType)!.price} n={counts.pickets || 0} onChange={(d) => bump("pickets", d)}>
              <Chips options={PICKETS} value={picketType} onChange={setPicketType} />
            </Counter>
            {PARTS.map((part) => (
              <Counter key={part.key} label={part.label} what={part.what} unit={part.unit} art={<FencePart part={part.key as FencePartKey} />} price={part.price} n={counts[part.key] || 0} onChange={(d) => bump(part.key, d)} />
            ))}
            <Counter label="Post replacement" what="The thick posts set in the ground" unit="post" art={<FencePart part="post" />} price={POSTS.find((p) => p.key === postType)!.price} n={counts.posts || 0} onChange={(d) => bump("posts", d)}>
              <Chips options={POSTS} value={postType} onChange={setPostType} />
            </Counter>
          </div>
          <div className="mt-3 flex items-center justify-between rounded-xl bg-[#15130F] px-4 py-3 text-white">
            <span className="flex items-center gap-2 text-[15px] font-semibold"><Hammer className="h-4 w-4" style={{ color: "#E3BE63" }} /> Repairs</span>
            <span className="font-heading text-xl font-bold tabular-nums">{repairs ? `+ ${formatCurrency(repairs)}` : "$0"}</span>
          </div>
        </section>

        {/* Two chapters of the story, made to look different on purpose
            (Alan, 2026-10-12: "they look too similar… you're taking them
            through a story"). First what we do to the fence, as a path
            through the two days, light and warm. */}
        <section className="px-4 pt-6 pb-4">
          <SectionTitle kicker="Step by step" title="What you get" sub="Two days, start to finish." />
          <ol className="rounded-3xl bg-[#F8F3E7] p-4 ring-1 ring-[#15130F]/10">
            {STEPS.map((st, i) => (
              <li key={st.head} className="relative flex gap-3 pb-4 last:pb-0">
                {i < STEPS.length - 1 ? <span className="absolute left-[21px] top-12 bottom-1 w-[3px] rounded-full" style={{ background: "#E3BE63" }} aria-hidden /> : null}
                <span className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white shadow-sm ring-2" style={{ color: "#8C6224", ["--tw-ring-color" as string]: GOLD }}>
                  <st.icon className="h-5 w-5" />
                </span>
                <div className="min-w-0 pt-0.5">
                  {st.day ? <span className="mb-1 inline-block rounded-full bg-[#15130F] px-2.5 py-0.5 text-[12px] font-bold uppercase tracking-wider text-[#E3BE63]">{st.day}</span> : null}
                  <p className="text-[17px] font-bold leading-tight">{st.head}</p>
                  <p className="mt-0.5 text-[15px] leading-snug text-[#15130F]/75">{st.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* Then why us: a dark band of big gold numbers, read in a glance. */}
        <section className="px-4 pb-6">
          <div className="rounded-3xl bg-[#15130F] p-4 text-white">
            <p className="text-[12px] font-bold uppercase tracking-[0.2em] text-[#E3BE63]">Why us</p>
            <h2 className="font-heading text-2xl font-bold leading-tight">Why people pick us</h2>
            <div className={cn("mt-3 grid grid-cols-2 gap-2", !phone && "sm:grid-cols-4")}>
              {[
                { big: "1 year", head: "Warranty on our work", body: "If our work peels or cracks, we come back and fix it." },
                { big: ratingText, head: "On Google", body: "We pride ourselves on being the best.", stars: true },
                { big: "1,500+", head: "Fences restored", body: "Across the Houston area." },
                { big: "7+ years", head: "Staining fences", body: "Hands-on, every job." },
              ].map((f) => (
                <div key={f.head} className="rounded-2xl bg-white/[0.06] p-3 ring-1 ring-white/10">
                  <p className="font-heading text-[30px] font-bold leading-none tabular-nums" style={{ color: "#E3BE63" }}>{f.big}</p>
                  {f.stars ? <p className="mt-1 flex gap-0.5">{[0, 1, 2, 3, 4].map((n) => <Star key={n} className="h-3.5 w-3.5 fill-current" style={{ color: "#E3BE63" }} />)}</p> : null}
                  <p className="mt-1.5 text-[15px] font-bold leading-tight">{f.head}</p>
                  <p className="mt-1 text-[15px] leading-snug text-white/85">{f.body}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 flex items-start gap-3 rounded-2xl bg-emerald-800 p-4 text-white">
            <Users className="mt-0.5 h-6 w-6 shrink-0" style={{ color: "#E3BE63" }} />
            <div>
              <p className="font-heading text-lg font-bold leading-tight">Know a neighbor who needs it too?</p>
              <p className="mt-1 text-[15px] text-white/85">You both get an extra $100 off. No deadline. Just tell us.</p>
            </div>
          </div>
        </section>

        {/* The four questions people ask most, folded until tapped, so the
            page stays short (Alan, 2026-10-10). */}
        <section className="px-4 pb-6">
          <SectionTitle kicker="Good to know" title="Questions people ask" />
          <div className="overflow-hidden rounded-2xl bg-white ring-1 ring-[#15130F]/10">
            {FAQ.map(([q, a], i) => {
              const open = faqOpen === i;
              return (
                <div key={q} className={cn(i > 0 && "border-t border-[#15130F]/10")}>
                  <button type="button" onClick={() => setFaqOpen(open ? null : i)} aria-expanded={open}
                    className="flex w-full items-center gap-3 px-4 py-4 text-left">
                    <span className="flex-1 text-[17px] font-bold leading-snug">{q}</span>
                    <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition", open ? "bg-[#15130F] text-[#E3BE63]" : "bg-[#F8F3E7] text-[#8C6224]")}>
                      {open ? <Minus className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                    </span>
                  </button>
                  {open ? <p className="px-4 pb-4 text-[15px] leading-relaxed text-[#15130F]/80">{a}</p> : null}
                </div>
              );
            })}
          </div>
        </section>

        {/* Reviews, laid out the way Google shows them: the rating up top,
            then cards you can read in a glance. Sample text until the real
            reviews are pulled in. */}
        <section className="bg-white px-4 py-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <p className="text-[12px] font-bold uppercase tracking-[0.2em] text-[#8C6224]">Google reviews</p>
              <div className="flex items-baseline gap-2">
                <span className="font-heading text-4xl font-bold leading-none">{ratingText}</span>
                <span className="flex gap-0.5">{[0, 1, 2, 3, 4].map((n) => <Star key={n} className="h-4 w-4 fill-current" style={{ color: GOLD }} />)}</span>
              </div>
              <p className="mt-0.5 text-sm text-[#15130F]/75">We pride ourselves on being the best.</p>
            </div>
          </div>
          {/* Every five-star review, swiped through on a phone, three across
              on a desktop with the rest below. Sample cards only until the
              real ones are pulled (Settings → Google reviews). */}
          <div className={cn(phone ? "-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" : "grid gap-3 sm:grid-cols-3")}>
            {realReviews ? realReviews.reviews.map((r) => (
              <ReviewCard key={r.id} author={r.author} photo={r.photo} text={r.text} when={r.when} photos={r.photos} phone={phone} />
            )) : [
              ["Sample customer", "Cypress · 2 weeks ago", "Fence looks brand new. Crew was on time, kept the hinges clean and tidied up after. Sample text until real reviews are pulled in."],
              ["Sample customer", "Katy · 2 weeks ago", "Picked Signature in Cedar Naturaltone and it came out exactly like the photo on the proposal. Sample text."],
              ["Sample customer", "Tomball · 2 weeks ago", "Easy to pick a package on my phone and pay the deposit. Two days later it was done. Sample text."],
            ].map(([who, when, text]) => (
              <ReviewCard key={text} author={who} photo="" text={text} when={when} phone={phone} />
            ))}
          </div>
          <a href="https://g.page/r/CSqFYMG3SFFFEBM/review" target="_blank" rel="noopener noreferrer"
            className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-white text-[15px] font-semibold ring-1 ring-[#15130F]/15">
            See all our reviews on Google
          </a>
        </section>

        {/* How to pay: the deposit, or the whole job over time. Both go to
            the same Stripe checkout; Klarna is picked there. */}
        <section id="mock-pay" className="scroll-mt-14 px-4 py-6">
          <SectionTitle kicker="Step 3 of 3" title="How would you like to pay?" sub={chosen ? `Your price: ${formatCurrency(total)} · ${chosen.name}${option ? ` · ${option.label}` : ""}${repairs ? " plus repairs" : ""}` : "Pick a package above to see your price."} />
          {/* The 20% off ends with the month and the price goes back up. Booking
              now locks it even if the job happens later; paying over time is
              how someone does that without the cash today (Alan, 2026-10-10). */}
          <div className="mb-3 flex items-start gap-2.5 rounded-xl bg-[#F8F3E7] px-3 py-2.5 ring-1 ring-[#C9972F]/50">
            <Calendar className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "#8C6224" }} />
            {expired
              ? <p className="text-sm leading-snug"><span className="font-bold">Your quoted price ended {customer.goodThrough}.</span> These are our regular prices. Call or text us with any questions.</p>
              : <p className="text-sm leading-snug"><span className="font-bold">Your price is good for {customer.priceDays} days, through {customer.goodThrough}.</span> Book by then and it's locked, even if we do the job next month. Paying over time means you don't need the money today.</p>}
          </div>
          {!chosen && !reserved ? (
            <div className="mb-3 flex items-center gap-3 rounded-xl bg-amber-50 px-3 py-3 ring-2 ring-amber-400">
              <p className="min-w-0 flex-1 text-[16px] font-bold leading-snug text-amber-950">You haven't picked a package yet.</p>
              <button type="button" onClick={() => setAskPick("pick")} className="h-11 shrink-0 rounded-xl bg-[#15130F] px-4 text-[15px] font-bold text-[#E3BE63]">Pick one</button>
            </div>
          ) : null}
          {doorError ? <p className="mb-3 rounded-xl bg-rose-50 px-3 py-2 text-[15px] font-semibold text-rose-700 ring-1 ring-rose-200">{doorError}</p> : null}
          {reserved ? (
            <div className="rounded-2xl bg-[#15130F] p-4 text-white ring-1 ring-[#C9972F]/50">
              <p className="flex items-center gap-2 font-heading text-lg font-bold"><Check className="h-5 w-5" style={{ color: "#E3BE63" }} /> You're reserved</p>
              <p className="mt-1 text-[15px] text-white/80">{reserved.kind === "full" ? "Your job is paid in full." : "Your $250 deposit is in."} {reserved.tier ? `${packages.find((p) => p.key === reserved.tier)?.name || ""} it is.` : ""} We'll be in touch about your dates.</p>
              <a href={reserved.afterUrl} className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-xl text-base font-bold text-[#15130F] shadow-lg" style={{ background: GOLD }}>What happens next</a>
            </div>
          ) : (
          <div className="space-y-3">
            <div className="rounded-2xl bg-[#15130F] p-4 text-white ring-1 ring-[#C9972F]/50">
              <p className="flex items-center gap-2 font-heading text-lg font-bold"><Home className="h-5 w-5" style={{ color: "#E3BE63" }} /> Reserve my spot</p>
              <p className="mt-1 text-[15px] text-white/80"><span className="font-bold text-white">$250 today</span> books your spot. The rest{chosen ? ` (${formatCurrency(Math.max(0, total - 250))})` : ""} is due when the job is done and you're happy.</p>
              <button type="button" onClick={() => void openDoor("reserve")} disabled={doorBusy !== null} className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-xl text-base font-bold text-[#15130F] shadow-lg active:scale-[0.98] disabled:opacity-70" style={{ background: GOLD }}>
                <CreditCard className="h-5 w-5" /> {doorBusy === "reserve" ? "Opening your payment page…" : "Reserve my spot · $250"}
              </button>
              <p className="mt-3 text-center text-[15px] leading-snug text-white">Card, Apple Pay, Google Pay, bank account or Cash App. <span className="font-bold">The $250 is not refundable.</span> You can move your date any time.</p>
              <p className="mt-2 text-center text-[15px] leading-snug text-white/85">By reserving, you agree to our <button type="button" onClick={() => setTerms(true)} className="inline-flex min-h-[44px] items-center font-bold underline underline-offset-2" style={{ color: "#E3BE63" }}>Terms</button>.</p>
            </div>
            <div className="rounded-2xl bg-white p-4 ring-1 ring-[#15130F]/10">
              <p className="flex items-center gap-2 font-heading text-lg font-bold"><Calendar className="h-5 w-5" style={{ color: "#8C6224" }} /> Or pay over time</p>
              <p className="mt-1 text-sm text-[#15130F]/75">Were you going to do this in a month or two anyway? Lock in today's price and spread the payments.</p>
              <div className="mt-2 space-y-2">
                <PayOption lender="klarna" text={payLine(total || packages[1].price).text} note="Pick 4 payments or a monthly plan. You see the full cost before you say yes." learn={() => setPayFaq("klarna")} />
                {AFFIRM_ON ? <PayOption lender="affirm" text="Affirm: 4 payments or monthly plans" note="Pay a little each month. You see the full cost before you say yes." learn={() => setPayFaq("affirm")} /> : null}
              </div>
              <button type="button" onClick={() => void openDoor("finance")} disabled={doorBusy !== null} className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#FFB3C7] text-base font-bold text-black shadow-md active:scale-[0.98] disabled:opacity-70">
                {doorBusy === "finance" ? "Opening Klarna…" : <><span className="font-black tracking-tight">Klarna.</span> {chosen ? `Apply · ${formatCurrency(total)}` : "Apply for Klarna"}</>}
              </button>
              <p className="mt-2 text-center text-[15px] leading-snug text-[#15130F]/80">{chosen ? "Klarna asks a few quick questions." : "First you'll pick your package."} Checking doesn't affect your credit score.</p>
              <p className="mt-1 text-center text-[15px] leading-snug text-[#15130F]/80">By paying, you agree to our <button type="button" onClick={() => setTerms(true)} className="inline-flex min-h-[44px] items-center font-bold text-[#8C6224] underline underline-offset-2">Terms</button>.</p>
            </div>
          </div>
          )}
        </section>

        {/* Footer links */}
        <section className="px-4 pb-28">
          <div className="mb-5"><ShareCard onShared={doors?.shared} /></div>
          <button type="button" onClick={() => setTerms(true)} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-white text-[16px] font-semibold ring-1 ring-[#15130F]/15"><FileText className="h-5 w-5" /> Terms</button>
          <p className="mt-4 text-center text-[15px] text-[#15130F]/75">Sterling Fence Staining · Cypress, TX · 346-589-7877</p>
          <p className="mt-1 text-center text-[13px] text-[#15130F]/60">Proposal {customer.number}</p>
        </section>

        {/* Sticky bottom: the one thing to do. */}
        {chosen || reserved || pastPackages ? <div className={cn("sticky bottom-0 z-20 border-t border-[#C9972F]/40 bg-[#15130F] p-3 text-white", phone && (preview ? "sm:rounded-b-[1.6rem]" : "rounded-b-[1.6rem]"))}>
          {chosen ? (
            // Both ways to pay, side by side, the moment a package is picked
            // (Alan, 2026-10-14): the $250 in gold, Klarna in its own pink.
            <div>
              <div className="flex items-end justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm text-white/85"><span className="font-bold" style={{ color: "#E3BE63" }}>Your price</span> · {chosen.short}{repairs ? " + repairs" : ""}</p>
                  <p className="font-heading text-2xl font-bold leading-none tabular-nums">{formatCurrency(total)}</p>
                </div>
              </div>
              {reserved ? null : (
                <button type="button" onClick={() => document.getElementById("mock-pay")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                  className="mt-1 text-left text-[13px] font-semibold leading-snug underline underline-offset-2" style={{ color: "#E3BE63" }}>
                  {pay.text}
                </button>
              )}
              {reserved ? (
                <button type="button" onClick={() => void openDoor("reserve")}
                  className="mt-2 flex h-12 w-full items-center justify-center gap-2 rounded-xl text-[15px] font-bold text-[#15130F] shadow-lg" style={{ background: GOLD }}>
                  <Home className="h-4 w-4" /> What's next
                </button>
              ) : (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => void openDoor("reserve")} disabled={doorBusy !== null}
                    className="flex h-12 items-center justify-center gap-1.5 rounded-xl text-[15px] font-bold text-[#15130F] shadow-lg active:scale-[0.98] disabled:opacity-70" style={{ background: GOLD }}>
                    <Home className="h-4 w-4" /> {doorBusy === "reserve" ? "Opening…" : "Reserve · $250"}
                  </button>
                  <button type="button" onClick={() => void openDoor("finance")} disabled={doorBusy !== null}
                    className="flex h-12 items-center justify-center gap-1.5 rounded-xl bg-[#FFB3C7] text-[15px] font-bold text-black shadow-lg active:scale-[0.98] disabled:opacity-70">
                    {doorBusy === "finance" ? "Opening…" : <><span className="font-black tracking-tight">Klarna.</span> Apply</>}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <p className="min-w-0 text-[15px] font-semibold leading-snug text-white/90">You haven't picked a package yet.</p>
              <button type="button" onClick={() => setAskPick("pick")}
                className="flex h-12 shrink-0 items-center rounded-xl px-4 text-[15px] font-bold text-[#15130F] shadow-lg" style={{ background: GOLD }}>Pick one</button>
            </div>
          )}
        </div> : null}
      </div>

      {colorOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 p-0 sm:items-center sm:p-4" onClick={() => setColorOpen(null)}>
          <div className="w-full max-w-md overflow-hidden rounded-t-3xl bg-white text-[#15130F] shadow-2xl sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
            <div className="relative">
              <ColorPhoto key={colorOpen.name} name={colorOpen.name} src={colorOpen.src} full={colorOpen.full} />
              <button type="button" onClick={() => setColorOpen(null)} aria-label="Close"
                className="absolute right-3 top-3 flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white ring-2 ring-[#C9972F]/70">✕</button>
            </div>
            <div className="p-5">
              <h3 className="font-heading text-3xl font-bold leading-tight">{colorOpen.name}</h3>
              <p className="mt-1 text-[12px] font-bold uppercase tracking-[0.15em] text-[#8C6224]">{colorOpen.finish}</p>
              <p className="mt-3 text-[17px] leading-relaxed text-[#15130F]/85">{colorOpen.note || COLOR_NOTES[colorOpen.name] || "A real fence we stained in this color."}</p>
              <p className="mt-4 rounded-xl bg-[#F8F3E7] px-3 py-2.5 text-[15px] text-[#15130F]/80">Like it? Tell us when we talk. We'll make sure it suits your wood.</p>
              <button type="button" onClick={() => setColorOpen(null)} className="mt-4 h-12 w-full rounded-xl text-[17px] font-bold text-[#15130F]" style={{ background: GOLD }}>Back to the colors</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Pay over time, explained the way PlayStation explains Klarna, for
          both lenders, with the two side by side at the top. */}
      {payFaq ? (() => {
        const faq = payFaq === "affirm" && AFFIRM_ON ? AFFIRM_FAQ : KLARNA_FAQ;
        return (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4" onClick={() => setPayFaq(null)}>
            <div className="flex max-h-[90vh] w-full max-w-md flex-col rounded-t-3xl bg-[#F8F3E7] text-[#15130F] shadow-2xl sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
              <div className="px-5 pt-5">
                <p className="text-[12px] font-bold uppercase tracking-[0.2em] text-[#8C6224]">Pay over time</p>
                <h3 className="font-heading text-xl font-bold leading-tight">{AFFIRM_ON ? "Two ways to spread it out" : "Spread it out with Klarna"}</h3>
                {AFFIRM_ON ? <div className="mt-3 grid grid-cols-2 gap-1 rounded-xl bg-white p-1 ring-1 ring-[#15130F]/10">
                  <button type="button" onClick={() => setPayFaq("klarna")}
                    className={cn("flex h-11 items-center justify-center rounded-lg text-[15px] font-black transition", payFaq === "klarna" ? "bg-[#FFB3C7] text-black" : "text-[#15130F]/75")}>Klarna.</button>
                  <button type="button" onClick={() => setPayFaq("affirm")}
                    className={cn("flex h-11 items-center justify-center rounded-lg transition", payFaq === "affirm" ? "bg-[#15130F]" : "opacity-50")}>
                    <img src="/affirm-white.png" alt="Affirm" className={cn("h-4 w-auto", payFaq !== "affirm" && "invert")} draggable={false} />
                  </button>
                </div> : null}
              </div>
              <div className="mt-3 flex-1 space-y-3 overflow-y-auto px-5 pb-2">
                {AFFIRM_ON ? <div className="overflow-hidden rounded-2xl bg-white ring-1 ring-[#15130F]/10">
                  <div className="grid grid-cols-[1.2fr_1fr_1fr] bg-[#15130F] px-3 py-1.5 text-[12px] font-bold uppercase tracking-wider text-white/85">
                    <span>Compare</span><span className={cn(payFaq === "klarna" && "text-[#E3BE63]")}>Klarna</span><span className={cn(payFaq === "affirm" && "text-[#E3BE63]")}>Affirm</span>
                  </div>
                  {LENDER_COMPARE.map(([label, k, a]) => (
                    <div key={label} className="grid grid-cols-[1.2fr_1fr_1fr] gap-2 border-t border-[#15130F]/5 px-3 py-2 text-[13px] leading-snug">
                      <span className="font-bold">{label}</span>
                      <span className={cn(payFaq === "klarna" ? "font-semibold" : "text-[#15130F]/75")}>{k}</span>
                      <span className={cn(payFaq === "affirm" ? "font-semibold" : "text-[#15130F]/75")}>{a}</span>
                    </div>
                  ))}
                </div> : null}
                {faq.map(([q, a]) => (
                  <div key={q} className="rounded-2xl bg-white p-3 ring-1 ring-[#15130F]/10">
                    <p className="text-[15px] font-bold leading-snug">{q}</p>
                    <p className="mt-1 text-[15px] leading-relaxed text-[#15130F]/85">{a}</p>
                  </div>
                ))}
                <p className="px-1 text-[13px] leading-snug text-[#15130F]/75">
                  {payFaq !== "affirm" || !AFFIRM_ON
                    ? "Klarna's current terms, privacy policy and customer service are on klarna.com and in the Klarna app. They are Klarna's, not Sterling Fence Staining's."
                    : "Affirm's current terms, lending partners and customer service are on affirm.com and in the Affirm app. They are Affirm's, not Sterling Fence Staining's."}
                </p>
              </div>
              <div className="p-5 pt-3">
                <button type="button" onClick={() => setPayFaq(null)} className="h-12 w-full rounded-xl text-[17px] font-bold text-[#15130F]" style={{ background: GOLD }}>Got it</button>
              </div>
            </div>
          </div>
        );
      })() : null}

      {checkout && payLook === "page" ? (
        <PayPageMock
          mode={checkout}
          pkgName={chosen?.name || packages[1].name}
          total={total || packages[1].price}
          firstName={customer.name.split(" ")[0]}
          address={customer.address}
          onClose={() => setCheckout(null)}
          onPaid={(method) => { const flow = checkout; setCheckout(null); setAfterPay({ flow, method }); }}
          onTerms={() => setTerms(true)}
          onOldLook={() => setPayLook("stripe")}
        />
      ) : checkout ? (
        <CheckoutMock
          mode={checkout}
          pkgName={chosen?.name || packages[1].name}
          total={total || packages[1].price}
          repairs={repairs}
          onClose={() => setCheckout(null)}
          onPaid={(method) => { const flow = checkout; setCheckout(null); setAfterPay({ flow, method }); }}
          onNewLook={() => setPayLook("page")}
        />
      ) : null}
      {afterPay ? (
        <AfterPay
          flow={afterPay.flow}
          method={afterPay.method}
          paidUpFront={afterPay.paidUpFront}
          firstName={customer.name.split(" ")[0]}
          address={customer.address}
          pkgName={chosen?.name || packages[1].name}
          feet={hasDrawing ? customer.feet : 0}
          total={total || packages[1].price}
          repairs={repairs}
          staff={!preview || staffPeek}
          onClose={() => setAfterPay(null)}
        />
      ) : null}

      {invite ? (
        <BookingInvite
          firstName={customer.name.split(" ")[0]}
          address={tidyAddress(customer.address)}
          pkgName={chosen?.name || packages[1].name}
          color="Pecan"
          sides={customer.sides}
          feet={hasDrawing ? customer.feet : 0}
          total={(chosen?.price || packages[1].price) + repairs}
          date={inviteDate}
          staff
          onClose={() => setInvite(false)}
          // The trust version of the pay box (Alan, 2026-10-25): the face of
          // whoever sent the invite. Mockup only until Alan says go.
          trust={{
            name: "Alan Bonner", role: "Project Manager, Sterling Fence Staining", photo: "/team/alan.jpg",
            reviews: realReviews ? {
              rating: realReviews.rating, total: realReviews.total,
              quote: (() => {
                const q = realReviews.reviews.filter((x) => x.rating === 5 && x.text && x.text.length <= 170).sort((a, b) => b.text.length - a.text.length)[0];
                return q ? { author: q.author.split(" ")[0], text: q.text } : undefined;
              })(),
            } : undefined,
          }}
        />
      ) : null}

      {askPick ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4" onClick={() => setAskPick(null)}>
          <div className="w-full max-w-md rounded-t-3xl bg-[#F8F3E7] p-5 text-[#15130F] shadow-2xl sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-heading text-2xl font-bold leading-tight">Which package do you want?</h3>
            <p className="mt-1 text-[15px] text-[#15130F]/80">
              {/* Say why (Alan, 2026-10-14): we can't make their Klarna
                  application or deposit link without knowing the package. */}
              {askPick === "finance"
                ? "Pick the package you want so we can make your Klarna application for that exact price. Then Klarna opens."
                : askPick === "reserve"
                  ? "Pick the package you want so we can make your $250 deposit link for that job. Then the payment page opens."
                  : "Pick the package you want. Your price, deposit and Klarna options all go by it."}
            </p>
            <div className="mt-3 space-y-2">
              {packages.map((p) => (
                <button key={p.key} type="button"
                  onClick={() => { const door = askPick; choose(p.key); setAskPick(null); if (door === "reserve" || door === "finance") void openDoor(door, p.key); }}
                  className="flex min-h-[60px] w-full items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 text-left ring-1 ring-[#15130F]/15 active:scale-[0.98]">
                  <span className="min-w-0">
                    <span className="block font-heading text-[19px] font-bold leading-tight">{p.name}</span>
                    <span className="block text-[14px] text-[#15130F]/75">{p.tag} · usually lasts {p.lasts}</span>
                  </span>
                  <span className="shrink-0 font-heading text-[19px] font-bold tabular-nums">{formatCurrency(p.price + repairs)}</span>
                </button>
              ))}
            </div>
            <button type="button" onClick={() => setAskPick(null)} className="mt-3 h-12 w-full rounded-xl text-[16px] font-semibold underline underline-offset-2">Not yet</button>
          </div>
        </div>
      ) : null}

      {/* The terms, in plain words (Alan, 2026-10-10). */}
      {terms ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4" onClick={() => setTerms(false)}>
          <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-[#F8F3E7] p-5 text-[#15130F] shadow-2xl sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
            <p className="text-[12px] font-bold uppercase tracking-[0.2em] text-[#8C6224]">The fine print, without the fine print</p>
            <h3 className="font-heading text-2xl font-bold leading-tight">1-year warranty on our work</h3>
            <div className="mt-3 space-y-4 text-[17px] leading-relaxed">
              <TermsBody />
              {expired
                ? <p><span className="font-bold">Your price</span> was good for {customer.priceDays} days, through {customer.goodThrough}. That has ended, so our regular prices apply.</p>
                : <p><span className="font-bold">Your price</span> is good for {customer.priceDays} days, through {customer.goodThrough}. After that, our regular prices apply.</p>}
            </div>
            <button type="button" onClick={() => setTerms(false)} className="mt-4 h-12 w-full rounded-xl text-base font-bold text-[#15130F]" style={{ background: GOLD }}>Got it</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Pieces ─────────────────────────────────────────────────────────────

// The colour sheet shows the small photo the grid already loaded, so it
// opens at once, and the big one fades in over it when it arrives. Alan
// (2026-10-10): the Legacy colours "take a minute… they need to show up
// with the photo automatically." The big Legacy photos are 400–600 KB each
// off the photo storage; the thumbnails are 30 KB and already on the page.
function ColorPhoto({ name, src, full }: { name: string; src: string; full?: string }) {
  const [ready, setReady] = useState(false);
  return (
    <div className="relative h-[52vh] max-h-[52vh] w-full bg-[#15130F]">
      <img src={src} alt={name} className="absolute inset-0 h-full w-full object-cover" draggable={false} />
      {full ? (
        <img src={full} alt="" onLoad={() => setReady(true)} draggable={false}
          className={cn("absolute inset-0 h-full w-full object-cover transition-opacity duration-500", ready ? "opacity-100" : "opacity-0")} />
      ) : null}
    </div>
  );
}

// A sweep of light across the open palette tab and a twinkling spark on it.
// Both stop for people who asked their phone for less motion.
const SHINE_CSS = `
@keyframes mock-shine { 0% { transform: translateX(-160%) skewX(-20deg); } 55%, 100% { transform: translateX(260%) skewX(-20deg); } }
@keyframes mock-twinkle { 0%, 100% { opacity: .55; transform: scale(.85) rotate(-8deg); } 50% { opacity: 1; transform: scale(1.2) rotate(10deg); } }
.mock-shine { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.mock-shine::after { content: ""; position: absolute; top: -30%; bottom: -30%; left: 0; width: 45%; background: linear-gradient(90deg, transparent, rgba(255, 236, 190, .45), transparent); animation: mock-shine 3.2s ease-in-out infinite; }
.mock-twinkle { animation: mock-twinkle 1.8s ease-in-out infinite; transform-origin: center; }
@media (prefers-reduced-motion: reduce) { .mock-shine::after, .mock-twinkle { animation: none; } }
`;

function SectionTitle({ kicker, title, sub }: { kicker: string; title: string; sub?: string }) {
  return (
    <div className="mb-3">
      <p className="text-[15px] font-bold uppercase tracking-[0.15em] text-[#8C6224]">{kicker}</p>
      <h2 className="font-heading text-[30px] font-bold leading-tight">{title}</h2>
      {sub ? <p className="mt-1 text-[17px] leading-snug text-[#15130F]/80">{sub}</p> : null}
    </div>
  );
}

function Fact({ icon: Icon, label, children, wide }: { icon: React.ElementType; label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={cn("flex items-start gap-2", wide && "col-span-2")}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: "#8C6224" }} />
      <div className="min-w-0">
        <p className="text-[12px] font-bold uppercase tracking-wider text-[#15130F]/75">{label}</p>
        <p className="truncate text-[15px] font-semibold">{children}</p>
      </div>
    </div>
  );
}

/** A lender's line the way the lender writes it, with its mark. Klarna's
 *  pink pill and Affirm's wordmark are stand-ins until the real badges are
 *  pulled from Stripe's messaging element. */
/** Stripe Checkout on a phone, with Sterling's branding, as the customer
 *  will really see it. Two jobs: the $250 deposit (card, Apple Pay, Google
 *  Pay), or the whole job with Klarna on it. The real page is
 *  Stripe's; this is its shape. What comes after a payment is a stub
 *  until Alan's post-payment flow arrives. */
function CheckoutMock({ mode, pkgName, total, repairs, onClose, onPaid, onNewLook }: {
  mode: PayFlow; pkgName: string; total: number; repairs: number; onClose: () => void; onPaid: (method: PayMethod) => void; onNewLook?: () => void;
}) {
  type Method = PayMethod;
  const [method, setMethod] = useState<Method>("card");
  const balance = Math.max(0, total - 250);
  const amount = mode === "deposit" ? 250 : mode === "balance" ? balance : total;
  const line = payLine(amount);
  const methods: { key: Method; label: string }[] = mode === "deposit"
    ? [{ key: "card", label: "Card" }]
    : [{ key: "card", label: "Card" }, { key: "klarna", label: "Klarna" }, ...(AFFIRM_ON ? [{ key: "affirm" as const, label: "Affirm" }] : [])];
  const payLabel = method === "klarna" ? "Continue to Klarna" : method === "affirm" ? "Continue to Affirm" : `Pay ${formatCurrency(amount)}`;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4" onClick={onClose}>
      <div className="flex max-h-[94vh] w-full max-w-md flex-col overflow-hidden rounded-t-3xl bg-white text-[#15130F] shadow-2xl sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <>
            {/* Stripe's header: back, the merchant, the amount. */}
            <div className="bg-[#15130F] px-5 pb-5 pt-4 text-white">
              <div className="flex items-center justify-between">
                <button type="button" onClick={onClose} className="inline-flex items-center gap-1 text-sm text-white/85"><ArrowLeft className="h-3.5 w-3.5" /> Back</button>
                <span className="flex items-center gap-2">
                  {onNewLook ? <button type="button" onClick={onNewLook} className="whitespace-nowrap rounded-md bg-white/10 px-2 py-1 text-[11px] font-bold text-white/85">New look</button> : null}
                  <span className="rounded bg-amber-400/90 px-1.5 py-0.5 text-[12px] font-bold uppercase tracking-wider text-amber-950">Mockup · old</span>
                </span>
              </div>
              <div className="mt-3 flex items-center gap-3">
                <img src="/sterling-logo-dark.png" alt="" className="h-7 w-auto" draggable={false} />
              </div>
              <p className="mt-3 text-sm text-white/85">{mode === "deposit" ? "Deposit to reserve your dates" : mode === "balance" ? "Your balance. The job is done." : `Pay Sterling Fence Staining`}</p>
              <p className="font-heading text-4xl font-bold leading-none">{formatCurrency(amount)}</p>
              <div className="mt-3 space-y-1 border-t border-white/10 pt-3 text-sm">
                <div className="flex justify-between"><span className="text-white/80">{pkgName}</span><span>{formatCurrency(total - repairs)}</span></div>
                {repairs ? <div className="flex justify-between"><span className="text-white/80">Repairs</span><span>{formatCurrency(repairs)}</span></div> : null}
                {mode === "deposit" ? (
                  <>
                    <div className="flex justify-between font-semibold"><span>Deposit today</span><span>{formatCurrency(250)}</span></div>
                    <div className="flex justify-between text-white/85"><span>Due when the job is done</span><span>{formatCurrency(balance)}</span></div>
                  </>
                ) : mode === "balance" ? (
                  <>
                    <div className="flex justify-between text-white/85"><span>Deposit paid</span><span>− {formatCurrency(250)}</span></div>
                    <div className="flex justify-between font-semibold"><span>Due today</span><span>{formatCurrency(balance)}</span></div>
                  </>
                ) : (
                  <div className="flex justify-between font-semibold"><span>Total due today</span><span>{formatCurrency(total)}</span></div>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              {/* Express checkout, the way Stripe places it. */}
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => onPaid("card")} className="flex h-11 items-center justify-center rounded-lg bg-black text-[15px] font-semibold text-white"> Pay</button>
                <button type="button" onClick={() => onPaid("card")} className="flex h-11 items-center justify-center rounded-lg bg-black text-[15px] font-semibold text-white"><span className="mr-1 font-bold">G</span> Pay</button>
              </div>
              <div className="my-4 flex items-center gap-3 text-[13px] text-[#15130F]/70"><span className="h-px flex-1 bg-[#15130F]/10" />Or pay another way<span className="h-px flex-1 bg-[#15130F]/10" /></div>

              {/* The payment method list: Stripe's accordion. */}
              <div className="overflow-hidden rounded-xl border border-[#15130F]/15">
                {methods.map((m) => {
                  const on = method === m.key;
                  return (
                    <div key={m.key} className={cn("border-b border-[#15130F]/10 last:border-b-0", on && "bg-[#F8F3E7]/60")}>
                      <button type="button" onClick={() => setMethod(m.key)} className="flex w-full items-center gap-3 px-3 py-3 text-left">
                        <span className={cn("flex h-4 w-4 items-center justify-center rounded-full border", on ? "border-[#15130F] bg-[#15130F]" : "border-[#15130F]/40")}>{on ? <span className="h-1.5 w-1.5 rounded-full bg-white" /> : null}</span>
                        {m.key === "card" ? <CreditCard className="h-4 w-4 text-[#15130F]/70" />
                          : m.key === "klarna" ? <span className="rounded bg-[#FFB3C7] px-1 text-[12px] font-black text-black">Klarna.</span>
                          : <span className="rounded bg-[#15130F] px-1 py-0.5"><img src="/affirm-white.png" alt="" className="h-2.5 w-auto" draggable={false} /></span>}
                        <span className="flex-1 text-[15px] font-semibold">{m.label}</span>
                        {m.key !== "card" ? <span className="text-[12px] text-[#15130F]/75">{m.key === "klarna" ? "4 payments or monthly" : "Monthly or 4 payments"}</span> : null}
                      </button>
                      {on && m.key === "card" ? (
                        <div className="space-y-2 px-3 pb-3">
                          <Fake label="Card number" value="1234 1234 1234 1234" right="VISA · MC · AMEX" />
                          <div className="grid grid-cols-2 gap-2"><Fake label="Expiration" value="MM / YY" /><Fake label="CVC" value="123" /></div>
                          <Fake label="Name on card" value="Jordan Miller" />
                          <Fake label="ZIP" value="77429" />
                        </div>
                      ) : null}
                      {on && m.key === "klarna" ? (
                        <div className="px-3 pb-3 text-sm leading-relaxed text-[#15130F]/75">
                          <p className="font-semibold text-[#15130F]">{line.text}.</p>
                          <p>You'll finish on Klarna's page: pick 4 payments or a monthly plan, and Klarna checks you in a minute. No effect on your credit score to check.</p>
                        </div>
                      ) : null}
                      {on && m.key === "affirm" ? (
                        <div className="px-3 pb-3 text-sm leading-relaxed text-[#15130F]/75">
                          <p className="font-semibold text-[#15130F]">As low as {formatCurrency(monthlyFrom(amount))}/mo with Affirm.</p>
                          <p>You'll finish on Affirm's page: see your plans and the exact rate before you agree. Checking doesn't affect your credit score.</p>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              <button type="button" onClick={() => onPaid(method)} className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-xl text-base font-bold text-[#15130F]" style={{ background: GOLD }}>
                <Lock className="h-4 w-4" /> {payLabel}
              </button>
              {mode === "deposit" ? (
                <p className="mt-2 text-center text-[13px] text-[#15130F]/75">The deposit is not refundable once your dates are set.</p>
              ) : null}
              <p className="mt-4 flex items-center justify-center gap-2 text-[12px] text-[#15130F]/65">
                <Lock className="h-3 w-3" /> Powered by <span className="font-bold">stripe</span> · Terms · Privacy
              </p>
            </div>
          </>
      </div>
    </div>
  );
}

/** A field as Stripe draws one, filled with placeholder text. */
function Fake({ label, value, right }: { label: string; value: string; right?: string }) {
  return (
    <label className="block">
      <span className="text-[13px] font-semibold text-[#15130F]/70">{label}</span>
      <span className="mt-0.5 flex h-10 items-center justify-between rounded-lg border border-[#15130F]/20 bg-white px-3 text-[15px] text-[#15130F]/40">
        <span>{value}</span>{right ? <span className="text-[12px] font-bold tracking-wider text-[#15130F]/35">{right}</span> : <ChevronDown className="hidden" />}
      </span>
    </label>
  );
}

function LearnMore({ onClick, dark }: { onClick: () => void; dark?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={cn("inline-flex min-h-[44px] items-center px-1 font-bold underline underline-offset-2", dark ? "text-[#E3BE63]" : "text-[#8C6224]")}>
      Learn more
    </button>
  );
}

function PayOption({ lender, text, note, dim, learn }: { lender: "klarna" | "affirm"; text: string; note: string; dim?: boolean; learn?: () => void }) {
  return (
    <div className={cn("flex items-center gap-3 rounded-xl bg-[#F8F3E7] px-3 py-2", dim && "opacity-50")}>
      {lender === "klarna"
        ? <span className="flex h-7 w-16 shrink-0 items-center justify-center rounded-md bg-[#FFB3C7] text-[15px] font-black tracking-tight text-black">Klarna.</span>
        : <span className="flex h-7 w-16 shrink-0 items-center justify-center rounded-md bg-[#15130F]"><img src="/affirm-white.png" alt="Affirm" className="h-4 w-auto" draggable={false} /></span>}
      <div className="min-w-0">
        <p className="text-[15px] font-bold leading-tight">{text}</p>
        <p className="text-[15px] leading-snug text-[#15130F]/80">{dim ? "Over the pay-in-4 limit for this amount." : note}{learn ? <> <LearnMore onClick={learn} /></> : null}</p>
      </div>
    </div>
  );
}

/** A choice as tap-pills with the price on each, instead of a drop-down
 *  (Alan, 2026-10-10). */
/** What happens to the fence, in order, for the "What you get" path. */
const STEPS: { icon: React.ElementType; day?: string; head: string; body: string }[] = [
  { icon: Droplets, day: "Day 1", head: "Full prep wash", body: "Mold, mildew, dirt and gray weathering come off first." },
  { icon: Sun, day: "Day 2", head: "Premium stain", body: "Top-quality stain made for Texas sun." },
  { icon: Paintbrush, head: "Two coats", body: "With attention to boards, edges and details." },
  { icon: Wrench, head: "Loose boards screwed back in", body: "A few loose pickets, rails, caps or bottom boards? We screw them back in. No charge." },
  { icon: Shield, head: "Hardware stays clean", body: "We keep stain off your black hinges and latches." },
  { icon: Sparkles, head: "Clean jobsite", body: "Labor and cleanup included." },
];

