import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { TrainingClient, type TranscriptEntry, type CallStatus } from "@/lib/training";
import { api, type TrainingSessionRecord } from "@/lib/api";
import type { Persona } from "@/components/training/PersonaCard";

// localStorage key — also read directly by api.ts request() interceptor
// so customer-contacting endpoints can be blocked without React access.
const TRAINING_MODE_LS_KEY = "at_training_mode";

export function isTrainingModeOnSync(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(TRAINING_MODE_LS_KEY) === "1";
  } catch {
    return false;
  }
}

export type ActiveCall = {
  sessionId: string;
  persona: Persona;
  mood: string;
  ttsConfigured: boolean;
};

type TrainingModeValue = {
  trainingModeOn: boolean;
  enableTrainingMode: () => void;
  disableTrainingMode: () => void;

  // Active call
  activeCall: ActiveCall | null;
  callStatus: CallStatus;
  recording: boolean;
  transcript: TranscriptEntry[];
  error: string | null;

  // Lifecycle
  startCall: (call: ActiveCall) => Promise<void>;
  pressTalk: () => Promise<void>;
  releaseTalk: () => void;
  endCall: () => Promise<void>;

  // Expanded view (fullscreen transcript) toggle
  expanded: boolean;
  expand: () => void;
  collapse: () => void;

  // Post-call summary modal
  pendingSummary: TrainingSessionRecord | null;
  dismissSummary: () => void;
};

const TrainingModeContext = createContext<TrainingModeValue | null>(null);

export function useTrainingMode(): TrainingModeValue {
  const v = useContext(TrainingModeContext);
  if (!v) throw new Error("useTrainingMode must be used inside <TrainingModeProvider>");
  return v;
}

export function TrainingModeProvider({ children }: { children: ReactNode }) {
  const [trainingModeOn, setTrainingModeOn] = useState<boolean>(() => isTrainingModeOnSync());
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [callStatus, setCallStatus] = useState<CallStatus>("idle");
  const [recording, setRecording] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [pendingSummary, setPendingSummary] = useState<TrainingSessionRecord | null>(null);

  const clientRef = useRef<TrainingClient | null>(null);

  // Persist training mode flag to localStorage so api.ts can read it
  // synchronously when intercepting customer-contacting requests.
  useEffect(() => {
    try {
      window.localStorage.setItem(TRAINING_MODE_LS_KEY, trainingModeOn ? "1" : "0");
    } catch {
      // ignore
    }
  }, [trainingModeOn]);

  const enableTrainingMode = useCallback(() => setTrainingModeOn(true), []);
  const disableTrainingMode = useCallback(() => {
    if (activeCall) {
      toast.error("End the current practice call before exiting training mode");
      return;
    }
    setTrainingModeOn(false);
  }, [activeCall]);

  const cleanupCallSideEffects = useCallback(() => {
    try {
      clientRef.current?.cleanup();
    } catch {
      // ignore
    }
    clientRef.current = null;
    setActiveCall(null);
    setCallStatus("idle");
    setRecording(false);
    setExpanded(false);
    setTranscript([]);
    setError(null);
  }, []);

  const startCall = useCallback(async (call: ActiveCall) => {
    if (activeCall) {
      toast.error("A practice call is already running");
      return;
    }
    setTranscript([]);
    setError(null);
    setCallStatus("connecting");
    setActiveCall(call);
    setExpanded(true);

    const client = new TrainingClient(call.sessionId, {
      onTranscript: (e) => setTranscript((prev) => [...prev, e]),
      onStatus: (s) => setCallStatus(s),
      onError: (msg) => {
        setError(msg);
        toast.error(msg);
      },
      onClose: () => setCallStatus("closed"),
    });
    clientRef.current = client;
    try {
      await client.connect();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect");
    }
  }, [activeCall]);

  const pressTalk = useCallback(async () => {
    if (!clientRef.current || !activeCall) return;
    if (callStatus === "speaking" || callStatus === "closed" || callStatus === "connecting") return;
    try {
      await clientRef.current.startRecording();
      setRecording(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Mic access denied";
      setError(msg);
      toast.error(msg);
    }
  }, [activeCall, callStatus]);

  const releaseTalk = useCallback(() => {
    if (!clientRef.current || !recording) return;
    clientRef.current.stopRecording();
    setRecording(false);
  }, [recording]);

  const endCall = useCallback(async () => {
    const call = activeCall;
    if (!call) return;
    try {
      clientRef.current?.endCall();
    } catch {
      // ignore
    }
    let summary: TrainingSessionRecord | null = null;
    try {
      summary = await api.endTrainingSession(call.sessionId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to end session");
    }
    cleanupCallSideEffects();
    if (summary) setPendingSummary(summary);
  }, [activeCall, cleanupCallSideEffects]);

  const expand = useCallback(() => setExpanded(true), []);
  const collapse = useCallback(() => setExpanded(false), []);
  const dismissSummary = useCallback(() => setPendingSummary(null), []);

  // Unmount safety — drop the WS + mic on hard refresh / nav-away
  useEffect(() => {
    return () => {
      try {
        clientRef.current?.cleanup();
      } catch {
        // ignore
      }
    };
  }, []);

  const value = useMemo<TrainingModeValue>(
    () => ({
      trainingModeOn,
      enableTrainingMode,
      disableTrainingMode,
      activeCall,
      callStatus,
      recording,
      transcript,
      error,
      startCall,
      pressTalk,
      releaseTalk,
      endCall,
      expanded,
      expand,
      collapse,
      pendingSummary,
      dismissSummary,
    }),
    [
      trainingModeOn,
      enableTrainingMode,
      disableTrainingMode,
      activeCall,
      callStatus,
      recording,
      transcript,
      error,
      startCall,
      pressTalk,
      releaseTalk,
      endCall,
      expanded,
      expand,
      collapse,
      pendingSummary,
      dismissSummary,
    ],
  );

  return <TrainingModeContext.Provider value={value}>{children}</TrainingModeContext.Provider>;
}
