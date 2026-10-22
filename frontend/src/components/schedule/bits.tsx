/**
 * The small parts every schedule view shares: the Sterling colours, Google's
 * day stamp (weekday small, number big, today in a gold circle) and the
 * one-line job chip. Read outdoors on a phone: nothing under 14px, every tap
 * target 44px tall.
 */
import type { ComponentType, ReactNode } from "react";
import type { PmDay } from "@/lib/api";
import { cn } from "@/lib/utils";
import { dayNumber, fmt, payLine, weekdayShort, type JobGroup } from "./dates";
import { INK, IVORY, MUTED, PAPER, RING, TASK_ICON, TASK_WORD, isDone } from "./look";

/** How a job opens. The page hands in its own JobLink: the office opens the
 *  customer's Company Cam page, a view-only login gets plain text. */
export type JobLinkComponent = ComponentType<{ leadId: string; className: string; children: ReactNode }>;

const longDay = (d: string) => fmt(d, { weekday: "long", month: "long", day: "numeric" });

/**
 * Google's day stamp. In a list (the schedule, a phone's stacked days) the
 * number sits on top with the weekday under it, in a 56px rail. As a column
 * header the weekday goes on top. Today's number is a filled gold circle.
 */
export function DayStamp({ day, today, onClick, column }: { day: string; today: string; onClick?: () => void; column?: boolean }) {
  const isToday = day === today;
  const weekday = <span className={cn("text-[12px] font-bold uppercase leading-none tracking-[0.1em]", isToday ? "text-[#C9972F]" : MUTED)}>{weekdayShort(day)}</span>;
  const number = (
    <span className={cn("flex h-10 w-10 items-center justify-center rounded-full text-[22px] font-bold tabular-nums leading-none",
      isToday ? "bg-[#C9972F] text-[#15130F] shadow-sm" : INK)}>{dayNumber(day)}</span>
  );
  const cls = cn("flex shrink-0 flex-col items-center justify-center gap-1 rounded-xl",
    column ? "min-h-[72px] w-full py-2" : "min-h-[64px] w-14 py-1",
    onClick && "hover:bg-[#F8F3E7] active:bg-[#E4DCCB]/60");
  const inner = column ? <>{weekday}{number}</> : <>{number}{weekday}</>;
  if (!onClick) return <div className={cls}>{inner}</div>;
  return <button type="button" onClick={onClick} aria-label={`Open ${longDay(day)}`} className={cls}>{inner}</button>;
}

/**
 * "🖌️ 1 Jose + Christian · Michelle Stout": one card per job, the lead tech
 * and anyone helping, cut off with … when it runs out of room. A finished
 * one gets a ✓ and goes quiet. `stacked` (Week) puts the customer's name on
 * top, wrapping, and the people under it. `tiny` is the month grid's size
 * (the cell is the tap target, so the chip is a plain span).
 */
export function JobChip({ g, Link, tiny, stacked, showPay }: { g: JobGroup; Link?: JobLinkComponent; tiny?: boolean; stacked?: boolean; showPay?: boolean }) {
  const x = g.x;
  const fin = g.rows.every(isDone);
  const icons = g.tasks.map((t) => TASK_ICON[t] ?? "•").join("");
  const pw = g.rows.find((r) => r.pw_services?.length)?.pw_services || [];
  const cls = cn("flex w-full gap-1.5 rounded-lg text-left text-[14px] font-semibold leading-tight", RING,
    stacked ? "flex-col items-stretch px-2 py-1.5" : "items-center",
    tiny ? "min-h-7 px-1.5" : stacked ? "min-h-11" : "min-h-11 px-2",
    fin ? cn(IVORY, MUTED) : cn(PAPER, INK, !tiny && "hover:bg-[#F8F3E7] active:bg-[#E4DCCB]/60"));
  const icon = <span className="shrink-0 text-[14px] leading-none" aria-hidden>{fin ? "✓" : icons}</span>;
  const body = stacked ? (
    <>
      <span className="line-clamp-2 break-words text-[15px] font-bold">{x.name}</span>
      <span className={cn("flex items-start gap-1.5 text-[14px] font-medium", MUTED)}>{icon}<span className="line-clamp-2 break-words">{g.n} · {g.people}</span></span>
      {g.tasks.includes("pressure_washing") && pw.length ? <span className={cn("line-clamp-2 text-[14px]", MUTED)}>{pw.join(" · ")}</span> : null}
      {showPay ? <span className={cn("text-[14px] font-bold tabular-nums", payLine(g).includes("not set") ? "text-amber-700" : "text-[#8C6224]")}>💵 {payLine(g)}</span> : null}
    </>
  ) : (
    <>
      {icon}
      <span className="min-w-0 flex-1 truncate">{g.n} {g.people} · {x.name}</span>
      {showPay ? <span className={cn("shrink-0 text-[14px] font-bold tabular-nums", payLine(g).includes("not set") ? "text-amber-700" : "text-[#8C6224]")}>{payLine(g)}</span> : null}
    </>
  );
  const title = `${[...g.leads, ...g.helpers].map((r) => r.person + (r.helper ? " (helper)" : "")).join(", ")} · ${x.name} · ${g.tasks.map((t) => TASK_WORD[t] ?? t).join(" + ")}`;
  if (tiny || !Link) return <span className={cls} title={title}>{body}</span>;
  return <Link leadId={x.lead_id} className={cls}>{body}</Link>;
}

/** The header over the Day view: the stamp, how many jobs and workers, a Today pill. */
export function DayBanner({ day, today, items }: { day: string; today: string; items: PmDay[] }) {
  const jobs = new Set(items.map((x) => x.lead_id)).size;
  const workers = new Set(items.map((x) => x.username)).size;
  const s = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
  return (
    <div className={cn("flex items-center gap-3 rounded-2xl px-3 py-1.5", PAPER, RING)}>
      <DayStamp day={day} today={today} />
      <div className="min-w-0">
        <p className={cn("flex flex-wrap items-center gap-2 font-heading text-[18px] font-bold leading-tight", INK)}>
          {fmt(day, { month: "long", day: "numeric", year: "numeric" })}
          {day === today ? <span className="rounded-full bg-[#C9972F] px-2 py-0.5 text-[12px] font-bold uppercase tracking-[0.1em] text-[#15130F]">Today</span> : null}
        </p>
        <p className={cn("text-[15px]", MUTED)}>{jobs ? `${s(jobs, "job")} · ${s(workers, "worker")}` : "Nothing on this day"}</p>
      </div>
    </div>
  );
}
