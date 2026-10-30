import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { FileText, Image as ImageIcon, Lightbulb, Loader2, Pencil, Search, Trash2, Upload } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { IdeasPlaybook } from "@/components/IdeasPlaybook";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, getCurrentUser, type DocCategory, type DocumentRow } from "@/lib/api";

// The business's PDFs in one place (Alan, 2026-10-16: "somewhere we can store
// all these PDFs very simply, so I can easily go back to them"), sorted into
// sections that follow how the company is being built: the plan, the VA, the
// numbers, sales, marketing. Tap to open, upload many at once. Owner-only.

const when = (iso: string) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");
const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export default function Documents() {
  const isAlan = (getCurrentUser()?.sub || "").toLowerCase() === "alanbonner" && !getCurrentUser()?.impersonated_by;
  const [params, setParams] = useSearchParams();
  // Alan opens to Ideas (2026-10-30: "I don't even look at documents, so it
  // always needs to open up to ideas"); Files is the second tab.
  const tab = isAlan && params.get("tab") !== "files" ? "ideas" : "files";
  const setTab = (t: "files" | "ideas") => setParams(t === "files" ? { tab: "files" } : {}, { replace: true });
  const [docs, setDocs] = useState<DocumentRow[] | null>(null);
  const [cats, setCats] = useState<DocCategory[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.listDocuments();
      setDocs(r.documents);
      setCats(r.categories);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load documents");
      setDocs([]);
    }
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: fetches on mount; the data lands asynchronously.
  useEffect(() => { load(); }, [load]);

  const upload = async (list: FileList | null) => {
    const files = Array.from(list || []);
    if (!files.length) return;
    setBusy(true);
    try {
      const r = await api.uploadDocuments(files);
      toast.success(r.documents.length === 1 ? "Saved" : `${r.documents.length} saved`);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const open = async (d: DocumentRow) => {
    // Open the tab now, while the tap still counts, so the phone doesn't block it.
    const tab = window.open("", "_blank");
    setOpening(d.id);
    try {
      const url = await api.documentBlobUrl(d.id);
      if (tab) tab.location.href = url;
      else window.location.href = url;
    } catch (e) {
      tab?.close();
      toast.error(e instanceof Error ? e.message : "Couldn't open it");
    } finally {
      setOpening(null);
    }
  };

  const rename = async (d: DocumentRow) => {
    const title = window.prompt("New name", d.title);
    if (!title || title.trim() === d.title) return;
    try {
      await api.updateDocument(d.id, { title: title.trim() });
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't rename it");
    }
  };

  const move = async (d: DocumentRow, category: string) => {
    try {
      await api.updateDocument(d.id, { category });
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't move it");
    }
  };

  const remove = async (d: DocumentRow) => {
    if (!window.confirm(`Remove "${d.title}"?`)) return;
    try {
      await api.removeDocument(d.id);
      toast.success("Removed");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't remove it");
    }
  };

  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (docs || []).filter((d) => words.every((w) => `${d.title} ${d.filename} ${d.blurb}`.toLowerCase().includes(w)));
  }, [docs, q]);
  const sections = useMemo(() => cats
    .map((c) => ({ ...c, items: shown.filter((d) => (d.category || "other") === c.key) }))
    .filter((c) => c.items.length > 0), [cats, shown]);

  // Files | Ideas (Alan's playbook, 2026-10-30). Ideas is his alone.
  const tabBar = isAlan ? (
    <div className="inline-flex rounded-xl bg-muted p-1">
      {([["ideas", "Ideas/Tasks", Lightbulb], ["files", "Files", FileText]] as const).map(([k, l, Icon]) => (
        <button key={k} type="button" onClick={() => setTab(k)}
          className={cn("inline-flex h-10 items-center gap-1.5 rounded-lg px-4 text-sm font-bold", tab === k ? "bg-background shadow-sm" : "text-muted-foreground")}>
          <Icon className="h-4 w-4" /> {l}
        </button>
      ))}
    </div>
  ) : null;
  if (isAlan && tab === "ideas") {
    return (
      <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-4">
        <h1 className="text-2xl font-bold flex items-center gap-2"><Lightbulb className="h-6 w-6" /> Ideas/Tasks</h1>
        {tabBar}
        <IdeasPlaybook />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-4">
      {tabBar}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FileText className="h-6 w-6" /> Documents</h1>
          <p className="text-sm text-muted-foreground mt-1">Everything we’ve written to build Sterling, in the order we’re building it. Tap one to open it.</p>
        </div>
        <Button onClick={() => input.current?.click()} disabled={busy} className="h-11">
          {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Upload className="h-4 w-4 mr-1.5" />}
          {busy ? "Saving…" : "Add PDFs"}
        </Button>
        <input ref={input} type="file" multiple hidden
          accept="application/pdf,image/png,image/jpeg,text/plain,text/csv,.docx,.xlsx"
          onChange={(e) => { void upload(e.target.files); e.target.value = ""; }} />
      </div>

      {(docs?.length || 0) > 5 && (
        <div className="relative">
          <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} className="pl-9 h-11 text-base" placeholder="Search, e.g. VA, numbers, plan" />
        </div>
      )}

      {docs === null ? (
        <div className="py-10 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : docs.length === 0 ? (
        <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">
          Nothing here yet. Tap <b>Add PDFs</b> and pick them all at once, e.g. from your Desktop or the Files app.
        </CardContent></Card>
      ) : (
        <div className="space-y-6">
          {sections.map((c) => (
          <section key={c.key} className="space-y-2">
            <div className={c.key === "older" ? "opacity-70" : ""}>
              <h2 className="text-base font-bold">{c.label}</h2>
              <p className="text-xs text-muted-foreground">{c.about}</p>
            </div>
          {c.items.map((d) => (
            <Card key={d.id} className="hover:border-primary/40 transition-colors">
              <CardContent className="p-0 flex items-center">
                <button type="button" onClick={() => void open(d)} className="flex-1 min-w-0 flex items-center gap-3 p-3.5 text-left min-h-14">
                  {opening === d.id
                    ? <Loader2 className="h-6 w-6 animate-spin text-muted-foreground shrink-0" />
                    : d.mime.startsWith("image/")
                      ? <ImageIcon className="h-6 w-6 text-sky-600 shrink-0" />
                      : <FileText className="h-6 w-6 text-red-600 shrink-0" />}
                  <span className="min-w-0">
                    <span className="block font-semibold leading-tight">{d.title}</span>
                    {d.blurb ? <span className="block text-sm text-muted-foreground mt-0.5 leading-snug">{d.blurb}</span> : null}
                    <span className="block text-xs text-muted-foreground/80 mt-1">{when(d.created_at)} · {kb(d.size)}</span>
                  </span>
                </button>
                <select aria-label="Move to section" value={d.category || "other"} onChange={(e) => void move(d, e.target.value)}
                  className="hidden sm:block h-9 max-w-[9rem] rounded-md border bg-background px-1.5 text-xs text-muted-foreground">
                  {cats.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                </select>
                <button type="button" aria-label="Rename" onClick={() => void rename(d)} className="p-3 text-muted-foreground hover:text-foreground"><Pencil className="h-4 w-4" /></button>
                <button type="button" aria-label="Remove" onClick={() => void remove(d)} className="p-3 pr-4 text-muted-foreground hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
              </CardContent>
            </Card>
          ))}
          </section>
          ))}
          {shown.length === 0 && <p className="text-sm text-muted-foreground">Nothing matches.</p>}
        </div>
      )}
    </div>
  );
}
