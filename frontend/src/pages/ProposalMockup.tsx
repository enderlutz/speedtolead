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
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Phone, Check, Shield, Droplets, Sparkles, Paintbrush, Sun, Star, Hammer, Minus, Plus,
  Download, FileText, MapPin, Calendar, Hash, UserRound, Leaf, Home, Smartphone, Monitor,
  Users, Lightbulb, ArrowLeft, Eye, Expand, MessageSquare, CreditCard,
} from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";

// ── Sample data ────────────────────────────────────────────────────────
// A made-up customer. Never a real one: this page ships inside the
// dashboard bundle.
const CUSTOMER = {
  name: "Jordan Miller",
  address: "12345 Cypress Creek Dr, Cypress, TX 77429",
  date: "October 10, 2026",
  number: "SF-2026-05481",
  goodThrough: "October 31",
  sides: ["Inside facing sides", "Outside facing: front"],
  feet: 280,
};

type PkgKey = "essential" | "signature" | "legacy";
const PACKAGES: {
  key: PkgKey; name: string; short: string; tag: string; lasts: string; photos: string[]; captions?: string[];
  best: string; lines: { icon: React.ElementType; text: string }[]; regular: number; price: number; popular?: boolean;
}[] = [
  {
    key: "essential", name: "Essential Seal", short: "Essential", tag: "Entry", lasts: "1–2 yrs",
    // The PDF's own photos, pulled out of the file: the clear pine fence
    // for Essential, the lighter and darker cedar pair for Signature, the
    // orange and the dark planks for Legacy (Alan, 2026-10-10).
    photos: ["/proposal-mockup/pkg-essential.jpg"],
    best: "Newer fences in good shape",
    lines: [
      { icon: Droplets, text: "Clear protection" },
      { icon: Sparkles, text: "Refreshes your fence" },
    ],
    regular: 1580, price: 1263.60,
  },
  {
    key: "signature", name: "Signature Finish", short: "Signature", tag: "Semi-transparent", lasts: "2–4 yrs",
    photos: ["/proposal-mockup/pkg-signature-a.jpg", "/proposal-mockup/pkg-signature-b.jpg"], popular: true,
    best: "Weathered fences you still want to see the grain on",
    lines: [
      { icon: Leaf, text: "Enhances the natural wood grain" },
      { icon: Paintbrush, text: "Balances protection and beauty" },
    ],
    regular: 1814, price: 1450.80,
  },
  {
    key: "legacy", name: "Legacy Finish", short: "Legacy", tag: "Premium", lasts: "4–7 yrs",
    photos: ["/proposal-mockup/pkg-legacy-a.jpg", "/proposal-mockup/pkg-legacy-b.jpg"],
    best: "Older fences that need full coverage",
    lines: [
      { icon: Shield, text: "Solid color protection" },
      { icon: Sun, text: "Maximum coverage and durability" },
    ],
    regular: 2301, price: 1840.80,
  },
];

// Repairs, priced from Alan's list (2026-10-09; posts by fence height,
// 2026-10-10).
const PICKETS = [
  { key: "pine6", label: "6 ft pine", price: 12 },
  { key: "pine8", label: "8 ft pine", price: 14 },
  { key: "cedar6", label: "6 ft cedar", price: 14 },
  { key: "cedar8", label: "8 ft cedar", price: 16 },
];
const PARTS = [
  { key: "rotboard", label: "Rot board", price: 50 },
  { key: "cap", label: "Cap", price: 85 },
  { key: "rail", label: "2x4 rail", price: 75 },
];
const POSTS = [
  { key: "post6", label: "6 ft fence", price: 225 },
  { key: "post7", label: "7 ft fence", price: 255 },
  { key: "post8", label: "8 ft fence", price: 350 },
];

// Signature colours with a real job photo (cropped from Alan's page in
// progress). The rest of the chart arrives through the photo library.
const SIGNATURE_PHOTOS = [
  { name: "Redwood Naturaltone", src: "/proposal-mockup/stain-redwood-naturaltone.jpg" },
  { name: "Cedar Naturaltone", src: "/proposal-mockup/stain-cedar-naturaltone.jpg" },
  { name: "Pecan", src: "/proposal-mockup/stain-pecan.jpg" },
  { name: "Redwood", src: "/proposal-mockup/stain-redwood.jpg" },
  { name: "Cottage Gray", src: "/proposal-mockup/stain-cottage-gray.jpg" },
  { name: "Monticello Tan", src: "/proposal-mockup/stain-monticello-tan.jpg" },
  { name: "Dark Walnut", src: "/proposal-mockup/stain-dark-walnut.jpg" },
  { name: "Chocolate Chips", src: "/proposal-mockup/stain-chocolate-chips.jpg" },
];
// Legacy solid colours: the best photo of each from the dashboard's Fence
// Photos (Valspar solid line), one per colour, as Alan picked the rule
// (2026-10-10). Served straight from the photo storage. Cedar Naturaltone
// and Midnight Gray have no photo yet.
const LEGACY_PHOTOS: { name: string; src: string; full: string }[] = [
  { name: "Simply Cedar", src: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/905d3a02-4ae0-4984-8207-01c738cfd216/b83d4972-fd3f-4196-bdea-b3f0a7270898_thumb.jpg", full: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/905d3a02-4ae0-4984-8207-01c738cfd216/b83d4972-fd3f-4196-bdea-b3f0a7270898.jpg" },
  { name: "Pine Bark", src: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/35fd7c95-2407-4bb8-ab12-c530ce523f02/cf591159-dadc-4bf8-bfce-e96984b906e8_thumb.jpg", full: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/35fd7c95-2407-4bb8-ab12-c530ce523f02/cf591159-dadc-4bf8-bfce-e96984b906e8.jpg" },
  { name: "October Brown", src: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/bb52bae5-9222-42b1-bd6a-2aa01cf4e22a/8231b4c2-0f42-459a-b568-631b81d2e1b4_thumb.jpg", full: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/bb52bae5-9222-42b1-bd6a-2aa01cf4e22a/8231b4c2-0f42-459a-b568-631b81d2e1b4.jpg" },
  { name: "Potato Skin", src: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/44a9bc64-990d-4a80-841f-f4fc2d29c3de/d70e843f-5584-4d9d-96bc-87b0b1ada5cc_thumb.jpg", full: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/44a9bc64-990d-4a80-841f-f4fc2d29c3de/d70e843f-5584-4d9d-96bc-87b0b1ada5cc.jpg" },
  { name: "Chocolate Chip", src: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/ad73d243-da98-4448-8158-646f436f0070/3a3a2501-207a-4c97-be2e-1fda6dba0bc3_thumb.jpg", full: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/ad73d243-da98-4448-8158-646f436f0070/3a3a2501-207a-4c97-be2e-1fda6dba0bc3.jpg" },
  { name: "Classic Mahogany", src: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/931bd8c6-919e-4647-8713-a60dd4359dd1/6248216e-0fc9-434e-80ae-8e7e18107b5e_thumb.jpg", full: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/931bd8c6-919e-4647-8713-a60dd4359dd1/6248216e-0fc9-434e-80ae-8e7e18107b5e.jpg" },
  { name: "Plymouth Red", src: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/52bade40-fa6c-4821-a089-1d0d1c0f7323/45f024e1-5090-4130-bfc0-23074708e99d_thumb.jpg", full: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/52bade40-fa6c-4821-a089-1d0d1c0f7323/45f024e1-5090-4130-bfc0-23074708e99d.jpg" },
  { name: "Galapagos Grey", src: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/573f331f-c1b8-4aa5-b301-c6ca83300c8f/bcc20eac-8ae7-418f-a333-da5613a3e06d_thumb.jpg", full: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/573f331f-c1b8-4aa5-b301-c6ca83300c8f/bcc20eac-8ae7-418f-a333-da5613a3e06d.jpg" },
  { name: "Silver Mine", src: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/0ad80f7d-f86e-4ace-9f18-466daf8efbe6/cf7043e7-45cc-4b04-8538-1aada511ca11_thumb.jpg", full: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/0ad80f7d-f86e-4ace-9f18-466daf8efbe6/cf7043e7-45cc-4b04-8538-1aada511ca11.jpg" },
  { name: "Darkest Night", src: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/3fdbff10-04d9-44a1-b878-f51f3e0ae197/49241180-35a4-48f5-91a9-52fa7c664ab9_thumb.jpg", full: "https://mlqaszopfpujfnjhnduz.supabase.co/storage/v1/object/public/fence-photos/3fdbff10-04d9-44a1-b878-f51f3e0ae197/49241180-35a4-48f5-91a9-52fa7c664ab9.jpg" },
];
const LEGACY_NO_PHOTO = ["Cedar Naturaltone", "Midnight Gray"];

// Affirm, the other door at checkout, in the same plain words. Numbers are
// Affirm's own published US terms; the real page links to affirm.com.
const AFFIRM_FAQ: [string, string][] = [
  ["What is Affirm?", "A way to pay for your fence over time. Smaller amounts can be split into 4 interest-free payments; bigger ones get a monthly plan. Affirm pays us in full; you pay Affirm. Manage it in the Affirm app."],
  ["How do I use it here?", "Tap \"See my options\", choose Affirm at checkout, and answer a few questions. You see your plans and the exact rate before you agree to anything."],
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

// The payment line the way PlayStation shows it with Klarna (Alan,
// 2026-10-10): "From $40/month, or 4 payments at 0% interest with Klarna.
// Learn more". Nobody at Sony works out the $40: Klarna's messaging returns
// it from Klarna's real plans for the exact amount, and on the real page
// Stripe's Payment Method Messaging Element does the same for us. Here it
// is estimated the way Klarna does: the lowest rate over the longest plan
// (7.99% APR over 24 months), rounded up to the dollar. Pay in 4 tops out
// around $2,000 a purchase.
const PAY_IN_4_MAX = 2000;
const KLARNA_LOW_APR = 0.0799;
const KLARNA_LONGEST_MONTHS = 24;
function monthlyFrom(total: number): number {
  const r = KLARNA_LOW_APR / 12;
  return Math.ceil((total * r) / (1 - Math.pow(1 + r, -KLARNA_LONGEST_MONTHS)));
}
function payLine(total: number): { text: string; lender: "klarna" } {
  const from = `From $${monthlyFrom(total)}/month`;
  if (total <= PAY_IN_4_MAX) return { text: `${from}, or 4 payments of ${formatCurrency(total / 4)} at 0% interest`, lender: "klarna" };
  return { text: from, lender: "klarna" };
}

// Klarna's FAQ, rewritten for a fence (PlayStation's is the model, Alan,
// 2026-10-10). Numbers are Klarna's own published US terms; the real page
// links to Klarna's terms for the current ones.
const KLARNA_FAQ: [string, string][] = [
  ["What is Klarna?", "A way to pay for your fence over time. Split it into 4 interest-free payments, or pick a monthly plan. Klarna pays us in full; you pay Klarna. See every payment in the Klarna app."],
  ["How do I use it here?", "Tap \"See my options\" on this proposal, choose Klarna at checkout, pick 4 payments or monthly, and enter a debit or credit card. That's it. Your dates get booked the same as paying the deposit."],
  ["What do I need?", "A US-issued debit or credit card, to be 18 or older, a phone that gets texts, and a US home address."],
  ["How do the 4 payments work?", "The first payment comes off your card today at checkout. The other three come off automatically 14, 28 and 42 days later. No interest. Klarna emails you the schedule, and may ask some customers for a larger first payment."],
  ["Is there a fee for 4 payments?", "No fee when you pay on schedule. If a payment doesn't go through, Klarna tries again; if it still fails, a late fee of up to $7 plus the missed amount is added to the next payment."],
  ["Will Klarna check my credit?", "For 4 payments, Klarna may do a soft check. It doesn't affect your credit score and doesn't show as a hard inquiry."],
  ["What are the monthly plans?", "For jobs of $200 and up. Apply at checkout and get an instant decision; applying is a soft check with no effect on your credit. Rates run from 7.99% to 29.99% APR, a down payment may be required, and late payments may be reported to the credit bureaus. No application, late or early-payoff fees. Plans are issued by WebBank, member FDIC."],
  ["What if something changes on the job?", "You paid the whole job through Klarna, so there's no deposit to think about. If the job ends up costing more (say, boards we find rotten on the day), we text you a payment link for the extra when the work is done, and you pay it any way you like: card, Apple Pay, Klarna or Affirm. If it ends up costing less, we refund the difference through Klarna and Klarna lowers what you owe on its own; allow 8 to 10 business days."],
  ["Is this a Sterling loan?", "No. Klarna is the lender and Sterling Fence Staining is paid in full when you check out. Your agreement, statements and privacy are with Klarna, not with us."],
];

const GOLD = "#C9972F";

export default function ProposalMockup() {
  const [phone, setPhone] = useState(true);
  const [withScope, setWithScope] = useState(true);
  const [pkg, setPkg] = useState<PkgKey | null>(null);
  const [palette, setPalette] = useState<"signature" | "legacy">("signature");
  const [stain, setStain] = useState<string | null>(null);
  const [switched, setSwitched] = useState<string | null>(null);
  const [picketType, setPicketType] = useState(PICKETS[0].key);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [bigPhoto, setBigPhoto] = useState<string | null>(null);
  const [colorAsk, setColorAsk] = useState("");
  const [colorSent, setColorSent] = useState(false);
  const [terms, setTerms] = useState(false);
  const [payFaq, setPayFaq] = useState<null | "klarna" | "affirm">(null);
  const [postType, setPostType] = useState(POSTS[0].key);

  const chosen = PACKAGES.find((p) => p.key === pkg) || null;
  const repairs = useMemo(() => {
    const picket = PICKETS.find((p) => p.key === picketType)!;
    const post = POSTS.find((p) => p.key === postType)!;
    let total = (counts.pickets || 0) * picket.price + (counts.posts || 0) * post.price;
    for (const part of PARTS) total += (counts[part.key] || 0) * part.price;
    return total;
  }, [counts, picketType, postType]);
  const total = (chosen?.price || 0) + repairs;
  const pay = payLine(total || PACKAGES[1].price);
  const bump = (key: string, by: number) =>
    setCounts((c) => ({ ...c, [key]: Math.max(0, (c[key] || 0) + by) }));

  const choose = (key: PkgKey) => {
    setPkg(key);
    setSwitched(null);
    if (key === "essential") setStain(null);
    else setPalette(key);
  };
  // Picking a colour picks its package too, so the colours are open to
  // everyone (Alan, 2026-10-10) and the price still follows the choice.
  const pickColor = (name: string, from: "signature" | "legacy") => {
    setStain(name);
    if (pkg !== from) {
      setPkg(from);
      setSwitched(`${name} is a ${from === "signature" ? "Signature" : "Legacy"} color, so that's your package now.`);
    } else {
      setSwitched(null);
    }
  };

  return (
    <div className="min-h-full bg-stone-200/70 pb-10">
      {/* Staff bar. Never part of the customer's page. */}
      <div className="sticky top-0 z-30 flex flex-wrap items-center gap-2 bg-ink px-3 py-2 text-ivory shadow-md">
        <Link to="/new-proposal" className="inline-flex items-center gap-1 rounded-lg bg-white/10 px-2 py-1 text-xs font-semibold hover:bg-white/20">
          <ArrowLeft className="h-3.5 w-3.5" /> Notes
        </Link>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-500/20 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-rose-200 ring-1 ring-rose-400/40">
          <Lightbulb className="h-3 w-3" /> Mockup · nothing here is sent to anyone
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={() => setWithScope((v) => !v)}
            className="rounded-lg bg-white/10 px-2 py-1 text-[11px] font-semibold hover:bg-white/20">
            {withScope ? "With scope drawing" : "No scope drawing"}
          </button>
          <button type="button" onClick={() => setPhone((v) => !v)} title="Phone or full width"
            className="inline-flex items-center gap-1 rounded-lg bg-white/10 px-2 py-1 text-[11px] font-semibold hover:bg-white/20">
            {phone ? <Smartphone className="h-3.5 w-3.5" /> : <Monitor className="h-3.5 w-3.5" />}
            {phone ? "Phone" : "Full"}
          </button>
        </div>
      </div>

      {/* The customer's page. Explicit colours so the dashboard's dark mode
          can never change it. */}
      <div className={cn("mx-auto mt-4 overflow-hidden bg-[#F8F3E7] text-[#15130F] shadow-2xl shadow-black/30",
        phone ? "max-w-[430px] rounded-[2rem] ring-8 ring-stone-800" : "max-w-3xl rounded-2xl")}>
        {/* Top bar */}
        <div className="flex items-center justify-between gap-3 bg-[#15130F] px-4 py-3">
          <img src="/sterling-logo-dark.png" alt="Sterling Fence Staining" className="h-8 w-auto" draggable={false} />
          <a href="tel:+13465897877" className="inline-flex h-10 items-center gap-2 rounded-full px-4 text-sm font-bold text-[#15130F] shadow-md" style={{ background: GOLD }}>
            <Phone className="h-4 w-4" /> Call or text
          </a>
        </div>

        {/* Cover */}
        <section className="relative">
          <img src="/proposal-mockup/hero-family.jpg" alt="" className="h-60 w-full object-cover" draggable={false} />
          <div className="absolute inset-0 bg-gradient-to-t from-[#15130F] via-[#15130F]/40 to-transparent" />
          <div className="absolute inset-x-0 bottom-0 p-4 text-white">
            <p className="text-[11px] font-bold uppercase tracking-[0.2em]" style={{ color: "#E3BE63" }}>Fence restoration proposal</p>
            <h1 className="font-heading text-3xl font-bold leading-tight">Hi {CUSTOMER.name.split(" ")[0]}, here's your fence plan.</h1>
          </div>
        </section>
        <section className="grid grid-cols-2 gap-x-3 gap-y-2 border-b border-[#15130F]/10 px-4 py-3 text-xs">
          <Fact icon={UserRound} label="Prepared for">{CUSTOMER.name}</Fact>
          <Fact icon={Calendar} label="Date">{CUSTOMER.date}</Fact>
          <Fact icon={MapPin} label="Property" wide>{CUSTOMER.address}</Fact>
          <Fact icon={Hash} label="Proposal #">{CUSTOMER.number}</Fact>
          <Fact icon={Eye} label="Price good through">{CUSTOMER.goodThrough}</Fact>
        </section>

        {/* Your fence: the scope drawing when we have one, the sides list when we don't. */}
        <section className="px-4 py-5">
          <SectionTitle kicker="Step 1" title="Your fence" />
          {withScope ? (
            <>
              <ScopeDrawing />
              <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 ring-1 ring-[#15130F]/10"><span className="h-2.5 w-6 rounded-full bg-blue-600" /> Blue = inside face</span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 ring-1 ring-[#15130F]/10"><span className="h-2.5 w-6 rounded-full bg-red-600" /> Red = both faces</span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[#15130F] px-3 py-1.5 text-[#E3BE63]">About {CUSTOMER.feet} ft</span>
              </div>
              <p className="mt-2 text-sm text-[#15130F]/70">This is what we'd stain. Not right? Tap Call or text at the top.</p>
            </>
          ) : (
            // No drawing for this customer: the size and the sides, in words.
            <div className="rounded-2xl bg-white p-4 ring-1 ring-[#15130F]/10">
              <p className="font-heading text-2xl font-bold leading-tight">About {CUSTOMER.feet} ft of fence</p>
              <p className="mt-1 text-[11px] font-bold uppercase tracking-wider text-[#8C6224]">Sides included in the price</p>
              <ul className="mt-1.5 space-y-1.5">
                {CUSTOMER.sides.map((s) => (
                  <li key={s} className="flex items-center gap-2 text-base font-semibold"><Check className="h-4 w-4" style={{ color: GOLD }} /> {s}</li>
                ))}
              </ul>
              <p className="mt-2 text-sm text-[#15130F]/70">Not right? Tap Call or text at the top.</p>
            </div>
          )}
        </section>

        {/* Packages. All three on one screen, no scrolling (Alan,
            2026-10-10). On a phone that is a compare grid: the photos across
            the top, then short rows that line up — lasts, price, best for,
            what you get — and three Pick buttons. At full width, three cards
            that each carry the whole story, the way a pricing page does. */}
        <section className="bg-white px-3 py-6 sm:px-4">
          <div className="px-1">
            <SectionTitle kicker="Step 2" title="Pick your package" sub="Same expert service. Three levels of protection." />
          </div>
          <p className="mb-3 flex items-center gap-2 rounded-xl bg-[#F8F3E7] px-3 py-2 text-xs font-semibold ring-1 ring-[#C9972F]/40">
            <Shield className="h-4 w-4 shrink-0" style={{ color: "#8C6224" }} />
            Every package: two coats of stain and a 1-year workmanship warranty.
          </p>

          {phone ? (() => {
            // Three photo tiles, always in view, name and price on each; the
            // one they tap (Signature until they do) opens in full below.
            // Pictures first, then words (Alan, 2026-10-10: "make the three
            // packages look most appealing for somebody on their phone").
            const show = chosen || PACKAGES[1];
            const line = payLine(show.price);
            return (
              <>
                <div className="grid grid-cols-3 gap-2">
                  {PACKAGES.map((p) => {
                    const on = pkg === p.key;
                    const shown = show.key === p.key;
                    return (
                      <button key={p.key} type="button" onClick={() => choose(p.key)}
                        className={cn("relative aspect-[3/4.4] overflow-hidden rounded-2xl text-left shadow-lg transition active:scale-[0.97]",
                          on ? "ring-4 ring-[#C9972F]" : shown ? "ring-2 ring-[#C9972F]/60" : "ring-1 ring-[#15130F]/10")}>
                        <div className={cn("absolute inset-0 grid gap-px bg-[#15130F]", p.photos.length > 1 && "grid-rows-2")}>
                          {p.photos.map((src) => <img key={src} src={src} alt="" className="h-full w-full object-cover" draggable={false} />)}
                        </div>
                        <div className="absolute inset-x-0 bottom-0 h-[62%] bg-gradient-to-t from-[#15130F] via-[#15130F]/75 to-transparent" />
                        {p.popular ? (
                          <span className="absolute left-1.5 top-1.5 rounded-full px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-[#15130F] shadow" style={{ background: GOLD }}>
                            <Star className="mr-0.5 inline h-2.5 w-2.5 fill-current" />Popular
                          </span>
                        ) : null}
                        {on ? (
                          <span className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-[#15130F] text-[#E3BE63] ring-2 ring-[#C9972F]"><Check className="h-3.5 w-3.5" /></span>
                        ) : null}
                        <div className="absolute inset-x-0 bottom-0 p-2 text-white">
                          <p className="text-[8px] font-bold uppercase tracking-[0.15em]" style={{ color: "#E3BE63" }}>{p.tag}</p>
                          <p className="font-heading text-[15px] font-bold leading-tight">{p.short}</p>
                          <p className="mt-0.5 text-[13px] font-bold tabular-nums">{formatCurrency(p.price)}</p>
                          <p className="text-[8px] text-white/70">Lasts {p.lasts}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div key={show.key} className="mt-3 overflow-hidden rounded-2xl bg-white shadow-md ring-1 ring-[#15130F]/10">
                  <div className="flex items-start justify-between gap-2 px-4 pt-4">
                    <div className="min-w-0">
                      <h3 className="font-heading text-2xl font-bold leading-tight">{show.name}</h3>
                      <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-[#8C6224]">{show.tag} · Lasts {show.lasts}</p>
                    </div>
                    {!chosen ? <span className="shrink-0 rounded-full bg-[#F8F3E7] px-2 py-1 text-[10px] font-bold ring-1 ring-[#C9972F]/50">Most popular</span> : null}
                  </div>
                  <div className="p-4 pt-3">
                    <div className="rounded-xl bg-[#F8F3E7] px-3 py-2 ring-1 ring-[#C9972F]/30">
                      <p className="text-[9px] font-bold uppercase tracking-wider text-[#8C6224]">Best for</p>
                      <p className="text-sm font-semibold leading-snug">{show.best}</p>
                    </div>
                    <ul className="mt-3 space-y-1.5">
                      {show.lines.map((l) => {
                        const Icon = l.icon;
                        return <li key={l.text} className="flex items-center gap-2 text-sm font-medium"><Icon className="h-4 w-4 shrink-0" style={{ color: "#8C6224" }} />{l.text}</li>;
                      })}
                    </ul>
                    <div className="mt-3 rounded-xl bg-[#15130F] px-3 py-2.5 text-white">
                      <p className="text-[10px] text-white/60"><s>{formatCurrency(show.regular)}</s> <span className="ml-1 font-bold text-emerald-300">20% off</span> · ends {CUSTOMER.goodThrough}</p>
                      <p className="font-heading text-3xl font-bold leading-none">{formatCurrency(show.price)}</p>
                      <p className="mt-1.5 flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: "#E3BE63" }}>
                        {line.lender === "klarna"
                          ? <span className="rounded bg-[#FFB3C7] px-1 text-[10px] font-black text-black">Klarna.</span>
                          : <img src="/affirm-white.png" alt="Affirm" className="h-2.5 w-auto" draggable={false} />}
                        or {line.text} with Klarna. <LearnMore onClick={() => setPayFaq("klarna")} dark />
                      </p>
                    </div>
                    <button type="button" onClick={() => choose(show.key)}
                      className={cn("mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-xl text-base font-bold transition active:scale-[0.98]",
                        chosen ? "bg-[#15130F] text-[#E3BE63]" : "text-[#15130F] shadow-md")}
                      style={chosen ? undefined : { background: GOLD }}>
                      {chosen ? <><Check className="h-5 w-5" /> {show.short} picked</> : `Pick ${show.short}`}
                    </button>
                  </div>
                </div>
              </>
            );
          })() : (
            <div className="grid gap-3 sm:grid-cols-3">
              {PACKAGES.map((p) => {
                const on = pkg === p.key;
                const line = payLine(p.price);
                return (
                  <div key={p.key} className={cn("flex flex-col overflow-hidden rounded-2xl bg-white shadow-md transition",
                    on ? "ring-4 ring-[#C9972F]" : p.popular ? "ring-2 ring-[#C9972F]/70" : "ring-1 ring-[#15130F]/10")}>
                    <div className="relative">
                      <div className={cn("grid gap-0.5", p.photos.length > 1 && "grid-cols-2")}>
                        {p.photos.map((src, i) => (
                          <div key={src} className="relative">
                            <img src={src} alt="" className="h-40 w-full object-cover" draggable={false} />
                            {p.captions?.[i] ? (
                              <span className="absolute bottom-1.5 left-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white">{p.captions[i]}</span>
                            ) : null}
                          </div>
                        ))}
                      </div>
                      <span className="absolute left-2 top-2 rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white shadow">20% off</span>
                      {p.popular ? (
                        <span className="absolute right-2 top-2 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-[#15130F] shadow" style={{ background: GOLD }}>
                          <Star className="mr-1 inline h-3 w-3 fill-current" />Most popular
                        </span>
                      ) : null}
                    </div>
                    <div className="flex flex-1 flex-col p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <h3 className="font-heading text-2xl font-bold leading-tight">{p.name}</h3>
                          <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-[#8C6224]">{p.tag}</p>
                        </div>
                        <span className="shrink-0 rounded-full bg-[#F8F3E7] px-2 py-1 text-[10px] font-bold ring-1 ring-[#C9972F]/50">Lasts {p.lasts}</span>
                      </div>
                      <div className="mt-3 rounded-xl bg-[#F8F3E7] px-3 py-2 ring-1 ring-[#C9972F]/30">
                        <p className="text-[9px] font-bold uppercase tracking-wider text-[#8C6224]">Best for</p>
                        <p className="text-sm font-semibold leading-snug">{p.best}</p>
                      </div>
                      <div className="mt-3 flex items-baseline gap-2">
                        <p className="font-heading text-3xl font-bold leading-none">{formatCurrency(p.price)}</p>
                        <s className="text-sm text-[#15130F]/50">{formatCurrency(p.regular)}</s>
                      </div>
                      <p className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-[#15130F]/75">
                        {line.lender === "klarna"
                          ? <span className="rounded bg-[#FFB3C7] px-1 text-[10px] font-black text-black">Klarna.</span>
                          : <span className="rounded bg-[#15130F] px-1 py-0.5"><img src="/affirm-white.png" alt="Affirm" className="h-2.5 w-auto" draggable={false} /></span>}
                        {line.text} with Klarna. <LearnMore onClick={() => setPayFaq("klarna")} />
                      </p>
                      <ul className="mt-3 flex-1 space-y-1.5">
                        {p.lines.map((l) => (
                          <li key={l.text} className="flex items-start gap-2 text-sm"><Check className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "#8C6224" }} />{l.text}</li>
                        ))}
                      </ul>
                      <button type="button" onClick={() => choose(p.key)}
                        className={cn("mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-xl text-base font-bold transition active:scale-[0.98]",
                          on ? "bg-[#15130F] text-[#E3BE63]" : "text-[#15130F] shadow-md")}
                        style={on ? undefined : { background: GOLD }}>
                        {on ? <><Check className="h-5 w-5" /> {p.short} picked</> : `Pick ${p.short}`}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <p className="mt-3 text-center text-xs text-[#15130F]/60">Choose based on the condition of your wood and the look you want.</p>
        </section>

        {/* Colours: always on show, in two tabs, so nobody has to pick a
            package to browse (Alan, 2026-10-10). */}
        <section id="mock-color" className="scroll-mt-14 px-4 py-6">
          <SectionTitle kicker="Step 3" title="Pick your color" sub="Essential is a clear coat. Signature and Legacy come in these." />
          <div className="mb-3 grid grid-cols-2 gap-1 rounded-xl bg-white p-1 ring-1 ring-[#15130F]/10">
            {([["signature", `Signature · ${SIGNATURE_PHOTOS.length} photos`], ["legacy", `Legacy · ${LEGACY_PHOTOS.length} photos`]] as const).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setPalette(k)}
                className={cn("h-9 rounded-lg text-xs font-bold transition", palette === k ? "bg-[#15130F] text-[#E3BE63]" : "text-[#15130F]/70")}>
                {label}
              </button>
            ))}
          </div>
          {palette === "signature" ? (
            <>
              <div className="grid grid-cols-4 gap-1.5">
                {SIGNATURE_PHOTOS.map((c) => {
                  const on = stain === c.name;
                  return (
                    <div key={c.name} className={cn("relative overflow-hidden rounded-xl bg-white shadow-sm transition", on ? "ring-[3px] ring-[#C9972F]" : "ring-1 ring-[#15130F]/10")}>
                      <button type="button" onClick={() => pickColor(c.name, "signature")} className="block w-full text-left">
                        <img src={c.src} alt={c.name} className="h-16 w-full object-cover" draggable={false} />
                        <span className="flex items-center justify-between gap-0.5 px-1.5 py-1">
                          <span className="text-[9px] font-bold leading-tight">{c.name}</span>
                          {on ? <Check className="h-3 w-3 shrink-0" style={{ color: "#8C6224" }} /> : null}
                        </span>
                      </button>
                      <button type="button" onClick={() => setBigPhoto(c.src)} aria-label={`See ${c.name} bigger`}
                        className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-md bg-black/50 text-white">
                        <Expand className="h-3 w-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
              <p className="mt-2 text-[11px] text-[#15130F]/60">Real fences we stained. Tap the corner to see one bigger. More colors as photos are added.</p>
            </>
          ) : (
            <>
              <div className="grid grid-cols-4 gap-1.5">
                {LEGACY_PHOTOS.map((c) => {
                  const on = stain === c.name;
                  return (
                    <div key={c.name} className={cn("relative overflow-hidden rounded-xl bg-white shadow-sm transition", on ? "ring-[3px] ring-[#C9972F]" : "ring-1 ring-[#15130F]/10")}>
                      <button type="button" onClick={() => pickColor(c.name, "legacy")} className="block w-full text-left">
                        <img src={c.src} alt={c.name} className="h-16 w-full object-cover" loading="lazy" draggable={false} />
                        <span className="flex items-center justify-between gap-0.5 px-1.5 py-1">
                          <span className="text-[9px] font-bold leading-tight">{c.name}</span>
                          {on ? <Check className="h-3 w-3 shrink-0" style={{ color: "#8C6224" }} /> : null}
                        </span>
                      </button>
                      <button type="button" onClick={() => setBigPhoto(c.full)} aria-label={`See ${c.name} bigger`}
                        className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-md bg-black/50 text-white">
                        <Expand className="h-3 w-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
              <p className="mt-2 text-[11px] text-[#15130F]/60">Solid colors on real fences we stained. Tap the corner to see one bigger. {LEGACY_NO_PHOTO.join(" and ")}: photos coming.</p>
            </>
          )}
          {stain ? (
            <p className="mt-3 rounded-xl bg-[#15130F] px-3 py-2 text-sm font-semibold text-[#E3BE63]">
              <Check className="mr-1 inline h-4 w-4" /> {stain} it is. {switched || "You can change this any time."}
            </p>
          ) : null}

          {/* The colour they want isn't here. */}
          <div className="mt-4 rounded-2xl bg-white p-3 ring-1 ring-[#15130F]/10">
            <p className="flex items-center gap-2 text-sm font-bold"><MessageSquare className="h-4 w-4" style={{ color: "#8C6224" }} /> Don't see your color?</p>
            <p className="mt-0.5 text-xs text-[#15130F]/65">Tell us what you have in mind and we'll find it for you.</p>
            {colorSent ? (
              <p className="mt-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800"><Check className="mr-1 inline h-4 w-4" /> Got it. We'll text you some options.</p>
            ) : (
              <div className="mt-2 flex gap-2">
                <input value={colorAsk} onChange={(e) => setColorAsk(e.target.value)} placeholder="A gray-brown like my neighbor's…"
                  className="h-11 min-w-0 flex-1 rounded-xl border border-[#15130F]/15 bg-[#F8F3E7] px-3 text-sm" />
                <button type="button" onClick={() => colorAsk.trim() && setColorSent(true)} className="h-11 rounded-xl px-4 text-sm font-bold text-[#15130F]" style={{ background: GOLD }}>Send</button>
              </div>
            )}
          </div>
        </section>

        {/* Repairs */}
        <section className="bg-white px-4 py-6">
          <SectionTitle kicker="Optional" title="Anything need replacing?" sub="Count it up. We bring the wood." />
          <div className="space-y-2.5">
            <Counter label="Pickets" price={PICKETS.find((p) => p.key === picketType)!.price} n={counts.pickets || 0} onChange={(d) => bump("pickets", d)}>
              <select value={picketType} onChange={(e) => setPicketType(e.target.value)} className="h-8 rounded-lg border border-[#15130F]/15 bg-white px-2 text-xs font-semibold">
                {PICKETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </Counter>
            {PARTS.map((part) => (
              <Counter key={part.key} label={part.label} price={part.price} n={counts[part.key] || 0} onChange={(d) => bump(part.key, d)} />
            ))}
            <Counter label="Post replacement" price={POSTS.find((p) => p.key === postType)!.price} n={counts.posts || 0} onChange={(d) => bump("posts", d)}>
              <select value={postType} onChange={(e) => setPostType(e.target.value)} className="h-8 rounded-lg border border-[#15130F]/15 bg-white px-2 text-xs font-semibold">
                {POSTS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </Counter>
          </div>
          <div className="mt-3 flex items-center justify-between rounded-xl bg-[#15130F] px-4 py-3 text-white">
            <span className="flex items-center gap-2 text-sm font-semibold"><Hammer className="h-4 w-4" style={{ color: "#E3BE63" }} /> Repairs</span>
            <span className="font-heading text-xl font-bold tabular-nums">{repairs ? `+ ${formatCurrency(repairs)}` : "$0"}</span>
          </div>
        </section>

        {/* What you get */}
        <section className="px-4 py-6">
          <SectionTitle kicker="Every job" title="What you get" />
          <div className={cn("grid gap-3", !phone && "sm:grid-cols-2")}>
            <List title="We prep it right" icon={Leaf} items={[
              ["Full prep wash", "Mold, mildew, dirt and gray weathering come off first."],
              ["Premium stain", "Professional-grade, picked for Texas sun."],
              ["Two coats", "With attention to boards, edges and details."],
              ["Hardware stays clean", "We keep stain off your black hinges and latches."],
              ["Clean jobsite", "Labor and cleanup included."],
            ]} />
            <List title="Why people pick us" icon={Shield} items={[
              ["1-year workmanship warranty", "If our work peels or cracks, we come back and fix it."],
              ["5.0 on Google", "Trusted by homeowners who want it done right."],
              ["1,500+ fences restored", "Across the Houston area."],
              ["7+ years", "Hands-on experience staining wood fences."],
            ]} />
          </div>
          <div className="mt-3 flex items-start gap-3 rounded-2xl bg-emerald-800 p-4 text-white">
            <Users className="mt-0.5 h-6 w-6 shrink-0" style={{ color: "#E3BE63" }} />
            <div>
              <p className="font-heading text-lg font-bold leading-tight">Know a neighbor who needs it too?</p>
              <p className="mt-1 text-sm text-white/85">You both get an extra $100 off. No deadline. Just tell us.</p>
            </div>
          </div>
        </section>

        {/* Reviews */}
        <section className="bg-white px-4 py-6">
          <SectionTitle kicker="Google reviews" title="5.0 out of 5" />
          <div className="space-y-2">
            {[
              ["Sample review", "Fence looks brand new. Crew was on time and cleaned up after. Sample text until real reviews are pulled in."],
              ["Sample review", "Picked Signature in Cedar Naturaltone and it came out exactly like the photo. Sample text."],
            ].map(([who, text], i) => (
              <blockquote key={i} className="rounded-2xl bg-[#F8F3E7] p-3 ring-1 ring-[#15130F]/10">
                <p className="flex gap-0.5">{[0, 1, 2, 3, 4].map((n) => <Star key={n} className="h-3.5 w-3.5 fill-current" style={{ color: GOLD }} />)}</p>
                <p className="mt-1 text-sm">{text}</p>
                <p className="mt-1 text-[11px] font-semibold text-[#15130F]/60">{who}</p>
              </blockquote>
            ))}
          </div>
        </section>

        {/* How to pay: the deposit, or the whole job over time. Both go to
            the same Stripe checkout; Klarna and Affirm are picked there. */}
        <section id="mock-pay" className="scroll-mt-14 px-4 py-6">
          <SectionTitle kicker="Step 4" title="How would you like to pay?" sub={chosen ? `${chosen.name}${repairs ? " plus repairs" : ""}: ${formatCurrency(total)}` : "Pick a package first and your numbers fill in."} />
          {/* The 20% off ends with the month and the price goes back up. Booking
              now locks it even if the job happens later; paying over time is
              how someone does that without the cash today (Alan, 2026-10-10). */}
          <div className="mb-3 flex items-start gap-2.5 rounded-xl bg-[#F8F3E7] px-3 py-2.5 ring-1 ring-[#C9972F]/50">
            <Calendar className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "#8C6224" }} />
            <p className="text-xs leading-snug"><span className="font-bold">Your 20% off ends {CUSTOMER.goodThrough}.</span> Book now and this price is locked, even if we do the job next month. Paying over time means you don't need the money today.</p>
          </div>
          <div className="space-y-3">
            <div className="rounded-2xl bg-[#15130F] p-4 text-white ring-1 ring-[#C9972F]/50">
              <p className="flex items-center gap-2 font-heading text-lg font-bold"><Home className="h-5 w-5" style={{ color: "#E3BE63" }} /> Reserve my dates</p>
              <p className="mt-1 text-sm text-white/80"><span className="font-bold text-white">$250 today</span> books your spot. The rest, {chosen ? formatCurrency(Math.max(0, total - 250)) : "the balance"}, is due when the job is done and you're happy.</p>
              <button type="button" className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-xl text-base font-bold text-[#15130F] shadow-lg active:scale-[0.98]" style={{ background: GOLD }}>
                <CreditCard className="h-5 w-5" /> Reserve my spot · $250
              </button>
              <p className="mt-2 text-center text-[10px] text-white/55">Card, Apple Pay or Google Pay. The deposit is not refundable once your dates are set.</p>
            </div>
            <div className="rounded-2xl bg-white p-4 ring-1 ring-[#15130F]/10">
              <p className="flex items-center gap-2 font-heading text-lg font-bold"><Calendar className="h-5 w-5" style={{ color: "#8C6224" }} /> Or pay over time</p>
              <p className="mt-1 text-xs text-[#15130F]/65">Were you going to do this in a month or two anyway? Lock in today's price and spread the payments.</p>
              <div className="mt-2 space-y-2">
                <PayOption lender="klarna" text={`${payLine(total || PACKAGES[1].price).text} with Klarna`} note="Pick 4 payments or a monthly plan at checkout." learn={() => setPayFaq("klarna")} />
                <PayOption lender="affirm" text="Affirm: 4 payments or monthly plans" note="Also offered at checkout. 3 to 36 months, the rate shown before you agree." learn={() => setPayFaq("affirm")} />
              </div>
              <button type="button" className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#15130F] text-base font-bold text-[#E3BE63] active:scale-[0.98]">
                See my options
              </button>
              <p className="mt-2 text-center text-[10px] text-[#15130F]/55">Pick Klarna or Affirm on the next screen. Checking takes a minute and doesn't affect your credit score.</p>
            </div>
          </div>
        </section>

        {/* Footer links */}
        <section className="px-4 pb-28">
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="flex h-11 items-center justify-center gap-2 rounded-xl bg-white text-sm font-semibold ring-1 ring-[#15130F]/15"><Download className="h-4 w-4" /> Save as PDF</button>
            <button type="button" onClick={() => setTerms(true)} className="flex h-11 items-center justify-center gap-2 rounded-xl bg-white text-sm font-semibold ring-1 ring-[#15130F]/15"><FileText className="h-4 w-4" /> Terms</button>
          </div>
          <p className="mt-4 text-center text-xs text-[#15130F]/55">Sterling Fence Staining · Cypress, TX · 346-589-7877</p>
        </section>

        {/* Sticky bottom: the one thing to do. */}
        <div className={cn("sticky bottom-0 z-20 border-t border-[#C9972F]/40 bg-[#15130F] p-3 text-white", phone && "rounded-b-[1.6rem]")}>
          {chosen ? (
            <div className="flex items-end justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-xs text-white/70">{chosen.name}{stain ? ` · ${stain}` : ""}{repairs ? " · repairs" : ""}</p>
                <p className="font-heading text-2xl font-bold leading-none tabular-nums">{formatCurrency(total)}</p>
                <button type="button" onClick={() => document.getElementById("mock-pay")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                  className="mt-0.5 text-[11px] font-semibold underline underline-offset-2" style={{ color: "#E3BE63" }}>
                  or {pay.text} with Klarna
                </button>
              </div>
              <button type="button" onClick={() => document.getElementById("mock-pay")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                className="flex h-12 shrink-0 items-center gap-2 rounded-xl px-4 text-sm font-bold text-[#15130F] shadow-lg active:scale-[0.98]" style={{ background: GOLD }}>
                <Home className="h-4 w-4" /> Reserve · $250
              </button>
            </div>
          ) : (
            <p className="py-2 text-center text-sm font-semibold text-white/85">Pick a package or a color to see your total.</p>
          )}
        </div>
      </div>

      {bigPhoto ? (
        <button type="button" onClick={() => setBigPhoto(null)} className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4">
          <img src={bigPhoto} alt="" className="max-h-full max-w-full rounded-2xl shadow-2xl" />
        </button>
      ) : null}

      {/* Pay over time, explained the way PlayStation explains Klarna, for
          both lenders, with the two side by side at the top. */}
      {payFaq ? (() => {
        const faq = payFaq === "klarna" ? KLARNA_FAQ : AFFIRM_FAQ;
        return (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4" onClick={() => setPayFaq(null)}>
            <div className="flex max-h-[90vh] w-full max-w-md flex-col rounded-t-3xl bg-[#F8F3E7] text-[#15130F] shadow-2xl sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
              <div className="px-5 pt-5">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#8C6224]">Pay over time</p>
                <h3 className="font-heading text-xl font-bold leading-tight">Two ways to spread it out</h3>
                <div className="mt-3 grid grid-cols-2 gap-1 rounded-xl bg-white p-1 ring-1 ring-[#15130F]/10">
                  <button type="button" onClick={() => setPayFaq("klarna")}
                    className={cn("flex h-10 items-center justify-center rounded-lg text-sm font-black transition", payFaq === "klarna" ? "bg-[#FFB3C7] text-black" : "text-[#15130F]/60")}>Klarna.</button>
                  <button type="button" onClick={() => setPayFaq("affirm")}
                    className={cn("flex h-10 items-center justify-center rounded-lg transition", payFaq === "affirm" ? "bg-[#15130F]" : "opacity-50")}>
                    <img src="/affirm-white.png" alt="Affirm" className={cn("h-4 w-auto", payFaq !== "affirm" && "invert")} draggable={false} />
                  </button>
                </div>
              </div>
              <div className="mt-3 flex-1 space-y-3 overflow-y-auto px-5 pb-2">
                <div className="overflow-hidden rounded-2xl bg-white ring-1 ring-[#15130F]/10">
                  <div className="grid grid-cols-[1.2fr_1fr_1fr] bg-[#15130F] px-3 py-1.5 text-[9px] font-bold uppercase tracking-wider text-white/80">
                    <span>Compare</span><span className={cn(payFaq === "klarna" && "text-[#E3BE63]")}>Klarna</span><span className={cn(payFaq === "affirm" && "text-[#E3BE63]")}>Affirm</span>
                  </div>
                  {LENDER_COMPARE.map(([label, k, a]) => (
                    <div key={label} className="grid grid-cols-[1.2fr_1fr_1fr] gap-2 border-t border-[#15130F]/5 px-3 py-1.5 text-[11px] leading-snug">
                      <span className="font-bold">{label}</span>
                      <span className={cn(payFaq === "klarna" ? "font-semibold" : "text-[#15130F]/60")}>{k}</span>
                      <span className={cn(payFaq === "affirm" ? "font-semibold" : "text-[#15130F]/60")}>{a}</span>
                    </div>
                  ))}
                </div>
                {faq.map(([q, a]) => (
                  <div key={q} className="rounded-2xl bg-white p-3 ring-1 ring-[#15130F]/10">
                    <p className="text-sm font-bold leading-snug">{q}</p>
                    <p className="mt-1 text-sm leading-relaxed text-[#15130F]/80">{a}</p>
                  </div>
                ))}
                <p className="px-1 text-[11px] leading-snug text-[#15130F]/55">
                  {payFaq === "klarna"
                    ? "Klarna's current terms, privacy policy and customer service are on klarna.com and in the Klarna app. They are Klarna's, not Sterling Fence Staining's."
                    : "Affirm's current terms, lending partners and customer service are on affirm.com and in the Affirm app. They are Affirm's, not Sterling Fence Staining's."}
                </p>
              </div>
              <div className="p-5 pt-3">
                <button type="button" onClick={() => setPayFaq(null)} className="h-12 w-full rounded-xl text-base font-bold text-[#15130F]" style={{ background: GOLD }}>Got it</button>
              </div>
            </div>
          </div>
        );
      })() : null}

      {/* The terms, in plain words (Alan, 2026-10-10). */}
      {terms ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4" onClick={() => setTerms(false)}>
          <div className="w-full max-w-md rounded-t-3xl bg-[#F8F3E7] p-5 text-[#15130F] shadow-2xl sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#8C6224]">The fine print, without the fine print</p>
            <h3 className="font-heading text-2xl font-bold leading-tight">1-year workmanship warranty</h3>
            <div className="mt-3 space-y-3 text-sm leading-relaxed">
              <p><span className="font-bold">What we cover.</span> If the stain peels or cracks because of how we applied it, we come back and touch it up. Free, for one year from the day we finish.</p>
              <p><span className="font-bold">What we don't.</span> Damage from anything other than our work: a mower or trimmer hitting the fence, a board you replaced, scrapes, pets, sprinklers, a neighbor's project. That part is on you.</p>
              <p><span className="font-bold">We still help.</span> If something like that happens, we'll tell you the exact stain name so you can pick it up at the store nearest you and touch it up to match.</p>
              <p><span className="font-bold">The deposit.</span> $250 books your dates and is not refundable once they're set. The rest is due when the job is done and you're happy.</p>
              <p><span className="font-bold">This price</span> is good through {CUSTOMER.goodThrough}.</p>
            </div>
            <button type="button" onClick={() => setTerms(false)} className="mt-4 h-12 w-full rounded-xl text-base font-bold text-[#15130F]" style={{ background: GOLD }}>Got it</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Pieces ─────────────────────────────────────────────────────────────

function SectionTitle({ kicker, title, sub }: { kicker: string; title: string; sub?: string }) {
  return (
    <div className="mb-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#8C6224]">{kicker}</p>
      <h2 className="font-heading text-2xl font-bold leading-tight">{title}</h2>
      {sub ? <p className="mt-0.5 text-sm text-[#15130F]/65">{sub}</p> : null}
    </div>
  );
}

function Fact({ icon: Icon, label, children, wide }: { icon: React.ElementType; label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={cn("flex items-start gap-2", wide && "col-span-2")}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: "#8C6224" }} />
      <div className="min-w-0">
        <p className="text-[9px] font-bold uppercase tracking-wider text-[#15130F]/55">{label}</p>
        <p className="truncate text-sm font-semibold">{children}</p>
      </div>
    </div>
  );
}

/** A lender's line the way the lender writes it, with its mark. Klarna's
 *  pink pill and Affirm's wordmark are stand-ins until the real badges are
 *  pulled from Stripe's messaging element. */
function LearnMore({ onClick, dark }: { onClick: () => void; dark?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={cn("font-bold underline underline-offset-2", dark ? "text-[#E3BE63]" : "text-[#8C6224]")}>
      Learn more
    </button>
  );
}

function PayOption({ lender, text, note, dim, learn }: { lender: "klarna" | "affirm"; text: string; note: string; dim?: boolean; learn?: () => void }) {
  return (
    <div className={cn("flex items-center gap-3 rounded-xl bg-[#F8F3E7] px-3 py-2", dim && "opacity-50")}>
      {lender === "klarna"
        ? <span className="flex h-7 w-16 shrink-0 items-center justify-center rounded-md bg-[#FFB3C7] text-[13px] font-black tracking-tight text-black">Klarna.</span>
        : <span className="flex h-7 w-16 shrink-0 items-center justify-center rounded-md bg-[#15130F]"><img src="/affirm-white.png" alt="Affirm" className="h-4 w-auto" draggable={false} /></span>}
      <div className="min-w-0">
        <p className="text-sm font-bold leading-tight">{text}</p>
        <p className="text-[11px] text-[#15130F]/60">{dim ? "Over the pay-in-4 limit for this amount." : note}{learn ? <> <LearnMore onClick={learn} /></> : null}</p>
      </div>
    </div>
  );
}

function Counter({ label, price, n, onChange, children }: {
  label: string; price: number; n: number; onChange: (delta: number) => void; children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-[#F8F3E7] px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold">{label}</p>
        <p className="text-[11px] text-[#15130F]/60">{formatCurrency(price)} each</p>
        {children ? <div className="mt-1">{children}</div> : null}
      </div>
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => onChange(-1)} className="flex h-10 w-10 items-center justify-center rounded-xl bg-white ring-1 ring-[#15130F]/15 active:scale-95" aria-label={`One less ${label}`}><Minus className="h-4 w-4" /></button>
        <span className="w-8 text-center font-heading text-xl font-bold tabular-nums">{n}</span>
        <button type="button" onClick={() => onChange(1)} className="flex h-10 w-10 items-center justify-center rounded-xl text-[#15130F] active:scale-95" style={{ background: GOLD }} aria-label={`One more ${label}`}><Plus className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

function List({ title, icon: Icon, items }: { title: string; icon: React.ElementType; items: [string, string][] }) {
  return (
    <div className="rounded-2xl bg-white p-4 ring-1 ring-[#15130F]/10">
      <p className="mb-2 flex items-center gap-2 font-heading text-lg font-bold"><Icon className="h-5 w-5" style={{ color: "#8C6224" }} /> {title}</p>
      <ul className="space-y-2">
        {items.map(([head, body]) => (
          <li key={head} className="flex items-start gap-2">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[#15130F]" style={{ background: GOLD }}><Check className="h-3 w-3" /></span>
            <span><span className="text-sm font-bold">{head}</span><br /><span className="text-xs text-[#15130F]/65">{body}</span></span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A stand-in for the real scope drawing: the lot from above, the house, and
 *  the fence runs in the editor's colours. The real one is the customer's
 *  satellite photo with the traced lines. */
function ScopeDrawing() {
  return (
    <div className="overflow-hidden rounded-2xl ring-1 ring-[#15130F]/10">
      <svg viewBox="0 0 400 260" className="block w-full" role="img" aria-label="Scope drawing">
        <defs>
          <pattern id="grass" width="8" height="8" patternUnits="userSpaceOnUse">
            <rect width="8" height="8" fill="#6b8f4e" />
            <circle cx="2" cy="2" r="0.8" fill="#5c7f42" /><circle cx="6" cy="6" r="0.8" fill="#79a05a" />
          </pattern>
        </defs>
        <rect width="400" height="260" fill="url(#grass)" />
        <rect x="0" y="212" width="400" height="48" fill="#8f8f8a" />
        <rect x="0" y="232" width="400" height="2" fill="#f1f1ea" opacity="0.6" />
        <rect x="120" y="120" width="160" height="92" fill="#d9d2c3" stroke="#a89f8c" strokeWidth="2" />
        <rect x="120" y="120" width="160" height="22" fill="#b3a68f" />
        <rect x="170" y="180" width="60" height="32" fill="#c9c1b0" />
        <path d="M60 40 L340 40 L340 150" fill="none" stroke="#2563eb" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M60 40 L60 150" fill="none" stroke="#2563eb" strokeWidth="6" strokeLinecap="round" />
        <path d="M60 150 L120 150" fill="none" stroke="#dc2626" strokeWidth="6" strokeLinecap="round" />
        <path d="M280 150 L340 150" fill="none" stroke="#dc2626" strokeWidth="6" strokeLinecap="round" />
        {[[60, 40], [340, 40], [340, 150], [60, 150], [120, 150], [280, 150]].map(([x, y]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="5" fill="#fff" stroke="#15130F" strokeWidth="2" />
        ))}
        <text x="200" y="30" textAnchor="middle" fontSize="11" fontWeight="700" fill="#fff" stroke="#15130F" strokeWidth="0.4">Back · 280 ft</text>
        <text x="90" y="166" textAnchor="middle" fontSize="10" fontWeight="700" fill="#fff" stroke="#15130F" strokeWidth="0.4">Gate</text>
        <text x="310" y="166" textAnchor="middle" fontSize="10" fontWeight="700" fill="#fff" stroke="#15130F" strokeWidth="0.4">Gate</text>
      </svg>
    </div>
  );
}
