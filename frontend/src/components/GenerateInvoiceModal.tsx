import { useState } from "react";
import { api, type ScheduledJob, type Lead } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { X, FileText, Loader2, Send, ExternalLink, CheckCircle2, AlertTriangle } from "lucide-react";

interface Props {
  job: ScheduledJob;
  lead: Lead;
  onClose: () => void;
  onSaved: (updatedJob: ScheduledJob) => void;
}

/** Generate a QuickBooks invoice for this scheduled job, copy the public
 * link, and SMS it to the customer. Works in mock mode (returns a fake
 * URL) without any QB credentials so admin can rehearse the flow tonight.
 *
 * Backend has been wired so:
 *   - flipping QB_MODE=live + adding QB_CLIENT_ID/QB_CLIENT_SECRET turns
 *     this into a real Intuit-issued invoice with no frontend changes
 *   - the QB webhook flips payment_status='paid' on receipt of payment,
 *     and the dashboard reflects revenue immediately. */
export default function GenerateInvoiceModal({ job, lead, onClose, onSaved }: Props) {
  const [amount, setAmount] = useState(String(job.qb_invoice_amount || job.closed_price || 0));
  const [description, setDescription] = useState(job.job_description || "Fence staining service");
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [generated, setGenerated] = useState<{ invoice_id: string; invoice_url: string; mode: string } | null>(
    job.qb_invoice_id ? { invoice_id: job.qb_invoice_id, invoice_url: job.qb_invoice_url || "", mode: "live" } : null,
  );
  const [updatedJob, setUpdatedJob] = useState<ScheduledJob>(job);

  const generate = async () => {
    const amt = parseFloat(amount) || 0;
    if (amt <= 0) {
      toast.error("Amount must be > 0");
      return;
    }
    setGenerating(true);
    try {
      const r = await api.generateInvoice(job.id, { amount: amt, description, due_in_days: 0 });
      setGenerated({ invoice_id: r.invoice_id, invoice_url: r.invoice_url, mode: r.mode });
      setUpdatedJob(r.job);
      toast.success(r.mode === "mock" ? "Mock invoice generated (test mode)" : "Invoice generated");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to generate invoice");
    } finally {
      setGenerating(false);
    }
  };

  const sendSms = async () => {
    if (!lead.contact_phone) {
      toast.error("No customer phone on file");
      return;
    }
    setSending(true);
    try {
      const r = await api.sendInvoiceSms(job.id);
      if (r.status === "sent") {
        toast.success(`Invoice link sent to ${r.to_phone}`);
      } else {
        toast.error("SMS failed — check the lead's GHL contact");
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to send SMS");
    } finally {
      setSending(false);
    }
  };

  /** Test-mode-only: pretend Intuit pinged us with payment received. Useful
   * for proving the end-to-end flow without real QB. */
  const simulatePayment = async () => {
    if (!generated) return;
    setSimulating(true);
    try {
      const r = await api.triggerMockQbPayment(generated.invoice_id, parseFloat(amount) || 0);
      if (r.status === "ok") {
        toast.success("Payment received — job marked PAID");
        // Re-fetch updated job state
        const refreshed = await api.getScheduledJob(job.id);
        setUpdatedJob(refreshed);
      } else {
        toast.error(`No-op: ${r.reason || "no matching job"}`);
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setSimulating(false);
    }
  };

  const isMock = generated?.mode === "mock";
  const isPaid = updatedJob.payment_status === "paid";
  const hasEmail = Boolean((lead.contact_email || "").trim());

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-background rounded-lg shadow-xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />
            {generated ? "Invoice ready" : "Generate Invoice"}
            {isMock && <span className="text-[10px] uppercase tracking-wide bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-bold">TEST MODE</span>}
          </h2>
          <button onClick={() => { onSaved(updatedJob); }} className="text-muted-foreground hover:text-foreground p-1"><X className="h-4 w-4" /></button>
        </div>

        <div className="p-4 space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            <span className="font-semibold">{lead.contact_name || job.customer_name}</span>
            {lead.contact_phone && <> · {lead.contact_phone}</>}
            {lead.address && <> · {lead.address}</>}
          </p>

          {!generated && (
            <>
              {!hasEmail && (
                <div className="bg-amber-50 border border-amber-300 rounded p-2.5 flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                  <div className="text-xs text-amber-900 leading-snug">
                    <p className="font-semibold mb-0.5">Customer email required</p>
                    <p>
                      QuickBooks needs an email to generate a customer-facing payment link and send the
                      invoice. Add the customer's email to the lead first (it'll sync to GHL), then come
                      back here.
                    </p>
                  </div>
                </div>
              )}
              <div>
                <label className="text-xs font-semibold text-muted-foreground">Amount ($)</label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="mt-1"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground">Description</label>
                <Input value={description} onChange={(e) => setDescription(e.target.value)} className="mt-1" />
              </div>
              <p className="text-[11px] text-muted-foreground italic">
                A QuickBooks invoice will be created and a hosted-payment link returned. QB also emails
                the invoice to the customer. Click "Text invoice to customer" after to send the payment
                link via SMS too.
              </p>
            </>
          )}

          {generated && (
            <>
              <div className="bg-blue-50 border border-blue-200 rounded p-3">
                <p className="text-xs font-semibold text-blue-900 mb-1 flex items-center gap-1">
                  <FileText className="h-3 w-3" /> QuickBooks Invoice {isMock && "(Mock)"}
                </p>
                <p className="text-xs break-all">
                  <a href={generated.invoice_url} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline inline-flex items-center gap-1">
                    {generated.invoice_url} <ExternalLink className="h-3 w-3" />
                  </a>
                </p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Invoice ID: <span className="font-mono">{generated.invoice_id}</span> · ${parseFloat(amount).toFixed(2)}
                </p>
              </div>

              {isPaid && (
                <div className="bg-emerald-50 border border-emerald-200 rounded p-2 flex items-center gap-2 text-xs text-emerald-900">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  <span className="font-semibold">PAID</span> — invoice settled, job marked complete.
                </div>
              )}

              {isMock && !isPaid && (
                <div className="border border-dashed rounded p-2 text-xs text-muted-foreground">
                  <p className="mb-2">In live mode, the QuickBooks webhook flips this to PAID automatically when the customer pays.
                  Click below to simulate that webhook so you can rehearse the full flow tonight.</p>
                  <Button size="sm" variant="outline" onClick={simulatePayment} disabled={simulating}>
                    {simulating && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                    Simulate customer paid
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        <div className="p-3 border-t flex justify-end gap-2 flex-wrap">
          <Button variant="ghost" onClick={() => { onSaved(updatedJob); }}>Close</Button>
          {!generated && (
            <Button
              onClick={generate}
              disabled={generating || !hasEmail}
              title={!hasEmail ? "Add the customer's email to the lead first" : undefined}
            >
              {generating && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              Generate
            </Button>
          )}
          {generated && !isPaid && (
            <Button onClick={sendSms} disabled={sending}>
              {sending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              <Send className="h-3.5 w-3.5 mr-1" /> Text invoice to customer
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
