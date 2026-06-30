import { useState, useEffect, useCallback } from "react";
import { useNavigate, Link } from "react-router-dom";
import { api, getCurrentUser, type EstimatorSchedule, type EstimatorVisit } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import EstimatorScheduleModal from "@/components/EstimatorScheduleModal";
import { toast } from "sonner";
import { MapPin, ChevronRight, ChevronDown, ChevronLeft, Clock, Loader2, Calendar as CalendarIcon, RefreshCw, Plus } from "lucide-react";

// ── date helpers (local time — this is browser app code) ──────────────────
function toYMD(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}
function mondayOf(d: Date): Date {
  const x = new Date(d);
  const day = x.getDay();                 // 0 Sun .. 6 Sat
  const diff = day === 0 ? -6 : 1 - day;  // back up to Monday
  x.setDate(x.getDate() + diff);
  x.setHours(0, 0, 0, 0);
  return x;
}
function fmtTime(hhmm: string): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m || 0).padStart(2, "0")} ${period}`;
}

/** The estimator's home screen: just the weekly calendar. Tapping a day opens
 *  that day's page (clock in/out + the list of estimates). */
export default function Estimator() {
  const user = getCurrentUser();
  const isEstimator = user?.role === "estimator";
  const isAdmin = user?.role === "admin";
  const navigate = useNavigate();

  const [weekStart, setWeekStart] = useState<string>(() => toYMD(mondayOf(new Date())));
  const [schedule, setSchedule] = useState<EstimatorSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);

  const loadSchedule = useCallback(() => {
    setLoading(true);
    api.getEstimatorSchedule(weekStart)
      .then(setSchedule)
      .catch(() => toast.error("Couldn't load the schedule"))
      .finally(() => setLoading(false));
  }, [weekStart]);

  useEffect(() => { loadSchedule(); }, [loadSchedule]);

  const shiftWeek = (deltaDays: number) => {
    const d = new Date(`${weekStart}T00:00:00`);
    d.setDate(d.getDate() + deltaDays);
    setWeekStart(toYMD(mondayOf(d)));
  };

  const weekLabel = (() => {
    if (!schedule) return "";
    const start = new Date(`${schedule.week_start}T00:00:00`);
    const end = new Date(start); end.setDate(end.getDate() + 6);
    const f = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `${f(start)} – ${f(end)}`;
  })();

  const totalStops = schedule?.days.reduce((n, d) => n + d.visits.length, 0) ?? 0;

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-3xl mx-auto">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight flex items-center gap-2">
            <MapPin className="h-5 w-5 text-primary" /> Estimator
          </h1>
          <p className="text-xs text-muted-foreground">
            {isEstimator ? "Your week" : schedule?.estimator_name ? `${schedule.estimator_name}'s week` : "Schedule"}
            {totalStops ? ` • ${totalStops} stop${totalStops === 1 ? "" : "s"}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={loadSchedule} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          {isAdmin && (
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4 mr-1" /> Add estimate
            </Button>
          )}
        </div>
      </div>

      {/* Week navigation */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => shiftWeek(-7)}>
          <ChevronLeft className="h-4 w-4 mr-1" /> Prev
        </Button>
        <div className="text-sm font-medium flex items-center gap-2">
          <CalendarIcon className="h-4 w-4 text-muted-foreground" /> {weekLabel}
        </div>
        <Button variant="ghost" size="sm" onClick={() => shiftWeek(7)}>
          Next <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
      </div>

      {/* Days — tap one to open its page */}
      {loading && !schedule ? (
        <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="space-y-2">
          {schedule?.days.map((day) => (
            <DayRow key={day.date} date={day.date} weekday={day.weekday} visits={day.visits}
                    onOpen={() => navigate(`/estimator/day/${day.date}`)} />
          ))}
        </div>
      )}

      {addOpen && (
        <EstimatorScheduleModal
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); loadSchedule(); }}
        />
      )}
    </div>
  );
}

function DayRow({ date, weekday, visits, onOpen }: {
  date: string; weekday: string; visits: EstimatorVisit[]; onOpen: () => void;
}) {
  const dayNum = new Date(`${date}T00:00:00`).getDate();
  // Days with estimates start expanded so the list is visible at a glance.
  const [open, setOpen] = useState(visits.length > 0);

  return (
    <Card>
      <CardContent className="p-3">
        <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between text-left">
          <div className="flex items-center gap-3">
            {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            <div>
              <div className="font-medium text-sm">{weekday} {dayNum}</div>
              <div className="text-xs text-muted-foreground">
                {visits.length === 0 ? "No estimates" : `${visits.length} estimate${visits.length === 1 ? "" : "s"}`}
              </div>
            </div>
          </div>
          {visits.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {fmtTime(visits[0].start_time)}{visits.length > 1 ? ` – ${fmtTime(visits[visits.length - 1].start_time)}` : ""}
            </span>
          )}
        </button>

        {open && (
          <div className="mt-3 space-y-2">
            {visits.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nothing scheduled.</p>
            ) : (
              <>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">In visiting order</p>
                {visits.map((v, i) => (
                  <div key={v.id} className="flex items-start gap-2 rounded border bg-muted/30 p-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        {v.lead_id ? (
                          <Link to={`/leads/${v.lead_id}`} className="font-medium text-sm text-primary hover:underline truncate">
                            {v.customer_name || "Customer"}
                          </Link>
                        ) : (
                          <span className="font-medium text-sm truncate">{v.customer_name || "Customer"}</span>
                        )}
                        <span className="text-xs text-muted-foreground shrink-0 flex items-center gap-1">
                          <Clock className="h-3 w-3" /> {fmtTime(v.start_time)}
                        </span>
                      </div>
                      {v.address && (
                        <a href={`https://maps.google.com/?q=${encodeURIComponent(v.address)}`} target="_blank" rel="noreferrer"
                           className="text-xs text-primary hover:underline flex items-start gap-1 mt-0.5">
                          <MapPin className="h-3 w-3 mt-0.5 shrink-0" /> <span className="truncate">{v.address}</span>
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </>
            )}
            <button onClick={onOpen} className="w-full flex items-center justify-center gap-1 rounded border border-dashed py-1.5 text-xs text-muted-foreground hover:bg-muted/50 transition-colors">
              Open day <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
