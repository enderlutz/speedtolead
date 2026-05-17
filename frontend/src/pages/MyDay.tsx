import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { Link } from "react-router-dom";
import { api, getCurrentUser, type ScheduledJob } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { MapPin, Clock, CheckCircle2, ClipboardList, RefreshCw, Camera } from "lucide-react";

// Worker "My Day" — the single screen workers see on their phone. Shows
// only their assigned jobs for today, with a slide-to-start gesture to
// prevent accidental "I arrived" taps in the field. SOP checklist
// surfaces inline once the job is in progress.
//
// Admins can use ?preview=worker in the URL to dogfood the worker UX.

function todayCstISO(): string {
  // Job dates are stored YYYY-MM-DD in Central Time. Render the "today"
  // boundary using America/Chicago so a 9 PM California worker doesn't
  // see tomorrow's jobs early.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(new Date());
}

function formatArrivalTime(arrival: string | undefined): string {
  if (!arrival) return "—";
  // arrival_time is "HH:MM" 24h. Render "7:30 AM" for human eyes.
  const [hh, mm] = arrival.split(":").map((p) => parseInt(p, 10));
  if (Number.isNaN(hh)) return arrival;
  const period = hh >= 12 ? "PM" : "AM";
  const h12 = ((hh + 11) % 12) + 1;
  return `${h12}:${String(mm || 0).padStart(2, "0")} ${period}`;
}

function statusBadge(status: string) {
  const map: Record<string, { label: string; cls: string }> = {
    scheduled:   { label: "Not started", cls: "bg-slate-200 text-slate-800" },
    in_progress: { label: "In progress",  cls: "bg-blue-500 text-white" },
    completed:   { label: "Complete",     cls: "bg-green-600 text-white" },
    cancelled:   { label: "Cancelled",    cls: "bg-red-200 text-red-900" },
  };
  const cfg = map[status] || map.scheduled;
  return <Badge className={`${cfg.cls} text-xs`}>{cfg.label}</Badge>;
}

// Slide-to-start gesture. Prevents accidental "I arrived" taps from a
// worker's phone in their pocket. Triggers `onConfirm` when the thumb is
// dragged ≥80% of the track width. Resets on release if not at threshold.
function SlideToConfirm({
  label,
  onConfirm,
  disabled,
  variant = "blue",
}: {
  label: string;
  onConfirm: () => void;
  disabled?: boolean;
  variant?: "blue" | "green";
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const colorClass = variant === "green"
    ? "bg-green-600"
    : "bg-blue-600";

  const reset = useCallback(() => {
    setOffset(0);
    setDragging(false);
  }, []);

  const handleStart = (clientX: number) => {
    if (disabled || confirmed) return;
    setDragging(true);
    const rect = trackRef.current?.getBoundingClientRect();
    if (rect) (trackRef.current as any)._startX = clientX - rect.left;
  };

  const handleMove = (clientX: number) => {
    if (!dragging || disabled || confirmed) return;
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const max = rect.width - 56; // 56 = thumb width
    const dx = clientX - rect.left - 28; // 28 = thumb half
    setOffset(Math.max(0, Math.min(dx, max)));
  };

  const handleEnd = () => {
    if (!dragging) return;
    const rect = trackRef.current?.getBoundingClientRect();
    if (rect && offset >= (rect.width - 56) * 0.8) {
      setConfirmed(true);
      setOffset(rect.width - 56);
      onConfirm();
    } else {
      reset();
    }
  };

  return (
    <div
      ref={trackRef}
      className={`relative h-14 w-full rounded-full bg-slate-200 overflow-hidden select-none ${
        disabled ? "opacity-50" : ""
      }`}
      onMouseDown={(e) => handleStart(e.clientX)}
      onMouseMove={(e) => handleMove(e.clientX)}
      onMouseUp={handleEnd}
      onMouseLeave={handleEnd}
      onTouchStart={(e) => handleStart(e.touches[0].clientX)}
      onTouchMove={(e) => handleMove(e.touches[0].clientX)}
      onTouchEnd={handleEnd}
    >
      <div
        className="absolute inset-0 flex items-center justify-center text-slate-600 font-medium text-sm pointer-events-none"
      >
        {confirmed ? "Confirmed!" : label}
      </div>
      <div
        className={`absolute top-1 left-1 h-12 w-12 rounded-full ${colorClass} text-white flex items-center justify-center shadow-md transition-transform`}
        style={{ transform: `translateX(${offset}px)`, transition: dragging ? "none" : "transform 0.2s" }}
      >
        <CheckCircle2 className="h-6 w-6" />
      </div>
    </div>
  );
}

export default function MyDay() {
  const user = getCurrentUser();
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const today = useMemo(() => todayCstISO(), []);

  const load = useCallback(async () => {
    try {
      const employee_id = user?.employee_id || undefined;
      const res = await api.listScheduledJobs({
        start: today,
        end: today,
        // Backend already filters to assigned jobs for role=worker. We
        // pass employee_id explicitly only for admin previewing as worker.
        ...(user?.role === "admin" && employee_id ? { employee_id } : {}),
      });
      setJobs(res.jobs || []);
    } catch (e) {
      console.error(e);
      toast.error("Failed to load today's jobs");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [today, user?.employee_id, user?.role]);

  useEffect(() => { load(); }, [load]);

  const handleStart = async (job: ScheduledJob) => {
    try {
      const updated = await api.startScheduledJob(job.id);
      setJobs((prev) => prev.map((j) => (j.id === job.id ? updated : j)));
      toast.success(`Started: ${job.customer_name}`);
    } catch (e: any) {
      toast.error(e?.message || "Failed to start job");
    }
  };

  const handleComplete = async (job: ScheduledJob) => {
    try {
      const updated = await api.completeScheduledJob(job.id);
      setJobs((prev) => prev.map((j) => (j.id === job.id ? updated : j)));
      toast.success(`Job complete: ${job.customer_name}`);
    } catch (e: any) {
      toast.error(e?.message || "Failed to complete job");
    }
  };

  const sorted = useMemo(() => {
    const order = (j: ScheduledJob) => {
      if (j.status === "in_progress") return 0;
      if (j.status === "scheduled") return 1;
      if (j.status === "completed") return 2;
      return 3;
    };
    return [...jobs].sort((a, b) => {
      const oa = order(a); const ob = order(b);
      if (oa !== ob) return oa - ob;
      return (a.arrival_time || "").localeCompare(b.arrival_time || "");
    });
  }, [jobs]);

  if (loading) {
    return (
      <div className="p-4 max-w-md mx-auto">
        <div className="text-center text-muted-foreground py-12">Loading today's jobs…</div>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-md mx-auto pb-24">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">My Day</h1>
          <p className="text-sm text-muted-foreground">
            {new Date(today + "T00:00:00").toLocaleDateString("en-US", {
              weekday: "long", month: "long", day: "numeric",
            })}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { setRefreshing(true); load(); }}
          disabled={refreshing}
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {sorted.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No jobs scheduled today. Enjoy the day off!
          </CardContent>
        </Card>
      )}

      <div className="space-y-4">
        {sorted.map((job) => (
          <Card key={job.id} className="overflow-hidden">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-base truncate">{job.customer_name || "(no name)"}</div>
                  <div className="flex items-center gap-1 text-sm text-muted-foreground mt-0.5">
                    <Clock className="h-3.5 w-3.5 shrink-0" />
                    {formatArrivalTime(job.arrival_time)}
                  </div>
                </div>
                {statusBadge(job.status)}
              </div>

              {job.address && (
                <a
                  href={`https://maps.google.com/?q=${encodeURIComponent(job.address)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-start gap-2 text-sm text-blue-600 underline-offset-2 hover:underline"
                >
                  <MapPin className="h-4 w-4 mt-0.5 shrink-0" />
                  <span className="break-words">{job.address}</span>
                </a>
              )}

              {job.job_description && (
                <div className="text-sm bg-slate-50 rounded px-3 py-2 whitespace-pre-wrap">
                  {job.job_description}
                </div>
              )}

              {job.status === "scheduled" && (
                <SlideToConfirm
                  label="Slide to start job"
                  variant="blue"
                  onConfirm={() => handleStart(job)}
                />
              )}

              {job.status === "in_progress" && (
                <>
                  <div className="flex gap-2">
                    <Link to={`/sops/job/${job.id}`} className="flex-1">
                      <Button variant="outline" className="w-full">
                        <ClipboardList className="h-4 w-4 mr-2" /> SOP Checklist
                      </Button>
                    </Link>
                    <Link to={`/sops/job/${job.id}#photos`}>
                      <Button variant="outline" size="icon" aria-label="Photos">
                        <Camera className="h-4 w-4" />
                      </Button>
                    </Link>
                  </div>
                  <SlideToConfirm
                    label="Slide to complete job"
                    variant="green"
                    onConfirm={() => handleComplete(job)}
                  />
                </>
              )}

              {job.status === "completed" && job.completed_at && (
                <div className="text-xs text-muted-foreground text-center pt-1">
                  Completed{" "}
                  {new Date(job.completed_at).toLocaleTimeString("en-US", {
                    hour: "numeric", minute: "2-digit", hour12: true,
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
