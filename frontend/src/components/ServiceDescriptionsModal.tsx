import { useEffect, useState } from "react";
import { api, type ServiceCatalogItem } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { X, Loader2, Pencil } from "lucide-react";

interface Props {
  onClose: () => void;
  /** Fired after a successful save so the parent can refresh its catalog copy. */
  onSaved?: (services: ServiceCatalogItem[]) => void;
}

/** Alan's editor for the per-service customer-facing descriptions. These are
 *  the default blurbs that pre-fill each service line on the schedule/invite;
 *  he can reword them once here and every future job picks them up. Leaving a
 *  box blank reverts that service to the built-in default. */
export default function ServiceDescriptionsModal({ onClose, onSaved }: Props) {
  const [items, setItems] = useState<ServiceCatalogItem[]>([]);
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getServiceCatalog()
      .then((r) => {
        setItems(r.services);
        setDescriptions(Object.fromEntries(r.services.map((s) => [s.key, s.description])));
      })
      .catch(() => toast.error("Failed to load service descriptions"))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.updateServiceCatalog(descriptions);
      toast.success("Service descriptions saved");
      onSaved?.(r.services);
      onClose();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-background rounded-lg shadow-xl w-full max-w-2xl max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Pencil className="h-5 w-5 text-primary" />
            Edit Service Descriptions
          </h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            These are the default blurbs that fill in each service when you add it to a job. The
            customer sees them on their calendar invite. You can still tweak the wording per job —
            this just sets the starting point. Leave a box blank to use the built-in default.
          </p>
          {loading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
            </div>
          ) : (
            items.map((s) => (
              <div key={s.key}>
                <label className="text-sm font-semibold flex items-center gap-2">
                  {s.label}
                  {s.is_tier && (
                    <span className="text-[10px] font-medium uppercase tracking-wide text-primary bg-primary/10 rounded px-1.5 py-0.5">
                      Tier
                    </span>
                  )}
                </label>
                <textarea
                  value={descriptions[s.key] ?? ""}
                  onChange={(e) => setDescriptions((prev) => ({ ...prev, [s.key]: e.target.value }))}
                  rows={2}
                  className="w-full border border-input rounded-md px-3 py-2 text-sm bg-background mt-1 resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            ))
          )}
        </div>

        <div className="p-4 border-t flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving || loading}>
            {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Save descriptions
          </Button>
        </div>
      </div>
    </div>
  );
}
