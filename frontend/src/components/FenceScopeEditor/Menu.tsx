// A small menu for the editor's dock.
//
// On a desktop it pops up above its button; on a phone it rises as a sheet
// from the bottom of the screen, where a thumb can reach it. Either way a
// full-screen backdrop sits underneath, so the tap that closes it can't also
// land on the canvas and drop a fence point.
import { useState } from "react";
import { Check, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

export function Menu({
  label, icon: Icon, title, align = "left", children,
}: {
  label?: string;
  icon: React.ElementType;
  title: string;
  align?: "left" | "right";
  /** Rendered with a `close` so an item can shut the menu after acting. */
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <div className="relative">
      <button
        type="button"
        title={title}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex h-9 items-center gap-1 rounded-xl px-2.5 text-xs font-semibold transition active:scale-95",
          open ? "bg-white/15 text-white" : "text-white/85 hover:bg-white/10",
        )}
      >
        <Icon className="h-4 w-4" />
        {label ? <span>{label}</span> : null}
        <ChevronUp className={cn("h-3 w-3 opacity-60 transition", open && "rotate-180")} />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-40 bg-black/30 sm:bg-transparent" onClick={close} />
          <div
            className={cn(
              "z-50 rounded-2xl bg-ivory p-1.5 text-ink shadow-2xl shadow-black/30 ring-1 ring-gold/40",
              "fixed inset-x-2 bottom-2 max-h-[70dvh] overflow-y-auto",
              "sm:absolute sm:inset-x-auto sm:bottom-full sm:mb-2 sm:max-h-none sm:w-64",
              align === "right" ? "sm:right-0" : "sm:left-0",
            )}
          >
            {children(close)}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function MenuItem({
  icon: Icon, label, hint, shortcut, checked, disabled, danger, onClick,
}: {
  icon?: React.ElementType;
  label: string;
  hint?: string;
  shortcut?: string;
  /** A tick on the right, for a setting that is on. */
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition",
        "disabled:cursor-not-allowed disabled:opacity-40",
        danger ? "text-red-700 hover:bg-red-50" : "hover:bg-gold/15",
      )}
    >
      {Icon ? <Icon className={cn("h-4 w-4 shrink-0", danger ? "text-red-600" : "text-bronze")} /> : null}
      <span className="min-w-0 flex-1">
        <span className="block font-semibold leading-tight">{label}</span>
        {hint ? <span className="block text-[11px] leading-snug text-muted-foreground">{hint}</span> : null}
      </span>
      {shortcut ? (
        <kbd className="hidden rounded-md border border-ink/15 bg-white px-1.5 text-[10px] font-semibold text-ink/60 sm:inline">{shortcut}</kbd>
      ) : null}
      {checked ? <Check className="h-4 w-4 shrink-0 text-emerald-600" /> : null}
    </button>
  );
}

export function MenuLabel({ children }: { children: React.ReactNode }) {
  return <p className="px-2.5 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.18em] text-bronze/80">{children}</p>;
}

export function MenuRule() {
  return <div className="my-1 h-px bg-gold/25" />;
}
