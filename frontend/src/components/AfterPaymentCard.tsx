// What the customer did on the thank-you screens after paying (Alan,
// 2026-10-14: "did they go through it? did they leave feedback? did they
// click the Google review?"). One row per paid link: whether they opened the
// screens, how far they got, and every answer, in plain words.
import { useEffect, useState } from "react";
import { HeartHandshake, Check, X, Star, ExternalLink } from "lucide-react";
import { api, type PayLinkEntry } from "@/lib/api";
import { Panel } from "@/components/Panel";
import { ACCENT } from "@/lib/accents";
import { cn } from "@/lib/utils";

function when(iso?: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
}

function Yes({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full", on ? "bg-emerald-600 text-white" : "bg-stone-200 text-stone-500")}>
        {on ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
      </span>
      <span className={on ? "font-medium" : "text-muted-foreground"}>{children}</span>
    </li>
  );
}

function Answers({ l }: { l: PayLinkEntry }) {
  const a = (l.answers || {}) as Record<string, unknown>;
  const score = typeof a.score === "number" ? a.score : null;
  const comment = typeof a.comment === "string" && a.comment.trim() ? a.comment.trim() : "";
  const shared = Array.isArray(a.referral_shared) ? (a.referral_shared as string[]) : [];
  const services = Array.isArray(a.services_interested) ? (a.services_interested as string[]) : [];
  const skipped = Array.isArray(a.skipped_screens) ? (a.skipped_screens as string[]) : [];
  const jobDone = !["deposit", "full"].includes(l.kind);
  const opened = (l.after_view_count || 0) > 0;
  const far = l.after_furthest;
  return (
    <div className="rounded-xl border border-border bg-background p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-semibold">{l.label} <span className="font-normal text-muted-foreground">· paid {when(l.paid_at)}</span></p>
        <a href={`${l.after_url}?preview=1`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 hover:underline">
          See their screens <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      <p className={cn("mt-1 text-xs", opened ? "text-foreground" : "text-amber-700")}>
        {opened
          ? <>Opened the thank-you screens {l.after_view_count}× · first {when(l.after_first_viewed_at)}{far ? <> · got to <b>{far.step} of {far.of}</b>{far.screen ? ` (${far.screen})` : ""}</> : null}</>
          : "Hasn't opened the thank-you screens (or opened them before we started tracking on Oct 14)."}
      </p>
      <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
        {jobDone ? (
          <>
            <li className="flex items-center gap-2">
              <span className={cn("flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 text-[11px] font-bold", score === null ? "bg-stone-200 text-stone-500" : score >= 9 ? "bg-emerald-600 text-white" : score >= 7 ? "bg-amber-500 text-white" : "bg-rose-600 text-white")}>
                {score === null ? <Star className="h-3 w-3" /> : score}
              </span>
              <span className={score === null ? "text-muted-foreground" : "font-medium"}>{score === null ? "No score yet" : `Scored us ${score}/10`}</span>
            </li>
            <Yes on={a.review_clicked === true}>Tapped Google review</Yes>
            <Yes on={shared.length > 0}>Shared the referral{shared.length ? ` (${shared.join(", ")})` : ""}</Yes>
            <Yes on={a.callback_requested === true}>Asked for a call from you</Yes>
            <Yes on={services.length > 0}>Wants other services{services.length ? `: ${services.join(", ")}` : ""}</Yes>
            <Yes on={a.feature_permission === true}>OK to feature their comment</Yes>
          </>
        ) : (
          <>
            <Yes on={a.prep_acknowledged === true}>Read the before-we-come list</Yes>
            <Yes on={shared.length > 0}>Shared with friends or neighbors{shared.length ? ` (${shared.join(", ")})` : ""}</Yes>
          </>
        )}
        <Yes on={a.finished === true}>Went all the way to the end</Yes>
      </ul>
      {comment ? <blockquote className="mt-2 rounded-lg border-l-4 border-emerald-500 bg-emerald-50 px-3 py-2 text-sm italic dark:bg-emerald-950/30">"{comment}"</blockquote> : null}
      {skipped.length ? <p className="mt-1.5 text-xs text-muted-foreground">Skipped: {skipped.join(", ")}</p> : null}
    </div>
  );
}

export function AfterPaymentCard({ leadId }: { leadId: string }) {
  const [paid, setPaid] = useState<PayLinkEntry[] | null>(null);
  useEffect(() => {
    api.listPayLinks(leadId)
      .then((d) => setPaid(d.links.filter((l) => l.status === "paid" && (l.kind !== "done" || l.after_view_count || Object.keys(l.answers || {}).length))))
      .catch(() => setPaid(null));
  }, [leadId]);
  if (!paid || paid.length === 0) return null;
  return (
    <Panel icon={HeartHandshake} title="After payment" sub="What they did on the thank-you screens: score, comment, Google review, referral" accent={ACCENT.emerald} bodyClassName="space-y-2 p-3.5">
      {paid.map((l) => <Answers key={l.token} l={l} />)}
    </Panel>
  );
}
