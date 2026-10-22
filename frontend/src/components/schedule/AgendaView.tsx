/**
 * Google's Schedule view: a vertical list, a sticky band per month, a row per
 * day that has something on it (empty days are skipped, the way Google does
 * it; today still shows so there is a place to stand). Each row: the day
 * stamp on the left, one line per worker-and-job on the right.
 */
import { ChevronDown, ChevronUp } from "lucide-react";
import type { PmDay } from "@/lib/api";
import { cn } from "@/lib/utils";
import { DayStamp, type JobLinkComponent } from "./bits";
import { INK, IVORY, LINE, MUTED, PAPER, RING, TASK_DOT, TASK_WORD, isDone } from "./look";
import { fmt, groupByDay, groupJobs, groupKey, monthBand, monthKey, payLine, type JobGroup } from "./dates";

const shortDay = (d: string) => fmt(d, { month: "short", day: "numeric" });

export function AgendaView({ days, start, end, today, Link, onPickDay, onEarlier, onLater, showPay }: {
  days: PmDay[]; start: string; end: string; today: string; Link: JobLinkComponent;
  onPickDay: (d: string) => void; onEarlier: () => void; onLater: () => void; showPay?: boolean;
}) {
  const byDay = groupByDay(days);
  const dates = [...byDay.keys()].filter((d) => d >= start && d <= end);
  if (today >= start && today <= end && !byDay.has(today)) dates.push(today);
  dates.sort();
  const months: { key: string; dates: string[] }[] = [];
  for (const d of dates) {
    const last = months[months.length - 1];
    if (last && last.key === monthKey(d)) last.dates.push(d); else months.push({ key: monthKey(d), dates: [d] });
  }
  const more = "flex min-h-12 w-full items-center justify-center gap-1.5 text-[15px] font-bold text-[#8C6224] hover:bg-[#F8F3E7] active:bg-[#E4DCCB]/60";

  return (
    <div className={cn("rounded-2xl", PAPER, RING)}>
      <button type="button" onClick={onEarlier} className={cn(more, "rounded-t-2xl")}>
        <ChevronUp className="h-5 w-5" />Earlier · before {shortDay(start)}
      </button>
      {months.length === 0 ? (
        <p className={cn("border-t px-4 py-10 text-center text-[16px]", LINE, MUTED)}>Nothing on the schedule from {shortDay(start)} to {shortDay(end)}.</p>
      ) : months.map((m) => (
        <section key={m.key}>
          <h3 className={cn("sticky top-0 z-10 border-y px-4 py-2 text-[12px] font-bold uppercase tracking-[0.16em]", IVORY, LINE, MUTED)}>
            {monthBand(m.dates[0])}
          </h3>
          {m.dates.map((d, i) => <DayRow key={d} day={d} today={today} first={i === 0} items={byDay.get(d) || []} Link={Link} onPick={() => onPickDay(d)} showPay={showPay} />)}
        </section>
      ))}
      <button type="button" onClick={onLater} className={cn(more, "rounded-b-2xl border-t", LINE)}>
        <ChevronDown className="h-5 w-5" />Later · after {shortDay(end)}
      </button>
    </div>
  );
}

function DayRow({ day, today, first, items, Link, onPick, showPay }: {
  day: string; today: string; first: boolean; items: PmDay[]; Link: JobLinkComponent; onPick: () => void; showPay?: boolean;
}) {
  const groups = groupJobs(items);
  return (
    <div className={cn("grid grid-cols-[56px_1fr] gap-1 px-2 py-1.5", !first && cn("border-t", LINE), day === today && "bg-[#C9972F]/10")}>
      <DayStamp day={day} today={today} onClick={onPick} />
      <div className="min-w-0 py-0.5">
        {groups.length === 0
          ? <p className={cn("flex min-h-11 items-center px-2 text-[15px]", MUTED)}>Nothing on today.</p>
          : groups.map((g) => <JobLine key={groupKey(g)} g={g} Link={Link} showPay={showPay} />)}
      </div>
    </div>
  );
}

/** "● Jose + Christian · 1. Michelle Stout · staining" with the address under it. */
function JobLine({ g, Link, showPay }: { g: JobGroup; Link: JobLinkComponent; showPay?: boolean }) {
  const x = g.x;
  const fin = g.rows.every(isDone);
  const stains = g.tasks.includes("staining");
  const pw = g.rows.find((r) => r.pw_services?.length)?.pw_services || [];
  return (
    <Link leadId={x.lead_id} className={cn("flex min-h-11 items-start gap-2.5 rounded-xl px-2 py-1.5 hover:bg-[#F8F3E7] active:bg-[#E4DCCB]/60", fin ? MUTED : INK)}>
      <span className={cn("mt-[7px] h-2.5 w-2.5 shrink-0 rounded-full", fin ? "bg-[#E4DCCB]" : TASK_DOT[g.tasks[0]] ?? TASK_DOT[""])} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[16px] leading-snug">
          {fin ? "✓ " : ""}
          <b className="font-bold">{g.people}</b>
          {" · "}{g.n}. {x.name}{" · "}
          <span className={cn(!fin && (stains ? "font-semibold text-[#B5651D]" : MUTED))}>{g.tasks.map((t) => TASK_WORD[t] ?? t).join(" + ")}</span>
          {g.tasks.includes("pressure_washing") && pw.length ? <span className={MUTED}>{" · "}{pw.join(", ")}</span> : null}
        </span>
        <span className={cn("block truncate text-[14px] leading-snug", MUTED)}>{x.address}</span>
        {showPay ? <span className={cn("block text-[14px] font-bold leading-snug tabular-nums", payLine(g).includes("not set") ? "text-amber-700" : "text-[#8C6224]")}>💵 {payLine(g)}</span> : null}
      </span>
    </Link>
  );
}
