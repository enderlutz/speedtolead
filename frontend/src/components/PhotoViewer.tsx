// Tap a photo, see it big, swipe through the rest of the section (Alan,
// 2026-10-20: "I don't want to have to hold down on them … a pop-up where I
// can swipe and just see all the photos"). Full screen, dark, big targets.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import { api, type CompanyCamPhoto } from "@/lib/api";
import { stampText } from "@/lib/photoTime";

function useSrc(leadId: string, photo: CompanyCamPhoto | undefined): string {
  const [blob, setBlob] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    if (!photo || photo.from_storage) return;
    let url = "";
    let dead = false;
    void api.fetchCompanyCamPhotoUrl(leadId, photo.id).then((u) => {
      if (dead || !u) return;
      url = u;
      setBlob({ id: photo.id, url: u });
    });
    return () => { dead = true; if (url) URL.revokeObjectURL(url); };
  }, [leadId, photo]);
  if (!photo) return "";
  if (photo.from_storage) return photo.url;
  return blob?.id === photo.id ? blob.url : "";
}

export default function PhotoViewer({ leadId, photos, start, title, onClose }: {
  leadId: string; photos: CompanyCamPhoto[]; start: number; title?: string; onClose: () => void;
}) {
  const [i, setI] = useState(() => Math.min(Math.max(start, 0), Math.max(photos.length - 1, 0)));
  const photo = photos[i];
  const src = useSrc(leadId, photo);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const go = (d: number) => setI((n) => (photos.length ? (n + d + photos.length) % photos.length : 0));

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", key);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", key); document.body.style.overflow = prev; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Preload the next picture so a swipe feels instant.
  const next = photos[(i + 1) % Math.max(photos.length, 1)];
  useEffect(() => { if (next?.from_storage) { const im = new Image(); im.src = next.url; } }, [next]);

  if (!photo) return null;
  const stamp = stampText(photo.taken_at || photo.uploaded_at);
  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col bg-black/95 text-white" role="dialog" aria-modal="true"
         onTouchStart={(e) => { const t = e.touches[0]; touch.current = { x: t.clientX, y: t.clientY }; }}
         onTouchEnd={(e) => {
           const s = touch.current; touch.current = null;
           if (!s) return;
           const t = e.changedTouches[0];
           const dx = t.clientX - s.x, dy = t.clientY - s.y;
           if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
           else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) onClose(); // swipe down closes
         }}>
      <div className="flex items-center justify-between gap-2 px-3 pt-[max(env(safe-area-inset-top),12px)] pb-2">
        <div className="min-w-0">
          {title ? <p className="truncate text-sm font-semibold">{title}</p> : null}
          <p className="text-xs text-white/70 tabular-nums">{i + 1} / {photos.length}{stamp ? ` · 🕒 ${stamp}` : ""}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 hover:bg-white/20">
          <X className="h-6 w-6" />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        {src ? <img key={photo.id} src={src} alt={photo.side || `Photo ${photo.seq}`} className="max-h-full max-w-full select-none object-contain" draggable={false} />
             : <Loader2 className="h-8 w-8 animate-spin text-white/60" />}
        {photos.length > 1 ? (
          <>
            <button type="button" onClick={() => go(-1)} aria-label="Previous photo"
                    className="absolute left-2 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 hover:bg-black/70">
              <ChevronLeft className="h-7 w-7" />
            </button>
            <button type="button" onClick={() => go(1)} aria-label="Next photo"
                    className="absolute right-2 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 hover:bg-black/70">
              <ChevronRight className="h-7 w-7" />
            </button>
          </>
        ) : null}
      </div>

      <div className="space-y-2 px-3 pt-2 pb-[max(env(safe-area-inset-bottom),12px)]">
        {photo.note || photo.side || photo.is_damage ? (
          <p className="text-sm">
            {photo.is_damage ? <span className="mr-1.5 rounded bg-red-600 px-1.5 py-0.5 text-xs font-bold">DAMAGE</span> : null}
            {[photo.side, photo.note].filter(Boolean).join(" · ")}
          </p>
        ) : null}
        {photos.length > 1 ? (
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {photos.map((p, n) => (
              <button key={p.id} type="button" onClick={() => setI(n)} aria-label={`Photo ${n + 1}`}
                      className={`h-14 w-14 shrink-0 overflow-hidden rounded-md ring-2 ${n === i ? "ring-white" : "ring-transparent opacity-60"}`}>
                {p.from_storage ? <img src={p.url} alt="" className="h-full w-full object-cover" loading="lazy" />
                                : <span className="flex h-full w-full items-center justify-center bg-white/10 text-xs">{n + 1}</span>}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
