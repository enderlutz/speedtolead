import { useEffect, useState, useCallback } from "react";
import { api, type InternalDashboard, type InternalRange, type InternalBaselines } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  TrendingUp, Zap, MessageCircle, ClipboardCheck, Clock, Moon, Phone,
  DollarSign, Users, AlertTriangle, Activity, Bot, Settings2, RefreshCw,
} from "lucide-react";

const RANGES: { value: InternalRange; label: string }[] = [
  { value: "last_7_days", label: "7d" },
  { value: "this_month", label: "This mo" },
  { value: "last_month", label: "Last mo" },
  { value: "last_90_days", label: "90d" },
  { value: "all_time", label: "All" },
];

function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

function formatMinutes(m: number): string {
  if (m < 1) return "<1m";
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

export default function Internal() {
  const [data, setData] = useState<InternalDashboard | null>(null);
  const [range, setRange] = useState<InternalRange>("this_month");
  const [loading, setLoading] = useState(true);
  const [showBaselines, setShowBaselines] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.getInternalDashboard(range)
      .then(setData)
      .catch((e) => toast.error(`Failed: ${e.message || e}`))
      .finally(() => setLoading(false));
  }, [range]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">Internal</h1>
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground bg-muted px-2 py-0.5 rounded">
              Owner-only
            </span>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            Value attribution & ROI proof. Not visible to clients.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Tabs value={range} onValueChange={(v) => setRange(v as InternalRange)}>
            <TabsList className="h-8">
              {RANGES.map(r => (
                <TabsTrigger key={r.value} value={r.value} className="text-xs px-2.5">
                  {r.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowBaselines(!showBaselines)}>
            <Settings2 className="h-3.5 w-3.5 mr-1" />
            Baselines
          </Button>
        </div>
      </div>

      {/* Baselines editor (collapsible) */}
      {showBaselines && (
        <BaselinesEditor
          baselines={data?.baselines || null}
          onSaved={(b) => {
            if (data) setData({ ...data, baselines: b });
            load();
          }}
        />
      )}

      {loading && !data && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-24 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      )}

      {data && (
        <>
          {/* Hero: attributable revenue */}
          <HeroCard data={data} />

          {/* Pillar 1: Speed-to-Quote */}
          <PillarSection
            number={1}
            title="Speed-to-Quote"
            subtitle="How fast leads get a priced proposal. Industry avg: ~4 hours."
            color="from-amber-400 to-orange-500"
          >
            <Metric
              icon={Clock}
              label="Avg response"
              value={formatMinutes(data.speed.avg_response_minutes)}
              hint={
                data.baselines.baseline_avg_response_minutes
                  ? `vs ${formatMinutes(data.baselines.baseline_avg_response_minutes)} baseline`
                  : "No baseline set"
              }
              good={data.speed.avg_response_minutes < 30}
            />
            <Metric
              icon={Zap}
              label="Median"
              value={formatMinutes(data.speed.median_response_minutes)}
              good={data.speed.median_response_minutes < 15}
            />
            <Metric
              icon={Activity}
              label="Under 5 min"
              value={`${data.speed.under_5_min_pct}%`}
              hint={`${data.speed.under_5_min_count} of ${data.speed.total_quotes_sent} quotes`}
              good={data.speed.under_5_min_pct >= 50}
            />
            <Metric
              icon={Moon}
              label="After hours"
              value={formatNumber(data.speed.after_hours_count)}
              hint="System worked while you slept"
            />
          </PillarSection>

          {/* Pillar 2: Persistence-to-Close */}
          <PillarSection
            number={2}
            title="Persistence-to-Close"
            subtitle="Deals the follow-up sequences won back. Most humans give up at touch 2."
            color="from-emerald-400 to-emerald-600"
          >
            <Metric
              icon={DollarSign}
              label="Recovered revenue"
              value={formatCurrency(data.persistence.recovered_revenue)}
              hint={`${data.persistence.recovered_leads_count} leads recovered`}
              good={data.persistence.recovered_revenue > 0}
              big
            />
            <Metric
              icon={MessageCircle}
              label="Reply rate"
              value={`${data.persistence.sequence_reply_rate_pct}%`}
              hint={`${data.persistence.sequence_reply_count} replies / ${data.persistence.sequence_runs_started} sequences`}
              good={data.persistence.sequence_reply_rate_pct >= 15}
            />
            <Metric
              icon={Activity}
              label="Avg touches"
              value={data.persistence.avg_touches_per_close > 0 ? `${data.persistence.avg_touches_per_close}` : "—"}
              hint="At which step did they reply"
            />
            <Metric
              icon={Users}
              label="Active sequences"
              value={formatNumber(data.persistence.active_sequences_now)}
              hint="Running right now"
            />
          </PillarSection>

          {/* Pillar 3: Labor Cost Compression */}
          <PillarSection
            number={3}
            title="Labor Cost Compression"
            subtitle={`Actions the system took without a human. Multipliers: auto-quote=${data.labor.multipliers.auto_quote_min}m, sms=${data.labor.multipliers.followup_sms_min}m, chat=${data.labor.multipliers.chatbot_reply_min}m, correction=${data.labor.multipliers.correction_route_min}m @ $${data.labor.multipliers.hourly_rate_usd}/hr.`}
            color="from-blue-400 to-blue-600"
          >
            <Metric
              icon={DollarSign}
              label="Labor $ saved"
              value={formatCurrency(data.labor.labor_dollars_saved)}
              hint={`${data.labor.estimated_hours_saved} admin hours`}
              good={data.labor.labor_dollars_saved > 0}
              big
            />
            <Metric
              icon={ClipboardCheck}
              label="Auto-quotes"
              value={formatNumber(data.labor.auto_quotes_generated)}
            />
            <Metric
              icon={MessageCircle}
              label="Follow-up SMS"
              value={formatNumber(data.labor.followup_sms_sent)}
            />
            <Metric
              icon={Bot}
              label="Chatbot replies"
              value={formatNumber(data.labor.chatbot_resolved_count)}
              hint={`+ ${data.labor.corrections_routed} corrections routed`}
            />
          </PillarSection>

          {/* Pillar 4: Owner Time & Mental Capacity */}
          <PillarSection
            number={4}
            title="Owner Time & Mental Capacity"
            subtitle="What the owner didn't have to do, decide, or chase."
            color="from-purple-400 to-purple-600"
          >
            <Metric
              icon={Activity}
              label="Autonomous decisions"
              value={formatNumber(data.owner_time.decisions_autonomous)}
              hint="Actions taken without you"
              good
              big
            />
            <Metric
              icon={Moon}
              label="After-hours revenue"
              value={formatCurrency(data.owner_time.after_hours_revenue)}
              hint="Closed outside 8am-6pm CT"
              good={data.owner_time.after_hours_revenue > 0}
            />
            <Metric
              icon={AlertTriangle}
              label="Delays caught"
              value={formatNumber(data.owner_time.delays_caught_count)}
              hint="Before they became fires"
            />
            <Metric
              icon={TrendingUp}
              label="Avg gross margin"
              value={data.owner_time.avg_gross_margin_pct > 0 ? `${data.owner_time.avg_gross_margin_pct}%` : "—"}
              hint={`Across ${data.owner_time.completed_jobs_in_range} completed jobs`}
              good={data.owner_time.avg_gross_margin_pct >= 40}
            />
          </PillarSection>

          {/* Footer */}
          <div className="text-[10px] text-muted-foreground text-center pt-4 pb-2">
            Range: {data.range_label} · {data.start.split("T")[0]} → {data.end.split("T")[0]} ·
            Generated {new Date(data.generated_at).toLocaleString()}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Hero ──────────────────────────────────────────────────────────────────

function HeroCard({ data }: { data: InternalDashboard }) {
  const { attributable_revenue, total_revenue_closed, attribution_pct, attribution_method, current_close_rate_pct } = data.hero;

  const methodLabel = {
    conservative_50pct: "Conservative 50% (no baseline set)",
    baseline_delta: "Baseline delta",
    below_baseline: "Below baseline — system hasn't beaten pre-system rate",
  }[attribution_method];

  return (
    <Card className="border-0 shadow-md overflow-hidden bg-gradient-to-br from-[#1C2235] to-[#2a3552] text-white">
      <CardContent className="p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="text-xs uppercase tracking-widest text-white/60 font-semibold">
              Revenue attributable to system · {data.range_label}
            </p>
            <p className="text-4xl sm:text-5xl font-bold tracking-tight mt-2">
              {formatCurrency(attributable_revenue)}
            </p>
            <p className="text-xs text-white/50 mt-2">
              {(attribution_pct * 100).toFixed(1)}% of {formatCurrency(total_revenue_closed)} total closed · {methodLabel}
            </p>
          </div>

          <div className="text-right space-y-2">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-white/50">Recovered by sequences</p>
              <p className="text-xl font-semibold text-emerald-300">
                {formatCurrency(data.hero.recovered_revenue_from_sequences)}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-widest text-white/50">Close rate</p>
              <p className="text-xl font-semibold">{current_close_rate_pct}%</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Pillar Section ───────────────────────────────────────────────────────

function PillarSection({
  number, title, subtitle, color, children,
}: {
  number: number;
  title: string;
  subtitle: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-baseline gap-3 mb-2">
        <span
          className={`text-[10px] font-bold tracking-widest px-2 py-0.5 rounded text-white bg-gradient-to-br ${color}`}
        >
          PILLAR {number}
        </span>
        <h2 className="text-base font-semibold">{title}</h2>
      </div>
      <p className="text-xs text-muted-foreground mb-3">{subtitle}</p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{children}</div>
    </section>
  );
}

// ─── Metric Card ──────────────────────────────────────────────────────────

function Metric({
  icon: Icon, label, value, hint, good, big,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  hint?: string;
  good?: boolean;
  big?: boolean;
}) {
  return (
    <Card className={`border ${big ? "border-emerald-200 bg-emerald-50/30" : ""}`}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
          <Icon className={`h-3.5 w-3.5 ${good ? "text-emerald-600" : "text-muted-foreground"}`} />
        </div>
        <p className={`font-bold tracking-tight ${big ? "text-2xl" : "text-xl"} ${good ? "text-emerald-700" : ""}`}>
          {value}
        </p>
        {hint && <p className="text-[10px] text-muted-foreground mt-1">{hint}</p>}
      </CardContent>
    </Card>
  );
}

// ─── Baselines Editor ─────────────────────────────────────────────────────

function BaselinesEditor({
  baselines, onSaved,
}: {
  baselines: InternalBaselines | null;
  onSaved: (b: InternalBaselines) => void;
}) {
  const [form, setForm] = useState({
    baseline_avg_response_minutes: baselines?.baseline_avg_response_minutes?.toString() || "",
    baseline_close_rate_pct: baselines?.baseline_close_rate_pct?.toString() || "",
    baseline_monthly_revenue: baselines?.baseline_monthly_revenue?.toString() || "",
    system_launch_date: baselines?.system_launch_date || "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (baselines) {
      setForm({
        baseline_avg_response_minutes: baselines.baseline_avg_response_minutes?.toString() || "",
        baseline_close_rate_pct: baselines.baseline_close_rate_pct?.toString() || "",
        baseline_monthly_revenue: baselines.baseline_monthly_revenue?.toString() || "",
        system_launch_date: baselines.system_launch_date || "",
      });
    }
  }, [baselines]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const body: Partial<InternalBaselines> = {
        baseline_avg_response_minutes: form.baseline_avg_response_minutes ? parseFloat(form.baseline_avg_response_minutes) : null,
        baseline_close_rate_pct: form.baseline_close_rate_pct ? parseFloat(form.baseline_close_rate_pct) : null,
        baseline_monthly_revenue: form.baseline_monthly_revenue ? parseFloat(form.baseline_monthly_revenue) : null,
        system_launch_date: form.system_launch_date || null,
      };
      const saved = await api.setInternalBaselines(body);
      onSaved(saved);
      toast.success("Baselines saved");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Save failed";
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="border-amber-200 bg-amber-50/30">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start gap-2">
          <Phone className="h-4 w-4 text-amber-700 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-amber-900">Pre-system baselines</p>
            <p className="text-xs text-amber-800/80">
              Ask Alan: "Before we launched, what was your avg response time? Your close rate? Monthly revenue?"
              Without these, attribution defaults to a conservative 50% of closed revenue.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">
              Baseline avg response (minutes)
            </label>
            <Input
              type="number"
              step="0.1"
              placeholder="e.g. 240 (4 hours)"
              value={form.baseline_avg_response_minutes}
              onChange={(e) => setForm({ ...form, baseline_avg_response_minutes: e.target.value })}
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">
              Baseline close rate (%)
            </label>
            <Input
              type="number"
              step="0.1"
              placeholder="e.g. 12"
              value={form.baseline_close_rate_pct}
              onChange={(e) => setForm({ ...form, baseline_close_rate_pct: e.target.value })}
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">
              Baseline monthly revenue ($)
            </label>
            <Input
              type="number"
              step="100"
              placeholder="e.g. 15000"
              value={form.baseline_monthly_revenue}
              onChange={(e) => setForm({ ...form, baseline_monthly_revenue: e.target.value })}
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">
              System launch date
            </label>
            <Input
              type="date"
              value={form.system_launch_date}
              onChange={(e) => setForm({ ...form, system_launch_date: e.target.value })}
            />
          </div>
        </div>

        <div className="flex justify-end">
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save baselines"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
