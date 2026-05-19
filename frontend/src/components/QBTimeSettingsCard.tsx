import { useEffect, useState, useCallback } from "react";
import { api, type QBTimeStatus, getCurrentUser } from "@/lib/api";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Clock, AlertOctagon, RotateCcw, Link2, Unlink } from "lucide-react";

export default function QBTimeSettingsCard() {
  const isAdmin = getCurrentUser()?.role === "admin";
  const [status, setStatus] = useState<QBTimeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    api
      .getQBTimeStatus()
      .then(setStatus)
      .catch(() => toast.error("Failed to load QuickBooks Time status"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (isAdmin) refresh();
  }, [refresh, isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("qbtime_connected")) {
      toast.success(
        params.get("qbtime_connected") === "mock"
          ? "Connected (mock mode)"
          : "Connected to QuickBooks Time",
      );
      window.history.replaceState({}, "", window.location.pathname);
      refresh();
    } else if (params.get("qbtime_error")) {
      toast.error(`QuickBooks Time connect failed: ${params.get("qbtime_error")}`);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [refresh, isAdmin]);

  if (!isAdmin) return null;

  const connect = async () => {
    setConnecting(true);
    try {
      const r = await api.getQBTimeAuthUrl();
      if (r.mode === "mock") {
        toast.info(r.note || "Mock mode — set QB_TIME_MODE=live in Railway to enable real OAuth");
        setConnecting(false);
        return;
      }
      if (!r.url) {
        toast.error("Auth URL was empty — check QB Time credentials in Railway");
        setConnecting(false);
        return;
      }
      window.location.href = r.url;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start QB Time auth");
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    if (!confirm("Disconnect QuickBooks Time? Time-pull sync will stop until reconnected.")) return;
    try {
      await api.disconnectQBTime();
      toast.success("Disconnected");
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to disconnect");
    }
  };

  const userLabel = (() => {
    const u = status?.current_user;
    if (!u) return "";
    const name = `${u.first_name || ""} ${u.last_name || ""}`.trim();
    return name || u.email || "";
  })();

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm sm:text-base flex items-center gap-2">
          <Clock className="h-4 w-4" /> QuickBooks Time
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading || !status ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <>
            {status.needs_reconnect && (
              <div className="rounded-md border border-red-300 bg-red-50/60 p-3 flex items-start justify-between gap-2">
                <div className="flex items-start gap-2 min-w-0">
                  <AlertOctagon className="h-4 w-4 text-red-600 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-red-900">QuickBooks Time connection expired</p>
                    <p className="text-[12px] text-red-800/80 leading-snug">
                      {status.reconnect_reason || "The refresh token is no longer valid. Reconnect to resume time sync."}
                    </p>
                  </div>
                </div>
                <Button size="sm" variant="outline" onClick={connect} disabled={connecting}>
                  <RotateCcw className="h-3.5 w-3.5 mr-1" /> Reconnect
                </Button>
              </div>
            )}

            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className="text-[10px]">
                mode: {status.mode}
              </Badge>
              {status.mode === "mock" && (
                <Badge variant="outline" className="text-[10px] text-amber-700 border-amber-300">
                  test mode
                </Badge>
              )}
              {status.connected && (
                <Badge className="bg-emerald-100 text-emerald-800 text-[10px]">Connected</Badge>
              )}
              {!status.credentials_configured && status.mode === "live" && (
                <Badge variant="outline" className="text-[10px] text-amber-700 border-amber-300">
                  creds missing
                </Badge>
              )}
            </div>

            {status.connected ? (
              <div className="text-xs space-y-1">
                {userLabel && (
                  <div>
                    <span className="text-muted-foreground">Authorized as: </span>
                    <span className="font-medium">{userLabel}</span>
                  </div>
                )}
                {status.company_id && (
                  <div>
                    <span className="text-muted-foreground">Company ID: </span>
                    <span className="font-mono">{status.company_id}</span>
                  </div>
                )}
                {status.access_token_expires_at && (
                  <div>
                    <span className="text-muted-foreground">Access token valid until: </span>
                    <span>{new Date(status.access_token_expires_at).toLocaleDateString()}</span>
                  </div>
                )}
                <div className="flex gap-2 pt-2">
                  <Button size="sm" variant="outline" className="text-red-600" onClick={disconnect}>
                    <Unlink className="h-3.5 w-3.5 mr-1" /> Disconnect
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  {status.mode === "mock"
                    ? "Backend is in mock mode. To enable real time tracking: set QB_TIME_MODE=live + QB_TIME_CLIENT_ID/SECRET/REDIRECT_URI in Railway env, then click Connect."
                    : !status.credentials_configured
                    ? "Credentials missing. Set QB_TIME_CLIENT_ID, QB_TIME_CLIENT_SECRET, and QB_TIME_REDIRECT_URI in Railway env before connecting."
                    : "Not connected. Click Connect to authorize the dashboard against your QuickBooks Time account."}
                </p>
                <Button
                  size="sm"
                  onClick={connect}
                  disabled={connecting || (status.mode === "live" && !status.credentials_configured)}
                >
                  <Link2 className="h-3.5 w-3.5 mr-1" />
                  {connecting
                    ? "Redirecting…"
                    : status.mode === "mock"
                    ? "Connect (mock)"
                    : "Connect QuickBooks Time"}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
