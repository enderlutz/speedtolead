import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { api, type ReadyToInvoiceJob } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { RefreshCw, MapPin, Clock, ExternalLink, FileText, Send, AlertCircle } from "lucide-react";
import { formatCurrency } from "@/lib/utils";

// Admin queue of jobs ready for QuickBooks invoicing. Surfaces every
// in_progress / completed job that hasn't been invoiced yet. Sourced
// from the worker-driven start/complete events on the My Day view —
// when a worker hits Start Job, this is where Alan/Olga prep the bill.

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function statusChip(status: ReadyToInvoiceJob["status"]) {
  if (status === "in_progress") {
    return <Badge className="bg-blue-500 text-white">In progress</Badge>;
  }
  return <Badge className="bg-green-600 text-white">Complete</Badge>;
}

export default function InvoiceQueue() {
  const [jobs, setJobs] = useState<ReadyToInvoiceJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [amountDrafts, setAmountDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await api.getReadyToInvoice();
      setJobs(res.jobs || []);
      // Seed the per-job amount editor with closed_price as the default.
      setAmountDrafts((prev) => {
        const next = { ...prev };
        for (const j of res.jobs || []) {
          if (next[j.id] === undefined) next[j.id] = String(j.closed_price || "");
        }
        return next;
      });
    } catch (e: any) {
      toast.error(e?.message || "Failed to load invoice queue");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Auto-refresh every 30s so newly-started jobs surface without a
    // manual reload. Cheap query — no BLOBs touched.
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  const handleGenerate = async (job: ReadyToInvoiceJob) => {
    const amountStr = amountDrafts[job.id] ?? String(job.closed_price);
    const amount = parseFloat(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a valid invoice amount");
      return;
    }
    setSendingId(job.id);
    try {
      const result = await api.generateInvoice(job.id, {
        amount,
        description: `${job.package_tier ? job.package_tier + " — " : ""}Fence staining @ ${job.address}`,
        due_in_days: 7,
      });
      toast.success(`Invoice created${result.invoice_url ? " — link copied" : ""}`);
      if (result.invoice_url) {
        try { await navigator.clipboard.writeText(result.invoice_url); } catch { /* clipboard blocked */ }
      }
      // Optimistic remove — invoice exists now, so it leaves the queue.
      setJobs((prev) => prev.filter((j) => j.id !== job.id));
    } catch (e: any) {
      toast.error(e?.message || "Failed to generate invoice");
    } finally {
      setSendingId(null);
    }
  };

  const handleSendSms = async (job: ReadyToInvoiceJob) => {
    setSendingId(job.id);
    try {
      const res = await api.sendInvoiceSms(job.id);
      toast.success(`SMS sent to ${res.to_phone}`);
    } catch (e: any) {
      toast.error(e?.message || "Failed to SMS invoice link");
    } finally {
      setSendingId(null);
    }
  };

  if (loading) {
    return (
      <div className="p-6 text-center text-muted-foreground">Loading queue…</div>
    );
  }

  const inProgress = jobs.filter((j) => j.status === "in_progress");
  const completed = jobs.filter((j) => j.status === "completed");

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Invoice Queue</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Jobs that started or finished but haven't been invoiced. Auto-refreshes every 30s.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { setRefreshing(true); load(); }} disabled={refreshing}>
          <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card><CardContent className="p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">Total queued</div>
          <div className="text-3xl font-bold mt-1">{jobs.length}</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">Working now</div>
          <div className="text-3xl font-bold mt-1 text-blue-600">{inProgress.length}</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">Done — needs invoice</div>
          <div className="text-3xl font-bold mt-1 text-green-700">{completed.length}</div>
        </CardContent></Card>
      </div>

      {jobs.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Nothing in the queue. When a worker hits Start or Complete on a job, it appears here.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {[...inProgress, ...completed].map((job) => (
            <Card key={job.id} className={job.status === "in_progress" ? "border-l-4 border-l-blue-500" : "border-l-4 border-l-green-600"}>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link to={`/leads/${job.lead_id}`} className="font-semibold text-base hover:underline">
                        {job.customer_name || "(no name)"}
                      </Link>
                      {statusChip(job.status)}
                      {job.package_tier && (
                        <Badge variant="outline" className="text-xs">{job.package_tier}</Badge>
                      )}
                    </div>
                    {job.address && (
                      <a
                        href={`https://maps.google.com/?q=${encodeURIComponent(job.address)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1 text-xs text-blue-600 mt-1 hover:underline"
                      >
                        <MapPin className="h-3 w-3" />
                        {job.address}
                      </a>
                    )}
                    <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {job.status === "in_progress"
                          ? `Started ${relativeTime(job.started_at)}`
                          : `Completed ${relativeTime(job.completed_at)}`}
                      </span>
                      <span>{job.job_date}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-muted-foreground">Quoted price</div>
                    <div className="text-xl font-bold">{formatCurrency(job.closed_price)}</div>
                  </div>
                </div>

                {!job.qb_invoice_id ? (
                  <div className="flex flex-wrap gap-2 items-end pt-2 border-t">
                    <div className="flex-1 min-w-[180px]">
                      <label className="text-xs text-muted-foreground block mb-1">
                        Invoice amount
                      </label>
                      <Input
                        type="number"
                        step="0.01"
                        value={amountDrafts[job.id] ?? ""}
                        onChange={(e) => setAmountDrafts((d) => ({ ...d, [job.id]: e.target.value }))}
                        className="h-9"
                      />
                    </div>
                    <Button
                      onClick={() => handleGenerate(job)}
                      disabled={sendingId === job.id}
                      className="bg-green-600 hover:bg-green-700 h-9"
                    >
                      <FileText className="h-4 w-4 mr-2" />
                      {sendingId === job.id ? "Creating…" : "Generate Invoice"}
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2 pt-2 border-t items-center">
                    <Badge className="bg-emerald-100 text-emerald-800">Invoice created</Badge>
                    {job.qb_invoice_url && (
                      <a
                        href={job.qb_invoice_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm text-blue-600 hover:underline inline-flex items-center gap-1"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        Open in QuickBooks
                      </a>
                    )}
                    {job.customer_phone && (
                      <Button size="sm" variant="outline" onClick={() => handleSendSms(job)} disabled={sendingId === job.id}>
                        <Send className="h-3.5 w-3.5 mr-1" />
                        {sendingId === job.id ? "Sending…" : `SMS link to ${job.customer_phone}`}
                      </Button>
                    )}
                  </div>
                )}

                {!job.customer_email && !job.customer_phone && (
                  <div className="flex items-center gap-2 text-xs text-amber-600">
                    <AlertCircle className="h-3.5 w-3.5" />
                    No customer email or phone on file — invoice will be created but can't be auto-sent.
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
