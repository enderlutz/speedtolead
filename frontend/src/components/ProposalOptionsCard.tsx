// One proposal, two (or more) options (Alan, 2026-10-13: Exolei asked for
// "one for my side, one for both sides"). Each option freezes the estimate's
// three prices and the scope drawing as they are when saved. Change the
// estimate's sides and the drawing, save again for option 2. The next
// interactive send carries every saved option, and the customer switches
// between them on the one page.
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Layers, Loader2, Plus, Trash2, Image as ImageIcon } from "lucide-react";
import { api, type ProposalOptionsState } from "@/lib/api";
import { cn, formatCurrency } from "@/lib/utils";
import { ScopeDrawingPicker } from "@/components/ScopeDrawingPicker";

export function ProposalOptionsCard({ leadId, interactive, onDrafts }: { leadId: string; interactive: boolean | null; onDrafts?: (n: number) => void }) {
  const [state, setState] = useState<ProposalOptionsState | null>(null);
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // Which numbered drawing goes with the option being saved. Must be picked.
  const [drawing, setDrawing] = useState<string | null>(null);
  const [shown, setShown] = useState<{ id: string; url: string } | null>(null);

  const load = useCallback(() => { api.listProposalOptions(leadId).then(setState).catch(() => setState(null)); }, [leadId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { if (shown) URL.revokeObjectURL(shown.url); }, [shown]);

  const drafts = state?.drafts ?? [];
  useEffect(() => { onDrafts?.(state?.drafts.length ?? 0); }, [state, onDrafts]);
  const save = async () => {
    setBusy(true);
    try {
      if (!drawing) { toast.error("Pick the drawing that goes with this option"); return; }
      const o = await api.saveProposalOption(leadId, { label: label.trim() || `Option ${drafts.length + 1}`, note: note.trim(), drawing });
      toast.success(`Saved "${o.label}" at Signature ${o.tiers ? formatCurrency(o.tiers.signature) : ""}${o.has_scope ? " with its drawing" : ", no drawing yet"}`);
      setLabel(""); setNote(""); setDrawing(null); load();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't save the option"); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    try { await api.deleteProposalOption(id); load(); } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't remove it"); }
  };
  const showDrawing = async (id: string) => {
    if (shown?.id === id) { setShown(null); return; }
    const url = await api.fetchProposalOptionScopeUrl(leadId, id);
    if (url) setShown({ id, url }); else toast.error("No drawing on that option");
  };

  return (
    <div className="rounded-xl border border-border bg-muted/30 p-2.5">
      <div className="flex items-center gap-2">
        <Layers className="h-4 w-4 text-violet-600" />
        <p className="text-sm font-semibold">Options in one proposal</p>
        {drafts.length ? <span className="ml-auto rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-bold text-violet-800">{drafts.length} ready</span> : null}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        For a customer who wants more than one price. Set the estimate for option 1, pick its drawing, and save it. Then change the sides, Save &amp; Recalculate, pick the other drawing, and save option 2. Each option keeps its own prices and drawing.
      </p>

      {drafts.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {drafts.map((o, i) => (
            <li key={o.id} className="rounded-lg bg-background p-2 text-xs ring-1 ring-border">
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-600 text-[10px] font-bold text-white">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <b className="text-sm">{o.label}</b>
                  {o.note ? <span className="block text-muted-foreground">{o.note}</span> : null}
                </span>
                <button type="button" onClick={() => showDrawing(o.id)} disabled={!o.has_scope} title={o.has_scope ? "See its drawing" : "Saved without a drawing"}
                  className={cn("rounded-md p-1 hover:bg-muted disabled:opacity-40", shown?.id === o.id && "bg-muted")}><ImageIcon className="h-3.5 w-3.5" /></button>
                <button type="button" onClick={() => remove(o.id)} className="rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label="Remove option"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
              {o.tiers ? (
                <p className="mt-1 pl-7 tabular-nums text-muted-foreground">
                  Essential {formatCurrency(o.tiers.essential)} · <b className="text-foreground">Signature {formatCurrency(o.tiers.signature)}</b> · Legacy {formatCurrency(o.tiers.legacy)}
                  {o.feet ? ` · ${o.feet} ft` : ""}{o.has_scope ? "" : " · no drawing"}
                </p>
              ) : null}
              {shown?.id === o.id ? <img src={shown.url} alt="" className="mt-2 w-full rounded-md ring-1 ring-border" /> : null}
            </li>
          ))}
        </ul>
      )}

      {drafts.length < 4 && (
        <div className="mt-2 space-y-1.5">
          <div className="flex flex-wrap gap-1.5">
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={drafts.length === 0 ? "Name it, e.g. Your side only" : "e.g. Both sides"}
              className="h-9 min-w-[10rem] flex-1 rounded-md border border-border bg-background px-2 text-sm" />
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="One line she sees (optional)"
              className="h-9 min-w-[10rem] flex-1 rounded-md border border-border bg-background px-2 text-sm" />
          </div>
          <p className="text-[11px] font-semibold text-muted-foreground">Which drawing goes with option {drafts.length + 1}?</p>
          <ScopeDrawingPicker leadId={leadId} value={drawing} onChange={setDrawing} />
          <button type="button" onClick={save} disabled={busy || !drawing}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-violet-600 px-3 text-sm font-bold text-white hover:bg-violet-700 disabled:opacity-60">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Save the current estimate as option {drafts.length + 1}
          </button>
        </div>
      )}

      {drafts.length === 1 && <p className="mt-1.5 text-[11px] font-semibold text-amber-700">One option saved. Save at least one more, or remove it to send a normal proposal.</p>}
      {drafts.length >= 2 && (
        <p className={cn("mt-1.5 text-[11px] font-semibold", interactive ? "text-violet-700" : "text-rose-600")}>
          {interactive ? `Send now: the interactive proposal goes out with all ${drafts.length} options.` : "Switch \"Send as\" to Interactive page. The PDF can't carry options."}
        </p>
      )}
      {state?.sent.length ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">Sent: {state.sent_number} has {state.sent.map((o) => o.label).join(" / ")}. Those are frozen.</p>
      ) : null}
    </div>
  );
}
