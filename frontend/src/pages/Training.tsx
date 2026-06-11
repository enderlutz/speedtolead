import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Brain, AlertTriangle, History, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
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
  const [moods, setMoods] = useState<TrainingMood[]>([]);
  const [history, setHistory] = useState<TrainingSessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [ttsConfigured, setTtsConfigured] = useState(false);
  const [pendingPersona, setPendingPersona] = useState<Persona | null>(null);
  const [active, setActive] = useState<ActiveSession | null>(null);
  const [summary, setSummary] = useState<TrainingSessionRow | null>(null);

  const refreshAll = useCallback(async () => {
    try {
      const [list, sessions] = await Promise.all([
        api.listTrainingPersonas(),
        api.listTrainingSessions(),
      ]);
      setCurated(list.curated);
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
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
          Curated personas
        </h2>
        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {curated.map((p) => (
              <PersonaCard key={p.id} persona={p} onPick={() => handlePick(p)} />
            ))}
          </div>
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
