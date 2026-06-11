import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft } from "lucide-react";

export type TranscriptTurn = {
  role: "user" | "assistant";
  content: string;
  ts?: string;
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
  score: Record<string, unknown>;
};

function formatDuration(seconds: number): string {
  if (!seconds) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function CallSummary({
  session,
  onClose,
}: {
  session: TrainingSessionRow;
  onClose: () => void;
}) {
  const repName = "You";
  const personaName = session.persona?.name || "Persona";

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-4">
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
            <Badge variant="outline" className="text-xs">
              {formatDuration(session.duration_seconds)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground italic mb-4">
            {session.persona?.fence_context}
          </p>

          <div className="space-y-2 max-h-[60vh] overflow-y-auto">
            {session.transcript.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">
                No conversation recorded.
              </p>
            )}
            {session.transcript.map((turn, idx) => (
              <div
                key={idx}
                className={`flex ${turn.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[80%] rounded-xl px-3 py-2 text-sm ${
                    turn.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-foreground"
                  }`}
                >
                  <p className="text-[10px] uppercase tracking-wide opacity-60 mb-0.5">
                    {turn.role === "user" ? repName : personaName}
                  </p>
                  <p className="whitespace-pre-wrap">{turn.content}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Phase 4 scoring slot (empty for now) */}
          {session.score && Object.keys(session.score).length > 0 && (
            <div className="mt-6 pt-6 border-t">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                Coaching
              </p>
              <pre className="text-xs whitespace-pre-wrap">
                {JSON.stringify(session.score, null, 2)}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
