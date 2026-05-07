import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Play, Pause, SkipBack, SkipForward, Save, FileText, MessageSquare, Mic, MicOff } from "lucide-react";

type Segment = { speaker: number; text: string; start: number; end: number };

interface Props {
  recordingId: string;
  segments: Segment[];
  speakerMap: Record<string, string>;
  initialNotes?: string;
}

const fmt = (s: number): string => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
};

const speakerColor = (id: number): string => {
  const palette = ["text-blue-700", "text-emerald-700", "text-purple-700", "text-amber-700"];
  return palette[id % palette.length];
};

const speakerBg = (id: number, active: boolean): string => {
  if (active) return "bg-primary/10 border-l-4 border-l-primary";
  const palette = ["hover:bg-blue-50/50", "hover:bg-emerald-50/50", "hover:bg-purple-50/50", "hover:bg-amber-50/50"];
  return `${palette[id % palette.length]} border-l-4 border-l-transparent`;
};

/**
 * Spotify-lyrics-style player: native audio controls + a transcript that
 * highlights and auto-scrolls to the active segment, click any line to seek.
 * Includes a freeform notes editor that saves on blur (and on explicit Save).
 */
export default function SyncedTranscriptPlayer({
  recordingId, segments, speakerMap, initialNotes = "",
}: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const segmentRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [autoscroll, setAutoscroll] = useState(true);
  const [rate, setRate] = useState(1);

  const [notes, setNotes] = useState(initialNotes);
  const [savedNotes, setSavedNotes] = useState(initialNotes);
  const [savingNotes, setSavingNotes] = useState(false);

  // Speech-to-text dictation (Web Speech API — Chrome + Safari + iOS).
  // The recognizer is created lazily because Firefox doesn't ship it.
  type SR = { start: () => void; stop: () => void; onresult: ((ev: unknown) => void) | null; onend: (() => void) | null; onerror: ((ev: unknown) => void) | null; continuous: boolean; interimResults: boolean; lang: string };
  const recognitionRef = useRef<SR | null>(null);
  const [dictating, setDictating] = useState(false);
  const dictationBaseRef = useRef<string>("");
  const speechAvailable = typeof window !== "undefined"
    && (("SpeechRecognition" in window) || ("webkitSpeechRecognition" in window));

  const audioUrl = api.getCallAudioUrl(recordingId);

  // Sort segments + find which one the playhead is in
  const ordered = useMemo(
    () => [...(segments || [])].sort((a, b) => a.start - b.start),
    [segments],
  );

  const activeIdx = useMemo(() => {
    if (ordered.length === 0) return -1;
    // Last segment whose start <= currentTime
    let idx = -1;
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i].start <= currentTime + 0.05) idx = i;
      else break;
    }
    return idx;
  }, [ordered, currentTime]);

  // Auto-scroll the active segment into view
  useEffect(() => {
    if (!autoscroll || activeIdx < 0) return;
    const el = segmentRefs.current[activeIdx];
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIdx, autoscroll]);

  // Wire audio element events
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => setCurrentTime(a.currentTime);
    const onLoaded = () => setDuration(a.duration || 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => setPlaying(false);
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onLoaded);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("ended", onEnded);
    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("loadedmetadata", onLoaded);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("ended", onEnded);
    };
  }, [recordingId]);

  // Apply playback rate when changed
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);

  const seekTo = (sec: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = Math.max(0, Math.min(sec, a.duration || sec));
  };

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => toast.error("Couldn't play recording"));
    else a.pause();
  };

  const skip = (delta: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = Math.max(0, Math.min((a.currentTime || 0) + delta, a.duration || 0));
  };

  const onScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    seekTo(parseFloat(e.target.value));
  };

  const saveNotes = async () => {
    if (notes === savedNotes) return;
    setSavingNotes(true);
    try {
      await api.setCallNotes(recordingId, notes);
      setSavedNotes(notes);
      toast.success("Notes saved");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save notes");
    } finally {
      setSavingNotes(false);
    }
  };

  const speakerName = (id: number): string => speakerMap?.[String(id)] || `Speaker ${id + 1}`;
  const notesDirty = notes !== savedNotes;

  const startDictation = () => {
    if (!speechAvailable) {
      toast.error("Voice typing isn't supported in this browser. Try Chrome or Safari.");
      return;
    }
    const Ctor = (window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR })
      .SpeechRecognition || (window as unknown as { webkitSpeechRecognition?: new () => SR }).webkitSpeechRecognition;
    if (!Ctor) {
      toast.error("Voice typing not available.");
      return;
    }
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = "en-US";
    dictationBaseRef.current = notes ? notes.replace(/\s*$/, "") + (notes ? " " : "") : "";
    r.onresult = (ev: unknown) => {
      const e = ev as { results: { isFinal: boolean; 0: { transcript: string } }[] };
      let finalText = "";
      let interimText = "";
      for (let i = 0; i < e.results.length; i++) {
        const seg = e.results[i];
        if (seg.isFinal) finalText += seg[0].transcript + " ";
        else interimText += seg[0].transcript;
      }
      setNotes((dictationBaseRef.current + finalText + interimText).trimStart());
      // After a final segment lands, advance the base so the next interim
      // doesn't overwrite it.
      if (finalText) {
        dictationBaseRef.current = (dictationBaseRef.current + finalText);
      }
    };
    r.onend = () => {
      setDictating(false);
      recognitionRef.current = null;
    };
    r.onerror = (ev: unknown) => {
      const e = ev as { error?: string };
      if (e.error && e.error !== "no-speech" && e.error !== "aborted") {
        toast.error(`Voice error: ${e.error}`);
      }
      setDictating(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = r;
    setDictating(true);
    try { r.start(); } catch { /* already running */ }
  };

  const stopDictation = () => {
    recognitionRef.current?.stop();
    setDictating(false);
  };

  // Stop dictation when component unmounts
  useEffect(() => {
    return () => { recognitionRef.current?.stop(); };
  }, []);

  return (
    <div className="space-y-3">
      {/* Player */}
      <div className="rounded-lg border bg-card p-3 space-y-2">
        <audio ref={audioRef} src={audioUrl} preload="metadata" className="hidden" />

        {/* Scrubber */}
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={currentTime}
          onChange={onScrub}
          className="w-full h-1.5 bg-muted rounded-full appearance-none cursor-pointer accent-primary"
        />

        {/* Time + controls */}
        <div className="flex items-center gap-2 text-xs">
          <span className="font-mono text-muted-foreground tabular-nums w-10">{fmt(currentTime)}</span>
          <div className="flex items-center gap-0.5 mx-auto">
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => skip(-10)} title="Back 10s">
              <SkipBack className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" className="h-9 w-9 p-0 rounded-full" onClick={togglePlay}>
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 ml-0.5" />}
            </Button>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => skip(10)} title="Forward 10s">
              <SkipForward className="h-3.5 w-3.5" />
            </Button>
          </div>
          <span className="font-mono text-muted-foreground tabular-nums w-10 text-right">{fmt(duration)}</span>
          <select
            value={rate}
            onChange={(e) => setRate(parseFloat(e.target.value))}
            className="text-[11px] border border-input rounded px-1.5 py-0.5 bg-background"
            title="Playback speed"
          >
            <option value={0.5}>0.5×</option>
            <option value={0.75}>0.75×</option>
            <option value={1}>1×</option>
            <option value={1.25}>1.25×</option>
            <option value={1.5}>1.5×</option>
            <option value={2}>2×</option>
          </select>
        </div>
      </div>

      {/* Transcript */}
      {ordered.length > 0 ? (
        <div className="rounded-lg border bg-card">
          <div className="flex items-center justify-between px-3 py-2 border-b">
            <div className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5" /> Transcript
              <span className="font-normal">· click any line to jump there</span>
            </div>
            <label className="text-[11px] text-muted-foreground flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={autoscroll}
                onChange={(e) => setAutoscroll(e.target.checked)}
              />
              Auto-scroll
            </label>
          </div>
          <div
            ref={transcriptRef}
            className="max-h-80 overflow-y-auto p-2 space-y-0.5"
            onWheel={() => {
              // Pause auto-scroll the moment the user scrolls manually
              if (autoscroll) setAutoscroll(false);
            }}
          >
            {ordered.map((s, i) => {
              const active = i === activeIdx;
              return (
                <button
                  key={i}
                  ref={(el) => { segmentRefs.current[i] = el; }}
                  onClick={() => seekTo(s.start)}
                  className={`w-full text-left px-3 py-1.5 rounded transition-colors ${speakerBg(s.speaker, active)} ${
                    active ? "" : "border-l-4 border-l-transparent"
                  }`}
                >
                  <div className="flex items-baseline gap-2">
                    <span className={`text-[10px] font-mono shrink-0 tabular-nums w-10 ${active ? "text-primary font-bold" : "text-muted-foreground"}`}>
                      {fmt(s.start)}
                    </span>
                    <span className={`text-[11px] font-semibold shrink-0 ${speakerColor(s.speaker)}`}>
                      {speakerName(s.speaker)}
                    </span>
                    <span className={`text-sm leading-snug ${active ? "text-foreground font-medium" : "text-muted-foreground"}`}>
                      {s.text}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground text-center py-4 border rounded-lg bg-muted/20">
          Transcript not available yet.
        </p>
      )}

      {/* Notes editor */}
      <div className="rounded-lg border bg-card p-3 space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
            <MessageSquare className="h-3.5 w-3.5" /> Call notes
          </label>
          <div className="flex items-center gap-1">
            {speechAvailable && (
              <Button
                size="sm"
                variant={dictating ? "default" : "outline"}
                onClick={dictating ? stopDictation : startDictation}
                className={`h-7 text-xs ${dictating ? "bg-red-600 hover:bg-red-700 text-white animate-pulse" : ""}`}
                title={dictating ? "Stop voice typing" : "Voice type — speak and we'll transcribe"}
              >
                {dictating ? <MicOff className="h-3 w-3 mr-1" /> : <Mic className="h-3 w-3 mr-1" />}
                {dictating ? "Listening…" : "Voice"}
              </Button>
            )}
            <Button
              size="sm"
              variant={notesDirty ? "default" : "outline"}
              onClick={saveNotes}
              disabled={!notesDirty || savingNotes}
              className="h-7 text-xs"
            >
              <Save className="h-3 w-3 mr-1" />
              {savingNotes ? "Saving…" : notesDirty ? "Save" : "Saved"}
            </Button>
          </div>
        </div>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={saveNotes}
          placeholder={dictating ? "Listening — speak now…" : "Anything worth remembering — what the customer asked for, follow-ups, surprises…"}
          rows={3}
          className={`w-full text-sm border rounded-md px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-ring resize-y ${dictating ? "border-red-300 ring-1 ring-red-200" : "border-input"}`}
        />
      </div>
    </div>
  );
}
