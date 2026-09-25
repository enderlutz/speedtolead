import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, type LeadDetail } from "@/lib/api";
import FenceScopeEditorPanel from "@/components/FenceScopeEditor";

export default function FenceScopeEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [lead, setLead] = useState<LeadDetail | null>(null);

  useEffect(() => {
    if (!id) return;
    api.getLead(id).then(setLead).catch(() => {});
  }, [id]);

  if (!id) return null;

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      <div className="flex items-center gap-3 border-b px-4 py-2.5">
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => navigate(`/leads/${id}`)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0">
          <h1 className="text-sm font-semibold truncate">
            {lead ? `Fence Scope — ${lead.contact_name || "Lead"}` : <Loader2 className="h-3.5 w-3.5 animate-spin inline" />}
          </h1>
          {lead?.address && <p className="text-xs text-muted-foreground truncate">{lead.address}</p>}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <FenceScopeEditorPanel leadId={id} />
      </div>
    </div>
  );
}
