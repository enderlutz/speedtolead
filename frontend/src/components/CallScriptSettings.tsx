import { useEffect, useState, useMemo } from "react";
import { api } from "@/lib/api";
import {
  renderTemplate, sampleContext,
  SCRIPT_VARIABLES, SCRIPT_CONDITIONALS,
} from "@/lib/callScript";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { PhoneCall, Save, Loader2, ChevronDown, ChevronRight, Eye, Code2 } from "lucide-react";
import { CallScriptRenderer } from "@/components/CallScriptRenderer";

/**
 * Settings → Call Script. Single textarea + live preview rendered against
 * a sample lead so the admin can see what Olga will see. Variable + conditional
 * cheatsheet collapsible underneath.
 */
export default function CallScriptSettings() {
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");
  const [updatedBy, setUpdatedBy] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const [view, setView] = useState<"preview" | "split">("split");

  useEffect(() => {
    api.getCallScript()
      .then((s) => {
        setContent(s.content);
        setSavedContent(s.content);
        setUpdatedAt(s.updated_at);
        setUpdatedBy(s.updated_by);
      })
      .catch(() => toast.error("Failed to load call script"))
      .finally(() => setLoading(false));
  }, []);

  const ctx = useMemo(() => sampleContext(), []);
  const rendered = useMemo(() => renderTemplate(content, ctx), [content, ctx]);

  const dirty = content !== savedContent;

  const save = async () => {
    setSaving(true);
    try {
      const updated = await api.updateCallScript(content);
      setSavedContent(updated.content);
      setUpdatedAt(updated.updated_at);
      setUpdatedBy(updated.updated_by);
      toast.success("Script saved — Olga will see updates immediately");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm sm:text-base flex items-center gap-2">
            <PhoneCall className="h-4 w-4 text-primary" /> Call Script
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
          The VA's sticky panel on the Lead Detail page renders this template against the lead's data.
          Use <code className="px-1 bg-muted rounded">{"{{var}}"}</code> for substitutions
          and <code className="px-1 bg-muted rounded">{"{{#if X}}…{{/if}}"}</code> for conditional blocks.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="h-64 bg-muted rounded animate-pulse" />
        ) : (
          <>
            <div className={`grid gap-3 ${view === "split" ? "lg:grid-cols-2" : "grid-cols-1"}`}>
              {view === "split" && (
                <div>
                  <label className="text-[11px] uppercase tracking-wider text-muted-foreground font-bold mb-1 block">Source</label>
                  <textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    rows={view === "split" ? 24 : 18}
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
                {updatedAt && <>Last saved {updatedAt.slice(0, 10)} by {updatedBy || "system"}</>}
              </p>
              <Button size="sm" onClick={save} disabled={saving || !dirty}>
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
