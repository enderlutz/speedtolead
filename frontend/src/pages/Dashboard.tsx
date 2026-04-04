import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { api, type KPIs, type Lead, type PendingEstimate, type ActivityEvent } from "@/lib/api";
import { formatCurrency, timeAgo } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Users, Send, TrendingUp, DollarSign, Clock, Target, Bell, Flame, ArrowRight, Zap, CheckCircle2 } from "lucide-react";
import { useSSE } from "@/hooks/useSSE";
import { playNewLeadSound, playUrgentSound } from "@/hooks/useNotificationSound";

const PRIORITY_CLS: Record<string, string> = {
  HOT: "bg-red-500/10 text-red-600 border-red-200",
  HIGH: "bg-orange-500/10 text-orange-600 border-orange-200",
  MEDIUM: "bg-blue-500/10 text-blue-600 border-blue-200",
  LOW: "bg-gray-500/10 text-gray-500 border-gray-200",
};

const APPROVAL_CLS: Record<string, { bg: string; text: string; label: string }> = {
  green: { bg: "bg-emerald-500/10", text: "text-emerald-700", label: "Ready" },
  yellow: { bg: "bg-amber-500/10", text: "text-amber-700", label: "Add-ons" },
  red: { bg: "bg-red-500/10", text: "text-red-700", label: "Review" },
};

export default function Dashboard() {
  const [kpis, setKpis] = useState<KPIs | null>(null);
  const [recentLeads, setRecentLeads] = useState<Lead[]>([]);
  const [pending, setPending] = useState<PendingEstimate[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [notifCount, setNotifCount] = useState(0);

  const refreshAll = useCallback(() => {
    api.getKPIs().then(setKpis).catch(console.error);
    api.getLeads().then((leads) => setRecentLeads(leads.slice(0, 8))).catch(console.error);
    api.getPendingAction().then(setPending).catch(console.error);
    api.getRecentActivity(10).then(setActivity).catch(console.error);
    api.getNotificationCount().then((d) => setNotifCount(d.count)).catch(console.error);
  }, []);

  useEffect(() => { refreshAll(); }, [refreshAll]);

  useSSE(useCallback((event) => {
    if (["new_lead", "estimate_sent", "customer_reply", "proposal_viewed", "nudge_sent"].includes(event.type)) refreshAll();
    if (event.type === "new_lead") playNewLeadSound();
    if (event.type === "nudge_sent" && (event.data.count as number) >= 3) playUrgentSound();
  }, [refreshAll]));

  const hotLeads = pending.filter((p) => p.priority === "HOT");
  const greenReady = pending.filter((p) => p.approval_status === "green");
  const redReview = pending.filter((p) => p.approval_status === "red");

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-5 sm:space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">Track progress toward doubling sales</p>
        </div>
        {notifCount > 0 && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary/10 text-primary text-sm font-medium">
            <Bell className="h-3.5 w-3.5" />
            {notifCount}
          </div>
        )}
      </div>

      {/* HOT leads banner */}
      {hotLeads.length > 0 && (
        <div className="rounded-xl bg-gradient-to-r from-red-500 to-orange-500 p-4 text-white shadow-lg shadow-red-500/20">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-white/20 flex items-center justify-center shrink-0">
              <Flame className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-sm">{hotLeads.length} HOT lead{hotLeads.length > 1 ? "s" : ""} need attention!</p>
              <p className="text-xs text-white/80 truncate">{hotLeads.map((h) => h.contact_name).join(", ")}</p>
            </div>
            <Link to="/leads">
              <Button size="sm" className="bg-white/20 hover:bg-white/30 text-white border-0 backdrop-blur-sm">
                View <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </div>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3 sm:gap-4">
        <GradientKPI icon={Users} title="Leads This Month" value={kpis?.leads_this_month ?? 0} change={kpis?.leads_change_pct} gradient="from-blue-500 to-blue-600" />
        <GradientKPI icon={Send} title="Estimates Sent" value={kpis?.estimates_sent ?? 0} change={kpis?.estimates_sent_change_pct} gradient="from-emerald-500 to-emerald-600" />
        <GradientKPI icon={TrendingUp} title="Close Rate" value={`${kpis?.close_rate ?? 0}%`} change={kpis?.close_rate_change} gradient="from-violet-500 to-violet-600" />
        <GradientKPI icon={DollarSign} title="Revenue" value={formatCurrency(kpis?.revenue_pipeline ?? 0)} gradient="from-amber-500 to-orange-500" />
        <GradientKPI icon={Clock} title="Avg Response" value={`${kpis?.avg_response_minutes ?? 0}m`} gradient="from-cyan-500 to-cyan-600" />
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
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-5">
        {/* Pending Action Queue */}
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-2 px-5 pt-5">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Zap className="h-4 w-4 text-amber-500" />
                Pending Action
              </CardTitle>
              {pending.length > 0 && (
                <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600">{pending.length}</span>
              )}
            </div>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            {pending.length === 0 ? (
              <div className="flex flex-col items-center py-6 text-muted-foreground">
                <CheckCircle2 className="h-8 w-8 mb-2 text-emerald-400" />
                <p className="text-sm font-medium">All caught up</p>
              </div>
            ) : (
              <div className="space-y-1 max-h-[320px] overflow-y-auto">
                {[...greenReady, ...pending.filter((p) => p.approval_status === "yellow"), ...redReview].map((est) => {
                  const cfg = APPROVAL_CLS[est.approval_status] || APPROVAL_CLS.red;
                  return (
                    <Link
                      key={est.id}
                      to={`/leads/${est.lead_id}`}
                      className="flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-muted/60 transition-colors group"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate group-hover:text-primary transition-colors">{est.contact_name || "Unknown"}</p>
                        <p className="text-xs text-muted-foreground truncate">{est.address || "No address"}</p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Badge className={`text-[10px] border-0 ${cfg.bg} ${cfg.text}`}>{cfg.label}</Badge>
                        <Badge className={`text-[10px] border ${PRIORITY_CLS[est.priority] || ""}`}>{est.priority}</Badge>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Activity Feed */}
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-2 px-5 pt-5">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Bell className="h-4 w-4 text-primary" />
              Recent Activity
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            {activity.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No activity yet</p>
            ) : (
              <div className="space-y-3 max-h-[320px] overflow-y-auto">
                {activity.map((ev) => (
                  <div key={ev.id} className="flex items-start gap-3 text-sm">
                    <div className="h-2 w-2 rounded-full bg-primary mt-2 shrink-0 ring-4 ring-primary/10" />
                    <div className="min-w-0">
                      <p className="text-xs leading-relaxed">{ev.detail}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">{timeAgo(ev.created_at)}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent leads */}
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-2 px-5 pt-5">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold">Recent Leads</CardTitle>
            <Link to="/leads" className="text-xs text-primary hover:underline font-medium">View all</Link>
          </div>
        </CardHeader>
        <CardContent className="px-5 pb-5">
          {recentLeads.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No leads yet</p>
          ) : (
            <div className="space-y-0.5">
              {recentLeads.map((lead) => (
                <Link
                  key={lead.id}
                  to={`/leads/${lead.id}`}
                  className="flex flex-col sm:flex-row sm:items-center justify-between px-3 py-2.5 rounded-lg hover:bg-muted/50 transition-colors gap-1 group"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate group-hover:text-primary transition-colors">{lead.contact_name || "Unknown"}</p>
                    <p className="text-xs text-muted-foreground truncate">{lead.address || "No address"}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="outline" className="text-[10px] py-0">{lead.location_label}</Badge>
                    <Badge className={`text-[10px] border ${PRIORITY_CLS[lead.priority] || PRIORITY_CLS.MEDIUM}`}>{lead.priority}</Badge>
                    <span className="text-[10px] text-muted-foreground w-14 text-right">{timeAgo(lead.created_at)}</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function GradientKPI({ icon: Icon, title, value, change, gradient }: {
  icon: React.ElementType; title: string; value: string | number; change?: number; gradient: string;
}) {
  return (
    <Card className="border-0 shadow-sm overflow-hidden">
      <CardContent className="pt-4 pb-3 px-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[10px] sm:text-xs font-medium text-muted-foreground">{title}</p>
          <div className={`h-8 w-8 rounded-lg bg-gradient-to-br ${gradient} flex items-center justify-center shadow-sm`}>
            <Icon className="h-4 w-4 text-white" />
          </div>
        </div>
        <div className="text-xl sm:text-2xl font-bold tracking-tight">{value}</div>
        {change !== undefined && (
          <p className={`text-[10px] sm:text-xs mt-1 font-medium ${change >= 0 ? "text-emerald-600" : "text-red-500"}`}>
            {change >= 0 ? "+" : ""}{change}% vs last mo
          </p>
        )}
      </CardContent>
    </Card>
  );
}
