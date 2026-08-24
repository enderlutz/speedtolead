import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
  api,
  STAIN_FINISH_TYPES,
  stainFinishLabel,
  type FencePhoto,
  type FencePhotoStain,
  type LeanLead,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomerSearchInput } from "@/components/SearchInput";
import { toast } from "sonner";
import {
  Images, Search, Trash2, Loader2, Plus, ChevronRight, ChevronDown,
  X, ChevronLeft, User as UserIcon, Pencil,
} from "lucide-react";

// Fence Photos — reference shots of finished fences, filed by stain colour.
//
// Same brand → opacity → colour skeleton as Stain Inventory (the colours ARE
// the stain_inventory rows), but each colour holds a gallery instead of a
// gallon count. Built for sales calls: pull up a colour, show the customer a
// real fence, and say whose it is.
//
// Colours stay COLLAPSED until tapped. That's not cosmetic — 25 colours with
// galleries rendered at once is a very heavy page on a phone mid-call.

const SELECT_CLASS =
  "h-9 rounded-md border border-input bg-background px-2 text-sm shadow-sm " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

type Group = { key: string; brand: string; finish: string; items: FencePhotoStain[]; photos: number };

/** Walk the already-sorted list and break a section on every brand-or-finish
 * change. Relies on the backend's sort — which is literally the same
 * _sort_key the Stain Inventory endpoint uses — so the two pages can't
 * disagree on section order. */
function groupStains(items: FencePhotoStain[]): Group[] {
  const groups: Group[] = [];
  for (const item of items) {
    const key = `${item.brand}|||${item.finish_type}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(item);
      last.photos += item.photo_count;
    } else {
      groups.push({
        key, brand: item.brand, finish: item.finish_type,
        items: [item], photos: item.photo_count,
      });
    }
  }
  return groups;
}

export default function FencePhotos() {
  const [items, setItems] = useState<FencePhotoStain[]>([]);
  const [totalPhotos, setTotalPhotos] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [finishFilter, setFinishFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // The full-screen viewer: which colour, and which photo within it.
  const [viewing, setViewing] = useState<{ stainId: string; index: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.listFencePhotos({
        q: search.trim() || undefined,
        finish_type: finishFilter || undefined,
      });
      setItems(r.items);
      setTotalPhotos(r.total_photos);
    } catch (e) {
      setItems([]);
      toast.error(e instanceof Error ? e.message : "Couldn't load the photos");
    } finally {
      setLoading(false);
    }
  }, [search, finishFilter]);

  // Debounced so typing in the search box doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const groups = useMemo(() => groupStains(items), [items]);
  const filtered = Boolean(search.trim() || finishFilter);

  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const viewingStain = viewing ? items.find((s) => s.id === viewing.stainId) : undefined;

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-4xl">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Images className="h-5 w-5 text-primary" /> Fence Photos
        </h1>
        <p className="text-sm text-muted-foreground">
          Finished fences by stain colour — pull one up on a call so the customer can see it.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-sm">
              {totalPhotos} photo{totalPhotos === 1 ? "" : "s"}
            </CardTitle>
          </div>
          <div className="flex items-center gap-2 flex-wrap pt-1">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-7 h-9"
                placeholder="Search brand or colour…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <select
              className={SELECT_CLASS}
              value={finishFilter}
              onChange={(e) => setFinishFilter(e.target.value)}
            >
              <option value="">All finishes</option>
              {STAIN_FINISH_TYPES.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </div>
        </CardHeader>

        <CardContent className="space-y-5">
          {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

          {!loading && groups.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {filtered
                ? "No colours match that search."
                : "No stain colours yet — add them on the Stain Inventory page and they'll show up here."}
            </p>
          )}

          {!loading && groups.map((g) => (
            <div key={g.key} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2 border-b pb-1">
                <h3 className="text-sm font-semibold">
                  {g.brand} <span className="text-muted-foreground font-normal">— {stainFinishLabel(g.finish)}</span>
                </h3>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {g.photos} photo{g.photos === 1 ? "" : "s"}
                </span>
              </div>
              {g.items.map((stain) => (
                <StainGallery
                  key={stain.id}
                  stain={stain}
                  open={expanded.has(stain.id)}
                  onToggle={() => toggle(stain.id)}
                  onChanged={load}
                  onView={(index) => setViewing({ stainId: stain.id, index })}
                />
              ))}
            </div>
          ))}
        </CardContent>
      </Card>

      {viewing && viewingStain && (
        <PhotoViewer
          stain={viewingStain}
          index={Math.min(viewing.index, viewingStain.photos.length - 1)}
          onIndex={(index) => setViewing({ stainId: viewingStain.id, index })}
          onClose={() => setViewing(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}

/** One colour: a collapsed summary row that expands into the photo grid. */
function StainGallery({
  stain, open, onToggle, onChanged, onView,
}: {
  stain: FencePhotoStain;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
  onView: (index: number) => void;
}) {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList | null) => {
    const list = Array.from(files || []);
    if (!list.length) return;
    setProgress({ done: 0, total: list.length });
    let failed = 0;
    // Sequential rather than parallel: these are multi-megabyte phone photos
    // and a burst of them on cell data is worse than a steady queue.
    for (let i = 0; i < list.length; i++) {
      try {
        await api.uploadFencePhoto(stain.id, list[i]);
      } catch {
        failed++;
      }
      setProgress({ done: i + 1, total: list.length });
    }
    setProgress(null);
    await onChanged();
    const ok = list.length - failed;
    if (failed === 0) toast.success(`${ok} photo${ok === 1 ? "" : "s"} added to ${stain.color_name}`);
    else if (ok === 0) toast.error("Photos failed to upload");
    else toast.error(`${ok} uploaded · ${failed} failed`);
  };

  const remove = async (photo: FencePhoto) => {
    if (!confirm("Remove this photo?")) return;
    try {
      await api.deleteFencePhoto(photo.id);
      toast.success("Photo removed");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't remove it");
    }
  };

  return (
    <div className="py-1">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        onClick={onToggle}
      >
        {open
          ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
        {stain.cover ? (
          <img
            src={stain.cover}
            alt=""
            loading="lazy"
            className="h-8 w-8 rounded object-cover border shrink-0"
          />
        ) : (
          <span className="h-8 w-8 rounded border bg-muted grid place-items-center shrink-0">
            <Images className="h-3.5 w-3.5 text-muted-foreground" />
          </span>
        )}
        <span className="flex-1 text-sm truncate">{stain.color_name}</span>
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {stain.photo_count === 0 ? "no photos" : `${stain.photo_count} photo${stain.photo_count === 1 ? "" : "s"}`}
        </span>
      </button>

      {open && (
        <div className="pl-6 pt-2 space-y-2">
          {stain.photos.length > 0 && (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
              {stain.photos.map((p, i) => (
                <div key={p.id} className="relative group aspect-square rounded overflow-hidden border bg-muted">
                  <button type="button" className="h-full w-full" onClick={() => onView(i)}>
                    <img
                      src={p.thumb_url}
                      alt={p.note || stain.color_name}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  </button>
                  {p.lead_name && (
                    <span className="absolute bottom-0 inset-x-0 bg-black/55 text-white text-[10px] px-1 py-0.5 truncate pointer-events-none">
                      {p.lead_name}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => remove(p)}
                    className="absolute top-0.5 right-0.5 bg-black/60 text-white rounded p-0.5 opacity-0 group-hover:opacity-100 transition"
                    title="Remove photo"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* No capture="environment" — that forces the camera and blocks
              picking from the camera roll, which is where these live. */}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => { upload(e.target.files); e.target.value = ""; }}
          />
          <button
            type="button"
            disabled={!!progress}
            onClick={() => fileRef.current?.click()}
            className="flex w-full items-center justify-center gap-1 rounded-md
              border border-blue-500/60 bg-blue-500/10 py-1.5 text-xs font-medium
              text-blue-600 transition-colors hover:border-blue-500 hover:bg-blue-500/20
              disabled:opacity-60 dark:text-blue-400"
          >
            {progress ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Uploading {progress.done}/{progress.total}…</>
            ) : (
              <><Plus className="h-3.5 w-3.5" /> Add photos</>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

/** Full-screen viewer — the phase-1 "get it big on screen so I can screenshot
 * it" path. Also where a photo's note and customer get set. */
function PhotoViewer({
  stain, index, onIndex, onClose, onChanged,
}: {
  stain: FencePhotoStain;
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const photo = stain.photos[index];
  const [editing, setEditing] = useState(false);

  const prev = useCallback(() => onIndex((index - 1 + stain.photos.length) % stain.photos.length), [index, stain.photos.length, onIndex]);
  const next = useCallback(() => onIndex((index + 1) % stain.photos.length), [index, stain.photos.length, onIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") prev();
      if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, prev, next]);

  if (!photo) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/90 flex flex-col" onClick={onClose}>
      <div className="flex items-center justify-between gap-2 p-3 text-white shrink-0">
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">
            {stain.brand} · {stain.color_name}
          </p>
          <p className="text-xs text-white/60">
            {index + 1} of {stain.photos.length}
          </p>
        </div>
        <button type="button" onClick={onClose} className="p-1.5 rounded hover:bg-white/10" title="Close">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="flex-1 min-h-0 flex items-center justify-center px-2" onClick={(e) => e.stopPropagation()}>
        {stain.photos.length > 1 && (
          <button type="button" onClick={prev} className="p-2 text-white/70 hover:text-white shrink-0" title="Previous">
            <ChevronLeft className="h-7 w-7" />
          </button>
        )}
        <img
          src={photo.url}
          alt={photo.note || stain.color_name}
          className="max-h-full max-w-full object-contain"
        />
        {stain.photos.length > 1 && (
          <button type="button" onClick={next} className="p-2 text-white/70 hover:text-white shrink-0" title="Next">
            <ChevronRight className="h-7 w-7" />
          </button>
        )}
      </div>

      <div className="shrink-0 p-3 text-white" onClick={(e) => e.stopPropagation()}>
        {editing ? (
          <PhotoDetailsForm
            photo={photo}
            onCancel={() => setEditing(false)}
            onSaved={() => { setEditing(false); onChanged(); }}
          />
        ) : (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 text-sm">
              {photo.lead_name && (
                <p className="flex items-center gap-1.5 text-white/90">
                  <UserIcon className="h-3.5 w-3.5 shrink-0" /> {photo.lead_name}
                </p>
              )}
              {photo.note && <p className="text-white/70 text-xs mt-0.5">{photo.note}</p>}
              {!photo.lead_name && !photo.note && (
                <p className="text-white/40 text-xs">No note or customer yet</p>
              )}
            </div>
            <Button size="sm" variant="secondary" className="h-8 shrink-0" onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Note + which customer's fence this is. The customer link is what lets Alan
 * say "this is the Johnson place over on Oak" on a call. */
function PhotoDetailsForm({
  photo, onCancel, onSaved,
}: {
  photo: FencePhoto;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [note, setNote] = useState(photo.note);
  const [leadId, setLeadId] = useState(photo.lead_id);
  const [leadText, setLeadText] = useState(photo.lead_name);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.updateFencePhoto(photo.id, { note: note.trim(), lead_id: leadId });
      toast.success("Saved");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md bg-white/10 p-2">
      <CustomerSearchInput
        value={leadText}
        onChange={(text) => {
          setLeadText(text);
          // Typing after a pick means they're changing their mind — drop the
          // stale id so a half-typed name can't stay linked to the old lead.
          if (leadId) setLeadId("");
        }}
        onSelect={(lead: LeanLead) => { setLeadId(lead.id); setLeadText(lead.contact_name || ""); }}
        placeholder="Whose fence is this? (optional)"
        className="h-9"
      />
      <Input
        className="h-9"
        placeholder="Note — e.g. 2 coats, west-facing (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") save(); }}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" className="h-8" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" className="h-8 text-white hover:bg-white/10" onClick={onCancel}>
          Cancel
        </Button>
        {leadId && (
          <button
            type="button"
            className="text-xs text-white/60 hover:text-white ml-auto"
            onClick={() => { setLeadId(""); setLeadText(""); }}
          >
            Unlink customer
          </button>
        )}
      </div>
    </div>
  );
}
