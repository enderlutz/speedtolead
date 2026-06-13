import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Brain,
  AlertTriangle,
  History,
  Loader2,
  Shuffle,
  RefreshCw,
  TrendingUp,
  GraduationCap,
  Power,
  Dices,
  Flame,
} from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { api, getCurrentUser } from "@/lib/api";
import PersonaCard, { type Persona } from "@/components/training/PersonaCard";
import { type TrainingSessionRow } from "@/components/training/CallSummary";
import CallSummary from "@/components/training/CallSummary";
import MoodPicker from "@/components/training/MoodPicker";
import type { TrainingMood } from "@/lib/api";
import { useTrainingMode } from "@/lib/training_mode_context";

export default function Training() {
  const navigate = useNavigate();
  const {
    trainingModeOn,
    enableTrainingMode,
    disableTrainingMode,
    activeCall,
    startCall,
  } = useTrainingMode();
  const [pickingRandom, setPickingRandom] = useState(false);
  const [startingGrill, setStartingGrill] = useState(false);

  // Curated archetypes are paused — we keep the state in place for now
  // so /api/training/personas can return them again if we restore them.
  const [, setCurated] = useState<Persona[]>([]);
  const [bank, setBank] = useState<Persona[]>([]);
  const [moods, setMoods] = useState<TrainingMood[]>([]);
  const [history, setHistory] = useState<TrainingSessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [ttsConfigured, setTtsConfigured] = useState(false);
  const [pendingPersona, setPendingPersona] = useState<Persona | null>(null);
  const [reviewing, setReviewing] = useState<TrainingSessionRow | null>(null);
  const [seeding, setSeeding] = useState(false);
  const user = getCurrentUser();
  const isAdmin = user?.role === "admin";

  const refreshAll = useCallback(async () => {
    try {
      const [list, sessions] = await Promise.all([
        api.listTrainingPersonas(),
        api.listTrainingSessions(),
      ]);
      setCurated(list.curated);
      setBank(list.bank);
      setMoods(list.moods);
      setTtsConfigured(list.tts_configured);
      setHistory(sessions.items);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load training data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  // After a call ends the user lands back here; refresh history to pick
  // up the new session row (which the global summary modal also shows).
  useEffect(() => {
    if (!activeCall) refreshAll();
  }, [activeCall, refreshAll]);

  const handlePick = (persona: Persona) => {
    if (!trainingModeOn) {
      toast.error("Turn on Training Mode first");
      return;
    }
    if (activeCall) {
      toast.error("End the current practice call before starting a new one");
      return;
    }
    setPendingPersona(persona);
  };

  const handleStart = async (mood: string) => {
    if (!pendingPersona) return;
    const persona = pendingPersona;
    setPendingPersona(null);
    try {
      const sess = await api.createTrainingSession(persona.id, mood);
      await startCall({
        sessionId: sess.id,
        persona,
        mood,
        ttsConfigured: sess.tts_configured,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start session");
    }
  };

  const handleSeed = async () => {
    if (
      !confirm(
        "This will wipe the current real-lead persona bank and generate ~30 fresh ones from your DB (~30s + Claude tokens). Continue?",
      )
    ) {
      return;
    }
    setSeeding(true);
    try {
      const result = await api.seedTrainingPersonaBank(30);
      toast.success(`Created ${result.created} personas (skipped ${result.skipped})`);
      if (result.errors.length > 0) {
        toast.warning(`${result.errors.length} errors during seed — check logs`);
      }
      await refreshAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Seed failed");
    } finally {
      setSeeding(false);
    }
  };

  const handleRandom = () => {
    if (!trainingModeOn) {
      toast.error("Turn on Training Mode first");
      return;
    }
    // Curated archetypes are paused; the random spin draws from the
    // conversion-modeled bank only.
    if (bank.length === 0) {
      toast.error("No personas available — build them first");
      return;
    }
    const pick = bank[Math.floor(Math.random() * bank.length)];
    setPendingPersona(pick);
  };

  const handleRandomLead = async () => {
    if (!trainingModeOn) {
      toast.error("Turn on Training Mode first");
      return;
    }
    if (activeCall) {
      toast.error("End the current practice call before starting a new one");
      return;
    }
    setPickingRandom(true);
    try {
      const r = await api.getRandomTrainingLead();
      navigate(`/leads/${r.lead_id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't find a lead");
    } finally {
      setPickingRandom(false);
    }
  };

  const handleGrillCall = async () => {
    if (!trainingModeOn) {
      toast.error("Turn on Training Mode first");
      return;
    }
    if (activeCall) {
      toast.error("End the current practice call before starting a new one");
      return;
    }
    setStartingGrill(true);
    try {
      const sess = await api.createGrillTrainingSession();
      const persona = sess.persona as unknown as Persona;
      await startCall({
        sessionId: sess.id,
        persona,
        mood: persona.default_mood || "skeptical",
        ttsConfigured: sess.tts_configured,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't start hard call");
    } finally {
      setStartingGrill(false);
    }
  };

  if (reviewing) {
    return <CallSummary session={reviewing} onClose={() => setReviewing(null)} />;
  }

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Brain className="h-5 w-5 text-primary" />
            <h1 className="text-2xl font-bold tracking-tight">Sales Training</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Practice real sales calls against an AI persona. Pick a homeowner, work through
            the objections, get better.
          </p>
        </div>
      </div>

      {/* Training Mode toggle — the big switch */}
      <Card
        className={
          trainingModeOn
            ? "border-rose-500/40 bg-rose-500/5"
            : "border-border"
        }
      >
        <CardContent className="p-5 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div
              className={`h-10 w-10 rounded-full flex items-center justify-center ${
                trainingModeOn
                  ? "bg-rose-500/15 text-rose-600"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              <GraduationCap className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-semibold leading-tight">
                Training Mode {trainingModeOn ? "is ON" : "is OFF"}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {trainingModeOn
                  ? "Red border is visible on every page. Customer-contacting actions (send estimate, SMS, payment links) are blocked. You can browse the dashboard freely while a practice call is running."
                  : "Flip this on to start a practice call. You'll still see the dashboard but customer sends will be disabled until you exit."}
              </p>
            </div>
          </div>
          <Button
            onClick={trainingModeOn ? disableTrainingMode : enableTrainingMode}
            variant={trainingModeOn ? "destructive" : "default"}
            size="lg"
            disabled={trainingModeOn && !!activeCall}
            title={trainingModeOn && activeCall ? "End the active call first" : undefined}
          >
            <Power className="h-4 w-4 mr-2" />
            {trainingModeOn ? "Exit Training Mode" : "Enter Training Mode"}
          </Button>
        </CardContent>
      </Card>

      {/* Mode 1 — Real Lead Simulation */}
      <Card>
        <CardContent className="p-5 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <Dices className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-semibold leading-tight">Real Lead Simulation</p>
              <p className="text-xs text-muted-foreground mt-0.5 max-w-2xl">
                Practice on a real lead from your CRM. The persona knows their name, address,
                and fence on file — but you have to discover which sides they want done, how
                urgent it is, their mood, and whether they've got other quotes. Browse to any
                lead and tap "Practice call".
              </p>
            </div>
          </div>
          <Button
            onClick={handleRandomLead}
            disabled={!trainingModeOn || pickingRandom || !!activeCall}
            size="lg"
          >
            {pickingRandom ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Dices className="h-4 w-4 mr-2" />
            )}
            Call a random lead
          </Button>
        </CardContent>
      </Card>

      {/* Mode 2 — Hard Mode (grill call) */}
      <Card className="border-rose-500/40 bg-gradient-to-br from-rose-500/5 to-amber-500/5">
        <CardContent className="p-5 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-full bg-rose-500/15 text-rose-600 flex items-center justify-center shrink-0">
              <Flame className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-semibold leading-tight">Hard mode — simulate a tough call</p>
              <p className="text-xs text-muted-foreground mt-0.5 max-w-2xl">
                Spin up a random challenging customer. They've done their homework, throw a competitor
                quote, ask detailed questions about materials, process, warranty — and turn passive-aggressive
                when answers are vague. A well-prepared rep can close them. An unprepared one can't.
                Different focus areas every time so it's not memorizable.
              </p>
            </div>
          </div>
          <Button
            onClick={handleGrillCall}
            disabled={!trainingModeOn || startingGrill || !!activeCall}
            size="lg"
            className="bg-rose-600 hover:bg-rose-700"
          >
            {startingGrill ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Flame className="h-4 w-4 mr-2" />
            )}
            Simulate hard call
          </Button>
        </CardContent>
      </Card>

      {history.length > 0 && <StatsCard history={history} />}

      {!ttsConfigured && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 flex items-start gap-3">
          <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
          <div className="text-xs text-amber-700">
            <p className="font-semibold mb-0.5">Voice mode pending API key</p>
            <p>
              ElevenLabs API key is not configured yet. Sessions still work in text-only mode
              — you'll see the persona's responses as text. Voice activates automatically once
              the key lands in env.
            </p>
          </div>
        </div>
      )}

      <section>
        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Personas <Badge variant="secondary" className="ml-1.5 text-[10px]">{bank.length}</Badge>
                </h2>
                <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
                  Modeled from your real conversions — leads that scheduled after getting an estimate.
                  Each persona is built from that customer's actual call transcript so the rep
                  practices the buyers they'll really face.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {bank.length > 0 && (
                  <Button onClick={handleRandom} variant="outline" size="sm">
                    <Shuffle className="h-3.5 w-3.5 mr-1.5" />
                    Spin random
                  </Button>
                )}
                {isAdmin && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleSeed}
                    disabled={seeding}
                  >
                    {seeding ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4 mr-2" />
                    )}
                    {bank.length === 0 ? "Build from conversions" : "Re-build from conversions"}
                  </Button>
                )}
              </div>
            </div>

            {bank.length === 0 ? (
              <Card>
                <CardContent className="py-10 text-center text-sm text-muted-foreground">
                  <p>No personas yet.</p>
                  {isAdmin ? (
                    <p className="mt-1 text-xs max-w-md mx-auto">
                      Click "Build from conversions" to pull personas from your last ~15 leads that
                      have a call transcript, an estimate sent, and a scheduled job.
                    </p>
                  ) : (
                    <p className="mt-1 text-xs">Ask an admin to build them.</p>
                  )}
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {bank.map((p) => (
                  <PersonaCard key={p.id} persona={p} onPick={() => handlePick(p)} />
                ))}
              </div>
            )}
          </>
        )}
      </section>

      {pendingPersona && (
        <MoodPicker
          persona={pendingPersona}
          moods={moods}
          onStart={handleStart}
          onCancel={() => setPendingPersona(null)}
        />
      )}

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3 flex items-center gap-2">
          <History className="h-3.5 w-3.5" />
          Your recent sessions
        </h2>
        {history.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No practice calls yet. {trainingModeOn ? "Pick a persona above to get started." : "Turn on Training Mode and pick a persona."}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {history.map((s) => (
              <HistoryRow key={s.id} session={s} onOpen={() => setReviewing(s)} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function HistoryRow({
  session,
  onOpen,
}: {
  session: TrainingSessionRow;
  onOpen: () => void;
}) {
  const personaName = session.persona?.name || "Unknown";
  const minutes = session.duration_seconds
    ? `${Math.floor(session.duration_seconds / 60)}:${String(session.duration_seconds % 60).padStart(2, "0")}`
    : "—";
  const date = session.started_at ? new Date(session.started_at).toLocaleString() : "";
  const score = session.score as { overall_score?: number; status?: string } | undefined;
  const showScore = score?.status === "scored" && typeof score.overall_score === "number";

  return (
    <Card>
      <CardHeader className="py-3 px-4">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <CardTitle className="text-sm">{personaName}</CardTitle>
            <p className="text-xs text-muted-foreground truncate">{date}</p>
          </div>
          <div className="flex items-center gap-2">
            {showScore && (
              <Badge
                variant="outline"
                className={
                  (score!.overall_score ?? 0) >= 7
                    ? "text-xs text-emerald-600 bg-emerald-500/10 border-emerald-500/30"
                    : (score!.overall_score ?? 0) >= 5
                    ? "text-xs text-blue-600 bg-blue-500/10 border-blue-500/30"
                    : "text-xs text-amber-600 bg-amber-500/10 border-amber-500/30"
                }
              >
                {(score!.overall_score ?? 0).toFixed(1)}/10
              </Badge>
            )}
            <Badge variant="outline" className="text-xs">
              {minutes}
            </Badge>
            <Badge variant="secondary" className="text-xs">
              {session.transcript.length} turns
            </Badge>
            <Button variant="ghost" size="sm" onClick={onOpen}>
              View
            </Button>
          </div>
        </div>
      </CardHeader>
    </Card>
  );
}

const STAT_DIMENSION_LABELS: Record<string, string> = {
  discovery: "Discovery",
  rapport: "Rapport",
  objection_handling: "Objection Handling",
  closing: "Closing",
  confidence: "Confidence",
};

function StatsCard({ history }: { history: TrainingSessionRow[] }) {
  const scored = history.filter((h) => {
    const s = h.score as { status?: string } | undefined;
    return s?.status === "scored";
  });

  if (scored.length === 0) return null;

  const overallSum = scored.reduce((acc, h) => {
    const s = h.score as { overall_score?: number };
    return acc + (s.overall_score ?? 0);
  }, 0);
  const avgOverall = overallSum / scored.length;

  const dimSums: Record<string, { sum: number; count: number }> = {};
  for (const h of scored) {
    const dims = (h.score as { dimensions?: Record<string, { score?: number }> }).dimensions || {};
    for (const [key, val] of Object.entries(dims)) {
      const v = (val as { score?: number }).score ?? 0;
      if (!dimSums[key]) dimSums[key] = { sum: 0, count: 0 };
      dimSums[key].sum += v;
      dimSums[key].count += 1;
    }
  }
  const dimAvgs = Object.entries(dimSums).map(([key, { sum, count }]) => ({
    key,
    avg: count > 0 ? sum / count : 0,
  }));
  dimAvgs.sort((a, b) => a.avg - b.avg);
  const weakest = dimAvgs[0];

  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center gap-6 flex-wrap">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-primary" />
            <p className="text-xs uppercase tracking-wide font-semibold text-muted-foreground">
              Your stats
            </p>
          </div>
          <div className="flex items-center gap-8 flex-wrap">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Avg score
              </p>
              <p className="text-xl font-bold">
                {avgOverall.toFixed(1)}
                <span className="text-sm text-muted-foreground font-normal">/10</span>
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Sessions
              </p>
              <p className="text-xl font-bold">{scored.length}</p>
            </div>
            {weakest && (
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Work on
                </p>
                <p className="text-xl font-bold">
                  {STAT_DIMENSION_LABELS[weakest.key] || weakest.key}
                  <span className="text-sm text-muted-foreground font-normal ml-1.5">
                    {weakest.avg.toFixed(1)}/10
                  </span>
                </p>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
