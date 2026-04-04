import { useEffect, useState } from "react";
import { api, type FunnelData, type WeeklyCloseRate, type LocationStats } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend, PieChart, Pie, Cell,
} from "recharts";
import { Zap, TrendingUp, MapPin, Clock, AlertTriangle, DollarSign, Lightbulb } from "lucide-react";

const COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];

export default function Analytics() {
  const [funnel, setFunnel] = useState<FunnelData | null>(null);
  const [weekly, setWeekly] = useState<WeeklyCloseRate[]>([]);
  const [byLocation, setByLocation] = useState<LocationStats | null>(null);
  const [speed, setSpeed] = useState<Record<string, unknown> | null>(null);
  const [patterns, setPatterns] = useState<Record<string, unknown> | null>(null);
  const [cohorts, setCohorts] = useState<Record<string, unknown>[] | null>(null);
  const [revenue, setRevenue] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    api.getFunnel().then(setFunnel).catch(console.error);
    api.getWeeklyCloseRate().then(setWeekly).catch(console.error);
    api.getByLocation().then(setByLocation).catch(console.error);
    api.getSpeedMetrics().then(setSpeed).catch(console.error);
    api.getClosePatterns().then(setPatterns).catch(console.error);
    api.getCohorts().then(setCohorts).catch(console.error);
    api.getRevenueInsights().then(setRevenue).catch(console.error);
  }, []);

  return (
    <div className="p-4 sm:p-6 space-y-4 sm:space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="text-xs sm:text-sm text-muted-foreground">Intelligence to double revenue</p>
      </div>

      <Tabs defaultValue="speed">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="speed"><Clock className="h-3.5 w-3.5 mr-1" />Speed</TabsTrigger>
          <TabsTrigger value="patterns"><TrendingUp className="h-3.5 w-3.5 mr-1" />Patterns</TabsTrigger>
          <TabsTrigger value="revenue"><DollarSign className="h-3.5 w-3.5 mr-1" />Revenue</TabsTrigger>
          <TabsTrigger value="funnel"><Zap className="h-3.5 w-3.5 mr-1" />Funnel</TabsTrigger>
        </TabsList>

        {/* ─── Speed Tab ─── */}
        <TabsContent value="speed" className="mt-4 space-y-4">
          {speed ? (
            <>
              {/* Speed KPIs */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <KPI label="Avg Response" value={`${speed.avg_minutes ?? 0}m`} />
                <KPI label="Median" value={`${speed.median_minutes ?? 0}m`} />
                <KPI label="Under 5 min" value={`${speed.under_5_min_pct ?? 0}%`} good={(speed.under_5_min_pct as number) >= 50} />
                <KPI label="Total Sent" value={String(speed.total_sent ?? 0)} />
              </div>

              {/* Time buckets chart */}
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Response Time Distribution</CardTitle></CardHeader>
                <CardContent>
                  {speed.buckets && (
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={Object.entries(speed.buckets as Record<string, number>).map(([k, v]) => ({
                        name: k.replace("_", "-").replace("under", "<"),
                        count: v,
                      }))}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                        <YAxis tick={{ fontSize: 10 }} width={30} />
                        <Tooltip />
                        <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              {/* Speed by dimension */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {["by_location", "by_zone", "by_priority"].map((key) => {
                  const data = speed[key] as Record<string, { avg_minutes: number; count: number }> | undefined;
                  if (!data) return null;
                  return (
                    <Card key={key}>
                      <CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">{key.replace("by_", "By ")}</CardTitle></CardHeader>
                      <CardContent className="space-y-2">
                        {Object.entries(data).map(([name, d]) => (
                          <div key={name} className="flex justify-between text-sm">
                            <span>{name}</span>
                            <span className="font-medium">{d.avg_minutes}m <span className="text-xs text-muted-foreground">({d.count})</span></span>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

              {/* Recent estimates with time */}
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Recent Response Times</CardTitle></CardHeader>
                <CardContent>
                  <div className="space-y-1 max-h-[250px] overflow-y-auto">
                    {((speed.recent as Array<Record<string, unknown>>) || []).map((r, i) => (
                      <div key={i} className="flex items-center justify-between text-sm px-2 py-1.5 rounded hover:bg-muted/30">
                        <div className="min-w-0">
                          <span className="font-medium truncate">{String(r.contact_name)}</span>
                          <span className="text-xs text-muted-foreground ml-2">{String(r.location)}</span>
                        </div>
                        <Badge className={`text-xs ${(r.minutes as number) <= 5 ? "bg-green-100 text-green-800" : (r.minutes as number) <= 15 ? "bg-yellow-100 text-yellow-800" : "bg-red-100 text-red-800"}`}>
                          {String(r.minutes)}m
                        </Badge>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </>
          ) : <Loading />}
        </TabsContent>

        {/* ─── Patterns Tab ─── */}
        <TabsContent value="patterns" className="mt-4 space-y-4">
          {patterns ? (
            <>
              {/* Speed vs Close insight */}
              {patterns.speed_vs_close && (
                <Card className="border-primary/20 bg-primary/5">
                  <CardContent className="pt-4">
                    <div className="flex items-start gap-3">
                      <Lightbulb className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                      <p className="text-sm">{(patterns.speed_vs_close as Record<string, unknown>).insight as string}</p>
                    </div>
                  </CardContent>
                </Card>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* By Zone */}
                <PatternCard title="By Zone" icon={<MapPin className="h-4 w-4" />} data={patterns.by_zone as Record<string, PatternRow>} />
                {/* By Sqft */}
                <PatternCard title="By Square Footage" icon={<TrendingUp className="h-4 w-4" />} data={patterns.by_sqft as Record<string, PatternRow>} />
                {/* By Age */}
                <PatternCard title="By Fence Age" data={patterns.by_age as Record<string, PatternRow>} />
                {/* By Priority */}
                <PatternCard title="By Priority" data={patterns.by_priority as Record<string, PatternRow>} />
                {/* By Location */}
                <PatternCard title="By Location" data={patterns.by_location as Record<string, PatternRow>} />
                {/* By Day */}
                <PatternCard title="By Day of Week" data={patterns.by_day_of_week as Record<string, PatternRow>} hideRevenue />
              </div>

              {/* Top ZIP codes */}
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Top ZIP Codes by Revenue</CardTitle></CardHeader>
                <CardContent>
                  <div className="space-y-1">
                    {((patterns.top_zip_codes as Array<Record<string, unknown>>) || []).map((z, i) => (
                      <div key={i} className="flex items-center justify-between text-sm px-2 py-1.5 rounded hover:bg-muted/30">
                        <span className="font-mono font-medium">{String(z.zip)}</span>
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-muted-foreground">{String(z.total)} leads</span>
                          <Badge variant="outline" className="text-xs">{String(z.close_rate)}%</Badge>
                          <span className="font-medium">{formatCurrency(z.revenue as number)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </>
          ) : <Loading />}
        </TabsContent>

        {/* ─── Revenue Tab ─── */}
        <TabsContent value="revenue" className="mt-4 space-y-4">
          {revenue ? (
            <>
              {/* Revenue KPIs */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <KPI label="Total Potential" value={formatCurrency(revenue.total_potential_revenue as number)} />
                <KPI label="Captured" value={formatCurrency(revenue.total_captured_revenue as number)} good />
                <KPI label="Missed" value={formatCurrency(revenue.missed_revenue as number)} />
                <KPI label="Capture Rate" value={`${revenue.capture_rate_pct}%`} good={(revenue.capture_rate_pct as number) >= 50} />
              </div>

              {/* Actionable Insights */}
              <Card className="border-yellow-200 bg-yellow-50/50">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2"><Lightbulb className="h-4 w-4 text-yellow-600" /> Actionable Insights</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2">
                    {((revenue.actionable_insights as string[]) || []).map((insight, i) => (
                      <li key={i} className="text-sm flex items-start gap-2">
                        <AlertTriangle className="h-4 w-4 text-yellow-600 shrink-0 mt-0.5" />
                        <span>{insight}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>

              {/* Why leads aren't closing */}
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Why Leads Aren't Closing</CardTitle></CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {((revenue.top_missed_reasons as Array<{ reason: string; count: number }>) || []).map((r, i) => (
                      <div key={i} className="flex items-center justify-between">
                        <span className="text-sm truncate mr-3">{r.reason}</span>
                        <Badge variant="outline" className="shrink-0">{r.count} leads</Badge>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Zone opportunity gaps */}
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Revenue Gaps by Zone</CardTitle></CardHeader>
                <CardContent>
                  {((revenue.zone_opportunity_gaps as Array<Record<string, unknown>>) || []).map((z, i) => (
                    <div key={i} className="flex items-center justify-between py-2 border-b last:border-0">
                      <div>
                        <span className="text-sm font-medium">{String(z.zone)} Zone</span>
                        <p className="text-xs text-muted-foreground">
                          Captured {formatCurrency(z.captured as number)} of {formatCurrency(z.potential as number)} ({String(z.capture_rate)}%)
                        </p>
                      </div>
                      <span className="font-bold text-red-600">{formatCurrency(z.gap as number)} gap</span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </>
          ) : <Loading />}
        </TabsContent>

        {/* ─── Funnel Tab ─── */}
        <TabsContent value="funnel" className="mt-4 space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Close Rate (8 Weeks)</CardTitle></CardHeader>
              <CardContent>
                {weekly.length > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={weekly}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="week_start" tick={{ fontSize: 10 }} />
                      <YAxis tick={{ fontSize: 10 }} unit="%" width={35} />
                      <Tooltip /><Legend wrapperStyle={{ fontSize: 12 }} />
                      <Line type="monotone" dataKey="close_rate" name="Close %" stroke="#22c55e" strokeWidth={2} />
                    </LineChart>
                  </ResponsiveContainer>
                ) : <Empty />}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Conversion Funnel</CardTitle></CardHeader>
              <CardContent>
                {funnel ? (
                  <div className="space-y-4">
                    <ResponsiveContainer width="100%" height={160}>
                      <BarChart data={[
                        { name: "Leads", value: funnel.total_leads },
                        { name: "Estimated", value: funnel.estimated },
                        { name: "Sent", value: funnel.sent },
                        { name: "Viewed", value: funnel.viewed ?? 0 },
                      ]} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis type="number" tick={{ fontSize: 10 }} />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={70} />
                        <Tooltip />
                        <Bar dataKey="value" fill="#3b82f6" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : <Loading />}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Leads & Sent by Week</CardTitle></CardHeader>
              <CardContent>
                {weekly.length > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={weekly}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="week_start" tick={{ fontSize: 10 }} />
                      <YAxis tick={{ fontSize: 10 }} width={30} />
                      <Tooltip /><Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="leads" name="Leads" fill="#94a3b8" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="sent" name="Sent" fill="#22c55e" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : <Empty />}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">By Location</CardTitle></CardHeader>
              <CardContent>
                {byLocation ? (
                  <div className="space-y-3">
                    {Object.entries(byLocation).map(([name, stats]) => (
                      <div key={name} className="flex items-center justify-between p-3 rounded-md border">
                        <div>
                          <p className="text-sm font-medium">{name}</p>
                          <p className="text-xs text-muted-foreground">{stats.leads} leads, {stats.sent} sent</p>
                        </div>
                        <Badge variant="outline" className="text-sm font-bold">{stats.close_rate}%</Badge>
                      </div>
                    ))}
                  </div>
                ) : <Loading />}
              </CardContent>
            </Card>

            {/* Cohort Analysis */}
            {cohorts && cohorts.length > 0 && (
              <Card className="lg:col-span-2">
                <CardHeader className="pb-2"><CardTitle className="text-sm">Weekly Cohort Analysis</CardTitle></CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left py-2 px-2 font-medium">Week</th>
                          <th className="text-right py-2 px-2 font-medium">Leads</th>
                          <th className="text-right py-2 px-2 font-medium">Estimated</th>
                          <th className="text-right py-2 px-2 font-medium">Sent</th>
                          <th className="text-right py-2 px-2 font-medium">Est %</th>
                          <th className="text-right py-2 px-2 font-medium">Sent %</th>
                          <th className="text-right py-2 px-2 font-medium">Avg Resp</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cohorts.map((c, i) => (
                          <tr key={i} className="border-b hover:bg-muted/30">
                            <td className="py-1.5 px-2 font-medium">{String(c.week)}</td>
                            <td className="py-1.5 px-2 text-right">{String(c.total)}</td>
                            <td className="py-1.5 px-2 text-right">{String(c.estimated)}</td>
                            <td className="py-1.5 px-2 text-right">{String(c.sent)}</td>
                            <td className="py-1.5 px-2 text-right">{String(c.est_rate)}%</td>
                            <td className="py-1.5 px-2 text-right font-medium">{String(c.sent_rate)}%</td>
                            <td className="py-1.5 px-2 text-right">{String(c.avg_response_min)}m</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// --- Shared components ---

interface PatternRow { total: number; sent: number; close_rate: number; revenue?: number; avg_revenue?: number }

function PatternCard({ title, icon, data, hideRevenue }: { title: string; icon?: React.ReactNode; data?: Record<string, PatternRow>; hideRevenue?: boolean }) {
  if (!data) return null;
  const sorted = Object.entries(data).sort((a, b) => b[1].close_rate - a[1].close_rate);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">{icon}{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-1.5">
          {sorted.map(([name, d]) => (
            <div key={name} className="flex items-center justify-between text-sm">
              <span className="truncate mr-2">{name}</span>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-muted-foreground">{d.total} leads</span>
                <Badge className={`text-[10px] ${d.close_rate >= 60 ? "bg-green-100 text-green-800" : d.close_rate >= 30 ? "bg-yellow-100 text-yellow-800" : "bg-red-100 text-red-800"}`}>
                  {d.close_rate}%
                </Badge>
                {!hideRevenue && d.revenue !== undefined && (
                  <span className="text-xs font-medium w-16 text-right">{formatCurrency(d.revenue)}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function KPI({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <p className="text-[10px] sm:text-xs text-muted-foreground">{label}</p>
        <p className={`text-lg sm:text-xl font-bold ${good ? "text-green-600" : ""}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

function Loading() {
  return <p className="text-sm text-muted-foreground py-8 text-center">Loading...</p>;
}

function Empty() {
  return <p className="text-sm text-muted-foreground py-8 text-center">No data yet</p>;
}
