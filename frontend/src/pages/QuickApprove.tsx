import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type QuickApproveInfo } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, MapPin, AlertTriangle, Ruler, Globe } from "lucide-react";

export default function QuickApprove() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<QuickApproveInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [expired, setExpired] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState(false);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    api
      .getQuickApproveInfo(token)
      .then((data) => {
        setInfo(data);
        if (data.approval_status === "approved") {
          setApproved(true);
        }
      })
      .catch(() => setExpired(true))
      .finally(() => setLoading(false));
  }, [token]);

  const handleApprove = async () => {
    if (!token) return;
    setApproving(true);
    try {
      await api.quickApprove(token);
      setApproved(true);
      toast.success("Estimate approved and sent!");
    } catch {
      toast.error("Failed to approve. Please try again.");
    } finally {
      setApproving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-pulse space-y-4 w-full max-w-sm px-4">
          <div className="h-8 w-48 bg-muted rounded" />
          <div className="h-48 bg-muted rounded" />
          <div className="h-12 bg-muted rounded" />
        </div>
      </div>
    );
  }

  if (expired) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="text-center">
          <AlertTriangle className="h-12 w-12 text-yellow-500 mx-auto mb-4" />
          <h1 className="text-xl font-semibold mb-2">Link Expired</h1>
          <p className="text-muted-foreground text-sm">
            This approval link has expired or has already been used.
          </p>
        </div>
      </div>
    );
  }

  if (approved) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="text-center">
          <CheckCircle2 className="h-16 w-16 text-green-500 mx-auto mb-4" />
          <h1 className="text-xl font-semibold mb-2">Approved!</h1>
          <p className="text-muted-foreground text-sm">
            The estimate for{" "}
            <span className="font-medium text-foreground">
              {info?.contact_name}
            </span>{" "}
            has been approved and sent to the customer.
          </p>
        </div>
      </div>
    );
  }

  if (!info) return null;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-sm mx-auto px-4 py-6">
        {/* Header */}
        <div className="text-center mb-6">
          <h1 className="text-xl font-bold tracking-tight">Quick Approve</h1>
          <p className="text-muted-foreground text-xs mt-1">
            Review & approve this estimate
          </p>
        </div>

        {/* Estimate summary */}
        <Card className="mb-4">
          <CardContent className="pt-5 space-y-3">
            <div>
              <h2 className="text-lg font-semibold">{info.contact_name}</h2>
              <div className="flex items-center gap-1.5 text-sm text-muted-foreground mt-1">
                <MapPin className="h-3.5 w-3.5 shrink-0" />
                <span>{info.address}</span>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{info.location_label}</Badge>
              <Badge variant="outline" className="flex items-center gap-1">
                <Globe className="h-3 w-3" />
                Zone {info.zone}
              </Badge>
              <Badge variant="outline" className="flex items-center gap-1">
                <Ruler className="h-3 w-3" />
                {info.sqft.toLocaleString()} sqft
              </Badge>
            </div>
          </CardContent>
        </Card>

        {/* Approval reason */}
        {info.approval_reason && (
          <Card className="mb-4 border-red-200 bg-red-50">
            <CardContent className="pt-4 pb-4">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs font-semibold text-red-800 mb-0.5">
                    Review Required
                  </p>
                  <p className="text-xs text-red-700">{info.approval_reason}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Tier prices */}
        <Card className="mb-6">
          <CardContent className="pt-5 space-y-2.5">
            {(["essential", "signature", "legacy"] as const).map((tier) => {
              const price = info.tiers[tier] || 0;
              const monthly = Math.round(price / 21);
              return (
                <div
                  key={tier}
                  className={`flex items-center justify-between p-3 rounded-lg border ${
                    tier === "signature"
                      ? "bg-primary/5 border-primary/20"
                      : "bg-muted/30"
                  }`}
                >
                  <div>
                    <span className="text-sm font-medium capitalize">{tier}</span>
                    {tier === "signature" && (
                      <span className="ml-1.5 text-[10px] text-primary font-medium">
                        Rec.
                      </span>
                    )}
                  </div>
                  <div className="text-right">
                    <span className="text-sm font-bold">
                      {formatCurrency(price)}
                    </span>
                    <span className="text-[10px] text-muted-foreground ml-1">
                      ~${monthly}/mo
                    </span>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        {/* Approve button */}
        <Button
          onClick={handleApprove}
          disabled={approving}
          size="lg"
          className="w-full h-14 text-lg bg-green-600 hover:bg-green-700 text-white"
        >
          {approving ? (
            <>
              <CheckCircle2 className="h-5 w-5 mr-2 animate-spin" />
              Approving...
            </>
          ) : (
            <>
              <CheckCircle2 className="h-5 w-5 mr-2" />
              Approve & Send
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
