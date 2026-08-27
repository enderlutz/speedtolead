import { useState } from "react";
import { api, type CallPrep } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";
import {
  Sparkles, Loader2, Copy, Check, AlertTriangle, RotateCw,
  MessageSquare, Phone, HelpCircle,
} from "lucide-react";

// Pre-call brief. Hit the button, read for fifteen seconds, dial.
//
// Two sections, because that's the job: what to say on the call, and three
// texts to fall back on when they don't pick up. Each text takes a different
// angle at why this particular customer went quiet, so the rep picks rather
// than edits.
//
// Regenerated every time on purpose — it has to reflect the text that came in
// ten minutes ago, and a stale brief is worse than none.

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success("Copied — paste it into your texts");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy. Select the text and copy it manually.");
    }
  };
  return (
    <Button
      size="sm"
      variant={copied ? "default" : "outline"}
      className="h-7 shrink-0"
      onClick={copy}
    >
      {copied
        ? <><Check className="h-3.5 w-3.5 mr-1" /> Copied</>
        : <><Copy className="h-3.5 w-3.5 mr-1" /> Copy</>}
    </Button>
  );
}

export default function CallPrepCard({ leadId, leadName }: { leadId: string; leadName?: string }) {
  const [prep, setPrep] = useState<CallPrep | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    try {
      setPrep(await api.generateCallPrep(leadId));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't build the brief");
    } finally {
      setLoading(false);
    }
  };

  const ev = prep?.evidence;

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" /> Before you call
            </h3>
            <p className="text-xs text-muted-foreground">
              Reads every text, call and price we've sent {leadName || "this customer"}.
            </p>
          </div>
          <Button size="sm" onClick={run} disabled={loading}>
            {loading
              ? <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Reading history…</>
              : prep
                ? <><RotateCw className="h-3.5 w-3.5 mr-1" /> Regenerate</>
                : <><Sparkles className="h-3.5 w-3.5 mr-1" /> Prep this call</>}
          </Button>
        </div>

        {!prep && !loading && (
          <p className="text-xs text-muted-foreground">
            Hit the button and you'll get what to talk about, plus three texts to send if they don't pick up.
          </p>
        )}

        {prep && (
          <div className="space-y-5">
            {/* What we're working from — so a thin brief looks thin. */}
            {ev && (
              <div className="flex items-center gap-3 flex-wrap text-[11px] text-muted-foreground border-b pb-2">
                <span>{ev.texts} text{ev.texts === 1 ? "" : "s"}</span>
                <span>·</span>
                <span>
                  {ev.calls_transcribed} of {ev.calls_recorded} call{ev.calls_recorded === 1 ? "" : "s"} readable
                </span>
                <span>·</span>
                <span>{ev.estimates} estimate{ev.estimates === 1 ? "" : "s"}</span>
                {ev.days_since_contact !== null && (
                  <><span>·</span><span>last contact {ev.days_since_contact}d ago</span></>
                )}
              </div>
            )}

            {ev?.thin && (
              <div className="flex gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2.5 text-xs">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-600" />
                <span>We have almost nothing on this customer, so this brief is mostly guesswork. Treat it as a cold call.</span>
              </div>
            )}

            {prep.headline && (
              <p className="text-sm font-medium leading-snug">{prep.headline}</p>
            )}

            {/* ── Section 1: the call ── */}
            <section className="space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                <Phone className="h-3.5 w-3.5" /> What to talk about on the call
              </h4>

              {prep.where_it_stands && (
                <p className="text-sm text-muted-foreground leading-relaxed">{prep.where_it_stands}</p>
              )}

              {prep.watch_out && (
                <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-destructive" />
                  <span><span className="font-medium">Watch out: </span>{prep.watch_out}</span>
                </div>
              )}

              {prep.talking_points.length > 0 && (
                <ul className="space-y-2">
                  {prep.talking_points.map((p, i) => (
                    <li key={i} className="flex gap-2.5 text-sm">
                      <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                      <span>
                        <span className="font-medium">{p.point}</span>
                        {p.detail && <span className="text-muted-foreground"> — {p.detail}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {prep.questions_to_ask.length > 0 && (
                <div className="space-y-1.5 pt-1">
                  <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                    <HelpCircle className="h-3.5 w-3.5" /> Ask them
                  </p>
                  <ul className="space-y-1">
                    {prep.questions_to_ask.map((q, i) => (
                      <li key={i} className="text-sm pl-5 relative">
                        <span className="absolute left-0 text-muted-foreground">›</span>{q}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>

            {/* ── Section 2: the texts ── */}
            {prep.messages.length > 0 && (
              <section className="space-y-3">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                  <MessageSquare className="h-3.5 w-3.5" /> If they don't pick up — copy and send
                </h4>
                <div className="space-y-2.5">
                  {prep.messages.map((m, i) => (
                    <div key={i} className="rounded-md border bg-muted/30 p-3 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold">{m.angle}</p>
                          {m.rationale && (
                            <p className="text-[11px] text-muted-foreground">{m.rationale}</p>
                          )}
                        </div>
                        <CopyButton text={m.text} />
                      </div>
                      <p className="text-sm bg-background rounded border p-2.5 leading-relaxed">
                        {m.text}
                      </p>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
