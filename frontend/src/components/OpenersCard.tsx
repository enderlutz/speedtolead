/**
 * Who loses people in the first seconds (Alan, 2026-10-31: "the customer
 * just hangs up maybe because they don't like the tone of voice that we
 * start off with"). Per caller, from the calls Gemini listened to: live
 * answers, how many hung up early, the rate, the average opener score, and
 * the worst openers to go play back.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronUp, PhoneOff } from "lucide-react";
import { api, type OpenerPerson } from "@/lib/api";

const DAYS = [7, 30, 90];

export default function OpenersCard() {
  const [days, setDays] = useState(30);
  const [people, setPeople] = useState<OpenerPerson[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.callOpeners(days).then((r) => { if (live) setPeople(r.people); }).catch(() => { if (live) setPeople([]); });
    return () => { live = false; };
  }, [days]);

  return (
    <div className="space-y-3 rounded-xl border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 font-semibold"><PhoneOff className="h-4 w-4 text-primary" />The opening: who hangs up early</p>
        <div className="flex gap-1">
          {DAYS.map((d) => (
            <button key={d} type="button" onClick={() => setDays(d)}
                    className={`min-h-9 rounded-full px-3 text-sm font-medium ${d === days ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
              {d} days
            </button>
          ))}
        </div>
      </div>
      <p className="text-sm text-muted-foreground">Calls where a real person picked up. "Hung up early" means they ended it in the first 30 seconds without agreeing to anything.</p>
      {people === null ? <p className="text-sm text-muted-foreground">Loading…</p>
        : people.length === 0 ? <p className="text-sm text-muted-foreground">No calls listened to yet in these {days} days.</p> : (
        <div className="space-y-2">
          {people.map((p) => (
            <div key={p.name} className="rounded-lg border bg-background">
              <button type="button" onClick={() => setOpen(open === p.name ? null : p.name)}
                      className="flex min-h-12 w-full flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-left">
                <span className="min-w-24 font-semibold">{p.name}</span>
                <span className="text-sm">{p.live} picked up</span>
                <span className={`text-sm font-semibold ${p.early_rate >= 30 ? "text-red-700" : p.early_rate >= 15 ? "text-amber-700" : "text-emerald-700"}`}>
                  {p.hung_up_early} hung up early ({p.early_rate}%)
                </span>
                {p.avg_opener != null ? <span className="text-sm">Opening {p.avg_opener}/10</span> : null}
                <span className="ml-auto">{open === p.name ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</span>
              </button>
              {open === p.name ? (
                <ul className="space-y-2 border-t px-3 py-2">
                  {p.worst.map((c) => (
                    <li key={c.recording_id} className="text-sm">
                      <span className={c.ended_early ? "font-semibold text-red-700" : "font-semibold"}>
                        {c.ended_early ? "Hung up early" : c.ending || "Call"}
                      </span>
                      {c.score != null ? <> · opening {c.score}/10</> : null}
                      {c.sounded_like ? <> · {c.sounded_like}</> : null} · {c.seconds}s
                      {c.lead_id ? <> · <Link to={`/leads/${c.lead_id}`} className="text-primary underline">lead</Link></> : null}
                      {c.first_words ? <p className="text-muted-foreground">"{c.first_words}"</p> : null}
                      {c.tip ? <p>Tip: {c.tip}</p> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
