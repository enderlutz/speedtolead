import { useState, useEffect, useCallback } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import { api, getCurrentUser, type EstimatorScheduleDay, type EstimatorDrivePath, type EstimatorVisit } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import EstimatorDriveMap from "@/components/EstimatorDriveMap";
import EstimatorScheduleModal from "@/components/EstimatorScheduleModal";
import { toast } from "sonner";
import {
  ArrowLeft, MapPin, Clock, Navigation, Play, Square, Loader2, Pencil,
} from "lucide-react";

function toYMD(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}
function mondayOf(d: Date): Date {
  const x = new Date(d);
  const day = x.getDay();
  const diff = day === 0 ? -6 : 1 - day;
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
function fmtDrive(n: number | null): string {
  if (n == null) return "";
  return n < 1 ? "<1 min drive" : `~${Math.round(n)} min drive`;
}
function fmtHours(h: number): string {
  const totalMin = Math.round(h * 60);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  if (hh === 0) return `${mm}m`;
  if (mm === 0) return `${hh}h`;
  return `${hh}h ${mm}m`;
}

/** One day's page: clock in/out + the ordered list of estimates. Tapping a
 *  customer opens the real Lead Detail page. Admins also get the drive-path
 *  map of where the estimator actually drove that day. */
export default function EstimatorDay() {
  const { date = "" } = useParams<{ date: string }>();
  const [searchParams] = useSearchParams();
  const user = getCurrentUser();
  const isEstimator = user?.role === "estimator";
  const isAdmin = user?.role === "admin";
  // Staff can arrive here viewing a specific estimator (?e=<id> from the week
  // page). Estimators are pinned to their own schedule server-side regardless.
  const viewEstimatorId = isEstimator ? undefined : (searchParams.get("e") || undefined);

  const [day, setDay] = useState<EstimatorScheduleDay | null>(null);
  const [estimatorName, setEstimatorName] = useState("");
  const [loading, setLoading] = useState(true);
  const [editVisit, setEditVisit] = useState<EstimatorVisit | null>(null);

  const load = useCallback(() => {
    if (!date) return;
    setLoading(true);
    const weekStart = toYMD(mondayOf(new Date(`${date}T00:00:00`)));
    api.getEstimatorSchedule(weekStart, viewEstimatorId)
      .then((s) => {
        setDay(s.days.find((d) => d.date === date) || { date, weekday: "", visits: [], worked_hours: 0 });
        setEstimatorName(s.estimator_name || "");
      })
      .catch(() => toast.error("Couldn't load the day"))
      .finally(() => setLoading(false));
  }, [date, viewEstimatorId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: raises the loading flag when this fetch's inputs change; the data itself lands asynchronously.
  useEffect(() => { load(); }, [load]);

  const heading = (() => {
    const d = new Date(`${date}T00:00:00`);
    return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  })();

  const visits = day?.visits || [];

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-2xl mx-auto">
      <Link to="/estimator" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to calendar
      </Link>

      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">{heading}</h1>
        {isAdmin && day && day.worked_hours > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-green-100 text-green-800 text-xs font-medium px-2 py-1">
            <Clock className="h-3 w-3" /> {fmtHours(day.worked_hours)} worked
          </span>
        )}
      </div>

      {/* Clock in/out — estimator only */}
      {isEstimator && <ClockBar onChange={load} />}

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : visits.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center">No estimates scheduled for this day.</p>
      ) : (
        <div className="space-y-2">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">In visiting order</p>
          {visits.map((v, i) => (
            <div key={v.id}>
              {i > 0 && v.drive_minutes_from_prev != null && (
                <div className="flex items-center gap-1 text-[11px] text-muted-foreground pl-2 py-0.5">
                  <Navigation className="h-3 w-3" /> {fmtDrive(v.drive_minutes_from_prev)}
                </div>
              )}
              <Card className={v.lead_id ? "hover:bg-muted/40 transition-colors" : ""}>
                <CardContent className="p-3">
                  <div className="flex items-start gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        {v.lead_id ? (
                          <Link to={`/leads/${v.lead_id}`} className="font-medium text-sm text-primary hover:underline truncate">
                            {v.customer_name || "Customer"}
                          </Link>
                        ) : (
                          <span className="font-medium text-sm truncate">{v.customer_name || "Customer"}</span>
                        )}
                        <span className="flex items-center gap-2 shrink-0">
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Clock className="h-3 w-3" /> {fmtTime(v.start_time)}
                          </span>
                          {isAdmin && (
                            <button onClick={() => setEditVisit(v)} className="text-muted-foreground hover:text-primary" title="Change time">
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          )}
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
                </CardContent>
              </Card>
            </div>
          ))}
        </div>
      )}

      {/* Estimator: a preview of the day's suggested drive (no tracking) */}
      {isEstimator && visits.length > 0 && <RoutePreviewSection date={date} />}

      {/* Admin-only: suggested route + where he actually drove this day */}
      {isAdmin && <DrivePathSection date={date} estimatorName={estimatorName || "the estimator"} estimatorUserId={viewEstimatorId} />}

      {editVisit && (
        <EstimatorScheduleModal
          visit={editVisit}
          initialDate={date}
          onClose={() => setEditVisit(null)}
          onSaved={() => { setEditVisit(null); load(); }}
        />
      )}
    </div>
  );
}

// ── Clock in/out + foreground GPS tracking (estimator only) ─────────────────
function ClockBar({ onChange }: { onChange?: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [since, setSince] = useState<string | null>(null);

  useEffect(() => {
    api.getEstimatorClockStatus()
      .then((s) => { setOpen(s.is_open); setSince(s.entry?.clock_in || null); })
      .catch(() => {});
  }, []);

  // While clocked in, sample GPS every ~60s and post it. Foreground-only — the
  // browser can't track once this page is closed.
  useEffect(() => {
    if (!open) return;
    if (!("geolocation" in navigator)) { toast.warning("Location isn't available on this device"); return; }
    const send = () => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          api.postEstimatorLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy_m: pos.coords.accuracy }).catch(() => {});
        },
        () => {},
        { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 },
      );
    };
    send();
    const timer = window.setInterval(send, 60000);
    return () => window.clearInterval(timer);
  }, [open]);

  const clockIn = async () => {
    setBusy(true);
    try { const e = await api.estimatorClockIn(); setOpen(true); setSince(e.clock_in); toast.success("Clocked in — tracking your route"); onChange?.(); }
    catch { toast.error("Couldn't clock in"); }
    finally { setBusy(false); }
  };
  const clockOut = async () => {
    setBusy(true);
    try { await api.estimatorClockOut(); setOpen(false); setSince(null); toast.success("Clocked out"); onChange?.(); }
    catch { toast.error("Couldn't clock out"); }
    finally { setBusy(false); }
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

// ── Estimator's own day preview — the suggested route only ──────────────────
function RoutePreviewSection({ date }: { date: string }) {
  const [data, setData] = useState<EstimatorDrivePath | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: raises the loading flag when this fetch's inputs change; the data itself lands asynchronously.
    setLoading(true);
    api.getEstimatorDrivePath(date)
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [date]);

  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center gap-2">
          <Navigation className="h-4 w-4 text-green-600" />
          <h2 className="text-sm font-semibold">Your route</h2>
        </div>
        <p className="text-xs text-muted-foreground">Suggested order + drive for the day.</p>
        {loading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : !data?.maps_api_key ? (
          <div className="text-xs text-amber-600">Map unavailable — GOOGLE_MAPS_API_KEY isn't configured yet.</div>
        ) : data.visits.filter((v) => v.lat != null).length === 0 ? (
          <div className="text-xs text-muted-foreground">No mapped stops for this day yet.</div>
        ) : (
          <EstimatorDriveMap data={data} showSuggested showActual={false} />
        )}
      </CardContent>
    </Card>
  );
}

// ── Admin-only drive path for this day ──────────────────────────────────────
function DrivePathSection({ date, estimatorName, estimatorUserId }: { date: string; estimatorName: string; estimatorUserId?: string }) {
  const [data, setData] = useState<EstimatorDrivePath | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = () => {
    setLoading(true);
    api.getEstimatorDrivePath(date, estimatorUserId)
      .then((d) => { setData(d); setLoaded(true); })
      .catch(() => toast.error("Couldn't load the drive path"))
      .finally(() => setLoading(false));
  };

  return (
    <Card className="border-amber-300/60">
      <CardContent className="p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Navigation className="h-4 w-4 text-amber-600" />
            <h2 className="text-sm font-semibold">Drive path <span className="text-xs font-normal text-muted-foreground">(admin only)</span></h2>
          </div>
          {!loaded && (
            <Button size="sm" onClick={load} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Load"}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">Suggested route vs. where {estimatorName} actually drove.</p>
        {data && (
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">
              {data.pings.length} GPS point{data.pings.length === 1 ? "" : "s"} • {data.visits.length} planned stop{data.visits.length === 1 ? "" : "s"}
            </div>
            {!data.maps_api_key ? (
              <div className="text-xs text-amber-600">No Google Maps key configured — the map will appear once GOOGLE_MAPS_API_KEY is set.</div>
            ) : data.pings.length === 0 && data.visits.length === 0 ? (
              <div className="text-xs text-muted-foreground">Nothing recorded for this day yet.</div>
            ) : (
              <EstimatorDriveMap data={data} showSuggested showActual />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
