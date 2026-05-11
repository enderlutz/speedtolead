/**
 * VoiceInput — reusable Web Speech API wrapper for natural-language input.
 *
 * Used by the workflow editor (and any future "talk to the dashboard"
 * surface). Browser-native, no API cost, instant. Works great in Chrome
 * and Safari; mediocre in Firefox (warn but allow). Returns the live
 * transcript via onText and signals dictation start/stop via onActiveChange.
 */
import { useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface SR {
  start(): void;
  stop(): void;
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: (e: unknown) => void;
  onend: () => void;
  onerror: (e: unknown) => void;
}

const _isSpeechSupported = (): boolean =>
  typeof window !== "undefined" &&
  (("SpeechRecognition" in window) || ("webkitSpeechRecognition" in window));

interface VoiceInputProps {
  /** Called with the latest combined (committed + interim) transcript. */
  onText: (text: string) => void;
  /** Starting text — used as the base so dictation appends instead of replacing. */
  initialText?: string;
  /** Disable mic when parent is mid-submission. */
  disabled?: boolean;
  /** Optional class for button alignment. */
  className?: string;
}

export default function VoiceInput({ onText, initialText = "", disabled, className }: VoiceInputProps) {
  const [active, setActive] = useState(false);
  const recognitionRef = useRef<SR | null>(null);
  const baseRef = useRef<string>("");

  // Track the latest initialText so a parent re-render (e.g. user typed
  // some text) updates the base for the NEXT dictation start without
  // resetting an in-progress one.
  useEffect(() => {
    if (!active) baseRef.current = initialText;
  }, [initialText, active]);

  useEffect(() => {
    return () => { recognitionRef.current?.stop(); };
  }, []);

  const start = () => {
    if (!_isSpeechSupported()) {
      toast.error("Voice input isn't supported here — try Chrome or Safari.");
      return;
    }
    const Ctor = (window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR })
      .SpeechRecognition || (window as unknown as { webkitSpeechRecognition?: new () => SR }).webkitSpeechRecognition;
    if (!Ctor) return;
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = "en-US";
    baseRef.current = initialText ? initialText.replace(/\s*$/, "") + " " : "";
    r.onresult = (ev: unknown) => {
      const e = ev as { results: { isFinal: boolean; 0: { transcript: string } }[] };
      let finalText = "";
      let interimText = "";
      for (let i = 0; i < e.results.length; i++) {
        const seg = e.results[i];
        if (seg.isFinal) finalText += seg[0].transcript + " ";
        else interimText += seg[0].transcript;
      }
      onText((baseRef.current + finalText + interimText).trimStart());
      if (finalText) {
        baseRef.current = baseRef.current + finalText;
      }
    };
    r.onend = () => {
      setActive(false);
      recognitionRef.current = null;
    };
    r.onerror = (ev: unknown) => {
      const e = ev as { error?: string };
      if (e.error && e.error !== "no-speech" && e.error !== "aborted") {
        toast.error(`Voice error: ${e.error}`);
      }
      setActive(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = r;
    setActive(true);
    try { r.start(); } catch { /* already running */ }
  };

  const stop = () => {
    recognitionRef.current?.stop();
    setActive(false);
  };

  return (
    <Button
      type="button"
      size="sm"
      variant={active ? "default" : "outline"}
      onClick={active ? stop : start}
      disabled={disabled}
      title={active ? "Stop dictation" : "Speak your instruction"}
      className={className}
    >
      {active ? (
        <>
          <Square className="h-3.5 w-3.5 mr-1 animate-pulse" />
          Stop
        </>
      ) : (
        <>
          <Mic className="h-3.5 w-3.5 mr-1" />
          Speak
        </>
      )}
    </Button>
  );
}
