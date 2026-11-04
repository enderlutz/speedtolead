// The office's own call scripts (Alan, 2026-11-04): one tab per script, each
// with its own title, read on screen and edited right here by anyone in the
// office. Paste it, type it, or upload a Word / PDF / text file. Saved in the
// shared script library, so everyone sees the same words.
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { FileUp, Loader2, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import { api, getCurrentUser, type CallScript } from "@/lib/api";
import { CallScriptRenderer } from "@/components/CallScriptRenderer";
import { cn } from "@/lib/utils";

const ACCEPT = ".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown";

/** The tab strip for the scripts. "old" is the built-in script, set aside. */
export function useScripts() {
  const [scripts, setScripts] = useState<CallScript[] | null>(null);
  const load = () => api.listCallScripts().then((r) => setScripts(r.scripts)).catch(() => setScripts([]));
  useEffect(() => { void load(); }, []);
  return { scripts, reload: load, setScripts };
}

export function ScriptTabs({ scripts, active, onPick, onAdd, oldLabel }: {
  scripts: CallScript[]; active: string; onPick: (id: string) => void; onAdd: () => void; oldLabel: string;
}) {
  const tab = (id: string, label: string) => (
    <button key={id} type="button" onClick={() => onPick(id)}
      className={cn("min-h-11 shrink-0 rounded-xl border px-4 text-sm font-semibold transition-colors",
        active === id ? "border-ink bg-ink text-gold-light" : "border-input bg-background hover:bg-muted")}>
      {label}
    </button>
  );
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {scripts.map((s) => tab(s.id, s.name || "Untitled script"))}
      <button type="button" onClick={onAdd}
        className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border border-dashed border-input px-4 text-sm font-semibold text-muted-foreground hover:bg-muted">
        <Plus className="h-4 w-4" /> New script
      </button>
      {tab("old", oldLabel)}
    </div>
  );
}

export function ScriptDoc({ script, onSaved, onDeleted }: {
  script: CallScript; onSaved: (s: CallScript) => void; onDeleted: (id: string) => void;
}) {
  const [editing, setEditing] = useState(!script.content.trim());
  const [name, setName] = useState(script.name);
  const [content, setContent] = useState(script.content);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const isAdmin = getCurrentUser()?.role === "admin";

  useEffect(() => { setName(script.name); setContent(script.content); setEditing(!script.content.trim()); }, [script.id]);

  const dirty = name !== script.name || content !== script.content;
  const save = async () => {
    if (!name.trim()) { toast.error("Give the script a title"); return; }
    setSaving(true);
    try {
      const s = await api.updateCallScriptById(script.id, { name: name.trim(), content });
      onSaved(s); setEditing(false); toast.success("Script saved. Everyone sees it now.");
    } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't save"); }
    finally { setSaving(false); }
  };
  const upload = async (f: File | undefined) => {
    if (!f) return;
    setImporting(true);
    try {
      const { text } = await api.extractCallScriptFile(f);
      setContent((c) => (c.trim() && !window.confirm("Replace what's in the script now with this file? (Cancel adds it at the end.)") ? `${c}\n\n${text}` : text));
      setEditing(true);
      toast.success("File read. Check it over, then Save.");
    } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't read that file"); }
    finally { setImporting(false); if (fileRef.current) fileRef.current.value = ""; }
  };
  const remove = async () => {
    if (!window.confirm(`Delete "${script.name}"? This can't be undone.`)) return;
    try { await api.deleteCallScript(script.id); onDeleted(script.id); toast.success("Script deleted"); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't delete"); }
  };

  return (
    <div className="rounded-2xl border bg-card p-4 sm:p-5">
      <input ref={fileRef} type="file" accept={ACCEPT} className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
      <div className="flex flex-wrap items-start justify-between gap-2">
        {editing ? (
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Title, e.g. New leads"
            className="h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-lg font-semibold" />
        ) : (
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">{script.name}</h2>
            {script.updated_at ? <p className="text-xs text-muted-foreground">Last edited {new Date(script.updated_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}{script.updated_by ? ` by ${script.updated_by}` : ""}</p> : null}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => fileRef.current?.click()} disabled={importing}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-input bg-background px-3 text-sm font-semibold hover:bg-muted disabled:opacity-60">
            {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />} Upload a file
          </button>
          {editing ? (
            <>
              <button type="button" onClick={() => void save()} disabled={saving || !dirty}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-ink px-4 text-sm font-semibold text-gold-light disabled:opacity-50">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save
              </button>
              {script.content.trim() ? (
                <button type="button" onClick={() => { setName(script.name); setContent(script.content); setEditing(false); }}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-input px-3 text-sm font-semibold hover:bg-muted">
                  <X className="h-4 w-4" /> Cancel
                </button>
              ) : null}
            </>
          ) : (
            <button type="button" onClick={() => setEditing(true)}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-ink px-4 text-sm font-semibold text-gold-light">
              <Pencil className="h-4 w-4" /> Edit
            </button>
          )}
          {isAdmin ? (
            <button type="button" onClick={() => void remove()} title="Delete this script"
              className="inline-flex min-h-11 items-center rounded-xl border border-input px-3 text-muted-foreground hover:bg-rose-50 hover:text-rose-700">
              <Trash2 className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>

      {editing ? (
        <div className="mt-3 space-y-2">
          <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={22}
            placeholder={"Paste or type the script here, or tap Upload a file.\n\n## Step 1 — Greeting\nHi, is this ...?\n\n> If they say ...\n\n**Bold** for what to stress."}
            className="w-full rounded-xl border border-input bg-background p-3 font-mono text-[15px] leading-relaxed" />
          <p className="text-xs text-muted-foreground">
            Tips: start a line with <b>##</b> for a big heading, <b>&gt;</b> for what the customer might say, <b>-</b> for a list, and wrap words in <b>**</b> to bold them.
          </p>
          {content.trim() ? (
            <details className="rounded-xl border bg-muted/30 p-3">
              <summary className="cursor-pointer text-sm font-semibold">How it will look</summary>
              <div className="mt-2 text-[15px]"><CallScriptRenderer source={content} /></div>
            </details>
          ) : null}
        </div>
      ) : (
        <div className="mt-4 text-[15px]"><CallScriptRenderer source={script.content} /></div>
      )}
    </div>
  );
}
