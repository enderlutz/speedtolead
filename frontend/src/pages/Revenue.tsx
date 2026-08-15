import { useCallback, useEffect, useRef, useState } from "react";
import { api, type QuickbooksInvoice, type QbInvoiceRollup, type LeanLead } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CustomerSearchInput } from "@/components/SearchInput";
import { toast } from "sonner";
import { RefreshCw, Search, X, Link2, DollarSign, Loader2 } from "lucide-react";

type Filter = "all" | "unassigned" | "paid" | "outstanding";
const PAGE = 100;

function money(n: number, cents = false): string {
  return `$${(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  })}`;
}
function fmtDate(d: string): string {
  if (!d) return "—";
  const dt = new Date(`${d}T12:00:00`);
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const STATUS_STYLE: Record<string, string> = {
  paid: "bg-emerald-100 text-emerald-800",
  partial: "bg-amber-100 text-amber-800",
  unpaid: "bg-rose-100 text-rose-700",
  void: "bg-gray-100 text-gray-500",
};

export default function Revenue() {
  const [invoices, setInvoices] = useState<QuickbooksInvoice[]>([]);
  const [rollup, setRollup] = useState<QbInvoiceRollup | null>(null);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [assignFor, setAssignFor] = useState<QuickbooksInvoice | null>(null);
  const pollRef = useRef<number | null>(null);

  // Takes the offset rather than a reset flag: reading invoices.length inside
  // made the callback depend on the very state it appends to, so it could not
  // be an honest effect dependency. The pagination caller passes the offset.
  const load = useCallback(async (offset: number) => {
    setLoading(true);
    try {
      const r = await api.listQbInvoices({ filter, q: search.trim(), limit: PAGE, offset });
      setRollup(r.rollup);
      setTotal(r.total);
      setInvoices((prev) => (offset === 0 ? r.invoices : [...prev, ...r.invoices]));
    } catch {
      toast.error("Couldn't load invoices");
    } finally {
      setLoading(false);
    }
  }, [filter, search]);

  // Reload from the top whenever the filter or search changes.
  useEffect(() => { load(0); }, [load]);
  useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current); }, []);

  const runSync = async () => {
    setSyncing(true);
    try {
      const r = await api.syncQbInvoices();
      if (r.status === "already_running") toast.info("A sync is already running…");
      else toast.success("Pulling invoices from QuickBooks…");
      // Poll until done, then refresh the list.
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        try {
          const s = await api.getQbInvoiceSyncStatus();
          if (s.status !== "running") {
            if (pollRef.current) window.clearInterval(pollRef.current);
            pollRef.current = null;
            setSyncing(false);
            if (s.status === "error") {
              toast.error(s.error || "Sync failed");
            } else {
              toast.success(`Synced ${s.synced ?? 0} invoices${s.auto_linked ? ` · ${s.auto_linked} auto-linked` : ""}`);
              load(0);
            }
          }
        } catch { /* keep polling */ }
      }, 2000);
    } catch (e) {
      setSyncing(false);
      toast.error(e instanceof Error ? e.message : "Couldn't start sync");
    }
  };

  const onAssigned = (updated: QuickbooksInvoice) => {
    setInvoices((prev) => prev.map((i) => (i.qb_invoice_id === updated.qb_invoice_id ? { ...i, ...updated } : i)));
    setAssignFor(null);
  };
  const unassign = async (inv: QuickbooksInvoice) => {
    try {
      const updated = await api.unassignQbInvoice(inv.qb_invoice_id);
      setInvoices((prev) => prev.map((i) => (i.qb_invoice_id === inv.qb_invoice_id ? { ...i, ...updated, lead_name: "" } : i)));
    } catch {
      toast.error("Couldn't unassign");
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Revenue</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Invoices pulled from QuickBooks. Match each one to a lead to see who's paid and what every lead is worth.
          </p>
        </div>
        <Button onClick={runSync} disabled={syncing}>
          <RefreshCw className={`h-4 w-4 mr-2 ${syncing ? "animate-spin" : ""}`} />
          {syncing ? "Syncing…" : "Sync from QuickBooks"}
        </Button>
      </div>

      {/* Rollup tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile label="Invoiced" value={money(rollup?.invoiced ?? 0)} />
        <Tile label="Collected" value={money(rollup?.collected ?? 0)} accent="text-emerald-600" />
        <Tile label="Outstanding" value={money(rollup?.outstanding ?? 0)} accent="text-amber-600" />
        <Tile label="Unassigned" value={String(rollup?.unassigned ?? 0)} sub="invoices" />
      </div>

      {/* Filters + search */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="inline-flex rounded-md border overflow-hidden">
          {(["all", "unassigned", "paid", "outstanding"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-sm capitalize border-r last:border-r-0 ${filter === f ? "bg-muted font-medium" : "hover:bg-muted/50"}`}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="relative w-64 max-w-full">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search customer or invoice #…"
            className="w-full text-sm rounded-md border bg-background pl-8 pr-8 py-1.5 focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Invoice table */}
      {loading && invoices.length === 0 ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : invoices.length === 0 ? (
        <Card><CardContent className="p-10 text-center text-sm text-muted-foreground">
          {rollup && rollup.invoiced === 0
            ? "No invoices yet. Click “Sync from QuickBooks” to pull them in."
            : "No invoices match this filter."}
        </CardContent></Card>
      ) : (
        <div className="rounded-xl border overflow-x-auto bg-background">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Invoice</th>
                <th className="px-4 py-2.5 font-medium">Customer</th>
                <th className="px-4 py-2.5 font-medium">Date</th>
                <th className="px-4 py-2.5 font-medium text-right">Total</th>
                <th className="px-4 py-2.5 font-medium text-right">Paid</th>
                <th className="px-4 py-2.5 font-medium text-right">Balance</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Lead</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.qb_invoice_id} className="border-b last:border-0 hover:bg-muted/20">
                  <td className="px-4 py-3 font-medium">{inv.doc_number || inv.qb_invoice_id}</td>
                  <td className="px-4 py-3">
                    <div className="truncate max-w-[180px]">{inv.customer_name || "—"}</div>
                    {inv.customer_email && <div className="text-xs text-muted-foreground truncate max-w-[180px]">{inv.customer_email}</div>}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{fmtDate(inv.txn_date)}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">{money(inv.total_amount, true)}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap text-emerald-700">{money(inv.amount_paid, true)}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">{inv.balance > 0 ? money(inv.balance, true) : "—"}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${STATUS_STYLE[inv.status] || "bg-gray-100 text-gray-600"}`}>
                      {inv.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {inv.lead_id ? (
                      <div className="flex items-center gap-1.5">
                        <a href={`/leads/${inv.lead_id}`} className="text-primary hover:underline truncate max-w-[130px]">
                          {inv.lead_name || "Lead"}
                        </a>
                        <button onClick={() => unassign(inv)} title="Unassign" className="text-muted-foreground hover:text-red-600">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setAssignFor(inv)}>
                        <Link2 className="h-3.5 w-3.5 mr-1" /> Assign
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {invoices.length < total && (
            <div className="p-3 text-center border-t">
              <Button variant="outline" size="sm" onClick={() => load(invoices.length)} disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
                Load more ({invoices.length} of {total})
              </Button>
            </div>
          )}
        </div>
      )}

      {assignFor && (
        <AssignInvoiceModal invoice={assignFor} onClose={() => setAssignFor(null)} onAssigned={onAssigned} />
      )}
    </div>
  );
}

function Tile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1">
          <DollarSign className="h-3 w-3" /> {label}
        </p>
        <p className={`text-2xl font-bold mt-1 ${accent || ""}`}>{value}</p>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function AssignInvoiceModal({ invoice, onClose, onAssigned }: {
  invoice: QuickbooksInvoice;
  onClose: () => void;
  onAssigned: (updated: QuickbooksInvoice) => void;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const pick = async (lead: LeanLead) => {
    setBusy(true);
    try {
      const updated = await api.assignQbInvoice(invoice.qb_invoice_id, lead.id);
      toast.success(`Linked to ${lead.contact_name || "lead"}`);
      onAssigned(updated);
    } catch {
      toast.error("Couldn't assign");
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border bg-background p-4 shadow-xl space-y-3" onClick={(e) => e.stopPropagation()}>
        <div>
          <p className="text-sm font-semibold">Assign invoice to a lead</p>
          <p className="text-xs text-muted-foreground">
            Invoice {invoice.doc_number || invoice.qb_invoice_id} · {invoice.customer_name || "—"} · {money(invoice.total_amount, true)}
          </p>
        </div>
        <CustomerSearchInput
          value={query}
          onChange={setQuery}
          onSelect={pick}
          disabled={busy}
          placeholder="Search a lead by name, phone, or address"
        />
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
