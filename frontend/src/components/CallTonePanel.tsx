/**
 * How a call sounded (Alan, 2026-10-25), under the transcript in Call Coach.
 * Top: the free numbers from the transcript timings (who talked more, the
 * pause after the price, cut-ins, short answers). Below: what Gemini heard
 * when it listened to the recording, and when to follow up. Plain words.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Ear, Loader2 } from "lucide-react";
import { api, type CallTone } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { errMessage } from "@/lib/utils";

const MOOD: Record<string, string> = {
  excited: "🤩 Excited", interested: "🙂 Interested", unsure: "🤔 Unsure",
  flat: "😐 Flat", annoyed: "😠 Annoyed", rushed: "⏱️ Rushed",
};

function Stat({ label, value, hint, warn }: { label: string; value: string; hint: string; warn?: boolean }) {
  return (
    <div className={`rounded-lg border p-2.5 ${warn ? "border-amber-300 bg-amber-50" : "bg-background"}`}>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-sm text-muted-foreground">{hint}</p>
    </div>
  );
}

function when(days?: number): string {
  if (days == null) return "";
  if (days <= 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
}

export default function CallTonePanel({ recordingId, isAdmin }: { recordingId: string; isAdmin: boolean }) {
  const [t, setT] = useState<CallTone | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api.getCallTone(recordingId).then((r) => { if (live) setT(r); }).catch(() => {});
    return () => { live = false; };
  }, [recordingId]);
  if (!t) return null;

  const listen = async () => {
    setBusy(true);
    try { setT(await api.listenToCall(recordingId)); }
    catch (e) { toast.error(errMessage(e, "Couldn't listen to this call")); }
    finally { setBusy(false); }
  };

  const n = t.numbers;
  const h = t.listen;
  const pause = n.price_pauses?.[0];
  return (
    <div className="space-y-3 rounded-xl border bg-card p-3">
      <p className="flex items-center gap-1.5 font-semibold"><Ear className="h-4 w-4 text-primary" />How it sounded</p>

      {n.ok ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Customer talked" value={`${n.customer_share}%`} warn={(n.customer_share ?? 0) < 30}
                hint={(n.customer_share ?? 0) < 30 ? "Low. Ask more, talk less." : "Good. They were part of it."} />
          <Stat label="Quiet after the price" value={pause ? `${pause.pause}s` : "—"} warn={!!pause && pause.pause >= 3}
                hint={!pause ? "No price heard." : pause.pause >= 3 ? "Long pause. Price may have surprised them." : "Quick answer."} />
          <Stat label="Short answers" value={`${n.short_answers_pct}%`} warn={(n.short_answers_pct ?? 0) >= 60}
                hint={(n.short_answers_pct ?? 0) >= 60 ? "Mostly \"yeah\" / \"ok\". Not opening up." : "They gave real answers."} />
          <Stat label="We cut them off" value={`${n.team_interrupted}×`} warn={(n.team_interrupted ?? 0) >= 3}
                hint={(n.team_interrupted ?? 0) >= 3 ? "Let them finish." : "Fine."} />
        </div>
      ) : <p className="text-sm text-muted-foreground">{n.why}</p>}

      {h && !h.skip ? (
        <div className="space-y-3 border-t pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-muted px-3 py-1 text-base font-semibold">{MOOD[h.customer_mood || ""] || h.customer_mood}</span>
            {h.buying_temperature != null ? <span className="text-sm">Ready to buy: <b>{h.buying_temperature}/10</b></span> : null}
            {h.team_score != null ? <span className="text-sm">Our call: <b>{h.team_score}/10</b></span> : null}
          </div>
          {h.customer_mood_why ? <p className="text-sm">{h.customer_mood_why}</p> : null}

          {h.follow_up ? (
            <div className="rounded-lg border-l-4 border-l-emerald-500 bg-emerald-50 p-2.5">
              <p className="text-sm font-semibold">Next: {when(h.follow_up.when_days)} · {h.follow_up.how === "text" ? "Text" : h.follow_up.how === "either" ? "Call or text" : "Call"}</p>
              {h.follow_up.say ? <p className="text-sm">Say: "{h.follow_up.say}"</p> : null}
              {h.follow_up.why ? <p className="text-sm text-muted-foreground">{h.follow_up.why}</p> : null}
            </div>
          ) : null}

          {h.moments?.length ? (
            <div>
              <p className="text-sm font-semibold">Moments that mattered</p>
              <ul className="mt-1 space-y-1.5">
                {h.moments.map((m, i) => (
                  <li key={i} className="text-sm">
                    <span className="font-mono text-muted-foreground">{m.at}</span>{" "}
                    <b>{m.who === "customer" ? "Customer" : "Us"}</b> sounded <b>{m.feeling}</b>: "{m.quote}"
                    {m.why_it_matters ? <span className="text-muted-foreground"> {m.why_it_matters}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {h.team_tone ? (
            <div>
              <p className="text-sm font-semibold">How we sounded</p>
              <p className="text-sm">Warm {h.team_tone.warmth}/10 · Sure of ourselves {h.team_tone.confidence}/10 · Listening {h.team_tone.listening}/10 · Pace: {h.team_tone.pace}</p>
              {h.team_tone.note ? <p className="text-sm text-muted-foreground">{h.team_tone.note}</p> : null}
            </div>
          ) : null}
          {h.do_better?.length ? (
            <div>
              <p className="text-sm font-semibold">Do better next time</p>
              <ul className="ml-5 list-disc text-sm">{h.do_better.map((d, i) => <li key={i}>{d}</li>)}</ul>
            </div>
          ) : null}
        </div>
      ) : h?.skip ? <p className="border-t pt-3 text-sm text-muted-foreground">Not a sales conversation: {h.why}</p> : null}

      {t.error && !h ? <p className="text-sm text-red-700">Last listen failed: {t.error}</p> : null}
      {isAdmin && t.can_listen ? (
        <Button size="sm" variant={h ? "outline" : "default"} disabled={busy} onClick={() => void listen()} className="min-h-10">
          {busy ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />Listening… (up to a minute)</> : h ? "Listen again" : "Listen to this call"}
        </Button>
      ) : null}
    </div>
  );
}
