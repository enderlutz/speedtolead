import { useState } from "react";
import { api, type ScheduledJob, type PaymentStatus } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { X, CheckCircle2, Loader2 } from "lucide-react";

const PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "zelle", label: "Zelle" },
  { value: "check", label: "Check" },
  { value: "venmo", label: "Venmo" },
  { value: "cashapp", label: "Cash App" },
  { value: "quickbooks_invoice", label: "QuickBooks invoice" },
  { value: "other", label: "Other" },
];

interface Props {
  job: ScheduledJob;
  onClose: () => void;
  onSaved: () => void;
}

/** Manual Mark Paid flow — what admin uses when collecting on-site. The
 * QuickBooks payment-received webhook flips the same fields automatically
 * via /quickbooks/webhook so admin never has to touch this when QB is
 * doing its job. */
export default function MarkPaidModal({ job, onClose, onSaved }: Props) {
  const [status, setStatus] = useState<PaymentStatus>("paid");
  const [amount, setAmount] = useState(String(job.closed_price || 0));
  const [method, setMethod] = useState("cash");
  const [bnplVendor, setBnplVendor] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const amt = parseFloat(amount) || 0;
    if (status === "paid" && amt <= 0) {
      toast.error("Amount collected must be > 0");
      return;
    }
    if (status === "bnpl_financed" && !bnplVendor.trim()) {
      toast.error("Pick a BNPL vendor (Wisetack, Affirm, etc.)");
      return;
    }
    setSaving(true);
    try {
      await api.markScheduledJobPaid(job.id, {
        payment_status: status,
        amount_collected: amt,
        payment_method: method,
        bnpl_vendor: status === "bnpl_financed" ? bnplVendor.trim() : "",
      });
      toast.success(status === "paid" ? "Marked paid" : status === "bnpl_financed" ? "Logged as BNPL" : "Marked unpaid");
      onSaved();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-background rounded-lg shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" /> Mark payment
          </h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1"><X className="h-4 w-4" /></button>
        </div>
        <div className="p-4 space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            <span className="font-semibold">{job.customer_name || "Job"}</span>
            {(job.closed_price || 0) > 0 && <> — quoted ${job.closed_price?.toFixed(2)}</>}
          </p>

          <div>
            <label className="text-xs font-semibold text-muted-foreground">Status</label>
            <div className="grid grid-cols-3 gap-2 mt-1">
              {[
                { v: "paid", label: "Paid in full" },
                { v: "bnpl_financed", label: "BNPL" },
                { v: "unpaid", label: "Unpaid" },
              ].map((opt) => (
                <button
                  key={opt.v}
                  type="button"
                  onClick={() => setStatus(opt.v as PaymentStatus)}
                  className={`px-2 py-1.5 rounded border text-xs font-medium ${
                    status === opt.v
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background hover:bg-muted"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {status === "paid" && (
            <>
              <div>
                <label className="text-xs font-semibold text-muted-foreground">Amount collected ($)</label>
                <Input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1" />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground">Payment method</label>
                <select value={method} onChange={(e) => setMethod(e.target.value)} className="w-full mt-1 border border-input rounded-md px-3 py-2 text-sm bg-background">
                  {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
            </>
          )}

          {status === "bnpl_financed" && (
            <>
              <div>
                <label className="text-xs font-semibold text-muted-foreground">BNPL vendor</label>
                <Input
                  value={bnplVendor}
                  onChange={(e) => setBnplVendor(e.target.value)}
                  placeholder="Wisetack, Affirm, Synchrony…"
                  className="mt-1"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground">Financed amount ($)</label>
                <Input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1" />
              </div>
              <p className="text-[11px] text-muted-foreground italic">
                BNPL counts as collected revenue from our side — the lender pays us.
              </p>
            </>
          )}

          {status === "unpaid" && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
              Reverting to unpaid will clear the recorded payment and put this job back in the outstanding list.
            </p>
          )}
        </div>
        <div className="p-3 border-t flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>
            {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
