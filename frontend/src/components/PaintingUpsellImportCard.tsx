// PaintingUpsellImportCard — admin one-shot import from the OLD GHL
// account's COMPLETED JOB-HAPPY CUSTOMER- SEND REVIEW stage into the
// new dashboard's Painting Upsell pipeline.
//
// Two phases on this card:
//   1. Preview — shows how many old leads are eligible + first few names
//   2. Run import — actually pulls them into the local DB
//
// Push-to-v2 is per-lead and lives on the Painting Upsell pipeline page,
// not here.

import { useEffect, useState } from "react";
import { api, getCurrentUser, type PaintingUpsellSample } from "@/lib/api";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Paintbrush, Loader2, Download, AlertTriangle } from "lucide-react";

type PreviewState =
  | { kind: "loading" }
  | { kind: "ok"; count: number; samples: PaintingUpsellSample[] }
  | { kind: "error"; message: string }
  | { kind: "not_configured" };

export default function PaintingUpsellImportCard() {
  const isAdmin = getCurrentUser()?.role === "admin";
  const [preview, setPreview] = useState<PreviewState>({ kind: "loading" });
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<
    | { imported: number; skipped: number; errors: string[] }
    | null
  >(null);

  const refresh = async () => {
    setPreview({ kind: "loading" });
    try {
      const r = await api.getPaintingUpsellPreview();
      if (!r.configured) {
        setPreview({ kind: "not_configured" });
        return;
      }
      setPreview({ kind: "ok", count: r.count, samples: r.samples });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to preview";
      // 503 = creds not set on Railway
      if (msg.includes("503") || msg.toLowerCase().includes("not set")) {
        setPreview({ kind: "not_configured" });
      } else {
        setPreview({ kind: "error", message: msg });
      }
    }
  };

  useEffect(() => {
    if (isAdmin) refresh();
  }, [isAdmin]);

  if (!isAdmin) return null;

  const handleRun = async () => {
    if (
      !confirm(
        "Pull every old-GHL Happy Customer into the Painting Upsell pipeline?\n\n" +
          "No dedup — duplicates of existing v2 leads will be created. " +
          "This is a one-shot batch you'll run once for the exterior-painting agenda.",
      )
    )
      return;
    setRunning(true);
    try {
      const r = await api.runPaintingUpsellImport();
      setLastRun(r);
      toast.success(
        `Imported ${r.imported} leads` +
          (r.skipped ? `, skipped ${r.skipped}` : "") +
          (r.errors.length ? `, ${r.errors.length} errors` : ""),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm sm:text-base flex items-center gap-2">
          <Paintbrush className="h-4 w-4 text-sky-600" />
          Painting Upsell — import from old GHL
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          One-shot pull of historical Happy Customers from the old GHL
          account (pre-rebrand) into the dedicated{" "}
          <a
            href="/leads/painting-upsell"
            className="underline hover:no-underline"
          >
            Painting Upsell pipeline
          </a>
          . From there the team can use the Upsell tab to pitch exterior
          painting; when a customer books, push them into the new GHL
          account as a v2 lead.
        </p>

        {preview.kind === "loading" && (
          <div className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" /> Checking old account…
          </div>
        )}

        {preview.kind === "not_configured" && (
          <div className="flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/30 p-3">
            <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
            <div className="text-xs text-amber-700">
              Old-account credentials aren't set. Add
              <code className="ml-1 px-1 bg-amber-200/40 rounded">GHL_API_KEY_V1</code>{" "}
              and
              <code className="ml-1 px-1 bg-amber-200/40 rounded">GHL_LOCATION_ID_V1</code>{" "}
              in Railway env, then refresh.
            </div>
          </div>
        )}

        {preview.kind === "error" && (
          <div className="text-xs text-rose-700">
            Couldn't reach old account: {preview.message}
          </div>
        )}

        {preview.kind === "ok" && (
          <>
            <div className="text-sm">
              <span className="font-semibold text-sky-700">
                {preview.count} leads
              </span>{" "}
              currently in the old account's COMPLETED JOB-HAPPY CUSTOMER
              stage.
            </div>
            {preview.samples.length > 0 && (
              <ul className="text-xs text-muted-foreground space-y-0.5 pl-4 list-disc">
                {preview.samples.slice(0, 5).map((s, i) => (
                  <li key={i}>
                    {s.name || "(unnamed)"} — {s.phone || "no phone"} —
                    closed {s.created_at || "?"}
                  </li>
                ))}
                {preview.count > 5 && <li>… and {preview.count - 5} more</li>}
              </ul>
            )}
            <div className="flex gap-2">
              <Button size="sm" onClick={handleRun} disabled={running}>
                {running ? (
                  <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                ) : (
                  <Download className="h-3 w-3 mr-1.5" />
                )}
                Pull all {preview.count} into Painting Upsell pipeline
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={refresh}
                disabled={running}
              >
                Refresh preview
              </Button>
            </div>
          </>
        )}

        {lastRun && (
          <div className="rounded-md bg-emerald-500/10 border border-emerald-500/30 p-3 text-xs">
            <div className="font-semibold text-emerald-800 mb-1">
              Last run: imported {lastRun.imported}
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
            <a
              href="/leads/painting-upsell"
              className="text-sky-700 underline mt-1 inline-block"
            >
              Open the Painting Upsell pipeline →
            </a>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
