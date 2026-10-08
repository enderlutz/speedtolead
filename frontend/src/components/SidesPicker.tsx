// The eight sides of a fence, as two little top-down maps of the house.
//
// Used on the Estimate tab to say which sides the customer is buying, and on
// Company Cam to say which sides get which stain colour. The side names live
// in lib/fenceSides so both screens and the backend agree on them.
import { Home } from "lucide-react";
import { ACCENT, type Accent } from "@/lib/accents";
import { ProgressPill } from "@/components/Panel";
import { cn } from "@/lib/utils";
import { FENCE_SIDES, type SideGroup } from "@/lib/fenceSides";

const GROUP_ACCENT: Record<SideGroup, Accent> = {
  Inside: ACCENT.violet,
  Outside: ACCENT.cyan,
};

/**
 * Tap the sides. Inside is violet, outside is sky, everywhere in the app.
 *
 * `highlight` — the sides on the estimate. When given, those get a solid
 *   outline and the rest go faint, but every side stays tappable: a crew can
 *   sell a side on site without going back to the estimate.
 * `elsewhere` — sides already claimed by another row (Company Cam's colour
 *   plan). Shown dotted; tapping one moves it here.
 */
export function SidesPicker({
  value, onChange, highlight, elsewhere, compact,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  highlight?: string[];
  elsewhere?: string[];
  compact?: boolean;
}) {
  const toggle = (name: string) =>
    onChange(value.includes(name) ? value.filter((s) => s !== name) : [...value, name]);
  const setGroup = (names: readonly string[], on: boolean) => {
    const rest = value.filter((s) => !names.includes(s));
    onChange(on ? [...rest, ...names] : rest);
  };

  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-2.5">
        {(Object.keys(FENCE_SIDES) as SideGroup[]).map((group) => {
          const names = FENCE_SIDES[group];
          const accent = GROUP_ACCENT[group];
          const n = names.filter((s) => value.includes(s)).length;
          const cell = (side: string) => {
            const name = `${group} ${side}`;
            const on = value.includes(name);
            const taken = !on && !!elsewhere?.includes(name);
            const bought = highlight ? highlight.includes(name) : undefined;
            const title = on
              ? name
              : taken ? `${name} — in another colour row. Tap to move it here.`
              : bought === false ? `${name} — not on the estimate. Tap to add it on site.`
              : bought ? `${name} — on the estimate` : name;
            return (
              <button
                key={name}
                type="button"
                aria-pressed={on}
                title={title}
                onClick={() => toggle(name)}
                className={cn(
                  "flex aspect-square items-center justify-center rounded-lg border font-semibold transition active:scale-95",
                  compact ? "text-[10px]" : "text-[11px]",
                  on
                    ? `border-transparent bg-gradient-to-br ${accent.grad} text-white shadow-sm`
                    : taken
                      ? "border-dotted border-foreground/40 bg-muted/60 text-foreground/60 hover:border-foreground/70 hover:text-foreground"
                      : bought
                        ? "border-solid border-foreground/40 bg-background text-foreground hover:border-foreground/70"
                        : bought === false
                          ? "border-dashed border-input bg-background text-muted-foreground/60 opacity-70 hover:opacity-100 hover:text-foreground"
                          : "border-dashed border-input bg-background text-muted-foreground hover:border-foreground/40 hover:text-foreground",
                )}
              >
                {side}
              </button>
            );
          };
          return (
            <div key={group} className={cn("rounded-xl border bg-muted/20", compact ? "p-2" : "p-2.5")}>
              <div className="mb-1.5 flex items-center justify-between gap-1">
                <span className={cn("text-[11px] font-bold uppercase tracking-wide", accent.text)}>{group}</span>
                <div className="flex items-center gap-1.5">
                  <ProgressPill done={n} total={names.length} />
                  <button
                    type="button"
                    onClick={() => setGroup(names, n < names.length)}
                    className="text-[10px] font-semibold text-muted-foreground underline underline-offset-2 hover:text-foreground"
                  >
                    {n < names.length ? "All" : "None"}
                  </button>
                </div>
              </div>
              <div className={cn("mx-auto grid grid-cols-3 gap-1", compact ? "max-w-[150px]" : "max-w-[170px]")}>
                <span />
                {cell("Back")}
                <span />
                {cell("Left")}
                <div className="flex aspect-square items-center justify-center rounded-lg bg-background ring-1 ring-foreground/10">
                  <Home className={cn("text-muted-foreground", compact ? "h-4 w-4" : "h-5 w-5")} />
                </div>
                {cell("Right")}
                <span />
                {cell("Front")}
                <span />
              </div>
            </div>
          );
        })}
      </div>
      {highlight ? (
        <p className="text-[10px] leading-snug text-muted-foreground">
          Solid outline = on the estimate. Faint = not bought, still tappable for an on-site add-on.
          {elsewhere && elsewhere.length > 0 ? " Dotted = already in another colour row; tap to move it." : ""}
        </p>
      ) : null}
    </div>
  );
}
