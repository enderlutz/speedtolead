import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { api, type MetaInsights, type MetaLevel, type MetaRow, type MetaStatus } from "@/lib/api";

// Meta ads (Alan, 2026-10-17): what each campaign, ad set and ad spends and
// what a lead costs, straight from the AT Pressure Washing ad account "AC 01"
// where Sterling's ads run. Read-only. Owner-only: it's spend.

const money = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n >= 100 ? 0 : 2 });
const LEVELS: { key: MetaLevel; label: string }[] = [
  { key: "campaign", label: "Campaigns" }, { key: "adset", label: "Ad sets" }, { key: "ad", label: "Ads" },
];
const RANGES = [7, 30, 90];

function rowName(r: MetaRow, level: MetaLevel) {
  if (level === "ad") return { title: r.ad || r.ad_id || "", sub: `${r.campaign} › ${r.adset}` };
  if (level === "adset") return { title: r.adset || r.adset_id || "", sub: r.campaign };
  return { title: r.campaign || r.campaign_id, sub: "" };
}

export default function MetaAds() {
  const [status, setStatus] = useState<MetaStatus | null>(null);
  const [level, setLevel] = useState<MetaLevel>("campaign");
  const [days, setDays] = useState(30);
  const [data, setData] = useState<MetaInsights | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

   
  useEffect(() => { api.metaStatus().then(setStatus).catch((e) => setStatus({ connected: false, error: String(e?.message || e) })); }, []);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try { setData(await api.metaInsights(level, days)); }
    catch (e) { setErr(e instanceof Error ? e.message : "Couldn't load from Meta"); setData(null); }
    finally { setLoading(false); }
  }, [level, days]);
   
  useEffect(() => { if (status?.connected) load(); }, [status, load]);

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <h1 className="text-2xl font-bold">Meta ads</h1>

      {!status ? (
        <Loader2 className="h-5 w-5 animate-spin" />
      ) : status.connected ? (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          <CheckCircle2 className="h-5 w-5 shrink-0" />
          Connected to <b>{status.name}</b> ({status.account_id}){status.timezone ? ` · ${status.timezone}` : ""}
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          <XCircle className="mt-0.5 h-5 w-5 shrink-0" />
          <div><b>Not connected.</b> {status.error}</div>
        </div>
      )}

      {status?.connected && (
        <>
          <div className="flex flex-wrap gap-2">
            {LEVELS.map((l) => (
              <button key={l.key} onClick={() => setLevel(l.key)}
                className={`min-h-[44px] rounded-full px-4 text-sm font-semibold ${level === l.key ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                {l.label}
              </button>
            ))}
            <span className="mx-1" />
            {RANGES.map((d) => (
              <button key={d} onClick={() => setDays(d)}
                className={`min-h-[44px] rounded-full px-4 text-sm font-semibold ${days === d ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                {d} days
              </button>
            ))}
          </div>

          {err && <p className="text-sm text-red-600">{err}</p>}
          {loading && !data && <Loader2 className="h-5 w-5 animate-spin" />}

          {data && (
            <>
              <div className="grid grid-cols-3 gap-2">
                {[["Spent", money(data.total.spend)], ["Leads", String(data.total.leads)], ["Per lead", money(data.total.cost_per_lead)]].map(([k, v]) => (
                  <Card key={k}><CardContent className="p-3">
                    <div className="text-xs text-muted-foreground">{k}</div>
                    <div className="text-xl font-bold tabular-nums">{v}</div>
                  </CardContent></Card>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{data.since} to {data.until}, leads as Meta counts them.</p>

              <div className={`space-y-2 ${loading ? "opacity-60" : ""}`}>
                {data.rows.length === 0 && <p className="text-sm text-muted-foreground">Nothing spent in this range.</p>}
                {data.rows.map((r, i) => {
                  const n = rowName(r, level);
                  return (
                    <Card key={`${r.ad_id || r.adset_id || r.campaign_id}-${i}`}><CardContent className="p-3">
                      <div className="font-semibold">{n.title}</div>
                      {n.sub && <div className="text-xs text-muted-foreground">{n.sub}</div>}
                      <div className="mt-2 grid grid-cols-4 gap-2 text-sm tabular-nums">
                        <div><div className="text-xs text-muted-foreground">Spent</div>{money(r.spend)}</div>
                        <div><div className="text-xs text-muted-foreground">Leads</div>{r.leads}</div>
                        <div><div className="text-xs text-muted-foreground">Per lead</div>{money(r.cost_per_lead)}</div>
                        <div><div className="text-xs text-muted-foreground">Clicks</div>{r.clicks.toLocaleString()}</div>
                      </div>
                    </CardContent></Card>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
