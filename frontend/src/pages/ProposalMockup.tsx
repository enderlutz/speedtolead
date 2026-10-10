// The first mockup of the interactive proposal (2026-10-09).
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
  Users, Lightbulb, ArrowLeft, Eye,
} from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";

// ── Sample data ────────────────────────────────────────────────────────
// A made-up customer. Never a real one: this page ships inside the
// dashboard bundle.
const CUSTOMER = {
  name: "Jordan Miller",
  address: "12345 Cypress Creek Dr, Cypress, TX 77429",
  date: "October 9, 2026",
  number: "SF-2026-05481",
  goodThrough: "October 31",
  sides: ["Inside facing sides", "Outside facing: front"],
};

type PkgKey = "essential" | "signature" | "legacy";
const PACKAGES: {
  key: PkgKey; name: string; tag: string; lasts: string; photo: string; photoB?: string;
  lines: { icon: React.ElementType; text: string }[]; regular: number; price: number; popular?: boolean;
}[] = [
  {
    key: "essential", name: "Essential Seal", tag: "Entry", lasts: "1–2 years",
    photo: "/proposal-mockup/pkg-essential.jpg",
    lines: [
      { icon: Droplets, text: "Clear protection" },
      { icon: Sparkles, text: "Refreshes newer fences" },
    ],
    regular: 1580, price: 1263.60,
  },
  {
    key: "signature", name: "Signature Finish", tag: "Semi-transparent", lasts: "2–4 years",
    photo: "/proposal-mockup/pkg-signature.jpg", popular: true,
    lines: [
      { icon: Leaf, text: "Natural finish, shows the wood grain" },
      { icon: Paintbrush, text: "Adds color and protection" },
    ],
    regular: 1814, price: 1450.80,
  },
  {
    key: "legacy", name: "Legacy Finish", tag: "Premium", lasts: "4–7 years",
    // One image on the PDF: the orange and the dark finish side by side.
    photo: "/proposal-mockup/pkg-legacy.jpg",
    lines: [
      { icon: Shield, text: "Solid stain, bold finish" },
      { icon: Droplets, text: "Hides imperfections and aging" },
      { icon: Sun, text: "Maximum coverage and durability" },
    ],
    regular: 2301, price: 1840.80,
  },
];

// Repairs, priced from Alan's list (2026-10-09). The post price depends on
// how the fence is built, which the customer answers once.
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
const postPrice = (rotBoard: boolean, cap: boolean) => (rotBoard && cap ? 350 : rotBoard ? 255 : 225);

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
// Legacy solid colours as swatches until their photos are loaded.
const LEGACY_SWATCHES: { name: string; hex: string }[] = [
  { name: "White Out", hex: "#F3F1EC" }, { name: "Snowstorm", hex: "#F2EBDD" }, { name: "Creamy Glen", hex: "#CFCFC7" },
  { name: "Coral Beach", hex: "#E4CBB2" }, { name: "Ghosted Sand", hex: "#D2C6B5" }, { name: "Carlsbad Dawn", hex: "#D9C39E" },
  { name: "Saddlebag Tan", hex: "#B99A74" }, { name: "Quiet Chamois", hex: "#A89A82" }, { name: "Heartland's", hex: "#B6AEA2" },
  { name: "Silver Mine", hex: "#B9B9B6" }, { name: "Parisian Gray", hex: "#8C8C88" }, { name: "Galapagos Grey", hex: "#6E6E6B" },
  { name: "Smoked Leather", hex: "#8A8072" }, { name: "Toasted Armado", hex: "#9C6B5E" }, { name: "Simply Cedar", hex: "#A6713F" },
  { name: "Pinebark", hex: "#6E4A2C" }, { name: "Chocolate Chips", hex: "#5A4232" }, { name: "October Brown", hex: "#5C5349" },
  { name: "Potato Skin", hex: "#5B4634" }, { name: "Rusticana", hex: "#8D4A3A" }, { name: "Badlands Red", hex: "#6E2F28" },
  { name: "Plymouth Red", hex: "#5E2A2A" }, { name: "Classic Mahogany", hex: "#4B2E22" }, { name: "Darkest Night", hex: "#1E1E1E" },
];

/** The payment line under a price, the way the lenders sell it: four
 *  interest-free payments up to $2,000, a monthly plan above that. */
function payLine(total: number): string {
  if (total <= 2000) return `or 4 payments of ${formatCurrency(total / 4)}, interest-free`;
  return `or as low as ${formatCurrency(total / 12)}/mo`;
}

const GOLD = "#C9972F";

export default function ProposalMockup() {
  const [phone, setPhone] = useState(true);
  const [withScope, setWithScope] = useState(true);
  const [pkg, setPkg] = useState<PkgKey | null>(null);
  const [stain, setStain] = useState<string | null>(null);
  const [picketType, setPicketType] = useState(PICKETS[0].key);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [rotBoard, setRotBoard] = useState(false);
  const [cap, setCap] = useState(false);
  const [bigPhoto, setBigPhoto] = useState<string | null>(null);

  const chosen = PACKAGES.find((p) => p.key === pkg) || null;
  const repairs = useMemo(() => {
    const picket = PICKETS.find((p) => p.key === picketType)!;
    let total = (counts.pickets || 0) * picket.price;
    for (const part of PARTS) total += (counts[part.key] || 0) * part.price;
    total += (counts.posts || 0) * postPrice(rotBoard, cap);
    return total;
  }, [counts, picketType, rotBoard, cap]);
  const total = (chosen?.price || 0) + repairs;
  const bump = (key: string, by: number) =>
    setCounts((c) => ({ ...c, [key]: Math.max(0, (c[key] || 0) + by) }));

  const choose = (key: PkgKey) => {
    setPkg(key);
    setStain(null);
    setTimeout(() => document.getElementById("mock-color")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
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
          <img src="/proposal-mockup/hero-family.jpg" alt="" className="h-64 w-full object-cover" draggable={false} />
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
              </div>
              <p className="mt-2 text-sm text-[#15130F]/70">This is what we'd stain. Not right? Tap Call or text at the top.</p>
            </>
          ) : (
            <div className="rounded-2xl bg-white p-4 ring-1 ring-[#15130F]/10">
              <p className="text-[11px] font-bold uppercase tracking-wider text-[#8C6224]">Sides included in the price</p>
              <ul className="mt-2 space-y-1.5">
                {CUSTOMER.sides.map((s) => (
                  <li key={s} className="flex items-center gap-2 text-base font-semibold"><Check className="h-4 w-4" style={{ color: GOLD }} /> {s}</li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* Packages */}
        <section className="bg-white px-4 py-6">
          <SectionTitle kicker="Step 2" title="Pick your package" sub="Same expert service. Three levels of protection." />
          <p className="mb-4 flex items-center gap-2 rounded-xl bg-[#F8F3E7] px-3 py-2 text-xs font-semibold ring-1 ring-[#C9972F]/40">
            <Shield className="h-4 w-4 shrink-0" style={{ color: "#8C6224" }} />
            Every package: two coats of stain and a 1-year workmanship warranty.
          </p>
          <div className={cn("grid gap-4", !phone && "sm:grid-cols-3")}>
            {PACKAGES.map((p) => {
              const on = pkg === p.key;
              return (
                <div key={p.key} className={cn("overflow-hidden rounded-2xl bg-white shadow-md transition",
                  on ? "ring-4 ring-[#C9972F]" : p.popular ? "ring-2 ring-[#C9972F]/60" : "ring-1 ring-[#15130F]/10")}>
                  <div className="relative">
                    {p.photoB ? (
                      <div className="grid h-44 grid-cols-2">
                        <img src={p.photo} alt="" className="h-44 w-full object-cover" draggable={false} />
                        <img src={p.photoB} alt="" className="h-44 w-full object-cover" draggable={false} />
                      </div>
                    ) : (
                      <img src={p.photo} alt="" className="h-44 w-full object-cover" draggable={false} />
                    )}
                    {p.popular ? (
                      <span className="absolute left-3 top-3 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-[#15130F] shadow" style={{ background: GOLD }}>
                        <Star className="mr-1 inline h-3 w-3 fill-current" />Most popular
                      </span>
                    ) : null}
                    <span className="absolute right-3 top-3 flex h-14 w-14 flex-col items-center justify-center rounded-full bg-white/95 text-center shadow ring-1 ring-[#C9972F]/50">
                      <span className="text-[8px] font-bold uppercase tracking-wider text-[#8C6224]">Lasts</span>
                      <span className="font-heading text-sm font-bold leading-none">{p.lasts.split(" ")[0]}</span>
                      <span className="text-[8px] uppercase tracking-wider text-[#15130F]/60">years</span>
                    </span>
                  </div>
                  <div className="p-4">
                    <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#8C6224]">{p.tag}</p>
                    <h3 className="font-heading text-2xl font-bold leading-tight">{p.name}</h3>
                    <ul className="mt-2 space-y-1.5">
                      {p.lines.map((l) => {
                        const Icon = l.icon;
                        return <li key={l.text} className="flex items-center gap-2 text-sm"><Icon className="h-4 w-4 shrink-0" style={{ color: "#8C6224" }} />{l.text}</li>;
                      })}
                    </ul>
                    <div className="mt-3 rounded-xl bg-[#F8F3E7] p-3">
                      <div className="flex items-end justify-between gap-2">
                        <div>
                          <p className="text-[10px] font-bold uppercase tracking-wider text-[#15130F]/60">Regular price <s className="ml-1 text-red-700">{formatCurrency(p.regular)}</s></p>
                          <p className="font-heading text-3xl font-bold leading-none">{formatCurrency(p.price)}</p>
                        </div>
                        <span className="rounded-full bg-emerald-700 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-white">20% off</span>
                      </div>
                      <p className="mt-1.5 text-xs font-semibold text-[#15130F]/75">{payLine(p.price)}</p>
                    </div>
                    <button type="button" onClick={() => choose(p.key)}
                      className={cn("mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-xl text-base font-bold transition active:scale-[0.98]",
                        on ? "bg-[#15130F] text-[#E3BE63]" : "text-[#15130F] shadow-md")}
                      style={on ? undefined : { background: GOLD }}>
                      {on ? <><Check className="h-5 w-5" /> {p.name} picked</> : `Pick ${p.name.split(" ")[0]}`}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-center text-xs text-[#15130F]/60">Choose based on the condition of your wood and the look you want.</p>
        </section>

        {/* Colour */}
        <section id="mock-color" className="scroll-mt-14 px-4 py-6">
          <SectionTitle kicker="Step 3" title="Pick your color" sub={chosen ? `${chosen.name} colors` : "Pick a package first"} />
          {!chosen ? (
            <p className="rounded-2xl bg-white p-4 text-sm text-[#15130F]/70 ring-1 ring-[#15130F]/10">Your colors show up here once you pick a package.</p>
          ) : chosen.key === "essential" ? (
            <p className="rounded-2xl bg-white p-4 text-sm ring-1 ring-[#15130F]/10">Essential is a clear coat. Your fence keeps its own color, just protected.</p>
          ) : chosen.key === "signature" ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                {SIGNATURE_PHOTOS.map((c) => {
                  const on = stain === c.name;
                  return (
                    <div key={c.name} className={cn("overflow-hidden rounded-2xl bg-white shadow-sm transition", on ? "ring-4 ring-[#C9972F]" : "ring-1 ring-[#15130F]/10")}>
                      <button type="button" onClick={() => setBigPhoto(c.src)} className="block w-full">
                        <img src={c.src} alt={c.name} className="h-28 w-full object-cover" draggable={false} />
                      </button>
                      <button type="button" onClick={() => setStain(c.name)} className="flex w-full items-center justify-between gap-1 px-2.5 py-2 text-left">
                        <span className="text-xs font-bold leading-tight">{c.name}</span>
                        <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full", on ? "bg-[#15130F] text-[#E3BE63]" : "bg-[#F8F3E7] ring-1 ring-[#15130F]/15")}>
                          {on ? <Check className="h-3.5 w-3.5" /> : null}
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-[#15130F]/60">Real fences we stained. Tap a photo to see it bigger.</p>
            </>
          ) : (
            <>
              <div className="grid grid-cols-4 gap-2">
                {LEGACY_SWATCHES.map((c) => {
                  const on = stain === c.name;
                  return (
                    <button key={c.name} type="button" onClick={() => setStain(c.name)}
                      className={cn("rounded-xl bg-white p-1.5 text-left shadow-sm transition", on ? "ring-4 ring-[#C9972F]" : "ring-1 ring-[#15130F]/10")}>
                      <span className="block h-12 w-full rounded-lg ring-1 ring-black/10" style={{ background: c.hex }} />
                      <span className="mt-1 block text-[10px] font-semibold leading-tight">{c.name}</span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-[#15130F]/60">Solid colors. Photos of real fences are coming for each one.</p>
            </>
          )}
          {stain ? <p className="mt-3 rounded-xl bg-[#15130F] px-3 py-2 text-sm font-semibold text-[#E3BE63]"><Check className="mr-1 inline h-4 w-4" /> {stain} it is. You can change this any time.</p> : null}
        </section>

        {/* Repairs */}
        <section className="bg-white px-4 py-6">
          <SectionTitle kicker="Optional" title="Anything need replacing?" sub="Count it up. We bring the wood." />
          <div className="space-y-3">
            <div className="rounded-2xl bg-[#F8F3E7] p-3">
              <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[#8C6224]">Your fence has…</p>
              <div className="grid grid-cols-2 gap-2">
                <Toggle on={rotBoard} onClick={() => setRotBoard((v) => !v)} label="A rot board" />
                <Toggle on={cap} onClick={() => setCap((v) => !v)} label="A cap on top" />
              </div>
            </div>
            <Counter label="Pickets" price={PICKETS.find((p) => p.key === picketType)!.price} n={counts.pickets || 0} onChange={(d) => bump("pickets", d)}>
              <select value={picketType} onChange={(e) => setPicketType(e.target.value)} className="h-8 rounded-lg border border-[#15130F]/15 bg-white px-2 text-xs font-semibold">
                {PICKETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </Counter>
            {PARTS.map((part) => (
              <Counter key={part.key} label={part.label} price={part.price} n={counts[part.key] || 0} onChange={(d) => bump(part.key, d)} />
            ))}
            <Counter label="Posts" price={postPrice(rotBoard, cap)} n={counts.posts || 0} onChange={(d) => bump("posts", d)} hint={rotBoard || cap ? "Price fits your fence" : undefined} />
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
              ["Clean jobsite", "Labor and cleanup included."],
            ]} />
            <List title="Why people pick us" icon={Shield} items={[
              ["1-year workmanship warranty", "On every package."],
              ["5.0 on Google", "Trusted by homeowners who want it done right."],
              ["1,500+ fences restored", "Across the Houston area."],
              ["7+ years", "Hands-on experience with wood fences."],
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

        {/* Footer links */}
        <section className="px-4 py-6 pb-28">
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="flex h-11 items-center justify-center gap-2 rounded-xl bg-white text-sm font-semibold ring-1 ring-[#15130F]/15"><Download className="h-4 w-4" /> Save as PDF</button>
            <button type="button" className="flex h-11 items-center justify-center gap-2 rounded-xl bg-white text-sm font-semibold ring-1 ring-[#15130F]/15"><FileText className="h-4 w-4" /> Terms</button>
          </div>
          <p className="mt-4 text-center text-xs text-[#15130F]/55">Sterling Fence Staining · Cypress, TX · 346-589-7877</p>
        </section>

        {/* Sticky bottom: the one thing to do. */}
        <div className={cn("sticky bottom-0 z-20 border-t border-[#C9972F]/40 bg-[#15130F] p-3 text-white", phone && "rounded-b-[1.6rem]")}>
          {chosen ? (
            <>
              <div className="flex items-end justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-xs text-white/70">{chosen.name}{stain ? ` · ${stain}` : ""}{repairs ? " · repairs" : ""}</p>
                  <p className="font-heading text-2xl font-bold leading-none tabular-nums">{formatCurrency(total)}</p>
                  <p className="mt-0.5 text-[11px] font-semibold" style={{ color: "#E3BE63" }}>{payLine(total)}</p>
                </div>
                <button type="button" className="flex h-12 shrink-0 items-center gap-2 rounded-xl px-4 text-sm font-bold text-[#15130F] shadow-lg active:scale-[0.98]" style={{ background: GOLD }}>
                  <Home className="h-4 w-4" /> Reserve my spot · $250
                </button>
              </div>
              <p className="mt-2 text-center text-[10px] text-white/55">$250 deposit books your dates. The rest is due when the job is done and you're happy.</p>
            </>
          ) : (
            <p className="py-2 text-center text-sm font-semibold text-white/85">Pick a package above to see your total.</p>
          )}
        </div>
      </div>

      {bigPhoto ? (
        <button type="button" onClick={() => setBigPhoto(null)} className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4">
          <img src={bigPhoto} alt="" className="max-h-full max-w-full rounded-2xl shadow-2xl" />
        </button>
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

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={cn("flex h-11 items-center justify-center gap-2 rounded-xl text-sm font-semibold transition",
        on ? "bg-[#15130F] text-[#E3BE63]" : "bg-white ring-1 ring-[#15130F]/15")}>
      {on ? <Check className="h-4 w-4" /> : null}{label}
    </button>
  );
}

function Counter({ label, price, n, onChange, hint, children }: {
  label: string; price: number; n: number; onChange: (delta: number) => void; hint?: string; children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-[#F8F3E7] px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold">{label}</p>
        <p className="text-[11px] text-[#15130F]/60">{formatCurrency(price)} each{hint ? ` · ${hint}` : ""}</p>
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
