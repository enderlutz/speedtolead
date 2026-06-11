import { Mic, MicOff, PhoneOff, Loader2, Maximize2 } from "lucide-react";
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
    recording,
    expanded,
    expand,
    pressTalk,
    releaseTalk,
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
        return recording ? "Listening" : "Your turn";
      case "closed":
        return "Ended";
      default:
        return "";
    }
  })();

  const statusTone = (() => {
    if (callStatus === "speaking") return "text-purple-200";
    if (callStatus === "thinking" || callStatus === "transcribing") return "text-amber-200";
    if (recording) return "text-rose-200";
    return "text-emerald-200";
  })();

  const disabled =
    callStatus === "closed" || callStatus === "connecting" || callStatus === "speaking";

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

        {/* Push-to-talk */}
        <button
          onMouseDown={pressTalk}
          onMouseUp={releaseTalk}
          onMouseLeave={releaseTalk}
          onTouchStart={(ev) => {
            ev.preventDefault();
            pressTalk();
          }}
          onTouchEnd={(ev) => {
            ev.preventDefault();
            releaseTalk();
          }}
          disabled={disabled}
          className={`flex items-center gap-2 h-10 px-4 rounded-full font-medium text-sm transition-all select-none ${
            recording
              ? "bg-rose-500 text-white shadow-lg shadow-rose-500/30"
              : disabled
              ? "bg-white/10 text-white/40 cursor-not-allowed"
              : "bg-white text-slate-900 hover:scale-105"
          }`}
        >
          {recording ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
          <span className="hidden sm:inline">{recording ? "Release to send" : "Hold to talk"}</span>
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
