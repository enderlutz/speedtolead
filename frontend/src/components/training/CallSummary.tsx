import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, Loader2, ThumbsUp, AlertTriangle, Lightbulb, Play, Pause, Square } from "lucide-react";
import { api, type TrainingAudioSegment } from "@/lib/api";

export type TranscriptTurn = {
  role: "user" | "assistant";
  content: string;
  ts?: string;
};

type DimensionScore = { score: number; note: string };

type Highlight = {
  turn_index: number;
  kind: "good" | "missed";
  note: string;
};

type Score = {
  status?: string;
  skip_reason?: string;
  dimensions?: Record<string, DimensionScore>;
  overall_score?: number;
  summary?: string;
  highlights?: Highlight[];
  next_time?: string[];
};

export type TrainingSessionRow = {
  id: string;
  persona: {
    name?: string;
    headline?: string;
    fence_context?: string;
    location?: string;
  };
  mood?: string;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  transcript: TranscriptTurn[];
  score: Score;
  audio_segments?: TrainingAudioSegment[];
};

const DIMENSION_LABELS: { key: string; label: string }[] = [
  { key: "discovery", label: "Discovery" },
  { key: "rapport", label: "Rapport" },
  { key: "objection_handling", label: "Objection Handling" },
  { key: "closing", label: "Closing" },
  { key: "confidence", label: "Confidence" },
];

function formatDuration(seconds: number): string {
  if (!seconds) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function scoreColor(score: number): string {
  if (score >= 8) return "text-emerald-600 bg-emerald-500/10 border-emerald-500/30";
  if (score >= 6) return "text-blue-600 bg-blue-500/10 border-blue-500/30";
  if (score >= 4) return "text-amber-600 bg-amber-500/10 border-amber-500/30";
  return "text-rose-600 bg-rose-500/10 border-rose-500/30";
}

export default function CallSummary({
  session: initialSession,
  onClose,
}: {
  session: TrainingSessionRow;
  onClose: () => void;
}) {
  const [session, setSession] = useState<TrainingSessionRow>(initialSession);
  const pollRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingTurn, setPlayingTurn] = useState<number | null>(null);
  const [playAllActive, setPlayAllActive] = useState(false);
  const playAllQueueRef = useRef<TrainingAudioSegment[]>([]);

  const segmentByTurn = useMemo(() => {
    const map = new Map<number, TrainingAudioSegment>();
    for (const seg of session.audio_segments || []) {
      map.set(seg.turn_index, seg);
    }
    return map;
  }, [session.audio_segments]);

  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      try {
        audioRef.current.pause();
      } catch {
        // ignore
      }
      audioRef.current = null;
    }
    setPlayingTurn(null);
    setPlayAllActive(false);
    playAllQueueRef.current = [];
  }, []);

  const playSegment = useCallback(
    (seg: TrainingAudioSegment, onEnded?: () => void) => {
      if (audioRef.current) {
        try {
          audioRef.current.pause();
        } catch {
          // ignore
        }
      }
      const audio = new Audio(seg.url);
      audioRef.current = audio;
      setPlayingTurn(seg.turn_index);
      audio.addEventListener("ended", () => {
        setPlayingTurn((cur) => (cur === seg.turn_index ? null : cur));
        if (onEnded) onEnded();
      });
      audio.addEventListener("error", () => {
        setPlayingTurn((cur) => (cur === seg.turn_index ? null : cur));
        if (onEnded) onEnded();
      });
      audio.play().catch(() => {
        setPlayingTurn(null);
        if (onEnded) onEnded();
      });
    },
    [],
  );

  const playOne = useCallback(
    (turnIndex: number) => {
      const seg = segmentByTurn.get(turnIndex);
      if (!seg) return;
      if (playingTurn === turnIndex) {
        stopAudio();
        return;
      }
      setPlayAllActive(false);
      playAllQueueRef.current = [];
      playSegment(seg);
    },
    [segmentByTurn, playingTurn, stopAudio, playSegment],
  );

  const playAll = useCallback(() => {
    const sorted = [...(session.audio_segments || [])].sort(
      (a, b) => a.turn_index - b.turn_index,
    );
    if (sorted.length === 0) return;
    if (playAllActive) {
      stopAudio();
      return;
    }
    playAllQueueRef.current = sorted;
    setPlayAllActive(true);
    const playNext = () => {
      const next = playAllQueueRef.current.shift();
      if (!next) {
        setPlayAllActive(false);
        setPlayingTurn(null);
        return;
      }
      playSegment(next, playNext);
    };
    playNext();
  }, [session.audio_segments, playAllActive, stopAudio, playSegment]);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        try {
          audioRef.current.pause();
        } catch {
          // ignore
        }
      }
    };
  }, []);

  // Poll while score is pending. Backend background task usually finishes
  // in 3-6s; cap at 30s of polling so a stuck job doesn't loop forever.
  useEffect(() => {
    const status = session.score?.status;
    if (status && status !== "pending") return;

    let attempts = 0;
    const tick = async () => {
      attempts += 1;
      try {
        const updated = await api.getTrainingSession(session.id);
        setSession(updated);
        if (updated.score?.status && updated.score.status !== "pending") {
          if (pollRef.current) {
            window.clearInterval(pollRef.current);
            pollRef.current = null;
          }
          return;
        }
      } catch {
        // ignore — keep polling
      }
      if (attempts >= 15) {
        if (pollRef.current) {
          window.clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }
    };

    pollRef.current = window.setInterval(tick, 2000);
    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [session.id, session.score?.status]);

  const repName = "You";
  const personaName = session.persona?.name || "Persona";
  const score = session.score || {};
  const isPending = score.status === "pending";
  const isScored = score.status === "scored";
  const isSkipped = score.status === "skipped";

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-4">
      <Button variant="ghost" size="sm" onClick={onClose} className="-ml-2">
        <ChevronLeft className="h-4 w-4 mr-1" />
        Back to training
      </Button>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="text-base">Call with {personaName}</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                {session.persona?.headline}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {session.mood && (
                <Badge variant="secondary" className="text-[10px] uppercase">
                  {session.mood}
                </Badge>
              )}
              <Badge variant="outline" className="text-xs">
                {formatDuration(session.duration_seconds)}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground italic mb-5">
            {session.persona?.fence_context}
          </p>

          {/* Score card */}
          {isPending && (
            <div className="rounded-lg border bg-muted/30 p-6 mb-6 flex items-center justify-center gap-3 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              Generating coaching review…
            </div>
          )}

          {isSkipped && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 mb-6 text-xs text-amber-700">
              Coaching review skipped — {score.skip_reason || "scorer unavailable"}.
            </div>
          )}

          {isScored && score.dimensions && (
            <div className="space-y-5 mb-6">
              {/* Overall + summary */}
              <div className="flex items-center gap-6 p-5 rounded-lg border bg-card">
                <div className="text-center shrink-0">
                  <div className="text-4xl font-bold tracking-tight">
                    {(score.overall_score ?? 0).toFixed(1)}
                    <span className="text-base text-muted-foreground font-normal"> /10</span>
                  </div>
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1">
                    Overall
                  </p>
                </div>
                <p className="text-sm leading-relaxed">{score.summary}</p>
              </div>

              {/* Dimensions */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {DIMENSION_LABELS.map(({ key, label }) => {
                  const d = score.dimensions?.[key];
                  if (!d) return null;
                  return (
                    <div key={key} className="rounded-lg border p-3">
                      <div className="flex items-center justify-between mb-1.5">
                        <p className="text-xs font-semibold">{label}</p>
                        <Badge variant="outline" className={`text-xs ${scoreColor(d.score)}`}>
                          {d.score}/10
                        </Badge>
                      </div>
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden mb-2">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-primary/60 to-primary"
                          style={{ width: `${(d.score / 10) * 100}%` }}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground leading-snug">{d.note}</p>
                    </div>
                  );
                })}
              </div>

              {/* Highlights */}
              {score.highlights && score.highlights.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                    Moments
                  </p>
                  <div className="space-y-2">
                    {score.highlights.map((h, idx) => {
                      const Icon = h.kind === "good" ? ThumbsUp : AlertTriangle;
                      const tone =
                        h.kind === "good"
                          ? "border-emerald-500/30 bg-emerald-500/5"
                          : "border-amber-500/30 bg-amber-500/5";
                      return (
                        <div key={idx} className={`rounded-lg border p-3 flex gap-3 ${tone}`}>
                          <Icon
                            className={`h-4 w-4 shrink-0 mt-0.5 ${
                              h.kind === "good" ? "text-emerald-600" : "text-amber-600"
                            }`}
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-muted-foreground mb-0.5">
                              Turn #{h.turn_index} · {h.kind === "good" ? "Strong" : "Missed"}
                            </p>
                            <p className="text-sm">{h.note}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Next time tips */}
              {score.next_time && score.next_time.length > 0 && (
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Lightbulb className="h-4 w-4 text-primary" />
                    <p className="text-xs font-semibold uppercase tracking-wide">Next time</p>
                  </div>
                  <ul className="space-y-1.5">
                    {score.next_time.map((tip, idx) => (
                      <li key={idx} className="text-sm leading-relaxed flex gap-2">
                        <span className="text-primary font-bold">{idx + 1}.</span>
                        <span>{tip}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Transcript */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Transcript
              </p>
              {(session.audio_segments || []).length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={playAll}
                  className="h-8 text-xs"
                >
                  {playAllActive ? (
                    <>
                      <Square className="h-3 w-3 mr-1.5 fill-current" />
                      Stop
                    </>
                  ) : (
                    <>
                      <Play className="h-3 w-3 mr-1.5 fill-current" />
                      Play full call
                    </>
                  )}
                  <Badge variant="secondary" className="ml-2 text-[10px] font-normal">
                    {(session.audio_segments || []).length} clips
                  </Badge>
                </Button>
              )}
            </div>
            <div className="space-y-2 max-h-[60vh] overflow-y-auto rounded-lg border bg-muted/20 p-3">
              {session.transcript.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No conversation recorded.
                </p>
              )}
              {session.transcript.map((turn, idx) => {
                const seg = segmentByTurn.get(idx);
                const isThisPlaying = playingTurn === idx;
                return (
                  <div
                    key={idx}
                    className={`flex ${turn.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[80%] rounded-xl px-3 py-2 text-sm ${
                        turn.role === "user"
                          ? "bg-primary text-primary-foreground"
                          : "bg-card border text-foreground"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-0.5">
                        <p className="text-[10px] uppercase tracking-wide opacity-60">
                          #{idx} · {turn.role === "user" ? repName : personaName}
                        </p>
                        {seg && (
                          <button
                            onClick={() => playOne(idx)}
                            className={`p-1 rounded-full transition-colors ${
                              turn.role === "user"
                                ? "hover:bg-primary-foreground/20"
                                : "hover:bg-muted"
                            } ${isThisPlaying ? "animate-pulse" : ""}`}
                            aria-label={isThisPlaying ? "Stop" : "Play this turn"}
                          >
                            {isThisPlaying ? (
                              <Pause className="h-3 w-3 fill-current" />
                            ) : (
                              <Play className="h-3 w-3 fill-current" />
                            )}
                          </button>
                        )}
                      </div>
                      <p className="whitespace-pre-wrap">{turn.content}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
