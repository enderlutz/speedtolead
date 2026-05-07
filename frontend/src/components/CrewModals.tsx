import { useMemo, useState } from "react";
import { api, type Employee, type EmployeeBody, type PaymentMethod, type TimeEntry, type Payment } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { X, Loader2 } from "lucide-react";
import CustomerSearchPicker from "@/components/CustomerSearchPicker";

const inputCls = "w-full border border-input rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring";
const selectCls = inputCls;
const labelCls = "text-xs font-semibold text-muted-foreground";

const todayCentralISO = (): string => {
  // Approximate Central Time today; close enough for UI defaulting.
  const now = new Date();
  const month = now.getUTCMonth() + 1;
  const isDst = month >= 3 && month <= 10;
  const offsetH = isDst ? -5 : -6;
  const central = new Date(now.getTime() + offsetH * 3600 * 1000);
  return central.toISOString().slice(0, 10);
};

function ModalShell({ title, onClose, children, footer }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-background rounded-lg shadow-xl w-full max-w-lg max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">{children}</div>
        {footer && <div className="p-4 border-t flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

// ─── Add / Edit Employee ────────────────────────────────────────────────

export function AddEmployeeModal({
  existing, onClose, onSaved,
}: {
  existing?: Employee;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [body, setBody] = useState<EmployeeBody>({
    first_name: existing?.first_name || "",
    last_name: existing?.last_name || "",
    display_name: existing?.display_name || "",
    role: existing?.role || "",
    pay_type: existing?.pay_type || "hourly",
    pay_rate: existing?.pay_rate ?? 0,
    phone: existing?.phone || "",
    email: existing?.email || "",
    address: existing?.address || "",
    start_date: existing?.start_date || todayCentralISO(),
    status: existing?.status || "active",
    notes: existing?.notes || "",
  });
  const [w9File, setW9File] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!body.first_name.trim() || !body.last_name.trim()) {
      toast.error("First and last name are required");
      return;
    }
    if (body.pay_rate <= 0) {
      toast.error("Pay rate must be greater than 0");
      return;
    }
    setSaving(true);
    try {
      const saved = existing
        ? await api.updateEmployee(existing.id, body)
        : await api.createEmployee(body);
      if (w9File) {
        try { await api.uploadW9(saved.id, w9File); }
        catch { toast.error("Saved employee but W9 upload failed"); }
      }
      toast.success(existing ? "Employee updated" : "Employee added");
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell
      title={existing ? "Edit Employee" : "Add Employee"}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
            {saving ? "Saving..." : existing ? "Save Changes" : "Add Employee"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>First Name *</label>
          <Input value={body.first_name} onChange={(e) => setBody({ ...body, first_name: e.target.value })} />
        </div>
        <div>
          <label className={labelCls}>Last Name *</label>
          <Input value={body.last_name} onChange={(e) => setBody({ ...body, last_name: e.target.value })} />
        </div>
      </div>
      <div>
        <label className={labelCls}>Display Name (shown in UI)</label>
        <Input value={body.display_name} onChange={(e) => setBody({ ...body, display_name: e.target.value })} placeholder='e.g. "Brett" or "Hernandez"' />
      </div>
      <div>
        <label className={labelCls}>Role</label>
        <Input value={body.role} onChange={(e) => setBody({ ...body, role: e.target.value })} placeholder="Stainer / Lead / Helper" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Pay Type</label>
          <select className={selectCls} value={body.pay_type} onChange={(e) => setBody({ ...body, pay_type: e.target.value as EmployeeBody["pay_type"] })}>
            <option value="hourly">Hourly</option>
            {/* Other pay types deliberately disabled in V1 */}
          </select>
        </div>
        <div>
          <label className={labelCls}>Pay Rate ($/hr) *</label>
          <Input type="number" step="0.25" min="0" value={body.pay_rate} onChange={(e) => setBody({ ...body, pay_rate: parseFloat(e.target.value) || 0 })} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Phone</label>
          <Input value={body.phone} onChange={(e) => setBody({ ...body, phone: e.target.value })} />
        </div>
        <div>
          <label className={labelCls}>Email</label>
          <Input type="email" value={body.email} onChange={(e) => setBody({ ...body, email: e.target.value })} />
        </div>
      </div>
      <div>
        <label className={labelCls}>Address</label>
        <Input value={body.address} onChange={(e) => setBody({ ...body, address: e.target.value })} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Start Date</label>
          <Input type="date" value={body.start_date} onChange={(e) => setBody({ ...body, start_date: e.target.value })} />
        </div>
        <div>
          <label className={labelCls}>Status</label>
          <select className={selectCls} value={body.status} onChange={(e) => setBody({ ...body, status: e.target.value as "active" | "inactive" })}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
      </div>
      <div>
        <label className={labelCls}>W9 File (PDF or image, max 10MB)</label>
        <Input type="file" accept=".pdf,image/*" onChange={(e) => setW9File(e.target.files?.[0] || null)} />
        {existing?.w9_uploaded && !w9File && (
          <p className="text-xs text-muted-foreground mt-1">Current: {existing.w9_file_name}. Upload a new file to replace it.</p>
        )}
      </div>
      <div>
        <label className={labelCls}>Notes</label>
        <textarea className={inputCls + " h-16 resize-none"} value={body.notes} onChange={(e) => setBody({ ...body, notes: e.target.value })} />
      </div>
    </ModalShell>
  );
}

// ─── Log Hours ───────────────────────────────────────────────────────────

const LAST_USED_EMPLOYEE_KEY = "crew_last_employee_id";

export function LogHoursModal({
  employees, defaultEmployeeId, existing, onClose, onSaved,
}: {
  employees: Employee[];
  defaultEmployeeId?: string;
  existing?: TimeEntry;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initialEmp = useMemo(() => {
    if (existing) return existing.employee_id;
    if (defaultEmployeeId && employees.find((e) => e.id === defaultEmployeeId)) return defaultEmployeeId;
    const last = typeof window !== "undefined" ? localStorage.getItem(LAST_USED_EMPLOYEE_KEY) : null;
    if (last && employees.find((e) => e.id === last)) return last;
    return employees[0]?.id || "";
  }, [existing, defaultEmployeeId, employees]);

  const [employeeId, setEmployeeId] = useState(initialEmp);
  const [workDate, setWorkDate] = useState(existing?.work_date || todayCentralISO());
  const [hours, setHours] = useState(existing ? String(existing.hours) : "");
  const [jobRef, setJobRef] = useState(existing?.job_reference || "");
  const [notes, setNotes] = useState(existing?.notes || "");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const h = parseFloat(hours);
    if (!employeeId) { toast.error("Pick an employee"); return; }
    if (!workDate) { toast.error("Pick a date"); return; }
    if (!h || h <= 0 || h > 24) { toast.error("Hours must be between 0 and 24"); return; }
    setSaving(true);
    try {
      if (existing) {
        await api.updateTimeEntry(existing.id, {
          work_date: workDate,
          hours: h,
          job_reference: jobRef.trim(),
          notes: notes.trim(),
        });
        toast.success("Time entry updated");
      } else {
        await api.createTimeEntry({
          employee_id: employeeId,
          work_date: workDate,
          hours: h,
          job_reference: jobRef.trim(),
          notes: notes.trim(),
        });
        localStorage.setItem(LAST_USED_EMPLOYEE_KEY, employeeId);
        toast.success("Hours logged");
      }
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell
      title={existing ? "Edit Time Entry" : "Log Hours"}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
            {existing ? "Save Changes" : "Submit"}
          </Button>
        </>
      }
    >
      <div>
        <label className={labelCls}>Employee</label>
        <select
          className={selectCls}
          value={employeeId}
          onChange={(e) => setEmployeeId(e.target.value)}
          disabled={!!existing}
          title={existing ? "Can't reassign — delete and re-add to move" : ""}
        >
          {employees.map((e) => (
            <option key={e.id} value={e.id}>{e.display_name || `${e.first_name} ${e.last_name}`} (${e.pay_rate.toFixed(2)}/hr)</option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Date</label>
          <Input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>Hours</label>
          <Input type="number" step="0.25" min="0" max="24" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="e.g. 8.5" />
        </div>
      </div>
      {existing && (
        <p className="text-[10px] text-muted-foreground">Rate stays at ${existing.rate_at_entry.toFixed(2)}/hr (snapshot from when this was logged). Earnings recompute automatically.</p>
      )}
      <div>
        <label className={labelCls}>Job Reference (optional)</label>
        <CustomerSearchPicker
          employeeId={employeeId}
          initialValue={jobRef}
          onChange={({ text }) => setJobRef(text)}
          placeholder="Search customer name (or type freeform)"
          hint="Pick a customer from the list, or just type — both save."
          className="mt-1"
        />
      </div>
      <div>
        <label className={labelCls}>Notes (optional)</label>
        <textarea className={inputCls + " h-16 resize-none"} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      {employeeId && hours && parseFloat(hours) > 0 && (
        <div className="rounded border-l-4 border-primary bg-primary/5 px-3 py-2 text-sm">
          Earnings: <strong>${(parseFloat(hours) * (employees.find((e) => e.id === employeeId)?.pay_rate || 0)).toFixed(2)}</strong>
        </div>
      )}
    </ModalShell>
  );
}

// ─── Record Payment ──────────────────────────────────────────────────────

const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "zelle", label: "Zelle" },
  { value: "check", label: "Check" },
  { value: "venmo", label: "Venmo" },
  { value: "cashapp", label: "CashApp" },
  { value: "other", label: "Other" },
];

export function RecordPaymentModal({
  employees, defaultEmployeeId, existing, onClose, onSaved,
}: {
  employees: Employee[];
  defaultEmployeeId?: string;
  existing?: Payment;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initialEmp = useMemo(() => {
    if (existing) return existing.employee_id;
    if (defaultEmployeeId && employees.find((e) => e.id === defaultEmployeeId)) return defaultEmployeeId;
    const last = typeof window !== "undefined" ? localStorage.getItem(LAST_USED_EMPLOYEE_KEY) : null;
    if (last && employees.find((e) => e.id === last)) return last;
    return employees[0]?.id || "";
  }, [existing, defaultEmployeeId, employees]);

  const [employeeId, setEmployeeId] = useState(initialEmp);
  const [paymentDate, setPaymentDate] = useState(existing?.payment_date || todayCentralISO());
  const [wage, setWage] = useState(existing && existing.wage_amount > 0 ? String(existing.wage_amount) : "");
  const [reimb, setReimb] = useState(existing && existing.reimbursement_amount > 0 ? String(existing.reimbursement_amount) : "");
  const [reimbNote, setReimbNote] = useState(existing?.reimbursement_note || "");
  const [bonus, setBonus] = useState(existing && existing.bonus_amount > 0 ? String(existing.bonus_amount) : "");
  const [bonusNote, setBonusNote] = useState(existing?.bonus_note || "");
  const [method, setMethod] = useState<PaymentMethod>(existing?.payment_method || "cash");
  const [methodOther, setMethodOther] = useState(existing?.payment_method_other || "");
  const [notes, setNotes] = useState(existing?.notes || "");
  const [showReimb, setShowReimb] = useState(!!existing && existing.reimbursement_amount > 0);
  const [showBonus, setShowBonus] = useState(!!existing && existing.bonus_amount > 0);
  const [saving, setSaving] = useState(false);

  const wageN = parseFloat(wage) || 0;
  const reimbN = parseFloat(reimb) || 0;
  const bonusN = parseFloat(bonus) || 0;
  const total = wageN + reimbN + bonusN;

  const handleSave = async () => {
    if (!employeeId) { toast.error("Pick an employee"); return; }
    if (total <= 0) { toast.error("At least one amount must be greater than 0"); return; }
    if (method === "other" && !methodOther.trim()) { toast.error("Specify the payment method"); return; }
    setSaving(true);
    try {
      const body = {
        employee_id: employeeId,
        payment_date: paymentDate,
        wage_amount: wageN,
        reimbursement_amount: reimbN,
        reimbursement_note: reimbNote.trim(),
        bonus_amount: bonusN,
        bonus_note: bonusNote.trim(),
        payment_method: method,
        payment_method_other: methodOther.trim(),
        notes: notes.trim(),
      };
      if (existing) {
        await api.updatePayment(existing.id, body);
        toast.success("Payment updated");
      } else {
        await api.createPayment(body);
        localStorage.setItem(LAST_USED_EMPLOYEE_KEY, employeeId);
        toast.success("Payment recorded");
      }
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell
      title={existing ? "Edit Payment" : "Record Payment"}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
            {existing ? `Save Changes ($${total.toFixed(2)})` : `Record ($${total.toFixed(2)})`}
          </Button>
        </>
      }
    >
      <div>
        <label className={labelCls}>Employee</label>
        <select
          className={selectCls}
          value={employeeId}
          onChange={(e) => setEmployeeId(e.target.value)}
          disabled={!!existing}
          title={existing ? "Can't reassign — delete and re-add to move" : ""}
        >
          {employees.map((e) => (
            <option key={e.id} value={e.id}>{e.display_name || `${e.first_name} ${e.last_name}`}</option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Payment Date</label>
          <Input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>Method</label>
          <select className={selectCls} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
            {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
      </div>
      {method === "other" && (
        <div>
          <label className={labelCls}>Specify Other Method</label>
          <Input value={methodOther} onChange={(e) => setMethodOther(e.target.value)} placeholder="e.g. Wire transfer" />
        </div>
      )}
      <div>
        <label className={labelCls}>Wages ($)</label>
        <Input type="number" step="0.01" min="0" value={wage} onChange={(e) => setWage(e.target.value)} />
      </div>

      {!showReimb ? (
        <button onClick={() => setShowReimb(true)} className="text-xs text-primary hover:underline text-left">+ Add reimbursement</button>
      ) : (
        <div className="space-y-2 border-l-2 border-muted pl-3">
          <div>
            <label className={labelCls}>Reimbursement ($)</label>
            <Input type="number" step="0.01" min="0" value={reimb} onChange={(e) => setReimb(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Reimbursement note</label>
            <Input value={reimbNote} onChange={(e) => setReimbNote(e.target.value)} placeholder="Gas, supplies, etc." />
          </div>
        </div>
      )}

      {!showBonus ? (
        <button onClick={() => setShowBonus(true)} className="text-xs text-primary hover:underline text-left">+ Add bonus / tip</button>
      ) : (
        <div className="space-y-2 border-l-2 border-muted pl-3">
          <div>
            <label className={labelCls}>Bonus / Tip ($)</label>
            <Input type="number" step="0.01" min="0" value={bonus} onChange={(e) => setBonus(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Bonus note</label>
            <Input value={bonusNote} onChange={(e) => setBonusNote(e.target.value)} placeholder="Customer tip / performance bonus" />
          </div>
        </div>
      )}

      <div>
        <label className={labelCls}>Notes</label>
        <textarea className={inputCls + " h-16 resize-none"} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      <div className="rounded border-l-4 border-primary bg-primary/5 px-3 py-2 text-sm flex items-center justify-between">
        <span className="text-muted-foreground">Total payment</span>
        <strong className="text-lg">${total.toFixed(2)}</strong>
      </div>
      {total > 0 && (
        <p className="text-[10px] text-muted-foreground">All ${total.toFixed(2)} counts toward the 1099 total (wages + reimbursements + bonuses).</p>
      )}
    </ModalShell>
  );
}
