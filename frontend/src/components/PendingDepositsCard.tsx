import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type PendingDeposit } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, timeAgo } from "@/lib/utils";
import { useSSE } from "@/hooks/useSSE";
import { Clock, ExternalLink, Loader2, CheckCircle2 } from "lucide-react";

// Deposits Unpaid — leads whose $250 deposit invoice was sent but hasn't been
// paid yet. Gives Alan a single glance at outstanding deposits (money owed to
// lock in a job) without digging through the kanban or QuickBooks.
//
// Live update: when a deposit is paid, the backend publishes a "deposit_paid"
// SSE event — we re-fetch so the paid one drops off the list immediately.

const AGING_DAYS = 3; // sent longer ago than this → flag as aging

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return ms > 0 ? Math.floor(ms / 86_400_000) : 0;
}

export default function PendingDepositsCard() {
  const [deposits, setDeposits] = useState<PendingDeposit[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    api
      .getPendingDeposits()
      .then((r) => {
        setDeposits(r.deposits);
        setTotal(r.total);
      })
      .catch(() => { /* silent — keep last good data */ })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // A paid deposit should leave this list — re-pull on the same SSE event the
  // Recent Payments card listens to.
  useSSE(
    useCallback(
      (event) => {
        if (event.type === "deposit_paid") refresh();
      },
      [refresh],
    ),
  );

  return (
    <Card className="border-amber-200 bg-amber-50/30">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm sm:text-base flex items-center gap-2">
            <Clock className="h-4 w-4 text-amber-600" />
            Deposits Unpaid
          </CardTitle>
          {deposits.length > 0 && (
            <Badge className="bg-amber-600 text-white text-xs">
              {deposits.length} · {formatCurrency(total)}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading…
          </div>
        ) : deposits.length === 0 ? (
          <div className="flex flex-col items-center py-6 text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 mb-2 text-emerald-400" />
            <p className="text-sm font-medium">No deposits outstanding</p>
          </div>
        ) : (
          <ul className="divide-y max-h-[320px] overflow-y-auto">
            {deposits.map((d) => {
              const days = daysSince(d.sent_at);
              const aging = days !== null && days >= AGING_DAYS;
              return (
                <li key={d.lead_id}>
                  <Link
                    to={`/leads/${d.lead_id}`}
                    className="flex items-center gap-3 py-2 hover:bg-amber-100/40 rounded px-1 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm truncate">
                          {d.contact_name || "(no name)"}
                        </span>
                        {aging && (
                          <Badge className="bg-red-100 text-red-700 text-[10px] h-4 px-1.5">
                            {days}d waiting
                          </Badge>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {d.sent_at ? `sent ${timeAgo(d.sent_at)}` : "sent —"}
                      </div>
                    </div>
                    <div className="text-sm font-semibold text-amber-700 shrink-0">
                      {formatCurrency(d.amount)}
                    </div>
                    <ExternalLink className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
