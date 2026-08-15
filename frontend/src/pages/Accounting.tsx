import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useNow } from "@/hooks/useNow";
import {
  api, getCurrentUser,
  type AccountingSummary, type JobProfitabilityRow,
  type OverheadEntry, type OverheadBody,
  type OutstandingJob, type QuickBooksStatus,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatCurrency, timeAgo } from "@/lib/utils";
import { toast } from "sonner";
import {
  DollarSign, TrendingUp, Plus, Trash2, Pencil, Check, X, Calculator, Receipt, Users as UsersIcon, FileText, AlertCircle, Wrench,
} from "lucide-react";

type Period = "this_month" | "last_month" | "ytd" | "all";
const PERIOD_LABELS: Record<Period, string> = {
  this_month: "This Month",
  last_month: "Last Month",
  ytd: "Year to Date",
  all: "All Time",
};

export default function Accounting() {
  const user = getCurrentUser();
  const navigate = useNavigate();
  const [urlParams] = useSearchParams();
  const focusJobId = urlParams.get("job");
  const focusedRowRef = useRef<HTMLTableRowElement | null>(null);

  const [period, setPeriod] = useState<Period>("this_month");
  const [summary, setSummary] = useState<AccountingSummary | null>(null);
  const [jobs, setJobs] = useState<JobProfitabilityRow[]>([]);
  const [overhead, setOverhead] = useState<OverheadEntry[]>([]);
  const [outstanding, setOutstanding] = useState<{ jobs: OutstandingJob[]; total_outstanding: number }>({ jobs: [], total_outstanding: 0 });
  const [qbStatus, setQbStatus] = useState<QuickBooksStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.getAccountingSummary(period).then(setSummary).catch(() => setSummary(null)),
      api.getJobProfitability(period).then((r) => setJobs(r.jobs)).catch(() => setJobs([])),
      api.listOverhead().then((r) => setOverhead(r.entries)).catch(() => setOverhead([])),
      api.getOutstanding().then(setOutstanding).catch(() => setOutstanding({ jobs: [], total_outstanding: 0 })),
      api.getQuickBooksStatus().then(setQbStatus).catch(() => setQbStatus(null)),
    ]).finally(() => setLoading(false));
  }, [period]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: raises the loading flag when this fetch's inputs change; the data itself lands asynchronously.
  useEffect(() => { load(); }, [load]);

  // Scroll the linked-from-Calendar job into view
  useEffect(() => {
    if (focusJobId && focusedRowRef.current) {
      focusedRowRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [focusJobId, jobs]);

  if (user?.role !== "admin") {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="pt-6 text-center text-sm text-muted-foreground">
            This area is owner-only.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-7xl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Calculator className="h-5 w-5 text-primary" /> Accounting
          </h1>
          <p className="text-sm text-muted-foreground">
            Revenue, labor, reimbursements, overhead, and per-job margin · owner-only
          </p>
        </div>
        <div className="inline-flex border rounded-md text-xs">
          {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 border-r last:border-r-0 ${
                period === p ? "bg-primary text-primary-foreground" : "hover:bg-muted"
              }`}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      {summary && summary.start && summary.end && (
        <p className="text-xs text-muted-foreground">
          Window: {summary.start} → {summary.end}
          {summary.months_in_period > 1 && ` · ${summary.months_in_period} months for overhead`}
        </p>
      )}

      {/* KPI cards */}
      <KpiGrid summary={summary} loading={loading} />

      {/* Outstanding (unpaid) jobs */}
      <OutstandingCard data={outstanding} onChange={load} />

      {/* Overhead manager */}
      <OverheadCard
        entries={overhead}
        onChange={load}
      />

      {/* Per-job P&L */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" /> Job profitability
            <span className="text-xs font-normal text-muted-foreground">
              · {jobs.length} job{jobs.length === 1 ? "" : "s"} in {PERIOD_LABELS[period]}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {loading ? (
            <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-10 bg-muted rounded animate-pulse" />)}</div>
          ) : jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No jobs scheduled in {PERIOD_LABELS[period].toLowerCase()}.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="px-2 py-1.5 font-medium">Date</th>
                  <th className="px-2 py-1.5 font-medium">Customer</th>
                  <th className="px-2 py-1.5 font-medium">Service</th>
                  <th className="px-2 py-1.5 font-medium text-right" title="What the customer agreed to pay (contract value)">Contracted</th>
                  <th className="px-2 py-1.5 font-medium text-right" title="Cash actually collected via QuickBooks">Collected</th>
                  <th className="px-2 py-1.5 font-medium text-right">Labor</th>
                  <th className="px-2 py-1.5 font-medium text-right">Materials</th>
                  <th className="px-2 py-1.5 font-medium text-right">Reimb.</th>
                  <th className="px-2 py-1.5 font-medium text-right" title="Collected − costs">Profit</th>
                  <th className="px-2 py-1.5 font-medium text-right">Margin</th>
                  <th className="px-2 py-1.5 font-medium text-center">Paid?</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => {
                  const isFocus = focusJobId && (j.scheduled_job_id === focusJobId || j.lead_id === focusJobId);
                  const contracted = j.contracted_price || 0;
                  // Unpaid-but-already-run jobs show a loss; that's the honest view.
                  // Highlight the Collected column when it lags Contracted so admin's
                  // eye lands on the cashflow gap.
                  const underCollected = contracted > 0 && j.revenue < contracted;
                  return (
                    <tr
                      key={j.scheduled_job_id}
                      ref={isFocus ? focusedRowRef : null}
                      onClick={() => navigate(`/leads/${j.lead_id}`)}
                      className={`border-b cursor-pointer hover:bg-muted/30 ${
                        isFocus ? "bg-primary/5 ring-1 ring-primary/30" : ""
                      }`}
                    >
                      <td className="px-2 py-2 font-mono text-xs">{j.job_date}</td>
                      <td className="px-2 py-2 font-medium truncate max-w-[180px]">{j.customer_name}</td>
                      <td className="px-2 py-2 text-xs text-muted-foreground capitalize">
                        {j.service_type.replace("_", " ")}
                        {j.package_tier && ` · ${j.package_tier}`}
                      </td>
                      <td className="px-2 py-2 text-right text-muted-foreground">{formatCurrency(contracted)}</td>
                      <td className={`px-2 py-2 text-right font-medium ${underCollected ? "text-amber-700" : "text-emerald-700"}`}>
                        {formatCurrency(j.revenue)}
                      </td>
                      <td className="px-2 py-2 text-right text-muted-foreground">{formatCurrency(j.labor_cost)}</td>
                      <td className="px-2 py-2 text-right text-muted-foreground">{formatCurrency(j.materials_cost || 0)}</td>
                      <td className="px-2 py-2 text-right text-muted-foreground">{formatCurrency(j.reimbursement_cost)}</td>
                      <td className={`px-2 py-2 text-right font-semibold ${
                        j.profit < 0 ? "text-red-600" : j.profit > 0 ? "text-emerald-700" : "text-muted-foreground"
                      }`}>{formatCurrency(j.profit)}</td>
                      <td className={`px-2 py-2 text-right text-xs ${
                        j.margin_pct < 20 ? "text-red-600" : j.margin_pct < 40 ? "text-amber-700" : "text-emerald-700"
                      }`}>{j.revenue > 0 ? `${j.margin_pct.toFixed(0)}%` : "—"}</td>
                      <td className="px-2 py-2 text-center">
                        {j.payment_status === "paid" ? (
                          <span className="text-[10px] uppercase tracking-wide bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded font-bold">PAID</span>
                        ) : j.payment_status === "bnpl_financed" ? (
                          <span className="text-[10px] uppercase tracking-wide bg-purple-100 text-purple-800 px-1.5 py-0.5 rounded font-bold">BNPL</span>
                        ) : (
                          <span className="text-[10px] uppercase tracking-wide bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-bold">UNPAID</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 font-semibold bg-muted/20">
                  <td colSpan={3} className="px-2 py-2 text-right text-xs text-muted-foreground">Totals</td>
                  <td className="px-2 py-2 text-right">{formatCurrency(jobs.reduce((a, j) => a + (j.contracted_price || 0), 0))}</td>
                  <td className="px-2 py-2 text-right">{formatCurrency(jobs.reduce((a, j) => a + j.revenue, 0))}</td>
                  <td className="px-2 py-2 text-right">{formatCurrency(jobs.reduce((a, j) => a + j.labor_cost, 0))}</td>
                  <td className="px-2 py-2 text-right">{formatCurrency(jobs.reduce((a, j) => a + (j.materials_cost || 0), 0))}</td>
                  <td className="px-2 py-2 text-right">{formatCurrency(jobs.reduce((a, j) => a + j.reimbursement_cost, 0))}</td>
                  <td className="px-2 py-2 text-right">{formatCurrency(jobs.reduce((a, j) => a + j.profit, 0))}</td>
                  <td className="px-2 py-2"></td>
                  <td className="px-2 py-2"></td>
                </tr>
              </tfoot>
            </table>
          )}
          <p className="text-[11px] text-muted-foreground mt-2">
            Click any row to open the lead. Profit + margin use the <strong>Collected</strong> column (cash you actually received).
            Jobs that already ran but haven't been paid show a loss until QuickBooks confirms the payment.
          </p>
        </CardContent>
      </Card>

      {/* QuickBooks status */}
      <QuickBooksStatusCard status={qbStatus} onChange={load} />
    </div>
  );
}


function QuickBooksStatusCard({ status, onChange }: { status: QuickBooksStatus | null; onChange: () => void }) {
  const now = useNow();
  if (!status) {
    return (
      <Card className="border-dashed">
        <CardContent className="pt-4 text-xs text-muted-foreground">QuickBooks status loading…</CardContent>
      </Card>
    );
  }
  const connected = status.connected;
  const isMock = status.mode === "mock";

  // W4 (2026-06-08) — Webhook health pill. Three states, derived from
  // last_webhook_received_at + outstanding_invoices:
  //   • green   — webhook within 24h OR nothing outstanding (idle is fine)
  //   • yellow  — 24-72h quiet with outstanding > 0
  //   • red     — 72h+ quiet OR never-received with outstanding > 0
  // Only renders in live + connected mode (no point in mock/disconnected).
  let healthPill: React.ReactNode = null;
  if (!isMock && connected) {
    const last = status.last_webhook_received_at || "";
    const outstanding = status.outstanding_invoices || 0;
    const ageMs = last
      ? Math.max(0, now - new Date(last).getTime())
      : Number.POSITIVE_INFINITY;
    const ageHours = ageMs / 3600000;
    const labelTime = last ? timeAgo(last) : "never";
    let tone: "green" | "yellow" | "red" = "green";
    if (outstanding > 0) {
      if (!last || ageHours >= 72) tone = "red";
      else if (ageHours >= 24) tone = "yellow";
    } else if (!last) {
      // Connected but no webhook ever — that's normal until the first
      // customer pays. Stay green with an "idle" label rather than scaring
      // Alan with a red pill on a fresh integration.
      tone = "green";
    }
    const toneCls =
      tone === "red" ? "bg-red-100 text-red-800"
      : tone === "yellow" ? "bg-amber-100 text-amber-800"
      : "bg-emerald-100 text-emerald-800";
    const toneLabel =
      tone === "red" ? "Stale" : tone === "yellow" ? "Quiet" : (last ? "Healthy" : "Idle");
    const detail = outstanding > 0
      ? `${labelTime} · ${outstanding} outstanding`
      : (last ? labelTime : "no payments yet");
    healthPill = (
      <span
        className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-bold ${toneCls}`}
        title={`Webhook health · ${toneLabel} (${detail})`}
      >
        {toneLabel} · webhook {detail}
      </span>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2 flex-wrap">
          <FileText className="h-4 w-4 text-primary" />
          QuickBooks Online
          {isMock && <span className="text-[10px] uppercase tracking-wide bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-bold">TEST MODE</span>}
          {!isMock && connected && <span className="text-[10px] uppercase tracking-wide bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded font-bold">LIVE</span>}
          {!isMock && !connected && <span className="text-[10px] uppercase tracking-wide bg-muted text-muted-foreground px-1.5 py-0.5 rounded font-bold">DISCONNECTED</span>}
          {healthPill}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm space-y-2">
        {isMock ? (
          <>
            <p className="text-xs text-muted-foreground">
              Backend is in <span className="font-mono">mock</span> mode — Generate Invoice on a lead returns a believable
              fake hosted URL so you can exercise the full flow tonight without real Intuit credentials. Flip
              <span className="font-mono"> QB_MODE=live</span> + add <span className="font-mono">QB_CLIENT_ID</span> /
              <span className="font-mono"> QB_CLIENT_SECRET</span> when Alan has the Intuit Developer app set up.
            </p>
            <p className="text-[11px] text-muted-foreground">
              On any unpaid job, the Mock Payment button on the Calendar's Mark Paid flow simulates the customer paying
              the invoice — flips status to PAID, fills amount_collected, and the dashboard reflects revenue immediately.
            </p>
          </>
        ) : connected ? (
          <>
            <p className="text-xs">
              Connected to <span className="font-medium">{status.company_name || "QuickBooks company"}</span>
              {status.connected_at && ` · since ${status.connected_at.slice(0, 10)}`}.
            </p>
            <div className="flex flex-wrap gap-2">
              {/* W3 (2026-06-08) — manual reconcile. The webhook is the primary
                  sync path; this is the "I think QB knows something we don't"
                  escape hatch + the demo button that proves the integration
                  actually pulls live state from QB. */}
              <ReconcileButton onComplete={onChange} />
              <Button variant="outline" size="sm" onClick={async () => {
                if (!confirm("Disconnect QuickBooks? Generate Invoice will stop working until you reconnect.")) return;
                try {
                  await api.disconnectQuickBooks();
                  toast.success("Disconnected");
                  onChange();
                } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
              }}>Disconnect</Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Not connected. Click below to authorize Sterling Fence Staining's QuickBooks Online company —
              after that, "Generate Invoice" on any lead will create real QB invoices and SMS the link to the customer.
            </p>
            <Button size="sm" onClick={async () => {
              try {
                const r = await api.getQuickBooksAuthUrl();
                window.location.href = r.url;
              } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
            }}>Connect QuickBooks</Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}


function ReconcileButton({ onComplete }: { onComplete: () => void }) {
  // W3 (2026-06-08) — "Sync from QB now" button. Calls the reconcile
  // endpoint and shows a toast summarizing how many jobs / deposits
  // changed state. If QB is in mock mode the endpoint returns
  // skipped_mock:true and we surface that explicitly.
  const [syncing, setSyncing] = useState(false);
  const handle = async () => {
    setSyncing(true);
    try {
      const r = await api.reconcileQuickBooks();
      const skipped = r.skipped_mock || r.jobs.skipped_mock || r.deposits.skipped_mock;
      if (skipped) {
        toast.info("QB is in test mode — no live invoices to reconcile.");
        return;
      }
      const totalChecked = r.jobs.checked + r.deposits.checked;
      const totalUpdated = r.jobs.updated + r.deposits.updated;
      const totalErrors = r.jobs.errors + r.deposits.errors;
      if (totalUpdated > 0) {
        toast.success(
          `Synced — ${totalUpdated} new payment${totalUpdated === 1 ? "" : "s"} found (checked ${totalChecked}).`,
        );
      } else {
        toast.success(`In sync — checked ${totalChecked}, no changes.`);
      }
      if (totalErrors > 0) {
        toast.warning(`${totalErrors} invoice${totalErrors === 1 ? "" : "s"} couldn't be reached. Check QB logs.`);
      }
      onComplete();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Reconcile failed");
    } finally {
      setSyncing(false);
    }
  };
  return (
    <Button variant="outline" size="sm" onClick={handle} disabled={syncing}>
      {syncing ? "Syncing…" : "Sync from QB now"}
    </Button>
  );
}


function OutstandingCard({ data }: { data: { jobs: OutstandingJob[]; total_outstanding: number }; onChange: () => void }) {
  if (data.jobs.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-emerald-600" /> Accounts Receivable
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          No outstanding payments — every job is paid up. 🎉
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className="border-amber-200">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <AlertCircle className="h-4 w-4 text-amber-600" />
          Accounts Receivable
          <span className="text-xs font-normal text-muted-foreground">
            · {formatCurrency(data.total_outstanding)} owed across {data.jobs.length} job{data.jobs.length === 1 ? "" : "s"}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground border-b">
              <th className="px-2 py-1.5 font-medium">Date</th>
              <th className="px-2 py-1.5 font-medium">Customer</th>
              <th className="px-2 py-1.5 font-medium">Address</th>
              <th className="px-2 py-1.5 font-medium text-right">Amount due</th>
              <th className="px-2 py-1.5 font-medium">Invoice</th>
              <th className="px-2 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {data.jobs.map((j) => (
              <tr key={j.scheduled_job_id} className="border-b">
                <td className="px-2 py-2 font-mono text-xs">{j.job_date}</td>
                <td className="px-2 py-2 font-medium">{j.customer_name}</td>
                <td className="px-2 py-2 text-xs text-muted-foreground truncate max-w-[260px]">{j.address}</td>
                <td className="px-2 py-2 text-right font-semibold">{formatCurrency(j.amount_due)}</td>
                <td className="px-2 py-2 text-xs">
                  {j.qb_invoice_url ? (
                    <a href={j.qb_invoice_url} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">
                      {j.qb_invoice_status || "view"}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-2 py-2 text-right">
                  <Button variant="ghost" size="sm" onClick={() => window.location.assign(`/leads/${j.lead_id}?invoice=1`)}>
                    Open lead
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[11px] text-muted-foreground mt-2">
          Cash flow heads-up — these are jobs you've contracted but haven't been paid for yet. Open the lead to generate a QuickBooks invoice or mark paid manually.
        </p>
      </CardContent>
    </Card>
  );
}


function KpiGrid({ summary, loading }: { summary: AccountingSummary | null; loading: boolean }) {
  if (loading || !summary) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[1, 2, 3, 4].map((i) => <div key={i} className="h-24 bg-muted rounded animate-pulse" />)}
      </div>
    );
  }
  const tile = (label: string, value: string, sub?: string, color: string = "text-foreground", icon: React.ReactNode = null) => (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-center gap-1.5 mb-1">
          {icon}
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
        </div>
        <p className={`text-xl sm:text-2xl font-bold ${color}`}>{value}</p>
        {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
  const profitColor = summary.net_profit < 0 ? "text-red-600" : "text-emerald-700";
  const fmtPct = (n: number) => `${n.toFixed(1)}%`;

  // W1 (2026-06-08): three new revenue tiles up top. Revenue = collected
  // cash (the honest number). Pipeline = contracted closed_price (future
  // money). Collection Rate = how much of what we billed has hit the bank.
  // Deposit subtotal surfaces as a subtitle so Alan can see the split.
  const depositPart = summary.revenue_from_deposits || 0;
  const depositSubtitle = depositPart > 0
    ? `${summary.jobs_count} job${summary.jobs_count === 1 ? "" : "s"} · incl. ${formatCurrency(depositPart)} deposits`
    : `${summary.jobs_count} job${summary.jobs_count === 1 ? "" : "s"}`;

  const contracted = summary.contracted_revenue || 0;
  const contractedDelta = contracted - (summary.revenue_from_jobs || 0);

  const collectionRateColor =
    summary.collection_rate_pct >= 90 ? "text-emerald-700"
    : summary.collection_rate_pct >= 60 ? "text-foreground"
    : "text-amber-700";

  return (
    <>
      {/* Revenue picture — collected, pipeline, collection rate */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {tile("Revenue (Collected)", formatCurrency(summary.revenue),
          depositSubtitle,
          "text-emerald-700",
          <DollarSign className="h-3.5 w-3.5 text-emerald-700" />)}
        {tile("Pipeline (Contracted)", formatCurrency(contracted),
          contracted > 0
            ? `${formatCurrency(Math.max(0, contractedDelta))} still to collect on closed deals`
            : "No deals booked yet this period",
          "text-foreground",
          <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />)}
        {tile("Collection Rate", `${(summary.collection_rate_pct || 0).toFixed(1)}%`,
          contracted > 0
            ? `${formatCurrency(summary.revenue_from_jobs || 0)} of ${formatCurrency(contracted)} contracted`
            : "Nothing contracted to collect against",
          collectionRateColor,
          <Receipt className={`h-3.5 w-3.5 ${collectionRateColor}`} />)}
      </div>
      {/* Costs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {tile("Labor", formatCurrency(summary.labor_cost),
          summary.revenue > 0 ? `${(summary.labor_cost / summary.revenue * 100).toFixed(0)}% of rev` : "—",
          "text-muted-foreground",
          <UsersIcon className="h-3.5 w-3.5 text-muted-foreground" />)}
        {tile("Materials", formatCurrency(summary.materials_cost || 0),
          summary.revenue > 0 ? `${((summary.materials_cost || 0) / summary.revenue * 100).toFixed(0)}% of rev` : "—",
          "text-muted-foreground",
          <Wrench className="h-3.5 w-3.5 text-muted-foreground" />)}
        {tile("Reimbursements", formatCurrency(summary.reimbursement_cost),
          summary.revenue > 0 ? `${(summary.reimbursement_cost / summary.revenue * 100).toFixed(0)}% of rev` : "—",
          "text-muted-foreground",
          <Receipt className="h-3.5 w-3.5 text-muted-foreground" />)}
        {tile("Overhead", formatCurrency(summary.overhead_cost),
          `${formatCurrency(summary.overhead_monthly)}/mo × ${summary.months_in_period}`,
          "text-muted-foreground",
          <Calculator className="h-3.5 w-3.5 text-muted-foreground" />)}
      </div>
      {/* Profit + AR */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {tile("Gross Profit", formatCurrency(summary.gross_profit),
          `${fmtPct(summary.gross_margin_pct)} margin · vs collected`,
          summary.gross_profit < 0 ? "text-red-600" : "text-emerald-700",
          <TrendingUp className="h-3.5 w-3.5 text-emerald-700" />)}
        {tile("Net Profit", formatCurrency(summary.net_profit),
          `${fmtPct(summary.net_margin_pct)} margin · after overhead`,
          profitColor,
          <TrendingUp className={`h-3.5 w-3.5 ${profitColor}`} />)}
        {tile("Outstanding A/R", formatCurrency(summary.outstanding_revenue || 0),
          (summary.outstanding_revenue || 0) > 0 ? "Closed deals still owing" : "All collected",
          (summary.outstanding_revenue || 0) > 0 ? "text-amber-700" : "text-emerald-700",
          <AlertCircle className={`h-3.5 w-3.5 ${(summary.outstanding_revenue || 0) > 0 ? "text-amber-600" : "text-emerald-600"}`} />)}
      </div>
    </>
  );
}


function OverheadCard({ entries, onChange }: { entries: OverheadEntry[]; onChange: () => void }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const totalActive = useMemo(
    () => entries.filter((e) => e.active).reduce((a, e) => a + e.monthly_amount, 0),
    [entries],
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-primary" /> Monthly Overhead
            <span className="text-xs font-normal text-muted-foreground">
              · {formatCurrency(totalActive)}/mo total
            </span>
          </CardTitle>
          <Button size="sm" variant={showAdd ? "outline" : "default"} onClick={() => setShowAdd(!showAdd)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> {showAdd ? "Cancel" : "Add"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {showAdd && (
          <OverheadForm
            onSaved={() => { setShowAdd(false); onChange(); }}
            onCancel={() => setShowAdd(false)}
          />
        )}
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-3">
            No overhead entries yet. Click Add to record monthly costs (rent, insurance, fuel, software, etc.).
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="px-2 py-1.5 font-medium">Category</th>
                  <th className="px-2 py-1.5 font-medium">Description</th>
                  <th className="px-2 py-1.5 font-medium text-right">Monthly</th>
                  <th className="px-2 py-1.5 font-medium">Status</th>
                  <th className="px-2 py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  editing === e.id ? (
                    <OverheadEditRow
                      key={e.id}
                      entry={e}
                      onSaved={() => { setEditing(null); onChange(); }}
                      onCancel={() => setEditing(null)}
                    />
                  ) : (
                    <tr key={e.id} className={`border-b ${e.active ? "" : "opacity-50"}`}>
                      <td className="px-2 py-2 font-medium">{e.category || "—"}</td>
                      <td className="px-2 py-2 text-xs text-muted-foreground truncate max-w-[280px]">{e.description || "—"}</td>
                      <td className="px-2 py-2 text-right font-semibold">{formatCurrency(e.monthly_amount)}</td>
                      <td className="px-2 py-2">
                        {e.active ? (
                          <Badge className="bg-emerald-100 text-emerald-800 text-[10px]">Active</Badge>
                        ) : (
                          <Badge className="bg-muted text-muted-foreground text-[10px]">Paused</Badge>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right whitespace-nowrap">
                        <button onClick={() => setEditing(e.id)} className="text-muted-foreground hover:text-primary p-1" title="Edit">
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={async () => {
                            if (!confirm(`Delete "${e.category || "this entry"}"? It'll be removed from overhead totals.`)) return;
                            try { await api.deleteOverhead(e.id); toast.success("Deleted"); onChange(); }
                            catch (err) { toast.error(err instanceof Error ? err.message : "Failed"); }
                          }}
                          className="text-muted-foreground hover:text-red-600 p-1"
                          title="Delete"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  )
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}


function OverheadForm({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const [body, setBody] = useState<OverheadBody>({
    category: "",
    description: "",
    monthly_amount: 0,
    active: true,
  });
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!body.category.trim()) { toast.error("Category is required"); return; }
    if (body.monthly_amount < 0) { toast.error("Monthly amount can't be negative"); return; }
    setSaving(true);
    try {
      await api.createOverhead(body);
      toast.success("Added");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border rounded-lg p-3 bg-muted/20 space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div>
          <label className="text-xs font-semibold text-muted-foreground">Category</label>
          <Input
            value={body.category}
            onChange={(e) => setBody({ ...body, category: e.target.value })}
            placeholder="e.g. Rent, Insurance, Fuel"
            className="mt-0.5"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="text-xs font-semibold text-muted-foreground">Description (optional)</label>
          <Input
            value={body.description}
            onChange={(e) => setBody({ ...body, description: e.target.value })}
            placeholder="What does this cover?"
            className="mt-0.5"
          />
        </div>
      </div>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label className="text-xs font-semibold text-muted-foreground">Monthly amount ($)</label>
          <Input
            type="number"
            step="0.01"
            value={body.monthly_amount || ""}
            onChange={(e) => setBody({ ...body, monthly_amount: parseFloat(e.target.value) || 0 })}
            placeholder="0.00"
            className="mt-0.5"
          />
        </div>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button onClick={submit} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
      </div>
    </div>
  );
}


function OverheadEditRow({
  entry, onSaved, onCancel,
}: {
  entry: OverheadEntry;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState<OverheadBody>({
    category: entry.category,
    description: entry.description,
    monthly_amount: entry.monthly_amount,
    active: entry.active,
  });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!body.category.trim()) { toast.error("Category required"); return; }
    setSaving(true);
    try {
      await api.updateOverhead(entry.id, body);
      toast.success("Saved");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <tr className="border-b bg-muted/20">
      <td className="px-2 py-1.5">
        <Input value={body.category} onChange={(e) => setBody({ ...body, category: e.target.value })} className="h-7 text-xs" />
      </td>
      <td className="px-2 py-1.5">
        <Input value={body.description} onChange={(e) => setBody({ ...body, description: e.target.value })} className="h-7 text-xs" />
      </td>
      <td className="px-2 py-1.5 text-right">
        <Input
          type="number"
          step="0.01"
          value={body.monthly_amount || ""}
          onChange={(e) => setBody({ ...body, monthly_amount: parseFloat(e.target.value) || 0 })}
          className="h-7 text-xs text-right"
        />
      </td>
      <td className="px-2 py-1.5">
        <label className="text-xs flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={body.active} onChange={(e) => setBody({ ...body, active: e.target.checked })} />
          Active
        </label>
      </td>
      <td className="px-2 py-1.5 text-right whitespace-nowrap">
        <button onClick={save} disabled={saving} className="text-emerald-600 hover:text-emerald-800 p-1" title="Save">
          <Check className="h-3.5 w-3.5" />
        </button>
        <button onClick={onCancel} className="text-muted-foreground hover:text-foreground p-1" title="Cancel">
          <X className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  );
}
