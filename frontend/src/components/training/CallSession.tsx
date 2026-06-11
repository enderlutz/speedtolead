import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Mic, MicOff, PhoneOff, Loader2, MessageCircle } from "lucide-react";
import { TrainingClient, type TranscriptEntry, type CallStatus } from "@/lib/training";
import type { Persona } from "./PersonaCard";

type Props = {
  sessionId: string;
  persona: Persona;
  mood: string;
  ttsConfigured: boolean;
  onEnd: () => void;
};

export default function CallSession({ sessionId, persona, mood, ttsConfigured, onEnd }: Props) {
  const clientRef = useRef<TrainingClient | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [status, setStatus] = useState<CallStatus>("connecting");
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const client = new TrainingClient(sessionId, {
      onTranscript: (e) => setTranscript((prev) => [...prev, e]),
      onStatus: (s) => setStatus(s),
      onError: (msg) => setError(msg),
      onClose: () => setStatus("closed"),
    });
    clientRef.current = client;
    client.connect().catch(() => {});
    return () => {
      client.cleanup();
    };
  }, [sessionId]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [transcript]);

  const handlePushToTalkDown = async () => {
    if (status === "closed") return;
    try {
      await clientRef.current?.startRecording();
      setRecording(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Mic access denied");
    }
  };

  const handlePushToTalkUp = () => {
    if (!recording) return;
    clientRef.current?.stopRecording();
    setRecording(false);
  };

  const handleEnd = () => {
    clientRef.current?.endCall();
    onEnd();
  };

  const statusLabel = (() => {
    if (error) return "Error";
    switch (status) {
      case "connecting":
        return "Connecting…";
      case "thinking":
        return `${persona.name} is thinking…`;
      case "transcribing":
        return "Transcribing…";
      case "speaking":
        return `${persona.name} is speaking`;
      case "idle":
        return recording ? "Listening…" : "Your turn";
      case "closed":
        return "Call ended";
    }
  })();

  const statusColor = (() => {
    if (error) return "bg-red-500/10 text-red-600 border-red-500/30";
    if (status === "speaking") return "bg-purple-500/10 text-purple-600 border-purple-500/30";
    if (status === "thinking" || status === "transcribing")
      return "bg-amber-500/10 text-amber-600 border-amber-500/30";
    if (recording) return "bg-rose-500/10 text-rose-600 border-rose-500/30 animate-pulse";
    return "bg-emerald-500/10 text-emerald-600 border-emerald-500/30";
  })();

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col">
      {/* Header */}
      <div className="border-b px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/20 flex items-center justify-center text-xs font-bold text-primary">
            {persona.name.split(" ").map((p) => p[0]).join("").toUpperCase()}
          </div>
          <div>
            <p className="text-sm font-semibold leading-tight">{persona.name}</p>
            <p className="text-xs text-muted-foreground">{persona.headline}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {mood && (
            <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">
              {mood}
            </Badge>
          )}
          <Badge variant="outline" className={`text-xs ${statusColor}`}>
            {(status === "thinking" || status === "transcribing") && (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            )}
            {statusLabel}
          </Badge>
          <Button variant="destructive" size="sm" onClick={handleEnd}>
            <PhoneOff className="h-4 w-4 mr-1" />
            End Call
          </Button>
        </div>
      </div>

      {/* Persona context strip */}
      <div className="border-b bg-muted/30 px-6 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Their fence:</span> {persona.fence_context}
      </div>

      {!ttsConfigured && (
        <div className="bg-amber-500/10 border-b border-amber-500/30 px-6 py-2 text-xs text-amber-700">
          ElevenLabs API key not configured — running in text-only mode. Audio will activate
          once the key is set.
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border-b border-red-500/30 px-6 py-2 text-xs text-red-600">
          {error}
        </div>
      )}

      {/* Transcript */}
      <div ref={transcriptRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
        {transcript.length === 0 && status === "connecting" && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
            <Loader2 className="h-6 w-6 animate-spin" />
            <p className="text-sm">Setting up the call…</p>
          </div>
        )}
        {transcript.length === 0 && status !== "connecting" && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 max-w-md mx-auto text-center">
            <MessageCircle className="h-8 w-8 opacity-50" />
            <p className="text-sm">
              Hold the mic button and introduce yourself. {persona.name.split(" ")[0]} will respond.
            </p>
          </div>
        )}
        {transcript.map((e, idx) => (
          <div
            key={idx}
            className={`flex ${e.speaker === "rep" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${
                e.speaker === "rep"
                  ? "bg-primary text-primary-foreground rounded-br-sm"
                  : "bg-muted text-foreground rounded-bl-sm"
              }`}
            >
              <p className="text-[10px] uppercase tracking-wide opacity-60 mb-0.5">
                {e.speaker === "rep" ? "You" : persona.name}
              </p>
              <p>{e.text}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Mic control */}
      <div className="border-t bg-card px-6 py-5">
        <div className="flex items-center justify-center">
          <button
            onMouseDown={handlePushToTalkDown}
            onMouseUp={handlePushToTalkUp}
            onMouseLeave={handlePushToTalkUp}
            onTouchStart={(ev) => {
              ev.preventDefault();
              handlePushToTalkDown();
            }}
            onTouchEnd={(ev) => {
              ev.preventDefault();
              handlePushToTalkUp();
            }}
            disabled={status === "closed" || status === "connecting" || status === "speaking"}
            className={`flex flex-col items-center justify-center gap-2 h-24 w-24 rounded-full transition-all select-none ${
              recording
                ? "bg-rose-500 text-white scale-110 shadow-2xl shadow-rose-500/40"
                : status === "closed" || status === "connecting" || status === "speaking"
                ? "bg-muted text-muted-foreground cursor-not-allowed"
                : "bg-primary text-primary-foreground hover:scale-105 shadow-lg shadow-primary/30"
            }`}
          >
            {recording ? <Mic className="h-8 w-8" /> : <MicOff className="h-8 w-8" />}
          </button>
        </div>
        <p className="text-center text-xs text-muted-foreground mt-3">
          {recording ? "Release to send" : "Hold to talk"}
        </p>
      </div>
    </div>
  );
}
