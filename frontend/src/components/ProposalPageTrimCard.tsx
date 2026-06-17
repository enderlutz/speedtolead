// ProposalPageTrimCard — admin control for hiding the last N pages of
// every proposal PDF from the customer. Per user (2026-06-17): the
// template ends with terms / portfolio / warranty pages they don't
// want shown in the customer-facing rasterized output.
//
// Applies to: preview-modal, customer-facing rasterized JPEG pages,
// download-PDF, and the regenerate-PDF paths. Template upload + canvas
// editor are unaffected (admin still sees every page when positioning
// fields).

import { useEffect, useState } from "react";
import { api, getCurrentUser } from "@/lib/api";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Scissors, Loader2, Save } from "lucide-react";

export default function ProposalPageTrimCard() {
  const isAdmin = getCurrentUser()?.role === "admin";
  const [count, setCount] = useState<string>("3");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    api
      .getProposalPagesToDrop()
      .then((r) => setCount(String(r.pages_to_drop)))
      .catch(() => toast.error("Failed to load page-trim setting"))
      .finally(() => setLoading(false));
  }, [isAdmin]);

  if (!isAdmin) return null;

  const handleSave = async () => {
    const parsed = parseInt(count, 10);
    if (Number.isNaN(parsed) || parsed < 0 || parsed > 50) {
      toast.error("Pages to drop must be a whole number between 0 and 50");
      return;
    }
    setSaving(true);
    try {
      const r = await api.setProposalPagesToDrop(parsed);
      setCount(String(r.pages_to_drop));
      toast.success(
        parsed === 0
          ? "Page trim disabled — proposals will show every template page"
          : `Last ${parsed} page${parsed === 1 ? "" : "s"} of every proposal will be hidden from customers`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm sm:text-base flex items-center gap-2">
          <Scissors className="h-4 w-4 text-slate-600" />
          Proposal PDF: trim last pages
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Hides the last N pages of every proposal PDF before the customer
          sees it. Useful for cutting off terms / portfolio / warranty
          pages without editing the template. Set to 0 to show everything.
          Template upload + canvas editor still see every page.
        </p>
        {loading ? (
          <div className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="flex items-center gap-2 max-w-sm">
            <Input
              type="number"
              value={count}
              onChange={(e) => setCount(e.target.value)}
              min={0}
              max={50}
              step={1}
              className="w-24"
            />
            <span className="text-sm text-muted-foreground">
              last pages hidden
            </span>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving}
              className="ml-2"
            >
              {saving ? (
                <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
              ) : (
                <Save className="h-3 w-3 mr-1.5" />
              )}
              Save
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
