import { useCallback, useEffect, useState } from "react";
import { api, type Lead, type ScheduledJob } from "@/lib/api";
import { Button } from "@/components/ui/button";
import ScheduleJobModal from "@/components/ScheduleJobModal";
import { Calendar, Plus, Send, BellOff, Pencil } from "lucide-react";

/** Every scheduled visit for one customer (a sale is often several — a clean
 *  day, a stain day, maybe a finish-up). Lists them with their label +
 *  invite/internal status, lets you edit/reschedule each, and add another. */
export default function ScheduledVisitsCard({ lead }: { lead: Lead }) {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [modal, setModal] = useState<{ mode: "create" | "edit"; job: ScheduledJob | null } | null>(null);

  const load = useCallback(() => {
    api.listScheduledJobs({})
      .then((r) =>
        setJobs(
          r.jobs
            .filter((j) => j.lead_id === lead.id)
            .sort((a, b) => a.job_date.localeCompare(b.job_date)),
        ),
      )
      .catch(() => {});
  }, [lead.id]);
  useEffect(() => { load(); }, [load]);

  const fmtDate = (d: string) => {
    try {
      const [y, m, day] = d.split("-").map(Number);
      return new Date(y, m - 1, day).toLocaleDateString(undefined, {
        weekday: "short", month: "short", day: "numeric",
      });
    } catch { return d; }
  };

  return (
    <div className="rounded-xl border bg-background p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Calendar className="h-5 w-5 text-primary" />
          <h3 className="font-semibold">Scheduled visits</h3>
          {jobs.length > 0 && <span className="text-xs text-muted-foreground">({jobs.length})</span>}
        </div>
        <Button size="sm" variant="outline" onClick={() => setModal({ mode: "create", job: null })}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Add a visit
        </Button>
      </div>

      {jobs.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No visits scheduled yet. A sale is often several — e.g. a clean day, then a stain day.
        </p>
      ) : (
        <div className="space-y-1.5">
          {jobs.map((j) => {
            const invited = !!j.google_event_id;
            return (
              <div key={j.id} className="flex items-center justify-between gap-2 border rounded-md px-2.5 py-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">
                    {j.job_label || "Visit"}
                    <span className="text-muted-foreground font-normal">
                      {" "}· {fmtDate(j.job_date)}{j.arrival_time ? ` · ${j.arrival_time}` : ""}
                    </span>
                  </div>
                  <div className="text-[11px]">
                    {invited ? (
                      <span className="text-emerald-700 inline-flex items-center gap-1">
                        <Send className="h-3 w-3" /> Customer invited
                      </span>
                    ) : (
                      <span className="text-amber-700 inline-flex items-center gap-1">
                        <BellOff className="h-3 w-3" /> Internal only
                      </span>
                    )}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setModal({ mode: "edit", job: j })} className="shrink-0">
                  <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                </Button>
              </div>
            );
          })}
        </div>
      )}

      {modal && (
        <ScheduleJobModal
          lead={lead}
          existing={modal.mode === "edit" ? modal.job : null}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); }}
        />
      )}
    </div>
  );
}
