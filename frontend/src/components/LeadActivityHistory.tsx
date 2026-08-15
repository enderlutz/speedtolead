import { useEffect, useState } from "react";
import { api, type DailyActivityEvent } from "@/lib/api";
import { toast } from "sonner";
import { Loader2, Phone, CalendarClock, StickyNote, Send, ArrowRightLeft, Activity } from "lucide-react";

const CST = "America/Chicago";
// Full CST date + time, e.g. "Jul 6, 5:31 PM CST".
function fmtDateTimeCST(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    timeZone: CST, month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }) + " CST";
}

// Icon + accent per activity action, so the timeline scans quickly.
function actionStyle(action: string): { Icon: typeof Phone; cls: string } {
  switch (action) {
    case "call": return { Icon: Phone, cls: "text-emerald-600 bg-emerald-100" };
    case "follow_up": return { Icon: CalendarClock, cls: "text-amber-600 bg-amber-100" };
    case "note_edited":
    case "call_note_edited": return { Icon: StickyNote, cls: "text-violet-600 bg-violet-100" };
    case "estimate_sent":
    case "proposal_sent": return { Icon: Send, cls: "text-sky-600 bg-sky-100" };
    case "stage_changed": return { Icon: ArrowRightLeft, cls: "text-indigo-600 bg-indigo-100" };
    default: return { Icon: Activity, cls: "text-muted-foreground bg-muted" };
  }
}

// Per-lead activity timeline: calls, scheduled follow-ups (with whether each was
// done / missed-and-rolled / superseded / upcoming), stage moves, notes, sends.
// This is where the day-by-day scheduling record lives now that the Daily Task
// List collapses a lead onto a single day.
export default function LeadActivityHistory({ leadId }: { leadId: string }) {
  const [events, setEvents] = useState<DailyActivityEvent[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: raises the loading flag when this fetch's inputs change; the data itself lands asynchronously.
    setLoading(true);
    api.getLeadActivity(leadId)
      .then((r) => { if (alive) setEvents(r.events); })
      .catch(() => { if (alive) { toast.error("Couldn't load the activity history"); setEvents([]); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [leadId]);

  if (loading && !events) {
    return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }
  if (!events || events.length === 0) {
    return (
      <div className="rounded-xl border bg-muted/20 p-8 text-center text-sm text-muted-foreground">
        No activity recorded for this lead yet. Calls, scheduled follow-ups, stage
        moves, and sends will appear here as they happen.
      </div>
    );
  }
  return (
    <div className="rounded-xl border bg-background divide-y">
      {events.map((e) => {
        const { Icon, cls } = actionStyle(e.action);
        return (
          <div key={e.id} className="flex items-start gap-3 px-3 py-2.5">
            <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full shrink-0 ${cls}`}>
              <Icon className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm">
                <span className="font-medium">{e.actor_name || "System"}</span>{" "}
                <span className="text-foreground/90">{e.summary}</span>
              </div>
              <div className="text-[11px] text-muted-foreground">{fmtDateTimeCST(e.at)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
