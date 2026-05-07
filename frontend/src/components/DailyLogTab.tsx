import { useEffect, useMemo, useState, useCallback } from "react";
import {
  api, type Employee, type DayLog, type UnloggedJob, type SearchableCustomer,
  type TaskAllocationRow, type ReimbursementRow,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Search, Plus, Trash2, AlertTriangle, Receipt, Image as ImageIcon, Check, X,
} from "lucide-react";

const inputCls = "w-full border border-input rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring";

const todayCentralISO = (): string => {
  const now = new Date();
  const month = now.getUTCMonth() + 1;
  const isDst = month >= 3 && month <= 10;
  const offsetH = isDst ? -5 : -6;
  const central = new Date(now.getTime() + offsetH * 3600 * 1000);
  return central.toISOString().slice(0, 10);
};

interface Props {
  employees: Employee[];
  /** Optional initial state — used by the calendar quick-log to pre-fill */
  initialEmployeeId?: string;
  initialDate?: string;
  initialLeadId?: string;
}

export default function DailyLogTab({ employees, initialEmployeeId, initialDate, initialLeadId }: Props) {
  const [employeeId, setEmployeeId] = useState(initialEmployeeId || (employees[0]?.id ?? ""));
  const [date, setDate] = useState(initialDate || todayCentralISO());
  const [day, setDay] = useState<DayLog | null>(null);
  const [unlogged, setUnlogged] = useState<UnloggedJob[]>([]);
  const [allCustomers, setAllCustomers] = useState<SearchableCustomer[]>([]);
  const [taskNames, setTaskNames] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [pickedLeadId, setPickedLeadId] = useState<string>(initialLeadId || "");

  // New allocation form fields
  const [newTask, setNewTask] = useState("");
  const [newHours, setNewHours] = useState("");
  const [newNotes, setNewNotes] = useState("");

  // Day-total edit state
  const [editingDayTotal, setEditingDayTotal] = useState(false);
  const [dayTotalInput, setDayTotalInput] = useState("");

  // Reimbursement form
  const [reimbursements, setReimbursements] = useState<ReimbursementRow[]>([]);
  const [showReimbForm, setShowReimbForm] = useState(false);

  const loadAll = useCallback(() => {
    if (!employeeId) return;
    api.getDayLog(employeeId, date).then(setDay).catch(() => setDay(null));
    api.getCustomersToLog(employeeId)
      .then((r) => { setUnlogged(r.unlogged); setAllCustomers(r.all_customers); })
      .catch(() => {});
    api.listTaskNames().then((r) => setTaskNames(r.names.map((x) => x.name))).catch(() => {});
    api.listReimbursements({ employee_id: employeeId })
      .then((r) => setReimbursements(r.reimbursements))
      .catch(() => {});
  }, [employeeId, date]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Filtered customer search results
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [] as SearchableCustomer[];
    return allCustomers
      .filter((c) => c.name.toLowerCase().includes(q) || c.address.toLowerCase().includes(q))
      .slice(0, 8);
  }, [search, allCustomers]);

  const pickedCustomerLabel = useMemo(() => {
    if (!pickedLeadId) return "";
    const fromUnlogged = unlogged.find((u) => u.lead_id === pickedLeadId);
    if (fromUnlogged) return `${fromUnlogged.customer_name} · ${fromUnlogged.job_date}`;
    const fromAll = allCustomers.find((c) => c.lead_id === pickedLeadId);
    return fromAll ? fromAll.name : "";
  }, [pickedLeadId, unlogged, allCustomers]);

  const addAllocation = async () => {
    if (!pickedLeadId) { toast.error("Pick a customer first"); return; }
    if (!newTask.trim()) { toast.error("Task name is required"); return; }
    const hrs = parseFloat(newHours);
    if (!hrs || hrs <= 0) { toast.error("Hours must be > 0"); return; }
    try {
      await api.createAllocation({
        employee_id: employeeId,
        work_date: date,
        lead_id: pickedLeadId,
        task_name: newTask.trim(),
        hours: hrs,
        notes: newNotes,
      });
      setNewTask(""); setNewHours(""); setNewNotes("");
      loadAll();
      toast.success("Time logged");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to add");
    }
  };

  const deleteAllocation = async (id: string) => {
    if (!confirm("Delete this allocation?")) return;
    try {
      await api.deleteAllocation(id);
      loadAll();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  const updateAllocationField = async (id: string, field: "hours" | "task_name" | "notes", value: string | number) => {
    try {
      await api.updateAllocation(id, { [field]: value } as Partial<{ hours: number; task_name: string; notes: string }>);
      loadAll();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update");
    }
  };

  const saveDayTotal = async () => {
    const v = parseFloat(dayTotalInput);
    if (isNaN(v) || v < 0) { toast.error("Invalid hours"); return; }
    if (!day?.time_entry) {
      toast.error("Add a task allocation first to create the day's entry");
      return;
    }
    try {
      // Reuse the existing crew TimeEntry update endpoint
      await api.updateTimeEntry(day.time_entry.id, {
        employee_id: employeeId,
        work_date: date,
        hours: v,
        job_reference: day.time_entry.job_reference || "",
        notes: day.time_entry.notes || "",
      });
      setEditingDayTotal(false);
      loadAll();
      toast.success("Day total updated");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  return (
    <div className="space-y-4">
      {/* Header: employee + date pickers */}
      <Card>
        <CardContent className="pt-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-semibold text-muted-foreground">Employee</label>
              <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className={`${inputCls} mt-1`}>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>{e.display_name || `${e.first_name} ${e.last_name}`}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground">Date</label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1" />
            </div>
            <div className="flex items-end">
              {!editingDayTotal ? (
                <div className="text-sm">
                  <p className="text-xs text-muted-foreground">Day total</p>
                  <div className="flex items-center gap-2">
                    <p className="text-lg font-semibold">{day ? day.day_total.toFixed(1) : "—"}h</p>
                    <Button size="sm" variant="ghost" onClick={() => { setDayTotalInput(String(day?.day_total ?? 0)); setEditingDayTotal(true); }} disabled={!day?.time_entry}>
                      Edit
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Input type="number" step="0.25" value={dayTotalInput} onChange={(e) => setDayTotalInput(e.target.value)} className="w-24" />
                  <Button size="sm" onClick={saveDayTotal}>Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingDayTotal(false)}>Cancel</Button>
                </div>
              )}
            </div>
          </div>

          {day && day.time_entry && day.mismatch > 0.01 && (
            <div className="mt-3 flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-2.5 text-xs">
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="font-semibold text-amber-900">
                  Allocations don't match day total
                </p>
                <p className="text-amber-800">
                  Day total: {day.day_total.toFixed(2)}h · Allocations sum: {day.allocated_total.toFixed(2)}h · Off by {day.mismatch.toFixed(2)}h.
                  Reconcile when convenient.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Customer picker */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Pick a customer to log</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Unlogged backlog */}
          {unlogged.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground mb-1.5">
                Unlogged scheduled jobs (oldest first)
              </p>
              <div className="border rounded-md divide-y max-h-44 overflow-y-auto">
                {unlogged.map((u) => (
                  <button
                    key={u.scheduled_job_id}
                    onClick={() => { setPickedLeadId(u.lead_id); setDate(u.job_date); }}
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-muted flex items-center gap-2 ${
                      pickedLeadId === u.lead_id ? "bg-primary/5" : ""
                    }`}
                  >
                    <span className="font-mono text-xs text-muted-foreground w-20 shrink-0">{u.job_date}</span>
                    <span className="font-medium truncate flex-1">{u.customer_name}</span>
                    {u.address && <span className="text-xs text-muted-foreground truncate hidden sm:inline">{u.address}</span>}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Search */}
          <div>
            <p className="text-xs font-semibold text-muted-foreground mb-1.5">
              Or search a customer
            </p>
            <div className="relative">
              <Search className="h-3.5 w-3.5 text-muted-foreground absolute left-2.5 top-2.5" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or address"
                className="pl-8"
              />
            </div>
            {searchResults.length > 0 && (
              <div className="border rounded-md mt-1 divide-y max-h-44 overflow-y-auto">
                {searchResults.map((c) => (
                  <button
                    key={c.lead_id}
                    onClick={() => { setPickedLeadId(c.lead_id); setSearch(""); }}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-muted flex items-center gap-2"
                  >
                    <span className="font-medium truncate flex-1">{c.name}</span>
                    {c.address && <span className="text-xs text-muted-foreground truncate hidden sm:inline">{c.address}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Picked indicator */}
          {pickedLeadId && (
            <div className="flex items-center gap-2 rounded bg-primary/5 border border-primary/20 px-3 py-2 text-sm">
              <Badge className="bg-primary text-primary-foreground text-[10px]">Picked</Badge>
              <span className="font-medium flex-1 truncate">{pickedCustomerLabel}</span>
              <button onClick={() => setPickedLeadId("")} className="text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add allocation */}
      {pickedLeadId && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Log time for {pickedCustomerLabel}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="text-xs font-semibold text-muted-foreground">Task</label>
                <Input
                  list="task-names"
                  value={newTask}
                  onChange={(e) => setNewTask(e.target.value)}
                  placeholder="e.g. Driving, Staining, Cleanup"
                  className="mt-1"
                />
                <datalist id="task-names">
                  {taskNames.map((n) => <option key={n} value={n} />)}
                </datalist>
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground">Hours</label>
                <Input type="number" step="0.25" value={newHours} onChange={(e) => setNewHours(e.target.value)} placeholder="0.00" className="mt-1" />
              </div>
              <div className="flex items-end">
                <Button onClick={addAllocation} className="w-full">
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add task
                </Button>
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground">Notes (optional)</label>
              <Input value={newNotes} onChange={(e) => setNewNotes(e.target.value)} placeholder="Anything specific" className="mt-1" />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Existing allocations for this day */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">Today's allocations</CardTitle>
            {day && (
              <span className="text-xs text-muted-foreground">
                {day.allocated_total.toFixed(2)}h logged across {day.allocations.length} task{day.allocations.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {!day || day.allocations.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              Nothing logged yet. Pick a customer above to start.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="px-2 py-1.5 font-medium">Customer</th>
                  <th className="px-2 py-1.5 font-medium">Task</th>
                  <th className="px-2 py-1.5 font-medium text-right">Hours</th>
                  <th className="px-2 py-1.5 font-medium">Notes</th>
                  <th className="px-2 py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {day.allocations.map((a) => (
                  <AllocationRow
                    key={a.id}
                    a={a}
                    taskNames={taskNames}
                    onUpdate={updateAllocationField}
                    onDelete={() => deleteAllocation(a.id)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Reimbursements */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Receipt className="h-4 w-4 text-muted-foreground" /> Reimbursements
            </CardTitle>
            <Button size="sm" variant="outline" onClick={() => setShowReimbForm(!showReimbForm)}>
              <Plus className="h-3.5 w-3.5 mr-1" /> New
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {showReimbForm && (
            <ReimbursementForm
              employeeId={employeeId}
              defaultLeadId={pickedLeadId}
              defaultDate={date}
              allCustomers={allCustomers}
              onClose={() => setShowReimbForm(false)}
              onSaved={() => { setShowReimbForm(false); loadAll(); }}
            />
          )}
          <ReimbursementList
            rows={reimbursements}
            onChange={loadAll}
          />
        </CardContent>
      </Card>
    </div>
  );
}


function AllocationRow({
  a, taskNames, onUpdate, onDelete,
}: {
  a: TaskAllocationRow & { customer_name: string };
  taskNames: string[];
  onUpdate: (id: string, field: "hours" | "task_name" | "notes", value: string | number) => void;
  onDelete: () => void;
}) {
  const [hoursInput, setHoursInput] = useState(String(a.hours));
  const [taskInput, setTaskInput] = useState(a.task_name);
  const [notesInput, setNotesInput] = useState(a.notes || "");

  return (
    <tr className="border-b hover:bg-muted/30">
      <td className="px-2 py-1.5 truncate max-w-[160px]">{a.customer_name}</td>
      <td className="px-2 py-1.5">
        <input
          list={`task-names-${a.id}`}
          value={taskInput}
          onChange={(e) => setTaskInput(e.target.value)}
          onBlur={() => { if (taskInput.trim() && taskInput !== a.task_name) onUpdate(a.id, "task_name", taskInput.trim()); }}
          className="bg-transparent w-full focus:outline-none focus:ring-1 focus:ring-ring rounded px-1"
        />
        <datalist id={`task-names-${a.id}`}>
          {taskNames.map((n) => <option key={n} value={n} />)}
        </datalist>
      </td>
      <td className="px-2 py-1.5 text-right">
        <input
          type="number"
          step="0.25"
          value={hoursInput}
          onChange={(e) => setHoursInput(e.target.value)}
          onBlur={() => {
            const v = parseFloat(hoursInput);
            if (!isNaN(v) && v > 0 && v !== a.hours) onUpdate(a.id, "hours", v);
          }}
          className="bg-transparent w-16 text-right focus:outline-none focus:ring-1 focus:ring-ring rounded px-1"
        />
      </td>
      <td className="px-2 py-1.5">
        <input
          value={notesInput}
          onChange={(e) => setNotesInput(e.target.value)}
          onBlur={() => { if (notesInput !== a.notes) onUpdate(a.id, "notes", notesInput); }}
          className="bg-transparent w-full focus:outline-none focus:ring-1 focus:ring-ring rounded px-1 text-muted-foreground"
        />
      </td>
      <td className="px-2 py-1.5 text-right">
        <button onClick={onDelete} className="text-red-500 hover:text-red-700">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  );
}


function ReimbursementForm({
  employeeId, defaultLeadId, defaultDate, allCustomers, onClose, onSaved,
}: {
  employeeId: string;
  defaultLeadId: string;
  defaultDate: string;
  allCustomers: SearchableCustomer[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [leadId, setLeadId] = useState(defaultLeadId || "");
  const [expenseDate, setExpenseDate] = useState(defaultDate || todayCentralISO());
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!leadId) { toast.error("Pick a customer"); return; }
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { toast.error("Amount must be > 0"); return; }
    if (!file) { toast.error("Receipt photo is required"); return; }
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append("employee_id", employeeId);
      fd.append("lead_id", leadId);
      fd.append("expense_date", expenseDate);
      fd.append("amount", String(amt));
      fd.append("description", description);
      fd.append("notes", notes);
      fd.append("receipt", file);
      await api.uploadReimbursement(fd);
      toast.success("Reimbursement submitted (pending admin confirmation)");
      onSaved();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to submit");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border rounded-lg p-3 space-y-3 bg-muted/20">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-semibold text-muted-foreground">Customer</label>
          <select value={leadId} onChange={(e) => setLeadId(e.target.value)} className={`${inputCls} mt-1`}>
            <option value="">— pick —</option>
            {allCustomers.map((c) => (
              <option key={c.lead_id} value={c.lead_id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold text-muted-foreground">Date paid</label>
          <Input type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} className="mt-1" />
        </div>
        <div>
          <label className="text-xs font-semibold text-muted-foreground">Amount ($)</label>
          <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className="mt-1" />
        </div>
        <div>
          <label className="text-xs font-semibold text-muted-foreground">Description</label>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What was bought" className="mt-1" />
        </div>
      </div>
      <div>
        <label className="text-xs font-semibold text-muted-foreground">Notes (optional)</label>
        <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything Alan should know" className="mt-1" />
      </div>
      <div>
        <label className="text-xs font-semibold text-muted-foreground">Receipt photo (required)</label>
        <Input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} className="mt-1" />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={submit} disabled={saving}>{saving ? "Uploading…" : "Submit"}</Button>
      </div>
    </div>
  );
}


function ReimbursementList({ rows, onChange }: { rows: ReimbursementRow[]; onChange: () => void }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground text-center py-3">No reimbursements yet.</p>;
  }

  const setStatus = async (id: string, status: "approved" | "rejected") => {
    try {
      await api.updateReimbursement(id, { status });
      toast.success(`Marked ${status}`);
      onChange();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this reimbursement?")) return;
    try {
      await api.deleteReimbursement(id);
      onChange();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground border-b">
            <th className="px-2 py-1.5 font-medium">Date</th>
            <th className="px-2 py-1.5 font-medium">Customer</th>
            <th className="px-2 py-1.5 font-medium">Description</th>
            <th className="px-2 py-1.5 font-medium text-right">Amount</th>
            <th className="px-2 py-1.5 font-medium">Status</th>
            <th className="px-2 py-1.5"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b hover:bg-muted/30">
              <td className="px-2 py-1.5 font-mono text-xs">{r.expense_date}</td>
              <td className="px-2 py-1.5 truncate max-w-[140px]">{r.customer_name}</td>
              <td className="px-2 py-1.5 truncate max-w-[200px]">{r.description || <span className="text-muted-foreground italic">—</span>}</td>
              <td className="px-2 py-1.5 text-right font-semibold">${r.amount.toFixed(2)}</td>
              <td className="px-2 py-1.5">
                {r.status === "approved" ? (
                  <Badge className="bg-emerald-100 text-emerald-800 text-[10px]">Approved</Badge>
                ) : r.status === "rejected" ? (
                  <Badge className="bg-red-100 text-red-800 text-[10px]">Rejected</Badge>
                ) : (
                  <Badge className="bg-amber-100 text-amber-800 text-[10px]">Pending</Badge>
                )}
              </td>
              <td className="px-2 py-1.5 text-right">
                <div className="inline-flex gap-1">
                  {r.receipt_uploaded && (
                    <a href={api.getReceiptUrl(r.id)} target="_blank" rel="noreferrer" title="View receipt" className="text-primary hover:underline">
                      <ImageIcon className="h-3.5 w-3.5" />
                    </a>
                  )}
                  {r.status === "pending" && (
                    <>
                      <button onClick={() => setStatus(r.id, "approved")} title="Approve" className="text-emerald-600 hover:text-emerald-800">
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => setStatus(r.id, "rejected")} title="Reject" className="text-red-500 hover:text-red-700">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                  <button onClick={() => remove(r.id)} title="Delete" className="text-muted-foreground hover:text-red-700">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
