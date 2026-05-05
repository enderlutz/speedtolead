import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Employee, type RangeTotals, type LifetimeTotals, getCurrentUser } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { toast } from "sonner";
import { HardHat, Plus, Clock, DollarSign, AlertTriangle, Download, FileText, Eye } from "lucide-react";
import { LogHoursModal, RecordPaymentModal, AddEmployeeModal } from "@/components/CrewModals";

type RangeKey = "this_week" | "last_week" | "month" | "ytd";
const RANGE_LABELS: Record<RangeKey, string> = {
  this_week: "This Week",
  last_week: "Last Week",
  month: "Month to Date",
  ytd: "Year to Date",
};

type EmployeeRow = Employee & { range_totals: RangeTotals; lifetime: LifetimeTotals };

export default function Crew() {
  const navigate = useNavigate();
  const user = getCurrentUser();
  const [range, setRange] = useState<RangeKey>("this_week");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [rangeBounds, setRangeBounds] = useState<{ start: string; end: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [showLogHours, setShowLogHours] = useState(false);
  const [showPayment, setShowPayment] = useState(false);
  const [w9Banner, setW9Banner] = useState<{ count: number; missing30d: number } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api.listCrew(range, includeInactive)
      .then((r) => {
        setEmployees(r.employees);
        setRangeBounds({ start: r.start, end: r.end });
      })
      .catch(() => toast.error("Failed to load crew"))
      .finally(() => setLoading(false));
    api.getCrewSummary()
      .then((s) => setW9Banner({ count: s.w9_missing_count, missing30d: s.w9_missing_30d_count }))
      .catch(() => {});
  }, [range, includeInactive]);

  useEffect(() => { load(); }, [load]);

  // Owner-walled route — render nothing for non-admins (in case the sidebar is bypassed)
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
    <div className="p-4 sm:p-6 space-y-4 max-w-6xl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight flex items-center gap-2">
            <HardHat className="h-5 w-5 text-primary" /> Crew
          </h1>
          <p className="text-sm text-muted-foreground">Time, pay, and 1099 prep · owner-only</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => window.open(api.getRosterExportUrl(), "_blank")}>
            <Download className="h-3.5 w-3.5 mr-1" /> Roster CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowLogHours(true)}>
            <Clock className="h-3.5 w-3.5 mr-1" /> Log Hours
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowPayment(true)}>
            <DollarSign className="h-3.5 w-3.5 mr-1" /> Record Payment
          </Button>
          <Button size="sm" onClick={() => setShowAdd(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add Employee
          </Button>
        </div>
      </div>

      {w9Banner && w9Banner.missing30d > 0 && (
        <div className="rounded-lg border-2 border-amber-300 bg-amber-50 p-3 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
          <div className="text-sm flex-1">
            <strong>{w9Banner.missing30d}</strong> employee{w9Banner.missing30d === 1 ? "" : "s"} ha{w9Banner.missing30d === 1 ? "s" : "ve"} been on the crew for 30+ days without a W9 on file. Collect before year-end to issue 1099s.
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap border-b">
        {(Object.keys(RANGE_LABELS) as RangeKey[]).map((k) => (
          <button
            key={k}
            onClick={() => setRange(k)}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              range === k ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {RANGE_LABELS[k]}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 pb-1">
          <label className="text-xs text-muted-foreground flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
            Show inactive
          </label>
        </div>
      </div>

      {rangeBounds && (
        <p className="text-xs text-muted-foreground">
          {RANGE_LABELS[range]}: {rangeBounds.start} → {rangeBounds.end}
        </p>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Roster</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {loading ? (
            <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-12 bg-muted rounded animate-pulse" />)}</div>
          ) : employees.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No employees yet. Click "Add Employee" to get started.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Role</th>
                  <th className="px-3 py-2 font-medium text-right">Rate</th>
                  <th className="px-3 py-2 font-medium text-right">Hours</th>
                  <th className="px-3 py-2 font-medium text-right">Earned</th>
                  <th className="px-3 py-2 font-medium text-right">Paid</th>
                  <th className="px-3 py-2 font-medium text-right">Balance</th>
                  <th className="px-3 py-2 font-medium">W9</th>
                  <th className="px-3 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {employees.map((e) => (
                  <tr
                    key={e.id}
                    onClick={() => navigate(`/crew/${e.id}`)}
                    className={`border-b hover:bg-muted/30 cursor-pointer ${e.status === "inactive" ? "opacity-50" : ""}`}
                  >
                    <td className="px-3 py-2.5 font-medium">{e.display_name || `${e.first_name} ${e.last_name}`}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">{e.role || "—"}</td>
                    <td className="px-3 py-2.5 text-right">${e.pay_rate.toFixed(2)}/hr</td>
                    <td className="px-3 py-2.5 text-right">{e.range_totals.hours.toFixed(1)}</td>
                    <td className="px-3 py-2.5 text-right">{formatCurrency(e.range_totals.earned)}</td>
                    <td className="px-3 py-2.5 text-right">{formatCurrency(e.range_totals.paid)}</td>
                    <td className={`px-3 py-2.5 text-right font-semibold ${e.lifetime.unpaid_balance < 0 ? "text-red-600" : e.lifetime.unpaid_balance > 0 ? "text-amber-700" : "text-muted-foreground"}`}>
                      {formatCurrency(e.lifetime.unpaid_balance)}
                    </td>
                    <td className="px-3 py-2.5">
                      {e.w9_uploaded ? (
                        <Badge className="bg-green-100 text-green-800 text-[10px]">✓</Badge>
                      ) : (
                        <Badge className="bg-amber-100 text-amber-800 text-[10px]">⚠ Missing</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" /> Roster totals ({RANGE_LABELS[range]})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Hours</p>
              <p className="text-lg font-semibold">{employees.reduce((a, e) => a + e.range_totals.hours, 0).toFixed(1)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Earned</p>
              <p className="text-lg font-semibold">{formatCurrency(employees.reduce((a, e) => a + e.range_totals.earned, 0))}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Paid</p>
              <p className="text-lg font-semibold">{formatCurrency(employees.reduce((a, e) => a + e.range_totals.paid, 0))}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total Unpaid (lifetime)</p>
              <p className="text-lg font-semibold text-amber-700">{formatCurrency(employees.reduce((a, e) => a + e.lifetime.unpaid_balance, 0))}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {showAdd && (
        <AddEmployeeModal
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); load(); }}
        />
      )}
      {showLogHours && (
        <LogHoursModal
          employees={employees.filter((e) => e.status === "active")}
          onClose={() => setShowLogHours(false)}
          onSaved={() => { setShowLogHours(false); load(); }}
        />
      )}
      {showPayment && (
        <RecordPaymentModal
          employees={employees.filter((e) => e.status === "active")}
          onClose={() => setShowPayment(false)}
          onSaved={() => { setShowPayment(false); load(); }}
        />
      )}
    </div>
  );
}
