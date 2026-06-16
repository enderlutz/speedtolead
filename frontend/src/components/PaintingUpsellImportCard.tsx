// PaintingUpsellImportCard — admin Settings card for the one-shot
// migration from the OLD GHL account into the local Painting Upsell
// pipeline. Two distinct sub-sections:
//
//   1. NEW-account pipeline setup (one-time)
//      Discover pipelines in the new GHL account, pick the "Painting
//      Upsell" pipeline you created, pick its landing stage. Stored
//      in SystemConfig so push-to-v2 knows where to create opps.
//
//   2. OLD-account import (run when ready)
//      Paste the old account's API key, preview (count + samples),
//      then run import. The key is only held in this component's
//      state during the session — never persisted, never sent to
//      anything but the two import endpoints.

import { useEffect, useState } from "react";
import { api, getCurrentUser } from "@/lib/api";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Paintbrush,
  Loader2,
  Download,
  Eye,
  CheckCircle2,
  Cog,
  AlertTriangle,
  Trash2,
} from "lucide-react";

type Preview =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ok"; count: number; samples: { name: string; phone: string; created_at: string }[] };

type V2Pipeline = { id: string; name: string; stages: { id: string; name: string }[] };

export default function PaintingUpsellImportCard() {
  const isAdmin = getCurrentUser()?.role === "admin";

  // ─── New-account pipeline config (one-time setup) ───
  const [v2Configured, setV2Configured] = useState<boolean | null>(null);
  const [v2ConfigPipelineId, setV2ConfigPipelineId] = useState("");
  const [v2ConfigStageId, setV2ConfigStageId] = useState("");
  const [v2Pipelines, setV2Pipelines] = useState<V2Pipeline[] | null>(null);
  const [loadingPipelines, setLoadingPipelines] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);

  // ─── Old-account import (paste-and-go) ───
  const [apiKey, setApiKey] = useState("");
  const [preview, setPreview] = useState<Preview>({ kind: "idle" });
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null);
  const [wiping, setWiping] = useState(false);

  // Pull saved v2 config on mount so the UI starts from the right state.
  useEffect(() => {
    if (!isAdmin) return;
    api
      .getPaintingUpsellV2Config()
      .then((c) => {
        setV2Configured(c.configured);
        setV2ConfigPipelineId(c.pipeline_id);
        setV2ConfigStageId(c.new_stage_id);
      })
      .catch(() => setV2Configured(false));
  }, [isAdmin]);

  if (!isAdmin) return null;

  const handleDiscoverPipelines = async () => {
    setLoadingPipelines(true);
    try {
      const r = await api.listV2Pipelines();
      setV2Pipelines(r.pipelines);
      // Auto-pick a pipeline whose name matches "painting upsell" so
      // they don't have to scroll if they named it sensibly.
      const auto = r.pipelines.find((p) => p.name.toLowerCase().includes("painting upsell"));
      if (auto) {
        setV2ConfigPipelineId(auto.id);
        const firstStage = auto.stages[0]?.id;
        if (firstStage) setV2ConfigStageId(firstStage);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Pipeline discovery failed");
    } finally {
      setLoadingPipelines(false);
    }
  };

  const handleSaveV2Config = async () => {
    if (!v2ConfigPipelineId || !v2ConfigStageId) {
      toast.error("Pick a pipeline AND a stage");
      return;
    }
    setSavingConfig(true);
    try {
      await api.savePaintingUpsellV2Config(v2ConfigPipelineId, v2ConfigStageId);
      setV2Configured(true);
      toast.success("Painting Upsell v2 pipeline saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingConfig(false);
    }
  };

  const handlePreview = async () => {
    if (!apiKey.trim()) {
      toast.error("Paste the old GHL account's API key first");
      return;
    }
    setPreview({ kind: "loading" });
    try {
      const r = await api.getPaintingUpsellPreview(apiKey.trim());
      // The endpoint returns 200 even on GHL failure — the actual GHL
      // error rides on `error` so we can surface the HTTP status code.
      if (r.error) {
        setPreview({ kind: "error", message: r.error });
      } else {
        setPreview({ kind: "ok", count: r.count, samples: r.samples });
      }
    } catch (e) {
      setPreview({
        kind: "error",
        message: e instanceof Error ? e.message : "Preview failed",
      });
    }
  };

  const handleWipe = async () => {
    if (
      !confirm(
        "Delete EVERY lead currently in the Painting Upsell pipeline?\n\n" +
          "This wipes the local DB state for this pipeline only (their messages " +
          "+ estimates too). v2 leads — including any that were already pushed " +
          "to the new GHL account — are NOT touched.\n\n" +
          "Use this to clean up after a partial / failed import before re-running.",
      )
    )
      return;
    setWiping(true);
    try {
      const r = await api.wipePaintingUpsell();
      toast.success(
        `Wiped ${r.deleted_leads} leads + ${r.deleted_messages} messages + ${r.deleted_estimates} estimates`,
      );
      setLastRun(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Wipe failed");
    } finally {
      setWiping(false);
    }
  };

  const handleRunImport = async () => {
    if (!apiKey.trim()) {
      toast.error("Paste the old GHL account's API key first");
      return;
    }
    if (
      !confirm(
        "Pull every old-GHL Happy Customer into the Painting Upsell pipeline?\n\n" +
          "No dedup — duplicates of existing v2 leads will be created. " +
          "This is a one-shot batch.",
      )
    )
      return;
    setRunning(true);
    try {
      const r = await api.runPaintingUpsellImport(apiKey.trim());
      setLastRun(r);
      toast.success(
        `Imported ${r.imported} leads` +
          (r.skipped ? `, skipped ${r.skipped}` : "") +
          (r.errors.length ? `, ${r.errors.length} errors` : ""),
      );
      // Clear the key from state once the import is done — defense-in-
      // depth so it doesn't sit around in browser memory longer than
      // necessary. The admin can re-paste if they need to run again.
      setApiKey("");
      setPreview({ kind: "idle" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed");
    } finally {
      setRunning(false);
    }
  };

  const chosenPipeline = v2Pipelines?.find((p) => p.id === v2ConfigPipelineId);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm sm:text-base flex items-center gap-2">
          <Paintbrush className="h-4 w-4 text-sky-600" />
          Painting Upsell — old-GHL import
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <p className="text-xs text-muted-foreground">
          One-shot migration of historical Happy Customers from the OLD GHL
          account into the dedicated{" "}
          <a href="/leads/painting-upsell" className="underline hover:no-underline">
            Painting Upsell pipeline
          </a>
          . Two setup steps below.
        </p>

        {/* ─── Section 1: New-account pipeline config ─── */}
        <div className="rounded-md border p-3 space-y-3">
          <div className="flex items-center gap-2">
            <Cog className="h-4 w-4 text-slate-600" />
            <p className="text-sm font-semibold">
              Step 1 — Pick the Painting Upsell pipeline in the new GHL account
            </p>
            {v2Configured && (
              <span className="ml-auto inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700">
                <CheckCircle2 className="h-3 w-3" /> configured
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            One-time setup — tells the system which pipeline + landing stage to
            push leads into when they book exterior painting.
          </p>

          {v2Pipelines === null ? (
            <Button size="sm" variant="outline" onClick={handleDiscoverPipelines} disabled={loadingPipelines}>
              {loadingPipelines ? (
                <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
              ) : (
                <Cog className="h-3 w-3 mr-1.5" />
              )}
              Discover pipelines in new GHL account
            </Button>
          ) : (
            <div className="space-y-2">
              <div className="grid sm:grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-muted-foreground block mb-0.5">Pipeline</label>
                  <select
                    className="w-full text-xs border rounded h-8 px-2 bg-background"
                    value={v2ConfigPipelineId}
                    onChange={(e) => {
                      setV2ConfigPipelineId(e.target.value);
                      const p = v2Pipelines.find((pl) => pl.id === e.target.value);
                      setV2ConfigStageId(p?.stages[0]?.id || "");
                    }}
                  >
                    <option value="">— pick one —</option>
                    {v2Pipelines.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground block mb-0.5">
                    Landing stage (where pushed leads land)
                  </label>
                  <select
                    className="w-full text-xs border rounded h-8 px-2 bg-background"
                    value={v2ConfigStageId}
                    onChange={(e) => setV2ConfigStageId(e.target.value)}
                    disabled={!chosenPipeline}
                  >
                    <option value="">— pick one —</option>
                    {chosenPipeline?.stages.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleSaveV2Config}
                  disabled={savingConfig || !v2ConfigPipelineId || !v2ConfigStageId}
                >
                  {savingConfig ? (
                    <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-3 w-3 mr-1.5" />
                  )}
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={handleDiscoverPipelines} disabled={loadingPipelines}>
                  Refresh
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* ─── Section 2: Old-account import (paste-and-go) ─── */}
        <div className="rounded-md border p-3 space-y-3">
          <div className="flex items-center gap-2">
            <Download className="h-4 w-4 text-sky-600" />
            <p className="text-sm font-semibold">
              Step 2 — Paste old GHL API key + import
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            The API key is used for this single import and never stored anywhere.
            It lives in your browser tab until you close it.
          </p>
          <Input
            type="password"
            placeholder="pit-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="text-xs font-mono"
          />

          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={handlePreview} disabled={preview.kind === "loading" || running || !apiKey.trim()}>
              {preview.kind === "loading" ? (
                <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
              ) : (
                <Eye className="h-3 w-3 mr-1.5" />
              )}
              Preview
            </Button>
            <Button
              size="sm"
              onClick={handleRunImport}
              disabled={running || !apiKey.trim() || preview.kind !== "ok"}
            >
              {running ? (
                <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
              ) : (
                <Download className="h-3 w-3 mr-1.5" />
              )}
              {preview.kind === "ok" ? `Pull all ${preview.count} into pipeline` : "Run import"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-rose-600 hover:bg-rose-50 ml-auto"
              onClick={handleWipe}
              disabled={wiping || running}
              title="Delete all current Painting Upsell leads. Use to clean up before a re-import."
            >
              {wiping ? (
                <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
              ) : (
                <Trash2 className="h-3 w-3 mr-1.5" />
              )}
              Wipe pipeline
            </Button>
          </div>

          {preview.kind === "error" && (
            <div className="flex items-start gap-2 rounded-md bg-rose-500/10 border border-rose-500/30 p-2 text-xs text-rose-700">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <div>
                Preview failed: {preview.message}
                {preview.message.toLowerCase().includes("401") ||
                preview.message.toLowerCase().includes("unauthorized") ? (
                  <div className="mt-1">
                    Looks like the API key didn't work. Double-check you copied
                    the full key including the <code>pit-</code> prefix.
                  </div>
                ) : null}
              </div>
            </div>
          )}

          {preview.kind === "ok" && (
            <div className="rounded-md bg-sky-500/10 border border-sky-500/30 p-2 space-y-1 text-xs">
              <div className="font-semibold text-sky-800">
                {preview.count} leads in the old account's Happy Customer stage
              </div>
              <ul className="text-[11px] text-muted-foreground space-y-0.5 pl-4 list-disc">
                {preview.samples.slice(0, 5).map((s, i) => (
                  <li key={i}>
                    {s.name || "(unnamed)"} — {s.phone || "no phone"} — closed{" "}
                    {s.created_at || "?"}
                  </li>
                ))}
                {preview.count > 5 && <li>… and {preview.count - 5} more</li>}
              </ul>
            </div>
          )}
        </div>

        {lastRun && (
          <div className="rounded-md bg-emerald-500/10 border border-emerald-500/30 p-3 text-xs space-y-1">
            <div className="font-semibold text-emerald-800">
              ✓ Imported {lastRun.imported}
              {lastRun.skipped ? `, skipped ${lastRun.skipped}` : ""}
            </div>
            {lastRun.errors.length > 0 && (
              <details className="text-rose-700">
                <summary className="cursor-pointer">
                  {lastRun.errors.length} error{lastRun.errors.length === 1 ? "" : "s"}
                </summary>
                <ul className="mt-1 pl-4 list-disc space-y-0.5">
                  {lastRun.errors.slice(0, 10).map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              </details>
            )}
            <a href="/leads/painting-upsell" className="text-sky-700 underline inline-block">
              Open the Painting Upsell pipeline →
            </a>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
