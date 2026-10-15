// Photo 1, Photo 2, … every scope drawing for this customer, right in the
// editor (Alan, 2026-10-14: "I built version 2 but I can't go back to
// version 1… just put photo one, photo two… stop making this so
// complicated"). Tap one to see it big and open it to edit; the one that
// was open is saved under its own number first, photo and all. "+ Photo"
// starts the next one from the same photo or a new one.
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, PencilLine, Plus, Check, ArrowLeft, Image as ImageIcon, Copy } from "lucide-react";
import { api, type FenceScopeVersion } from "@/lib/api";

interface Props {
  leadId: string;
  /** Bumps whenever the scope is saved or sent, so the list refetches. */
  revision: number;
  /** Called once a different photo is open, so the editor reloads it. */
  onRevised: () => void;
}

/** A filed photo's picture, fetched with the login (a bare <img src> gets
 *  turned away, the API reads the token from the header only). */
function VersionImage({ leadId, id, className, alt }: { leadId: string; id: string; className: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    api.fetchFenceScopeVersionBlobUrl(leadId, id).then((u) => {
      made = u;
      if (alive) setUrl(u); else if (u) URL.revokeObjectURL(u);
    }).catch(() => {});
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [leadId, id]);
  return url
    ? <img src={url} alt={alt} className={className} />
    : <span className={`${className} flex items-center justify-center bg-ink/5`}><ImageIcon className="h-4 w-4 text-ink/40" /></span>;
}

function shortDate(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function ScopeVersions({ leadId, revision, onRevised }: Props) {
  const [versions, setVersions] = useState<FenceScopeVersion[]>([]);
  const [openNo, setOpenNo] = useState(1);
  const [openSent, setOpenSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<FenceScopeVersion | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    api.getFenceScopeVersions(leadId)
      .then((r) => {
        setVersions([...r.versions].sort((a, b) => a.version_no - b.version_no));
        setOpenNo(r.active_version_no);
        setOpenSent(!!r.active_sent_at);
      })
      .catch(() => { /* a missing list is not worth interrupting a trace for */ });
  }, [leadId]);

  useEffect(() => { load(); }, [load, revision]);

  const openPhoto = async (v: FenceScopeVersion) => {
    setBusy(true);
    try {
      await api.openFenceScopeDrawing(leadId, v.id);
      toast.success(`Photo ${openNo} saved. Photo ${v.version_no} is open.`);
      setPreview(null);
      load();
      onRevised();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't open that photo");
    } finally {
      setBusy(false);
    }
  };

  const addPhoto = async (newPhoto: boolean) => {
    setBusy(true);
    try {
      const r = await api.newFenceScopeDrawing(leadId, newPhoto);
      toast.success(`Photo ${r.filed_drawing_no} saved. Photo ${r.editing_drawing_no} is open${newPhoto ? ": add its picture" : ""}.`);
      setAdding(false);
      load();
      onRevised();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't start another photo");
    } finally {
      setBusy(false);
    }
  };

  // Every photo in number order, the open one in its place.
  const items: ({ kind: "filed"; v: FenceScopeVersion } | { kind: "open" })[] = [
    ...versions.map((v) => ({ kind: "filed" as const, v })),
    { kind: "open" as const },
  ].sort((a, b) => (a.kind === "open" ? openNo : a.v.version_no) - (b.kind === "open" ? openNo : b.v.version_no));

  return (
    <>
      <div className="flex items-center gap-2 overflow-x-auto border-b border-gold/20 bg-ivory/70 px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <span className="shrink-0 text-[11px] font-bold uppercase tracking-wider text-bronze">Photos</span>
        {items.map((it) => it.kind === "open" ? (
          <span key="open" className="inline-flex h-12 shrink-0 items-center gap-1.5 rounded-xl bg-gold/25 px-3 text-[13px] font-bold text-bronze ring-2 ring-gold">
            <PencilLine className="h-4 w-4" /> Photo {openNo}
            <span className="font-semibold text-bronze/80">{openSent ? "· sent" : "· open"}</span>
          </span>
        ) : (
          <button key={it.v.id} type="button" onClick={() => setPreview(it.v)} disabled={busy}
            className="inline-flex h-12 shrink-0 items-center gap-2 rounded-xl border border-gold/40 bg-white pl-1 pr-3 text-[13px] font-semibold text-ink/80 transition hover:bg-gold/10 disabled:opacity-50"
            title={`Photo ${it.v.version_no}${it.v.sent_at ? `, sent ${shortDate(it.v.sent_at)}` : ""}. Tap to see it or open it.`}>
            {it.v.has_image ? (
              <VersionImage leadId={leadId} id={it.v.id} alt="" className="h-10 w-10 rounded-lg object-cover" />
            ) : <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-ink/5"><ImageIcon className="h-4 w-4" /></span>}
            Photo {it.v.version_no}
            {it.v.sent_at ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : null}
          </button>
        ))}
        <button type="button" onClick={() => setAdding(true)} disabled={busy}
          className="inline-flex h-12 shrink-0 items-center gap-1 rounded-xl border border-dashed border-gold/60 bg-white px-3 text-[13px] font-bold text-bronze transition hover:bg-gold/10 disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Photo
        </button>
      </div>

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm" onClick={() => setPreview(null)}>
          <div className="w-full max-w-lg space-y-3 rounded-2xl bg-ivory p-3 shadow-2xl ring-1 ring-gold/40" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setPreview(null)} className="inline-flex h-11 items-center gap-1.5 rounded-xl bg-ink/5 px-3 text-sm font-bold">
                <ArrowLeft className="h-4 w-4" /> Back
              </button>
              <p className="font-heading text-base font-bold text-ink">
                Photo {preview.version_no}
                {preview.sent_at ? <span className="ml-2 text-xs font-normal text-muted-foreground">sent {shortDate(preview.sent_at)}</span> : null}
              </p>
            </div>
            <VersionImage leadId={leadId} id={preview.id} alt={`Photo ${preview.version_no}`} className="min-h-40 w-full rounded-xl ring-1 ring-ink/10" />
            <button type="button" onClick={() => void openPhoto(preview)} disabled={busy}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-ink text-base font-bold text-gold-light disabled:opacity-60">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PencilLine className="h-4 w-4" />} Open Photo {preview.version_no} to edit
            </button>
            <p className="text-center text-xs text-muted-foreground">Photo {openNo} is saved first, so nothing is lost.{preview.sent_at ? " The link the customer has keeps showing what they were sent." : ""}</p>
          </div>
        </div>
      )}

      {adding && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4" onClick={() => setAdding(false)}>
          <div className="w-full max-w-md space-y-2 rounded-t-3xl bg-ivory p-4 shadow-2xl sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
            <p className="font-heading text-lg font-bold">Start Photo {Math.max(openNo, ...versions.map((v) => v.version_no)) + 1}</p>
            <p className="text-sm text-muted-foreground">Photo {openNo} is saved as it is.</p>
            <button type="button" onClick={() => void addPhoto(false)} disabled={busy}
              className="flex min-h-[56px] w-full items-center gap-3 rounded-xl bg-white px-4 py-3 text-left ring-1 ring-ink/10 disabled:opacity-60">
              <Copy className="h-5 w-5 shrink-0 text-bronze" />
              <span><span className="block font-bold">Same photo, copy the lines</span><span className="block text-xs text-muted-foreground">To show a second option, or fix a side</span></span>
            </button>
            <button type="button" onClick={() => void addPhoto(true)} disabled={busy}
              className="flex min-h-[56px] w-full items-center gap-3 rounded-xl bg-white px-4 py-3 text-left ring-1 ring-ink/10 disabled:opacity-60">
              <ImageIcon className="h-5 w-5 shrink-0 text-bronze" />
              <span><span className="block font-bold">A new photo</span><span className="block text-xs text-muted-foreground">Different picture, start the lines fresh</span></span>
            </button>
            <button type="button" onClick={() => setAdding(false)} className="h-11 w-full text-sm font-semibold underline">Not now</button>
          </div>
        </div>
      )}
    </>
  );
}
