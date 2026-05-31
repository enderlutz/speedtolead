import { useEffect, useState, useRef, useCallback } from "react";
import { api, getCurrentUser } from "@/lib/api";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Upload, Trash2, FileText, Search, ChevronDown, ChevronRight,
  BarChart3, Database, Send, RefreshCw, Link2, GitCompare, AlertCircle, CheckCircle2,
} from "lucide-react";
import type { GhlStageDiff } from "@/lib/api";
import PdfTemplateEditor from "@/components/PdfTemplateEditor";
import ChatbotSettings from "@/components/ChatbotSettings";
import CallScriptSettings from "@/components/CallScriptSettings";
import FollowUpSettingsCard from "@/components/FollowUpSettingsCard";
import QuickBooksSettingsCard from "@/components/QuickBooksSettingsCard";
import QBTimeSettingsCard from "@/components/QBTimeSettingsCard";
import SupportCard from "@/components/SupportCard";

interface PdfTemplateInfo {
  id: string;
  filename: string;
  page_count: number;
  field_map: Record<string, unknown>;
}

interface SystemStats {
  total_leads: number;
  total_estimates: number;
  sent_estimates: number;
}

export default function Settings() {
  // PDF Template state
  const [template, setTemplate] = useState<PdfTemplateInfo | null>(null);
  const [templateLoading, setTemplateLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // GHL state
  const [pipelines, setPipelines] = useState<Record<string, unknown[]> | null>(null);
  const [pipelinesLoading, setPipelinesLoading] = useState(false);
  const [pipelinesOpen, setPipelinesOpen] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);

  // Field mapping state
  const [syncedFields, setSyncedFields] = useState<{ ghl_field_id: string; ghl_field_name: string; ghl_field_key: string; field_type: string; options: string[]; location: string }[]>([]);
  const [mappings, setMappings] = useState<{ ghl_field_id: string; ghl_field_key: string; ghl_field_name: string; our_field_name: string }[]>([]);
  const [ourFieldOptions, setOurFieldOptions] = useState<{ value: string; label: string }[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [mappingsLoaded, setMappingsLoaded] = useState(false);

  // Stats state
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  useEffect(() => {
    api
      .getPdfTemplate()
      .then(setTemplate)
      .catch(() => setTemplate(null))
      .finally(() => setTemplateLoading(false));

    api
      .getStats()
      .then(setStats)
      .catch(() => toast.error("Failed to load stats"))
      .finally(() => setStatsLoading(false));
  }, []);

  const uploadFile = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      toast.error("Only PDF files are allowed");
      return;
    }
    setUploading(true);
    try {
      const result = await api.uploadPdfTemplate(file);
      setTemplate({ ...result, field_map: result.field_map ?? {} });
      toast.success("Template uploaded");
    } catch {
      toast.error("Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, []);

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadFile(file);
  };

  const safeFieldMap = (template?.field_map ?? {}) as Record<string, { page: number; x: number; y: number; font_size: number; color?: string }>;

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) uploadFile(file);
  }, [uploadFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
  }, []);

  const handleDeleteTemplate = async () => {
    // Reset template display (backend would need a delete endpoint)
    setTemplate(null);
    toast.success("Template removed");
  };

  const handleDiscoverPipelines = async () => {
    setPipelinesLoading(true);
    try {
      const data = await api.getGhlPipelines();
      setPipelines(data);
      setPipelinesOpen(true);
      toast.success("Pipelines discovered");
    } catch {
      toast.error("Failed to discover pipelines");
    } finally {
      setPipelinesLoading(false);
    }
  };


  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-3xl">
      <h1 className="text-lg sm:text-2xl font-semibold tracking-tight">
        Settings
      </h1>

      {/* GHL Maintenance */}
      <BackfillDashboardLinksCard />

      {/* GHL stage diff — surfaces stages Alan added in GHL that we don't
          know about. Run this any time the kanban looks "missing" a stage. */}
      <StageDiffCard />

      {/* Call Script — VA's reading panel on Lead Detail pulls from here */}
      <CallScriptSettings />

      {/* Follow-up Engine — master toggle, routing numbers, sequences */}
      <FollowUpSettingsCard />

      {/* QuickBooks Online — OAuth connection, mode, realm, reconnect banner */}
      <QuickBooksSettingsCard />

      {/* QuickBooks Time — separate OAuth app for time tracking + payroll-adjacent sync */}
      <QBTimeSettingsCard />

      {/* Support + legal — surfaces contact email + EULA / Privacy links */}
      <SupportCard />

      {/* Google Calendar OAuth */}
      <GoogleCalendarCard />

      {/* PDF Template */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm sm:text-base flex items-center gap-2">
            <FileText className="h-4 w-4" />
            PDF Template
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {templateLoading ? (
            <div className="h-10 bg-muted rounded animate-pulse" />
          ) : template ? (
            <div className="flex items-center justify-between gap-3 p-3 rounded-lg border bg-muted/30">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">
                  {template.filename}
                </p>
                <p className="text-xs text-muted-foreground">
                  {template.page_count} page{template.page_count !== 1 ? "s" : ""}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleDeleteTemplate}
                className="text-red-500 hover:text-red-600 hover:bg-red-50 shrink-0"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No template uploaded</p>
          )}

          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => !uploading && fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
              dragging
                ? "border-primary bg-primary/5"
                : "border-muted-foreground/25 hover:border-muted-foreground/50"
            } ${uploading ? "opacity-50 pointer-events-none" : ""}`}
          >
            <Input
              ref={fileInputRef}
              type="file"
              accept=".pdf"
              onChange={handleUpload}
              className="hidden"
              id="pdf-upload"
            />
            <Upload className={`h-8 w-8 mx-auto mb-2 ${dragging ? "text-primary" : "text-muted-foreground/50"}`} />
            <p className="text-sm font-medium">{uploading ? "Uploading..." : "Drop PDF here or tap to browse"}</p>
            <p className="text-xs text-muted-foreground mt-1">PDF files only</p>
          </div>

          {/* Template Editor */}
          {template && (
            <PdfTemplateEditor
              pageCount={template.page_count}
              pageSizes={(template as unknown as { page_sizes?: { width: number; height: number }[] }).page_sizes || []}
              initialFieldMap={safeFieldMap}
              onSave={(fieldMap) => setTemplate((prev) => prev ? { ...prev, field_map: fieldMap } : prev)}
            />
          )}
        </CardContent>
      </Card>

      {/* GHL Field Mapping */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm sm:text-base flex items-center gap-2">
            <Link2 className="h-4 w-4" />
            GHL Field Mapping
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">Map GHL custom fields to our internal fields so leads are properly categorized.</p>

          <div className="flex flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              onClick={async () => {
                setSyncing(true);
                try {
                  const data = await api.syncGhlFields();
                  setSyncedFields(data.fields);
                  // Load mappings after sync
                  const mapData = await api.getFieldMappings();
                  setMappings(mapData.mappings);
                  setOurFieldOptions(mapData.our_field_options);
                  setMappingsLoaded(true);
                  toast.success(`Synced ${data.synced} fields from GHL`);
                } catch {
                  toast.error("Failed to sync fields");
                } finally {
                  setSyncing(false);
                }
              }}
              disabled={syncing}
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${syncing ? "animate-spin" : ""}`} />
              {syncing ? "Syncing..." : "Sync Fields from GHL"}
            </Button>
            {!mappingsLoaded && (
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    const data = await api.getFieldMappings();
                    setMappings(data.mappings);
                    setOurFieldOptions(data.our_field_options);
                    setMappingsLoaded(true);
                  } catch {
                    toast.error("Failed to load mappings");
                  }
                }}
              >
                <Database className="h-4 w-4 mr-2" /> Load Current Mappings
              </Button>
            )}
          </div>

          {/* Synced fields with options */}
          {syncedFields.length > 0 && (
            <div className="border rounded-lg">
              <button
                onClick={() => setFieldsOpen(!fieldsOpen)}
                className="w-full flex items-center justify-between p-3 text-sm font-medium hover:bg-muted/50 transition-colors"
              >
                <span>GHL Custom Fields ({syncedFields.length})</span>
                {fieldsOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
              {fieldsOpen && (
                <div className="border-t max-h-64 overflow-y-auto">
                  {syncedFields.map((f) => (
                    <div key={f.ghl_field_id} className="px-3 py-2 border-b last:border-0 hover:bg-muted/20">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium">{f.ghl_field_name}</p>
                          <p className="text-[10px] text-muted-foreground">{f.location} | {f.field_type} | {f.ghl_field_key}</p>
                        </div>
                      </div>
                      {f.options && f.options.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {f.options.map((opt, i) => (
                            <span key={i} className="text-[10px] bg-muted px-1.5 py-0.5 rounded">{typeof opt === "object" ? JSON.stringify(opt) : String(opt)}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Field mappings */}
          {mappingsLoaded && mappings.length > 0 && (
            <div className="border rounded-lg">
              <div className="p-3 border-b bg-muted/30">
                <p className="text-sm font-medium">Field Mappings</p>
                <p className="text-[10px] text-muted-foreground">Map each GHL field to an internal field</p>
              </div>
              <div className="max-h-96 overflow-y-auto">
                {mappings.map((m) => (
                  <div key={m.ghl_field_id} className="flex items-center gap-3 px-3 py-2 border-b last:border-0 hover:bg-muted/10">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{m.ghl_field_name || m.ghl_field_key}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{m.ghl_field_id}</p>
                    </div>
                    <select
                      className="text-sm border rounded px-2 py-1 bg-background min-w-[150px]"
                      value={m.our_field_name}
                      onChange={async (e) => {
                        const newValue = e.target.value;
                        try {
                          await api.updateFieldMapping(m.ghl_field_id, newValue);
                          setMappings(prev => prev.map(p => p.ghl_field_id === m.ghl_field_id ? { ...p, our_field_name: newValue } : p));
                          toast.success(`Mapped "${m.ghl_field_name}" → ${newValue || "unmapped"}`);
                        } catch {
                          toast.error("Failed to update mapping");
                        }
                      }}
                    >
                      {ourFieldOptions.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Legacy discover buttons */}
          <div className="flex flex-col sm:flex-row gap-2">
            <Button variant="outline" size="sm" onClick={handleDiscoverPipelines} disabled={pipelinesLoading}>
              <Search className="h-3.5 w-3.5 mr-1" />
              {pipelinesLoading ? "Loading..." : "View Pipelines"}
            </Button>
          </div>

          {pipelines && (
            <div className="border rounded-lg">
              <button onClick={() => setPipelinesOpen(!pipelinesOpen)} className="w-full flex items-center justify-between p-3 text-sm font-medium hover:bg-muted/50">
                <span>Pipelines ({Object.keys(pipelines).length})</span>
                {pipelinesOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
              {pipelinesOpen && (
                <div className="border-t px-3 pb-3 space-y-3">
                  {Object.entries(pipelines).map(([name, stages]) => (
                    <div key={name} className="pt-3">
                      <p className="text-sm font-semibold">{name}</p>
                      <div className="mt-1 space-y-0.5">
                        {Array.isArray(stages) && stages.map((stage, i) => (
                          <p key={i} className="text-xs text-muted-foreground pl-3">
                            {typeof stage === "object" && stage !== null ? (stage as Record<string, string>).name || JSON.stringify(stage) : String(stage)}
                          </p>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* System Stats */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm sm:text-base flex items-center gap-2">
            <BarChart3 className="h-4 w-4" />
            System Stats
          </CardTitle>
        </CardHeader>
        <CardContent>
          {statsLoading ? (
            <div className="grid grid-cols-3 gap-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-16 bg-muted rounded animate-pulse" />
              ))}
            </div>
          ) : stats ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="p-3 rounded-lg border bg-muted/30 text-center">
                <Database className="h-4 w-4 mx-auto text-muted-foreground mb-1" />
                <p className="text-2xl font-bold">{stats.total_leads}</p>
                <p className="text-xs text-muted-foreground">Total Leads</p>
              </div>
              <div className="p-3 rounded-lg border bg-muted/30 text-center">
                <BarChart3 className="h-4 w-4 mx-auto text-muted-foreground mb-1" />
                <p className="text-2xl font-bold">{stats.total_estimates}</p>
                <p className="text-xs text-muted-foreground">Total Estimates</p>
              </div>
              <div className="p-3 rounded-lg border bg-muted/30 text-center">
                <Send className="h-4 w-4 mx-auto text-muted-foreground mb-1" />
                <p className="text-2xl font-bold">{stats.sent_estimates}</p>
                <p className="text-xs text-muted-foreground">Sent Estimates</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Failed to load stats
            </p>
          )}
        </CardContent>
      </Card>

      {/* Chatbot Settings */}
      <ChatbotSettings />
    </div>
  );
}


function BackfillDashboardLinksCard() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ total: number; succeeded: number; failed: number; skipped: number } | null>(null);

  const handleRun = async () => {
    if (!confirm("Pin a Dashboard link note to every v2 lead's GHL contact that doesn't have one yet? This is idempotent — safe to re-run.")) return;
    setRunning(true);
    try {
      const r = await api.backfillDashboardLinkNotes("v2");
      setResult(r);
      toast.success(`Backfill complete: ${r.succeeded} added, ${r.skipped} skipped, ${r.failed} failed`);
    } catch {
      toast.error("Backfill failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm sm:text-base flex items-center gap-2">
          <Link2 className="h-4 w-4" /> GHL Dashboard Links Backfill
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Pins a "Dashboard link: ..." note to the GHL contact for every v2 lead that doesn't already have one. New leads going forward already get this automatically — this button is for catching up the leads that existed before the feature.
        </p>
        <Button onClick={handleRun} disabled={running} size="sm">
          <RefreshCw className={`h-4 w-4 mr-2 ${running ? "animate-spin" : ""}`} />
          {running ? "Backfilling..." : "Run Backfill"}
        </Button>
        {result && (
          <div className="text-xs space-y-0.5 rounded border bg-muted/30 p-2">
            <p>Total v2 leads scanned: <span className="font-semibold">{result.total}</span></p>
            <p>Notes added: <span className="font-semibold text-green-700">{result.succeeded}</span></p>
            <p>Already had a link: <span className="font-semibold">{result.skipped}</span></p>
            {result.failed > 0 && <p>Failed: <span className="font-semibold text-red-700">{result.failed}</span></p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}


function GoogleCalendarCard() {
  const user = getCurrentUser();
  const isAdmin = user?.role === "admin";
  const [status, setStatus] = useState<{ connected: boolean; email?: string; connected_at?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api.getGoogleStatus().then(setStatus).catch(() => setStatus({ connected: false }));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Surface OAuth callback result from URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("google_connected")) {
      toast.success(`Connected as ${params.get("google_connected")}`);
      window.history.replaceState({}, "", window.location.pathname);
      refresh();
    } else if (params.get("google_error")) {
      toast.error(`Google connect failed: ${params.get("google_error")}`);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [refresh]);

  const connect = async () => {
    setBusy(true);
    try {
      const r = await api.getGoogleAuthUrl();
      window.location.href = r.url;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start Google auth");
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!confirm("Disconnect Google Calendar? Future jobs won't auto-sync to your calendar or send invites.")) return;
    try {
      await api.disconnectGoogle();
      toast.success("Disconnected");
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to disconnect");
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm sm:text-base flex items-center gap-2">
          📅 Google Calendar
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Link Alan's Google account so scheduled jobs auto-sync to his calendar and customers receive Google Calendar invites.
        </p>
        {!status ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : status.connected ? (
          <div className="flex items-center gap-2 flex-wrap">
            <Badge className="bg-emerald-100 text-emerald-800 text-[10px]">Connected</Badge>
            <span className="text-sm">{status.email || "(unknown account)"}</span>
            {isAdmin && (
              <Button size="sm" variant="outline" className="ml-auto text-red-600" onClick={disconnect}>
                Disconnect
              </Button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px]">Not connected</Badge>
            {isAdmin && (
              <Button size="sm" onClick={connect} disabled={busy}>
                {busy ? "Redirecting…" : "Connect Google"}
              </Button>
            )}
            {!isAdmin && (
              <span className="text-xs text-muted-foreground">Only Alan can connect Google.</span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}


function StageDiffCard() {
  // Surfaces drift between live GHL stages and our hardcoded V2_STAGES.
  // Admin only — same trust level as the other GHL diagnostic cards on
  // this page. When the user spots a missing stage in the result, they
  // share it with whoever maintains the codebase to add it to
  // V2_STAGES (frontend) and pipeline_stages.py (backend).
  const [loading, setLoading] = useState(false);
  const [diff, setDiff] = useState<GhlStageDiff | null>(null);
  const [showAll, setShowAll] = useState(false);

  const run = async () => {
    setLoading(true);
    try {
      const r = await api.getGhlStageDiff();
      setDiff(r);
      const missing = r.missing_from_dashboard.length;
      if (missing === 0) {
        toast.success("In sync — no missing stages");
      } else {
        toast.warning(`${missing} stage${missing === 1 ? "" : "s"} missing from dashboard`);
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Stage diff failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm sm:text-base flex items-center gap-2">
          <GitCompare className="h-4 w-4" /> GHL Pipeline Stage Diff
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Compares the live GHL pipeline against the hardcoded stage list
          in the dashboard. Use this whenever Alan adds new stages in GHL
          and you want to know what to add to the codebase.
        </p>
        <Button size="sm" onClick={run} disabled={loading} variant="outline">
          {loading ? (
            <><RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Checking…</>
          ) : (
            <><GitCompare className="h-3.5 w-3.5 mr-1.5" /> Run diff</>
          )}
        </Button>

        {diff && (
          <div className="space-y-3 text-sm">
            <div className="text-xs text-muted-foreground">
              Pipeline: <span className="font-mono">{diff.pipeline_name}</span>
              <span className="mx-1">·</span>
              {diff.matched} stages matched
            </div>

            {diff.missing_from_dashboard.length > 0 ? (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
                <div className="flex items-center gap-1.5 text-amber-900 font-medium mb-2">
                  <AlertCircle className="h-4 w-4" />
                  Missing from dashboard ({diff.missing_from_dashboard.length})
                </div>
                <p className="text-xs text-amber-800 mb-2">
                  These exist in GHL but NOT in <span className="font-mono">V2_STAGES</span>{" "}
                  or <span className="font-mono">pipeline_stages.py</span>. Share these
                  IDs + names with whoever maintains the code.
                </p>
                <ul className="space-y-1">
                  {diff.missing_from_dashboard.map((s) => (
                    <li key={s.id} className="text-xs">
                      <span className="font-mono text-amber-900">{s.id}</span>
                      <span className="mx-1.5">·</span>
                      <span className="font-medium">{s.name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 flex items-center gap-2 text-emerald-900 text-sm">
                <CheckCircle2 className="h-4 w-4" />
                Dashboard knows about every live GHL stage.
              </div>
            )}

            {diff.extra_in_dashboard.length > 0 && (
              <div className="rounded-lg border border-slate-300 bg-slate-50 p-3">
                <div className="flex items-center gap-1.5 text-slate-700 font-medium mb-2">
                  <AlertCircle className="h-4 w-4" />
                  Extra in dashboard ({diff.extra_in_dashboard.length})
                </div>
                <p className="text-xs text-slate-600 mb-2">
                  Defined in our code but NOT returned by GHL. Probably renamed,
                  archived, or deleted on the GHL side. Safe to leave unless
                  cleanup is wanted.
                </p>
                <ul className="space-y-1">
                  {diff.extra_in_dashboard.map((s) => (
                    <li key={s.id} className="text-xs">
                      <span className="font-mono text-slate-700">{s.id}</span>
                      <span className="mx-1.5">·</span>
                      <span>{s.name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <button
              onClick={() => setShowAll((v) => !v)}
              className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            >
              {showAll ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {showAll ? "Hide" : "Show"} full live stage list (ordered, copy-pasteable)
            </button>
            {showAll && (
              <div className="rounded-lg border bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground mb-2">
                  All {diff.all_live_stages_in_order.length} live stages in their pipeline order:
                </p>
                <ol className="space-y-0.5 text-xs">
                  {diff.all_live_stages_in_order.map((s, i) => (
                    <li key={s.id}>
                      <span className="text-muted-foreground">{i + 1}.</span>{" "}
                      <span className="font-mono">{s.id}</span>
                      <span className="mx-1.5">·</span>
                      <span>{s.name}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
