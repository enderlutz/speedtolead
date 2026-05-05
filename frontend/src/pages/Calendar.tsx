import { useEffect, useMemo, useState, useCallback } from "react";
import { api, getCurrentUser, type ScheduledJob, type WeatherForecast, type WeatherDay, type Lead } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon, Cloud, Droplets, Eye, EyeOff, X, MapPin } from "lucide-react";
import ScheduleJobModal from "@/components/ScheduleJobModal";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const PACKAGE_COLORS: Record<string, string> = {
  essential: "bg-blue-500",
  signature: "bg-amber-400",
  legacy: "bg-purple-500",
  custom: "bg-slate-500",
};

const todayISO = (): string => {
  const t = new Date();
  return t.toISOString().slice(0, 10);
};

const monthMatrix = (year: number, monthIdx: number): Date[][] => {
  // 6-week grid (Sun→Sat) like Google Calendar
  const first = new Date(year, monthIdx, 1);
  const start = new Date(first);
  start.setDate(start.getDate() - first.getDay());
  const weeks: Date[][] = [];
  const cursor = new Date(start);
  for (let w = 0; w < 6; w++) {
    const week: Date[] = [];
    for (let d = 0; d < 7; d++) {
      week.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
};

const fmtMonth = (year: number, monthIdx: number) =>
  new Date(year, monthIdx, 1).toLocaleString("default", { month: "long", year: "numeric" });

export default function Calendar() {
  const user = getCurrentUser();
  const isAdmin = user?.role === "admin";
  const isWorker = user?.role === "worker";

  const [now, setNow] = useState(new Date());
  const year = now.getFullYear();
  const monthIdx = now.getMonth();

  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewAsWorker, setPreviewAsWorker] = useState(false);
  const [activeJob, setActiveJob] = useState<ScheduledJob | null>(null);
  const [activeJobLead, setActiveJobLead] = useState<Lead | null>(null);
  const [editJob, setEditJob] = useState<ScheduledJob | null>(null);
  const [weatherByZip, setWeatherByZip] = useState<Record<string, WeatherForecast>>({});

  const weeks = useMemo(() => monthMatrix(year, monthIdx), [year, monthIdx]);
  const monthStart = weeks[0][0].toISOString().slice(0, 10);
  const monthEnd = weeks[weeks.length - 1][6].toISOString().slice(0, 10);

  const load = useCallback(() => {
    setLoading(true);
    api.listScheduledJobs({ start: monthStart, end: monthEnd })
      .then((r) => setJobs(r.jobs))
      .catch(() => toast.error("Failed to load calendar"))
      .finally(() => setLoading(false));
  }, [monthStart, monthEnd]);

  useEffect(() => { load(); }, [load]);

  // Weather: fetch forecast for distinct ZIPs across this month's jobs
  useEffect(() => {
    const zips = Array.from(new Set(jobs.map((j) => j.zip_code).filter(Boolean)));
    zips.forEach((zip) => {
      if (weatherByZip[zip]) return;
      api.getWeather(zip).then((fc) => {
        setWeatherByZip((prev) => ({ ...prev, [zip]: fc }));
      }).catch(() => {});
    });
  }, [jobs, weatherByZip]);

  const jobsByDate = useMemo(() => {
    const map: Record<string, ScheduledJob[]> = {};
    jobs.forEach((j) => {
      if (!map[j.job_date]) map[j.job_date] = [];
      map[j.job_date].push(j);
    });
    return map;
  }, [jobs]);

  // Worker view (whether actual or admin preview): hide internal data
  const showAsWorker = isWorker || (isAdmin && previewAsWorker);

  const goPrev = () => setNow(new Date(year, monthIdx - 1, 1));
  const goNext = () => setNow(new Date(year, monthIdx + 1, 1));
  const goToday = () => setNow(new Date());

  const openJob = async (j: ScheduledJob) => {
    setActiveJob(j);
    if (!showAsWorker) {
      try {
        const lead = await api.getLead(j.lead_id);
        setActiveJobLead(lead);
      } catch {
        setActiveJobLead(null);
      }
    }
  };

  const closeJob = () => { setActiveJob(null); setActiveJobLead(null); };

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-7xl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight flex items-center gap-2">
            <CalendarIcon className="h-5 w-5 text-primary" /> Calendar
          </h1>
          <p className="text-sm text-muted-foreground">
            {showAsWorker ? "Your assigned jobs" : "All scheduled jobs"} · {fmtMonth(year, monthIdx)}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {isAdmin && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPreviewAsWorker(!previewAsWorker)}
              title="Toggle to see what a worker sees"
            >
              {previewAsWorker ? <EyeOff className="h-3.5 w-3.5 mr-1" /> : <Eye className="h-3.5 w-3.5 mr-1" />}
              {previewAsWorker ? "Admin view" : "Preview as worker"}
            </Button>
          )}
          <div className="inline-flex border rounded-md">
            <button onClick={goPrev} className="px-2 py-1.5 hover:bg-muted text-sm border-r">
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button onClick={goToday} className="px-3 py-1.5 hover:bg-muted text-xs font-medium border-r">Today</button>
            <button onClick={goNext} className="px-2 py-1.5 hover:bg-muted text-sm">
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Weather note */}
      {Object.keys(weatherByZip).length > 0 && (
        <p className="text-[11px] text-muted-foreground italic">
          Weather predictions are only accurate for the next 7 days.
        </p>
      )}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <div className="h-96 grid place-items-center text-sm text-muted-foreground">Loading…</div>
          ) : (
            <div className="min-w-[700px]">
              {/* Day headers */}
              <div className="grid grid-cols-7 border-b">
                {WEEKDAY_LABELS.map((d) => (
                  <div key={d} className="text-[11px] font-semibold text-muted-foreground px-2 py-2 text-center uppercase tracking-wide">
                    {d}
                  </div>
                ))}
              </div>
              {/* Weeks */}
              {weeks.map((week, wi) => (
                <div key={wi} className="grid grid-cols-7 border-b last:border-b-0">
                  {week.map((day) => {
                    const iso = day.toISOString().slice(0, 10);
                    const inMonth = day.getMonth() === monthIdx;
                    const isToday = iso === todayISO();
                    const dayJobs = jobsByDate[iso] || [];

                    return (
                      <div
                        key={iso}
                        className={`min-h-[105px] border-r last:border-r-0 p-1.5 flex flex-col gap-1 ${
                          inMonth ? "bg-background" : "bg-muted/20 text-muted-foreground"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className={`text-[11px] font-semibold inline-flex items-center justify-center h-5 min-w-5 px-1 rounded-full ${
                            isToday ? "bg-primary text-primary-foreground" : ""
                          }`}>
                            {day.getDate()}
                          </span>
                          <DayWeatherChip
                            zips={dayJobs.map((j) => j.zip_code).filter(Boolean)}
                            byZip={weatherByZip}
                            iso={iso}
                          />
                        </div>
                        <div className="flex flex-col gap-0.5">
                          {dayJobs.map((j) => (
                            <button
                              key={j.id}
                              onClick={() => openJob(j)}
                              className="text-[10px] text-left rounded px-1.5 py-1 hover:opacity-90 truncate flex items-center gap-1"
                              style={{ background: "rgb(243 244 246)" }}
                              title={`${j.customer_name} · ${j.arrival_time}`}
                            >
                              {!showAsWorker && j.package_tier && (
                                <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${PACKAGE_COLORS[j.package_tier] || "bg-slate-400"}`} />
                              )}
                              <span className="font-mono text-muted-foreground">{j.arrival_time}</span>
                              <span className="truncate">{j.customer_name || "Job"}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Legend (admin only) */}
      {!showAsWorker && (
        <div className="flex items-center gap-4 text-[11px] text-muted-foreground flex-wrap">
          <span className="font-semibold">Package:</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-blue-500" />Essential</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-400" />Signature</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-purple-500" />Legacy</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-slate-500" />Custom</span>
        </div>
      )}

      {/* Job detail panel */}
      {activeJob && (
        <JobDetailModal
          job={activeJob}
          showAsWorker={showAsWorker}
          weather={weatherByZip[activeJob.zip_code]?.days.find((d) => d.date === activeJob.job_date)}
          onClose={closeJob}
          onEdit={!showAsWorker ? () => { setEditJob(activeJob); closeJob(); } : undefined}
          onDelete={!showAsWorker && isAdmin ? async () => {
            if (!confirm("Cancel this job? The Google event will also be deleted and customer notified.")) return;
            try {
              await api.deleteScheduledJob(activeJob.id);
              toast.success("Job cancelled");
              closeJob();
              load();
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Failed to cancel");
            }
          } : undefined}
        />
      )}

      {editJob && activeJobLead && (
        <ScheduleJobModal
          lead={activeJobLead}
          existing={editJob}
          onClose={() => { setEditJob(null); setActiveJobLead(null); }}
          onSaved={() => { setEditJob(null); setActiveJobLead(null); load(); }}
        />
      )}
      {editJob && !activeJobLead && (
        // Lead lookup needed for the modal — fetch then render
        <LeadFetcher
          leadId={editJob.lead_id}
          onLoad={(l) => setActiveJobLead(l)}
          onError={() => { toast.error("Couldn't load lead for editing"); setEditJob(null); }}
        />
      )}
    </div>
  );
}

function LeadFetcher({ leadId, onLoad, onError }: { leadId: string; onLoad: (l: Lead) => void; onError: () => void }) {
  useEffect(() => {
    api.getLead(leadId).then(onLoad).catch(onError);
  }, [leadId, onLoad, onError]);
  return null;
}

function DayWeatherChip({ zips, byZip, iso }: { zips: string[]; byZip: Record<string, WeatherForecast>; iso: string }) {
  if (zips.length === 0) return null;
  // Pick the first zip's forecast as representative
  const fc = byZip[zips[0]];
  const day = fc?.days.find((d) => d.date === iso);
  if (!day || day.high_f == null) return null;
  const wet = (day.precip_chance_pct || 0) >= 40;
  return (
    <span
      className={`text-[9px] px-1 py-0.5 rounded inline-flex items-center gap-0.5 ${
        wet ? "bg-blue-100 text-blue-800" : "bg-amber-50 text-amber-800"
      }`}
      title={`${day.summary} · High ${Math.round(day.high_f)}°F · ${day.precip_chance_pct ?? 0}% rain`}
    >
      {wet ? <Droplets className="h-2 w-2" /> : <Cloud className="h-2 w-2" />}
      {Math.round(day.high_f)}°
    </span>
  );
}

function JobDetailModal({
  job, showAsWorker, weather, onClose, onEdit, onDelete,
}: {
  job: ScheduledJob;
  showAsWorker: boolean;
  weather?: WeatherDay;
  onClose: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-background rounded-lg shadow-xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="text-base font-semibold">{job.customer_name || "Job"}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <CalendarIcon className="h-3.5 w-3.5 text-muted-foreground" />
            <span>{job.job_date} at {job.arrival_time}</span>
            <span className="text-muted-foreground">({job.estimated_duration_hours}h)</span>
          </div>
          <div className="flex items-start gap-2">
            <MapPin className="h-3.5 w-3.5 text-muted-foreground mt-0.5" />
            <a
              href={`https://maps.google.com/?q=${encodeURIComponent(job.address)}`}
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline"
            >
              {job.address || "—"}
            </a>
          </div>
          {weather && weather.high_f != null && (
            <div className="text-xs flex items-center gap-2 bg-muted/40 rounded p-2">
              {(weather.precip_chance_pct || 0) >= 40 ? <Droplets className="h-3.5 w-3.5 text-blue-600" /> : <Cloud className="h-3.5 w-3.5 text-amber-600" />}
              <span>{weather.summary || "—"} · {Math.round(weather.high_f)}°F · {weather.precip_chance_pct ?? 0}% rain</span>
            </div>
          )}
          {job.color_choice && (
            <p><span className="text-muted-foreground">Color:</span> {job.color_choice}</p>
          )}
          {job.needs_test_spots && (
            <Badge className="bg-amber-100 text-amber-800 text-[10px]">Test patches first (same day)</Badge>
          )}
          {job.gallons_estimate > 0 && (
            <p><span className="text-muted-foreground">Gallons:</span> {job.gallons_estimate}</p>
          )}
          {job.job_description && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground mb-1">Job description</p>
              <p>{job.job_description}</p>
            </div>
          )}

          {!showAsWorker && (
            <>
              {job.package_tier && (
                <p><span className="text-muted-foreground">Package:</span> <span className="capitalize">{job.package_tier}</span></p>
              )}
              {(job.closed_price || 0) > 0 && (
                <p><span className="text-muted-foreground">Closed price:</span> ${job.closed_price?.toFixed(2)}</p>
              )}
              {job.customer_email && (
                <p><span className="text-muted-foreground">Customer email:</span> {job.customer_email}</p>
              )}
              {job.customer_phone && (
                <p><span className="text-muted-foreground">Customer phone:</span> {job.customer_phone}</p>
              )}
              {job.admin_notes && (
                <div className="bg-amber-50 border border-amber-200 rounded p-2">
                  <p className="text-xs font-semibold text-amber-900 mb-1">Admin notes</p>
                  <p className="text-xs">{job.admin_notes}</p>
                </div>
              )}
            </>
          )}
        </div>
        {(onEdit || onDelete) && (
          <div className="p-3 border-t flex justify-end gap-2">
            {onDelete && <Button variant="outline" size="sm" className="text-red-600" onClick={onDelete}>Cancel job</Button>}
            {onEdit && <Button size="sm" onClick={onEdit}>Edit</Button>}
          </div>
        )}
      </div>
    </div>
  );
}
