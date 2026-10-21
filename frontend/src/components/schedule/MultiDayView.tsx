/**
 * Google's Day-columns layout for 3 days and Week: on a laptop one column per
 * day with the stamp on top and the jobs stacked under it as all-day chips;
 * on a phone the same days top to bottom (never a sideways scroll). Tap a
 * stamp to open that day, tap a chip to open the job.
 *
 * Admins can also drag a job to another day and add a customer to any day
 * (Alan, 2026-10-21: Michelle Stout was put on Wednesday by mistake and had
 * to move to Thursday). A drag on a laptop starts after the mouse moves a
 * little, on a phone after holding the chip for a moment, so a plain tap
 * still opens the job and a swipe still scrolls.
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  DndContext, DragOverlay, PointerSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { Plus } from "lucide-react";
import type { PmDay } from "@/lib/api";
import { cn } from "@/lib/utils";
import { DayStamp, JobChip, type JobLinkComponent } from "./bits";
import { LINE, MUTED, PAPER, RING, TODAY_WASH } from "./look";
import { rankDay } from "./dates";

/** Laptop or phone. Only one layout is on the page at a time, so every day
 *  is one drop target (both hidden-by-CSS copies would confuse the drag). */
function useWide(): boolean {
  const q = "(min-width: 640px)";
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}

const keyOf = (x: PmDay) => `${x.lead_id}|${x.username}|${x.task}|${x.date}`;

function Draggable({ x, n, children, on }: { x: PmDay; n: number; children: ReactNode; on: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: keyOf(x), data: { x, n }, disabled: !on });
  return (
    <div ref={setNodeRef} {...(on ? listeners : {})} {...(on ? attributes : {})}
         className={cn(on && "touch-manipulation", isDragging && "opacity-30")}>
      {children}
    </div>
  );
}

function DropDay({ day, className, children }: { day: string; className: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: day });
  return <div ref={setNodeRef} className={cn(className, isOver && "bg-[#C9972F]/15 ring-2 ring-inset ring-[#C9972F]")}>{children}</div>;
}

export function MultiDayView({ dates, byDay, today, Link, onPickDay, maxChips, canEdit, onMove, onAdd, stacked }: {
  dates: string[]; byDay: Map<string, PmDay[]>; today: string; Link: JobLinkComponent;
  onPickDay: (d: string) => void;
  /** Week shows this many chips a day, then "+N more" (tap → that day). */
  maxChips?: number;
  canEdit?: boolean;
  /** Drop a job on another day. */
  onMove?: (x: PmDay, toDate: string) => void;
  /** "+ Add" under a day. */
  onAdd?: (d: string) => void;
  /** Week: narrow columns, so each job is two lines, the customer on top. */
  stacked?: boolean;
}) {
  const last = dates.length - 1;
  const dnd = !!(canEdit && onMove);
  const wide = useWide();
  const [dragging, setDragging] = useState<{ x: PmDay; n: number } | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );
  const onStart = (e: DragStartEvent) => setDragging((e.active.data.current as { x: PmDay; n: number }) || null);
  const onEnd = (e: DragEndEvent) => {
    setDragging(null);
    const x = (e.active.data.current as { x: PmDay } | undefined)?.x;
    const to = e.over ? String(e.over.id) : "";
    if (x && to && to !== x.date) onMove?.(x, to);
  };
  const chip = (x: PmDay, n: number) => (
    <Draggable key={keyOf(x)} x={x} n={n} on={dnd}><JobChip x={x} n={n} Link={Link} stacked={stacked && wide} /></Draggable>
  );
  const moreBtn = "flex min-h-11 w-full items-center rounded-lg px-2 text-left text-[14px] font-bold text-[#8C6224] hover:bg-[#F8F3E7] active:bg-[#E4DCCB]/60";
  const addBtn = (d: string) => canEdit && onAdd ? (
    <button type="button" onClick={() => onAdd(d)} aria-label={`Add a customer to ${d}`}
            className="flex min-h-11 w-full items-center gap-1.5 rounded-lg border border-dashed border-[#C9972F]/60 px-2 text-left text-[14px] font-bold text-[#8C6224] hover:bg-[#F8F3E7] active:bg-[#E4DCCB]/60">
      <Plus className="h-4 w-4" /> Add
    </button>
  ) : null;

  const body = wide ? (
      /* Laptop: columns. */
      <div className={cn("overflow-hidden rounded-2xl", PAPER, RING)}>
        <div className="grid" style={{ gridTemplateColumns: `repeat(${dates.length}, minmax(0, 1fr))` }}>
          {dates.map((d, i) => (
            <div key={d} className={cn("border-b", LINE, i < last && cn("border-r", LINE), d === today && TODAY_WASH)}>
              <DayStamp day={d} today={today} onClick={() => onPickDay(d)} column />
            </div>
          ))}
          {dates.map((d, i) => {
            const ranked = rankDay(byDay.get(d) || []);
            const cap = maxChips ?? ranked.length;
            return (
              <DropDay key={d} day={d} className={cn("min-h-[220px] space-y-1.5 p-1.5 transition-colors", i < last && cn("border-r", LINE), d === today && "bg-[#C9972F]/5")}>
                {ranked.slice(0, cap).map(({ x, n }) => chip(x, n))}
                {ranked.length > cap ? <button type="button" onClick={() => onPickDay(d)} className={moreBtn}>+{ranked.length - cap} more</button> : null}
                {addBtn(d)}
              </DropDay>
            );
          })}
        </div>
      </div>
  ) : (
      /* Phone: the same days, top to bottom. */
      <div className={cn("rounded-2xl", PAPER, RING)}>
        {dates.map((d, i) => {
          const ranked = rankDay(byDay.get(d) || []);
          return (
            <DropDay key={d} day={d} className={cn("grid grid-cols-[56px_1fr] gap-1.5 px-2 py-1.5 transition-colors", i > 0 && cn("border-t", LINE),
                                         i === 0 && "rounded-t-2xl", i === last && "rounded-b-2xl", d === today && TODAY_WASH)}>
              <DayStamp day={d} today={today} onClick={() => onPickDay(d)} />
              <div className="min-w-0 space-y-1.5 py-1">
                {ranked.length
                  ? ranked.map(({ x, n }) => chip(x, n))
                  : <p className={cn("flex min-h-11 items-center px-1 text-[15px]", MUTED)}>Nothing on.</p>}
                {addBtn(d)}
              </div>
            </DropDay>
          );
        })}
      </div>
  );
  if (!dnd) return body;
  return (
    <>
      <p className={cn("px-1 text-[14px]", MUTED)}>Drag a job to another day to move it. On a phone, hold it for a moment first.</p>
      <DndContext sensors={sensors} onDragStart={onStart} onDragEnd={onEnd} onDragCancel={() => setDragging(null)}>
        {body}
        <DragOverlay dropAnimation={null}>
          {dragging ? <div className="w-56 rotate-1 shadow-xl"><JobChip x={dragging.x} n={dragging.n} /></div> : null}
        </DragOverlay>
      </DndContext>
    </>
  );
}
