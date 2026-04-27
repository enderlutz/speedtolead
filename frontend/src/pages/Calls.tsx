import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type CallRecordingEntry, type CallPatterns } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/utils";
import {
  Mic, PhoneCall, TrendingUp, TrendingDown, BarChart3,
  ChevronDown, ChevronUp, ExternalLink, RefreshCw,
} from "lucide-react";

export default function Calls() {
  const [calls, setCalls] = useState<CallRecordingEntry[]>([]);
  const [patterns, setPatterns] = useState<CallPatterns | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.getAllCalls(100).then((r) => setCalls(r.calls)),
      api.getCallPatterns().then(setPatterns),
    ])
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const scoreColor = (score: number) => {
    if (score >= 7) return "text-green-600 bg-green-50";
    if (score >= 4) return "text-amber-600 bg-amber-50";
    return "text-red-600 bg-red-50";
  };

  const formatDuration = (secs: number) => {
    if (!secs) return "—";
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  if (loading) {
    return (
      <div className="p-4 sm:p-6 space-y-4">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Call Analytics</h1>
        <div className="space-y-3">{[1, 2, 3].map((i) => <div key={i} className="h-24 bg-muted rounded-lg animate-pulse" />)}</div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-4xl">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Call Analytics</h1>
        <p className="text-sm text-muted-foreground">
          {patterns?.total_calls || 0} calls analyzed &middot; {patterns?.closed_calls || 0} closed
        </p>
      </div>

      {/* Pattern Comparison */}
      {patterns && patterns.total_calls > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Card className="border-green-200">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2 text-green-700">
                <TrendingUp className="h-4 w-4" /> Closed Deals ({patterns.closed_calls})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div><p className="text-xs text-muted-foreground">Avg Score</p><p className="text-lg font-bold text-green-700">{patterns.avg_score_closed}/10</p></div>
                <div><p className="text-xs text-muted-foreground">Avg Duration</p><p className="text-lg font-bold">{patterns.avg_duration_closed}m</p></div>
              </div>
              {Object.keys(patterns.sentiment_closed).length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {Object.entries(patterns.sentiment_closed).map(([s, count]) => (
                    <Badge key={s} className="text-[10px] bg-green-100 text-green-800 capitalize">{s}: {count}</Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-red-200">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2 text-red-700">
                <TrendingDown className="h-4 w-4" /> Lost Deals ({patterns.lost_calls})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div><p className="text-xs text-muted-foreground">Avg Score</p><p className="text-lg font-bold text-red-700">{patterns.avg_score_lost}/10</p></div>
                <div><p className="text-xs text-muted-foreground">Avg Duration</p><p className="text-lg font-bold">{patterns.avg_duration_lost}m</p></div>
              </div>
              {Object.keys(patterns.sentiment_lost).length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {Object.entries(patterns.sentiment_lost).map(([s, count]) => (
                    <Badge key={s} className="text-[10px] bg-red-100 text-red-800 capitalize">{s}: {count}</Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Top Coaching Tips */}
      {patterns && patterns.top_coaching_tips.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-purple-600" /> Top Coaching Tips (recurring)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {patterns.top_coaching_tips.slice(0, 8).map(([tip, count], i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="text-xs font-bold text-purple-600 w-5 shrink-0">{i + 1}.</span>
                  <p className="text-sm flex-1">{tip}</p>
                  <Badge variant="outline" className="text-[10px] shrink-0">{count}x</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Common Objections */}
      {patterns && patterns.top_objections.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <PhoneCall className="h-4 w-4 text-red-600" /> Common Objections
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1.5">
              {patterns.top_objections.slice(0, 8).map(([obj, count], i) => {
                const pct = patterns.total_calls > 0 ? Math.round((count / patterns.total_calls) * 100) : 0;
                return (
                  <div key={i} className="flex items-center gap-2">
                    <div className="flex-1 text-sm">{obj}</div>
                    <div className="w-20 bg-muted rounded-full h-2">
                      <div className="bg-red-400 h-2 rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-xs text-muted-foreground w-10 text-right">{pct}%</span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent Calls */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Mic className="h-4 w-4" /> Recent Calls
            </CardTitle>
            <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {calls.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No calls recorded yet. Upload a recording from a lead's detail page or wait for GHL sync.
            </p>
          ) : (
            <div className="space-y-2">
              {calls.map((rec) => {
                const isExpanded = expandedId === rec.id;
                const analysis = rec.analysis;
                return (
                  <div key={rec.id} className="border rounded-lg overflow-hidden">
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : rec.id)}
                      className="w-full text-left px-3 py-2.5 flex items-center gap-3 hover:bg-muted/30 transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium">{rec.contact_name || rec.caller_name || "Unknown"}</span>
                          <Badge variant="outline" className="text-[10px] capitalize">{rec.call_direction}</Badge>
                          <span className="text-xs text-muted-foreground">{formatDuration(rec.duration_seconds)}</span>
                          <span className="text-xs text-muted-foreground">{timeAgo(rec.created_at)}</span>
                        </div>
                        {analysis && (
                          <div className="flex items-center gap-2 mt-1">
                            <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${scoreColor(analysis.call_score)}`}>
                              {analysis.call_score}/10
                            </span>
                            <span className="text-xs text-muted-foreground capitalize">
                              {analysis.customer_sentiment}
                            </span>
                            <Badge variant="outline" className="text-[10px] capitalize">{analysis.close_likelihood}</Badge>
                          </div>
                        )}
                      </div>
                      {rec.lead_id && (
                        <Link to={`/leads/${rec.lead_id}`} onClick={(e) => e.stopPropagation()}>
                          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground hover:text-primary" />
                        </Link>
                      )}
                      {isExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                    </button>

                    {isExpanded && analysis && (
                      <div className="border-t px-3 py-3 space-y-2 bg-muted/10">
                        <p className="text-sm">{analysis.summary}</p>
                        {analysis.coaching_tips.length > 0 && (
                          <div>
                            <p className="text-xs font-semibold text-purple-700 mb-1">Coaching</p>
                            <ul className="space-y-1">
                              {analysis.coaching_tips.map((tip, i) => (
                                <li key={i} className="text-xs text-muted-foreground pl-3 border-l-2 border-purple-200">{tip}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {analysis.objections.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {analysis.objections.map((obj, i) => (
                              <Badge key={i} variant="outline" className="text-[10px] text-red-700 border-red-200">{obj}</Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
