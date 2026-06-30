import { useState, useEffect, useRef, useCallback } from "react";
import { api, getCurrentUser, type EstimatorSchedule, type EstimatorVisit, type EstimatorDrivePath } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  MapPin, Clock, ChevronDown, ChevronRight, ChevronLeft, Play, Square,
  Navigation, Loader2, Calendar as CalendarIcon, RefreshCw,
} from "lucide-react";

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
function fmtDriveMins(n: number | null): string {
  if (n == null) return "";
  return n < 1 ? "<1 min drive" : `~${Math.round(n)} min drive`;
}

export default function Estimator() {
  const user = getCurrentUser();
  const isEstimator = user?.role === "estimator";
  const isAdmin = user?.role === "admin";

  const [weekStart, setWeekStart] = useState<string>(() => toYMD(mondayOf(new Date())));
  const [schedule, setSchedule] = useState<EstimatorSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const loadSchedule = useCallback(() => {
    setLoading(true);
    api.getEstimatorSchedule(weekStart)
      .then((s) => {
        setSchedule(s);
        // Auto-expand any day that has stops so the estimator sees them at a glance.
        setExpanded((prev) => {
          const next = new Set(prev);
          for (const d of s.days) if (d.visits.length) next.add(d.date);
          return next;
        });
      })
      .catch(() => toast.error("Couldn't load the schedule"))
      .finally(() => setLoading(false));
  }, [weekStart]);

  useEffect(() => { loadSchedule(); }, [loadSchedule]);

  const shiftWeek = (deltaDays: number) => {
    const d = new Date(`${weekStart}T00:00:00`);
    d.setDate(d.getDate() + deltaDays);
    setWeekStart(toYMD(mondayOf(d)));
  };

  const toggleDay = (date: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date); else next.add(date);
      return next;
    });

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
        <Button variant="outline" size="sm" onClick={loadSchedule} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Clock in/out + live tracking — estimator only */}
      {isEstimator && <ClockBar />}

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

      {/* Per-day schedule */}
      {loading && !schedule ? (
        <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="space-y-2">
          {schedule?.days.map((day) => (
            <DayCard
              key={day.date}
              date={day.date}
              weekday={day.weekday}
              visits={day.visits}
              open={expanded.has(day.date)}
              onToggle={() => toggleDay(day.date)}
            />
          ))}
        </div>
      )}

      {/* Admin-only: where he actually drove */}
      {isAdmin && <DrivePathSection estimatorName={schedule?.estimator_name || "Estimator"} />}
    </div>
  );
}

// ── Day card ───────────────────────────────────────────────────────────────
function DayCard({ date, weekday, visits, open, onToggle }: {
  date: string; weekday: string; visits: EstimatorVisit[]; open: boolean; onToggle: () => void;
}) {
  const dayNum = new Date(`${date}T00:00:00`).getDate();
  return (
    <Card>
      <button onClick={onToggle} className="w-full text-left">
        <CardContent className="p-3 flex items-center justify-between">
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
        </CardContent>
      </button>

      {open && visits.length > 0 && (
        <div className="px-3 pb-3 space-y-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">In visiting order</p>
          {visits.map((v, i) => (
            <div key={v.id}>
              {i > 0 && v.drive_minutes_from_prev != null && (
                <div className="flex items-center gap-1 text-[11px] text-muted-foreground pl-2 py-0.5">
                  <Navigation className="h-3 w-3" /> {fmtDriveMins(v.drive_minutes_from_prev)}
                </div>
              )}
              <div className="flex items-start gap-2 rounded border bg-muted/30 p-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sm truncate">{v.customer_name || "Customer"}</span>
                    <span className="text-xs text-muted-foreground shrink-0 flex items-center gap-1">
                      <Clock className="h-3 w-3" /> {fmtTime(v.start_time)}
                    </span>
                  </div>
                  {v.address && (
                    <a
                      href={`https://maps.google.com/?q=${encodeURIComponent(v.address)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-primary hover:underline flex items-start gap-1 mt-0.5"
                    >
                      <MapPin className="h-3 w-3 mt-0.5 shrink-0" /> <span className="truncate">{v.address}</span>
                    </a>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Clock in/out + foreground GPS tracking (estimator only) ─────────────────
function ClockBar() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [since, setSince] = useState<string | null>(null);
  const lastPingRef = useRef<number>(0);

  useEffect(() => {
    api.getEstimatorClockStatus()
      .then((s) => { setOpen(s.is_open); setSince(s.entry?.clock_in || null); })
      .catch(() => {});
  }, []);

  // While clocked in, sample GPS every ~60s and post it. Browser web apps can
  // only do this while the page is open in the foreground — that's by design.
  useEffect(() => {
    if (!open) return;
    if (!("geolocation" in navigator)) {
      toast.warning("Location isn't available on this device");
      return;
    }
    const send = () => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          lastPingRef.current = pos.timestamp;
          api.postEstimatorLocation({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy_m: pos.coords.accuracy,
          }).catch(() => {});
        },
        () => {},
        { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 },
      );
    };
    send();                                   // immediate fix on clock-in
    const timer = window.setInterval(send, 60000);
    return () => window.clearInterval(timer);
  }, [open]);

  const clockIn = async () => {
    setBusy(true);
    try {
      const e = await api.estimatorClockIn();
      setOpen(true);
      setSince(e.clock_in);
      toast.success("Clocked in — tracking your route");
    } catch {
      toast.error("Couldn't clock in");
    } finally { setBusy(false); }
  };
  const clockOut = async () => {
    setBusy(true);
    try {
      await api.estimatorClockOut();
      setOpen(false);
      setSince(null);
      toast.success("Clocked out");
    } catch {
      toast.error("Couldn't clock out");
    } finally { setBusy(false); }
  };

  const sinceLabel = since ? new Date(since).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";

  return (
    <Card className={open ? "border-green-300 bg-green-50/40" : ""}>
      <CardContent className="p-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${open ? "bg-green-500 animate-pulse" : "bg-muted-foreground/40"}`} />
          <div>
            <div className="text-sm font-medium">{open ? "On the clock" : "Off the clock"}</div>
            <div className="text-xs text-muted-foreground">
              {open ? `Since ${sinceLabel} • sharing location` : "Clock in to start your day"}
            </div>
          </div>
        </div>
        {open ? (
          <Button size="sm" variant="destructive" onClick={clockOut} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Square className="h-4 w-4 mr-1" /> Clock out</>}
          </Button>
        ) : (
          <Button size="sm" onClick={clockIn} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Play className="h-4 w-4 mr-1" /> Clock in</>}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// ── Admin-only drive path (map lands in Phase 4) ────────────────────────────
function DrivePathSection({ estimatorName }: { estimatorName: string }) {
  const [date, setDate] = useState<string>(() => toYMD(new Date()));
  const [data, setData] = useState<EstimatorDrivePath | null>(null);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    api.getEstimatorDrivePath(date)
      .then(setData)
      .catch(() => toast.error("Couldn't load the drive path"))
      .finally(() => setLoading(false));
  };

  return (
    <Card className="border-amber-300/60">
      <CardContent className="p-3 space-y-3">
        <div className="flex items-center gap-2">
          <Navigation className="h-4 w-4 text-amber-600" />
          <h2 className="text-sm font-semibold">Drive path <span className="text-xs font-normal text-muted-foreground">(admin only)</span></h2>
        </div>
        <p className="text-xs text-muted-foreground">Where {estimatorName} actually drove. Pick a day to load the GPS trail.</p>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="text-sm rounded border bg-background px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <Button size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Load"}
          </Button>
        </div>
        {data && (
          <div className="text-xs text-muted-foreground space-y-1">
            <div>{data.pings.length} GPS point{data.pings.length === 1 ? "" : "s"} recorded • {data.visits.length} planned stop{data.visits.length === 1 ? "" : "s"}</div>
            {!data.maps_api_key && <div className="text-amber-600">No Google Maps key configured — the map will appear once GOOGLE_MAPS_API_KEY is set.</div>}
            {data.pings.length === 0 && <div>No location recorded for this day yet.</div>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
