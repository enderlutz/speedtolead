// Fence Photos → By customer (Alan, 2026-10-25): "click on the customer I
// want and it opens straight to all the photos we've taken, and it labels
// each one: before cleaning, after cleaning, before staining, after staining."
// Read only. The photos are the crew's job photos (Company Cam).
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Images, Loader2, Search, X } from "lucide-react";
import { api, type PhotoCustomer, type PhotoCustomerDetail } from "@/lib/api";
import { cn } from "@/lib/utils";

const TONE: Record<string, string> = {
  "Before cleaning": "bg-stone-800 text-white",
  "After cleaning": "bg-sky-700 text-white",
  "Before staining": "bg-amber-700 text-white",
  "After staining": "bg-emerald-700 text-white",
  "Fence scope": "bg-stone-500 text-white",
};
const tone = (label: string) => TONE[label] || "bg-stone-600 text-white";

/** A public storage photo renders as is; an old one only lives behind our
 *  login, so it's fetched with the token and shown as a blob. */
function JobImg({ url, alt, className }: { url: string; alt: string; className: string }) {
  const direct = /^https?:\/\//.test(url);
  const [blob, setBlob] = useState("");
  useEffect(() => {
    if (direct) return;
    const m = url.match(/company-cam\/([^/]+)\/photos\/([^/]+)\/image/);
    if (!m) return;
    let dead = false;
    let made = "";
    void api.fetchCompanyCamPhotoUrl(m[1], m[2]).then((u) => { if (!dead && u) { made = u; setBlob(u); } });
    return () => { dead = true; if (made) URL.revokeObjectURL(made); };
  }, [url, direct]);
  const src = direct ? url : blob;
  return src ? <img src={src} alt={alt} loading="lazy" className={className} draggable={false} />
    : <div className={cn(className, "animate-pulse bg-muted")} />;
}

const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
};

export function CustomerPhotos() {
  const [list, setList] = useState<PhotoCustomer[] | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { api.fencePhotoCustomers().then((r) => setList(r.customers)).catch((e) => setErr(e instanceof Error ? e.message : "Couldn't load")); }, []);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (list || []).filter((c) => !t || c.name.toLowerCase().includes(t) || c.address.toLowerCase().includes(t));
  }, [list, q]);

  if (open) return <CustomerGallery leadId={open} onBack={() => setOpen(null)} />;
  return (
    <div className="space-y-3">
      <label className="flex min-h-11 items-center gap-2 rounded-xl border border-input bg-background px-3">
        <Search className="h-4 w-4 text-muted-foreground" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Customer name or address" className="w-full bg-transparent text-base outline-none" />
      </label>
      {err ? <p className="rounded-xl bg-red-50 p-3 text-[15px] text-red-800">{err}</p> : null}
      {!list && !err ? <p className="flex items-center gap-2 text-[15px] text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading customers…</p> : null}
      {list ? <p className="text-[14px] text-muted-foreground">{shown.length} customer{shown.length === 1 ? "" : "s"} with photos · newest first</p> : null}
      <ul className="grid gap-2.5 sm:grid-cols-2">
        {shown.map((c) => (
          <li key={c.lead_id} className="min-w-0">
            <button type="button" onClick={() => setOpen(c.lead_id)} className="flex w-full gap-3 rounded-2xl border bg-card p-2.5 text-left shadow-sm transition hover:bg-muted/40 active:scale-[0.99]">
              {c.cover ? <JobImg url={c.cover} alt={c.name} className="h-20 w-20 shrink-0 rounded-xl object-cover" />
                : <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl bg-muted"><Images className="h-6 w-6 text-muted-foreground" /></div>}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[16px] font-bold">{c.name || "No name"}</p>
                <p className="truncate text-[14px] text-muted-foreground">{c.address}</p>
                <p className="mt-1 text-[14px] font-semibold">{c.count} photo{c.count === 1 ? "" : "s"}{c.last ? ` · ${day(c.last)}` : ""}</p>
              </div>
              <ChevronRight className="mt-7 h-5 w-5 shrink-0 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CustomerGallery({ leadId, onBack }: { leadId: string; onBack: () => void }) {
  const [d, setD] = useState<PhotoCustomerDetail | null>(null);
  const [err, setErr] = useState("");
  const [big, setBig] = useState<number | null>(null);
  useEffect(() => { api.fencePhotoCustomer(leadId).then(setD).catch((e) => setErr(e instanceof Error ? e.message : "Couldn't load")); }, [leadId]);
  useEffect(() => {
    if (big === null || !d) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBig(null);
      if (e.key === "ArrowRight") setBig((i) => (i === null ? i : Math.min(d.photos.length - 1, i + 1)));
      if (e.key === "ArrowLeft") setBig((i) => (i === null ? i : Math.max(0, i - 1)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [big, d]);
  // Grouped by label, in job order (the server sorts them).
  const groups = useMemo(() => {
    const out: { label: string; items: { p: PhotoCustomerDetail["photos"][number]; i: number }[] }[] = [];
    (d?.photos || []).forEach((p, i) => {
      const g = out.find((x) => x.label === p.label);
      if (g) g.items.push({ p, i }); else out.push({ label: p.label, items: [{ p, i }] });
    });
    return out;
  }, [d]);
  const cur = big !== null && d ? d.photos[big] : null;
  return (
    <div className="space-y-3">
      <button type="button" onClick={onBack} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border bg-background px-3.5 text-[15px] font-bold">
        <ChevronLeft className="h-5 w-5" /> All customers
      </button>
      {err ? <p className="rounded-xl bg-red-50 p-3 text-[15px] text-red-800">{err}</p> : null}
      {!d && !err ? <p className="flex items-center gap-2 text-[15px] text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading photos…</p> : null}
      {d ? (
        <>
          <div>
            <h2 className="text-xl font-bold">{d.name}</h2>
            <p className="text-[15px] text-muted-foreground">{d.address} · {d.photos.length} photos</p>
          </div>
          {groups.map((g) => (
            <section key={g.label}>
              <p className="mb-1.5 flex items-center gap-2"><span className={cn("rounded-full px-3 py-1 text-[14px] font-bold", tone(g.label))}>{g.label}</span>
                <span className="text-[14px] text-muted-foreground">{g.items.length}</span></p>
              <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
                {g.items.map(({ p, i }) => (
                  <button key={p.id} type="button" onClick={() => setBig(i)} className="relative overflow-hidden rounded-lg">
                    <JobImg url={p.url} alt={`${g.label}${p.side ? ` · ${p.side}` : ""}`} className="aspect-square w-full object-cover" />
                    {p.side ? <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1.5 py-0.5 text-[12px] font-semibold text-white">{p.side}</span> : null}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </>
      ) : null}
      {cur && big !== null && d ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-black" onClick={() => setBig(null)}>
          <div className="flex items-center justify-between gap-2 p-3" onClick={(e) => e.stopPropagation()}>
            <span className={cn("rounded-full px-3 py-1.5 text-[15px] font-bold", tone(cur.label))}>{cur.label}{cur.side ? ` · ${cur.side}` : ""}</span>
            <button type="button" onClick={() => setBig(null)} aria-label="Close" className="flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white"><X className="h-6 w-6" /></button>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center px-2" onClick={(e) => e.stopPropagation()}>
            <JobImg url={cur.url} alt={cur.label} className="max-h-full max-w-full object-contain" />
          </div>
          <div className="flex items-center justify-between gap-2 p-3 text-white" onClick={(e) => e.stopPropagation()}>
            <button type="button" disabled={big === 0} onClick={() => setBig(big - 1)} className="flex h-12 w-12 items-center justify-center rounded-full bg-white/15 disabled:opacity-30" aria-label="Previous"><ChevronLeft className="h-6 w-6" /></button>
            <p className="min-w-0 text-center text-[14px]">{cur.note ? <span className="block truncate">{cur.note}</span> : null}<span className="text-white/70">{big + 1} of {d.photos.length}{cur.taken_at ? ` · ${day(cur.taken_at)}` : ""}</span></p>
            <button type="button" disabled={big === d.photos.length - 1} onClick={() => setBig(big + 1)} className="flex h-12 w-12 items-center justify-center rounded-full bg-white/15 disabled:opacity-30" aria-label="Next"><ChevronRight className="h-6 w-6" /></button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
