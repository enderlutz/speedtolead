// David's rules (Alan, 2026-11-11): the rulebook for David, the AI Project
// Manager. The same list the Claude app reads when it connects and adds to
// with teach_david; the 9 PM check lists the ones added that day.
// Documents → David's rules. Alan only.
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { api, type DavidRule } from "@/lib/api";

const day = (d: string) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");
const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

export function DavidRules() {
  const [rules, setRules] = useState<DavidRule[] | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setRules((await api.davidRules()).rules); } catch (e) { toast.error(msg(e, "Couldn't load David's rules")); setRules([]); }
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const r = await api.addDavidRule(text);
      setRules(r.rules); setDraft("");
      toast.success(r.added ? "David has it" : "David already had that rule");
    } catch (e) { toast.error(msg(e, "Couldn't add it")); } finally { setBusy(false); }
  };
  const save = async (n: number) => {
    if (busy) return;
    setBusy(true);
    try { setRules((await api.editDavidRule(n, editText.trim())).rules); setEditing(null); }
    catch (e) { toast.error(msg(e, "Couldn't save")); } finally { setBusy(false); }
  };
  const remove = async (r: DavidRule) => {
    if (busy || !window.confirm(`Take rule ${r.n} away from David?\n\n${r.text}`)) return;
    setBusy(true);
    try { setRules((await api.deleteDavidRule(r.n)).rules); } catch (e) { toast.error(msg(e, "Couldn't remove it")); } finally { setBusy(false); }
  };

  if (rules === null) return <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>;
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gold/40 bg-gold/10 p-3 text-sm text-stone-800">
        How David (the project manager) runs jobs, crew and materials. Every Claude that connects reads these first,
        and the 9 PM job check lists what he learned that day. {rules.length} rule{rules.length === 1 ? "" : "s"}.
      </div>

      <div className="space-y-2 rounded-xl border border-border bg-card p-3">
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2}
          placeholder="New rule, one sentence + why…" className="w-full rounded-lg border border-input bg-background px-3 py-2 text-base" />
        <button type="button" onClick={() => void add()} disabled={!draft.trim() || busy}
          className="inline-flex h-11 items-center gap-1.5 rounded-lg bg-ink px-4 text-sm font-bold text-white disabled:opacity-40">
          <Plus className="h-4 w-4" /> Teach David
        </button>
      </div>

      {rules.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">No rules yet. Add the first one above, or tell Claude "teach David…".</p>
      ) : (
        <ol className="space-y-2">
          {rules.map((r) => (
            <li key={r.n} className="rounded-xl border border-border bg-card p-3">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-cedar/15 text-sm font-bold text-walnut">{r.n}</span>
                <div className="min-w-0 flex-1">
                  {editing === r.n ? (
                    <textarea value={editText} onChange={(e) => setEditText(e.target.value)} rows={3}
                      className="w-full rounded-lg border border-input bg-background px-3 py-2 text-base" />
                  ) : (
                    <p className="whitespace-pre-wrap text-[15px] text-stone-900">{r.text}</p>
                  )}
                  {r.added && <p className="mt-1 text-sm text-muted-foreground">Added {day(r.added)}</p>}
                </div>
              </div>
              <div className="mt-2 flex justify-end gap-2">
                {editing === r.n ? (
                  <>
                    <button type="button" onClick={() => setEditing(null)} className="inline-flex h-11 items-center gap-1 rounded-lg px-3 text-sm font-semibold text-muted-foreground">
                      <X className="h-4 w-4" /> Cancel
                    </button>
                    <button type="button" onClick={() => void save(r.n)} disabled={busy || !editText.trim()}
                      className="inline-flex h-11 items-center gap-1 rounded-lg bg-ink px-4 text-sm font-bold text-white disabled:opacity-40">
                      <Check className="h-4 w-4" /> Save
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={() => { setEditing(r.n); setEditText(r.text); }}
                      className="inline-flex h-11 items-center gap-1 rounded-lg border border-border px-3 text-sm font-semibold">
                      <Pencil className="h-4 w-4" /> Edit
                    </button>
                    <button type="button" onClick={() => void remove(r)} aria-label={`Remove rule ${r.n}`}
                      className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-border text-muted-foreground">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
