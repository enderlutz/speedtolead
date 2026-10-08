// One palette for every "stage" chip, header band and tier card in the app.
//
// The rule these encode: a thing that belongs to one part of the job carries
// the same colour everywhere it appears, so a VA or a crew member learns the
// colour instead of reading the heading. `grad` paints an icon chip or a
// filled tier card, `band` is the wash behind a card's header, `text` is the
// matching readable foreground on white, `ring` the matching focus/selection
// ring.
//
// The brand accents (gold, bronze, ink, cedar, walnut) are the Sterling logo
// and the stain itself — see the swatches in index.css. The rest are the
// stage colours, deepened a shade so they sit well on ivory.

export type Accent = { grad: string; band: string; text: string; ring: string; soft: string };

export const ACCENT = {
  violet:  { grad: "from-violet-600 to-indigo-700",   band: "from-violet-500/10 to-indigo-500/5",  text: "text-violet-700",  ring: "ring-violet-400",  soft: "bg-violet-100 text-violet-700" },
  amber:   { grad: "from-amber-500 to-orange-700",    band: "from-amber-500/10 to-orange-500/5",   text: "text-amber-700",   ring: "ring-amber-400",   soft: "bg-amber-100 text-amber-800" },
  cyan:    { grad: "from-cyan-600 to-sky-700",        band: "from-cyan-500/10 to-sky-500/5",       text: "text-cyan-700",    ring: "ring-cyan-400",    soft: "bg-cyan-100 text-cyan-800" },
  emerald: { grad: "from-emerald-500 to-teal-700",    band: "from-emerald-500/10 to-teal-500/5",   text: "text-emerald-700", ring: "ring-emerald-400", soft: "bg-emerald-100 text-emerald-700" },
  blue:    { grad: "from-blue-600 to-indigo-700",     band: "from-blue-500/10 to-indigo-500/5",    text: "text-blue-700",    ring: "ring-blue-400",    soft: "bg-blue-100 text-blue-700" },
  fuchsia: { grad: "from-fuchsia-600 to-purple-700",  band: "from-fuchsia-500/10 to-purple-500/5", text: "text-fuchsia-700", ring: "ring-fuchsia-400", soft: "bg-fuchsia-100 text-fuchsia-700" },
  rose:    { grad: "from-rose-600 to-pink-700",       band: "from-rose-500/10 to-pink-500/5",      text: "text-rose-700",    ring: "ring-rose-400",    soft: "bg-rose-100 text-rose-700" },
  slate:   { grad: "from-stone-500 to-stone-700",     band: "from-stone-500/10 to-stone-500/5",    text: "text-stone-700",   ring: "ring-stone-400",   soft: "bg-stone-200 text-stone-700" },
  // Brand
  gold:    { grad: "from-gold-light to-bronze",       band: "from-gold/20 to-bronze/5",            text: "text-bronze",      ring: "ring-gold",        soft: "bg-gold/15 text-bronze" },
  bronze:  { grad: "from-bronze-light to-bronze",     band: "from-bronze/15 to-bronze/5",          text: "text-bronze",      ring: "ring-bronze-light",soft: "bg-bronze/12 text-bronze" },
  ink:     { grad: "from-stone-700 to-ink",           band: "from-ink/10 to-ink/[0.03]",           text: "text-stone-800",   ring: "ring-stone-500",   soft: "bg-stone-200 text-stone-800" },
  cedar:   { grad: "from-cedar to-walnut",            band: "from-cedar/12 to-walnut/5",           text: "text-walnut",      ring: "ring-cedar",       soft: "bg-cedar/15 text-walnut" },
  walnut:  { grad: "from-walnut to-ink",              band: "from-walnut/12 to-ink/5",             text: "text-walnut",      ring: "ring-walnut",      soft: "bg-walnut/12 text-walnut" },
  forest:  { grad: "from-emerald-700 to-emerald-900", band: "from-emerald-700/10 to-emerald-900/5", text: "text-emerald-800", ring: "ring-emerald-600", soft: "bg-emerald-100 text-emerald-800" },
} satisfies Record<string, Accent>;

export type AccentName = keyof typeof ACCENT;

/** A stable colour per customer, so the same person always gets the same
 *  avatar. Hashes the name; an empty name gets the brand gold. */
export function accentForName(name: string): Accent {
  const keys: AccentName[] = ["gold", "cedar", "violet", "cyan", "emerald", "blue", "rose", "walnut"];
  if (!name) return ACCENT.gold;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return ACCENT[keys[h % keys.length]];
}

/** "Jerry Armand" → "JA". One letter for a single word; "?" for nothing. */
export function initials(name: string): string {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
