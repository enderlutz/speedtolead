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
 *
 * A job to fix on a day (Alan, 2026-10-27) sits under the real jobs as a
 * dashed 🔧 placeholder, and drags to another day the same way.
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  DndContext, DragOverlay, PointerSensor, TouchSensor, pointerWithin, rectIntersection, useDraggable, useDroppable, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { Plus } from "lucide-react";
import type { FixJob, PmDay } from "@/lib/api";
import { cn } from "@/lib/utils";
import { DayStamp, JobChip, type JobLinkComponent } from "./bits";
import { FixChip } from "./FixJobs";
import { LINE, MUTED, PAPER, RING, TODAY_WASH } from "./look";
import { groupJobs, groupKey, type JobGroup } from "./dates";

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

function Draggable({ g, children, on }: { g: JobGroup; children: ReactNode; on: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: groupKey(g), data: { g }, disabled: !on });
  // Each card is also a drop spot: drop a job on it to take its place in the day
  // (Alan, 2026-10-22: Harold above Charlotte on Friday).
  const drop = useDroppable({ id: `chip:${groupKey(g)}`, data: { g }, disabled: !on });
  const ref = (el: HTMLElement | null) => { setNodeRef(el); drop.setNodeRef(el); };
  return (
    <div ref={ref} {...(on ? listeners : {})} {...(on ? attributes : {})}
         className={cn("rounded-xl", on && "touch-manipulation", isDragging && "opacity-30",
                       drop.isOver && !isDragging && "ring-2 ring-[#C9972F] ring-offset-2")}>
      {children}
    </div>
  );
}

function DraggableFix({ f, children, on }: { f: FixJob; children: ReactNode; on: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `fix:${f.id}`, data: { fix: f }, disabled: !on });
  return (
    <div ref={setNodeRef} {...(on ? listeners : {})} {...(on ? attributes : {})} className={cn("rounded-xl", on && "touch-manipulation", isDragging && "opacity-30")}>
      {children}
    </div>
  );
}

function DropDay({ day, className, children }: { day: string; className: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: day });
  return <div ref={setNodeRef} className={cn(className, isOver && "bg-[#C9972F]/15 ring-2 ring-inset ring-[#C9972F]")}>{children}</div>;
}

export function MultiDayView({ dates, byDay, today, Link, onPickDay, maxChips, canEdit, onMove, onReorder, onAdd, stacked, showPay, fixesByDay, onMoveFix, onOpenFix, whoOf }: {
  dates: string[]; byDay: Map<string, PmDay[]>; today: string; Link: JobLinkComponent;
  onPickDay: (d: string) => void;
  /** Week shows this many chips a day, then "+N more" (tap → that day). */
  maxChips?: number;
  canEdit?: boolean;
  /** Drop a job (the lead tech and their helpers) on another day. */
  onMove?: (g: JobGroup, toDate: string) => void;
  /** The day's customers in their new running order, first = where they start. */
  onReorder?: (day: string, leadIds: string[]) => void;
  /** "+ Add" under a day. */
  onAdd?: (d: string) => void;
  /** Week: narrow columns, so each job is two lines, the customer on top. */
  stacked?: boolean;
  /** Each worker's pay on the card (office only). */
  showPay?: boolean;
  /** The jobs to fix on each day, shown under the real jobs. */
  fixesByDay?: Map<string, FixJob[]>;
  /** Drop a job to fix on another day. */
  onMoveFix?: (f: FixJob, toDate: string) => void;
  /** Tap a job to fix. */
  onOpenFix?: (f: FixJob) => void;
  /** A worker's first name from their username, for the fix chip. */
  whoOf?: (username: string) => string;
}) {
  const last = dates.length - 1;
  const dnd = !!(canEdit && (onMove || onMoveFix));
  const wide = useWide();
  const [dragging, setDragging] = useState<{ g?: JobGroup; fix?: FixJob } | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );
  const onStart = (e: DragStartEvent) => setDragging((e.active.data.current as { g?: JobGroup; fix?: FixJob } | undefined) || null);
  // A card under the finger wins over the day around it.
  const collide: CollisionDetection = (args) => {
    const hits = pointerWithin(args);
    if (hits.length) return [...hits].sort((a, b) => Number(String(b.id).startsWith("chip:")) - Number(String(a.id).startsWith("chip:")));
    return rectIntersection(args);
  };
  const onEnd = (e: DragEndEvent) => {
    setDragging(null);
    const data = e.active.data.current as { g?: JobGroup; fix?: FixJob } | undefined;
    if (!data || !e.over) return;
    const overId = String(e.over.id);
    const t = overId.startsWith("chip:") ? (e.over.data.current as { g: JobGroup } | undefined)?.g : undefined;
    const to = t ? t.x.date : overId;
    if (data.fix) { if (to !== data.fix.date) onMoveFix?.(data.fix, to); return; }
    const g = data.g;
    if (!g) return;
    if (to !== g.x.date) { onMove?.(g, to); return; }
    if (!t || t.key === g.key || !onReorder) return;
    // Same day: take the dropped-on card's spot.
    const ids = groupJobs(byDay.get(to) || []).map((x) => x.key);
    const from = ids.indexOf(g.key), at = ids.indexOf(t.key);
    if (from < 0 || at < 0) return;
    ids.splice(from, 1);
    ids.splice(at, 0, g.key);
    onReorder(to, ids);
  };
  const chip = (g: JobGroup) => (
    <Draggable key={groupKey(g)} g={g} on={dnd}><JobChip g={g} Link={Link} stacked={stacked && wide} showPay={showPay} /></Draggable>
  );
  const fixChip = (f: FixJob) => (
    <DraggableFix key={`fix:${f.id}`} f={f} on={dnd && !!onMoveFix}>
      <FixChip f={f} who={f.username && whoOf ? whoOf(f.username) : undefined} stacked={stacked && wide} onClick={onOpenFix ? () => onOpenFix(f) : undefined} />
    </DraggableFix>
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
            const groups = groupJobs(byDay.get(d) || []);
            const cap = maxChips ?? groups.length;
            return (
              <DropDay key={d} day={d} className={cn("min-h-[220px] space-y-1.5 p-1.5 transition-colors", i < last && cn("border-r", LINE), d === today && "bg-[#C9972F]/5")}>
                {groups.slice(0, cap).map(chip)}
                {groups.length > cap ? <button type="button" onClick={() => onPickDay(d)} className={moreBtn}>+{groups.length - cap} more</button> : null}
                {(fixesByDay?.get(d) || []).map(fixChip)}
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
          const groups = groupJobs(byDay.get(d) || []);
          const fixes = fixesByDay?.get(d) || [];
          return (
            <DropDay key={d} day={d} className={cn("grid grid-cols-[56px_1fr] gap-1.5 px-2 py-1.5 transition-colors", i > 0 && cn("border-t", LINE),
                                         i === 0 && "rounded-t-2xl", i === last && "rounded-b-2xl", d === today && TODAY_WASH)}>
              <DayStamp day={d} today={today} onClick={() => onPickDay(d)} />
              <div className="min-w-0 space-y-1.5 py-1">
                {groups.length || fixes.length
                  ? groups.map(chip)
                  : <p className={cn("flex min-h-11 items-center px-1 text-[15px]", MUTED)}>Nothing on.</p>}
                {fixes.map(fixChip)}
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
      <p className={cn("px-1 text-[14px]", MUTED)}>Drag a job to another day to move it, or onto another job to swap their order. On a phone, hold it for a moment first.</p>
      <DndContext sensors={sensors} collisionDetection={collide} onDragStart={onStart} onDragEnd={onEnd} onDragCancel={() => setDragging(null)}>
        {body}
        <DragOverlay dropAnimation={null}>
          {dragging?.g ? <div className="w-56 rotate-1 shadow-xl"><JobChip g={dragging.g} /></div>
            : dragging?.fix ? <div className="w-56 rotate-1 shadow-xl"><FixChip f={dragging.fix} /></div> : null}
        </DragOverlay>
      </DndContext>
    </>
  );
}
