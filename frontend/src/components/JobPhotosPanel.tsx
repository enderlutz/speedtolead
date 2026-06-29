import { useEffect, useRef, useState, useCallback } from "react";
import { api, type JobPhotoMeta, type ScheduledJob } from "@/lib/api";
import { toast } from "sonner";
import { Camera, Trash2, Image as ImageIcon, Loader2 } from "lucide-react";

// The three fixed buckets every assigned job gets. Order = the natural
// job flow: inspect → clean → stain. Keys match the backend category enum.
const CATEGORIES: { key: string; label: string }[] = [
  { key: "inspection", label: "Inspection Pictures" },
  { key: "post_cleanup", label: "Post Cleanup" },
  { key: "post_staining", label: "Post Staining" },
];

/**
 * Job Photos & field report — the crew's per-job record, organized into the
 * three buckets (Inspection / Post Cleanup / Post Staining). Each bucket has
 * camera-upload photos plus the field the crew records for that stage:
 *   - Inspection → free-text inspection notes
 *   - Post Cleanup → bleach gallons used
 *   - Post Staining → stain assigned (read-only) + stain gallons used
 *
 * Same component renders on the worker SOP page (crew input) and in the admin
 * Employee View / job modal (admin reads the same data). Fields auto-save on
 * blur via the materials endpoint; backend gates writes to assigned crew/staff.
 * Egress-safe: photo metadata only, thumbnails load + revoke per blob URL.
 */
export default function JobPhotosPanel({ jobId }: { jobId: string }) {
  const [photos, setPhotos] = useState<JobPhotoMeta[]>([]);
  const [blobs, setBlobs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [uploadingCat, setUploadingCat] = useState<string | null>(null);
  const blobsRef = useRef<Record<string, string>>({});
  useEffect(() => { blobsRef.current = blobs; }, [blobs]);

  // Field report — pulled from the job row, edited inline, saved on blur.
  const [inspectionNotes, setInspectionNotes] = useState("");
  const [bleachUsed, setBleachUsed] = useState("");
  const [stainUsed, setStainUsed] = useState("");
  const [stainAssigned, setStainAssigned] = useState("");
  const [savingField, setSavingField] = useState<string | null>(null);
  // Baseline of last-saved values so a blur with no change is a no-op (and
  // doesn't clobber a value another field's save just refreshed).
  const initial = useRef({ notes: "", bleach: "", stain: "", assigned: "" });

  const applyJob = useCallback((j: ScheduledJob) => {
    const notes = j.inspection_notes || "";
    const bleach = j.bleach_gallons ? String(j.bleach_gallons) : "";
    const stain = j.stain_gallons_used ? String(j.stain_gallons_used) : "";
    const assigned = j.gallons_estimate ? String(j.gallons_estimate) : "";
    setInspectionNotes(notes);
    setBleachUsed(bleach);
    setStainUsed(stain);
    setStainAssigned(assigned);
    initial.current = { notes, bleach, stain, assigned };
  }, []);

  const loadBlob = useCallback(async (id: string) => {
    const url = await api.fetchJobPhotoBlobUrl(jobId, id);
    if (url) setBlobs((prev) => ({ ...prev, [id]: url }));
  }, [jobId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r] = await Promise.all([
        api.listJobPhotos(jobId),
        api.getScheduledJob(jobId).then(applyJob).catch(() => {}),
      ]);
      setPhotos(r.photos);
      await Promise.all(r.photos.map((p) => loadBlob(p.id)));
    } catch {
      // Silent — an empty panel is the right fallback (e.g. not yet assigned).
    } finally {
      setLoading(false);
    }
  }, [jobId, loadBlob, applyJob]);

  useEffect(() => { load(); }, [load]);

  // Revoke every object URL when the panel closes so we don't leak them.
  useEffect(() => {
    return () => { Object.values(blobsRef.current).forEach((u) => URL.revokeObjectURL(u)); };
  }, []);

  const upload = async (category: string, files: FileList | null) => {
    const list = Array.from(files || []);
    if (!list.length) return;
    setUploadingCat(category);
    try {
      for (const f of list) {
        const meta = await api.uploadJobPhoto(jobId, category, f);
        setPhotos((prev) => [...prev, meta]);
        await loadBlob(meta.id);
      }
      toast.success(list.length > 1 ? `${list.length} photos uploaded` : "Photo uploaded");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploadingCat(null);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Remove this photo?")) return;
    try {
      await api.deleteJobPhoto(jobId, id);
      setPhotos((prev) => prev.filter((p) => p.id !== id));
      setBlobs((prev) => {
        const u = prev[id];
        if (u) URL.revokeObjectURL(u);
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const saveField = async (field: "notes" | "bleach" | "stain" | "assigned", value: string) => {
    const body: { inspection_notes?: string; bleach_gallons?: number; stain_gallons?: number; stain_assigned?: number } = {};
    if (field === "notes") {
      if (value === initial.current.notes) return;
      body.inspection_notes = value;
    } else if (field === "bleach") {
      if (value === initial.current.bleach) return;
      body.bleach_gallons = parseFloat(value) || 0;
    } else if (field === "assigned") {
      if (value === initial.current.assigned) return;
      body.stain_assigned = parseFloat(value) || 0;
    } else {
      if (value === initial.current.stain) return;
      body.stain_gallons = parseFloat(value) || 0;
    }
    setSavingField(field);
    try {
      const updated = await api.updateJobMaterials(jobId, body);
      applyJob(updated);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSavingField(null);
    }
  };

  return (
    <div className="border rounded-lg p-3 space-y-3">
      <div className="flex items-center gap-2">
        <Camera className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">Job Photos &amp; Notes</h3>
      </div>
      {loading ? (
        <div className="py-4 text-center text-xs text-muted-foreground">Loading…</div>
      ) : (
        CATEGORIES.map((c) => {
          const items = photos.filter((p) => p.category === c.key);
          const busy = uploadingCat === c.key;
          return (
            <div key={c.key} className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold">
                  {c.label}
                  {items.length > 0 && (
                    <span className="ml-1.5 text-[10px] text-muted-foreground font-normal">({items.length})</span>
                  )}
                </span>
                <label className={`inline-flex items-center gap-1 text-[11px] cursor-pointer text-primary hover:underline ${busy ? "opacity-60 pointer-events-none" : ""}`}>
                  {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Camera className="h-3 w-3" />}
                  {busy ? "Uploading…" : "Add photos"}
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    multiple
                    className="hidden"
                    disabled={busy}
                    onChange={(e) => {
                      upload(c.key, e.target.files);
                      e.currentTarget.value = "";
                    }}
                  />
                </label>
              </div>

              {items.length === 0 ? (
                <p className="text-[11px] text-muted-foreground italic">No photos yet.</p>
              ) : (
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
                  {items.map((p) => (
                    <div key={p.id} className="relative group aspect-square rounded overflow-hidden border bg-muted">
                      {blobs[p.id] ? (
                        <img src={blobs[p.id]} alt={c.label} className="h-full w-full object-cover" />
                      ) : (
                        <div className="h-full w-full grid place-items-center text-muted-foreground">
                          <ImageIcon className="h-4 w-4" />
                        </div>
                      )}
                      <button
                        onClick={() => remove(p.id)}
                        className="absolute top-0.5 right-0.5 bg-black/60 text-white rounded p-0.5 opacity-0 group-hover:opacity-100 transition"
                        title="Remove photo"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Per-category crew field report */}
              {c.key === "inspection" && (
                <div>
                  <label className="text-[11px] font-semibold text-muted-foreground flex items-center gap-1 mb-0.5">
                    Pre-Inspection Notes
                    {savingField === "notes" && <Loader2 className="h-3 w-3 animate-spin" />}
                  </label>
                  <textarea
                    value={inspectionNotes}
                    onChange={(e) => setInspectionNotes(e.target.value)}
                    onBlur={() => saveField("notes", inspectionNotes)}
                    rows={2}
                    placeholder="What did the crew find on inspection?"
                    className="w-full text-xs rounded border bg-background p-1.5 resize-y focus:outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </div>
              )}

              {c.key === "post_cleanup" && (
                <div className="flex items-center gap-2">
                  <label className="text-[11px] font-semibold text-muted-foreground">Bleach used (gal)</label>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    value={bleachUsed}
                    onChange={(e) => setBleachUsed(e.target.value)}
                    onBlur={() => saveField("bleach", bleachUsed)}
                    placeholder="0"
                    className="w-20 text-xs rounded border bg-background px-1.5 py-1 focus:outline-none focus:ring-2 focus:ring-primary/40"
                  />
                  {savingField === "bleach" && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                </div>
              )}

              {c.key === "post_staining" && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <label className="text-[11px] font-semibold text-muted-foreground w-24">Stain assigned (gal)</label>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      value={stainAssigned}
                      onChange={(e) => setStainAssigned(e.target.value)}
                      onBlur={() => saveField("assigned", stainAssigned)}
                      placeholder="0"
                      className="w-20 text-xs rounded border bg-background px-1.5 py-1 focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                    {savingField === "assigned" && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-[11px] font-semibold text-muted-foreground w-24">Stain used (gal)</label>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      value={stainUsed}
                      onChange={(e) => setStainUsed(e.target.value)}
                      onBlur={() => saveField("stain", stainUsed)}
                      placeholder="0"
                      className="w-20 text-xs rounded border bg-background px-1.5 py-1 focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                    {savingField === "stain" && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
