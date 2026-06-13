// Fullscreen "phone call" expanded view of the active practice call.
// Matches the GHL outbound-call aesthetic the user pointed at:
//   - thin top bar (back / mood / info)
//   - big persona name + headline + status text
//   - large circular avatar in the middle (pulses while persona speaks)
//   - floating transcript bubble on the left edge
//   - bottom sheet with call info + push-to-talk + end call
//
// Consumes the global TrainingMode context — no props, no internal WS
// or mic state. The persistent CallBar mounts the call across nav; this
// is the "tap to expand" detail view.

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Mic,
  MicOff,
  PhoneOff,
  Loader2,
  MessageSquare,
  ChevronLeft,
  Info,
  X,
} from "lucide-react";
import { useTrainingMode } from "@/lib/training_mode_context";

const MIC_INDICATOR_LEVELS: number[] = [0.4, 0.8, 1.2, 0.8, 0.4];

export default function CallSession() {
  const {
    activeCall,
    callStatus,
    repIsSpeaking,
    muted,
    transcript,
    error,
    expanded,
    collapse,
    toggleMute,
    endCall,
  } = useTrainingMode();

  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const lastReadCountRef = useRef(0);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the transcript to the bottom when it opens and as new
  // messages arrive while it's open. Reset the unread counter on open.
  useEffect(() => {
    if (transcriptOpen) {
      lastReadCountRef.current = transcript.length;
      const el = transcriptScrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [transcript, transcriptOpen]);

  if (!activeCall || !expanded) return null;

  const persona = activeCall.persona;
  const mood = activeCall.mood;
  const ttsConfigured = activeCall.ttsConfigured;

  const initials = persona.name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const unreadCount = transcriptOpen
    ? 0
    : Math.max(0, transcript.length - lastReadCountRef.current);

  const status = (() => {
    if (error) return { label: "Error", tone: "text-rose-600" };
    if (muted) return { label: "Muted", tone: "text-slate-500" };
    switch (callStatus) {
      case "connecting":
        return { label: "Ringing...", tone: "text-slate-500" };
      case "thinking":
        return { label: "Thinking...", tone: "text-amber-600" };
      case "transcribing":
        return { label: "Heard you, working on it...", tone: "text-amber-600" };
      case "speaking":
        return { label: "Speaking", tone: "text-purple-600" };
      case "idle":
        return repIsSpeaking
          ? { label: "You're speaking...", tone: "text-rose-600" }
          : { label: "Listening...", tone: "text-emerald-600" };
      case "closed":
        return { label: "Call ended", tone: "text-slate-500" };
      default:
        return { label: "", tone: "text-slate-500" };
    }
  })();

  const avatarPulse = callStatus === "speaking" || repIsSpeaking;
  const endDisabled = callStatus === "closed" || callStatus === "connecting";

  return (
    <div className="fixed inset-0 z-[58] bg-gradient-to-b from-slate-50 via-white to-white flex flex-col overflow-hidden">
      {/* ── Top bar ──────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          onClick={collapse}
          className="h-10 w-10 rounded-full"
          aria-label="Minimize"
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div className="flex items-center gap-2">
          {mood && (
            <Badge variant="secondary" className="text-[10px] uppercase tracking-wide font-semibold">
              {mood}
            </Badge>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setInfoOpen(true)}
            className="h-10 w-10 rounded-full"
            aria-label="Persona info"
          >
            <Info className="h-5 w-5" />
          </Button>
        </div>
      </div>

      {/* ── Persona name + status ─────────────────────────────────── */}
      <div className="text-center mt-4 px-6 shrink-0">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">
          {persona.name}
        </h1>
        <p className="text-sm text-slate-500 mt-1.5">{persona.headline}</p>
        <p className={`text-base mt-5 font-medium flex items-center justify-center gap-1.5 ${status.tone}`}>
          {(callStatus === "thinking" || callStatus === "transcribing") && (
            <Loader2 className="h-4 w-4 animate-spin" />
          )}
          {status.label}
        </p>
      </div>

      {/* ── Big avatar ────────────────────────────────────────────── */}
      <div className="flex-1 flex items-center justify-center px-6 py-8 min-h-0">
        <div className="relative">
          {avatarPulse && (
            <div className="absolute inset-0 rounded-full bg-primary/20 animate-ping" />
          )}
          <div
            className={`relative h-44 w-44 sm:h-52 sm:w-52 rounded-full bg-gradient-to-br from-primary/15 to-primary/5 border-4 border-white shadow-2xl flex items-center justify-center text-5xl sm:text-6xl font-bold text-primary transition-transform ${
              avatarPulse ? "scale-105" : ""
            }`}
          >
            {initials}
          </div>
        </div>
      </div>

      {/* ── Floating transcript bubble ────────────────────────────── */}
      <button
        onClick={() => setTranscriptOpen(true)}
        className="fixed left-4 top-1/2 -translate-y-1/2 h-14 w-14 rounded-full bg-white/95 backdrop-blur shadow-lg border border-slate-200 flex items-center justify-center hover:bg-white hover:scale-105 transition-all"
        aria-label="Open transcript"
      >
        <MessageSquare className="h-5 w-5 text-slate-600" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 h-5 min-w-5 px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center">
            {unreadCount}
          </span>
        )}
      </button>

      {/* ── Optional warnings ─────────────────────────────────────── */}
      {error && (
        <div className="mx-6 mb-3 rounded-lg bg-rose-50 border border-rose-200 p-3 text-xs text-rose-700 shrink-0">
          {error}
        </div>
      )}
      {!ttsConfigured && !error && (
        <div className="mx-6 mb-3 rounded-lg bg-amber-50 border border-amber-200 p-2.5 text-xs text-amber-700 shrink-0">
          Voice off — text-only mode (set <code className="font-mono text-[11px]">ELEVENLABS_API_KEY</code> to enable)
        </div>
      )}

      {/* ── Bottom sheet ──────────────────────────────────────────── */}
      <div className="bg-white border-t shadow-[0_-8px_32px_rgba(0,0,0,0.08)] rounded-t-3xl px-6 pt-3 pb-8 shrink-0 safe-bottom">
        {/* drag handle indicator (decorative) */}
        <div className="h-1.5 w-12 bg-slate-200 rounded-full mx-auto mb-4" />

        <div className="text-center mb-5">
          <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">
            Practice Call
          </p>
          <p className="text-xs text-slate-600 mt-1 line-clamp-1">
            {persona.fence_context}
          </p>
        </div>

        <div className="flex items-end justify-center gap-6">
          {/* Mute toggle */}
          <button
            onClick={toggleMute}
            disabled={callStatus === "closed" || callStatus === "connecting"}
            className={`flex flex-col items-center justify-center gap-1 h-16 w-16 rounded-full shadow-lg transition-colors disabled:opacity-40 ${
              muted
                ? "bg-slate-700 text-white shadow-slate-700/30 hover:bg-slate-800"
                : "bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
            aria-label={muted ? "Unmute mic" : "Mute mic"}
          >
            {muted ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
            <span className="text-[10px] font-bold uppercase tracking-wider">
              {muted ? "Muted" : "Mute"}
            </span>
          </button>

          {/* Mic activity indicator — the main "you're talking" feedback */}
          <div
            className={`flex flex-col items-center justify-center gap-1 h-24 w-24 rounded-full transition-all ${
              repIsSpeaking
                ? "bg-rose-500 text-white scale-110 shadow-2xl shadow-rose-500/40"
                : muted
                ? "bg-slate-200 text-slate-400"
                : "bg-primary/15 text-primary"
            }`}
            aria-live="polite"
            aria-label={repIsSpeaking ? "You are speaking" : muted ? "Mic muted" : "Listening for your voice"}
          >
            {/* Audio-bar indicator when speaking, mic icon when idle */}
            {repIsSpeaking ? (
              <div className="flex items-end gap-1 h-7">
                {MIC_INDICATOR_LEVELS.map((scale, i) => (
                  <span
                    key={i}
                    className="w-1 bg-white rounded-full animate-pulse"
                    style={{
                      height: `${scale * 28}px`,
                      animationDelay: `${i * 90}ms`,
                      animationDuration: "700ms",
                    }}
                  />
                ))}
              </div>
            ) : muted ? (
              <MicOff className="h-7 w-7" />
            ) : (
              <Mic className="h-7 w-7" />
            )}
            <span className="text-[10px] font-bold uppercase tracking-wider">
              {repIsSpeaking ? "Talking" : muted ? "Muted" : "Open"}
            </span>
          </div>

          {/* End call */}
          <button
            onClick={endCall}
            disabled={endDisabled}
            className="flex flex-col items-center justify-center gap-1 h-16 w-16 rounded-full bg-rose-500 text-white shadow-lg shadow-rose-500/30 hover:bg-rose-600 transition-colors disabled:opacity-50"
            aria-label="End call"
          >
            <PhoneOff className="h-6 w-6" />
            <span className="text-[10px] font-bold uppercase tracking-wider">End</span>
          </button>
        </div>

        <p className="text-center text-xs text-slate-400 mt-4">
          {muted
            ? "Mic is muted. Tap Mute to unmute."
            : callStatus === "connecting"
            ? "Connecting..."
            : callStatus === "closed"
            ? "Call ended"
            : callStatus === "speaking"
            ? `${persona.name.split(" ")[0]} is talking — interrupt anytime`
            : repIsSpeaking
            ? "Keep going..."
            : `Just talk — ${persona.name.split(" ")[0]} is listening`}
        </p>
      </div>

      {/* ── Transcript modal ──────────────────────────────────────── */}
      {transcriptOpen && (
        <SlideUpSheet onClose={() => setTranscriptOpen(false)} title="Transcript">
          <div ref={transcriptScrollRef} className="px-5 py-4 space-y-3 overflow-y-auto flex-1">
            {transcript.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-8">
                No messages yet — hold the mic to start talking.
              </p>
            ) : (
              transcript.map((e, idx) => (
                <div
                  key={idx}
                  className={`flex ${e.speaker === "rep" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${
                      e.speaker === "rep"
                        ? "bg-primary text-primary-foreground rounded-br-sm"
                        : "bg-slate-100 text-slate-800 rounded-bl-sm"
                    }`}
                  >
                    <p className="text-[10px] uppercase tracking-wide opacity-60 mb-0.5">
                      {e.speaker === "rep" ? "You" : persona.name}
                    </p>
                    <p>{e.text}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </SlideUpSheet>
      )}

      {/* ── Persona info modal ────────────────────────────────────── */}
      {infoOpen && (
        <SlideUpSheet onClose={() => setInfoOpen(false)} title={persona.name}>
          <div className="px-5 py-4 space-y-4 overflow-y-auto flex-1">
            <p className="text-sm text-slate-600 italic">{persona.headline}</p>

            <div>
              <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold mb-1.5">
                Background
              </p>
              <p className="text-sm text-slate-700">
                {persona.age} years old, lives in {persona.location}.
              </p>
            </div>

            <div>
              <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold mb-1.5">
                Their fence
              </p>
              <p className="text-sm text-slate-700">{persona.fence_context}</p>
            </div>

            {persona.traits?.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold mb-1.5">
                  Traits
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {persona.traits.map((t) => (
                    <Badge key={t} variant="secondary" className="text-xs font-normal">
                      {t}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {mood && (
              <div>
                <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold mb-1.5">
                  Current mood
                </p>
                <Badge className="text-sm bg-rose-500/10 text-rose-700 border-rose-500/30 uppercase">
                  {mood}
                </Badge>
              </div>
            )}
          </div>
        </SlideUpSheet>
      )}
    </div>
  );
}

// Shared slide-up sheet pattern — used for both Transcript and Persona Info.
// Click outside to dismiss; the sheet itself stops click propagation.
function SlideUpSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 flex items-end animate-in fade-in"
      onClick={onClose}
    >
      <div
        className="bg-white w-full rounded-t-3xl max-h-[80vh] flex flex-col animate-in slide-in-from-bottom"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-3 pb-3 border-b shrink-0">
          <div className="h-1.5 w-12 bg-slate-200 rounded-full mx-auto mb-3" />
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">{title}</h2>
            <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
