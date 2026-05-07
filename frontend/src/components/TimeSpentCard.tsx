import { useEffect, useState, useCallback } from "react";
import { api, type TaskAllocationRow, type ReimbursementRow } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { Clock, Receipt, ChevronDown, ChevronUp, Image as ImageIcon } from "lucide-react";

type AllocRow = TaskAllocationRow & { employee_name: string };
type ReimbRow = ReimbursementRow & { employee_name: string };

interface Props {
  leadId: string;
}

export default function TimeSpentCard({ leadId }: Props) {
  const [data, setData] = useState<{
    allocations: AllocRow[];
    reimbursements: ReimbRow[];
    total_hours: number;
    total_reimbursements: number;
    pending_reimbursements: number;
  } | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(() => {
    api.getLeadTimeLogs(leadId).then(setData).catch(() => setData(null));
  }, [leadId]);

  useEffect(() => { refresh(); }, [refresh]);

  if (!data) return null;
  const { allocations, reimbursements, total_hours, total_reimbursements, pending_reimbursements } = data;
  const isEmpty = allocations.length === 0 && reimbursements.length === 0;

  // Group allocations by employee for the worker breakdown
  const byEmployee = new Map<string, AllocRow[]>();
  for (const a of allocations) {
    const list = byEmployee.get(a.employee_name) || [];
    list.push(a);
    byEmployee.set(a.employee_name, list);
  }

  // Job-total breakdown by task name
  const byTask = new Map<string, number>();
  for (const a of allocations) {
    byTask.set(a.task_name, (byTask.get(a.task_name) || 0) + a.hours);
  }
  const taskBreakdown = Array.from(byTask.entries()).sort((a, b) => b[1] - a[1]);

  return (
    <Card>
      <CardHeader className="pb-2 cursor-pointer" onClick={() => setOpen((v) => !v)}>
        <CardTitle className="text-sm flex items-center gap-2">
          <Clock className="h-4 w-4 text-primary" /> Time Spent
          {!isEmpty && (
            <span className="text-xs font-normal text-muted-foreground ml-2">
              {total_hours.toFixed(1)}h logged
              {total_reimbursements > 0 && ` · ${formatCurrency(total_reimbursements)} reimbursed`}
              {pending_reimbursements > 0 && ` · ${formatCurrency(pending_reimbursements)} pending`}
            </span>
          )}
          <span className="ml-auto">
            {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </span>
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent className="space-y-4">
          {isEmpty ? (
            <p className="text-sm text-muted-foreground text-center py-3">
              No time logged for this customer yet.
            </p>
          ) : (
            <>
              {/* Job-total breakdown (across all employees) */}
              {taskBreakdown.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-1.5">Total job breakdown</p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {taskBreakdown.map(([task, hrs]) => (
                      <div key={task} className="rounded border bg-muted/20 p-2">
                        <p className="text-[11px] text-muted-foreground capitalize">{task}</p>
                        <p className="text-sm font-semibold">{hrs.toFixed(1)}h</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Per-worker breakdown */}
              {byEmployee.size > 0 && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-1.5">Worker breakdown</p>
                  <div className="space-y-2">
                    {Array.from(byEmployee.entries()).map(([name, allocs]) => {
                      const empHours = allocs.reduce((a, x) => a + x.hours, 0);
                      return (
                        <div key={name} className="border rounded-md overflow-hidden">
                          <div className="px-3 py-1.5 bg-muted/30 flex items-center justify-between text-sm">
                            <span className="font-semibold">{name}</span>
                            <span className="text-muted-foreground">{empHours.toFixed(1)}h total</span>
                          </div>
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-left text-muted-foreground border-b">
                                <th className="px-3 py-1 font-medium">Date</th>
                                <th className="px-3 py-1 font-medium">Task</th>
                                <th className="px-3 py-1 font-medium text-right">Hours</th>
                                <th className="px-3 py-1 font-medium">Notes</th>
                              </tr>
                            </thead>
                            <tbody>
                              {allocs.map((a) => (
                                <tr key={a.id} className="border-b last:border-b-0">
                                  <td className="px-3 py-1 font-mono">{a.work_date}</td>
                                  <td className="px-3 py-1 capitalize">{a.task_name}</td>
                                  <td className="px-3 py-1 text-right font-semibold">{a.hours.toFixed(1)}</td>
                                  <td className="px-3 py-1 text-muted-foreground truncate max-w-[200px]">{a.notes || "—"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Reimbursements */}
              {reimbursements.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-1.5 flex items-center gap-1">
                    <Receipt className="h-3.5 w-3.5" /> Reimbursements
                  </p>
                  <table className="w-full text-xs border rounded-md overflow-hidden">
                    <thead>
                      <tr className="text-left text-muted-foreground border-b bg-muted/30">
                        <th className="px-3 py-1.5 font-medium">Date</th>
                        <th className="px-3 py-1.5 font-medium">Worker</th>
                        <th className="px-3 py-1.5 font-medium">Description</th>
                        <th className="px-3 py-1.5 font-medium text-right">Amount</th>
                        <th className="px-3 py-1.5 font-medium">Status</th>
                        <th className="px-3 py-1.5 font-medium">Receipt</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reimbursements.map((r) => (
                        <tr key={r.id} className="border-b last:border-b-0">
                          <td className="px-3 py-1.5 font-mono">{r.expense_date}</td>
                          <td className="px-3 py-1.5">{r.employee_name}</td>
                          <td className="px-3 py-1.5 truncate max-w-[180px]">{r.description || "—"}</td>
                          <td className="px-3 py-1.5 text-right font-semibold">{formatCurrency(r.amount)}</td>
                          <td className="px-3 py-1.5">
                            {r.status === "approved" ? (
                              <Badge className="bg-emerald-100 text-emerald-800 text-[10px]">Approved</Badge>
                            ) : r.status === "rejected" ? (
                              <Badge className="bg-red-100 text-red-800 text-[10px]">Rejected</Badge>
                            ) : (
                              <Badge className="bg-amber-100 text-amber-800 text-[10px]">Pending</Badge>
                            )}
                          </td>
                          <td className="px-3 py-1.5">
                            {r.receipt_uploaded ? (
                              <a href={api.getReceiptUrl(r.id)} target="_blank" rel="noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
                                <ImageIcon className="h-3 w-3" /> View
                              </a>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}
