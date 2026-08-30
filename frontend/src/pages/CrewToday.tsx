import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type CrewToday as CrewTodayData, type CrewCard } from "@/lib/api";
import { toast } from "sonner";
import { Loader2, Phone, MapPin, Play, CheckCircle2, CloudRain, Flag, Clock } from "lucide-react";

/** Public, no-login crew phone page. Token in the URL identifies the worker
 * (same trust model as proposal pages). Shows today's jobs, tap-to-clock timing,
 * materials capture, and the rain/wrapping-up flow. */
export default function CrewToday() {
  const { token = "" } = useParams();
  const [data, setData] = useState<CrewTodayData | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [finishFor, setFinishFor] = useState<CrewCard | null>(null);

  const load = useCallback(() => {
    api.getCrewToday(token)
      .then((d) => { setData(d); setStatus("ready"); })
      .catch(() => setStatus("error"));
  }, [token]);
  useEffect(() => { load(); }, [load]);

  const runningCard = useMemo(
    () => [...(data?.primary || []), ...(data?.backup || [])].find((c) => c.running) || null,
    [data],
  );

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); load(); } catch { toast.error("Something went wrong — try again."); }
    finally { setBusy(false); }
  };

  if (status === "loading") {
    return <div className="min-h-dvh flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }
  if (status === "error" || !data) {
    return (
      <div className="min-h-dvh flex items-center justify-center p-6 text-center">
        <p className="text-sm text-muted-foreground">This crew link isn't active.<br />Ask your manager for a new one.</p>
      </div>
    );
  }

  const dateLabel = new Date(`${data.date}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

  return (
    <div className="min-h-dvh bg-muted/20 pb-24">
      <header className="bg-blue-600 text-white px-4 pt-6 pb-5 sticky top-0 z-10 shadow">
        <p className="text-xs opacity-80">Sterling Fence Staining</p>
        <h1 className="text-xl font-bold">Hi {data.worker.first_name || data.worker.name} 👋</h1>
        <p className="text-sm opacity-90">{dateLabel}</p>
      </header>

      <main className="px-4 py-4 space-y-4 max-w-md mx-auto">
        {!data.day_started ? (
          <button
            disabled={busy}
            onClick={() => act(() => api.crewStartDay(token))}
            className="w-full py-4 rounded-xl bg-blue-600 text-white font-semibold text-lg shadow disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Play className="h-5 w-5" />} Start Day
          </button>
        ) : (
          <div className="flex items-center justify-between rounded-xl border bg-background px-3 py-2 text-sm">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Clock className="h-4 w-4" />
              {data.open_segment?.kind === "work" ? "Working" : data.open_segment?.kind === "travel" ? "On the road" : "On the clock"}
            </span>
            <button disabled={busy} onClick={() => act(() => api.crewEndDay(token))} className="text-red-600 font-medium hover:underline disabled:opacity-50">End Day</button>
          </div>
        )}

        <Section title="TODAY" cards={data.primary} token={token} busy={busy} runningId={runningCard?.job_task_id || null}
                 dayStarted={data.day_started} onAct={act} onFinish={setFinishFor} />

        {data.backup.length > 0 && (
          <Section title="BACKUP (if rain)" cards={data.backup} token={token} busy={busy} runningId={runningCard?.job_task_id || null}
                   dayStarted={data.day_started} onAct={act} onFinish={setFinishFor} muted />
        )}

        {data.primary.length === 0 && data.backup.length === 0 && (
          <p className="text-center text-sm text-muted-foreground py-10">Nothing scheduled for you today. 🎉</p>
        )}
      </main>

      {finishFor && (
        <FinishSheet
          card={finishFor}
          onClose={() => setFinishFor(null)}
          onDone={async (body) => {
            await act(() => api.crewFinish(token, { job_task_id: finishFor.job_task_id, ...body }));
            setFinishFor(null);
          }}
        />
      )}
    </div>
  );
}

function Section({ title, cards, token, busy, runningId, dayStarted, onAct, onFinish, muted }: {
  title: string; cards: CrewCard[]; token: string; busy: boolean; runningId: string | null; dayStarted: boolean;
  onAct: (fn: () => Promise<unknown>) => Promise<void>; onFinish: (c: CrewCard) => void; muted?: boolean;
}) {
  if (cards.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{title}</p>
      {cards.map((c, i) => (
        <JobCardView key={c.job_task_id} card={c} index={i + 1} token={token} busy={busy}
                     running={runningId === c.job_task_id} anyRunning={!!runningId} dayStarted={dayStarted}
                     onAct={onAct} onFinish={onFinish} muted={muted} />
      ))}
    </div>
  );
}

function JobCardView({ card, index, token, busy, running, anyRunning, dayStarted, onAct, onFinish, muted }: {
  card: CrewCard; index: number; token: string; busy: boolean; running: boolean; anyRunning: boolean; dayStarted: boolean;
  onAct: (fn: () => Promise<unknown>) => Promise<void>; onFinish: (c: CrewCard) => void; muted?: boolean;
}) {
  const done = card.status === "complete";
  const details = [card.package && cap(card.package), card.sides, card.linear_feet ? `${card.linear_feet} LF` : "", card.height, card.task_type === "stain" ? card.stain_color : ""]
    .filter(Boolean).join(" · ");
  return (
    <div className={`rounded-xl border bg-background p-3 shadow-sm ${done ? "opacity-60" : ""} ${muted ? "border-dashed" : ""}`}>
      <div className="flex items-start gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700 text-sm font-bold">{index}</span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold flex items-center gap-1.5">
            <span>{card.emoji}</span> {card.task_label} — {card.customer_name}
            {done && <CheckCircle2 className="h-4 w-4 text-green-600" />}
          </div>
          {card.address && (
            <a href={card.maps_url} target="_blank" rel="noreferrer" className="text-sm text-blue-600 flex items-center gap-1 hover:underline">
              <MapPin className="h-3.5 w-3.5" /> {card.address}
            </a>
          )}
          {card.customer_phone && (
            <a
              href={`tel:${card.customer_phone.replace(/[^\d+]/g, "")}`}
              className="text-sm text-emerald-700 flex items-center gap-1 hover:underline font-medium"
            >
              <Phone className="h-3.5 w-3.5" /> {card.customer_phone}
            </a>
          )}
          {details && <p className="text-xs text-muted-foreground mt-0.5">{details}</p>}
          {card.pm_note && <p className="text-xs mt-1 rounded bg-amber-50 text-amber-800 px-2 py-1">📋 {card.pm_note}</p>}
        </div>
      </div>

      {!done && (
        <div className="mt-3">
          {running ? (
            <div className="space-y-2">
              <Timer />
              <div className="grid grid-cols-2 gap-2">
                <button disabled={busy} onClick={() => onFinish(card)} className="py-2.5 rounded-lg bg-green-600 text-white font-semibold text-sm disabled:opacity-50 flex items-center justify-center gap-1">
                  <CheckCircle2 className="h-4 w-4" /> Done
                </button>
                <button disabled={busy} onClick={() => onFinish(card)} className="py-2.5 rounded-lg bg-slate-200 text-slate-700 font-medium text-sm disabled:opacity-50 flex items-center justify-center gap-1">
                  <CloudRain className="h-4 w-4" /> Stop
                </button>
              </div>
              <button
                disabled={busy || !!card.wrapping_up_at}
                onClick={() => onAct(() => api.crewWrappingUp(token, card.job_task_id).then(() => toast.success("PM notified — keep going!")))}
                className="w-full py-2 rounded-lg border border-amber-400 text-amber-700 font-medium text-sm disabled:opacity-50 flex items-center justify-center gap-1"
              >
                <Flag className="h-4 w-4" /> {card.wrapping_up_at ? "PM notified ✓" : "Wrapping Up (~20 min out)"}
              </button>
            </div>
          ) : (
            <button
              disabled={busy || !dayStarted || anyRunning}
              onClick={() => onAct(() => api.crewArrive(token, card.job_task_id))}
              title={!dayStarted ? "Start your day first" : anyRunning ? "Finish your current job first" : ""}
              className="w-full py-2.5 rounded-lg bg-blue-600 text-white font-semibold text-sm disabled:opacity-40"
            >
              I'm Here
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Simple mm:ss (or h:mm:ss) counter that starts when mounted (i.e. when a task
 * goes running). Resets on the next running task since the component remounts. */
function Timer() {
  const [start] = useState(() => Date.now());
  // The interval stores the clock itself instead of bumping a counter, so
  // render never calls Date.now() (react-hooks/purity). Same 1s cadence.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const s = Math.floor((now - start) / 1000);
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const label = hh > 0 ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${mm}:${String(ss).padStart(2, "0")}`;
  return (
    <div className="text-center rounded-lg bg-blue-50 py-2">
      <span className="text-2xl font-bold tabular-nums text-blue-700">{label}</span>
    </div>
  );
}

function FinishSheet({ card, onClose, onDone }: {
  card: CrewCard;
  onClose: () => void;
  onDone: (body: { outcome: "done" | "rain" | "other"; gallons?: number; stain_color?: string; progress_note?: string }) => Promise<void>;
}) {
  const [mode, setMode] = useState<"choose" | "done" | "stop">("choose");
  const [gallons, setGallons] = useState("");
  const [color, setColor] = useState(card.stain_color || "");
  const [note, setNote] = useState("");
  const isStain = card.task_type === "stain";
  const isClean = card.task_type === "clean";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div className="w-full max-w-md rounded-t-2xl bg-background p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto h-1 w-10 rounded-full bg-muted" />
        <p className="font-semibold text-center">{card.emoji} {card.task_label} — {card.customer_name}</p>

        {mode === "choose" && (
          <div className="grid grid-cols-1 gap-2 pt-1">
            <button onClick={() => setMode("done")} className="py-3 rounded-lg bg-green-600 text-white font-semibold flex items-center justify-center gap-2"><CheckCircle2 className="h-5 w-5" /> Finished this job</button>
            <button onClick={() => setMode("stop")} className="py-3 rounded-lg bg-slate-200 text-slate-700 font-medium flex items-center justify-center gap-2"><CloudRain className="h-5 w-5" /> Stopping — rain / other</button>
          </div>
        )}

        {mode === "done" && (
          <div className="space-y-3 pt-1">
            {(isClean || isStain) && (
              <label className="block">
                <span className="text-sm font-medium">{isClean ? "Bleach gallons used" : "Stain gallons used"}</span>
                <input type="number" inputMode="decimal" value={gallons} onChange={(e) => setGallons(e.target.value)}
                       className="mt-1 w-full rounded-lg border px-3 py-2.5 text-base" placeholder="0" />
              </label>
            )}
            {isStain && (
              <label className="block">
                <span className="text-sm font-medium">Stain color used</span>
                <input value={color} onChange={(e) => setColor(e.target.value)}
                       className="mt-1 w-full rounded-lg border px-3 py-2.5 text-base" placeholder="e.g. Dark Walnut" />
              </label>
            )}
            <button
              onClick={() => onDone({ outcome: "done", gallons: gallons ? Number(gallons) : undefined, stain_color: isStain ? color : undefined })}
              className="w-full py-3 rounded-lg bg-green-600 text-white font-semibold">Mark complete</button>
          </div>
        )}

        {mode === "stop" && (
          <div className="space-y-3 pt-1">
            <label className="block">
              <span className="text-sm font-medium">What's left? (goes to your PM)</span>
              <input value={note} onChange={(e) => setNote(e.target.value)}
                     className="mt-1 w-full rounded-lg border px-3 py-2.5 text-base" placeholder="e.g. 2 of 4 sides done" />
            </label>
            <button onClick={() => onDone({ outcome: "rain", progress_note: note })}
                    className="w-full py-3 rounded-lg bg-slate-700 text-white font-semibold">Stop & save progress</button>
          </div>
        )}
      </div>
    </div>
  );
}

function cap(s: string) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
