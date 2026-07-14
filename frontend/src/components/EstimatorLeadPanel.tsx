import { useState, useEffect, useRef, useCallback } from "react";
import { api, type EstimatorCaptures } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Camera, Mic, Square, Trash2, Loader2, StickyNote, Image as ImageIcon, AudioLines, Upload, Download, RotateCw } from "lucide-react";

// Map a recorded/uploaded audio MIME to a sensible file extension.
function audioExt(type: string): string {
  const t = (type || "").toLowerCase();
  if (t.includes("mp4") || t.includes("m4a") || t.includes("aac")) return "m4a";
  if (t.includes("mpeg") || t.includes("mp3")) return "mp3";
  if (t.includes("ogg")) return "ogg";
  if (t.includes("wav")) return "wav";
  return "webm";
}

function fmtDur(s: number | null): string {
  if (!s || s < 1) return "";
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** The Estimator tab body: conversation recording, pre-inspection photos, and
 *  per-estimate notes for one lead. Shared by the estimator's own lead page and
 *  the Estimator tab on the staff Lead Detail page. */
export default function EstimatorLeadPanel({ leadId }: { leadId: string }) {
  const [caps, setCaps] = useState<EstimatorCaptures | null>(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState("");
  const notesSaved = useRef("");
  const [notesStatus, setNotesStatus] = useState<"idle" | "saving" | "saved">("idle");
  const notesTimer = useRef<number | null>(null);

  const [photoBlobs, setPhotoBlobs] = useState<Record<string, string>>({});
  const photoBlobsRef = useRef<Record<string, string>>({});
  useEffect(() => { photoBlobsRef.current = photoBlobs; }, [photoBlobs]);
  const [photoProgress, setPhotoProgress] = useState<{ done: number; total: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [recBlobs, setRecBlobs] = useState<Record<string, string>>({});
  const recBlobsRef = useRef<Record<string, string>>({});
  useEffect(() => { recBlobsRef.current = recBlobs; }, [recBlobs]);
  const recFileRef = useRef<HTMLInputElement>(null);
  const [recUploading, setRecUploading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.getLeadCaptures(leadId)
      .then((c) => {
        setCaps(c);
        setNotes(c.notes);
        notesSaved.current = c.notes;
      })
      .catch(() => toast.error("Couldn't load estimate captures"))
      .finally(() => setLoading(false));
  }, [leadId]);

  useEffect(() => { load(); }, [load]);

  // Load photo thumbnails as blob URLs once metadata arrives.
  useEffect(() => {
    if (!caps) return;
    let alive = true;
    (async () => {
      for (const p of caps.photos) {
        if (photoBlobsRef.current[p.id]) continue;
        const url = await api.fetchEstimatorPhotoBlobUrl(p.id);
        if (alive && url) setPhotoBlobs((prev) => ({ ...prev, [p.id]: url }));
      }
    })();
    return () => { alive = false; };
  }, [caps]);

  // Revoke object URLs + clear the pending notes-save timer on unmount.
  useEffect(() => () => {
    Object.values(photoBlobsRef.current).forEach(URL.revokeObjectURL);
    Object.values(recBlobsRef.current).forEach(URL.revokeObjectURL);
    if (notesTimer.current) window.clearTimeout(notesTimer.current);
  }, []);

  // Autosave notes so nothing is lost if the estimator navigates away, the
  // screen locks, or the tab reloads before tapping out of the box. Saves ~1s
  // after typing stops AND on blur, with a live Saving/Saved/Unsaved status.
  const saveNotes = useCallback(async (val: string) => {
    if (notesTimer.current) { window.clearTimeout(notesTimer.current); notesTimer.current = null; }
    if (val === notesSaved.current) return;
    setNotesStatus("saving");
    try {
      await api.saveLeadNotes(leadId, val);
      notesSaved.current = val;
      setNotesStatus("saved");
    } catch {
      setNotesStatus("idle");
      toast.error("Couldn't save notes — check your connection");
    }
  }, [leadId]);

  const onNotesChange = (val: string) => {
    setNotes(val);
    setNotesStatus("idle");
    if (notesTimer.current) window.clearTimeout(notesTimer.current);
    notesTimer.current = window.setTimeout(() => saveNotes(val), 1000);
  };

  const onPickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    // Upload each selected photo sequentially (robust on flaky on-site mobile
    // connections — each is independent), reloading once at the end.
    setPhotoProgress({ done: 0, total: files.length });
    let failed = 0;
    for (let i = 0; i < files.length; i++) {
      try {
        await api.uploadEstimatorPhoto(leadId, files[i]);
      } catch {
        failed++;
      }
      setPhotoProgress({ done: i + 1, total: files.length });
    }
    setPhotoProgress(null);
    await load();
    const ok = files.length - failed;
    if (failed === 0) toast.success(`${ok} photo${ok === 1 ? "" : "s"} uploaded`);
    else if (ok === 0) toast.error("Photos failed to upload");
    else toast.error(`${ok} uploaded · ${failed} failed`);
  };

  const deletePhoto = async (id: string) => {
    try {
      await api.deleteEstimatorPhoto(id);
      setCaps((prev) => prev ? { ...prev, photos: prev.photos.filter((p) => p.id !== id) } : prev);
    } catch {
      toast.error("Couldn't delete photo");
    }
  };

  const playRec = async (id: string) => {
    if (recBlobs[id]) return;
    const url = await api.fetchEstimatorRecordingBlobUrl(id);
    if (url) setRecBlobs((prev) => ({ ...prev, [id]: url }));
  };

  const deleteRec = async (id: string) => {
    try {
      await api.deleteEstimatorRecording(id);
      setCaps((prev) => prev ? { ...prev, recordings: prev.recordings.filter((r) => r.id !== id) } : prev);
    } catch {
      toast.error("Couldn't delete recording");
    }
  };

  // Upload an existing audio file (e.g. recorded with the phone's Voice Memos
  // app — the most reliable way to capture a long conversation).
  const onPickRecording = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = (e.target.files || [])[0];
    e.target.value = "";
    if (!file) return;
    setRecUploading(true);
    try {
      await api.uploadEstimatorRecording(leadId, file, 0);
      toast.success("Recording uploaded");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't upload recording");
    } finally {
      setRecUploading(false);
    }
  };

  if (loading) {
    return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-5">
      {/* Conversation recording */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold flex items-center gap-2"><AudioLines className="h-4 w-4 text-primary" /> Conversation recording</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Recorder leadId={leadId} onUploaded={load} />
          <input ref={recFileRef} type="file" accept="audio/*" onChange={onPickRecording} className="hidden" />
          <Button size="sm" variant="outline" onClick={() => recFileRef.current?.click()} disabled={recUploading}>
            {recUploading
              ? <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Uploading…</>
              : <><Upload className="h-4 w-4 mr-1" /> Upload recording</>}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          For a long conversation, record it with your phone's Voice Memos app, then tap <span className="font-medium">Upload recording</span> — it's the most reliable way and won't cut off if the screen locks.
        </p>
        {caps?.recordings.length ? (
          <div className="space-y-2">
            {caps.recordings.map((r) => (
              <div key={r.id} className="flex items-center gap-2 rounded border bg-muted/30 p-2">
                <Mic className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium">
                    {new Date(r.recorded_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    {fmtDur(r.duration_seconds) ? ` • ${fmtDur(r.duration_seconds)}` : ""}
                  </div>
                  {r.audio_url ? (
                    // Stored in Supabase Storage — play straight from the CDN.
                    <audio controls preload="none" src={r.audio_url} className="mt-1 h-8 w-full" />
                  ) : recBlobs[r.id] ? (
                    <audio controls src={recBlobs[r.id]} className="mt-1 h-8 w-full" />
                  ) : (
                    <button onClick={() => playRec(r.id)} className="text-xs text-primary underline mt-0.5">Load &amp; play</button>
                  )}
                </div>
                <button onClick={() => deleteRec(r.id)} className="text-muted-foreground hover:text-destructive shrink-0"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No recordings yet.</p>
        )}
      </section>

      {/* Pre-inspection photos */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold flex items-center gap-2"><ImageIcon className="h-4 w-4 text-primary" /> Pre-inspection photos</h3>
        <p className="text-[11px] text-muted-foreground">Pick several at once. These also show up in the job's Inspection Pictures once it's on the schedule.</p>
        <input ref={fileRef} type="file" accept="image/*" multiple onChange={onPickPhoto} className="hidden" />
        <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={!!photoProgress}>
          {photoProgress
            ? <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Uploading {photoProgress.done}/{photoProgress.total}…</>
            : <><Camera className="h-4 w-4 mr-1" /> Add photos</>}
        </Button>
        {caps?.photos.length ? (
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {caps.photos.map((p) => (
              <div key={p.id} className="relative group aspect-square rounded border overflow-hidden bg-muted/40">
                {photoBlobs[p.id] ? (
                  <img src={photoBlobs[p.id]} alt="estimate" className="h-full w-full object-cover" />
                ) : (
                  <div className="h-full w-full flex items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
                )}
                <button
                  onClick={() => deletePhoto(p.id)}
                  className="absolute top-1 right-1 rounded-full bg-black/60 p-1 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No photos yet.</p>
        )}
      </section>

      {/* Notes */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <StickyNote className="h-4 w-4 text-primary" /> Estimate notes
        </h3>
        <Textarea
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          onBlur={() => saveNotes(notes)}
          placeholder="What you saw, what the customer wants, access/parking, anything the crew should know…"
          rows={5}
        />
        <div className="text-[11px] h-4 flex items-center gap-1">
          {notesStatus === "saving" ? (
            <span className="flex items-center gap-1 text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Saving…</span>
          ) : notes !== notesSaved.current ? (
            <span className="text-amber-600">Unsaved changes</span>
          ) : notesStatus === "saved" ? (
            <span className="text-emerald-600">Saved ✓</span>
          ) : null}
        </div>
      </section>
    </div>
  );
}

// ── In-browser audio recorder (MediaRecorder) ───────────────────────────────
function Recorder({ leadId, onUploaded }: { leadId: string; onUploaded: () => void }) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  // If the upload fails, we keep the captured audio here so it's never lost —
  // the estimator can Retry or Download it as a backup.
  const [failed, setFailed] = useState<{ blob: Blob; dur: number } | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const startRef = useRef<number>(0);
  const timerRef = useRef<number | null>(null);

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; }
  };

  useEffect(() => () => stopTracks(), []);

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.error("Recording isn't supported on this device");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      // Pick a mime the browser actually supports (iOS/Safari records MP4/AAC,
      // not webm). Force-labeling everything "audio/webm" makes iPhone
      // recordings fail to play back — so we negotiate here and use the real
      // type on the resulting blob.
      const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/mpeg", "audio/ogg"];
      const supported = typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported
        ? preferred.find((t) => MediaRecorder.isTypeSupported(t))
        : undefined;
      const mr = supported ? new MediaRecorder(stream, { mimeType: supported }) : new MediaRecorder(stream);
      mr.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        const type = mr.mimeType || supported || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        const dur = (performance.now() - startRef.current) / 1000;
        stopTracks();
        setRecording(false);
        setElapsed(0);
        void doUpload(blob, dur);
      };
      mediaRef.current = mr;
      // Flush a chunk every 5s (instead of only at stop) so a long recording
      // isn't held entirely in memory until the end.
      mr.start(5000);
      startRef.current = performance.now();
      setRecording(true);
      timerRef.current = window.setInterval(() => setElapsed((performance.now() - startRef.current) / 1000), 500);
    } catch {
      toast.error("Microphone permission denied");
    }
  };

  const stop = () => mediaRef.current?.stop();

  const doUpload = async (blob: Blob, dur: number) => {
    setBusy(true);
    try {
      await api.uploadEstimatorRecording(leadId, blob, dur);
      toast.success("Recording saved");
      setFailed(null);
      onUploaded();
    } catch (e) {
      // Keep the audio so it's never silently lost — offer Retry / Download.
      setFailed({ blob, dur });
      toast.error(e instanceof Error ? e.message : "Upload failed — your recording is safe, tap Retry.");
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    if (!failed) return;
    const url = URL.createObjectURL(failed.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `estimate-recording.${audioExt(failed.blob.type)}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (failed) {
    return (
      <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs space-y-2">
        <div className="text-amber-800">Recording captured but didn't upload. It's still here — retry, or download it as a backup.</div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => doUpload(failed.blob, failed.dur)} disabled={busy}>
            {busy ? <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Retrying…</> : <><RotateCw className="h-4 w-4 mr-1" /> Retry upload</>}
          </Button>
          <Button size="sm" variant="outline" onClick={download} disabled={busy}><Download className="h-4 w-4 mr-1" /> Download</Button>
        </div>
      </div>
    );
  }
  if (busy) {
    return <Button size="sm" variant="outline" disabled><Loader2 className="h-4 w-4 animate-spin mr-1" /> Saving…</Button>;
  }
  return recording ? (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="destructive" onClick={stop}><Square className="h-4 w-4 mr-1" /> Stop</Button>
      <span className="text-xs text-muted-foreground flex items-center gap-1">
        <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" /> {fmtDur(elapsed) || "0:00"}
      </span>
    </div>
  ) : (
    <Button size="sm" variant="outline" onClick={start}><Mic className="h-4 w-4 mr-1" /> Record conversation</Button>
  );
}
