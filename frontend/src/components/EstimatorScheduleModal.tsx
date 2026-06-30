import { useState, useEffect, useCallback } from "react";
import { api, type EstimatorAvailability } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { X, Navigation, Clock, Loader2, MapPin } from "lucide-react";

function toYMD(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
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
  return n < 1 ? "<1 min" : `~${Math.round(n)} min`;
}

/** Pops when an admin drags a lead into the Estimator Needed column. Pick a
 *  day + slot for the estimate; shows the day's existing route + drive times
 *  so the admin can slot the new stop sensibly. */
export default function EstimatorScheduleModal({ lead, onClose, onScheduled }: {
  lead: { id: string; name: string };
  onClose: () => void;
  onScheduled: (leadId: string) => void;
}) {
  const [date, setDate] = useState<string>(() => toYMD(new Date()));
  const [time, setTime] = useState<string>("");
  const [avail, setAvail] = useState<EstimatorAvailability | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadAvail = useCallback(() => {
    setLoading(true);
    api.getEstimatorAvailability(date)
      .then(setAvail)
      .catch(() => toast.error("Couldn't load availability"))
      .finally(() => setLoading(false));
  }, [date]);

  useEffect(() => { loadAvail(); }, [loadAvail]);

  const book = async () => {
    if (!time) { toast.error("Pick a time first"); return; }
    setBusy(true);
    try {
      await api.createEstimatorVisit({ lead_id: lead.id, visit_date: date, start_time: time });
      toast.success(`Estimate booked for ${fmtTime(time)}`);
      onScheduled(lead.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to schedule");
    } finally {
      setBusy(false);
    }
  };

  const visits = avail?.visits || [];

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <Card className="w-full md:w-[30rem] max-w-[94vw] max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div>
            <h2 className="text-sm font-semibold">Schedule estimate</h2>
            <p className="text-xs text-muted-foreground">{lead.name}</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
        </div>

        <CardContent className="p-4 space-y-4 overflow-y-auto">
          {/* Date */}
          <div>
            <label className="text-xs font-semibold text-muted-foreground block mb-1">Day</label>
            <input
              type="date"
              value={date}
              onChange={(e) => { setDate(e.target.value); setTime(""); }}
              className="w-full text-sm rounded border bg-background px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>

          {/* Slot grid */}
          <div>
            <label className="text-xs font-semibold text-muted-foreground block mb-1">Time slot</label>
            {loading ? (
              <div className="flex justify-center py-4"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : (
              <div className="grid grid-cols-3 gap-1.5">
                {avail?.slots.map((s) => (
                  <button
                    key={s.start_time}
                    disabled={!s.available}
                    onClick={() => setTime(s.start_time)}
                    className={`text-xs rounded border px-2 py-1.5 transition-colors ${
                      time === s.start_time
                        ? "bg-primary text-primary-foreground border-primary"
                        : s.available
                          ? "bg-background hover:bg-muted"
                          : "bg-muted/50 text-muted-foreground/50 cursor-not-allowed line-through"
                    }`}
                    title={s.available ? "" : "Already booked"}
                  >
                    {fmtTime(s.start_time)}
                  </button>
                ))}
              </div>
            )}
            {/* Custom time — admin can schedule anytime, not just a listed slot. */}
            <div className="flex items-center gap-2 mt-2">
              <span className="text-[11px] text-muted-foreground">or custom:</span>
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="text-xs rounded border bg-background px-2 py-1 focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
          </div>

          {/* Existing route for the day, with drive times between stops */}
          {visits.length > 0 && (
            <div>
              <label className="text-xs font-semibold text-muted-foreground block mb-1">
                Already booked this day ({visits.length})
              </label>
              <div className="space-y-1">
                {visits.map((v, i) => (
                  <div key={v.id}>
                    {i > 0 && v.drive_minutes_from_prev != null && (
                      <div className="flex items-center gap-1 text-[11px] text-muted-foreground pl-1 py-0.5">
                        <Navigation className="h-3 w-3" /> {fmtDrive(v.drive_minutes_from_prev)} drive
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-2 rounded border bg-muted/30 px-2 py-1.5 text-xs">
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">{i + 1}</span>
                        <span className="truncate">{v.customer_name || "Customer"}</span>
                      </span>
                      <span className="text-muted-foreground shrink-0 flex items-center gap-1"><Clock className="h-3 w-3" /> {fmtTime(v.start_time)}</span>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground mt-1 flex items-start gap-1">
                <MapPin className="h-3 w-3 mt-0.5 shrink-0" />
                Drive times recalculate from the geocoded addresses once you book.
              </p>
            </div>
          )}
        </CardContent>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button size="sm" onClick={book} disabled={busy || !time}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Book estimate"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
