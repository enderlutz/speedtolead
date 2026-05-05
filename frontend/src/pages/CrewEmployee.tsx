import { useEffect, useState, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { api, type Employee, type RangeTotals, type LifetimeTotals, type TimeEntry, type Payment, getCurrentUser } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatCurrency, formatDate } from "@/lib/utils";
import { toast } from "sonner";
import {
  ArrowLeft, Pencil, Upload, FileText, Clock, DollarSign, Plus, Trash2, Download, ChevronDown, ChevronUp,
} from "lucide-react";
import { LogHoursModal, RecordPaymentModal, AddEmployeeModal } from "@/components/CrewModals";

type EmployeeFull = Employee & { this_week: RangeTotals; last_week: RangeTotals; month: RangeTotals; ytd: RangeTotals; lifetime: LifetimeTotals };
type SummaryRange = "this_week" | "ytd";

export default function CrewEmployee() {
  const { id } = useParams<{ id: string }>();
  const user = getCurrentUser();
  const [emp, setEmp] = useState<EmployeeFull | null>(null);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingRate, setEditingRate] = useState(false);
  const [newRate, setNewRate] = useState("");
  const [savingRate, setSavingRate] = useState(false);
  const [summaryRange, setSummaryRange] = useState<SummaryRange>("this_week");
  const [showLogHours, setShowLogHours] = useState(false);
  const [showPayment, setShowPayment] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [show1099, setShow1099] = useState(false);
  const [taxYear, setTaxYear] = useState<number>(new Date().getFullYear());
  const [yearTimeEntries, setYearTimeEntries] = useState<TimeEntry[]>([]);
  const [yearPayments, setYearPayments] = useState<Payment[]>([]);

  const load = useCallback(() => {
    if (!id) return;
    setLoading(true);
    Promise.all([
      api.getEmployee(id),
      api.listTimeEntries(id),
      api.listPayments(id),
    ])
      .then(([e, t, p]) => { setEmp(e); setTimeEntries(t); setPayments(p); })
      .catch(() => toast.error("Failed to load employee"))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!id || !show1099) return;
    Promise.all([
      api.listTimeEntries(id, taxYear),
      api.listPayments(id, taxYear),
    ]).then(([t, p]) => { setYearTimeEntries(t); setYearPayments(p); });
  }, [id, show1099, taxYear]);

  if (user?.role !== "admin") {
    return <div className="p-6 text-sm text-muted-foreground">Owner-only.</div>;
  }
  if (loading) {
    return <div className="p-6"><div className="h-32 bg-muted rounded animate-pulse" /></div>;
  }
  if (!emp) {
    return <div className="p-6 text-sm text-muted-foreground">Employee not found.</div>;
  }

  const summary = summaryRange === "this_week" ? emp.this_week : emp.ytd;

  const handleRateSave = async () => {
    const r = parseFloat(newRate);
    if (!r || r <= 0) { toast.error("Rate must be greater than 0"); return; }
    setSavingRate(true);
    try {
      await api.updateEmployee(emp.id, {
        first_name: emp.first_name, last_name: emp.last_name, display_name: emp.display_name,
        role: emp.role, pay_type: emp.pay_type, pay_rate: r,
        phone: emp.phone, email: emp.email, address: emp.address,
        start_date: emp.start_date, status: emp.status, notes: emp.notes,
      });
      toast.success("Rate updated. Future hours use the new rate; past entries keep their original rate.");
      setEditingRate(false);
      load();
    } catch (e: any) {
      toast.error(e?.message || "Update failed");
    } finally {
      setSavingRate(false);
    }
  };

  const handleW9Upload = async (file: File) => {
    try {
      await api.uploadW9(emp.id, file);
      toast.success("W9 uploaded");
      load();
    } catch (e: any) {
      toast.error(e?.message || "Upload failed");
    }
  };

  const handleStatusToggle = async () => {
    const next = emp.status === "active" ? "inactive" : "active";
    if (next === "inactive" && !confirm("Deactivate this employee? Their history stays — they just stop appearing in active rosters.")) return;
    try {
      await api.setEmployeeStatus(emp.id, next);
      toast.success(`Set to ${next}`);
      load();
    } catch (e: any) {
      toast.error(e?.message || "Failed");
    }
  };

  const handleDeleteTime = async (te: TimeEntry) => {
    if (!confirm(`Delete ${te.hours}h on ${te.work_date}?`)) return;
    try { await api.deleteTimeEntry(te.id); toast.success("Deleted"); load(); }
    catch { toast.error("Delete failed"); }
  };

  const handleDeletePayment = async (p: Payment) => {
    if (!confirm(`Delete payment of $${p.total_paid.toFixed(2)} on ${p.payment_date}?`)) return;
    try { await api.deletePayment(p.id); toast.success("Deleted"); load(); }
    catch { toast.error("Delete failed"); }
  };

  const yearList = Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - i);

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-5xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link to="/crew" className="text-muted-foreground hover:text-foreground"><ArrowLeft className="h-5 w-5" /></Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight truncate">{emp.display_name || `${emp.first_name} ${emp.last_name}`}</h1>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <Badge variant="outline" className="text-xs">{emp.role || "—"}</Badge>
            <Badge className={`text-xs ${emp.status === "active" ? "bg-green-100 text-green-800" : "bg-muted text-muted-foreground"}`}>{emp.status}</Badge>
            {emp.w9_missing ? (
              <Badge className="text-xs bg-amber-100 text-amber-800">⚠ W9 Missing</Badge>
            ) : emp.w9_uploaded ? (
              <Badge className="text-xs bg-green-100 text-green-800">✓ W9</Badge>
            ) : null}
          </div>
        </div>
        <div className="flex gap-2 shrink-0 flex-wrap justify-end">
          <Button variant="outline" size="sm" onClick={() => setShowEdit(true)}><Pencil className="h-3.5 w-3.5 mr-1" /> Edit</Button>
          <Button variant="outline" size="sm" onClick={handleStatusToggle}>
            {emp.status === "active" ? "Deactivate" : "Reactivate"}
          </Button>
        </div>
      </div>

      {/* Contact + rate row */}
      <Card>
        <CardContent className="pt-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Pay Rate</p>
              {editingRate ? (
                <div className="flex items-center gap-1 mt-1">
                  <Input type="number" step="0.25" value={newRate} onChange={(e) => setNewRate(e.target.value)} className="h-7 text-sm" />
                  <Button size="sm" className="h-7 px-2 text-xs" onClick={handleRateSave} disabled={savingRate}>Save</Button>
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setEditingRate(false)}>Cancel</Button>
                </div>
              ) : (
                <p className="font-semibold flex items-center gap-1.5">
                  ${emp.pay_rate.toFixed(2)}/hr
                  <button onClick={() => { setNewRate(String(emp.pay_rate)); setEditingRate(true); }} className="text-muted-foreground hover:text-foreground">
                    <Pencil className="h-3 w-3" />
                  </button>
                </p>
              )}
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Phone</p>
              <p className="text-sm">{emp.phone || "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Email</p>
              <p className="text-sm truncate">{emp.email || "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Start Date</p>
              <p className="text-sm">{emp.start_date || "—"}</p>
            </div>
          </div>
          {emp.address && (
            <p className="text-xs text-muted-foreground mt-3">{emp.address}</p>
          )}
        </CardContent>
      </Card>

      {/* W9 card */}
      <Card className={emp.w9_missing ? "border-amber-300 bg-amber-50/50" : ""}>
        <CardContent className="pt-4 flex items-center gap-3 flex-wrap">
          <FileText className="h-5 w-5 text-muted-foreground" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">W9</p>
            <p className="text-xs text-muted-foreground">
              {emp.w9_uploaded
                ? `${emp.w9_file_name} · uploaded ${formatDate(emp.w9_uploaded_at || "")}`
                : "Not on file. Required to issue a 1099 at year-end."}
            </p>
          </div>
          {emp.w9_uploaded && (
            <Button variant="outline" size="sm" onClick={() => window.open(api.getW9Url(emp.id), "_blank")}>
              View
            </Button>
          )}
          <label className="text-xs cursor-pointer">
            <input type="file" accept=".pdf,image/*" className="hidden" onChange={(e) => e.target.files?.[0] && handleW9Upload(e.target.files[0])} />
            <span className="inline-flex items-center justify-center rounded-md border bg-background hover:bg-muted/50 px-3 py-1.5 text-xs">
              <Upload className="h-3 w-3 mr-1" /> {emp.w9_uploaded ? "Replace" : "Upload"}
            </span>
          </label>
        </CardContent>
      </Card>

      {/* Summary cards */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">Summary</CardTitle>
            <div className="flex gap-1">
              <button
                onClick={() => setSummaryRange("this_week")}
                className={`text-xs px-2 py-1 rounded border ${summaryRange === "this_week" ? "bg-primary text-primary-foreground border-primary" : "border-border"}`}
              >
                This Week
              </button>
              <button
                onClick={() => setSummaryRange("ytd")}
                className={`text-xs px-2 py-1 rounded border ${summaryRange === "ytd" ? "bg-primary text-primary-foreground border-primary" : "border-border"}`}
              >
                Year to Date
              </button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-muted-foreground">Hours</p>
              <p className="text-2xl font-bold">{summary.hours.toFixed(1)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Earned</p>
              <p className="text-2xl font-bold">{formatCurrency(summary.earned)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Paid</p>
              <p className="text-2xl font-bold">{formatCurrency(summary.paid)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Unpaid Balance (lifetime)</p>
              <p className={`text-2xl font-bold ${emp.lifetime.unpaid_balance < 0 ? "text-red-600" : emp.lifetime.unpaid_balance > 0 ? "text-amber-700" : "text-muted-foreground"}`}>
                {formatCurrency(emp.lifetime.unpaid_balance)}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Time entries */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2"><Clock className="h-4 w-4 text-primary" /> Time Entries</CardTitle>
            <Button size="sm" onClick={() => setShowLogHours(true)}><Plus className="h-3.5 w-3.5 mr-1" /> Log Hours</Button>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {timeEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No time entries yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="px-2 py-1.5">Date</th>
                  <th className="px-2 py-1.5 text-right">Hours</th>
                  <th className="px-2 py-1.5 text-right">Rate</th>
                  <th className="px-2 py-1.5 text-right">Earnings</th>
                  <th className="px-2 py-1.5">Job / Notes</th>
                  <th className="px-2 py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {timeEntries.map((t) => (
                  <tr key={t.id} className="border-b">
                    <td className="px-2 py-1.5">{t.work_date}</td>
                    <td className="px-2 py-1.5 text-right">{t.hours.toFixed(1)}</td>
                    <td className="px-2 py-1.5 text-right text-muted-foreground">${t.rate_at_entry.toFixed(2)}</td>
                    <td className="px-2 py-1.5 text-right font-medium">{formatCurrency(t.earnings)}</td>
                    <td className="px-2 py-1.5 text-xs text-muted-foreground">
                      {t.job_reference && <span>{t.job_reference}</span>}
                      {t.job_reference && t.notes && <span> · </span>}
                      {t.notes && <span className="italic">{t.notes}</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <button onClick={() => handleDeleteTime(t)} className="text-muted-foreground hover:text-red-600 p-1">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Payments */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2"><DollarSign className="h-4 w-4 text-primary" /> Payments</CardTitle>
            <Button size="sm" onClick={() => setShowPayment(true)}><Plus className="h-3.5 w-3.5 mr-1" /> Record Payment</Button>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {payments.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No payments yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="px-2 py-1.5">Date</th>
                  <th className="px-2 py-1.5 text-right">Total</th>
                  <th className="px-2 py-1.5">Breakdown</th>
                  <th className="px-2 py-1.5">Method</th>
                  <th className="px-2 py-1.5">Notes</th>
                  <th className="px-2 py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id} className="border-b">
                    <td className="px-2 py-1.5">{p.payment_date}</td>
                    <td className="px-2 py-1.5 text-right font-semibold">{formatCurrency(p.total_paid)}</td>
                    <td className="px-2 py-1.5 text-xs text-muted-foreground">
                      {p.wage_amount > 0 && <span>W: ${p.wage_amount.toFixed(2)}</span>}
                      {p.reimbursement_amount > 0 && <span> · R: ${p.reimbursement_amount.toFixed(2)}</span>}
                      {p.bonus_amount > 0 && <span> · B: ${p.bonus_amount.toFixed(2)}</span>}
                    </td>
                    <td className="px-2 py-1.5 text-xs capitalize">
                      {p.payment_method === "other" ? `Other (${p.payment_method_other})` : p.payment_method}
                    </td>
                    <td className="px-2 py-1.5 text-xs text-muted-foreground italic">{p.notes}</td>
                    <td className="px-2 py-1.5 text-right">
                      <button onClick={() => handleDeletePayment(p)} className="text-muted-foreground hover:text-red-600 p-1">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* 1099 prep */}
      <Card>
        <CardHeader className="pb-2 cursor-pointer" onClick={() => setShow1099((v) => !v)}>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2"><FileText className="h-4 w-4 text-muted-foreground" /> 1099 Prep</CardTitle>
            {show1099 ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </div>
        </CardHeader>
        {show1099 && (
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <label className="text-xs text-muted-foreground">Tax Year:</label>
              <select className="border rounded px-2 py-1 text-sm bg-background" value={taxYear} onChange={(e) => setTaxYear(parseInt(e.target.value))}>
                {yearList.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
              <Button variant="outline" size="sm" onClick={() => window.open(api.getEmployeeYtdExportUrl(emp.id, taxYear), "_blank")}>
                <Download className="h-3.5 w-3.5 mr-1" /> Export {taxYear} CSV
              </Button>
            </div>
            <YearSummary timeEntries={yearTimeEntries} payments={yearPayments} year={taxYear} w9Uploaded={emp.w9_uploaded} />
          </CardContent>
        )}
      </Card>

      {showLogHours && (
        <LogHoursModal
          employees={[emp]}
          defaultEmployeeId={emp.id}
          onClose={() => setShowLogHours(false)}
          onSaved={() => { setShowLogHours(false); load(); }}
        />
      )}
      {showPayment && (
        <RecordPaymentModal
          employees={[emp]}
          defaultEmployeeId={emp.id}
          onClose={() => setShowPayment(false)}
          onSaved={() => { setShowPayment(false); load(); }}
        />
      )}
      {showEdit && (
        <AddEmployeeModal
          existing={emp}
          onClose={() => setShowEdit(false)}
          onSaved={() => { setShowEdit(false); load(); }}
        />
      )}
    </div>
  );
}


function YearSummary({ timeEntries, payments, year, w9Uploaded }: {
  timeEntries: TimeEntry[];
  payments: Payment[];
  year: number;
  w9Uploaded: boolean;
}) {
  const totalHours = timeEntries.reduce((a, t) => a + t.hours, 0);
  const totalEarned = timeEntries.reduce((a, t) => a + t.earnings, 0);
  const wage = payments.reduce((a, p) => a + p.wage_amount, 0);
  const reimb = payments.reduce((a, p) => a + p.reimbursement_amount, 0);
  const bonus = payments.reduce((a, p) => a + p.bonus_amount, 0);
  const totalPaid = wage + reimb + bonus;

  return (
    <div className="space-y-2 text-sm">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div><p className="text-xs text-muted-foreground">Hours ({year})</p><p className="font-semibold">{totalHours.toFixed(1)}</p></div>
        <div><p className="text-xs text-muted-foreground">Earned ({year})</p><p className="font-semibold">{formatCurrency(totalEarned)}</p></div>
        <div><p className="text-xs text-muted-foreground">Paid ({year})</p><p className="font-semibold">{formatCurrency(totalPaid)}</p></div>
        <div>
          <p className="text-xs text-muted-foreground">1099 Total</p>
          <p className="font-semibold text-primary">{formatCurrency(totalPaid)}</p>
        </div>
      </div>
      <div className="text-xs text-muted-foreground border-l-2 border-muted pl-3 space-y-0.5">
        <p>Wages: {formatCurrency(wage)}</p>
        <p>Reimbursements: {formatCurrency(reimb)}</p>
        <p>Bonuses/Tips: {formatCurrency(bonus)}</p>
      </div>
      {!w9Uploaded && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
          ⚠ Cannot issue 1099 without a W9 on file. Upload one above.
        </p>
      )}
    </div>
  );
}
