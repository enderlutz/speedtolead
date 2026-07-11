// PromotionSettingsCard — admin control for the "summer special" slashed
// price feature on proposal PDFs.
//
// Per user (2026-06-16): A&T advertises a 20%-off summer special but the
// proposal only shows the already-discounted price. This card lets an
// admin set a markup percentage that gets rendered as a slashed,
// strikethrough "original" price above each tier on the PDF.
//
// Math: our tier prices are ALREADY the discounted price, so we reverse the
// discount to show the true "was" price: slashed = actual ÷ (1 − discount/100).
// e.g. $1,000 at 20% → was $1,250, "You save $250". Set to 0 to disable.

import { useEffect, useState } from "react";
import { api, getCurrentUser } from "@/lib/api";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tag, Loader2, Save } from "lucide-react";

export default function PromotionSettingsCard() {
  const isAdmin = getCurrentUser()?.role === "admin";
  const [markup, setMarkup] = useState<string>("20");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    api
      .getPromotionMarkup()
      .then((r) => setMarkup(String(r.markup_percent)))
      .catch(() => toast.error("Failed to load promotion settings"))
      .finally(() => setLoading(false));
  }, [isAdmin]);

  if (!isAdmin) return null;

  const handleSave = async () => {
    const parsed = parseFloat(markup);
    if (Number.isNaN(parsed) || parsed < 0 || parsed > 200) {
      toast.error("Markup must be a number between 0 and 200");
      return;
    }
    setSaving(true);
    try {
      const r = await api.setPromotionMarkup(parsed);
      setMarkup(String(r.markup_percent));
      toast.success(
        parsed === 0
          ? "Promotion disabled — proposals will not show slashed prices"
          : `Promotion saved — proposals will show prices ${parsed}% higher with a strikethrough`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  // Preview the math so the admin sees what the customer will see.
  const previewMarkup = (() => {
    const parsed = parseFloat(markup);
    if (Number.isNaN(parsed) || parsed <= 0) return null;
    const sample = 1500;
    const marked = sample * (1 + parsed / 100);
    return { sample, marked };
  })();

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm sm:text-base flex items-center gap-2">
          <Tag className="h-4 w-4 text-rose-600" />
          Promotion: slashed proposal pricing
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Adds a strikethrough "original" price above each tier on the
          proposal PDF so the customer sees the discount they're getting.
          Our prices are already discounted, so this is the % <em>off</em> —
          the "was" price = actual ÷ (1 − %). e.g. $1,000 at 20% → was $1,250,
          "You save $250". Set to 0 to disable.
        </p>
        {loading ? (
          <div className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 max-w-sm">
              <Input
                type="number"
                value={markup}
                onChange={(e) => setMarkup(e.target.value)}
                min={0}
                max={99}
                step={1}
                className="w-24"
              />
              <span className="text-sm text-muted-foreground">% off</span>
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
            {previewMarkup && (
              <p className="text-xs text-muted-foreground">
                Example: a ${previewMarkup.sample.toLocaleString()} tier price
                would show as{" "}
                <span className="line-through text-rose-600 font-semibold">
                  ${previewMarkup.marked.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>{" "}
                crossed out above ${previewMarkup.sample.toLocaleString()}.
              </p>
            )}
            {previewMarkup === null && (
              <p className="text-xs text-amber-700">
                Promotion is disabled — proposals will not show slashed prices.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
