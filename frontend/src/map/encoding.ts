// Pure visual-encoding functions for the job map. No DOM, no Leaflet — every
// rule here is unit-testable on its own. See the build spec, Section 4.

export type JobColor = "banana" | "tomato" | "peacock";

export interface Job {
  id: string;
  name: string;
  title: string;
  day: string;
  dayLabel: string;
  time: string;
  tzWarn?: boolean;
  biz: string;
  color: JobColor;
  addr: string;
  addrNote?: string;
  lat: number | null;
  lng: number | null;
  approx?: boolean;
  price: string;
  priceNum: number;
  fields: [string, string][];
  notes?: string;
  warn?: string;
  link?: string;
  done?: boolean;
  archived?: boolean;
  gb?: "red" | "blue";
  alsoGoBack?: boolean;
  rework?: boolean;
}

export interface Site {
  id: string;
  kind: "base" | "supply" | "closed";
  n: string;
  c: string;
  addr: string;
  lat: number | null;
  lng: number | null;
  note: string;
}

// 4.1 — fill colour by business. A peacock job means nobody assigned a
// business on the calendar invite; that is a data-quality flag, not a look.
export const COLOR_HEX: Record<JobColor, string> = {
  banana: "#F6BF26",
  tomato: "#D50000",
  peacock: "#039BE5",
};

export function colourFor(job: Pick<Job, "color">): string {
  return COLOR_HEX[job.color] || COLOR_HEX.peacock;
}

// 4.2 — circle size by job value. Square root so a $2,500 job doesn't dwarf a
// $500 one into invisibility. Clamped so the biggest job can't swallow its
// neighbours. Range: 19px – 37px.
export function sizeOf(job: Pick<Job, "priceNum">): number {
  return 19 + Math.min(18, Math.sqrt(job.priceNum || 0) / 3.6);
}

// 4.7 — smaller pins float above larger ones so a small job can't get buried
// under a big star half a mile away. Do not replace with a clustering plugin
// — clustering hides exactly what the operator is looking for.
export function zIndexOffsetFor(job: Pick<Job, "priceNum">): number {
  return Math.round(1000 - sizeOf(job) * 10);
}

// 4.4 — the go-back ring colour. Red = we owe it, our cost, schedule it.
// Blue = on hold, waiting on the customer — do not schedule, call them.
// White = this record IS the rework in progress (spec 4.4 "white inner ring").
export function ringColorFor(job: Pick<Job, "gb" | "rework">): string | null {
  if (job.rework) return "#ffffff";
  if (job.gb === "red") return "#e53935";
  if (job.gb === "blue") return "#1e88e5";
  return null;
}

// A job "owes a go-back" if it's an open go-back itself, or a finished job
// that still owes one (alsoGoBack). Used to drive the stat tile + ring.
export function owesGoBack(job: Pick<Job, "gb" | "alsoGoBack">): boolean {
  return !!job.gb || !!job.alsoGoBack;
}

// 10.2 — precision ladder. approx:true covers street/block/zip precision;
// only its absence (with real coordinates) means rooftop.
export function isApprox(job: Pick<Job, "approx" | "lat" | "lng">): boolean {
  return !!job.approx;
}

export function hasCoords(job: Pick<Job, "lat" | "lng">): job is { lat: number; lng: number } {
  return job.lat != null && job.lng != null;
}

// Overlay-aware state readers — `ovr` is the localStorage override for one
// job id (or undefined). An override always wins over the base record so a
// person's click sticks even if the underlying data file is later replaced.
export interface JobOverride {
  done?: boolean;
  archived?: boolean;
}

export function isDone(job: Pick<Job, "id" | "done">, ovr?: JobOverride): boolean {
  return ovr && "done" in ovr ? !!ovr.done : !!job.done;
}

export function isArchived(job: Pick<Job, "id" | "archived">, ovr?: JobOverride): boolean {
  return ovr && "archived" in ovr ? !!ovr.archived : !!job.archived;
}

// 11.1 — a stain spec is complete only when brand, colour, opacity and
// quantity are all present. Opacity may never be inferred from a colour name
// — Simply Cedar, October Brown, Chocolate Chip, Potato Skin, Pine Bark and
// Cedar Naturaltone all ship in both solid and semi-transparent.
const OPACITY_WORDS = ["solid", "semi-transparent", "semi transparent", "transparent"];
export function stainOpacityStated(colorFieldValue: string): boolean {
  const v = colorFieldValue.toLowerCase();
  return OPACITY_WORDS.some((w) => v.includes(w));
}
