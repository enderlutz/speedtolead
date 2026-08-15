import { useEffect, useState, useCallback } from "react";
import { api, type QuickBooksStatus, getCurrentUser } from "@/lib/api";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FileText, AlertOctagon, RotateCcw, Link2, Unlink, RefreshCw } from "lucide-react";

export default function QuickBooksSettingsCard() {
  const isAdmin = getCurrentUser()?.role === "admin";
  const [status, setStatus] = useState<QuickBooksStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    api.getQuickBooksStatus()
      .then(setStatus)
      .catch(() => toast.error("Failed to load QuickBooks status"))
      .finally(() => setLoading(false));
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: raises the loading flag when this fetch's inputs change; the data itself lands asynchronously.
  useEffect(() => { if (isAdmin) refresh(); }, [refresh, isAdmin]);

  // Surface OAuth callback result from URL
  useEffect(() => {
    if (!isAdmin) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("qb_connected")) {
      toast.success(params.get("qb_connected") === "mock" ? "Connected (mock mode)" : "Connected to QuickBooks");
      window.history.replaceState({}, "", window.location.pathname);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: raises the loading flag when this fetch's inputs change; the data itself lands asynchronously.
      refresh();
    } else if (params.get("qb_error")) {
      toast.error(`QuickBooks connect failed: ${params.get("qb_error")}`);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [refresh, isAdmin]);

  if (!isAdmin) return null;

  const connect = async () => {
    setConnecting(true);
    try {
      const r = await api.getQuickBooksAuthUrl();
      if (r.mode === "mock") {
        toast.info(r.note || "Mock mode — set QB_MODE=live in Railway to enable real OAuth");
        setConnecting(false);
        return;
      }
      window.location.href = r.url;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start QB auth");
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    if (!confirm("Disconnect QuickBooks? Future invoices won't be created automatically.")) return;
    try {
      await api.disconnectQuickBooks();
      toast.success("Disconnected");
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to disconnect");
    }
  };

  const refreshDiscovery = async () => {
    try {
      const r = await api.refreshQuickBooksDiscovery();
      toast.success("OIDC discovery doc refreshed", {
        description: r.token_endpoint ? `token_endpoint: ${new URL(r.token_endpoint).host}` : "",
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to refresh discovery");
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm sm:text-base flex items-center gap-2">
          <FileText className="h-4 w-4" /> QuickBooks Online
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading || !status ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <>
            {/* Reconnect banner — only shown when refresh token expired or invalid_grant */}
            {status.needs_reconnect && (
              <div className="rounded-md border border-red-300 bg-red-50/60 p-3 flex items-start justify-between gap-2">
                <div className="flex items-start gap-2 min-w-0">
                  <AlertOctagon className="h-4 w-4 text-red-600 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-red-900">QuickBooks connection expired</p>
                    <p className="text-[12px] text-red-800/80 leading-snug">
                      {status.reconnect_reason || "The refresh token is no longer valid. Reconnect to keep invoicing working."}
                    </p>
                  </div>
                </div>
                <Button size="sm" variant="outline" onClick={connect} disabled={connecting}>
                  <RotateCcw className="h-3.5 w-3.5 mr-1" /> Reconnect
                </Button>
              </div>
            )}

            {/* Mode + environment row */}
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className="text-[10px]">
                mode: {status.mode}
              </Badge>
              {status.mode === "live" && (
                <Badge variant="outline" className={`text-[10px] ${status.environment === "production" ? "border-emerald-300 text-emerald-700" : "border-amber-300 text-amber-700"}`}>
                  {status.environment}
                </Badge>
              )}
              {status.mode === "mock" && (
                <Badge variant="outline" className="text-[10px] text-amber-700 border-amber-300">
                  test mode
                </Badge>
              )}
              {status.connected && (
                <Badge className="bg-emerald-100 text-emerald-800 text-[10px]">Connected</Badge>
              )}
            </div>

            {/* Connection details */}
            {status.connected ? (
              <div className="text-xs space-y-1">
                <div>
                  <span className="text-muted-foreground">Company: </span>
                  <span className="font-medium">{status.company_name || "(name pending)"}</span>
                </div>
                {status.realm_id && (
                  <div>
                    <span className="text-muted-foreground">Realm ID: </span>
                    <span className="font-mono">{status.realm_id}</span>
                  </div>
                )}
                {status.refresh_token_expires_at && (
                  <div>
                    <span className="text-muted-foreground">Refresh token valid until: </span>
                    <span>{new Date(status.refresh_token_expires_at).toLocaleDateString()}</span>
                  </div>
                )}
                <div className="flex gap-2 pt-2">
                  <Button size="sm" variant="outline" onClick={refreshDiscovery}>
                    <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh OIDC doc
                  </Button>
                  <Button size="sm" variant="outline" className="text-red-600" onClick={disconnect}>
                    <Unlink className="h-3.5 w-3.5 mr-1" /> Disconnect
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  {status.mode === "mock"
                    ? "Backend is in mock mode. To enable real invoicing: set QB_MODE=live + QB_CLIENT_ID/SECRET/REDIRECT_URI in Railway env, then click Connect."
                    : "Not connected. Click Connect to authorize the dashboard against your QuickBooks Online company."}
                </p>
                <Button size="sm" onClick={connect} disabled={connecting}>
                  <Link2 className="h-3.5 w-3.5 mr-1" />
                  {connecting ? "Redirecting…" : status.mode === "mock" ? "Connect (mock)" : "Connect QuickBooks"}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
