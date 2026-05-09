import { useEffect, useState, useCallback } from "react";
import { api, type SopTemplate } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Plus, ListChecks, Star, Pencil, Trash2, RefreshCw, Loader2, Download } from "lucide-react";
import SopTemplateEditor from "@/components/SopTemplateEditor";

const SERVICE_LABEL: Record<string, string> = {
  fence_staining: "Fence Staining",
  power_washing: "Power Washing",
};

/** SOPs tab on the Crew/Payroll page. Lists templates, gives admin a
 * Create button + per-row edit/delete + a one-click Backfill action
 * that attaches the default template to existing scheduled jobs that
 * pre-dated the template. */
export default function SopTemplatesList() {
  const [templates, setTemplates] = useState<SopTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState<{ id: string | null } | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  const [importing, setImporting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.listSopTemplates({ include_inactive: true })
      .then((r) => setTemplates(r.templates))
      .catch(() => toast.error("Failed to load SOP templates"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const remove = async (t: SopTemplate) => {
    if (!confirm(`Delete "${t.name}"? Existing job runs that already used it stay intact (they snapshot their own copy).`)) return;
    try {
      await api.deleteSopTemplate(t.id);
      toast.success("Template deleted");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  const importCrewClock = async () => {
    if (!confirm("Import the CrewClock Fence Staining template? Creates a new template marked as default with 23 steps, reference card, and the bleach-vs-power-wash branch picker.")) return;
    setImporting(true);
    try {
      const r = await api.importCrewClockTemplate();
      if (r.status === "exists") toast.info(r.message);
      else toast.success(`${r.message} (${r.step_count} steps)`);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed");
    } finally {
      setImporting(false);
    }
  };

  const backfill = async () => {
    if (!confirm("Attach the default templates to all existing scheduled jobs that don't have a checklist yet?")) return;
    setBackfilling(true);
    try {
      const r = await api.backfillSopRuns();
      toast.success(`Attached to ${r.attached} job(s) · ${r.skipped_no_template} skipped (no template configured)`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Backfill failed");
    } finally {
      setBackfilling(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <ListChecks className="h-4 w-4 text-primary" /> SOP Templates
            <span className="text-xs font-normal text-muted-foreground">
              · the master checklists workers tick off on each job
            </span>
          </CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            {templates.length === 0 && (
              <Button variant="outline" size="sm" onClick={importCrewClock} disabled={importing}>
                {importing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Download className="h-3.5 w-3.5 mr-1" />}
                Import CrewClock template
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={backfill} disabled={backfilling || templates.length === 0}>
              {backfilling ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
              Apply to existing jobs
            </Button>
            <Button size="sm" onClick={() => setEditorOpen({ id: null })}>
              <Plus className="h-3.5 w-3.5 mr-1" /> New template
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            {[1, 2].map((i) => <div key={i} className="h-14 bg-muted rounded animate-pulse" />)}
          </div>
        ) : templates.length === 0 ? (
          <div className="text-center py-12 space-y-3">
            <ListChecks className="h-10 w-10 text-muted-foreground/50 mx-auto" />
            <div>
              <p className="text-sm font-semibold">No SOP templates yet</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                Create your first checklist — workers will see it on every scheduled job they're assigned to.
              </p>
            </div>
            <div className="flex items-center justify-center gap-2 flex-wrap">
              <Button size="sm" variant="default" onClick={importCrewClock} disabled={importing}>
                {importing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Download className="h-3.5 w-3.5 mr-1" />}
                Import CrewClock template
              </Button>
              <span className="text-xs text-muted-foreground">or</span>
              <Button size="sm" variant="outline" onClick={() => setEditorOpen({ id: null })}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Create from scratch
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {templates.map((t) => (
              <div
                key={t.id}
                className={`border rounded-lg p-3 flex items-center gap-3 hover:bg-muted/30 transition cursor-pointer ${
                  !t.active ? "opacity-50" : ""
                }`}
                onClick={() => setEditorOpen({ id: t.id })}
              >
                <div className="h-9 w-9 rounded-lg bg-primary/10 grid place-items-center shrink-0">
                  <ListChecks className="h-4 w-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <p className="text-sm font-semibold truncate">{t.name}</p>
                    {t.is_default && (
                      <Badge className="bg-amber-100 text-amber-800 text-[10px] gap-0.5">
                        <Star className="h-2.5 w-2.5" /> Default
                      </Badge>
                    )}
                    {!t.active && <Badge className="bg-muted text-muted-foreground text-[10px]">Paused</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {SERVICE_LABEL[t.service_type] || t.service_type} · updated {t.updated_at?.slice(0, 10) || "—"}
                  </p>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); setEditorOpen({ id: t.id }); }}
                  className="p-1.5 text-muted-foreground hover:text-primary"
                  title="Edit"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); remove(t); }}
                  className="p-1.5 text-muted-foreground hover:text-red-600"
                  title="Delete"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {editorOpen && (
        <SopTemplateEditor
          initialTemplateId={editorOpen.id}
          onClose={() => setEditorOpen(null)}
          onSaved={() => { setEditorOpen(null); load(); }}
        />
      )}
    </Card>
  );
}
