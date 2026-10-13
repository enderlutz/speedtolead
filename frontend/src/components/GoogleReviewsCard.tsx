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
  const [paste, setPaste] = useState("");
  const [rating, setRating] = useState("");
  const [total, setTotal] = useState("");
  const [fiveStar, setFiveStar] = useState("");

  const load = () => {
    api.listReviews().then((d) => {
      setData(d);
      setRating(d.summary.rating == null ? "" : String(d.summary.rating));
      setTotal(d.summary.total ? String(d.summary.total) : "");
      setFiveStar(d.summary.five_star ? String(d.summary.five_star) : "");
    }).catch(() => setData(null));
  };
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
  const addPasted = async () => {
    if (!paste.trim()) return;
    setBusy(true);
    try {
      const r = await api.addManualReviews(paste);
      toast.success(`${r.added} new review${r.added === 1 ? "" : "s"} added${r.parsed > r.added ? `, ${r.parsed - r.added} already there` : ""}`);
      setPaste("");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't add those", { duration: 8000 });
    } finally {
      setBusy(false);
    }
  };
  const saveCounts = async () => {
    setBusy(true);
    try {
      await api.setReviewsSummary({
        rating: rating.trim() ? Number(rating) : null,
        total: total.trim() ? Number(total) : null,
        five_star: fiveStar.trim() ? Number(fiveStar) : null,
      });
      toast.success("Saved. The proposal shows these numbers up top.");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save");
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
        {/* Typed in from the listing (Alan, 2026-10-12) until Google's own
            feed is approved. The numbers up top are set by hand too. */}
        <div className="space-y-2 rounded-lg border p-3">
          <p className="text-sm font-semibold">Add reviews by hand</p>
          <p className="text-xs text-muted-foreground">One review per block, a blank line between. First line: name | stars | when Google says. Then the words.</p>
          <textarea
            value={paste} onChange={(e) => setPaste(e.target.value)} rows={7}
            placeholder={"Matt Shivers | 5 | 7 weeks ago\nAwesome crew to work with and very pleased with the result! Definitely recommend!\n\nMichael Parr | 5 | 7 weeks ago\nMy fence has never looked better!"}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs"
          />
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs">Rating<br /><input value={rating} onChange={(e) => setRating(e.target.value)} inputMode="decimal" placeholder="5.0" className="h-9 w-16 rounded-lg border border-border bg-background px-2 text-sm tabular-nums" /></label>
            <label className="text-xs">Reviews on Google<br /><input value={total} onChange={(e) => setTotal(e.target.value)} inputMode="numeric" placeholder="41" className="h-9 w-20 rounded-lg border border-border bg-background px-2 text-sm tabular-nums" /></label>
            <label className="text-xs">Five-star<br /><input value={fiveStar} onChange={(e) => setFiveStar(e.target.value)} inputMode="numeric" placeholder="40" className="h-9 w-20 rounded-lg border border-border bg-background px-2 text-sm tabular-nums" /></label>
            <Button size="sm" variant="outline" onClick={saveCounts} disabled={busy}>Save numbers</Button>
            <Button size="sm" onClick={addPasted} disabled={busy || !paste.trim()} className="ml-auto">Add these reviews</Button>
          </div>
        </div>
        {data && !data.configured ? (
          <p className="text-xs text-muted-foreground">
            Pull now needs a SERPAPI_KEY in Railway; Google's own feed comes once the Business Profile API request is approved. Until then, paste them above.
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
