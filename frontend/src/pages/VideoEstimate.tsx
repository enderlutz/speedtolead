// FenceScope — public mobile-first guided video-estimate capture page.
// Route: /v/:token  (no auth — token-gated by the backend). See fencescope.md.
//
// Flow: instructions → record (guided, guardrailed) → damage photos + back-side
// → done. The measurement engine is human picket-counting at review, so this
// page's whole job is producing a COUNTABLE video — hence the guardrails matter
// more than anything: framing bracket, pace timer, min-duration, quality checks.

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  Video, Square, RotateCcw, ChevronRight, CheckCircle2, Loader2, AlertCircle,
  Smartphone, Camera, Sun,
} from "lucide-react";

const BASE = (import.meta.env.VITE_API_URL as string) || "";
const MIN_SECONDS = 20;

type Stage = "loading" | "invalid" | "desktop" | "instructions" | "record" | "damage" | "done";

type DamageKey = "rotten_boards" | "leaning_posts" | "damaged_caps" | "loose_rails";
const DAMAGE_ITEMS: { key: DamageKey; label: string }[] = [
  { key: "rotten_boards", label: "Rotten or cracked boards" },
  { key: "leaning_posts", label: "Leaning or broken posts" },
  { key: "damaged_caps", label: "Damaged caps / trim" },
  { key: "loose_rails", label: "Loose or sagging rails" },
];

function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return true;
  const ua = navigator.userAgent || "";
  const coarse = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  return /Mobi|Android|iPhone|iPad|iPod/i.test(ua) || !!coarse;
}

/** Sample the recorded clip and gate on the things that make a video
 *  UN-countable: too short, too low-res, too dark, badly out of focus.
 *  Brightness/duration/resolution are hard blocks; blur is lenient (a low
 *  Laplacian variance) so we don't frustrate a decent-but-soft clip. */
async function analyzeClip(blob: Blob, durationSec: number): Promise<{ ok: boolean; reason?: string }> {
  if (durationSec < MIN_SECONDS) {
    return { ok: false, reason: `That was only ${Math.round(durationSec)}s. We need at least ${MIN_SECONDS} seconds — walk the whole fence slowly.` };
  }
  const url = URL.createObjectURL(blob);
  try {
    const v = document.createElement("video");
    v.src = url; v.muted = true; (v as HTMLVideoElement).playsInline = true;
    await new Promise<void>((res, rej) => { v.onloadeddata = () => res(); v.onerror = () => rej(new Error("load")); });
    const w = v.videoWidth, h = v.videoHeight;
    if (Math.min(w, h) < 360) {
      return { ok: false, reason: "The video came out too low-resolution. Re-record with your normal camera (not zoomed way out)." };
    }
    // Seek a little in and sample one frame.
    await new Promise<void>((res) => { v.onseeked = () => res(); v.currentTime = Math.min(2, (v.duration || 4) / 2); });
    const scale = 160 / Math.max(w, h);
    const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { ok: true };
    ctx.drawImage(v, 0, 0, cw, ch);
    const data = ctx.getImageData(0, 0, cw, ch).data;
    // Grayscale + mean luminance.
    const gray = new Float64Array(cw * ch);
    let sum = 0;
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      gray[p] = g; sum += g;
    }
    const mean = sum / (cw * ch);
    if (mean < 35) {
      return { ok: false, reason: "The video looks very dark. Film during the day with the sun behind you." };
    }
    // Laplacian variance (focus/shake proxy). Lenient threshold — only reject
    // clips that are badly out of focus so we don't false-reject good ones.
    let lapSum = 0, lapSq = 0, n = 0;
    for (let y = 1; y < ch - 1; y++) {
      for (let x = 1; x < cw - 1; x++) {
        const c = gray[y * cw + x];
        const lap = gray[(y - 1) * cw + x] + gray[(y + 1) * cw + x] + gray[y * cw + (x - 1)] + gray[y * cw + (x + 1)] - 4 * c;
        lapSum += lap; lapSq += lap * lap; n++;
      }
    }
    if (n > 0) {
      const variance = lapSq / n - (lapSum / n) ** 2;
      if (variance < 12) {
        return { ok: false, reason: "The video looks blurry. Hold the phone steady and walk slowly — let the camera focus on the fence." };
      }
    }
    return { ok: true };
  } catch {
    return { ok: true }; // never block on an analysis error
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function VideoEstimate() {
  const { token } = useParams<{ token: string }>();
  const [stage, setStage] = useState<Stage>("loading");
  const [firstName, setFirstName] = useState("");
  const [forceMobile, setForceMobile] = useState(false);

  // Recording
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [qualityIssue, setQualityIssue] = useState<string | null>(null);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [videoUploaded, setVideoUploaded] = useState(false);
  const [portrait, setPortrait] = useState(false);

  const liveRef = useRef<HTMLVideoElement | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const startRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  // Damage + back side
  const [damage, setDamage] = useState<Record<DamageKey, number>>({ rotten_boards: 0, leaning_posts: 0, damaged_caps: 0, loose_rails: 0 });
  const [damagePhotos, setDamagePhotos] = useState<number>(0);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [bothSides, setBothSides] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Bootstrap: validate token + desktop guard.
  useEffect(() => {
    if (!token) { setStage("invalid"); return; }
    if (!isMobileDevice() && !forceMobile) { setStage("desktop"); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${BASE}/api/v/${token}/info`);
        if (!r.ok) throw new Error(String(r.status));
        const data = await r.json();
        if (cancelled) return;
        setFirstName(data.first_name || "");
        setStage("instructions");
      } catch {
        if (!cancelled) setStage("invalid");
      }
    })();
    return () => { cancelled = true; };
  }, [token, forceMobile]);

  // Orientation hint on the record screen.
  useEffect(() => {
    if (stage !== "record") return;
    const check = () => setPortrait(window.innerHeight > window.innerWidth);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [stage]);

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; }
  }, []);
  useEffect(() => () => stopTracks(), [stopTracks]);

  const beginPreview = useCallback(async () => {
    setQualityIssue(null);
    if (recordedUrl) { URL.revokeObjectURL(recordedUrl); setRecordedUrl(null); }
    if (!navigator.mediaDevices?.getUserMedia) {
      setQualityIssue("This phone's browser can't record video. Try Safari (iPhone) or Chrome (Android).");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      });
      streamRef.current = stream;
      if (liveRef.current) { liveRef.current.srcObject = stream; await liveRef.current.play().catch(() => {}); }
      try { await (screen.orientation as { lock?: (o: string) => Promise<void> })?.lock?.("landscape"); } catch { /* iOS rejects — the hint covers it */ }
    } catch {
      setQualityIssue("We couldn't open your camera. Check that your browser has camera permission, then try again.");
    }
  }, [recordedUrl]);

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    chunksRef.current = [];
    const preferred = ["video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    const supported = typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported
      ? preferred.find((t) => MediaRecorder.isTypeSupported(t)) : undefined;
    const mr = supported ? new MediaRecorder(stream, { mimeType: supported }) : new MediaRecorder(stream);
    mr.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
    mr.onstop = async () => {
      const type = mr.mimeType || supported || "video/mp4";
      const blob = new Blob(chunksRef.current, { type });
      const dur = (performance.now() - startRef.current) / 1000;
      if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; }
      setRecording(false);
      setAnalyzing(true);
      const verdict = await analyzeClip(blob, dur);
      setAnalyzing(false);
      if (!verdict.ok) { setQualityIssue(verdict.reason || "Please re-record."); return; }
      setRecordedUrl(URL.createObjectURL(blob));
      await uploadVideo(blob, type, dur);
    };
    mediaRef.current = mr;
    startRef.current = performance.now();
    setElapsed(0);
    mr.start(1000);
    setRecording(true);
    timerRef.current = window.setInterval(() => setElapsed((performance.now() - startRef.current) / 1000), 200);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopRecording = useCallback(() => {
    try { mediaRef.current?.stop(); } catch { /* already stopped */ }
    stopTracks();
  }, [stopTracks]);

  const uploadVideo = useCallback(async (blob: Blob, type: string, dur: number) => {
    if (!token) return;
    setUploading(true);
    try {
      const ext = type.includes("mp4") ? "mp4" : "webm";
      const fd = new FormData();
      fd.append("video", new File([blob], `fence.${ext}`, { type }));
      fd.append("duration_seconds", String(Math.round(dur)));
      const r = await fetch(`${BASE}/api/v/${token}/video`, { method: "POST", body: fd });
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        throw new Error(txt.slice(0, 140) || `Upload failed (${r.status})`);
      }
      setVideoUploaded(true);
      setStage("damage");
    } catch (e) {
      setQualityIssue(e instanceof Error ? e.message : "Upload failed — please try recording again.");
      setRecordedUrl(null);
    } finally {
      setUploading(false);
    }
  }, [token]);

  const uploadDamagePhoto = useCallback(async (file: File) => {
    if (!token) return;
    setUploadingPhoto(true);
    try {
      const fd = new FormData();
      fd.append("photo", file);
      const r = await fetch(`${BASE}/api/v/${token}/damage-photo`, { method: "POST", body: fd });
      if (r.ok) { const d = await r.json(); setDamagePhotos(d.photos_submitted || damagePhotos + 1); }
    } finally {
      setUploadingPhoto(false);
    }
  }, [token, damagePhotos]);

  const submit = useCallback(async () => {
    if (!token) return;
    setSubmitting(true);
    try {
      const r = await fetch(`${BASE}/api/v/${token}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // "Couldn't film back there" → the back side is not accessible.
        body: JSON.stringify({ ...damage, both_sides_requested: bothSides, back_side_accessible: !bothSides }),
      });
      if (!r.ok) throw new Error(String(r.status));
      setStage("done");
    } catch {
      setSubmitting(false);
    }
  }, [token, damage, bothSides]);

  // ---------- Render ----------

  if (stage === "loading") {
    return <Center><Loader2 className="h-8 w-8 animate-spin text-blue-600" /></Center>;
  }
  if (stage === "invalid") {
    return (
      <Center>
        <div className="text-center max-w-sm">
          <AlertCircle className="h-10 w-10 text-amber-500 mx-auto mb-3" />
          <h1 className="text-lg font-semibold">This link isn't active</h1>
          <p className="text-sm text-gray-500 mt-2">Ask Sterling Fence Staining to text you a fresh link, then open it on your phone.</p>
        </div>
      </Center>
    );
  }
  if (stage === "desktop") {
    return (
      <Center>
        <div className="text-center max-w-sm">
          <Smartphone className="h-12 w-12 text-blue-600 mx-auto mb-3" />
          <h1 className="text-xl font-semibold">Open this on your phone</h1>
          <p className="text-sm text-gray-500 mt-2">You'll be recording a short video of your fence, so this needs your phone's camera.</p>
          <button onClick={() => { navigator.clipboard?.writeText(window.location.href).catch(() => {}); }} className="mt-4 w-full rounded-xl bg-blue-600 text-white py-3 font-medium">Copy link</button>
          <button onClick={() => setForceMobile(true)} className="mt-3 text-xs text-gray-400 underline">Continue on this device anyway</button>
        </div>
      </Center>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="bg-blue-600 text-white px-4 py-3 flex items-center gap-2 sticky top-0 z-10">
        <Camera className="h-5 w-5" />
        <span className="font-semibold">Sterling Fence Staining</span>
      </header>

      {stage === "instructions" && (
        <Screen>
          <h1 className="text-2xl font-bold">{firstName ? `Hi ${firstName}!` : "Hi there!"}</h1>
          <p className="text-gray-600 mt-1">Let's get your fence quote without anyone coming out. Just one short video — here's how to nail it:</p>
          <ul className="mt-5 space-y-4">
            <Tip icon={<Camera className="h-5 w-5" />} title="Stand about 10 feet back">Keep the <b>top of the fence AND the ground</b> both in the frame the whole time.</Tip>
            <Tip icon={<Video className="h-5 w-5" />} title="Walk slow and steady">Hold the phone level and film the <b>whole run</b> from one end to the other.</Tip>
            <Tip icon={<CheckCircle2 className="h-5 w-5" />} title="Film only what you want stained">Want both sides done? Walk both sides. A section staying as-is? Don't film it.</Tip>
            <Tip icon={<Sun className="h-5 w-5" />} title="Say it out loud">Tell us where to start and stop as you walk.</Tip>
          </ul>
          <button onClick={() => { setStage("record"); void beginPreview(); }} className="mt-6 w-full rounded-xl bg-blue-600 text-white py-4 font-semibold flex items-center justify-center gap-2">
            Start recording <ChevronRight className="h-5 w-5" />
          </button>
        </Screen>
      )}

      {stage === "record" && (
        <div className="p-4">
          <div className="relative rounded-2xl overflow-hidden bg-black aspect-[3/4] sm:aspect-video">
            <video ref={liveRef} className="w-full h-full object-cover" muted playsInline autoPlay />
            {/* Framing bracket — keep fence top above the top line, ground below the bottom line. */}
            <div className="absolute inset-x-0 top-[18%] border-t-2 border-dashed border-yellow-300/90" />
            <div className="absolute inset-x-0 bottom-[18%] border-t-2 border-dashed border-yellow-300/90" />
            <div className="absolute left-2 top-[18%] -translate-y-full text-[11px] text-yellow-200 bg-black/40 px-1 rounded">fence top above this line</div>
            <div className="absolute left-2 bottom-[18%] translate-y-1 text-[11px] text-yellow-200 bg-black/40 px-1 rounded">ground below this line</div>

            {portrait && (
              <div className="absolute inset-0 bg-black/70 flex items-center justify-center text-center p-6">
                <div className="text-white"><RotateCcw className="h-8 w-8 mx-auto mb-2" /><p className="font-medium">Turn your phone sideways</p><p className="text-sm text-white/70">Landscape captures the whole fence.</p></div>
              </div>
            )}

            {recording && (
              <>
                <div className="absolute top-3 right-3 flex items-center gap-1.5 bg-red-600 text-white text-xs font-semibold px-2 py-1 rounded-full">
                  <span className="h-2 w-2 rounded-full bg-white animate-pulse" /> {Math.floor(elapsed)}s
                </div>
                {/* Pace timer — keep your walk about as fast as this dot. */}
                <div className="absolute bottom-16 inset-x-6">
                  <div className="text-[11px] text-white/80 text-center mb-1">walk at this pace →</div>
                  <div className="h-1.5 rounded-full bg-white/20 overflow-hidden relative">
                    <div className="absolute top-0 h-full w-8 rounded-full bg-yellow-300 fs-pace" />
                  </div>
                </div>
              </>
            )}
          </div>

          {qualityIssue && (
            <div className="mt-3 rounded-xl bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800 flex gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" /> <span>{qualityIssue}</span>
            </div>
          )}

          <div className="mt-4">
            {analyzing || uploading ? (
              <button disabled className="w-full rounded-xl bg-gray-300 text-white py-4 font-semibold flex items-center justify-center gap-2">
                <Loader2 className="h-5 w-5 animate-spin" /> {uploading ? "Uploading…" : "Checking the video…"}
              </button>
            ) : recording ? (
              <button onClick={stopRecording} className="w-full rounded-xl bg-red-600 text-white py-4 font-semibold flex items-center justify-center gap-2">
                <Square className="h-5 w-5" /> Stop {elapsed < MIN_SECONDS ? `(${Math.max(0, Math.ceil(MIN_SECONDS - elapsed))}s more)` : ""}
              </button>
            ) : (
              <button onClick={() => { if (!streamRef.current) { void beginPreview().then(startRecording); } else startRecording(); }} className="w-full rounded-xl bg-blue-600 text-white py-4 font-semibold flex items-center justify-center gap-2">
                <Video className="h-5 w-5" /> {qualityIssue ? "Re-record" : "Record"}
              </button>
            )}
            <p className="text-center text-xs text-gray-400 mt-2">Record at least {MIN_SECONDS} seconds. Walk the whole fence.</p>
          </div>
        </div>
      )}

      {stage === "damage" && (
        <Screen>
          <div className="rounded-xl bg-green-50 border border-green-200 p-3 text-sm text-green-800 flex gap-2 mb-4">
            <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" /> <span>Got your video{videoUploaded ? "" : ""}. One more quick step.</span>
          </div>
          <h1 className="text-xl font-bold">Any damage?</h1>
          <p className="text-gray-600 mt-1 text-sm">Tap the count for anything broken, and add a close-up photo. This becomes a repair line on your quote.</p>

          <div className="mt-4 space-y-3">
            {DAMAGE_ITEMS.map((it) => (
              <div key={it.key} className="flex items-center justify-between rounded-xl border bg-white p-3">
                <span className="text-sm font-medium pr-2">{it.label}</span>
                <Stepper value={damage[it.key]} onChange={(n) => setDamage((d) => ({ ...d, [it.key]: n }))} />
              </div>
            ))}
          </div>

          <label className="mt-4 flex items-center justify-center gap-2 w-full rounded-xl border-2 border-dashed border-gray-300 py-4 text-sm font-medium text-gray-600 cursor-pointer">
            {uploadingPhoto ? <Loader2 className="h-5 w-5 animate-spin" /> : <Camera className="h-5 w-5" />}
            {damagePhotos > 0 ? `${damagePhotos} photo${damagePhotos > 1 ? "s" : ""} added — add another` : "Add a close-up photo"}
            <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadDamagePhoto(f); e.currentTarget.value = ""; }} />
          </label>

          <div className="mt-5 rounded-xl border bg-white p-3">
            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={bothSides} onChange={(e) => setBothSides(e.target.checked)} className="h-5 w-5 mt-0.5" />
              <span className="text-sm">I want the <b>other side</b> stained too, but couldn't film back there (trees, neighbor's yard, no gate).</span>
            </label>
            {bothSides && (
              <p className="text-xs text-gray-500 mt-2 pl-8">No problem — it's the same fence length, so we can quote both sides. We'll confirm the back side's condition when we arrive.</p>
            )}
          </div>

          <button onClick={submit} disabled={submitting} className="mt-6 w-full rounded-xl bg-blue-600 text-white py-4 font-semibold flex items-center justify-center gap-2 disabled:opacity-60">
            {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />} Send it to Sterling
          </button>
          <p className="text-center text-xs text-gray-400 mt-2">No damage? Just tap send — you're done.</p>
        </Screen>
      )}

      {stage === "done" && (
        <Screen>
          <div className="text-center py-10">
            <CheckCircle2 className="h-16 w-16 text-green-500 mx-auto mb-4" />
            <h1 className="text-2xl font-bold">All set{firstName ? `, ${firstName}` : ""}!</h1>
            <p className="text-gray-600 mt-2">We've got your video. Sterling Fence Staining will review it and text you a quote — usually the same day.</p>
            <p className="text-sm text-gray-400 mt-6">You can close this page.</p>
          </div>
        </Screen>
      )}

      <style>{`@keyframes fsPace { 0%{left:0} 100%{left:calc(100% - 2rem)} } .fs-pace{ animation: fsPace 2.4s ease-in-out infinite alternate; }`}</style>
    </div>
  );
}

// ---------- Small presentational helpers ----------

function Center({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">{children}</div>;
}
function Screen({ children }: { children: React.ReactNode }) {
  return <div className="max-w-md mx-auto p-5">{children}</div>;
}
function Tip({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <div className="h-10 w-10 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">{icon}</div>
      <div><div className="font-semibold text-sm">{title}</div><div className="text-sm text-gray-600">{children}</div></div>
    </li>
  );
}
function Stepper({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="flex items-center gap-3">
      <button onClick={() => onChange(Math.max(0, value - 1))} className="h-8 w-8 rounded-full border text-lg leading-none disabled:opacity-30" disabled={value === 0}>−</button>
      <span className="w-5 text-center font-semibold tabular-nums">{value}</span>
      <button onClick={() => onChange(value + 1)} className="h-8 w-8 rounded-full border text-lg leading-none">+</button>
    </div>
  );
}
