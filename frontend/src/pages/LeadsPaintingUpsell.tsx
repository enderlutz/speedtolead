// LeadsPaintingUpsell — dedicated pipeline page for the exterior-painting
// upsell agenda. Holds leads imported from the OLD GHL account (the
// pre-rebrand "Happy Customer" stage). The team works each lead via the
// Upsell tab on the lead detail page; when a customer books exterior
// painting, the admin clicks "Push to v2 GHL" and that lead becomes a
// regular v2 lead handled by the rest of the dashboard.
//
// Intentionally simpler than LeadsV2 — no drag-drop (move via dropdown),
// no fancy filters. Get-it-shipped UI for a one-shot agenda.

import { useEffect, useState, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  api,
  type LeadDetail,
  type PaintingUpsellStage,
  getCurrentUser,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Paintbrush,
  Loader2,
  ExternalLink,
  Send,
  Phone,
  RefreshCw,
} from "lucide-react";

export default function LeadsPaintingUpsell() {
  const navigate = useNavigate();
  const user = getCurrentUser();
  const isAdmin = user?.role === "admin";
  const [stages, setStages] = useState<PaintingUpsellStage[]>([]);
  const [leads, setLeads] = useState<LeadDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyLeadId, setBusyLeadId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.listPaintingUpsellLeads();
      setStages(r.stages);
      setLeads(r.leads);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load pipeline");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const leadsByStage = useMemo(() => {
    const groups: Record<string, LeadDetail[]> = Object.fromEntries(
      stages.map((s) => [s.id, []]),
    );
    for (const lead of leads) {
      const stageId = lead.kanban_column || stages[0]?.id;
      if (stageId && groups[stageId]) groups[stageId].push(lead);
      else if (stages[0]?.id) groups[stages[0].id].push(lead);
    }
    return groups;
  }, [leads, stages]);

  const handleMove = async (leadId: string, stageId: string) => {
    setBusyLeadId(leadId);
    try {
      await api.movePaintingUpsellStage(leadId, stageId);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Move failed");
    } finally {
      setBusyLeadId(null);
    }
  };

  const handlePushToV2 = async (leadId: string, leadName: string) => {
    if (
      !confirm(
        `Push "${leadName}" to the new GHL account?\n\n` +
          "Creates a new GHL contact in the v2 account and removes the lead " +
          "from this Painting Upsell pipeline. They'll appear in the regular " +
          "leads kanban as a new v2 lead.",
      )
    )
      return;
    setBusyLeadId(leadId);
    try {
      await api.pushPaintingUpsellToV2(leadId);
      toast.success(`${leadName} pushed to v2 GHL`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Push failed");
    } finally {
      setBusyLeadId(null);
    }
  };

  return (
    <div className="space-y-4 max-w-[1600px] mx-auto p-4 sm:p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Paintbrush className="h-5 w-5 text-sky-600" />
          <h1 className="text-lg sm:text-2xl font-semibold tracking-tight">
            Painting Upsell pipeline
          </h1>
          <Badge variant="outline" className="text-[10px]">
            {leads.length} lead{leads.length === 1 ? "" : "s"}
          </Badge>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={refresh} disabled={loading}>
            {loading ? (
              <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3 mr-1.5" />
            )}
            Refresh
          </Button>
          {isAdmin && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigate("/settings")}
            >
              Import from old GHL →
            </Button>
          )}
        </div>
      </div>

      <p className="text-sm text-muted-foreground max-w-3xl">
        Historical happy customers pulled from the old GHL account. Use the
        Upsell tab on each lead to pitch exterior painting; when one books,
        click Push to v2 GHL to move them into the regular dashboard
        kanban as a v2 lead.
      </p>

      {loading && leads.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin inline mr-2" /> Loading…
          </CardContent>
        </Card>
      ) : leads.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            No leads in the Painting Upsell pipeline yet. Head to{" "}
            <a className="underline" href="/settings">
              Settings → Painting Upsell — import from old GHL
            </a>{" "}
            to pull them in.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
          {stages.map((stage) => (
            <div key={stage.id} className={`rounded-lg ${stage.bg_cls}`}>
              <div
                className={`px-3 py-2 rounded-t-lg ${stage.header_cls} flex items-center justify-between`}
              >
                <span className="text-xs font-semibold truncate" title={stage.label}>
                  {stage.short}
                </span>
                <Badge variant="outline" className="text-[10px] bg-white/40">
                  {leadsByStage[stage.id]?.length || 0}
                </Badge>
              </div>
              <div className="p-2 space-y-2 min-h-[200px]">
                {(leadsByStage[stage.id] || []).map((lead) => (
                  <PipelineCard
                    key={lead.id}
                    lead={lead}
                    stages={stages}
                    currentStageId={stage.id}
                    busy={busyLeadId === lead.id}
                    onOpen={() => navigate(`/leads/${lead.id}`)}
                    onMove={(stageId) => handleMove(lead.id, stageId)}
                    onPushToV2={() =>
                      handlePushToV2(lead.id, lead.contact_name || "this lead")
                    }
                    showPushButton={stage.id === "pu_booked" && isAdmin}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PipelineCard({
  lead,
  stages,
  currentStageId,
  busy,
  onOpen,
  onMove,
  onPushToV2,
  showPushButton,
}: {
  lead: LeadDetail;
  stages: PaintingUpsellStage[];
  currentStageId: string;
  busy: boolean;
  onOpen: () => void;
  onMove: (stageId: string) => void;
  onPushToV2: () => void;
  showPushButton: boolean;
}) {
  return (
    <Card className="text-xs hover:shadow-md transition-shadow">
      <CardHeader className="p-2.5 pb-1.5">
        <CardTitle className="text-xs truncate" title={lead.contact_name}>
          {lead.contact_name || "(no name)"}
        </CardTitle>
        {lead.contact_phone && (
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <Phone className="h-2.5 w-2.5" />
            <span className="truncate">{lead.contact_phone}</span>
          </div>
        )}
      </CardHeader>
      <CardContent className="p-2.5 pt-0 space-y-1.5">
        {lead.address && (
          <div className="text-[10px] text-muted-foreground truncate">
            {lead.address}
          </div>
        )}
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[10px] px-2"
            onClick={onOpen}
            disabled={busy}
          >
            <ExternalLink className="h-2.5 w-2.5 mr-1" />
            Open
          </Button>
          <select
            className="text-[10px] border rounded h-6 px-1 bg-background"
            value={currentStageId}
            onChange={(e) => onMove(e.target.value)}
            disabled={busy}
          >
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                Move → {s.short}
              </option>
            ))}
          </select>
        </div>
        {showPushButton && (
          <Button
            size="sm"
            className="h-6 text-[10px] w-full bg-emerald-600 hover:bg-emerald-700"
            onClick={onPushToV2}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />
            ) : (
              <Send className="h-2.5 w-2.5 mr-1" />
            )}
            Push to v2 GHL
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
