import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PenLine, Loader2 } from "lucide-react";
import { api, type FenceScopeState } from "@/lib/api";

export default function FenceScopeSummaryCard({ leadId }: { leadId: string }) {
  const navigate = useNavigate();
  const [state, setState] = useState<FenceScopeState | null>(null);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.getFenceScope(leadId).then(async (d) => {
      if (cancelled) return;
      setState(d);
      if (d.has_export) {
        const url = await api.fetchFenceScopeExportBlobUrl(leadId);
        if (!cancelled) setThumbUrl(url);
      }
      setLoading(false);
    }).catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [leadId]);

  if (loading) {
    return (
      <Card><CardContent className="p-4 flex items-center justify-center h-32">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </CardContent></Card>
    );
  }

  const started = state?.has_source;

  return (
    <Card>
      <CardContent className="p-4 flex flex-col sm:flex-row gap-4 items-start sm:items-center">
        <div className="h-24 w-32 shrink-0 rounded border bg-muted/40 overflow-hidden flex items-center justify-center">
          {thumbUrl ? (
            <img src={thumbUrl} alt="Fence scope" className="h-full w-full object-cover" />
          ) : (
            <span className="text-[10px] text-muted-foreground px-2 text-center">
              {started ? "Not exported yet" : "No scope yet"}
            </span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold">Fence Staining Scope</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            A branded blue/red fence markup sent to the customer to confirm exactly what's being stained — before they get the estimate.
          </p>
          {state?.updated_at && (
            <p className="text-[11px] text-muted-foreground mt-1">
              Last updated {new Date(state.updated_at).toLocaleDateString()}
              {state.updated_by ? ` by ${state.updated_by}` : ""}
            </p>
          )}
        </div>
        <Button onClick={() => navigate(`/leads/${leadId}/scope`)} className="shrink-0">
          <PenLine className="h-4 w-4 mr-1.5" /> {started ? "Edit Scope" : "Create Scope"}
        </Button>
      </CardContent>
    </Card>
  );
}
