// How much of GoHighLevel's daily API allowance we use (Alan, 2026-11-13),
// before the automations move off GHL. Numbers come from GHL's own headers.
import { useEffect, useState } from "react";
import { api, type GhlUsage } from "@/lib/api";

export default function GhlUsageCard() {
  const [u, setU] = useState<GhlUsage | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    const load = () => api.getGhlUsage().then(setU).catch(() => setErr(true));
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  if (err) return null;
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-base font-semibold">📡 GoHighLevel API today</p>
      {!u ? <p className="text-sm text-muted-foreground">Loading…</p> : (
        <div className="mt-2 space-y-2 text-sm">
          <p>Our requests today: <b className="tabular-nums">{u.our_requests_today.toLocaleString()}</b>
            {u.refused_today ? <span className="ml-2 font-semibold text-rose-600">GHL refused {u.refused_today}</span> : null}</p>
          {u.accounts.length === 0 ? <p className="text-muted-foreground">Waiting for GHL to report the daily allowance.</p> : u.accounts.map((a) => {
            const pct = a.limit ? Math.round((a.used / a.limit) * 100) : 0;
            return (
              <div key={a.account}>
                <div className="flex justify-between"><span className="font-medium">{a.account}</span>
                  <span className="tabular-nums">{a.used.toLocaleString()} of {a.limit.toLocaleString()} used · {a.left.toLocaleString()} left</span></div>
                <div className="mt-1 h-3 overflow-hidden rounded bg-muted">
                  <div className={`h-full ${a.low ? "bg-rose-500" : pct > 60 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
          {u.top_endpoints.length ? <p className="text-xs text-muted-foreground">Most used: {u.top_endpoints.slice(0, 4).map((t) => `${t.endpoint} ${t.requests.toLocaleString()}`).join(" · ")}</p> : null}
        </div>
      )}
    </div>
  );
}
