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
  key: PkgKey; name: string; short: string; tag: string; lasts: string; photos: string[];
  lines: { icon: React.ElementType; text: string }[]; regular: number; price: number; popular?: boolean;
}[] = [
  {
    key: "essential", name: "Essential Seal", short: "Essential", tag: "Entry", lasts: "1–2 yrs",
    photos: ["/proposal-mockup/pkg-essential.jpg"],
    lines: [
      { icon: Droplets, text: "Clear protection" },
      { icon: Sparkles, text: "Refreshes newer fences" },
    ],
    regular: 1580, price: 1263.60,
  },
  {
    key: "signature", name: "Signature Finish", short: "Signature", tag: "Semi-transparent", lasts: "2–4 yrs",
    photos: ["/proposal-mockup/pkg-signature-a.jpg", "/proposal-mockup/pkg-signature-b.jpg"], popular: true,
    lines: [
      { icon: Leaf, text: "Natural finish, shows the wood grain" },
      { icon: Paintbrush, text: "Adds color and protection" },
    ],
    regular: 1814, price: 1450.80,
  },
  {
    key: "legacy", name: "Legacy Finish", short: "Legacy", tag: "Premium", lasts: "4–7 yrs",
    photos: ["/proposal-mockup/pkg-legacy-a.jpg", "/proposal-mockup/pkg-legacy-b.jpg"],
    lines: [
      { icon: Shield, text: "Solid stain, bold finish" },
      { icon: Droplets, text: "Hides imperfections and aging" },
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
  { key: "post6", label: "Post, 6 ft fence", price: 225 },
  { key: "post7", label: "Post, 7 ft fence", price: 255 },
  { key: "post8", label: "Post, 8 ft fence", price: 350 },
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

// The lenders' own wording, which is what the big retailers show under a
// price: Klarna and Afterpay say "4 interest-free payments of $X", Affirm
// says "As low as $X/mo". Pay-in-4 tops out around $2,000 a purchase.
const PAY_IN_4_MAX = 2000;
function payLine(total: number): { text: string; lender: "klarna" | "affirm" } {
  if (total <= PAY_IN_4_MAX) return { text: `4 interest-free payments of ${formatCurrency(total / 4)}`, lender: "klarna" };
  return { text: `As low as ${formatCurrency(total / 12)}/mo`, lender: "affirm" };
}

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

  const chosen = PACKAGES.find((p) => p.key === pkg) || null;
  const repairs = useMemo(() => {
    const picket = PICKETS.find((p) => p.key === picketType)!;
    let total = (counts.pickets || 0) * picket.price;
    for (const part of PARTS) total += (counts[part.key] || 0) * part.price;
    return total;
  }, [counts, picketType]);
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

        {/* Packages: three across, on a phone too (Alan, 2026-10-10: "next
            to each other", so the colours fit below without a long scroll). */}
        <section className="bg-white px-3 py-6 sm:px-4">
          <div className="px-1">
            <SectionTitle kicker="Step 2" title="Pick your package" sub="Same expert service. Three levels of protection." />
          </div>
          <p className="mb-3 flex items-center gap-2 rounded-xl bg-[#F8F3E7] px-3 py-2 text-xs font-semibold ring-1 ring-[#C9972F]/40">
            <Shield className="h-4 w-4 shrink-0" style={{ color: "#8C6224" }} />
            Every package: two coats of stain and a 1-year workmanship warranty.
          </p>
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            {PACKAGES.map((p) => {
              const on = pkg === p.key;
              const line = payLine(p.price);
              return (
                <div key={p.key} className={cn("flex flex-col overflow-hidden rounded-2xl bg-white shadow-md transition",
                  on ? "ring-4 ring-[#C9972F]" : p.popular ? "ring-2 ring-[#C9972F]/60" : "ring-1 ring-[#15130F]/10")}>
                  <div className="relative">
                    {/* Two photos stack on a phone, sit side by side when wide. */}
                    <div className={cn("grid gap-0.5", p.photos.length > 1 && (phone ? "grid-rows-2" : "sm:grid-cols-2"))}>
                      {p.photos.map((src) => (
                        <img key={src} src={src} alt="" className={cn("w-full object-cover", p.photos.length > 1 && phone ? "h-[72px]" : "h-[148px]")} draggable={false} />
                      ))}
                    </div>
                    {p.popular ? (
                      <span className="absolute left-1.5 top-1.5 rounded-full px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-[#15130F] shadow sm:px-2.5 sm:py-1 sm:text-[10px]" style={{ background: GOLD }}>
                        <Star className="mr-0.5 inline h-2.5 w-2.5 fill-current" />Popular
                      </span>
                    ) : null}
                  </div>
                  <div className="flex flex-1 flex-col p-2 sm:p-3">
                    <p className="text-[8px] font-bold uppercase tracking-[0.15em] text-[#8C6224] sm:text-[10px]">{p.tag}</p>
                    <h3 className="font-heading text-[13px] font-bold leading-tight sm:text-xl">{p.name}</h3>
                    <p className="mt-1 inline-flex w-fit items-center rounded-full bg-[#F8F3E7] px-1.5 py-0.5 text-[9px] font-bold ring-1 ring-[#C9972F]/50 sm:text-[10px]">Lasts {p.lasts}</p>
                    <div className="mt-2 flex-1">
                      <p className="text-[9px] text-[#15130F]/55 sm:text-[11px]"><s className="text-red-700">{formatCurrency(p.regular)}</s> <span className="font-bold text-emerald-700">20% off</span></p>
                      <p className="font-heading text-[15px] font-bold leading-none sm:text-2xl">{formatCurrency(p.price)}</p>
                      <p className="mt-1 text-[9px] font-semibold leading-tight text-[#15130F]/70 sm:text-[11px]">
                        or {line.text}{line.lender === "klarna" ? " with Klarna" : " with Affirm"}
                      </p>
                    </div>
                    <button type="button" onClick={() => choose(p.key)}
                      className={cn("mt-2 flex h-9 w-full items-center justify-center gap-1 rounded-xl text-xs font-bold transition active:scale-[0.98] sm:h-11 sm:text-sm",
                        on ? "bg-[#15130F] text-[#E3BE63]" : "text-[#15130F] shadow-md")}
                      style={on ? undefined : { background: GOLD }}>
                      {on ? <><Check className="h-4 w-4" /> Picked</> : `Pick ${p.short}`}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          {/* What the picked one is (or the most popular, until they pick). */}
          {(() => {
            const show = chosen || PACKAGES[1];
            return (
              <div className="mt-3 rounded-xl bg-[#F8F3E7] px-3 py-2.5">
                <p className="text-[10px] font-bold uppercase tracking-wider text-[#8C6224]">{show.name}{chosen ? "" : " · most popular"}</p>
                <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                  {show.lines.map((l) => {
                    const Icon = l.icon;
                    return <li key={l.text} className="flex items-center gap-1.5 text-xs"><Icon className="h-3.5 w-3.5 shrink-0" style={{ color: "#8C6224" }} />{l.text}</li>;
                  })}
                </ul>
              </div>
            );
          })()}
          <p className="mt-3 text-center text-xs text-[#15130F]/60">Choose based on the condition of your wood and the look you want.</p>
        </section>

        {/* Colours: always on show, in two tabs, so nobody has to pick a
            package to browse (Alan, 2026-10-10). */}
        <section id="mock-color" className="scroll-mt-14 px-4 py-6">
          <SectionTitle kicker="Step 3" title="Pick your color" sub="Essential is a clear coat. Signature and Legacy come in these." />
          <div className="mb-3 grid grid-cols-2 gap-1 rounded-xl bg-white p-1 ring-1 ring-[#15130F]/10">
            {([["signature", `Signature · ${SIGNATURE_PHOTOS.length} photos`], ["legacy", `Legacy · ${LEGACY_SWATCHES.length} colors`]] as const).map(([k, label]) => (
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
              <div className="grid grid-cols-6 gap-1.5">
                {LEGACY_SWATCHES.map((c) => {
                  const on = stain === c.name;
                  return (
                    <button key={c.name} type="button" onClick={() => pickColor(c.name, "legacy")}
                      className={cn("rounded-lg bg-white p-1 text-left shadow-sm transition", on ? "ring-[3px] ring-[#C9972F]" : "ring-1 ring-[#15130F]/10")}>
                      <span className="block h-9 w-full rounded-md ring-1 ring-black/10" style={{ background: c.hex }} />
                      <span className="mt-0.5 block text-[8px] font-semibold leading-tight">{c.name}</span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-[11px] text-[#15130F]/60">Solid colors. Photos of real fences are coming for each one.</p>
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
              <div className="mt-2 space-y-2">
                <PayOption lender="klarna" text={`4 interest-free payments of ${formatCurrency((total || PACKAGES[1].price) / 4)}`} note="One every 2 weeks. No interest." dim={(total || PACKAGES[1].price) > PAY_IN_4_MAX} />
                <PayOption lender="affirm" text={`As low as ${formatCurrency((total || PACKAGES[1].price) / 12)}/mo`} note="3 to 36 months. Rate shown before you agree." />
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
                  or {pay.text} {pay.lender === "klarna" ? "with Klarna" : "with Affirm"}
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
function PayOption({ lender, text, note, dim }: { lender: "klarna" | "affirm"; text: string; note: string; dim?: boolean }) {
  return (
    <div className={cn("flex items-center gap-3 rounded-xl bg-[#F8F3E7] px-3 py-2", dim && "opacity-50")}>
      {lender === "klarna"
        ? <span className="flex h-7 w-16 shrink-0 items-center justify-center rounded-md bg-[#FFB3C7] text-[13px] font-black tracking-tight text-black">Klarna.</span>
        : <span className="flex h-7 w-16 shrink-0 items-center justify-center rounded-md bg-[#15130F]"><img src="/affirm-white.png" alt="Affirm" className="h-4 w-auto" draggable={false} /></span>}
      <div className="min-w-0">
        <p className="text-sm font-bold leading-tight">{text}</p>
        <p className="text-[11px] text-[#15130F]/60">{dim ? "Over the pay-in-4 limit for this amount." : note}</p>
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
