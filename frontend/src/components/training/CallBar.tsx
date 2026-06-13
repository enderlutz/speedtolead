import { Mic, MicOff, PhoneOff, Loader2, Maximize2, Volume2 } from "lucide-react";
import { useTrainingMode } from "@/lib/training_mode_context";
import { Badge } from "@/components/ui/badge";

/**
 * Persistent docked bar at the bottom of the screen while a practice
 * call is active. Survives navigation — the rep can be on Lead Detail,
 * Calendar, Pricing, etc. while a call runs.
 *
 * Hides itself when:
 *  - no active call
 *  - the expanded fullscreen view is open (CallSession takes over)
 */
export default function CallBar() {
  const {
    activeCall,
    callStatus,
    repIsSpeaking,
    muted,
    expanded,
    expand,
    toggleMute,
    endCall,
  } = useTrainingMode();

  if (!activeCall || expanded) return null;

  const persona = activeCall.persona;
  const initials = persona.name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const statusLabel = (() => {
    if (muted) return "Muted";
    switch (callStatus) {
      case "connecting":
        return "Connecting…";
      case "thinking":
        return `${persona.name.split(" ")[0]} thinking…`;
      case "transcribing":
        return "Transcribing…";
      case "speaking":
        return `${persona.name.split(" ")[0]} speaking`;
      case "idle":
        return repIsSpeaking ? "You're speaking" : "Listening…";
      case "closed":
        return "Ended";
      default:
        return "";
    }
  })();

  const statusTone = (() => {
    if (muted) return "text-slate-300";
    if (callStatus === "speaking") return "text-purple-200";
    if (callStatus === "thinking" || callStatus === "transcribing") return "text-amber-200";
    if (repIsSpeaking) return "text-rose-200";
    return "text-emerald-200";
  })();

  const muteDisabled = callStatus === "closed" || callStatus === "connecting";

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-[55] border-t border-rose-700 bg-slate-900 text-white shadow-2xl"
      role="dialog"
      aria-label="Practice call in progress"
    >
      <div className="max-w-screen-2xl mx-auto px-4 py-2.5 flex items-center gap-3">
        {/* Persona identity */}
        <button
          onClick={expand}
          className="flex items-center gap-3 min-w-0 hover:bg-white/5 rounded-md px-2 py-1 -ml-2 transition-colors"
          aria-label="Open full call view"
        >
          <div className="h-9 w-9 shrink-0 rounded-full bg-gradient-to-br from-rose-500/40 to-rose-700/40 border border-rose-500/30 flex items-center justify-center text-xs font-bold">
            {initials}
          </div>
          <div className="min-w-0 text-left">
            <p className="text-sm font-semibold leading-tight truncate">{persona.name}</p>
            <p className={`text-[11px] truncate ${statusTone} flex items-center gap-1`}>
              {(callStatus === "thinking" || callStatus === "transcribing") && (
                <Loader2 className="h-3 w-3 animate-spin" />
              )}
              {statusLabel}
            </p>
          </div>
        </button>

        <Badge variant="outline" className="hidden sm:inline-flex text-[10px] uppercase border-rose-500/40 text-rose-200">
          {activeCall.mood || "practice"}
        </Badge>

        <div className="flex-1" />

        {/* Live mic-activity pill (informational, not a button) */}
        <div
          className={`hidden md:inline-flex items-center gap-2 h-10 px-4 rounded-full text-sm font-medium select-none ${
            repIsSpeaking
              ? "bg-rose-500/20 text-rose-100"
              : muted
              ? "bg-slate-700 text-slate-300"
              : callStatus === "speaking"
              ? "bg-purple-500/20 text-purple-100"
              : "bg-emerald-500/20 text-emerald-100"
          }`}
        >
          {repIsSpeaking ? (
            <Mic className="h-4 w-4" />
          ) : muted ? (
            <MicOff className="h-4 w-4" />
          ) : callStatus === "speaking" ? (
            <Volume2 className="h-4 w-4" />
          ) : (
            <Mic className="h-4 w-4" />
          )}
          {repIsSpeaking
            ? "Listening to you"
            : muted
            ? "Muted"
            : callStatus === "speaking"
            ? `${persona.name.split(" ")[0]} speaking`
            : "Open mic"}
        </div>

        {/* Mute toggle */}
        <button
          onClick={toggleMute}
          disabled={muteDisabled}
          className={`flex items-center gap-1.5 h-10 px-3 rounded-full font-medium text-sm transition-all ${
            muted
              ? "bg-slate-700 text-white"
              : "bg-white/10 text-white hover:bg-white/20"
          } ${muteDisabled ? "opacity-40 cursor-not-allowed" : ""}`}
          aria-label={muted ? "Unmute" : "Mute"}
        >
          {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          <span className="hidden sm:inline">{muted ? "Unmute" : "Mute"}</span>
        </button>

        {/* Expand */}
        <button
          onClick={expand}
          className="h-9 w-9 rounded-full hover:bg-white/10 flex items-center justify-center transition-colors"
          aria-label="Expand"
        >
          <Maximize2 className="h-4 w-4" />
        </button>

        {/* End call */}
        <button
          onClick={endCall}
          className="h-9 px-3 rounded-full bg-rose-700 hover:bg-rose-600 text-sm font-medium flex items-center gap-1.5 transition-colors"
        >
          <PhoneOff className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">End</span>
        </button>
      </div>
    </div>
  );
}
