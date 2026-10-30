// Alan's ideas playbook (2026-10-30): "ideas for different things in the
// business… underneath those, things I need to accomplish… log my progress…
// I like to work on a few different ideas a day." Everything he's talked
// about doing and hasn't done lives here as a task: under its area of the
// business, with a time frame, a stage and a dated log. Documents → Ideas.
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, Loader2, Plus, Trash2 } from "lucide-react";
import { api, type IdeaPick, type IdeaRow } from "@/lib/api";
import { cn } from "@/lib/utils";

const STAGE_TONE: Record<string, string> = {
  idea: "bg-muted text-foreground", working: "bg-amber-100 text-amber-900", testing: "bg-sky-100 text-sky-900",
  done: "bg-emerald-100 text-emerald-800", parked: "bg-stone-200 text-stone-600",
};
const day = (iso: string) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");
const sel = "h-10 rounded-lg border border-input bg-background px-2 text-sm";

export function IdeasPlaybook() {
  const [ideas, setIdeas] = useState<IdeaRow[] | null>(null);
  const [areas, setAreas] = useState<IdeaPick[]>([]);
  const [stages, setStages] = useState<IdeaPick[]>([]);
  const [frames, setFrames] = useState<IdeaPick[]>([]);
  const [by, setBy] = useState<"area" | "when">("area");
  const [show, setShow] = useState<"active" | "done" | "parked">("active");
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState({ title: "", area: "operations", timeframe: "month" });

  const load = useCallback(async () => {
    try {
      const r = await api.listIdeas();
      setIdeas(r.ideas); setAreas(r.areas); setStages(r.stages); setFrames(r.timeframes);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't load ideas"); setIdeas([]); }
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
  useEffect(() => { void load(); }, [load]);

  const put = (row: IdeaRow) => setIdeas((xs) => (xs || []).map((x) => (x.id === row.id ? row : x)));
  const edit = async (id: string, patch: Parameters<typeof api.editIdea>[1]) => {
    try { put(await api.editIdea(id, patch)); } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't save"); }
  };
  const add = async () => {
    if (!draft.title.trim()) return;
    try {
      const row = await api.addIdea({ ...draft, title: draft.title.trim() });
      setIdeas((xs) => [...(xs || []), row]); setDraft({ ...draft, title: "" }); setOpen(row.id);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't add it"); }
  };

  const shown = useMemo(() => (ideas || []).filter((i) =>
    show === "active" ? !["done", "parked"].includes(i.stage) : i.stage === show), [ideas, show]);
  const groups = (by === "area" ? areas : frames).map((g) => ({ ...g, rows: shown.filter((i) => (by === "area" ? i.area : i.timeframe) === g.key) }));
  const label = (list: IdeaPick[], k: string) => list.find((x) => x.key === k)?.label || k;
  const counts = { active: (ideas || []).filter((i) => !["done", "parked"].includes(i.stage)).length,
    working: (ideas || []).filter((i) => i.stage === "working" || i.stage === "testing").length,
    done: (ideas || []).filter((i) => i.stage === "done").length, parked: (ideas || []).filter((i) => i.stage === "parked").length };

  if (ideas === null) return <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Everything you want to get done to reach $10M, by part of the business. {counts.active} open · {counts.working} in progress · {counts.done} done.
      </p>

      {/* Add one */}
      <div className="space-y-2 rounded-xl border border-border bg-card p-3">
        <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
          placeholder="New idea or task…" className="h-11 w-full rounded-lg border border-input bg-background px-3 text-base" />
        <div className="flex flex-wrap gap-2">
          <select value={draft.area} onChange={(e) => setDraft({ ...draft, area: e.target.value })} className={cn(sel, "flex-1")}>
            {areas.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
          </select>
          <select value={draft.timeframe} onChange={(e) => setDraft({ ...draft, timeframe: e.target.value })} className={cn(sel, "flex-1")}>
            {frames.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
          <button type="button" onClick={() => void add()} disabled={!draft.title.trim()} className="inline-flex h-10 items-center gap-1 rounded-lg bg-foreground px-4 text-sm font-bold text-background disabled:opacity-40">
            <Plus className="h-4 w-4" /> Add
          </button>
        </div>
      </div>

      {/* How to look at them */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg bg-muted p-1">
          {([["area", "By area"], ["when", "By when"]] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setBy(k)} className={cn("h-9 rounded-md px-3 text-sm font-semibold", by === k ? "bg-background shadow-sm" : "text-muted-foreground")}>{l}</button>
          ))}
        </div>
        <div className="inline-flex rounded-lg bg-muted p-1">
          {([["active", `Open ${counts.active}`], ["done", `Done ${counts.done}`], ["parked", `Parked ${counts.parked}`]] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setShow(k)} className={cn("h-9 rounded-md px-3 text-sm font-semibold", show === k ? "bg-background shadow-sm" : "text-muted-foreground")}>{l}</button>
          ))}
        </div>
      </div>

      {groups.filter((g) => g.rows.length).map((g) => (
        <section key={g.key} className="space-y-2">
          <h2 className="flex items-baseline gap-2 text-base font-bold">{g.label} <span className="text-sm font-normal text-muted-foreground">{g.rows.length}</span></h2>
          {g.rows.map((i) => {
            const isOpen = open === i.id;
            const last = i.logs.find((l) => l.body);
            return (
              <div key={i.id} className="rounded-xl border border-border bg-card">
                <button type="button" onClick={() => setOpen(isOpen ? null : i.id)} className="flex w-full items-start gap-2 p-3 text-left">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold leading-snug">{i.title}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className={cn("rounded px-1.5 py-0.5 text-[12px] font-bold", STAGE_TONE[i.stage])}>{label(stages, i.stage)}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[12px] font-semibold text-muted-foreground">{by === "area" ? label(frames, i.timeframe) : label(areas, i.area)}</span>
                      {last ? <span className="truncate text-[13px] text-muted-foreground">{day(last.created_at)} · {last.body}</span> : null}
                    </div>
                  </div>
                  {isOpen ? <ChevronUp className="mt-1 h-4 w-4 shrink-0" /> : <ChevronDown className="mt-1 h-4 w-4 shrink-0" />}
                </button>
                {isOpen ? <IdeaDetail i={i} areas={areas} stages={stages} frames={frames} onEdit={edit} onPut={put}
                  onDelete={async () => { if (!window.confirm(`Delete "${i.title}"?`)) return; await api.deleteIdea(i.id); setIdeas((xs) => (xs || []).filter((x) => x.id !== i.id)); }} /> : null}
              </div>
            );
          })}
        </section>
      ))}
      {!shown.length ? <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">Nothing here yet.</p> : null}
    </div>
  );
}

function IdeaDetail({ i, areas, stages, frames, onEdit, onPut, onDelete }: {
  i: IdeaRow; areas: IdeaPick[]; stages: IdeaPick[]; frames: IdeaPick[];
  onEdit: (id: string, p: Parameters<typeof api.editIdea>[1]) => Promise<void>; onPut: (r: IdeaRow) => void; onDelete: () => Promise<void>;
}) {
  const [title, setTitle] = useState(i.title);
  const [details, setDetails] = useState(i.details);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const log = async () => {
    if (!note.trim()) return;
    setBusy(true);
    try { onPut(await api.addIdeaLog(i.id, note.trim())); setNote(""); } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't save"); } finally { setBusy(false); }
  };
  const label = (list: IdeaPick[], k: string) => list.find((x) => x.key === k)?.label || k;
  return (
    <div className="space-y-3 border-t border-border p-3">
      <input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() && title !== i.title && void onEdit(i.id, { title })}
        className="h-10 w-full rounded-lg border border-input bg-background px-3 text-base font-semibold" />
      <div className="grid grid-cols-3 gap-2">
        <select value={i.stage} onChange={(e) => void onEdit(i.id, { stage: e.target.value })} className={sel}>
          {stages.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <select value={i.timeframe} onChange={(e) => void onEdit(i.id, { timeframe: e.target.value })} className={sel}>
          {frames.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        <select value={i.area} onChange={(e) => void onEdit(i.id, { area: e.target.value })} className={sel}>
          {areas.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
        </select>
      </div>
      <textarea value={details} onChange={(e) => setDetails(e.target.value)} onBlur={() => details !== i.details && void onEdit(i.id, { details })}
        rows={3} placeholder="What it is, why, what done looks like…" className="w-full rounded-lg border border-input bg-background p-2.5 text-[15px] leading-snug" />
      {i.source ? <p className="text-[13px] text-muted-foreground">From: {i.source}</p> : null}

      <div className="space-y-2">
        <p className="text-sm font-bold">Progress</p>
        <div className="flex gap-2">
          <input value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void log(); }}
            placeholder="What did you do on it today?" className="h-10 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-[15px]" />
          <button type="button" onClick={() => void log()} disabled={busy || !note.trim()} className="h-10 rounded-lg bg-foreground px-3 text-sm font-bold text-background disabled:opacity-40">Log it</button>
        </div>
        <ul className="space-y-1.5">
          {i.logs.map((l) => (
            <li key={l.id} className="flex gap-2 text-[14px]">
              <span className="w-14 shrink-0 text-muted-foreground">{day(l.created_at)}</span>
              <span className="min-w-0 flex-1">{l.body || <em className="text-muted-foreground">Moved to {label(stages, l.stage)}</em>}</span>
            </li>
          ))}
          {!i.logs.length ? <li className="text-[14px] text-muted-foreground">Nothing logged yet.</li> : null}
        </ul>
      </div>
      <button type="button" onClick={() => void onDelete()} className="inline-flex h-9 items-center gap-1 text-sm font-semibold text-red-600"><Trash2 className="h-4 w-4" /> Delete</button>
    </div>
  );
}
