// ProposalInteractiveCard: do new Sterling proposals go out as the
// interactive page (three packages, Reserve $250, financing, a 30-day
// price) or as the PDF? Admin only. Off, the per-lead switch on the
// Payment links panel still works and carries forward to that lead's next
// send. The brick division always gets the PDF (Alan, 2026-10-11).
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Sparkles, Loader2 } from "lucide-react";
import { api, getCurrentUser } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function ProposalInteractiveCard() {
  const isAdmin = getCurrentUser()?.role === "admin";
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    api.getProposalInteractiveDefault().then((r) => setOn(r.on)).catch(() => setOn(false));
  }, [isAdmin]);

  if (!isAdmin) return null;

  const flip = async () => {
    if (on === null) return;
    setBusy(true);
    try {
      const r = await api.setProposalInteractiveDefault(!on);
      setOn(r.on);
      toast.success(r.on ? "New Sterling proposals go out as the interactive page" : "New proposals go out as the PDF");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><Sparkles className="h-4 w-4 text-amber-600" /> Interactive proposal</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm text-muted-foreground">
          On, every new Sterling proposal is the interactive page: the three packages, Reserve $250, financing, a 30-day price.
          Off, proposals go out as the PDF and each lead can still be switched on its own from the Payment links panel. Brick always gets the PDF.
        </p>
        <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
          <input type="checkbox" checked={on === true} disabled={on === null || busy} onChange={flip} className="h-4 w-4 accent-amber-600" />
          {on === null ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : on ? "On for new Sterling proposals" : "Off, sending the PDF"}
        </label>
      </CardContent>
    </Card>
  );
}
