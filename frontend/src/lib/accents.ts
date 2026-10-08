// One palette for every "stage" chip, header band and tier card in the app.
//
// The rule these encode: a thing that belongs to one part of the job carries
// the same colour everywhere it appears, so a VA or a crew member learns the
// colour instead of reading the heading. `grad` paints an icon chip or a
// filled tier card, `band` is the wash behind a card's header, `text` is the
// matching readable foreground on white, `ring` the matching focus/selection
// ring.

export type Accent = { grad: string; band: string; text: string; ring: string; soft: string };

export const ACCENT = {
  violet:  { grad: "from-violet-500 to-indigo-600",   band: "from-violet-500/10 to-indigo-500/5",  text: "text-violet-700",  ring: "ring-violet-400",  soft: "bg-violet-100 text-violet-700" },
  amber:   { grad: "from-amber-500 to-orange-600",    band: "from-amber-500/10 to-orange-500/5",   text: "text-amber-700",   ring: "ring-amber-400",   soft: "bg-amber-100 text-amber-800" },
  cyan:    { grad: "from-cyan-500 to-sky-600",        band: "from-cyan-500/10 to-sky-500/5",       text: "text-cyan-700",    ring: "ring-cyan-400",    soft: "bg-cyan-100 text-cyan-800" },
  emerald: { grad: "from-emerald-500 to-teal-600",    band: "from-emerald-500/10 to-teal-500/5",   text: "text-emerald-700", ring: "ring-emerald-400", soft: "bg-emerald-100 text-emerald-700" },
  blue:    { grad: "from-blue-500 to-indigo-600",     band: "from-blue-500/10 to-indigo-500/5",    text: "text-blue-700",    ring: "ring-blue-400",    soft: "bg-blue-100 text-blue-700" },
  fuchsia: { grad: "from-fuchsia-500 to-purple-600",  band: "from-fuchsia-500/10 to-purple-500/5", text: "text-fuchsia-700", ring: "ring-fuchsia-400", soft: "bg-fuchsia-100 text-fuchsia-700" },
  rose:    { grad: "from-rose-500 to-pink-600",       band: "from-rose-500/10 to-pink-500/5",      text: "text-rose-700",    ring: "ring-rose-400",    soft: "bg-rose-100 text-rose-700" },
  slate:   { grad: "from-slate-500 to-slate-700",     band: "from-slate-500/10 to-slate-500/5",    text: "text-slate-700",   ring: "ring-slate-400",   soft: "bg-slate-100 text-slate-700" },
  gold:    { grad: "from-amber-400 to-yellow-600",    band: "from-amber-400/15 to-yellow-500/5",   text: "text-amber-800",   ring: "ring-amber-400",   soft: "bg-amber-100 text-amber-800" },
} satisfies Record<string, Accent>;

export type AccentName = keyof typeof ACCENT;

/** A stable colour per customer, so the same person always gets the same
 *  avatar. Hashes the name; an empty name gets the brand blue. */
export function accentForName(name: string): Accent {
  const keys: AccentName[] = ["blue", "violet", "cyan", "emerald", "fuchsia", "rose", "amber"];
  if (!name) return ACCENT.blue;
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
