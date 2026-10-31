import { useCallback, useEffect, useState } from "react";
import { Copy, FileAudio, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

// Alan's Plaud recordings (2026-10-31): they arrive through Zapier, and
// every night after 9 PM Claude reads the day's and writes the brief. The
// address Zapier posts to is shown only here, with a copy button.

type Data = Awaited<ReturnType<typeof api.plaud>>;

const day = (iso: string) => (iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");

export default function PlaudRecordings() {
  const [d, setD] = useState<Data | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { api.plaud().then(setD).catch((e) => toast.error(String(e.message || e))); }, []);
  useEffect(load, [load]);

  async function briefNow() {
    setBusy(true);
    try { const r = await api.plaudBriefNow(); toast[r.ok ? "success" : "message"](r.message); load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Didn't work"); }
    finally { setBusy(false); }
  }

  if (!d) return <p className="text-[15px] text-muted-foreground">Loading…</p>;
  const setup = (
    <div className="space-y-3 rounded-xl border bg-white p-4 text-[15px]">
      <p className="font-bold">Connect your Plaud (one time, in Zapier)</p>
      <ol className="list-decimal space-y-1.5 pl-5">
        <li>Zapier → <b>Create → Zap</b>.</li>
        <li><b>Trigger:</b> Plaud → <b>Transcript &amp; Summary Ready</b>. Sign in to Plaud. Set a minimum length of 1 minute.</li>
        <li><b>Action:</b> Webhooks by Zapier → <b>POST</b>.</li>
        <li><b>URL:</b> paste the address below. <b>Payload type:</b> json.</li>
        <li><b>Data:</b> add <code>title</code>, <code>transcript</code>, <code>summary</code>, <code>id</code> and <code>start_time</code>, each set to the Plaud field with that name.</li>
        <li>Test it, then <b>Publish</b>. The test recording shows up below.</li>
      </ol>
      <div className="flex items-center gap-2">
        <input readOnly value={d.address} className="h-11 min-w-0 flex-1 rounded-lg border bg-muted/40 px-3 font-mono text-[13px]" onFocus={(e) => e.target.select()} />
        <button type="button" onClick={() => navigator.clipboard.writeText(d.address).then(() => toast.success("Copied"))}
          className="flex h-11 items-center gap-1.5 rounded-lg bg-[#15130F] px-4 text-[15px] font-bold text-[#E3BE63]">
          <Copy className="h-4 w-4" /> Copy
        </button>
      </div>
      <p className="text-[13px] text-muted-foreground">Keep this address private: anyone with it can add recordings. Card, bank and SSN numbers are blanked out before anything is saved.</p>
    </div>
  );

  return (
    <div className="space-y-4">
      {d.notes.length ? <details className="rounded-xl border bg-white px-4 py-3"><summary className="cursor-pointer text-[15px] font-semibold">Zapier setup and your address</summary><div className="mt-3">{setup}</div></details> : setup}

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Nightly briefs</h2>
        <button type="button" onClick={briefNow} disabled={busy}
          className="flex h-11 items-center gap-1.5 rounded-lg border px-3 text-[14px] font-bold disabled:opacity-40">
          <Sparkles className="h-4 w-4" /> Write tonight's now
        </button>
      </div>
      {d.briefs.length ? d.briefs.map((b) => (
        <details key={b.day} className="rounded-xl border bg-white px-4 py-3" open={b === d.briefs[0]}>
          <summary className="cursor-pointer text-[15px] font-semibold">{new Date(b.day + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}</summary>
          <p className="mt-2 whitespace-pre-wrap text-[15px] leading-relaxed">{b.body}</p>
        </details>
      )) : <p className="text-[15px] text-muted-foreground">The first brief comes the night after your first recording arrives (after 9 PM).</p>}

      <h2 className="text-lg font-bold">Recordings</h2>
      {d.notes.length ? d.notes.map((n) => (
        <details key={n.id} className="rounded-xl border bg-white px-4 py-3">
          <summary className="flex cursor-pointer items-center gap-2 text-[15px] font-semibold">
            <FileAudio className="h-4 w-4 shrink-0" /> <span className="min-w-0 flex-1 truncate">{n.title}</span>
            <span className="shrink-0 text-[13px] font-normal text-muted-foreground">{day(n.at)}</span>
          </summary>
          {n.summary ? <p className="mt-2 whitespace-pre-wrap text-[15px]">{n.summary}</p> : null}
          <details className="mt-2"><summary className="cursor-pointer text-[14px] text-muted-foreground">Full transcript</summary>
            <p className="mt-1 whitespace-pre-wrap text-[14px] leading-relaxed text-muted-foreground">{n.transcript}</p></details>
        </details>
      )) : <p className="text-[15px] text-muted-foreground">Nothing yet.</p>}
    </div>
  );
}
