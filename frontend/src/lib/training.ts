// Training session WS client + mic capture for the voice sales simulator.
//
// Public API: a TrainingClient with start()/stop() lifecycle + event
// callbacks (onTranscript, onStatus, onAudio, onClose). The component
// owns rendering; this module owns the protocol.

const API_BASE = (import.meta.env.VITE_API_URL as string) || "";

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
  onClose?: (reason?: string) => void;
  onError?: (msg: string) => void;
};

export class TrainingClient {
  private ws: WebSocket | null = null;
  private mediaStream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private playbackQueue: HTMLAudioElement[] = [];
  private isPlaying = false;
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
      // Persona TTS audio (MP3 blob)
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

  async startRecording(): Promise<void> {
    if (this.recorder && this.recorder.state === "recording") return;
    if (!this.mediaStream) {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    }
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    const recorder = new MediaRecorder(this.mediaStream, { mimeType });
    this.audioChunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.audioChunks.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(this.audioChunks, { type: mimeType });
      this.audioChunks = [];
      blob.arrayBuffer().then((buf) => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(buf);
        }
      });
    };
    recorder.start();
    this.recorder = recorder;
  }

  stopRecording() {
    if (this.recorder && this.recorder.state === "recording") {
      this.recorder.stop();
    }
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
    try {
      this.stopRecording();
    } catch {
      // ignore
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    this.playbackQueue.forEach((a) => {
      try {
        a.pause();
      } catch {
        // ignore
      }
    });
    this.playbackQueue = [];
    this.isPlaying = false;
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }
}
