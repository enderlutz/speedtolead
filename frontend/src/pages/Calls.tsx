import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type CallRecordingEntry, type CallPatterns, type CallReview, getCurrentUser } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { timeAgo, formatDateTime } from "@/lib/utils";
import { toast } from "sonner";
import {
  Mic, PhoneCall,
  ChevronDown, ChevronUp, ExternalLink, RefreshCw, Star, Archive,
  ArchiveRestore, Trash2, Play, Pause, AlertTriangle, RotateCw, Search, User,
  MessageSquare, Volume2, Loader2, Sparkles,
} from "lucide-react";
import SyncedTranscriptPlayer from "@/components/SyncedTranscriptPlayer";

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
  // Scoring is on hold — keep the state slot at "all" so the filter useMemo
  // is a no-op without ripping it out.
  const [scoreFilter] = useState<ScoreFilter>("all");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const isAdmin = getCurrentUser()?.role === "admin";
  const [reviewCall, setReviewCall] = useState<CallRecordingEntry | null>(null);

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

      <CoachingProfilePanel isAdmin={isAdmin} />


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

      {/* Pattern comparison + Top Coaching Tips — hidden for now per spec. We
          only surface "what customers ask about" (the Common Customer Questions
          card below) until the scoring feature is reinstated. Avg-duration is
          tied into the same KPI tiles, so it goes with the rest. */}
      {/*
      {tab === "active" && patterns && patterns.total_calls > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          ...
        </div>
      )}
      {tab === "active" && patterns && patterns.top_coaching_tips.length > 0 && (
        <Card>...Top Coaching Tips...</Card>
      )}
      */}

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
            {/* Score filter chips hidden — scoring on hold. */}
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
                        {/* Score chip + close-likelihood hidden — scoring feature on hold.
                            Customer sentiment is still useful so we keep it. */}
                        {analysis && analysis.customer_sentiment && (
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-xs text-muted-foreground capitalize">{analysis.customer_sentiment}</span>
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
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-muted-foreground hover:text-primary"
                          onClick={(e) => { e.stopPropagation(); setReviewCall(rec); }}
                          title={isAdmin ? "Leave a coaching review" : "View coaching reviews"}
                        >
                          <MessageSquare className="h-3.5 w-3.5" />
                        </Button>
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
                      <div className="border-t px-3 py-3 space-y-3 bg-muted/10">
                        {rec.has_recording && (
                          <SyncedTranscriptPlayer
                            recordingId={rec.id}
                            segments={rec.transcript?.segments || []}
                            speakerMap={rec.transcript?.speaker_map || {}}
                            initialNotes={rec.notes || ""}
                          />
                        )}
                        {!rec.has_recording && isFailed && (
                          <p className="text-xs text-muted-foreground">
                            Transcription failed. Hit the retry icon to run it again.
                          </p>
                        )}
                        {!rec.has_recording && !isFailed && !analysis && (
                          <p className="text-xs text-muted-foreground">Still processing — playback + transcript appear when ready.</p>
                        )}
                        {/* Scoring/coaching analysis hidden for now — pattern recognition lives
                            in the "Common Customer Questions" card below the list. */}
                        {/* {analysis && <CallCoachAnalysis analysis={analysis} />} */}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Common questions/objections — pattern recognition across all calls.
          Highlights what customers keep asking about so we can preempt them. */}
      {tab === "active" && patterns && patterns.top_objections.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <PhoneCall className="h-4 w-4 text-red-600" /> Common Customer Questions
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

      {reviewCall && (
        <CallReviewModal
          recording={reviewCall}
          isAdmin={isAdmin}
          onClose={() => setReviewCall(null)}
        />
      )}
    </div>
  );
}


function CoachingProfilePanel({ isAdmin }: { isAdmin: boolean }) {
  const [profile, setProfile] = useState<Awaited<ReturnType<typeof api.getCoachingProfile>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = () => {
    api.getCoachingProfile().then((p) => setProfile(p)).catch(() => {}).finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      const p = await api.regenerateCoachingProfile();
      setProfile(p);
      toast.success("Coaching profile regenerated");
    } catch (e: any) {
      toast.error(e?.message || "Couldn't regenerate");
    } finally {
      setRegenerating(false);
    }
  };

  if (loading) return null;
  if (!profile) {
    if (!isAdmin) return null;
    return (
      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="pt-4 flex items-start gap-3">
          <Sparkles className="h-4 w-4 text-primary shrink-0 mt-0.5" />
          <div className="text-sm flex-1">
            <p className="font-medium">Self-learning coach</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Once you leave coaching reviews on a few calls, Claude will distill them into a profile of how you teach Olga and apply it to every future call analysis. No reviews yet — leave a few from any call's <MessageSquare className="inline h-3 w-3" /> button.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" /> What Claude has learned from your reviews
          </CardTitle>
          <div className="flex items-center gap-1">
            <Badge variant="outline" className="text-[10px]">{profile.reviews_count_at_gen} review{profile.reviews_count_at_gen === 1 ? "" : "s"}</Badge>
            {isAdmin && (
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleRegenerate} disabled={regenerating}>
                <RefreshCw className={`h-3 w-3 mr-1 ${regenerating ? "animate-spin" : ""}`} />
                Regenerate
              </Button>
            )}
            <button onClick={() => setExpanded((v) => !v)} className="text-muted-foreground hover:text-foreground p-1">
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Last regenerated {timeAgo(profile.created_at)} · auto-updates every 5 new reviews
        </p>
      </CardHeader>
      {expanded && (
        <CardContent className="text-xs whitespace-pre-wrap text-foreground/80 leading-relaxed">
          {profile.profile_text}
        </CardContent>
      )}
    </Card>
  );
}


type CallAnalysisData = NonNullable<CallRecordingEntry["analysis"]>;

export function CallCoachAnalysis({ analysis }: { analysis: CallAnalysisData }) {
  const stages = analysis.stage_evaluation || [];
  const violations = analysis.boundary_violations || [];
  const hasStructured = stages.length > 0 || violations.length > 0 || analysis.next_action;

  if (!hasStructured) {
    // Older analyses (pre-rubric) — fall back to the legacy rendering.
    return (
      <div className="space-y-2">
        <p className="text-sm">{analysis.summary}</p>
        {analysis.coaching_tips?.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-purple-700 mb-1">Coaching</p>
            <ul className="space-y-1">
              {analysis.coaching_tips.map((tip, i) => (
                <li key={i} className="text-xs text-muted-foreground pl-3 border-l-2 border-purple-200">{tip}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-[10px] text-muted-foreground italic">Re-analyze for stage-by-stage evaluation against the call coach rubric.</p>
      </div>
    );
  }

  const statusIcon = (s: string) => {
    if (s === "passed") return <span className="text-green-600">✓</span>;
    if (s === "skipped_okay") return <span className="text-muted-foreground">○</span>;
    if (s === "missed") return <span className="text-red-600">✗</span>;
    return <span className="text-muted-foreground">·</span>;
  };

  return (
    <div className="space-y-3">
      {analysis.summary_one_line && (
        <p className="text-sm font-medium">{analysis.summary_one_line}</p>
      )}
      {analysis.summary && analysis.summary !== analysis.summary_one_line && (
        <p className="text-xs text-muted-foreground">{analysis.summary}</p>
      )}

      {analysis.next_action && (
        <div className="rounded border-l-4 border-primary bg-primary/5 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">One thing for next call</p>
          <p className="text-sm mt-0.5">{analysis.next_action}</p>
        </div>
      )}

      {analysis.what_went_well && (
        <div className="rounded border-l-4 border-green-500 bg-green-50/50 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-green-700">What went well</p>
          <p className="text-sm mt-0.5">{analysis.what_went_well}</p>
        </div>
      )}

      {violations.length > 0 && (
        <div className="rounded border-l-4 border-red-500 bg-red-50/50 px-3 py-2 space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-red-700">Boundary violations</p>
          {violations.map((v, i) => (
            <div key={i} className="text-xs">
              <Badge variant="outline" className="text-[9px] mr-1 border-red-200 text-red-700 capitalize">{v.type.replace(/_/g, " ")}</Badge>
              <span className="text-muted-foreground">"{v.evidence}"</span>
            </div>
          ))}
        </div>
      )}

      {stages.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Stage-by-stage</p>
          <div className="space-y-1">
            {stages.map((s, i) => (
              <div key={i} className="text-xs flex items-start gap-2 px-2 py-1 rounded hover:bg-muted/30">
                <span className="shrink-0 font-mono">{statusIcon(s.status)}</span>
                <div className="flex-1 min-w-0">
                  <p className="font-medium">{s.stage}</p>
                  {s.evidence && <p className="text-muted-foreground italic truncate">"{s.evidence}"</p>}
                  {s.feedback && <p className="text-amber-700 mt-0.5">{s.feedback}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


function pickRecorderMime(): { mime: string; ext: string } {
  const candidates: { mime: string; ext: string }[] = [
    { mime: "audio/webm;codecs=opus", ext: "webm" },
    { mime: "audio/webm", ext: "webm" },
    { mime: "audio/mp4", ext: "m4a" },
    { mime: "audio/ogg;codecs=opus", ext: "ogg" },
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c.mime)) return c;
  }
  return { mime: "", ext: "webm" };
}

function CallReviewModal({
  recording, isAdmin, onClose,
}: {
  recording: CallRecordingEntry;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const [reviews, setReviews] = useState<CallReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"type" | "speak">("type");
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [recState, setRecState] = useState<"idle" | "recording" | "uploading">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioExt, setAudioExt] = useState("webm");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const ttsRef = useRef<SpeechSynthesisUtterance | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [ttsId, setTtsId] = useState<string | null>(null);

  useEffect(() => {
    api.getCallReviews(recording.id).then(setReviews).catch(() => {}).finally(() => setLoading(false));
    return () => {
      audioPlayerRef.current?.pause();
      window.speechSynthesis.cancel();
      stopRecording(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording.id]);

  const stopTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  function stopRecording(produceBlob: boolean) {
    stopTimer();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      if (!produceBlob) recorderRef.current.onstop = null;
      try { recorderRef.current.stop(); } catch { /* */ }
    }
  }

  const handleStartRecording = async () => {
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      toast.error("Recording not supported in this browser");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const { mime, ext } = pickRecorderMime();
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      setAudioExt(ext);

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stopTimer();
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: mime || "audio/webm" });
        chunksRef.current = [];
        if (blob.size > 0) setAudioBlob(blob);
        setRecState("idle");
      };

      recorder.start();
      setElapsed(0);
      setAudioBlob(null);
      setRecState("recording");
      timerRef.current = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    } catch (err: any) {
      toast.error(err?.name === "NotAllowedError" ? "Microphone permission denied" : "Could not start recording");
    }
  };

  const handleStopRecording = () => stopRecording(true);

  const handleDiscardAudio = () => {
    setAudioBlob(null);
    setElapsed(0);
  };

  const handleSubmit = async () => {
    const trimmed = text.trim();
    if (!trimmed && !audioBlob) {
      toast.error("Type a review or record one");
      return;
    }
    setSubmitting(true);
    try {
      const created = await api.createCallReview(
        recording.id,
        trimmed,
        audioBlob ?? undefined,
        `review.${audioExt}`,
      );
      setReviews((prev) => [...prev, created]);
      setText("");
      setAudioBlob(null);
      setElapsed(0);
      toast.success("Review sent — Olga has been notified");
    } catch (e: any) {
      toast.error(e?.message || "Couldn't save review");
    } finally {
      setSubmitting(false);
    }
  };

  const handleListenAudio = (rev: CallReview) => {
    if (playingId === rev.id) {
      audioPlayerRef.current?.pause();
      setPlayingId(null);
      return;
    }
    audioPlayerRef.current?.pause();
    window.speechSynthesis.cancel();
    setTtsId(null);
    const audio = new Audio(api.getReviewAudioUrl(rev.id));
    audio.onended = () => setPlayingId(null);
    audio.onerror = () => { toast.error("Couldn't play audio"); setPlayingId(null); };
    audio.play().catch(() => { toast.error("Couldn't play audio"); setPlayingId(null); });
    audioPlayerRef.current = audio;
    setPlayingId(rev.id);
  };

  const handleListenTts = (rev: CallReview) => {
    if (ttsId === rev.id) {
      window.speechSynthesis.cancel();
      setTtsId(null);
      return;
    }
    window.speechSynthesis.cancel();
    audioPlayerRef.current?.pause();
    setPlayingId(null);
    const u = new SpeechSynthesisUtterance(rev.text);
    u.onend = () => setTtsId(null);
    u.onerror = () => setTtsId(null);
    ttsRef.current = u;
    window.speechSynthesis.speak(u);
    setTtsId(rev.id);
  };

  const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-background rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-primary" /> Coaching Reviews
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            Call with {recording.contact_name || recording.caller_name || "Unknown"} · {timeAgo(recording.created_at)}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {loading ? (
            <div className="h-16 bg-muted rounded animate-pulse" />
          ) : reviews.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No reviews yet{isAdmin ? " — leave the first one below" : ""}.
            </p>
          ) : (
            reviews.map((rev) => (
              <div key={rev.id} className="border rounded-lg p-3 space-y-2 bg-muted/20">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-semibold">{rev.reviewer_name || "Admin"}</span>
                  <span className="text-muted-foreground">{formatDateTime(rev.created_at)}</span>
                </div>
                <p className="text-sm whitespace-pre-wrap">{rev.text}</p>
                <div className="flex items-center gap-2">
                  {rev.has_audio && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => handleListenAudio(rev)}
                    >
                      {playingId === rev.id ? <Pause className="h-3 w-3 mr-1" /> : <Play className="h-3 w-3 mr-1" />}
                      {playingId === rev.id ? "Pause" : "Listen (voice)"}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => handleListenTts(rev)}
                  >
                    <Volume2 className="h-3 w-3 mr-1" />
                    {ttsId === rev.id ? "Stop" : "Read aloud"}
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>

        {isAdmin && (
          <div className="p-4 border-t space-y-3 bg-muted/10">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground">New review:</span>
              <button
                onClick={() => setMode("type")}
                className={`text-xs px-2 py-1 rounded border ${mode === "type" ? "bg-primary text-primary-foreground border-primary" : "border-border"}`}
              >Type</button>
              <button
                onClick={() => setMode("speak")}
                className={`text-xs px-2 py-1 rounded border ${mode === "speak" ? "bg-primary text-primary-foreground border-primary" : "border-border"}`}
              >Speak</button>
            </div>

            {mode === "type" ? (
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Coaching feedback for Olga..."
                className="w-full border rounded-md px-3 py-2 text-sm bg-background h-24 resize-none focus:outline-none focus:ring-2 focus:ring-ring"
              />
            ) : (
              <div className="space-y-2">
                {recState === "idle" && !audioBlob && (
                  <Button onClick={handleStartRecording} variant="outline" size="sm" className="bg-red-600 hover:bg-red-700 text-white border-red-600">
                    <Mic className="h-3.5 w-3.5 mr-1" /> Start Recording
                  </Button>
                )}
                {recState === "recording" && (
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-red-600 animate-pulse" />
                    <span className="text-xs font-mono font-semibold text-red-700">{fmt(elapsed)}</span>
                    <Button onClick={handleStopRecording} variant="outline" size="sm" className="bg-red-600 hover:bg-red-700 text-white border-red-600">Stop</Button>
                  </div>
                )}
                {audioBlob && recState === "idle" && (
                  <div className="flex items-center gap-2">
                    <Badge className="bg-green-100 text-green-800 text-xs">Recorded · {fmt(elapsed)}</Badge>
                    <Button onClick={handleDiscardAudio} variant="outline" size="sm" className="text-xs">Discard</Button>
                  </div>
                )}
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Optional — typed notes alongside the recording. If empty, we'll transcribe your voice via Deepgram."
                  className="w-full border rounded-md px-3 py-2 text-xs bg-background h-16 resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
              <Button size="sm" onClick={handleSubmit} disabled={submitting}>
                {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
                {submitting ? "Sending..." : "Send to Olga"}
              </Button>
            </div>
          </div>
        )}

        {!isAdmin && (
          <div className="p-3 border-t text-xs text-muted-foreground text-center">
            Read-only view — only admins can leave reviews.
          </div>
        )}
      </div>
    </div>
  );
}
