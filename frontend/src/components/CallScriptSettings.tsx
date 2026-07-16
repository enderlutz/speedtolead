import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { api, type CallScript } from "@/lib/api";
import {
  renderTemplate, sampleContext,
  SCRIPT_VARIABLES, SCRIPT_CONDITIONALS,
} from "@/lib/callScript";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  PhoneCall, Save, Loader2, ChevronDown, ChevronRight, Eye, Code2,
  UploadCloud, Plus, Pencil, Trash2,
} from "lucide-react";
import { CallScriptRenderer } from "@/components/CallScriptRenderer";

const ACCEPT = ".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown";

/**
 * Settings → Call Script. Manages the shared library of named scripts: pick
 * one from the dropdown, edit its template with a live preview (rendered
 * against a sample lead), add / rename / delete scripts, and import text from
 * a PDF / Word .docx / plain-text file into the selected script.
 */
export default function CallScriptSettings() {
  const [scripts, setScripts] = useState<CallScript[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false); // create/rename/delete in flight
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const [view, setView] = useState<"preview" | "split">("split");
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(
    () => scripts.find((s) => s.id === selectedId) || null,
    [scripts, selectedId],
  );
  const dirty = content !== savedContent;

  // Load the given script's content into the editor.
  const loadInto = useCallback((s: CallScript | null) => {
    setSelectedId(s?.id || "");
    setContent(s?.content || "");
    setSavedContent(s?.content || "");
  }, []);

  useEffect(() => {
    api.listCallScripts()
      .then((r) => {
        const list = r.scripts || [];
        setScripts(list);
        loadInto(list[0] || null);
      })
      .catch(() => toast.error("Failed to load call scripts"))
      .finally(() => setLoading(false));
  }, [loadInto]);

  const ctx = useMemo(() => sampleContext(), []);
  const rendered = useMemo(() => renderTemplate(content, ctx), [content, ctx]);

  const switchTo = (id: string) => {
    if (id === selectedId) return;
    if (dirty && !confirm("You have unsaved changes. Discard them and switch scripts?")) return;
    loadInto(scripts.find((s) => s.id === id) || null);
  };

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const updated = await api.updateCallScriptById(selected.id, { content });
      setSavedContent(updated.content);
      setScripts((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      toast.success("Script saved — the VA panel picks it up immediately");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const addScript = async () => {
    const name = window.prompt("Name the new call script:", "");
    if (name === null) return;
    if (!name.trim()) { toast.error("Give the script a name."); return; }
    setBusy(true);
    try {
      const created = await api.createCallScript(name.trim());
      setScripts((prev) => [...prev, created]);
      loadInto(created);
      toast.success(`Created "${created.name}" — add its content and Save`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't create the script");
    } finally {
      setBusy(false);
    }
  };

  const renameScript = async () => {
    if (!selected) return;
    const name = window.prompt("Rename this call script:", selected.name);
    if (name === null) return;
    if (!name.trim()) { toast.error("Name can't be empty."); return; }
    setBusy(true);
    try {
      const updated = await api.updateCallScriptById(selected.id, { name: name.trim() });
      setScripts((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      toast.success("Renamed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rename failed");
    } finally {
      setBusy(false);
    }
  };

  const deleteScript = async () => {
    if (!selected) return;
    if (scripts.length <= 1) { toast.error("Add another script before deleting this one."); return; }
    if (!confirm(`Delete "${selected.name}"? This can't be undone.`)) return;
    setBusy(true);
    try {
      await api.deleteCallScript(selected.id);
      const remaining = scripts.filter((s) => s.id !== selected.id);
      setScripts(remaining);
      loadInto(remaining[0] || null);
      toast.success("Script deleted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  };

  // Import a PDF / .docx / text file → pull its text into the editor for the
  // selected script. Doesn't auto-save; admin reviews, tweaks, then Saves.
  const importFile = async (f: File | null) => {
    if (!f) return;
    if (!selected) { toast.error("Pick or create a script first."); return; }
    setImporting(true);
    try {
      const r = await api.extractCallScriptFile(f);
      if (!r.text.trim()) { toast.error("No text found in that file."); return; }
      setView("split");
      setContent(r.text);
      toast.success("Imported — review and Save");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't read that file");
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm sm:text-base flex items-center gap-2">
            <PhoneCall className="h-4 w-4 text-primary" /> Call Scripts
          </CardTitle>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setView("split")}
              className={`text-[11px] px-2 py-1 rounded font-medium ${
                view === "split" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
              }`}
            >
              <Code2 className="h-3 w-3 inline mr-1" /> Edit
            </button>
            <button
              onClick={() => setView("preview")}
              className={`text-[11px] px-2 py-1 rounded font-medium ${
                view === "preview" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
              }`}
            >
              <Eye className="h-3 w-3 inline mr-1" /> Preview only
            </button>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Build a library of named scripts — the VA picks one from a dropdown on the Lead Detail page,
          and it renders against the lead's data. Use <code className="px-1 bg-muted rounded">{"{{var}}"}</code> for
          substitutions and <code className="px-1 bg-muted rounded">{"{{#if X}}…{{/if}}"}</code> for conditional blocks.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="h-64 bg-muted rounded animate-pulse" />
        ) : (
          <>
            {/* Script picker + management */}
            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={selectedId}
                onChange={(e) => switchTo(e.target.value)}
                className="text-xs h-8 rounded-md border border-input bg-background px-2 min-w-[180px] focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {scripts.map((s) => (
                  <option key={s.id} value={s.id}>{s.name || "Untitled script"}</option>
                ))}
              </select>
              <Button size="sm" variant="outline" onClick={addScript} disabled={busy}>
                <Plus className="h-3.5 w-3.5 mr-1" /> New
              </Button>
              <Button size="sm" variant="outline" onClick={renameScript} disabled={busy || !selected}>
                <Pencil className="h-3.5 w-3.5 mr-1" /> Rename
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={deleteScript}
                disabled={busy || !selected || scripts.length <= 1}
                className="text-destructive hover:text-destructive"
                title={scripts.length <= 1 ? "Add another script before deleting this one" : "Delete this script"}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
              </Button>
            </div>

            {/* Import from a PDF / Word / text file — pull its text into the
                editor (converted to plain words), then review + save. */}
            <label
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); importFile(e.dataTransfer.files?.[0] || null); }}
              className={`flex items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-3 text-center cursor-pointer transition-colors ${
                dragging ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-muted-foreground/40 hover:bg-muted/30"
              }`}
            >
              <input ref={fileRef} type="file" accept={ACCEPT} className="hidden"
                onChange={(e) => importFile(e.target.files?.[0] || null)} />
              {importing ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : <UploadCloud className="h-4 w-4 text-muted-foreground" />}
              <span className="text-xs">
                {importing ? "Reading file…" : <><span className="font-medium">Import into “{selected?.name || "this script"}”</span> — drag &amp; drop or click a PDF, Word (.docx), or text file. Replaces the editor text (review before saving).</>}
              </span>
            </label>

            <div className={`grid gap-3 ${view === "split" ? "lg:grid-cols-2" : "grid-cols-1"}`}>
              {view === "split" && (
                <div>
                  <label className="text-[11px] uppercase tracking-wider text-muted-foreground font-bold mb-1 block">Source</label>
                  <textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    rows={24}
                    className="w-full font-mono text-xs leading-relaxed border border-input rounded-md px-3 py-2 bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                    spellCheck={false}
                  />
                </div>
              )}
              <div>
                <label className="text-[11px] uppercase tracking-wider text-muted-foreground font-bold mb-1 block">
                  Preview <span className="font-normal normal-case text-muted-foreground/70">(rendered against a sample lead)</span>
                </label>
                <div className="border border-input rounded-md p-3 bg-muted/20 max-h-[600px] overflow-y-auto">
                  <CallScriptRenderer source={rendered} />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between flex-wrap gap-2 pt-2">
              <p className="text-[11px] text-muted-foreground">
                {selected?.updated_at && <>Last saved {selected.updated_at.slice(0, 10)} by {selected.updated_by || "system"}</>}
              </p>
              <Button size="sm" onClick={save} disabled={saving || !dirty || !selected}>
                {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                <Save className="h-3.5 w-3.5 mr-1" />
                {dirty ? "Save changes" : "Saved"}
              </Button>
            </div>

            {/* Variable + conditional cheatsheet */}
            <div className="border-t pt-2">
              <button
                onClick={() => setCheatsheetOpen(!cheatsheetOpen)}
                className="text-xs font-semibold text-muted-foreground hover:text-foreground flex items-center gap-1"
              >
                {cheatsheetOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                Available variables + conditionals
              </button>
              {cheatsheetOpen && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2 text-[11px]">
                  <div>
                    <p className="font-bold uppercase tracking-wider text-muted-foreground mb-1">Variables</p>
                    <ul className="space-y-0.5">
                      {SCRIPT_VARIABLES.map((v) => (
                        <li key={v.key} className="flex items-baseline gap-1.5">
                          <code className="font-mono bg-muted px-1 rounded">{`{{${v.key}}}`}</code>
                          <span className="text-muted-foreground">{v.description}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <p className="font-bold uppercase tracking-wider text-muted-foreground mb-1">Conditionals</p>
                    <ul className="space-y-0.5">
                      {SCRIPT_CONDITIONALS.map((c) => (
                        <li key={c.key} className="flex items-baseline gap-1.5">
                          <code className="font-mono bg-muted px-1 rounded">{`{{#if ${c.key}}}`}</code>
                          <span className="text-muted-foreground">{c.description}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="text-muted-foreground mt-1.5 italic">
                      Each <code className="font-mono bg-muted px-0.5 rounded">{"{{#if X}}"}</code> can be paired with <code className="font-mono bg-muted px-0.5 rounded">{"{{#unless X}}"}</code> for the inverse branch.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
