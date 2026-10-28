/**
 * Jobs to fix (Alan, 2026-10-27): "a spot on the side where I can add jobs
 * that need fixing and write a little description". The go-backs that aren't
 * a crew day: pick up the wood left behind a customer's house, spray a
 * little bleach on a patio, screw the decorative pieces back on a fence, a
 * gallon more of stain on the inside. They wait on this list beside the
 * calendar; give one a day and it shows on that day as a placeholder next
 * to the real jobs (dashed, with a 🔧), and on the week map when it's one
 * of our customers. Done ones leave the list and stay on their day with a ✓.
 * Read on a phone too: nothing under 14px, every tap 44px.
 */
import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronUp, Loader2, Plus, Search, Trash2, Undo2, Wrench, X } from "lucide-react";
import { api, type FixJob } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { JobLinkComponent } from "./bits";
import { INK, IVORY, LINE, MUTED, PAPER, RING } from "./look";
import { fmt, whoOf } from "./dates";

export type FixCrew = { username: string; name: string }[];
export type FixPatch = { description?: string; date?: string; username?: string; done?: boolean };
/** What the page does with a change. Each one tells the user what went
 *  wrong itself and answers true when it worked. */
export type FixActions = {
  onAdd: (b: { lead_id: string; name: string; description: string; date: string; username: string }) => Promise<boolean>;
  onUpdate: (id: string, patch: FixPatch) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
};

/** A shade warmer than paper, so a placeholder reads as one next to a real job. */
const WASH = "bg-[#FBF6EA]";
const DASH = "border border-dashed border-[#8C6224]/60";
const shortDay = (d: string) => fmt(d, { weekday: "short", month: "short", day: "numeric" });

/**
 * "🔧 a customer · pick up the wood": the placeholder on a day in the Week, 3
 * days and Month views, the same size as a job chip. `stacked` is the Week's
 * two-line shape, `tiny` the month grid's (a plain span: the cell is the tap).
 */
export function FixChip({ f, who, tiny, stacked, onClick }: { f: FixJob; who?: string; tiny?: boolean; stacked?: boolean; onClick?: () => void }) {
  const fin = !!f.done_at;
  const cls = cn("flex w-full gap-1.5 rounded-lg text-left text-[14px] font-semibold leading-tight",
    fin ? cn("border border-dashed border-[#E4DCCB]", IVORY, MUTED) : cn(DASH, WASH, INK),
    stacked ? "flex-col items-stretch px-2 py-1.5" : "items-center",
    tiny ? "min-h-7 px-1.5" : stacked ? "min-h-11" : "min-h-11 px-2 py-1.5",
    onClick && "hover:bg-[#F8F3E7] active:bg-[#E4DCCB]/60");
  const icon = <span className="shrink-0 text-[14px] leading-none" aria-hidden>{fin ? "✓" : "🔧"}</span>;
  const title = `Fix · ${f.name} · ${f.description}${who ? ` · ${who}` : ""}`;
  const body = tiny ? <>{icon}<span className="min-w-0 flex-1 truncate">{f.name}</span></>
    : stacked ? (
      <>
        <span className="line-clamp-2 break-words text-[15px] font-bold">{fin ? "✓ " : "🔧 "}{f.name}</span>
        <span className={cn("line-clamp-2 break-words text-[14px] font-medium", MUTED)}>{f.description}{who ? ` · ${who}` : ""}</span>
      </>
    ) : (
      <>
        {icon}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-bold">{f.name}</span>
          <span className={cn("block truncate text-[14px] font-medium", MUTED)}>{f.description}{who ? ` · ${who}` : ""}</span>
        </span>
      </>
    );
  if (tiny || !onClick) return <span className={cls} title={title}>{body}</span>;
  return <button type="button" onClick={onClick} className={cls} title={title}>{body}</button>;
}

/** The line in the List view: a dashed dot, then "🔧 name · what · who". */
export function FixLine({ f, who, onClick }: { f: FixJob; who?: string; onClick?: () => void }) {
  const fin = !!f.done_at;
  return (
    <button type="button" onClick={onClick}
            className={cn("flex min-h-11 w-full items-start gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-[#F8F3E7] active:bg-[#E4DCCB]/60", fin ? MUTED : INK)}>
      <span className={cn("mt-[7px] h-2.5 w-2.5 shrink-0 rounded-full border border-dashed", fin ? "border-[#E4DCCB]" : "border-[#8C6224]")} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[16px] leading-snug">{fin ? "✓ " : "🔧 "}<b className="font-bold">{f.name}</b>{" · "}{f.description}</span>
        <span className={cn("block truncate text-[14px] leading-snug", MUTED)}>Job to fix{who ? ` · ${who}` : ""}</span>
      </span>
    </button>
  );
}

/**
 * One go-back with everything you can do to it: the day (a date box: put it
 * on a day, or move it), who's going, the words, Done, take it off. Closed
 * it's three lines; tap the top to open it. In the Day view and on Today it
 * starts open.
 */
export function FixCard({ f, crew, canEdit, actions, startOpen, Link }: {
  f: FixJob; crew: FixCrew; canEdit: boolean; actions: FixActions; startOpen?: boolean; Link?: JobLinkComponent;
}) {
  const [open, setOpen] = useState(!!startOpen);
  const [editing, setEditing] = useState(false);
  const [words, setWords] = useState(f.description);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState("");
  const fin = !!f.done_at;
  const who = f.username ? whoOf(crew, f.username) : "";
  const run = async (what: string, fn: () => Promise<boolean>) => { setBusy(what); try { return await fn(); } finally { setBusy(""); } };
  const field = "min-h-11 w-full rounded-xl border border-[#E4DCCB] bg-white px-3 text-[15px] text-[#15130F] focus:outline-none focus:ring-2 focus:ring-[#C9972F]";
  const small = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-3 text-[14px] font-bold";

  return (
    <div className={cn("rounded-xl", fin ? cn("border border-dashed border-[#E4DCCB]", IVORY) : cn(DASH, WASH))}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
              className="flex min-h-11 w-full items-start gap-2 rounded-xl px-3 py-2 text-left hover:bg-[#F8F3E7]/70 active:bg-[#E4DCCB]/60">
        <span className="mt-0.5 shrink-0 text-[16px] leading-none" aria-hidden>{fin ? "✓" : "🔧"}</span>
        <span className="min-w-0 flex-1">
          <span className={cn("block text-[15px] font-bold leading-snug", fin ? MUTED : INK)}>{f.name}</span>
          <span className={cn("block text-[14px] leading-snug", MUTED)}>{f.description}</span>
          <span className={cn("mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[14px] font-semibold", f.date ? "text-[#8C6224]" : "text-amber-700")}>
            <span>{f.date ? `📅 ${shortDay(f.date)}` : "Not on a day yet"}</span>
            {who ? <span className={MUTED}>· {who}</span> : null}
            {fin && f.done_by ? <span className={MUTED}>· done by {f.done_by}</span> : null}
          </span>
        </span>
        {open ? <ChevronUp className={cn("mt-1 h-4 w-4 shrink-0", MUTED)} /> : <ChevronDown className={cn("mt-1 h-4 w-4 shrink-0", MUTED)} />}
      </button>

      {open ? (
        <div className={cn("space-y-2 border-t px-3 pb-3 pt-2", LINE)}>
          {f.lead_id && Link ? <Link leadId={f.lead_id} className="inline-flex min-h-11 items-center text-[14px] font-bold text-[#8C6224] underline-offset-2 hover:underline">Open {f.name}'s job ›</Link> : null}
          {canEdit ? (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className={cn("mb-1 block text-[14px] font-semibold", MUTED)}>{f.date ? "Move it to" : "Put it on a day"}</span>
                  <input type="date" value={f.date} disabled={!!busy} className={field}
                         onChange={(e) => { if (e.target.value) void run("date", () => actions.onUpdate(f.id, { date: e.target.value })); }} />
                </label>
                <label className="block">
                  <span className={cn("mb-1 block text-[14px] font-semibold", MUTED)}>Who's going</span>
                  <select value={f.username} disabled={!!busy} className={field}
                          onChange={(e) => void run("who", () => actions.onUpdate(f.id, { username: e.target.value }))}>
                    <option value="">Nobody yet</option>
                    {crew.map((c) => <option key={c.username} value={c.username}>{c.name}</option>)}
                  </select>
                </label>
              </div>
              {f.date ? (
                <button type="button" disabled={!!busy} onClick={() => void run("date", () => actions.onUpdate(f.id, { date: "" }))}
                        className={cn(small, "text-[#8C6224] hover:bg-[#F8F3E7]")}>Take it off the day (back to the list)</button>
              ) : null}
              {editing ? (
                <div className="space-y-2">
                  <textarea value={words} onChange={(e) => setWords(e.target.value)} rows={3} maxLength={1000}
                            className={cn(field, "min-h-[88px] py-2")} placeholder="What needs doing there" />
                  <div className="flex flex-wrap gap-2">
                    <button type="button" disabled={!!busy || !words.trim()} className={cn(small, "bg-[#15130F] text-white disabled:opacity-50")}
                            onClick={() => void run("words", () => actions.onUpdate(f.id, { description: words.trim() })).then((ok) => { if (ok) setEditing(false); })}>
                      {busy === "words" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Save the words
                    </button>
                    <button type="button" className={cn(small, MUTED, "hover:bg-[#F8F3E7]")} onClick={() => { setWords(f.description); setEditing(false); }}>Cancel</button>
                  </div>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {fin ? (
                  <button type="button" disabled={!!busy} onClick={() => void run("done", () => actions.onUpdate(f.id, { done: false }))}
                          className={cn(small, "bg-white ring-1 ring-[#E4DCCB] hover:bg-[#F8F3E7]", INK)}><Undo2 className="h-4 w-4" />Put it back</button>
                ) : (
                  <button type="button" disabled={!!busy} onClick={() => void run("done", () => actions.onUpdate(f.id, { done: true }))}
                          className={cn(small, "bg-emerald-700 text-white hover:bg-emerald-800")}>
                    {busy === "done" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Done
                  </button>
                )}
                {!editing ? <button type="button" className={cn(small, "bg-white ring-1 ring-[#E4DCCB] hover:bg-[#F8F3E7]", INK)} onClick={() => setEditing(true)}>Change the words</button> : null}
                {sure ? (
                  <>
                    <button type="button" disabled={!!busy} onClick={() => void run("gone", () => actions.onDelete(f.id))}
                            className={cn(small, "bg-rose-700 text-white hover:bg-rose-800")}><Trash2 className="h-4 w-4" />Yes, take it off</button>
                    <button type="button" className={cn(small, MUTED, "hover:bg-[#F8F3E7]")} onClick={() => setSure(false)}>No</button>
                  </>
                ) : (
                  <button type="button" className={cn(small, "ml-auto text-rose-700 hover:bg-rose-50")} onClick={() => setSure(true)}><Trash2 className="h-4 w-4" />Take it off</button>
                )}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The list beside the calendar: the open go-backs (not on a day yet first,
 * then by day), an Add form, and the done ones folded away under it.
 */
export function FixList({ fixes, crew, canEdit, actions, Link, className }: {
  fixes: FixJob[]; crew: FixCrew; canEdit: boolean; actions: FixActions; Link?: JobLinkComponent; className?: string;
}) {
  const open = fixes.filter((f) => !f.done_at);
  const waiting = open.filter((f) => !f.date);
  const placed = open.filter((f) => !!f.date);
  const done = fixes.filter((f) => !!f.done_at);
  const [adding, setAdding] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const group = (label: string) => <p className={cn("px-1 pt-1 text-[12px] font-bold uppercase tracking-[0.12em]", MUTED)}>{label}</p>;

  return (
    <section className={cn("rounded-2xl", PAPER, RING, className)} aria-label="Jobs to fix">
      <header className={cn("flex items-center justify-between gap-2 border-b px-3 py-2.5", LINE)}>
        <p className={cn("flex items-center gap-1.5 font-heading text-[18px] font-bold", INK)}>
          <Wrench className="h-5 w-5 text-[#8C6224]" />Jobs to fix
          <span className={cn("text-[14px] font-semibold", MUTED)}>· {open.length}</span>
        </p>
        {canEdit && !adding ? (
          <button type="button" onClick={() => setAdding(true)}
                  className="inline-flex min-h-11 items-center gap-1 rounded-xl bg-[#15130F] px-3 text-[14px] font-bold text-white hover:bg-black">
            <Plus className="h-4 w-4" />Add
          </button>
        ) : null}
      </header>
      <p className={cn("px-3 pt-2 text-[14px]", MUTED)}>The small go-backs. Give one a day and it shows on the calendar next to the real jobs.</p>
      {adding ? <AddFix crew={crew} actions={actions} onDone={() => setAdding(false)} /> : null}
      <div className="space-y-2 p-2">
        {open.length === 0 && !adding ? <p className={cn("rounded-xl border border-dashed px-3 py-6 text-center text-[15px]", LINE, MUTED)}>Nothing to fix right now.</p> : null}
        {waiting.length ? group("Not on a day yet") : null}
        {waiting.map((f) => <FixCard key={f.id} f={f} crew={crew} canEdit={canEdit} actions={actions} Link={Link} />)}
        {placed.length ? group("On the calendar") : null}
        {placed.map((f) => <FixCard key={f.id} f={f} crew={crew} canEdit={canEdit} actions={actions} Link={Link} />)}
      </div>
      {done.length ? (
        <div className={cn("border-t", LINE)}>
          <button type="button" onClick={() => setShowDone((s) => !s)} aria-expanded={showDone}
                  className={cn("flex min-h-11 w-full items-center justify-between px-3 text-[14px] font-bold", MUTED, "hover:bg-[#F8F3E7]")}>
            <span>✓ Done · {done.length}</span>{showDone ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          {showDone ? <div className="space-y-2 p-2 pt-0">{done.map((f) => <FixCard key={f.id} f={f} crew={crew} canEdit={canEdit} actions={actions} Link={Link} />)}</div> : null}
        </div>
      ) : null}
    </section>
  );
}

/** Add one: pick the customer (or just type who it's for), say what, and
 *  give it a day and a person now or later. */
function AddFix({ crew, actions, onDone }: { crew: FixCrew; actions: FixActions; onDone: () => void }) {
  const [q, setQ] = useState("");
  const [options, setOptions] = useState<{ lead_id: string; name: string; address: string }[]>([]);
  const [who, setWho] = useState<{ lead_id: string; name: string; address?: string } | null>(null);
  const [words, setWords] = useState("");
  const [date, setDate] = useState("");
  const [username, setUsername] = useState("");
  const [saving, setSaving] = useState(false);
  const field = "min-h-11 w-full rounded-xl border border-[#E4DCCB] bg-white px-3 text-[15px] text-[#15130F] focus:outline-none focus:ring-2 focus:ring-[#C9972F]";

  // The search runs a beat after typing stops; the list only shows from two
  // letters, so a short box never shows a stale answer.
  useEffect(() => {
    if (who) return;
    const term = q.trim();
    const t = window.setTimeout(() => {
      if (term.length < 2) { setOptions([]); return; }
      api.getCompanyCamJobs(term).then((r) => {
        const seen = new Set<string>();
        setOptions(r.filter((x) => (seen.has(x.lead_id) ? false : (seen.add(x.lead_id), true))).slice(0, 6));
      }).catch(() => setOptions([]));
    }, 250);
    return () => window.clearTimeout(t);
  }, [q, who]);

  const ready = !!who && !!words.trim();
  const save = async () => {
    if (!who || !ready) return;
    setSaving(true);
    const ok = await actions.onAdd({ lead_id: who.lead_id, name: who.name, description: words.trim(), date, username });
    setSaving(false);
    if (ok) onDone();
  };

  return (
    <div className={cn("m-2 space-y-2 rounded-xl p-3", DASH, WASH)}>
      <p className={cn("text-[15px] font-bold", INK)}>Add a job to fix</p>
      {who ? (
        <div className="flex min-h-11 items-center gap-2 rounded-xl bg-white px-3 ring-1 ring-[#E4DCCB]">
          <span className="min-w-0 flex-1 truncate text-[15px] font-bold">{who.name}{who.address ? <span className={cn("font-normal", MUTED)}> · {who.address}</span> : null}</span>
          <button type="button" onClick={() => { setWho(null); setQ(""); }} aria-label="Pick someone else" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-[#F8F3E7]"><X className="h-4 w-4" /></button>
        </div>
      ) : (
        <div>
          <div className="relative">
            <Search className={cn("pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2", MUTED)} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Who is it for? Type a customer's name" autoFocus className={cn(field, "pl-9")} />
          </div>
          {q.trim().length >= 2 ? (
            <div className="mt-1 overflow-hidden rounded-xl bg-white ring-1 ring-[#E4DCCB]">
              {options.map((o) => (
                <button key={o.lead_id} type="button" onClick={() => setWho(o)}
                        className={cn("flex min-h-11 w-full items-center gap-2 border-b px-3 text-left hover:bg-[#F8F3E7]", LINE)}>
                  <span className="min-w-0 flex-1 truncate text-[15px] font-bold">{o.name}</span>
                  <span className={cn("hidden max-w-[50%] truncate text-[14px] sm:block", MUTED)}>{o.address}</span>
                </button>
              ))}
              <button type="button" onClick={() => setWho({ lead_id: "", name: q.trim().slice(0, 120) })}
                      className="flex min-h-11 w-full items-center px-3 text-left text-[14px] font-semibold text-[#8C6224] hover:bg-[#F8F3E7]">
                Not a customer: just use “{q.trim()}”
              </button>
            </div>
          ) : null}
        </div>
      )}
      <textarea value={words} onChange={(e) => setWords(e.target.value)} rows={3} maxLength={1000}
                placeholder="What needs doing there. Like: pick up the wood behind the house." className={cn(field, "min-h-[88px] py-2")} />
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className={cn("mb-1 block text-[14px] font-semibold", MUTED)}>Day (or leave it for later)</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={field} />
        </label>
        <label className="block">
          <span className={cn("mb-1 block text-[14px] font-semibold", MUTED)}>Who's going</span>
          <select value={username} onChange={(e) => setUsername(e.target.value)} className={field}>
            <option value="">Nobody yet</option>
            {crew.map((c) => <option key={c.username} value={c.username}>{c.name}</option>)}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!ready || saving} onClick={() => void save()}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-[#15130F] px-4 text-[15px] font-bold text-white hover:bg-black disabled:opacity-50">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}{date ? "Put it on the calendar" : "Add to the list"}
        </button>
        <button type="button" onClick={onDone} className={cn("inline-flex min-h-11 items-center rounded-xl px-3 text-[14px] font-bold hover:bg-[#F8F3E7]", MUTED)}>Cancel</button>
      </div>
    </div>
  );
}
