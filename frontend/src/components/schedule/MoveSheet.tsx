/**
 * Moving a job on a phone (Alan, 2026-11-02: "moving customers around is
 * horrendously hard to do"). Holding a card and dragging it down a phone
 * screen barely worked, so every card has a Move button that opens this
 * sheet from the bottom: tap a day to put the job there, or Move up / Move
 * down to change that day's order. It runs the same moves the drag does;
 * the drag still works on a laptop.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, CalendarDays, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { dayList, fmt } from "./dates";
import { INK, MUTED, PAPER, RING } from "./look";

export function MoveSheet({ name, detail, from, today, onDay, place, onUp, onDown, onClose }: {
  name: string;
  /** A short line under the name: who's on it, or what the fix is. */
  detail?: string;
  /** The day it's on now ("" for a job to fix with no day yet). */
  from: string;
  today: string;
  onDay: (to: string) => void;
  /** Where it sits in the day's order, when the day has more than one job. */
  place?: { n: number; of: number };
  onUp?: () => void;
  onDown?: () => void;
  onClose: () => void;
}) {
  const [other, setOther] = useState("");
  // Escape closes it, and the page behind doesn't scroll while it's open.
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", key); document.body.style.overflow = was; };
  }, [onClose]);

  const days = dayList(today, 14);
  const go = (to: string) => { if (to && to !== from) onDay(to); };
  const order = place && place.of > 1 && (onUp || onDown);

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={`Move ${name}`}>
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/45" />
      <div className={cn("relative max-h-[88dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl p-4 pb-[max(env(safe-area-inset-bottom),16px)] shadow-2xl sm:rounded-3xl", PAPER, INK)}>
        <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-[#E4DCCB] sm:hidden" aria-hidden />
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate font-heading text-[20px] font-bold leading-tight">Move {name}</p>
            <p className={cn("truncate text-[15px]", MUTED)}>
              {from ? `Now on ${fmt(from, { weekday: "long", month: "short", day: "numeric" })}` : "Not on a day yet"}{detail ? ` · ${detail}` : ""}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-[#F8F3E7] active:bg-[#E4DCCB]/60">
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mt-4 text-[16px] font-bold">Move to which day?</p>
        <div className="-mx-4 mt-2 flex snap-x gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {days.map((d) => {
            const now = d === from;
            const isToday = d === today;
            return (
              <button key={d} type="button" disabled={now} onClick={() => go(d)}
                      className={cn("flex min-h-[68px] w-[72px] shrink-0 snap-start flex-col items-center justify-center rounded-2xl text-center ring-1 transition-colors",
                        now ? "bg-[#F8F3E7] text-[#6B6256] ring-[#E4DCCB]"
                          : isToday ? "bg-[#C9972F] text-[#15130F] ring-[#C9972F] active:bg-[#B3851F]"
                          : "bg-white ring-[#E4DCCB] hover:bg-[#F8F3E7] active:bg-[#E4DCCB]/60")}>
                <span className="text-[14px] font-bold uppercase leading-none tracking-wide">{isToday ? "Today" : fmt(d, { weekday: "short" })}</span>
                <span className="mt-1 text-[17px] font-bold tabular-nums leading-none">{fmt(d, { month: "numeric", day: "numeric" })}</span>
                {now ? <span className="mt-1 text-[12px] font-semibold leading-none">now</span> : null}
              </button>
            );
          })}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl bg-white px-3 ring-1 ring-[#E4DCCB]">
            <CalendarDays className={cn("h-5 w-5 shrink-0", MUTED)} aria-hidden />
            <span className="sr-only">Another day</span>
            <input type="date" value={other} onChange={(e) => setOther(e.target.value)}
                   className="min-h-12 min-w-0 flex-1 bg-transparent text-[16px] outline-none" />
          </label>
          <button type="button" disabled={!other || other === from} onClick={() => go(other)}
                  className="min-h-12 shrink-0 rounded-xl bg-[#15130F] px-4 text-[15px] font-bold text-[#E3BE63] disabled:opacity-40">
            Move there
          </button>
        </div>

        {order ? (
          <>
            <p className="mt-5 text-[16px] font-bold">Order on this day <span className={cn("font-normal", MUTED)}>· number {place!.n} of {place!.of}</span></p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button type="button" disabled={!onUp || place!.n <= 1} onClick={onUp}
                      className={cn("flex min-h-12 items-center justify-center gap-1.5 rounded-xl bg-white text-[15px] font-bold disabled:opacity-40", RING)}>
                <ArrowUp className="h-5 w-5" />Move up
              </button>
              <button type="button" disabled={!onDown || place!.n >= place!.of} onClick={onDown}
                      className={cn("flex min-h-12 items-center justify-center gap-1.5 rounded-xl bg-white text-[15px] font-bold disabled:opacity-40", RING)}>
                <ArrowDown className="h-5 w-5" />Move down
              </button>
            </div>
          </>
        ) : null}

        <button type="button" onClick={onClose}
                className={cn("mt-5 min-h-12 w-full rounded-xl text-[15px] font-bold hover:bg-[#F8F3E7]", RING)}>
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** The Move button on a card: a word on a phone, an icon in a laptop's narrow week column. */
export function MoveButton({ name, onClick, compact }: { name: string; onClick: () => void; compact?: boolean }) {
  return (
    <button type="button" onClick={onClick} aria-label={`Move ${name}`} title="Move to another day or change the order"
            className={cn("flex shrink-0 items-center justify-center gap-1 rounded-lg text-[14px] font-bold text-[#8C6224] ring-1 ring-[#E4DCCB] hover:bg-[#F8F3E7] active:bg-[#E4DCCB]/60",
              compact ? "w-7" : "min-h-11 px-2.5")}>
      <CalendarDays className="h-4 w-4" />{compact ? null : "Move"}
    </button>
  );
}
