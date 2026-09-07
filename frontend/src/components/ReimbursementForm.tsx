import { useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomerSearchInput } from "@/components/SearchInput";
import { toast } from "sonner";
import {
  X, Plus, Trash2, Upload, Image as ImageIcon, FileText,
} from "lucide-react";
import { todayCT } from "@/lib/date";

const labelCls = "text-xs font-semibold text-muted-foreground";

type LineItem = { id: string; description: string; amount: string };

interface Props {
  employeeId: string;
  employeeName: string;
  defaultLeadId?: string;
  defaultLeadName?: string;
  defaultDate?: string;
  /** Show as a centered modal overlay. Default: inline card. */
  asModal?: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export default function ReimbursementForm({
  employeeId,
  employeeName,
  defaultLeadId = "",
  defaultLeadName = "",
  defaultDate,
  asModal = false,
  onClose,
  onSaved,
}: Props) {
  const [leadId, setLeadId] = useState(defaultLeadId);
  const [leadLabel, setLeadLabel] = useState(defaultLeadName);
  const [customerQuery, setCustomerQuery] = useState("");
  const [expenseDate, setExpenseDate] = useState(defaultDate || todayCT());

  // Single-amount path (used when items list is empty)
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");

  // Itemized path
  const [items, setItems] = useState<LineItem[]>([]);

  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Customer search is now backend-driven (debounced typeahead + recent
  // dropdown on focus) via <CustomerSearchInput>. Old client-side filter
  // over getCustomersToLog removed.

  const itemsTotal = useMemo(
    () => items.reduce((a, i) => a + (parseFloat(i.amount) || 0), 0),
    [items],
  );

  const filledItems = items.filter((i) => i.description.trim() && parseFloat(i.amount) > 0);
  const useItems = filledItems.length > 0;

  const finalAmount = useItems ? itemsTotal : parseFloat(amount) || 0;

  const addItem = () => {
    setItems((prev) => [
      ...prev,
      { id: Math.random().toString(36).slice(2), description: "", amount: "" },
    ]);
  };
  const updateItem = (id: string, field: "description" | "amount", value: string) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, [field]: value } : i)));
  };
  const removeItem = (id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
  };

  const clearCustomer = () => {
    setLeadId("");
    setLeadLabel("");
    setCustomerQuery("");
  };

  const handleFile = (f: File | null) => {
    if (!f) {
      setFile(null);
      return;
    }
    // Reasonable cap — backend stores blobs in DB
    if (f.size > 15 * 1024 * 1024) {
      toast.error("File too big — please pick something under 15 MB");
      return;
    }
    setFile(f);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };
  const onDragLeave = () => setDragOver(false);

  const submit = async () => {
    if (!employeeId) {
      toast.error("No employee selected");
      return;
    }
    if (!leadId) {
      toast.error("Pick a customer");
      return;
    }
    if (!finalAmount || finalAmount <= 0) {
      toast.error("Amount must be greater than 0");
      return;
    }
    if (!file) {
      toast.error("Receipt photo is required");
      return;
    }

    let finalDescription = description.trim();
    if (useItems) {
      finalDescription = filledItems
        .map((i) => `- ${i.description.trim()} — $${(parseFloat(i.amount) || 0).toFixed(2)}`)
        .join("\n");
    }

    setSaving(true);
    try {
      const fd = new FormData();
      fd.append("employee_id", employeeId);
      fd.append("lead_id", leadId);
      fd.append("expense_date", expenseDate);
      fd.append("amount", String(finalAmount));
      fd.append("description", finalDescription);
      fd.append("notes", notes);
      fd.append("receipt", file);
      await api.uploadReimbursement(fd);
      toast.success("Reimbursement submitted");
      onSaved();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to submit");
    } finally {
      setSaving(false);
    }
  };

  const body = (
    <div className="space-y-3">
      {/* Employee — read-only */}
      <div>
        <label className={labelCls}>Employee</label>
        <div className="mt-1 px-3 py-2 rounded-md bg-muted/50 border text-sm font-medium">
          {employeeName || "—"}
        </div>
      </div>

      {/* Customer search — shared autocomplete component. Recent customers
          appear on focus; typing triggers backend search (debounced). */}
      <div>
        <label className={labelCls}>Customer</label>
        {leadId ? (
          <div className="mt-1 flex items-center gap-2 rounded-md bg-primary/5 border border-primary/20 px-3 py-2 text-sm">
            <span className="font-medium flex-1 truncate">{leadLabel || "Selected"}</span>
            <button onClick={clearCustomer} className="text-muted-foreground hover:text-foreground" title="Change customer">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div className="mt-1">
            <CustomerSearchInput
              value={customerQuery}
              onChange={setCustomerQuery}
              onSelect={(c) => {
                setLeadId(c.id);
                setLeadLabel(c.contact_name + (c.address ? ` · ${c.address}` : ""));
                setCustomerQuery("");
              }}
              placeholder="Search customer name, phone, or address"
            />
          </div>
        )}
      </div>

      {/* Date */}
      <div>
        <label className={labelCls}>Date paid</label>
        <Input
          type="date"
          value={expenseDate}
          onChange={(e) => setExpenseDate(e.target.value)}
          className="mt-1"
        />
      </div>

      {/* Description */}
      <div>
        <div className="flex items-center justify-between">
          <label className={labelCls}>Description</label>
          <button
            type="button"
            onClick={addItem}
            className="text-[11px] text-primary hover:underline inline-flex items-center gap-0.5"
          >
            <Plus className="h-3 w-3" /> Add line item
          </button>
        </div>

        {items.length === 0 ? (
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What was bought (or click 'Add line item' to itemize)"
            className="mt-1"
          />
        ) : (
          <div className="mt-1 space-y-1.5">
            {items.map((it) => (
              <div key={it.id} className="flex items-center gap-2">
                <Input
                  value={it.description}
                  onChange={(e) => updateItem(it.id, "description", e.target.value)}
                  placeholder="Item description"
                  className="flex-1"
                />
                <Input
                  type="number"
                  step="0.01"
                  value={it.amount}
                  onChange={(e) => updateItem(it.id, "amount", e.target.value)}
                  placeholder="0.00"
                  className="w-24"
                />
                <button
                  type="button"
                  onClick={() => removeItem(it.id)}
                  className="text-muted-foreground hover:text-red-600 p-1"
                  title="Remove line"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Amount — auto when itemized, manual otherwise */}
      <div>
        <label className={labelCls}>
          Amount ($) {useItems && <span className="text-[10px] font-normal text-muted-foreground">— summed from line items</span>}
        </label>
        {useItems ? (
          <div className="mt-1 px-3 py-2 rounded-md bg-muted/50 border text-sm font-semibold">
            ${itemsTotal.toFixed(2)}
          </div>
        ) : (
          <Input
            type="number"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="mt-1"
          />
        )}
      </div>

      {/* Notes */}
      <div>
        <label className={labelCls}>Notes (optional)</label>
        <Input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything Alan should know"
          className="mt-1"
        />
      </div>

      {/* File: drag & drop */}
      <div>
        <label className={labelCls}>Receipt photo (required)</label>
        <div
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onClick={() => fileInputRef.current?.click()}
          className={`mt-1 border-2 border-dashed rounded-md p-4 text-center cursor-pointer transition-colors ${
            dragOver
              ? "border-primary bg-primary/5"
              : file
                ? "border-emerald-300 bg-emerald-50/40"
                : "border-input hover:border-primary/50 hover:bg-muted/30"
          }`}
        >
          {file ? (
            <div className="flex items-center justify-center gap-2 text-sm">
              {file.type.startsWith("image/") ? (
                <ImageIcon className="h-4 w-4 text-emerald-700" />
              ) : (
                <FileText className="h-4 w-4 text-emerald-700" />
              )}
              <span className="truncate max-w-[260px] font-medium">{file.name}</span>
              <span className="text-xs text-muted-foreground">({(file.size / 1024).toFixed(0)} KB)</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setFile(null);
                }}
                className="text-muted-foreground hover:text-red-600 p-0.5"
                title="Remove"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <>
              <Upload className="h-5 w-5 mx-auto text-muted-foreground" />
              <p className="text-sm mt-1.5">
                <span className="font-medium text-primary">Click to upload</span> or drag & drop
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">Image or PDF, up to 15 MB</p>
            </>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0] || null)}
          />
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={submit} disabled={saving}>{saving ? "Uploading…" : "Submit"}</Button>
      </div>
    </div>
  );

  if (asModal) {
    return (
      <div
        className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
        onClick={onClose}
      >
        <div
          className="bg-background rounded-lg shadow-xl w-full max-w-lg max-h-[92vh] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="p-4 border-b flex items-center justify-between">
            <h2 className="text-base font-semibold">New Reimbursement</h2>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">{body}</div>
        </div>
      </div>
    );
  }

  return <div className="border rounded-lg p-3 bg-muted/20">{body}</div>;
}
