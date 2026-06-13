// Training session WS client + continuous-mic VAD pipeline for the
// voice sales simulator.
//
// Replaces the older push-to-talk pattern with always-on mic + level-
// based voice activity detection. While the call is active the mic
// stays hot; the client samples audio level every 50ms and detects
// the start/end of each utterance automatically.
//
// Lifecycle per utterance:
//   level > THRESHOLD              → start MediaRecorder, mark speaking
//   level < THRESHOLD for SILENCE  → stop recorder, send blob via WS
//                                    immediately resume listening
//   level > THRESHOLD while persona
//   audio is playing               → barge-in: cut persona audio, start
//                                    capturing the rep's new utterance
//
// Public API: a TrainingClient with connect()/startContinuous()/
// setMuted()/endCall() + event callbacks (onTranscript, onStatus,
// onRepSpeakingChange, onAudio, onClose).

const API_BASE = (import.meta.env.VITE_API_URL as string) || "";

// VAD tuning constants. Conservative defaults — calibrated for a
// reasonably quiet room. Bump VAD_THRESHOLD if the rep's mic picks up
// too much background noise; bump SILENCE_MS if it cuts off mid-sentence.
const VAD_THRESHOLD = 0.018; // RMS (0..1). Above this = "speaking".
const SILENCE_MS = 800; // Continuous quiet before finalizing an utterance.
const MIN_SPEECH_MS = 250; // Drop blips shorter than this (cough, click, hum).
const SAMPLE_INTERVAL_MS = 50; // How often the polling loop checks level.

function wsUrl(path: string): string {
  // VITE_API_URL is "http://host" or "https://host" or empty (same-origin).
  // WebSocket scheme is ws/wss accordingly.
  const base = API_BASE || `${window.location.protocol}//${window.location.host}`;
  return base.replace(/^http/, "ws") + path;
}

function getAuthToken(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(/(?:^|;\s*)at_auth=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export type TranscriptEntry = {
  speaker: "rep" | "persona";
  text: string;
  ts: string;
};

export type CallStatus = "idle" | "thinking" | "speaking" | "transcribing" | "connecting" | "closed";

type Callbacks = {
  onTranscript?: (entry: TranscriptEntry) => void;
  onStatus?: (s: CallStatus) => void;
  onRepSpeakingChange?: (speaking: boolean) => void;
  onClose?: (reason?: string) => void;
  onError?: (msg: string) => void;
  // Fires when the server detected a closed "corvette sandwich" in the
  // rep's transcript and persisted a coaching note. `text` is the saved
  // note body (between the two trigger words). UI can flash a toast.
  onCoachingNoteSaved?: (text: string) => void;
};

export class TrainingClient {
  private ws: WebSocket | null = null;
  private mediaStream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private playbackQueue: HTMLAudioElement[] = [];
  private isPlaying = false;

  // VAD state
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  // Explicitly typed as Uint8Array<ArrayBuffer> (not ArrayBufferLike) so
  // analyser.getByteTimeDomainData accepts it under TS strict checking —
  // newer TS won't widen this on its own.
  private analyserBuf: Uint8Array<ArrayBuffer> | null = null;
  private vadInterval: number | null = null;
  private isCapturing = false;
  private speechStartedAt: number | null = null;
  private silenceStartedAt: number | null = null;
  private muted = false;
  private continuousActive = false;
  private discardNextStop = false;

  private cb: Callbacks;
  private sessionId: string;

  constructor(sessionId: string, cb: Callbacks = {}) {
    this.sessionId = sessionId;
    this.cb = cb;
  }

  async connect(): Promise<void> {
    this.cb.onStatus?.("connecting");
    const token = getAuthToken();
    if (!token) {
      this.cb.onError?.("Not signed in");
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const url = wsUrl(`/ws/training/${this.sessionId}?token=${encodeURIComponent(token)}`);
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      ws.onopen = () => resolve();
      ws.onerror = () => {
        this.cb.onError?.("Connection error");
        reject(new Error("ws error"));
      };
      ws.onclose = (ev) => {
        this.cb.onStatus?.("closed");
        this.cb.onClose?.(ev.reason);
      };
      ws.onmessage = (ev) => this.handleMessage(ev);
    });
  }

  private handleMessage(ev: MessageEvent) {
    if (ev.data instanceof ArrayBuffer) {
      const blob = new Blob([ev.data], { type: "audio/mpeg" });
      this.enqueueAudio(blob);
      return;
    }
    if (typeof ev.data === "string") {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "transcript") {
          this.cb.onTranscript?.({
            speaker: msg.speaker,
            text: msg.text,
            ts: msg.ts,
          });
        } else if (msg.type === "status") {
          this.cb.onStatus?.(msg.state as CallStatus);
        } else if (msg.type === "coaching_note_saved") {
          this.cb.onCoachingNoteSaved?.(msg.text || "");
        } else if (msg.type === "error") {
          this.cb.onError?.(msg.message || "Unknown error");
        }
      } catch {
        // ignore malformed frames
      }
    }
  }

  private enqueueAudio(blob: Blob) {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.addEventListener("ended", () => {
      URL.revokeObjectURL(url);
      this.isPlaying = false;
      this.playNext();
    });
    this.playbackQueue.push(audio);
    if (!this.isPlaying) this.playNext();
  }

  private playNext() {
    if (this.isPlaying) return;
    const next = this.playbackQueue.shift();
    if (!next) return;
    this.isPlaying = true;
    next.play().catch(() => {
      this.isPlaying = false;
      this.playNext();
    });
  }

  /** Stop and clear the persona's audio playback queue. Called on
   *  barge-in when the rep starts speaking over the persona. */
  private stopPlayback() {
    this.playbackQueue.forEach((a) => {
      try {
        a.pause();
        a.currentTime = 0;
      } catch {
        // ignore
      }
    });
    this.playbackQueue = [];
    this.isPlaying = false;
  }

  /** Begin always-on listening. Sets up the mic, the AudioContext
   *  analyser for level detection, and the VAD polling loop. */
  async startContinuous(): Promise<void> {
    if (this.continuousActive) return;
    if (!this.mediaStream) {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    }

    // AudioContext setup for level monitoring. fftSize controls how
    // much audio data we read per sample (smaller = faster + lower
    // resolution, fine for an RMS check).
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.4;
      source.connect(this.analyser);
      this.analyserBuf = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
    }

    this.continuousActive = true;
    this.vadInterval = window.setInterval(() => this.tickVAD(), SAMPLE_INTERVAL_MS);
  }

  /** Toggle the rep's mic. When muted we leave the polling loop running
   *  but disable the audio tracks — VAD won't trigger so no utterance
   *  fires while muted. */
  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.mediaStream) {
      this.mediaStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
    }
    if (muted && this.isCapturing) {
      // Drop the in-flight capture so a half-utterance doesn't get sent
      this.discardCapture();
    }
  }

  private tickVAD() {
    if (!this.analyser || !this.analyserBuf || this.muted) return;

    this.analyser.getByteTimeDomainData(this.analyserBuf);
    const rms = this.computeRMS(this.analyserBuf);
    const isSpeaking = rms > VAD_THRESHOLD;

    if (isSpeaking) {
      // Barge-in: cut the persona's audio if it's currently playing
      if (this.isPlaying || this.playbackQueue.length > 0) {
        this.stopPlayback();
      }

      // Start capturing on the rising edge
      if (!this.isCapturing) {
        this.startCapture();
        this.speechStartedAt = Date.now();
      }
      // Reset silence timer — they're still talking
      this.silenceStartedAt = null;
    } else if (this.isCapturing) {
      // Quiet during a capture — start (or continue) the silence timer
      if (this.silenceStartedAt === null) {
        this.silenceStartedAt = Date.now();
      }
      const silenceFor = Date.now() - this.silenceStartedAt;
      if (silenceFor >= SILENCE_MS) {
        const speechFor = this.speechStartedAt
          ? Date.now() - this.speechStartedAt
          : 0;
        if (speechFor >= MIN_SPEECH_MS) {
          this.finalizeCapture();
        } else {
          // Too short — probably a cough or false trigger
          this.discardCapture();
        }
        this.speechStartedAt = null;
        this.silenceStartedAt = null;
      }
    }
  }

  private computeRMS(buf: Uint8Array<ArrayBuffer>): number {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / buf.length);
  }

  private startCapture() {
    if (!this.mediaStream || this.isCapturing) return;
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    const recorder = new MediaRecorder(this.mediaStream, { mimeType });
    this.audioChunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.audioChunks.push(e.data);
    };
    recorder.onstop = () => {
      const chunks = this.audioChunks;
      this.audioChunks = [];
      if (this.discardNextStop) {
        this.discardNextStop = false;
        return;
      }
      const blob = new Blob(chunks, { type: mimeType });
      blob.arrayBuffer().then((buf) => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(buf);
        }
      });
    };
    recorder.start();
    this.recorder = recorder;
    this.isCapturing = true;
    this.cb.onRepSpeakingChange?.(true);
  }

  private finalizeCapture() {
    if (this.recorder && this.recorder.state === "recording") {
      this.recorder.stop();
    }
    this.isCapturing = false;
    this.cb.onRepSpeakingChange?.(false);
  }

  private discardCapture() {
    if (this.recorder && this.recorder.state === "recording") {
      this.discardNextStop = true;
      this.recorder.stop();
    }
    this.audioChunks = [];
    this.isCapturing = false;
    this.cb.onRepSpeakingChange?.(false);
  }

  endCall() {
    try {
      this.ws?.send(JSON.stringify({ type: "end_call" }));
    } catch {
      // ignore
    }
    this.cleanup();
  }

  cleanup() {
    if (this.vadInterval !== null) {
      window.clearInterval(this.vadInterval);
      this.vadInterval = null;
    }
    this.continuousActive = false;
    try {
      if (this.recorder && this.recorder.state === "recording") {
        this.discardNextStop = true;
        this.recorder.stop();
      }
    } catch {
      // ignore
    }
    this.isCapturing = false;
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    if (this.audioContext) {
      try {
        this.audioContext.close();
      } catch {
        // ignore
      }
      this.audioContext = null;
      this.analyser = null;
      this.analyserBuf = null;
    }
    this.stopPlayback();
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }
}
