import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Brain, AlertTriangle, History, Loader2, Shuffle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api, getCurrentUser } from "@/lib/api";
import PersonaCard, { type Persona } from "@/components/training/PersonaCard";
import CallSession from "@/components/training/CallSession";
import CallSummary, { type TrainingSessionRow } from "@/components/training/CallSummary";
import MoodPicker from "@/components/training/MoodPicker";
import type { TrainingMood } from "@/lib/api";

type ActiveSession = {
  id: string;
  persona: Persona;
  mood: string;
};

export default function Training() {
  const [curated, setCurated] = useState<Persona[]>([]);
  const [bank, setBank] = useState<Persona[]>([]);
  const [moods, setMoods] = useState<TrainingMood[]>([]);
  const [history, setHistory] = useState<TrainingSessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [ttsConfigured, setTtsConfigured] = useState(false);
  const [pendingPersona, setPendingPersona] = useState<Persona | null>(null);
  const [active, setActive] = useState<ActiveSession | null>(null);
  const [summary, setSummary] = useState<TrainingSessionRow | null>(null);
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

  const handleSeed = async () => {
    if (!confirm("This will wipe the current real-lead persona bank and generate ~30 fresh ones from your DB (~30s + Claude tokens). Continue?")) {
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
    const pool = [...curated, ...bank];
    if (pool.length === 0) {
      toast.error("No personas available");
      return;
    }
    const pick = pool[Math.floor(Math.random() * pool.length)];
    setPendingPersona(pick);
  };

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  const handlePick = (persona: Persona) => {
    setPendingPersona(persona);
  };

  const handleStart = async (mood: string) => {
    if (!pendingPersona) return;
    const persona = pendingPersona;
    setPendingPersona(null);
    try {
      const sess = await api.createTrainingSession(persona.id, mood);
      setActive({ id: sess.id, persona, mood });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start session");
    }
  };

  const handleEnd = async () => {
    if (!active) return;
    try {
      const ended = await api.endTrainingSession(active.id);
      setSummary(ended);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to end session");
    } finally {
      setActive(null);
      refreshAll();
    }
  };

  const handleCloseSummary = () => {
    setSummary(null);
  };

  if (active) {
    return (
      <CallSession
        sessionId={active.id}
        persona={active.persona}
        mood={active.mood}
        ttsConfigured={ttsConfigured}
        onEnd={handleEnd}
      />
    );
  }

  if (summary) {
    return <CallSummary session={summary} onClose={handleCloseSummary} />;
  }

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="flex items-start justify-between">
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
          <Tabs defaultValue="curated" className="w-full">
            <div className="flex items-center justify-between mb-4">
              <TabsList>
                <TabsTrigger value="curated">
                  Curated <Badge variant="secondary" className="ml-2 text-[10px]">{curated.length}</Badge>
                </TabsTrigger>
                <TabsTrigger value="bank">
                  Real Leads <Badge variant="secondary" className="ml-2 text-[10px]">{bank.length}</Badge>
                </TabsTrigger>
                <TabsTrigger value="random">
                  <Shuffle className="h-3 w-3 mr-1.5" />
                  Random
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="curated">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {curated.map((p) => (
                  <PersonaCard key={p.id} persona={p} onPick={() => handlePick(p)} />
                ))}
              </div>
            </TabsContent>

            <TabsContent value="bank">
              <div className="flex items-center justify-between mb-4 px-1">
                <p className="text-xs text-muted-foreground">
                  Personas generated from your real (anonymized) leads. Each one is a fictional
                  homeowner consistent with a real fence shape on file.
                </p>
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
                    {bank.length === 0 ? "Seed from DB" : "Re-roll bank"}
                  </Button>
                )}
              </div>
              {bank.length === 0 ? (
                <Card>
                  <CardContent className="py-10 text-center text-sm text-muted-foreground">
                    <p>No real-lead personas yet.</p>
                    {isAdmin ? (
                      <p className="mt-1 text-xs">
                        Click "Seed from DB" to generate ~30 from your live leads.
                      </p>
                    ) : (
                      <p className="mt-1 text-xs">Ask an admin to seed the bank.</p>
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
            </TabsContent>

            <TabsContent value="random">
              <Card>
                <CardContent className="py-12 text-center">
                  <Shuffle className="h-10 w-10 mx-auto mb-3 text-muted-foreground/40" />
                  <h3 className="text-base font-semibold mb-1">Roulette mode</h3>
                  <p className="text-sm text-muted-foreground mb-5 max-w-md mx-auto">
                    Get a random persona from the entire pool (curated + real leads). Best
                    way to keep yourself sharp.
                  </p>
                  <Button onClick={handleRandom} size="lg">
                    <Shuffle className="h-4 w-4 mr-2" />
                    Spin and call
                  </Button>
                  <p className="text-xs text-muted-foreground mt-3">
                    Pool: {curated.length + bank.length} personas
                  </p>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
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
              No practice calls yet. Pick a persona above to get started.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {history.map((s) => (
              <HistoryRow
                key={s.id}
                session={s}
                onOpen={() => setSummary(s)}
              />
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

  return (
    <Card>
      <CardHeader className="py-3 px-4">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <CardTitle className="text-sm">{personaName}</CardTitle>
            <p className="text-xs text-muted-foreground truncate">{date}</p>
          </div>
          <div className="flex items-center gap-2">
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
