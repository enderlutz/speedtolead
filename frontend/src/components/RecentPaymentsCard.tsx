import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type PaymentEvent } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, timeAgo } from "@/lib/utils";
import { useSSE } from "@/hooks/useSSE";
import { playSuccessSound } from "@/hooks/useNotificationSound";
import { toast } from "sonner";
import { DollarSign, ExternalLink, Loader2 } from "lucide-react";

// W2 (2026-06-08) — Recent payment activity for the Dashboard.
//
// Two purposes:
//   1. Operational — give Alan a single glance at "who just paid me" so
//      he doesn't have to log into QuickBooks to find out.
//   2. Sales narrative — when demoing the software to prospects, the
//      live ticker showing real-time payments closing the loop with QB
//      is one of the most concrete proof points that "this thing tracks
//      cash, not just contracts."
//
// Live update path:
//   • QB webhook → backend marks job/deposit paid + publishes SSE event
//     ("payment_received" for jobs, "deposit_paid" for $250 deposits).
//   • This card subscribes to both, plays a soft success sound, toasts
//     the customer + amount, and re-fetches /api/payments/recent so the
//     feed + today-tally update without a page reload.
//
// We don't expect this card to handle pagination — the dashboard only
// ever needs the 5–7 most recent events. If Alan wants full history,
// the Accounting page's job profitability + outstanding tables already
// cover that.

const PAGE_SIZE = 7;

export default function RecentPaymentsCard() {
  const [events, setEvents] = useState<PaymentEvent[]>([]);
  const [collectedToday, setCollectedToday] = useState(0);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    api
      .getRecentPayments(PAGE_SIZE)
      .then((r) => {
        setEvents(r.events);
        setCollectedToday(r.collected_today);
      })
      .catch(() => { /* silent — keep last good data */ })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // SSE: payment_received (job invoices) and deposit_paid (deposits).
  // We toast the human-facing summary then re-pull the list so we don't
  // try to construct the row locally (the backend has the source of
  // truth for amount, customer_name, etc.).
  useSSE(
    useCallback(
      (event) => {
        if (event.type === "payment_received") {
          const name = String(event.data.customer_name || "Customer");
          const amt = Number(event.data.revenue || 0);
          playSuccessSound();
          toast.success(`💵 ${name} paid ${formatCurrency(amt)}`, { duration: 6000 });
          refresh();
        } else if (event.type === "deposit_paid") {
          const name = String(event.data.customer_name || "Customer");
          const amt = Number(event.data.amount || 250);
          playSuccessSound();
          toast.success(`💵 ${name} paid ${formatCurrency(amt)} deposit`, { duration: 6000 });
          refresh();
        }
      },
      [refresh],
    ),
  );

  return (
    <Card className="border-emerald-200 bg-emerald-50/30">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm sm:text-base flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-emerald-700" />
            Recent Payments
          </CardTitle>
          {/* Today's running tally — refreshes on every SSE tick + on page mount.
              When zero we surface "—" so the tile doesn't fake a busy day. */}
          <Badge className="bg-emerald-600 text-white text-xs">
            Today: {collectedToday > 0 ? formatCurrency(collectedToday) : "—"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading…
          </div>
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No payments yet. As soon as a customer pays a QB invoice (or deposit), it'll show up here.
          </p>
        ) : (
          <ul className="divide-y">
            {events.map((e) => (
              <li key={e.id}>
                <Link
                  to={`/leads/${e.lead_id}`}
                  className="flex items-center gap-3 py-2 hover:bg-emerald-100/40 rounded px-1 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm truncate">
                        {e.customer_name || "(no name)"}
                      </span>
                      {e.source === "deposit" && (
                        <Badge className="bg-blue-100 text-blue-800 text-[10px] h-4 px-1.5">
                          Deposit
                        </Badge>
                      )}
                      {e.payment_method && e.payment_method !== "quickbooks_invoice" && (
                        <Badge variant="outline" className="text-[10px] h-4 px-1.5 capitalize">
                          {e.payment_method.replace("_", " ")}
                        </Badge>
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {e.paid_at ? timeAgo(e.paid_at) : "—"}
                    </div>
                  </div>
                  <div className="text-sm font-semibold text-emerald-700 shrink-0">
                    {formatCurrency(e.amount)}
                  </div>
                  <ExternalLink className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
