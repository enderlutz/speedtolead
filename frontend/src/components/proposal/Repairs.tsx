// Fence repairs, shared by the proposal and the booking invite so both look
// and price exactly the same (Alan, 2026-10-15: "literally looking
// identical to how the estimate looks"). Prices per unit, tax included.
import { Minus, Plus } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";

const GOLD = "#C9972F";

export function Chips({ options, value, onChange }: {
  options: { key: string; label: string; price: number }[]; value: string; onChange: (key: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button key={o.key} type="button" onClick={() => onChange(o.key)} aria-pressed={on}
            className={cn("rounded-lg px-3 py-2 text-[15px] font-semibold leading-tight transition",
              on ? "bg-[#15130F] text-[#E3BE63]" : "bg-white text-[#15130F]/75 ring-1 ring-[#15130F]/15")}>
            {o.label} <span className={cn("ml-0.5", on ? "text-white/85" : "text-[#15130F]/65")}>{formatCurrency(o.price).replace(".00", "")}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Counter({ label, what, unit, price, n, onChange, art, children, stack }: {
  label: string; what?: string; unit: string; price: number; n: number; onChange: (delta: number) => void; art?: React.ReactNode; children?: React.ReactNode;
  /** Narrow places (the lead page): the − / + row sits under the words. */
  stack?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-3 rounded-2xl bg-[#F8F3E7] px-3 py-3", stack && "flex-wrap")}>
      {art ? <div className="shrink-0 overflow-hidden rounded-xl bg-white ring-1 ring-[#15130F]/10">{art}</div> : null}
      <div className="min-w-0 flex-1">
        <p className="text-base font-bold leading-tight">{label}</p>
        {what ? <p className="text-[15px] leading-snug text-[#15130F]/75">{what}</p> : null}
        <p className="text-[15px] font-semibold text-[#15130F]/75">{formatCurrency(price).replace(".00", "")} per {unit}</p>
        {children ? <div className="mt-1">{children}</div> : null}
      </div>
      <div className={cn("flex items-center gap-1", stack && "ml-auto w-full justify-end")}>
        <button type="button" onClick={() => onChange(-1)} className="flex h-12 w-12 items-center justify-center rounded-xl bg-white ring-1 ring-[#15130F]/20 active:scale-95" aria-label={`One less ${label}`}><Minus className="h-5 w-5" /></button>
        <span className="w-9 text-center font-heading text-2xl font-bold tabular-nums">{n}</span>
        <button type="button" onClick={() => onChange(1)} className="flex h-12 w-12 items-center justify-center rounded-xl text-[#15130F] active:scale-95" style={{ background: GOLD }} aria-label={`One more ${label}`}><Plus className="h-5 w-5" /></button>
      </div>
    </div>
  );
}


export type FencePartKey = "picket" | "rotboard" | "cap" | "rail" | "post";

/** One section of fence, drawn the same way every time, with the part
 *  being counted lit up in gold, so a customer can see what a rot board
 *  or a cap is before they count them (Alan, 2026-10-10). Only ONE of the
 *  part lights up: eight gold pickets made it look like $12 bought all
 *  eight (Alan, 2026-10-12). */
export function FencePart({ part }: { part: FencePartKey }) {
  const wood = "#D9C2A3", edge = "#A98A63";
  const hot = (k: FencePartKey, one = true) => (part === k && one ? { fill: GOLD, stroke: "#15130F", strokeWidth: 2 } : { fill: wood, stroke: edge, strokeWidth: 1 });
  const pickets = [15, 22, 29, 36, 43, 50, 57, 64];
  const picketLayer = pickets.map((x) => <rect key={x} x={x} y="11" width="6" height="42" rx="0.5" {...hot("picket", x === 36)} />);
  const railLayer = [14, 30, 44].map((y) => <rect key={y} x="13" y={y} width="56" height="5" rx="0.5" {...hot("rail", y === 30)} />);
  // From the street the pickets hide the rails. The rail view is the back
  // of the fence, where the three rails run across the pickets.
  const fromBack = part === "rail";
  return (
    <svg viewBox="0 0 82 62" width="96" height="72" role="img" aria-label={part}>
      <rect x="0" y="57" width="82" height="5" fill="#6b8f4e" />
      <rect x="6" y="6" width="7" height="52" rx="1" {...hot("post")} />
      <rect x="69" y="6" width="7" height="52" rx="1" {...hot("post", false)} />
      {fromBack ? <>{picketLayer}{railLayer}</> : <>{railLayer}{picketLayer}</>}
      <rect x="13" y="50" width="56" height="6" {...hot("rotboard")} />
      <rect x="4" y="5" width="74" height="5" rx="1" {...hot("cap")} />
      {fromBack ? <text x="41" y="3.5" textAnchor="middle" fontSize="5.5" fontWeight="800" fill="#15130F">BACK OF FENCE</text> : null}
    </svg>
  );
}
