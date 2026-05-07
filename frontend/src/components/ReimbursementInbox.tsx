import { useEffect, useState, useCallback } from "react";
import { api, type ReimbursementRow } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import { toast } from "sonner";
import { Receipt, Image as ImageIcon, Check, X, Trash2, Inbox, Clock, CheckCircle2, XCircle } from "lucide-react";

type Filter = "pending" | "approved" | "rejected" | "all";

const FILTER_LABELS: Record<Filter, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  all: "All",
};

export default function ReimbursementInbox() {
  const [filter, setFilter] = useState<Filter>("pending");
  const [rows, setRows] = useState<ReimbursementRow[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    const params = filter === "all" ? {} : { status: filter };
    api.listReimbursements(params)
      .then((r) => setRows(r.reimbursements))
      .catch(() => toast.error("Failed to load reimbursements"))
      .finally(() => setLoading(false));
    // Always fetch the pending count for the inbox header
    api.listReimbursements({ status: "pending" })
      .then((r) => setPendingCount(r.reimbursements.length))
      .catch(() => {});
  }, [filter]);

  useEffect(() => { refresh(); }, [refresh]);

  const setStatus = async (id: string, status: "approved" | "rejected") => {
    try {
      await api.updateReimbursement(id, { status });
      toast.success(`Marked ${status}`);
      refresh();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update");
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this reimbursement permanently?")) return;
    try {
      await api.deleteReimbursement(id);
      refresh();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to delete");
    }
  };

  const totalAmount = rows.reduce((a, r) => a + r.amount, 0);

  return (
    <div className="space-y-4">
      {/* Summary banner — always shows pending count even when filter is approved */}
      <Card className={pendingCount > 0 ? "border-amber-300 bg-amber-50/50" : ""}>
        <CardContent className="pt-4 flex items-center gap-3 flex-wrap">
          <Inbox className={`h-5 w-5 ${pendingCount > 0 ? "text-amber-600" : "text-muted-foreground"}`} />
          {pendingCount > 0 ? (
            <p className="text-sm">
              <strong>{pendingCount}</strong> reimbursement{pendingCount === 1 ? "" : "s"} awaiting your approval
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">All caught up — no pending reimbursements</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Receipt className="h-4 w-4 text-muted-foreground" /> Reimbursements
            </CardTitle>
            <div className="inline-flex border rounded-md text-xs">
              {(Object.keys(FILTER_LABELS) as Filter[]).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1.5 border-r last:border-r-0 transition-colors ${
                    filter === f ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                  }`}
                >
                  {FILTER_LABELS[f]}
                  {f === "pending" && pendingCount > 0 && filter !== "pending" && (
                    <span className="ml-1 px-1 rounded bg-amber-200 text-amber-900 text-[10px]">{pendingCount}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {loading ? (
            <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-12 bg-muted rounded animate-pulse" />)}</div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              {filter === "pending" ? "No pending reimbursements." : `No ${FILTER_LABELS[filter].toLowerCase()} reimbursements.`}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Worker</th>
                  <th className="px-3 py-2 font-medium">Customer</th>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 font-medium text-right">Amount</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Receipt</th>
                  <th className="px-3 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b hover:bg-muted/30">
                    <td className="px-3 py-2.5 font-mono text-xs">{r.expense_date}</td>
                    <td className="px-3 py-2.5">{r.employee_name || "—"}</td>
                    <td className="px-3 py-2.5 truncate max-w-[160px]">{r.customer_name || "—"}</td>
                    <td className="px-3 py-2.5 truncate max-w-[220px]">
                      {r.description || <span className="text-muted-foreground italic">no description</span>}
                      {r.notes && <p className="text-[11px] text-muted-foreground italic truncate">{r.notes}</p>}
                    </td>
                    <td className="px-3 py-2.5 text-right font-semibold">{formatCurrency(r.amount)}</td>
                    <td className="px-3 py-2.5">
                      {r.status === "approved" ? (
                        <Badge className="bg-emerald-100 text-emerald-800 text-[10px] inline-flex items-center gap-1">
                          <CheckCircle2 className="h-2.5 w-2.5" /> Approved
                        </Badge>
                      ) : r.status === "rejected" ? (
                        <Badge className="bg-red-100 text-red-800 text-[10px] inline-flex items-center gap-1">
                          <XCircle className="h-2.5 w-2.5" /> Rejected
                        </Badge>
                      ) : (
                        <Badge className="bg-amber-100 text-amber-800 text-[10px] inline-flex items-center gap-1">
                          <Clock className="h-2.5 w-2.5" /> Pending
                        </Badge>
                      )}
                      {r.approved_at && r.approved_by && (
                        <p className="text-[10px] text-muted-foreground mt-0.5">by {r.approved_by}</p>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {r.receipt_uploaded ? (
                        <a
                          href={api.getReceiptUrl(r.id)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline inline-flex items-center gap-1"
                        >
                          <ImageIcon className="h-3.5 w-3.5" /> View
                        </a>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="inline-flex gap-1">
                        {r.status === "pending" && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-emerald-700 border-emerald-200 hover:bg-emerald-50"
                              onClick={() => setStatus(r.id, "approved")}
                            >
                              <Check className="h-3.5 w-3.5 mr-0.5" /> Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-red-700 border-red-200 hover:bg-red-50"
                              onClick={() => setStatus(r.id, "rejected")}
                            >
                              <X className="h-3.5 w-3.5 mr-0.5" /> Reject
                            </Button>
                          </>
                        )}
                        <button
                          onClick={() => remove(r.id)}
                          className="text-muted-foreground hover:text-red-700 p-1"
                          title="Delete"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {!loading && rows.length > 0 && (
            <div className="mt-3 pt-3 border-t text-sm flex justify-end gap-4 text-muted-foreground">
              <span>{rows.length} entr{rows.length === 1 ? "y" : "ies"}</span>
              <span>Total: <strong className="text-foreground">{formatCurrency(totalAmount)}</strong></span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
