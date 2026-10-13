// GoogleReviewsCard: the Google reviews the proposal shows. Pull them now,
// see the counts, and hide one. Admin only. Needs SERPAPI_KEY in Railway;
// without it the card says so and the proposal keeps its sample cards.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Star, RefreshCw, Loader2, EyeOff, Eye } from "lucide-react";
import { api, getCurrentUser, type ReviewsAdmin } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function GoogleReviewsCard() {
  const isAdmin = getCurrentUser()?.role === "admin";
  const [data, setData] = useState<ReviewsAdmin | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const load = () => { api.listReviews().then(setData).catch(() => setData(null)); };
  useEffect(() => { if (isAdmin) load(); }, [isAdmin]);
  if (!isAdmin) return null;

  const refresh = async () => {
    setBusy(true);
    try {
      const s = await api.refreshReviews();
      toast.success(`Pulled the reviews: ${s.five_star} five-star of ${s.total}`);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't pull the reviews", { duration: 10000 });
    } finally {
      setBusy(false);
    }
  };
  const flip = async (id: string, hidden: boolean) => {
    try { await api.hideReview(id, hidden); load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't change that"); }
  };

  const rows = data?.reviews || [];
  const shown = showAll ? rows : rows.slice(0, 8);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base"><Star className="h-4 w-4 fill-current text-amber-500" /> Google reviews on the proposal</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {data && !data.configured ? (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
            No SERPAPI_KEY in Railway yet. Sign up at serpapi.com (the free plan covers a nightly pull), copy the API key, and have Fragne add it as SERPAPI_KEY. Until then the proposal shows sample cards.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {data?.summary ? (
            <span>
              <b>{data.summary.rating ?? "–"}</b> rating · <b>{data.summary.five_star}</b> five-star of <b>{data.summary.total}</b>
              {data.summary.fetched_at ? <span className="text-muted-foreground"> · pulled {new Date(data.summary.fetched_at).toLocaleString()}</span> : null}
            </span>
          ) : <span className="text-muted-foreground">Nothing pulled yet.</span>}
          <Button size="sm" variant="outline" onClick={refresh} disabled={busy || !data?.configured} className="ml-auto">
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />} Pull now
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">The proposal shows five-star reviews with words, newest first, and the five-star count. Anything under five stars stays off on its own. Hide one here to take it off the page.</p>
        {rows.length ? (
          <ul className="divide-y rounded-lg border">
            {shown.map((r) => (
              <li key={r.id} className={`flex items-start gap-3 px-3 py-2 text-sm ${r.hidden || r.rating < 5 ? "opacity-50" : ""}`}>
                <span className="w-10 shrink-0 font-bold tabular-nums">{r.rating}★</span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{r.author} <span className="font-normal text-muted-foreground">· {r.when}</span></p>
                  <p className="line-clamp-2 text-muted-foreground">{r.text || <i>no words, so not shown</i>}</p>
                </div>
                {r.rating >= 5 ? (
                  <button type="button" onClick={() => flip(r.id, !r.hidden)} title={r.hidden ? "Show on the proposal" : "Hide from the proposal"} className="rounded-md p-1 hover:bg-muted">
                    {r.hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                ) : <span className="text-xs text-muted-foreground">off</span>}
              </li>
            ))}
          </ul>
        ) : null}
        {rows.length > 8 ? (
          <button type="button" onClick={() => setShowAll((v) => !v)} className="text-xs font-semibold text-muted-foreground hover:text-foreground">
            {showAll ? "Show fewer" : `Show all ${rows.length}`}
          </button>
        ) : null}
      </CardContent>
    </Card>
  );
}
