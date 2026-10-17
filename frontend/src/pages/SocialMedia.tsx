import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, Check, Clapperboard, Download, ImagePlus, Loader2, Search, Trash2, Video, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, canSeeRevenue, type ContentItem, type ContentPatch } from "@/lib/api";
import { cn, formatCurrency } from "@/lib/utils";

// Social media content (Alan, 2026-10-17): every photo and video from a job
// in one place, at the quality it was shot, tagged to the customer so the
// editor sees the job (package, colour, price for the owners) without
// asking. The file goes from the phone straight to storage on a one-time
// link; nothing here resizes or re-encodes it.

const STATUSES: { key: "" | "raw" | "edited" | "posted"; label: string }[] = [
  { key: "", label: "All" }, { key: "raw", label: "Raw" }, { key: "edited", label: "Edited" }, { key: "posted", label: "Posted" },
];
const mb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(n > 100 * 1024 * 1024 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const when = (iso: string) => (iso ? new Date(iso + (iso.length === 10 ? "T12:00:00" : "")).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");
const dur = (s: number | null) => (s == null ? "" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);
const today = () => new Date().toLocaleDateString("en-CA");

// Who uploaded it, as a coloured tag on every tile (Alan, 2026-10-17: "red
// for Alan, and if Alec uploads it, it says Alec"). The colour follows the
// name, so one person is always the same colour.
const TAG_COLORS = ["bg-blue-600", "bg-emerald-600", "bg-violet-600", "bg-amber-600", "bg-pink-600", "bg-teal-600", "bg-orange-600", "bg-indigo-600"];
function uploaderTag(name: string): { label: string; cls: string } {
  const label = (name || "").trim().split(/\s+/)[0] || "?";
  if (/^alan/i.test(name)) return { label, cls: "bg-red-600" };
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { label, cls: TAG_COLORS[h % TAG_COLORS.length] };
}

/** Width, height and length, read on the phone before the upload. */
function measure(file: File): Promise<{ width?: number; height?: number; duration_seconds?: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const done = (v: { width?: number; height?: number; duration_seconds?: number }) => { URL.revokeObjectURL(url); resolve(v); };
    if (file.type.startsWith("video/")) {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => done({ width: v.videoWidth, height: v.videoHeight, duration_seconds: v.duration });
      v.onerror = () => done({});
      v.src = url;
    } else {
      const img = new Image();
      img.onload = () => done({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => done({});
      img.src = url;
    }
  });
}

/** PUT the file to storage, byte for byte, with progress. */
function putFile(url: string, file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("Cache-Control", "max-age=31536000");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Storage said ${xhr.status}. ${xhr.responseText.slice(0, 160)}`)));
    xhr.onerror = () => reject(new Error("The upload dropped. Check your signal and try again."));
    xhr.send(file);
  });
}

type Job = { name: string; pct: number; state: "uploading" | "done" | "error"; error?: string };

export default function SocialMedia() {
  const [items, setItems] = useState<ContentItem[] | null>(null);
  const [ready, setReady] = useState(true);
  const [status, setStatus] = useState<"" | "raw" | "edited" | "posted">("");
  const [q, setQ] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [open, setOpen] = useState<ContentItem | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const showPrice = canSeeRevenue();

  const load = useCallback(async () => {
    try {
      const r = await api.listContent({ status });
      setItems(r.items);
      setReady(r.storage_ready);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load");
      setItems([]);
    }
  }, [status]);
   
  useEffect(() => { load(); }, [load]);

  const upload = async (list: FileList | null) => {
    const files = Array.from(list || []);
    if (!files.length) return;
    const start = jobs.length;
    setJobs((j) => [...j, ...files.map((f) => ({ name: f.name, pct: 0, state: "uploading" as const }))]);
    const set = (i: number, patch: Partial<Job>) => setJobs((j) => j.map((x, k) => (k === start + i ? { ...x, ...patch } : x)));
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      try {
        const kind = f.type.startsWith("video/") ? "video" : "photo";
        const signed = await api.signContentUpload({ filename: f.name, mime: f.type, size: f.size, kind, shot_on: new Date(f.lastModified || Date.now()).toLocaleDateString("en-CA") });
        await putFile(signed.upload_url, f, (pct) => set(i, { pct }));
        const dims = await measure(f);
        await api.contentUploaded(signed.id, dims);
        set(i, { state: "done", pct: 100 });
      } catch (e) {
        set(i, { state: "error", error: e instanceof Error ? e.message : "Failed" });
      }
    }
    void load();
    setTimeout(() => setJobs((j) => j.filter((x) => x.state !== "done")), 4000);
  };

  const patch = async (id: string, p: ContentPatch) => {
    try {
      const fresh = await api.updateContent(id, p);
      setItems((cur) => (cur || []).map((x) => (x.id === id ? fresh : x)));
      setOpen((cur) => (cur && cur.id === id ? fresh : cur));
    } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't save"); }
  };

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return items || [];
    return (items || []).filter((i) => `${i.note} ${i.filename} ${i.lead?.name || ""} ${i.lead?.address || ""}`.toLowerCase().includes(needle));
  }, [items, q]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Social media</h1>
          <p className="text-sm text-muted-foreground">Raw photos and videos from jobs, kept at the quality they were shot. Tag each one to the customer.</p>
        </div>
        <input ref={input} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => { void upload(e.target.files); e.target.value = ""; }} />
        <Button size="lg" className="h-12 font-bold" onClick={() => input.current?.click()} disabled={!ready}>
          <ImagePlus className="mr-2 h-5 w-5" /> Add photos or videos
        </Button>
      </div>

      {!ready && (
        <p className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Storage isn't set up on the server yet, so uploads are off. Fragne adds the Supabase keys in Railway and this turns on.</p>
      )}

      <p className="text-xs text-muted-foreground">
        For the best quality from an iPhone, pick the file through <b>Browse</b> (the Files app) rather than the photo library, or add it from a computer. The photo library can hand over a smaller copy. Big videos can take a few minutes; keep this page open.
      </p>

      {jobs.length > 0 && (
        <div className="space-y-1.5">
          {jobs.map((j, i) => (
            <div key={i} className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
              {j.state === "uploading" ? <Loader2 className="h-4 w-4 animate-spin" /> : j.state === "done" ? <Check className="h-4 w-4 text-emerald-600" /> : <X className="h-4 w-4 text-red-600" />}
              <span className="min-w-0 flex-1 truncate">{j.name}</span>
              {j.state === "uploading" && <span className="w-20 overflow-hidden rounded-full bg-muted"><span className="block h-2 bg-primary" style={{ width: `${j.pct}%` }} /></span>}
              {j.state === "uploading" && <span className="w-10 text-right tabular-nums">{j.pct}%</span>}
              {j.state === "error" && <span className="text-xs text-red-600">{j.error}</span>}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {STATUSES.map((s) => (
          <button key={s.key} onClick={() => setStatus(s.key)}
            className={cn("min-h-[40px] rounded-full px-4 text-sm font-semibold", status === s.key ? "bg-primary text-primary-foreground" : "bg-muted")}>
            {s.label}
          </button>
        ))}
        <div className="relative ml-auto w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Customer, address or note" className="h-10 pl-8" />
        </div>
      </div>

      {items === null ? <Loader2 className="h-5 w-5 animate-spin" /> : shown.length === 0 ? (
        <Card><CardContent className="flex flex-col items-center gap-2 p-10 text-center text-muted-foreground">
          <Clapperboard className="h-8 w-8" />
          <p className="font-semibold">Nothing here yet.</p>
          <p className="text-sm">Tap "Add photos or videos". A whole day's filming at once is fine.</p>
        </CardContent></Card>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {shown.map((it) => (
            <button key={it.id} type="button" onClick={() => setOpen(it)} className="overflow-hidden rounded-xl border bg-card text-left shadow-sm transition hover:shadow-md">
              <div className="relative aspect-square bg-muted">
                {it.kind === "video"
                  ? <video src={`${it.url}#t=0.5`} preload="metadata" muted playsInline className="h-full w-full object-cover" />
                  : <img src={it.url} alt="" loading="lazy" className="h-full w-full object-cover" />}
                <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-xs font-bold text-white">
                  {it.kind === "video" ? <><Video className="h-3 w-3" /> {dur(it.duration_seconds)}</> : "Photo"}
                </span>
                <span className={cn("absolute right-1.5 top-1.5 rounded-md px-1.5 py-0.5 text-xs font-bold capitalize text-white",
                  it.status === "posted" ? "bg-emerald-600" : it.status === "edited" ? "bg-blue-600" : "bg-stone-600")}>{it.status}</span>
                {it.created_by && (() => { const t = uploaderTag(it.created_by); return (
                  <span className={cn("absolute bottom-1.5 right-1.5 max-w-[70%] truncate rounded-md px-1.5 py-0.5 text-xs font-bold text-white shadow", t.cls)} title={`Uploaded by ${it.created_by}`}>{t.label}</span>
                ); })()}
              </div>
              <div className="space-y-0.5 p-2">
                <p className="truncate text-sm font-semibold">{it.customer_name || <span className="text-amber-700">Not tagged yet</span>}</p>
                <p className="truncate text-xs text-muted-foreground">{when(it.shot_on || it.created_at)}{it.width ? ` · ${it.width}×${it.height}` : ""} · {mb(it.size)}</p>
                {it.note && <p className="truncate text-xs text-muted-foreground">{it.note}</p>}
              </div>
            </button>
          ))}
        </div>
      )}

      {open && (
        <Detail item={open} showPrice={showPrice} onClose={() => setOpen(null)} onPatch={(p) => patch(open.id, p)}
          onRemove={async () => {
            if (!confirm("Take this out of the library? The file itself stays in storage.")) return;
            try { await api.removeContent(open.id); setOpen(null); void load(); } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't remove"); }
          }} />
      )}
    </div>
  );
}

function Detail({ item, showPrice, onClose, onPatch, onRemove }: {
  item: ContentItem; showPrice: boolean; onClose: () => void;
  onPatch: (p: ContentPatch) => Promise<void>; onRemove: () => void;
}) {
  // The phone's back swipe (and the Back button) closes this, not the page
  // (Alan, 2026-10-17: "to back out I have to swipe left, it looks unprofessional").
  const closing = useRef(false);
  useEffect(() => {
    window.history.pushState({ sheet: item.id }, "");
    const onPop = () => { closing.current = true; onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("popstate", onPop);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("keydown", onKey);
      if (!closing.current && window.history.state?.sheet === item.id) window.history.back();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per opened item
  }, [item.id]);
  const close = () => {
    if (window.history.state?.sheet === item.id) { closing.current = true; window.history.back(); }
    onClose();
  };

  const [note, setNote] = useState(item.note);
  const [noteSaved, setNoteSaved] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ customer_name: item.customer_name, address: item.address, package: item.package, color: item.color, sold_for: item.sold_for == null ? "" : String(item.sold_for) });
  const [picking, setPicking] = useState(!item.lead_id);
  const [lq, setLq] = useState("");
  const [found, setFound] = useState<{ id: string; name: string; address: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!picking) return;
    let live = true;
     
    setSearching(true);
    const t = setTimeout(() => {
      api.searchContentCustomers(lq.trim())
        .then((r) => { if (live) setFound(r.results); })
        .catch(() => { if (live) setFound([]); })
        .finally(() => { if (live) setSearching(false); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [lq, picking]);
  const download = `${item.url}?download=${encodeURIComponent(item.filename || "file")}`;

  const saveNote = async () => { setBusy(true); await onPatch({ note }); setBusy(false); setNoteSaved(true); setTimeout(() => setNoteSaved(false), 2500); };
  const saveCard = async () => {
    setBusy(true);
    const p: ContentPatch = { customer_name: draft.customer_name, address: draft.address, package: draft.package, color: draft.color };
    if (showPrice) {
      const n = parseFloat(draft.sold_for.replace(/[^0-9.]/g, ""));
      if (draft.sold_for.trim() === "") p.clear_sold_for = true; else if (!isNaN(n)) p.sold_for = n;
    }
    await onPatch(p);
    setBusy(false); setEditing(false);
  };
  const startEdit = () => { setDraft({ customer_name: item.customer_name, address: item.address, package: item.package, color: item.color, sold_for: item.sold_for == null ? "" : String(item.sold_for) }); setEditing(true); };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={close}>
      <div className="flex max-h-[96vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl bg-background shadow-2xl sm:max-h-[92vh] sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b px-2 py-2">
          <button onClick={close} className="inline-flex min-h-[44px] items-center gap-1 rounded-lg px-3 text-base font-semibold hover:bg-muted"><ArrowLeft className="h-5 w-5" /> Back</button>
          <p className="min-w-0 flex-1 truncate text-center text-sm font-semibold">{item.filename}</p>
          <button onClick={close} className="rounded-lg p-2.5 hover:bg-muted" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        <div className="overflow-y-auto">
          <div className="bg-black">
            {item.kind === "video"
              ? <video src={item.url} controls playsInline className="mx-auto max-h-[45vh] w-full" />
              : <img src={item.url} alt="" className="mx-auto max-h-[45vh] w-full object-contain" />}
          </div>
          <div className="space-y-4 p-4">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{when(item.shot_on || item.created_at)}</span>
              {item.width ? <span>· {item.width}×{item.height}</span> : null}
              {item.duration_seconds != null ? <span>· {dur(item.duration_seconds)}</span> : null}
              <span>· {mb(item.size)} · original file, untouched</span>
              {item.created_by && <span>· uploaded by <b className="text-foreground">{item.created_by}</b></span>}
              <a href={download} className="ml-auto inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border px-3 text-sm font-semibold text-foreground"><Download className="h-4 w-4" /> Download original</a>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-xs font-bold uppercase tracking-wide text-muted-foreground">Status</p>
                <div className="flex gap-1.5">
                  {(["raw", "edited", "posted"] as const).map((s) => (
                    <button key={s} onClick={() => void onPatch({ status: s })}
                      className={cn("min-h-[44px] flex-1 rounded-lg text-sm font-semibold capitalize", item.status === s ? "bg-primary text-primary-foreground" : "bg-muted")}>{s}</button>
                  ))}
                </div>
              </div>
              <div>
                <p className="mb-1 text-xs font-bold uppercase tracking-wide text-muted-foreground">Shot on <span className="font-normal normal-case">(the job's calendar day once tagged)</span></p>
                <Input type="date" value={item.shot_on || today()} onChange={(e) => void onPatch({ shot_on: e.target.value })} className="h-11" />
              </div>
            </div>

            <div>
              <p className="mb-1 text-xs font-bold uppercase tracking-wide text-muted-foreground">Note</p>
              <div className="flex gap-2">
                <Input value={note} onChange={(e) => { setNote(e.target.value); setNoteSaved(false); }}
                  placeholder="Black fence, came out beautiful. Good for a before/after." className="h-11 flex-1" />
                <Button onClick={() => void saveNote()} disabled={busy || note === item.note} className="h-11 min-w-[88px] font-bold">
                  {noteSaved ? <><Check className="mr-1 h-4 w-4" /> Saved</> : "Save"}
                </Button>
              </div>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Customer and job</p>
                {item.lead_id && !picking && !editing && (
                  <div className="flex gap-3 text-sm font-semibold text-primary">
                    <button onClick={startEdit}>Edit details</button>
                    <button onClick={() => setPicking(true)}>Change customer</button>
                  </div>
                )}
              </div>

              {picking ? (
                <div className="rounded-xl border bg-card p-3">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input autoFocus value={lq} onChange={(e) => setLq(e.target.value)} placeholder="Customer name or address" className="h-11 pl-8" />
                  </div>
                  <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
                    {searching && found.length === 0 ? <Loader2 className="h-4 w-4 animate-spin" /> : found.map((l) => (
                      <button key={l.id} onClick={() => { void onPatch({ lead_id: l.id }); setPicking(false); }}
                        className="flex min-h-[44px] w-full flex-col justify-center rounded-lg px-2 py-1.5 text-left hover:bg-muted">
                        <span className="text-sm font-semibold">{l.name || "Customer"}</span>
                        <span className="truncate text-xs text-muted-foreground">{l.address}</span>
                      </button>
                    ))}
                    {!searching && found.length === 0 && <p className="px-2 py-1 text-sm text-muted-foreground">No customer matches that.</p>}
                  </div>
                  {item.lead_id && <button onClick={() => setPicking(false)} className="mt-2 min-h-[40px] text-sm text-muted-foreground">Keep {item.customer_name || "this customer"}</button>}
                </div>
              ) : editing ? (
                <div className="space-y-2 rounded-xl border bg-card p-3">
                  <label className="block text-xs text-muted-foreground">Customer name
                    <Input value={draft.customer_name} onChange={(e) => setDraft({ ...draft, customer_name: e.target.value })} className="mt-0.5 h-11" /></label>
                  <label className="block text-xs text-muted-foreground">Address
                    <Input value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} className="mt-0.5 h-11" /></label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block text-xs text-muted-foreground">Package
                      <select value={["Essential", "Signature", "Legacy", "Custom", ""].includes(draft.package) ? draft.package : "other"}
                        onChange={(e) => setDraft({ ...draft, package: e.target.value === "other" ? draft.package : e.target.value })}
                        className="mt-0.5 h-11 w-full rounded-md border bg-background px-2 text-sm text-foreground">
                        <option value="">—</option><option>Essential</option><option>Signature</option><option>Legacy</option><option>Custom</option>
                        {!["Essential", "Signature", "Legacy", "Custom", ""].includes(draft.package) && <option value="other">{draft.package}</option>}
                      </select></label>
                    <label className="block text-xs text-muted-foreground">Color
                      <Input value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })} className="mt-0.5 h-11" /></label>
                  </div>
                  {showPrice && (
                    <label className="block text-xs text-muted-foreground">Sold for ($)
                      <Input inputMode="decimal" value={draft.sold_for} onChange={(e) => setDraft({ ...draft, sold_for: e.target.value })} className="mt-0.5 h-11" /></label>
                  )}
                  <div className="flex items-center gap-2 pt-1">
                    <Button onClick={() => void saveCard()} disabled={busy} className="h-11 font-bold">Save</Button>
                    <Button variant="outline" onClick={() => setEditing(false)} className="h-11">Cancel</Button>
                    {item.lead_id && <button onClick={() => { void onPatch({ reset_from_job: true }); setEditing(false); }} className="ml-auto text-sm text-muted-foreground">Use the job's details</button>}
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border bg-card p-3">
                  <p className="font-semibold">{item.customer_name || "Customer"}</p>
                  {item.address && <p className="text-sm text-muted-foreground">{item.address}</p>}
                  <div className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                    <div><div className="text-xs text-muted-foreground">Package</div>{item.package || "—"}</div>
                    <div><div className="text-xs text-muted-foreground">Color</div>{item.color || "—"}</div>
                    {showPrice && <div><div className="text-xs text-muted-foreground">Sold for</div>{item.sold_for != null ? formatCurrency(item.sold_for) : "—"}</div>}
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 pb-2">
              <Button variant="ghost" size="sm" onClick={onRemove} className="text-red-600 hover:bg-red-50 hover:text-red-700"><Trash2 className="mr-1.5 h-4 w-4" /> Remove</Button>
              <Button onClick={close} className="h-12 min-w-[120px] font-bold">Done</Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
