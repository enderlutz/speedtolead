import { useState, useEffect, useRef, useCallback } from "react";
import { api, type EstimatorCaptures } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Camera, Mic, Square, Trash2, Loader2, StickyNote, Image as ImageIcon, AudioLines } from "lucide-react";

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
  const [savingNotes, setSavingNotes] = useState(false);

  const [photoBlobs, setPhotoBlobs] = useState<Record<string, string>>({});
  const photoBlobsRef = useRef<Record<string, string>>({});
  useEffect(() => { photoBlobsRef.current = photoBlobs; }, [photoBlobs]);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [recBlobs, setRecBlobs] = useState<Record<string, string>>({});
  const recBlobsRef = useRef<Record<string, string>>({});
  useEffect(() => { recBlobsRef.current = recBlobs; }, [recBlobs]);

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

  // Revoke object URLs on unmount.
  useEffect(() => () => {
    Object.values(photoBlobsRef.current).forEach(URL.revokeObjectURL);
    Object.values(recBlobsRef.current).forEach(URL.revokeObjectURL);
  }, []);

  const saveNotes = async () => {
    if (notes === notesSaved.current) return;
    setSavingNotes(true);
    try {
      await api.saveLeadNotes(leadId, notes);
      notesSaved.current = notes;
      toast.success("Notes saved");
    } catch {
      toast.error("Couldn't save notes");
    } finally {
      setSavingNotes(false);
    }
  };

  const onPickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadingPhoto(true);
    try {
      await api.uploadEstimatorPhoto(leadId, file);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploadingPhoto(false);
    }
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

  if (loading) {
    return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-5">
      {/* Conversation recording */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold flex items-center gap-2"><AudioLines className="h-4 w-4 text-primary" /> Conversation recording</h3>
        <Recorder leadId={leadId} onUploaded={load} />
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
                  {recBlobs[r.id] ? (
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
        <p className="text-[11px] text-muted-foreground">These also show up in the job's Inspection Pictures once it's on the schedule.</p>
        <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={onPickPhoto} className="hidden" />
        <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={uploadingPhoto}>
          {uploadingPhoto ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Camera className="h-4 w-4 mr-1" />} Add photo
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
          {savingNotes && <Loader2 className="h-3 w-3 animate-spin" />}
        </h3>
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={saveNotes}
          placeholder="What you saw, what the customer wants, access/parking, anything the crew should know…"
          rows={5}
        />
      </section>
    </div>
  );
}

// ── In-browser audio recorder (MediaRecorder) ───────────────────────────────
function Recorder({ leadId, onUploaded }: { leadId: string; onUploaded: () => void }) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
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
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const dur = (performance.now() - startRef.current) / 1000;
        stopTracks();
        setRecording(false);
        setElapsed(0);
        setBusy(true);
        try {
          await api.uploadEstimatorRecording(leadId, blob, dur);
          toast.success("Recording saved");
          onUploaded();
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Couldn't save recording");
        } finally {
          setBusy(false);
        }
      };
      mediaRef.current = mr;
      mr.start();
      startRef.current = performance.now();
      setRecording(true);
      timerRef.current = window.setInterval(() => setElapsed((performance.now() - startRef.current) / 1000), 500);
    } catch {
      toast.error("Microphone permission denied");
    }
  };

  const stop = () => mediaRef.current?.stop();

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
