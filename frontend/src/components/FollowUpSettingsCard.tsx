import { useEffect, useState, useCallback } from "react";
import { api, type FollowUpConfig, type FollowUpSequence, getCurrentUser } from "@/lib/api";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Power, Sparkles, Send, Edit2, Trash2, Plus } from "lucide-react";
import SequenceEditor from "@/components/SequenceEditor";

export default function FollowUpSettingsCard() {
  const isAdmin = getCurrentUser()?.role === "admin";
  const [config, setConfig] = useState<FollowUpConfig | null>(null);
  const [sequences, setSequences] = useState<FollowUpSequence[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [providerId, setProviderId] = useState("");
  const [testLeadId, setTestLeadId] = useState("");
  const [firingTest, setFiringTest] = useState<string | null>(null);
  const [editingSeqId, setEditingSeqId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    Promise.all([api.getFollowupConfig(), api.listFollowupSequences()])
      .then(([cfg, list]) => {
        setConfig(cfg);
        setProviderId(cfg.mycrmsim_provider_id || "");
        setTestLeadId(cfg.test_lead_id);
        setSequences(list.sequences);
      })
      .catch(() => toast.error("Failed to load follow-up config"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (isAdmin) refresh();
  }, [refresh, isAdmin]);

  if (!isAdmin) return null;

  const toggleMaster = async () => {
    if (!config) return;
    setSaving(true);
    try {
      const next = await api.updateFollowupConfig({ master_on: !config.master_on });
      setConfig(next);
      toast.success(next.master_on ? "Engine ON — runs will fire on next tick" : "Engine OFF");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to toggle master");
    } finally {
      setSaving(false);
    }
  };

  const saveNumbers = async () => {
    setSaving(true);
    try {
      const next = await api.updateFollowupConfig({
        mycrmsim_provider_id: providerId.trim(),
        test_lead_id: testLeadId.trim(),
      });
      setConfig(next);
      toast.success("Saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const toggleSeq = async (seq: FollowUpSequence) => {
    try {
      const r = await api.toggleFollowupSequence(seq.id);
      setSequences((prev) => prev.map((s) => (s.id === seq.id ? { ...s, active: r.active } : s)));
      toast.success(r.active ? `Activated "${seq.name}"` : `Deactivated "${seq.name}"`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  const deleteSeq = async (seq: FollowUpSequence) => {
    if (!confirm(`Delete sequence "${seq.name}"? This removes all its steps. Past runs are preserved for audit.`)) return;
    try {
      await api.deleteFollowupSequence(seq.id);
      setSequences((prev) => prev.filter((s) => s.id !== seq.id));
      toast.success("Deleted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  const fireTest = async (seq: FollowUpSequence) => {
    setFiringTest(seq.id);
    try {
      const r = await api.startFollowupTestRun({ sequence_id: seq.id });
      const warnings = (r as unknown as { warnings?: string[] }).warnings || [];
      if (warnings.length > 0) {
        // Loud warning when something will silently block the send.
        toast.warning(`Test run created on ${r.lead_name} — but it won't fire`, {
          description: warnings.join(" "),
          duration: 12000,
        });
      } else {
        toast.success(`Test run started on ${r.lead_name}`, {
          description: r.hint || "Will fire on the next tick (within 5 min).",
          duration: 8000,
        });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start test");
    } finally {
      setFiringTest(null);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm sm:text-base flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-violet-600" />
          Follow-up Engine
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <>
            {/* Master toggle */}
            <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5 bg-muted/20">
              <div className="flex items-center gap-2 min-w-0">
                <Power className={`h-4 w-4 ${config?.master_on ? "text-emerald-600" : "text-muted-foreground"}`} />
                <div className="min-w-0">
                  <p className="text-sm font-medium leading-tight">Master switch</p>
                  <p className="text-[11px] text-muted-foreground">
                    {config?.master_on
                      ? "Engine ON — active sequences will fire when due"
                      : "Engine OFF — nothing sends, even active sequences"}
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                variant={config?.master_on ? "outline" : "default"}
                onClick={toggleMaster}
                disabled={saving}
              >
                {config?.master_on ? "Turn OFF" : "Turn ON"}
              </Button>
            </div>

            {/* MyCRMSim provider ID + test lead */}
            <div className="space-y-2">
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">
                  MyCRMSim Conversation Provider ID
                </label>
                <Input
                  value={providerId}
                  onChange={(e) => setProviderId(e.target.value)}
                  placeholder="e.g. 685e4cb0e83b1a3187bfd686"
                />
                <p className="text-[11px] text-muted-foreground mt-1 leading-snug">
                  Found by sending an iMessage from GHL conversation UI with Chrome DevTools open
                  → Network tab → click the <code>messages</code> request → Payload → copy{" "}
                  <code>conversationProviderId</code>. With this set, the engine sends through
                  MyCRMSim (iMessage when possible, SMS fallback automatic). Leave blank to fall
                  back to GHL's default SMS line for all sends.
                </p>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground block mb-1">
                  Test lead ID <span className="opacity-60">(defaults to first lead named "Fragne …")</span>
                </label>
                <Input value={testLeadId} onChange={(e) => setTestLeadId(e.target.value)} placeholder="auto-detect" />
              </div>
              <div className="flex justify-end">
                <Button size="sm" onClick={saveNumbers} disabled={saving}>
                  Save
                </Button>
              </div>
            </div>

            {/* Sequences */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Sequences</p>
                <Button size="sm" variant="outline" onClick={async () => {
                  try {
                    const seq = await api.createFollowupSequence({ name: "Untitled sequence", description: "" });
                    setSequences((prev) => [seq, ...prev]);
                    setEditingSeqId(seq.id);
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Failed to create");
                  }
                }}>
                  <Plus className="h-3.5 w-3.5 mr-1" /> New sequence
                </Button>
              </div>
              {sequences.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">No sequences yet.</p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {sequences.map((seq) => (
                    <li key={seq.id} className="px-3 py-2.5 flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-medium truncate">{seq.name}</p>
                          <Badge variant="outline" className={seq.active ? "text-emerald-700 border-emerald-300" : "text-muted-foreground"}>
                            {seq.active ? "active" : "inactive"}
                          </Badge>
                          {seq.trigger_event && (
                            <Badge variant="outline" className="text-[10px]">trigger: {seq.trigger_event}</Badge>
                          )}
                        </div>
                        {seq.description && (
                          <p className="text-[11px] text-muted-foreground line-clamp-2 mt-0.5">{seq.description}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => fireTest(seq)}
                          disabled={firingTest === seq.id}
                          title="Fire this sequence on the configured test lead (Fragne by default)"
                        >
                          <Send className="h-3.5 w-3.5 mr-1" />
                          {firingTest === seq.id ? "Firing…" : "Test"}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => toggleSeq(seq)}>
                          {seq.active ? "Disable" : "Enable"}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditingSeqId(seq.id)} title="Edit steps + voice/text editor">
                          <Edit2 className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="text-red-600" onClick={() => deleteSeq(seq)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </CardContent>
      {editingSeqId && (
        <SequenceEditor
          sequenceId={editingSeqId}
          onClose={() => {
            setEditingSeqId(null);
            refresh();
          }}
        />
      )}
    </Card>
  );
}
