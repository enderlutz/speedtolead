import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  api, getCurrentUser,
  type AccountingSummary, type JobProfitabilityRow,
  type OverheadEntry, type OverheadBody,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { toast } from "sonner";
import {
  DollarSign, TrendingUp, Plus, Trash2, Pencil, Check, X, Calculator, Receipt, Users as UsersIcon, FileText,
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
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.getAccountingSummary(period).then(setSummary).catch(() => setSummary(null)),
      api.getJobProfitability(period).then((r) => setJobs(r.jobs)).catch(() => setJobs([])),
      api.listOverhead().then((r) => setOverhead(r.entries)).catch(() => setOverhead([])),
    ]).finally(() => setLoading(false));
  }, [period]);

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
                  <th className="px-2 py-1.5 font-medium text-right">Revenue</th>
                  <th className="px-2 py-1.5 font-medium text-right">Labor</th>
                  <th className="px-2 py-1.5 font-medium text-right">Reimb.</th>
                  <th className="px-2 py-1.5 font-medium text-right">Profit</th>
                  <th className="px-2 py-1.5 font-medium text-right">Margin</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => {
                  const isFocus = focusJobId && (j.scheduled_job_id === focusJobId || j.lead_id === focusJobId);
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
                      <td className="px-2 py-2 text-right font-medium">{formatCurrency(j.revenue)}</td>
                      <td className="px-2 py-2 text-right text-muted-foreground">{formatCurrency(j.labor_cost)}</td>
                      <td className="px-2 py-2 text-right text-muted-foreground">{formatCurrency(j.reimbursement_cost)}</td>
                      <td className={`px-2 py-2 text-right font-semibold ${
                        j.profit < 0 ? "text-red-600" : j.profit > 0 ? "text-emerald-700" : "text-muted-foreground"
                      }`}>{formatCurrency(j.profit)}</td>
                      <td className={`px-2 py-2 text-right text-xs ${
                        j.margin_pct < 20 ? "text-red-600" : j.margin_pct < 40 ? "text-amber-700" : "text-emerald-700"
                      }`}>{j.revenue > 0 ? `${j.margin_pct.toFixed(0)}%` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 font-semibold bg-muted/20">
                  <td colSpan={3} className="px-2 py-2 text-right text-xs text-muted-foreground">Totals</td>
                  <td className="px-2 py-2 text-right">{formatCurrency(jobs.reduce((a, j) => a + j.revenue, 0))}</td>
                  <td className="px-2 py-2 text-right">{formatCurrency(jobs.reduce((a, j) => a + j.labor_cost, 0))}</td>
                  <td className="px-2 py-2 text-right">{formatCurrency(jobs.reduce((a, j) => a + j.reimbursement_cost, 0))}</td>
                  <td className="px-2 py-2 text-right">{formatCurrency(jobs.reduce((a, j) => a + j.profit, 0))}</td>
                  <td className="px-2 py-2"></td>
                </tr>
              </tfoot>
            </table>
          )}
          <p className="text-[11px] text-muted-foreground mt-2">
            Click any row to open the lead. Margin is gross (revenue − labor − reimbursements);
            overhead is applied at the summary level above, not per-job.
          </p>
        </CardContent>
      </Card>

      {/* QuickBooks placeholder */}
      <Card className="border-dashed">
        <CardContent className="pt-4 flex items-center gap-3 flex-wrap text-sm">
          <span className="text-xs uppercase tracking-wide font-bold bg-muted px-2 py-1 rounded">Coming soon</span>
          <span className="text-muted-foreground">
            QuickBooks Online sync — push closed jobs as Sales Receipts and pull payments back into the dashboard.
          </span>
        </CardContent>
      </Card>
    </div>
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

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {tile("Revenue", formatCurrency(summary.revenue),
          `${summary.jobs_count} job${summary.jobs_count === 1 ? "" : "s"}`,
          "text-foreground",
          <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />)}
        {tile("Labor", formatCurrency(summary.labor_cost),
          summary.revenue > 0 ? `${(summary.labor_cost / summary.revenue * 100).toFixed(0)}% of rev` : "—",
          "text-muted-foreground",
          <UsersIcon className="h-3.5 w-3.5 text-muted-foreground" />)}
        {tile("Reimbursements", formatCurrency(summary.reimbursement_cost),
          summary.revenue > 0 ? `${(summary.reimbursement_cost / summary.revenue * 100).toFixed(0)}% of rev` : "—",
          "text-muted-foreground",
          <Receipt className="h-3.5 w-3.5 text-muted-foreground" />)}
        {tile("Overhead", formatCurrency(summary.overhead_cost),
          `${formatCurrency(summary.overhead_monthly)}/mo × ${summary.months_in_period}`,
          "text-muted-foreground",
          <Calculator className="h-3.5 w-3.5 text-muted-foreground" />)}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {tile("Gross Profit", formatCurrency(summary.gross_profit),
          `${fmtPct(summary.gross_margin_pct)} margin · before overhead`,
          summary.gross_profit < 0 ? "text-red-600" : "text-emerald-700",
          <TrendingUp className="h-3.5 w-3.5 text-emerald-700" />)}
        {tile("Net Profit", formatCurrency(summary.net_profit),
          `${fmtPct(summary.net_margin_pct)} margin · after overhead`,
          profitColor,
          <TrendingUp className={`h-3.5 w-3.5 ${profitColor}`} />)}
        {tile("Cost ratios", "—",
          `Labor + Reimb = ${formatCurrency(summary.labor_cost + summary.reimbursement_cost)}`,
          "text-muted-foreground")}
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
