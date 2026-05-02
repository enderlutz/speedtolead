import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type CallRecordingEntry, type CallPatterns, getCurrentUser } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { timeAgo, formatDateTime } from "@/lib/utils";
import { toast } from "sonner";
import {
  Mic, PhoneCall, TrendingUp, TrendingDown, BarChart3,
  ChevronDown, ChevronUp, ExternalLink, RefreshCw, Star, Archive,
  ArchiveRestore, Trash2, Play, Pause, AlertTriangle, RotateCw, Search, User,
} from "lucide-react";

type Tab = "active" | "archived";
type ScoreFilter = "all" | "green" | "amber" | "red";

const GB = 1024 * 1024 * 1024;
const STORAGE_WARN_BYTES = 5 * GB;
const STORAGE_DANGER_BYTES = 10 * GB;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < GB) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / GB).toFixed(2)} GB`;
}

export default function Calls() {
  const [calls, setCalls] = useState<CallRecordingEntry[]>([]);
  const [patterns, setPatterns] = useState<CallPatterns | null>(null);
  const [storage, setStorage] = useState<{ total_bytes: number; active_count: number; archived_count: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("active");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [scoreFilter, setScoreFilter] = useState<ScoreFilter>("all");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const isAdmin = getCurrentUser()?.role === "admin";

  const loadCalls = () => {
    api.getAllCalls({ limit: 100, archived: tab === "archived", favoritesOnly })
      .then((r) => setCalls(r.calls))
      .catch(() => {});
  };

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.getAllCalls({ limit: 100, archived: tab === "archived", favoritesOnly }).then((r) => setCalls(r.calls)),
      api.getCallPatterns().then(setPatterns).catch(() => {}),
      api.getCallStorage().then(setStorage).catch(() => {}),
    ])
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [tab, favoritesOnly]);

  const scoreColor = (score: number) => {
    if (score >= 7) return "text-green-600 bg-green-50";
    if (score >= 4) return "text-amber-600 bg-amber-50";
    return "text-red-600 bg-red-50";
  };

  const scoreBucket = (score: number): ScoreFilter => {
    if (score >= 7) return "green";
    if (score >= 4) return "amber";
    return "red";
  };

  const formatDuration = (secs: number) => {
    if (!secs) return "—";
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const filtered = useMemo(() => {
    return calls.filter((c) => {
      if (search) {
        const s = search.toLowerCase();
        const name = (c.contact_name || c.caller_name || "").toLowerCase();
        const preview = (c.transcript_preview || "").toLowerCase();
        if (!name.includes(s) && !preview.includes(s)) return false;
      }
      if (scoreFilter !== "all" && c.analysis) {
        if (scoreBucket(c.analysis.call_score) !== scoreFilter) return false;
      }
      return true;
    });
  }, [calls, search, scoreFilter]);

  const handleToggleFavorite = async (rec: CallRecordingEntry) => {
    const next = !rec.is_favorite;
    setCalls((prev) => prev.map((c) => (c.id === rec.id ? { ...c, is_favorite: next } : c)));
    try {
      await api.setCallFavorite(rec.id, next);
    } catch {
      toast.error("Couldn't update favorite");
      setCalls((prev) => prev.map((c) => (c.id === rec.id ? { ...c, is_favorite: !next } : c)));
    }
  };

  const handleArchive = async (rec: CallRecordingEntry) => {
    if (!confirm("Archive this recording? The 'called' icon on the lead will be removed if no other recordings remain.")) return;
    try {
      await api.archiveCall(rec.id);
      toast.success("Recording archived");
      loadCalls();
      api.getCallStorage().then(setStorage).catch(() => {});
    } catch (e: any) {
      toast.error(e?.message || "Couldn't archive");
    }
  };

  const handleUnarchive = async (rec: CallRecordingEntry) => {
    try {
      await api.unarchiveCall(rec.id);
      toast.success("Recording restored");
      loadCalls();
    } catch {
      toast.error("Couldn't restore");
    }
  };

  const handleHardDelete = async (rec: CallRecordingEntry) => {
    if (!confirm("Permanently delete this recording? This cannot be undone.")) return;
    try {
      await api.hardDeleteCall(rec.id);
      toast.success("Recording deleted");
      loadCalls();
      api.getCallStorage().then(setStorage).catch(() => {});
    } catch {
      toast.error("Couldn't delete");
    }
  };

  const handleRetry = async (rec: CallRecordingEntry) => {
    try {
      await api.retryCallTranscription(rec.id);
      toast.success("Retrying transcription...");
      setTimeout(loadCalls, 5000);
      setTimeout(loadCalls, 15000);
    } catch {
      toast.error("Couldn't retry");
    }
  };

  const handlePlay = (rec: CallRecordingEntry) => {
    if (playingId === rec.id) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }
    if (audioRef.current) {
      audioRef.current.pause();
    }
    const audio = new Audio(api.getCallAudioUrl(rec.id));
    audio.onended = () => setPlayingId(null);
    audio.onerror = () => {
      toast.error("Couldn't play recording");
      setPlayingId(null);
    };
    audio.play().catch(() => {
      toast.error("Couldn't play recording");
      setPlayingId(null);
    });
    audioRef.current = audio;
    setPlayingId(rec.id);
  };

  // Stop audio on unmount
  useEffect(() => () => { audioRef.current?.pause(); }, []);

  const storageBanner = (() => {
    if (!storage || storage.total_bytes < STORAGE_WARN_BYTES) return null;
    const danger = storage.total_bytes >= STORAGE_DANGER_BYTES;
    const cls = danger
      ? "bg-red-50 border-red-300 text-red-800"
      : "bg-amber-50 border-amber-300 text-amber-800";
    return (
      <div className={`rounded-lg border-2 p-3 flex items-start gap-2 ${cls}`}>
        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
        <div className="text-sm">
          <strong>Storage:</strong> {formatBytes(storage.total_bytes)} used across {storage.active_count + storage.archived_count} recordings.
          {danger ? " Consider archiving and permanently deleting older calls." : " Approaching the recommended limit — archive old calls when convenient."}
        </div>
      </div>
    );
  })();

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Call Coach</h1>
        <p className="text-sm text-muted-foreground">
          {patterns?.total_calls || 0} calls analyzed &middot; {patterns?.closed_calls || 0} closed
          {storage && ` · ${formatBytes(storage.total_bytes)} stored`}
        </p>
      </div>

      {storageBanner}

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b">
        <button
          onClick={() => { setTab("active"); setExpandedId(null); }}
          className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === "active" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Active {storage && <span className="ml-1 text-xs text-muted-foreground">({storage.active_count})</span>}
        </button>
        <button
          onClick={() => { setTab("archived"); setExpandedId(null); }}
          className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            tab === "archived" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Archived {storage && <span className="ml-1 text-xs text-muted-foreground">({storage.archived_count})</span>}
        </button>
      </div>

      {/* Pattern comparison — active tab only */}
      {tab === "active" && patterns && patterns.total_calls > 0 && (
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
            </CardContent>
          </Card>
        </div>
      )}

      {tab === "active" && patterns && patterns.top_coaching_tips.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-purple-600" /> Top Coaching Tips (recurring)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {patterns.top_coaching_tips.slice(0, 6).map(([tip, count], i) => (
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

      {/* Filters + list */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-sm flex items-center gap-2">
              <Mic className="h-4 w-4" /> {tab === "active" ? "Recent Calls" : "Archived Calls"}
            </CardTitle>
            <Button variant="outline" size="sm" onClick={loadCalls}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="flex items-center gap-2 flex-wrap mt-2">
            <div className="relative flex-1 min-w-[180px] max-w-xs">
              <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or transcript..."
                className="pl-7 h-8 text-sm"
              />
            </div>
            <Button
              variant={favoritesOnly ? "default" : "outline"}
              size="sm"
              onClick={() => setFavoritesOnly((v) => !v)}
              className={favoritesOnly ? "bg-amber-500 hover:bg-amber-600 text-white" : ""}
            >
              <Star className={`h-3.5 w-3.5 mr-1 ${favoritesOnly ? "fill-current" : ""}`} />
              Favorites
            </Button>
            <div className="flex gap-1">
              {(["all", "green", "amber", "red"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setScoreFilter(s)}
                  className={`text-xs px-2 py-1 rounded border ${
                    scoreFilter === s ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-muted/50"
                  }`}
                >
                  {s === "all" ? "All scores" : s === "green" ? "7-10" : s === "amber" ? "4-6" : "0-3"}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-20 bg-muted rounded-lg animate-pulse" />)}</div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              {tab === "archived"
                ? "No archived calls."
                : favoritesOnly
                  ? "No favorited calls yet — star a call to flag it for training."
                  : "No calls recorded yet. Hit Record on a lead's detail page to capture one."}
            </p>
          ) : (
            <div className="space-y-2">
              {filtered.map((rec) => {
                const isExpanded = expandedId === rec.id;
                const analysis = rec.analysis;
                const isPlaying = playingId === rec.id;
                const isFailed = rec.status === "failed";
                const isPending = rec.status === "pending";
                return (
                  <div key={rec.id} className={`border rounded-lg overflow-hidden ${rec.is_favorite ? "border-amber-300" : ""}`}>
                    <div className="px-3 py-2.5 flex items-start gap-3">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleToggleFavorite(rec); }}
                        className="shrink-0 mt-0.5"
                        title={rec.is_favorite ? "Unstar" : "Star for training"}
                      >
                        <Star className={`h-4 w-4 ${rec.is_favorite ? "fill-amber-400 text-amber-400" : "text-muted-foreground hover:text-amber-400"}`} />
                      </button>
                      <button
                        onClick={() => setExpandedId(isExpanded ? null : rec.id)}
                        className="flex-1 min-w-0 text-left"
                      >
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium">{rec.contact_name || rec.caller_name || "Unknown"}</span>
                          <Badge variant="outline" className="text-[10px] capitalize">{rec.call_direction}</Badge>
                          <span className="text-xs text-muted-foreground">{formatDuration(rec.duration_seconds)}</span>
                          <span className="text-xs text-muted-foreground" title={rec.created_at}>
                            {formatDateTime(rec.created_at)} &middot; {timeAgo(rec.created_at)}
                          </span>
                          {rec.recorded_by && (
                            <Badge variant="outline" className="text-[10px] flex items-center gap-1">
                              <User className="h-2.5 w-2.5" /> {rec.recorded_by}
                            </Badge>
                          )}
                          {isPending && <Badge className="text-[10px] bg-blue-100 text-blue-800">Processing...</Badge>}
                          {isFailed && <Badge className="text-[10px] bg-red-100 text-red-800">Failed</Badge>}
                        </div>
                        {analysis && (
                          <div className="flex items-center gap-2 mt-1">
                            <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${scoreColor(analysis.call_score)}`}>
                              {analysis.call_score}/10
                            </span>
                            <span className="text-xs text-muted-foreground capitalize">{analysis.customer_sentiment}</span>
                            <Badge variant="outline" className="text-[10px] capitalize">{analysis.close_likelihood}</Badge>
                          </div>
                        )}
                        {rec.transcript_preview && (
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{rec.transcript_preview}</p>
                        )}
                      </button>
                      <div className="flex items-center gap-1 shrink-0">
                        {rec.has_recording && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            onClick={(e) => { e.stopPropagation(); handlePlay(rec); }}
                            title={isPlaying ? "Pause" : "Play"}
                          >
                            {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                          </Button>
                        )}
                        {isFailed && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            onClick={(e) => { e.stopPropagation(); handleRetry(rec); }}
                            title="Retry transcription"
                          >
                            <RotateCw className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {rec.lead_id && (
                          <Link to={`/leads/${rec.lead_id}`} onClick={(e) => e.stopPropagation()} title="Open lead">
                            <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                              <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                            </Button>
                          </Link>
                        )}
                        {tab === "active" ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 text-muted-foreground hover:text-red-600"
                            onClick={(e) => { e.stopPropagation(); handleArchive(rec); }}
                            title="Archive"
                          >
                            <Archive className="h-3.5 w-3.5" />
                          </Button>
                        ) : (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0"
                              onClick={(e) => { e.stopPropagation(); handleUnarchive(rec); }}
                              title="Restore"
                            >
                              <ArchiveRestore className="h-3.5 w-3.5" />
                            </Button>
                            {isAdmin && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0 text-muted-foreground hover:text-red-600"
                                onClick={(e) => { e.stopPropagation(); handleHardDelete(rec); }}
                                title="Delete forever (admin)"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </>
                        )}
                        <button
                          onClick={() => setExpandedId(isExpanded ? null : rec.id)}
                          className="h-8 w-8 flex items-center justify-center text-muted-foreground"
                        >
                          {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </button>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="border-t px-3 py-3 space-y-2 bg-muted/10">
                        {analysis ? (
                          <>
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
                          </>
                        ) : isFailed ? (
                          <p className="text-xs text-muted-foreground">
                            Transcription failed. Hit the retry icon to run it again.
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground">Still processing — analysis appears when transcription finishes.</p>
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

      {/* Common objections — keep the original aggregate card */}
      {tab === "active" && patterns && patterns.top_objections.length > 0 && (
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
    </div>
  );
}
