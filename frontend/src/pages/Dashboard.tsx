import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { api, canSeeRevenue, type KPIs, type CorrectionRequest, getCurrentUser } from "@/lib/api";
import { formatCurrency, timeAgo } from "@/lib/utils";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Users, Send, TrendingUp, DollarSign, Clock, Target, Bell, AlertCircle, HardHat, Sparkles, PartyPopper } from "lucide-react";
import { useSSE } from "@/hooks/useSSE";
import { playNewLeadSound, playUrgentSound } from "@/hooks/useNotificationSound";
import WrappedModal from "@/components/WrappedModal";
import RecentPaymentsCard from "@/components/RecentPaymentsCard";
import PendingDepositsCard from "@/components/PendingDepositsCard";
import CommandCenter from "@/components/command/CommandCenter";

type PipelineFilter = "v2" | "v1" | "all";
const FILTER_KEY = "at_dashboard_pipeline_filter";

export default function Dashboard() {
  const [kpis, setKpis] = useState<KPIs | null>(null);
  const [notifCount, setNotifCount] = useState(0);
  const [corrections, setCorrections] = useState<CorrectionRequest[]>([]);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [crewSummary, setCrewSummary] = useState<{ active_count: number; total_unpaid_balance: number; w9_missing_count: number; w9_missing_30d_count: number } | null>(null);
  const isAdmin = getCurrentUser()?.role === "admin";
  // The owner's command center (Alan, 2026-11-14) for the people who see
  // money; everyone else keeps the page as it was.
  const [cmd, setCmd] = useState(() => canSeeRevenue());
  const [cmdKey, setCmdKey] = useState(0);
  const hideCmd = useCallback(() => setCmd(false), []);
  const [filter, setFilter] = useState<PipelineFilter>(() => {
    const saved = (typeof window !== "undefined" && localStorage.getItem(FILTER_KEY)) as PipelineFilter | null;
    return saved || "v2";
  });

  // Wrapped popup state. Two flavors: weekly (Saturdays) + monthly (last day
  // of the month). Auto-pops once per period on first dashboard load. The
  // "Preview" buttons let admin re-open at any time without resetting the
  // popup's seen-flag.
  const [wrappedOpen, setWrappedOpen] = useState<null | { cadence: "weekly" | "monthly"; period?: string; manual: boolean }>(null);

  const refreshAll = useCallback(() => {
    const apiFilter = filter === "all" ? undefined : filter;
    api.getKPIs(apiFilter).then(setKpis).catch(console.error);
    api.getNotificationCount().then((d) => setNotifCount(d.count)).catch(console.error);
    api.listCorrectionRequests("pending").then(setCorrections).catch(console.error);
    if (isAdmin) {
      api.getCrewSummary().then(setCrewSummary).catch(() => {});
    }
  }, [filter, isAdmin]);

  useEffect(() => { refreshAll(); }, [refreshAll]);

  // Auto-pop the Wrapped digest. Two triggers:
  //
  // 2026-06-07: The auto-pop logic was MOVED OUT to <WrappedAutoPop /> at
  // the App layout level so it fires on any page, not just /. Reason:
  // Alan rarely opens the home dashboard, so Saturday digests went
  // unseen for weeks. The manual preview buttons below remain here and
  // use this local state — they're admin self-serve and intentionally
  // never write the "seen" flag so admin can re-preview anytime.
  const closeWrapped = () => {
    setWrappedOpen(null);
  };

  const handleResolveCorrection = async (id: string) => {
    setResolvingId(id);
    try {
      await api.resolveCorrectionRequest(id);
      setCorrections((prev) => prev.filter((c) => c.id !== id));
      toast.success("Correction marked resolved");
    } catch {
      toast.error("Failed to resolve");
    } finally {
      setResolvingId(null);
    }
  };

  const handleFilterChange = (next: PipelineFilter) => {
    setFilter(next);
    localStorage.setItem(FILTER_KEY, next);
  };

  useSSE(useCallback((event) => {
    if (["new_lead", "estimate_sent", "customer_reply", "proposal_viewed", "nudge_sent", "correction_requested"].includes(event.type)) {
      refreshAll();
      setCmdKey((k) => k + 1);
    }
    if (event.type === "new_lead") playNewLeadSound();
    if (event.type === "nudge_sent" && (event.data.count as number) >= 3) playUrgentSound();
    if (event.type === "correction_requested") {
      playUrgentSound();
      const name = event.data.contact_name as string || "Customer";
      const text = event.data.text as string || "";
      toast.error(`Requote requested by ${name}: "${text.slice(0, 80)}"`, {
        duration: 12000,
        action: { label: "Open", onClick: () => window.location.href = `/leads/${event.data.lead_id}` },
      });
    }
  }, [refreshAll]));


  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-5 sm:space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{cmd ? "What needs a decision today" : "Track progress toward doubling sales"}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {isAdmin && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setWrappedOpen({ cadence: "weekly", manual: true })}
                className="bg-gradient-to-r from-fuchsia-500/10 to-amber-400/10 border-fuchsia-200 hover:from-fuchsia-500/20 hover:to-amber-400/20"
                title="Preview this week's wrap"
              >
                <Sparkles className="h-3.5 w-3.5 mr-1" /> Week wrap
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setWrappedOpen({ cadence: "monthly", manual: true })}
                title="Preview this month's wrap"
              >
                <PartyPopper className="h-3.5 w-3.5 mr-1" /> Month wrap
              </Button>
            </>
          )}
          <Tabs value={filter} onValueChange={(v) => handleFilterChange(v as PipelineFilter)}>
            <TabsList>
              <TabsTrigger value="v2">New Leads</TabsTrigger>
              <TabsTrigger value="v1">Old Leads</TabsTrigger>
              <TabsTrigger value="all">All</TabsTrigger>
            </TabsList>
          </Tabs>
          {notifCount > 0 && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary/10 text-primary text-sm font-medium">
              <Bell className="h-3.5 w-3.5" />
              {notifCount}
            </div>
          )}
        </div>
      </div>

      {cmd && <CommandCenter onUnavailable={hideCmd} refreshKey={cmdKey} />}
      {cmd && (
        <div className="border-t pt-5">
          <h2 className="font-heading text-lg font-semibold">Work lists</h2>
          <p className="text-sm text-muted-foreground">Deposits, payments and requotes. New leads with no estimate are on Contacts.</p>
        </div>
      )}


      {/* Deposits pending (QuickBooks invoices and 7-day Stripe links) and
          the money that landed: the daily who-to-call, right under the
          estimate list (Alan, 2026-10-11). */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-5">
        <PendingDepositsCard />
        <RecentPaymentsCard />
      </div>

      {/* Wrapped is owner-only — both triggers (auto-popup + preview buttons)
          already gate on isAdmin, but the mount checks it too in case any
          future code path sets wrappedOpen. */}
      {wrappedOpen && isAdmin && (
        <WrappedModal
          cadence={wrappedOpen.cadence}
          period={wrappedOpen.period}
          onClose={closeWrapped}
        />
      )}

      {/* Requote requests — top priority alert */}
      {corrections.length > 0 && (
        <div className="rounded-xl border-2 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/60 p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-300" />
            <p className="font-bold text-sm text-red-800 dark:text-red-300">
              {corrections.length} requote request{corrections.length > 1 ? "s" : ""} need attention
            </p>
          </div>
          <div className="space-y-2">
            {corrections.map((cr) => (
              <div key={cr.id} className="flex items-start gap-3 bg-card rounded-lg p-3 border border-red-200 dark:border-red-800">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold text-foreground">{cr.contact_name || "Unknown"}</p>
                    <span className="text-xs text-muted-foreground">{timeAgo(cr.requested_at)}</span>
                    {cr.escalated_at && (
                      <Badge className="text-[10px] bg-red-600 text-white">Escalated</Badge>
                    )}
                  </div>
                  {cr.address && <p className="text-xs text-muted-foreground truncate">{cr.address}</p>}
                  <p className="text-sm text-foreground mt-1.5 italic">"{cr.text}"</p>
                </div>
                <div className="flex flex-col gap-1.5 shrink-0">
                  <Link to={`/leads/${cr.lead_id}`}>
                    <Button size="sm" className="bg-red-600 hover:bg-red-700 text-white w-full">
                      Open Lead
                    </Button>
                  </Link>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleResolveCorrection(cr.id)}
                    disabled={resolvingId === cr.id}
                  >
                    {resolvingId === cr.id ? "..." : "Resolve"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* HOT leads banner */}

      {/* KPI Cards (the command center's scorecard replaces these for the owner) */}
      {!cmd && <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3 sm:gap-4">
        <GradientKPI icon={Users} title="Leads This Month" value={kpis?.leads_this_month ?? 0} change={kpis?.leads_change_pct} gradient="from-blue-500 to-blue-600" />
        <GradientKPI icon={Send} title="Estimates Sent" value={kpis?.estimates_sent ?? 0} change={kpis?.estimates_sent_change_pct} gradient="from-emerald-500 to-emerald-600" />
        <GradientKPI icon={TrendingUp} title="Close Rate" value={kpis?.close_rate != null ? `${kpis.close_rate}%` : "—"} gradient="from-violet-500 to-violet-600" />
        <GradientKPI icon={DollarSign} title="Closed Revenue" value={kpis?.revenue_pipeline != null ? formatCurrency(kpis.revenue_pipeline) : "—"} gradient="from-amber-500 to-orange-500" />
        <GradientKPI icon={Clock} title="Avg Time to Est." value={kpis?.avg_response_minutes != null ? `${kpis.avg_response_minutes}m` : "—"} gradient="from-cyan-500 to-cyan-600" />
        {isAdmin && crewSummary && (
          <GradientKPI
            icon={HardHat}
            title="Unpaid Crew Owed"
            value={formatCurrency(crewSummary.total_unpaid_balance)}
            gradient={crewSummary.total_unpaid_balance > 0 ? "from-rose-500 to-rose-600" : "from-slate-400 to-slate-500"}
            href="/crew"
          />
        )}
        <Card className="border-0 shadow-sm bg-card">
          <CardContent className="pt-4 pb-3 px-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] sm:text-xs font-medium text-muted-foreground">2x Goal</p>
              <Target className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="text-xl sm:text-2xl font-bold">{kpis?.goal_current ?? 0}<span className="text-muted-foreground text-sm font-normal">/{kpis?.goal_target ?? 0}</span></div>
            <Progress value={kpis?.goal_progress_pct ?? 0} className="mt-2 h-2" />
            <p className="text-[10px] text-muted-foreground mt-1">{kpis?.goal_progress_pct ?? 0}% complete</p>
          </CardContent>
        </Card>
      </div>}
    </div>
  );
}

function GradientKPI({ icon: Icon, title, value, change, gradient, href }: {
  icon: React.ElementType; title: string; value: string | number; change?: number; gradient: string; href?: string;
}) {
  const content = (
    <Card className={`border-0 shadow-sm overflow-hidden ${href ? "hover:shadow-md transition-shadow cursor-pointer" : ""}`}>
      <CardContent className="pt-4 pb-3 px-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[10px] sm:text-xs font-medium text-muted-foreground">{title}</p>
          <div className={`h-8 w-8 rounded-lg bg-gradient-to-br ${gradient} flex items-center justify-center shadow-sm`}>
            <Icon className="h-4 w-4 text-white" />
          </div>
        </div>
        <div className="text-xl sm:text-2xl font-bold tracking-tight">{value}</div>
        {change !== undefined && (
          <p className={`text-[10px] sm:text-xs mt-1 font-medium ${change >= 0 ? "text-emerald-600 dark:text-emerald-300" : "text-red-500"}`}>
            {change >= 0 ? "+" : ""}{change}% vs last mo
          </p>
        )}
      </CardContent>
    </Card>
  );
  return href ? <Link to={href}>{content}</Link> : content;
}

