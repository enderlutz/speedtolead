import { useEffect, useRef, useState, useCallback } from "react";
import { api, type JobPhotoMeta } from "@/lib/api";
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
 * Job Photos — three camera-upload buckets the crew fills from their phone in
 * the SOP section of an assigned job. Unlimited photos per bucket. Lives next
 * to the SOP checklist in the job detail modal; visible to crew and admin.
 *
 * Egress-safe: lists metadata only, then loads each thumbnail's bytes once via
 * a blob URL that's revoked on unmount. Mirrors the SOP photo gallery pattern.
 */
export default function JobPhotosPanel({ jobId }: { jobId: string }) {
  const [photos, setPhotos] = useState<JobPhotoMeta[]>([]);
  const [blobs, setBlobs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [uploadingCat, setUploadingCat] = useState<string | null>(null);
  // Ref mirror of blobs so the unmount cleanup revokes the latest set without
  // re-subscribing the effect on every upload.
  const blobsRef = useRef<Record<string, string>>({});
  useEffect(() => { blobsRef.current = blobs; }, [blobs]);

  const loadBlob = useCallback(async (id: string) => {
    const url = await api.fetchJobPhotoBlobUrl(jobId, id);
    if (url) setBlobs((prev) => ({ ...prev, [id]: url }));
  }, [jobId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.listJobPhotos(jobId);
      setPhotos(r.photos);
      await Promise.all(r.photos.map((p) => loadBlob(p.id)));
    } catch {
      // Silent — an empty panel is the right fallback (e.g. not yet assigned).
    } finally {
      setLoading(false);
    }
  }, [jobId, loadBlob]);

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

  return (
    <div className="border rounded-lg p-3 space-y-3">
      <div className="flex items-center gap-2">
        <Camera className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">Job Photos</h3>
      </div>
      {loading ? (
        <div className="py-4 text-center text-xs text-muted-foreground">Loading photos…</div>
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
            </div>
          );
        })
      )}
    </div>
  );
}
