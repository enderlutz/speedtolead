// The shared card grammar for the customer pages.
//
// Every section is a `Panel`: a coloured header band with a gradient icon
// chip, a title, an optional one-line subtitle, and whatever controls belong
// at the top right. The colour comes from `lib/accents` so the same stage of
// a job looks the same on the Estimate tab and on Company Cam.
//
// `Panel` replaces CardHeader/CardContent here because the band has to run
// the full width of the card, under the icon chip, which the shadcn header's
// padding does not allow.
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Accent } from "@/lib/accents";

export function Panel({
  id, icon: Icon, title, sub, right, accent, className, bodyClassName,
  collapsed, onToggle, children,
}: {
  id?: string;
  icon: React.ElementType;
  title: React.ReactNode;
  sub?: React.ReactNode;
  right?: React.ReactNode;
  accent: Accent;
  className?: string;
  bodyClassName?: string;
  /** When `onToggle` is given the header is a button and the body hides
   *  while `collapsed` is true. */
  collapsed?: boolean;
  onToggle?: () => void;
  children?: React.ReactNode;
}) {
  const chip = (
    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${accent.grad} shadow-sm shadow-black/10`}>
      <Icon className="h-4 w-4 text-white" />
    </div>
  );
  const text = (
    <div className="min-w-0 flex-1 text-left">
      <div className="font-heading text-sm font-semibold leading-tight">{title}</div>
      {sub ? <div className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">{sub}</div> : null}
    </div>
  );
  const bandCls = `flex w-full items-center gap-3 bg-gradient-to-r ${accent.band} px-3.5 py-3`;
  return (
    <Card id={id} className={cn("gap-0 py-0", className)}>
      {onToggle ? (
        // The title and the chevron both fold the card. `right` sits between
        // them, outside either button, so a control in the header is never
        // a button inside a button.
        <div className={cn(bandCls, !collapsed && "border-b")}>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            className="flex min-w-0 flex-1 items-center gap-3 text-left transition hover:opacity-90"
          >
            {chip}
            {text}
          </button>
          {right}
          <button
            type="button"
            onClick={onToggle}
            aria-label={collapsed ? "Open" : "Fold"}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-black/5 hover:text-foreground"
          >
            {collapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          </button>
        </div>
      ) : (
        <div className={cn(bandCls, "border-b")}>
          {chip}
          {text}
          {right}
        </div>
      )}
      {collapsed ? null : (
        <div className={cn("space-y-3 p-3.5", bodyClassName)}>{children}</div>
      )}
    </Card>
  );
}

/** A labelled control. The label is small caps so the value underneath is
 *  what the eye lands on. */
export function Field({
  label, hint, right, children, className,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </label>
        {right}
      </div>
      {children}
      {hint ? <p className="text-[11px] leading-snug text-muted-foreground/80">{hint}</p> : null}
    </div>
  );
}

/** A number with its own icon chip, so a row of numbers reads as a row of
 *  things rather than as a form. */
export function StatTile({
  icon: Icon, label, accent, hint, className, children,
}: {
  icon: React.ElementType;
  label: string;
  accent: Accent;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-xl border bg-card p-3", className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${accent.grad} shadow-sm`}>
          <Icon className="h-3.5 w-3.5 text-white" />
        </div>
      </div>
      {children}
      {hint ? <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** "3 of 4". A checklist with nothing showing its own progress gets half
 *  filled in and abandoned. */
export function ProgressPill({ done, total }: { done: number; total: number }) {
  const all = total > 0 && done === total;
  return (
    <span className={cn(
      "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums",
      all ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground",
    )}>
      {all ? <Check className="h-2.5 w-2.5" /> : null}{done} of {total}
    </span>
  );
}

/** A checkbox that looks like a button. Pressed is a filled gradient, so the
 *  state of a row of these reads at a glance. */
export function ToggleChip({
  on, onClick, icon: Icon, accent, disabled, title, className, children,
}: {
  on: boolean;
  onClick: () => void;
  icon?: React.ElementType;
  accent: Accent;
  disabled?: boolean;
  title?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        "inline-flex h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-semibold transition select-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        on
          ? `border-transparent bg-gradient-to-br ${accent.grad} text-white shadow-sm`
          : "border-input bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground",
        className,
      )}
    >
      {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
      {children}
      {on ? <Check className="h-3.5 w-3.5" /> : null}
    </button>
  );
}

/** A soft rounded label in an accent's colour. Replaces `Badge` where the
 *  fixed height got in the way. */
export function Pill({
  accent, className, children, title,
}: {
  accent: Accent;
  className?: string;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold", accent.soft, className)}
    >
      {children}
    </span>
  );
}
