import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, MessageSquare, Phone, PhoneIncoming, PhoneOutgoing, Send } from "lucide-react";
import { toast } from "sonner";
import { api, type CrewLineItem, type CrewLineRow } from "@/lib/api";

// The crew line (Alan, 2026-10-30): text and call the crew from the
// dashboard on its own number, every call recorded and transcribed, so what
// was said (a scope switched on a call) can be checked against the records.
// Phone first: the crew list, then one worker's thread.

function when(at: string) {
  if (!at) return "";
  const d = new Date(at);
  return d.toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function CrewLine() {
  const [data, setData] = useState<{ ready: boolean; missing: string[]; number: string; crew: CrewLineRow[] } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => { api.crewLine().then(setData).catch((e) => toast.error(String(e.message || e))); }, []);
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);

  if (open) return <Thread id={open} ready={!!data?.ready} onBack={() => { setOpen(null); load(); }} />;

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold"><Phone className="h-6 w-6" /> Crew line</h1>
        <p className="mt-1 text-[15px] text-muted-foreground">
          {data?.number ? `Texts and calls with the crew on ${data.number}. Every call is recorded and written out.` : "Texts and calls with the crew, recorded and written out."}
        </p>
      </div>
      {data && !data.ready ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-[15px] text-amber-900">
          <p className="font-bold">The number isn't connected yet.</p>
          <p className="mt-1">Still needed in Railway: {data.missing.join(", ")}.</p>
        </div>
      ) : null}
      <div className="divide-y rounded-xl border bg-white">
        {(data?.crew || []).map((c) => (
          <button key={c.id} type="button" onClick={() => setOpen(c.id)}
            className="flex min-h-[64px] w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#15130F] text-[15px] font-bold text-[#E3BE63]">
              {c.name.slice(0, 1)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-[16px] font-semibold">{c.name}</span>
                <span className="shrink-0 text-[13px] text-muted-foreground">{when(c.last_at)}</span>
              </span>
              <span className="block truncate text-[14px] text-muted-foreground">{c.last || (c.phone ? c.phone : "No cell yet · tap to add it")}</span>
            </span>
            {c.unread ? <span className="rounded-full bg-[#C9A24A] px-2 py-0.5 text-[13px] font-bold text-[#15130F]">{c.unread}</span> : null}
          </button>
        ))}
        {data && !data.crew.length ? <p className="p-4 text-[15px] text-muted-foreground">No active crew on the list.</p> : null}
      </div>
    </div>
  );
}

function Thread({ id, ready, onBack }: { id: string; ready: boolean; onBack: () => void }) {
  const [t, setT] = useState<{ employee: { id: string; name: string; phone: string }; items: CrewLineItem[] } | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [cell, setCell] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const load = useCallback(() => { api.crewThread(id).then(setT).catch((e) => toast.error(String(e.message || e))); }, [id]);
  useEffect(() => { load(); const i = setInterval(load, 10000); return () => clearInterval(i); }, [load]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [t?.items.length]);

  async function send() {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    try { await api.crewText(id, body); setDraft(""); load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Didn't send"); }
    finally { setBusy(false); }
  }
  async function savePhone() {
    try { await api.crewSetPhone(id, cell); setCell(""); toast.success("Saved"); load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Didn't save"); }
  }
  async function call() {
    try { const r = await api.crewCall(id); toast.success(r.message); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't call"); }
  }

  return (
    <div className="mx-auto flex h-[calc(100dvh-4rem)] max-w-2xl flex-col p-4">
      <div className="flex items-center gap-2 border-b pb-3">
        <button type="button" onClick={onBack} className="flex h-11 w-11 items-center justify-center rounded-lg hover:bg-muted" aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[18px] font-bold">{t?.employee.name || "…"}</p>
          <p className="text-[13px] text-muted-foreground">{t?.employee.phone}</p>
        </div>
        <button type="button" onClick={call} disabled={!ready}
          className="flex h-11 items-center gap-2 rounded-lg bg-[#15130F] px-4 text-[15px] font-bold text-[#E3BE63] disabled:opacity-40">
          <Phone className="h-4 w-4" /> Call
        </button>
      </div>
      {t && !t.employee.phone ? (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3">
          <input value={cell} onChange={(e) => setCell(e.target.value)} inputMode="tel" placeholder={`${t.employee.name.split(" ")[0]}'s cell number`}
            className="h-11 min-w-0 flex-1 rounded-lg border bg-white px-3 text-[16px]" />
          <button type="button" onClick={savePhone} disabled={!cell.trim()}
            className="h-11 rounded-lg bg-[#15130F] px-4 text-[15px] font-bold text-[#E3BE63] disabled:opacity-40">Save</button>
        </div>
      ) : null}
      <div className="flex-1 space-y-2 overflow-y-auto py-3">
        {(t?.items || []).map((it) => it.kind === "text" ? (
          <div key={it.id} className={it.direction === "outbound" ? "flex justify-end" : "flex justify-start"}>
            <div className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-[15px] ${it.direction === "outbound" ? "bg-[#15130F] text-[#F8F3E7]" : "bg-muted"}`}>
              <p className="whitespace-pre-wrap">{it.body}</p>
              {it.media.map((m) => <a key={m} href={m} target="_blank" rel="noreferrer" className="mt-1 block text-[13px] underline">Picture</a>)}
              <p className="mt-0.5 text-[12px] opacity-60">{when(it.at)}</p>
            </div>
          </div>
        ) : (
          <details key={it.id} className="rounded-xl border bg-white px-3.5 py-2.5">
            <summary className="flex cursor-pointer items-center gap-2 text-[15px] font-semibold">
              {it.direction === "outbound" ? <PhoneOutgoing className="h-4 w-4" /> : <PhoneIncoming className="h-4 w-4" />}
              {it.direction === "outbound" ? "You called" : "They called"} · {Math.floor(it.seconds / 60)}:{String(it.seconds % 60).padStart(2, "0")}
              <span className="ml-auto text-[12px] font-normal text-muted-foreground">{when(it.at)}</span>
            </summary>
            <p className="mt-2 whitespace-pre-wrap text-[14px] leading-relaxed text-muted-foreground">
              {it.transcript || (it.status === "failed" ? "The recording couldn't be saved." : "Writing it out…")}
            </p>
          </details>
        ))}
        {t && !t.items.length ? (
          <p className="flex items-center gap-2 p-4 text-[15px] text-muted-foreground"><MessageSquare className="h-4 w-4" /> Nothing yet.</p>
        ) : null}
        <div ref={end} />
      </div>
      <div className="flex items-end gap-2 border-t pt-3">
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} disabled={!ready}
          placeholder={ready ? `Text ${t?.employee.name?.split(" ")[0] || ""}` : "The number isn't connected yet"}
          className="min-h-[48px] flex-1 resize-none rounded-xl border px-3 py-2 text-[16px]" />
        <button type="button" onClick={send} disabled={!ready || busy || !draft.trim()}
          className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#C9A24A] text-[#15130F] disabled:opacity-40" aria-label="Send">
          <Send className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
