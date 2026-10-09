// The scopes this customer has already been sent.
//
// A customer who replies "that's wrong" needs a corrected scope back in
// seconds. The expensive part — the ChatGPT drone render — belongs to the
// house, not to the markings, so revising reuses it and never re-renders.
// Before this, the only way to change a sent scope was Delete, which wiped
// the render and cost a minute to redo a thirty-second fix.
//
// Each sent version keeps its own link, so the image already sitting in the
// customer's texts stays exactly what they were sent.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { History, Loader2, PencilLine, X, Check } from "lucide-react";
import { api, type FenceScopeVersion } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Props {
  leadId: string;
  /** Bumps whenever the scope is saved or sent, so the list refetches. */
  revision: number;
  /** Called once a revision is opened, so the editor reloads the fresh scope. */
  onRevised: () => void;
}

function shortDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function ScopeVersions({ leadId, revision, onRevised }: Props) {
  const [versions, setVersions] = useState<FenceScopeVersion[]>([]);
  const [editingNo, setEditingNo] = useState(1);
  // Whether the scope currently open has already gone out. Read from the same
  // endpoint rather than threaded down, so it can never drift from the list.
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<FenceScopeVersion | null>(null);

  const load = useCallback(() => {
    api.getFenceScopeVersions(leadId)
      .then((r) => {
        setVersions(r.versions);
        setEditingNo(r.active_version_no);
        setSent(!!r.active_sent_at);
      })
      .catch(() => { /* a missing history is not worth interrupting a trace for */ });
  }, [leadId]);

  useEffect(() => { load(); }, [load, revision]);

  const revise = async () => {
    setBusy(true);
    try {
      const r = await api.reviseFenceScope(leadId);
      toast.success(`Scope v${r.archived_version_no} filed. Editing v${r.editing_version_no} — the drone view is kept.`);
      load();
      onRevised();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't start a revision");
    } finally {
      setBusy(false);
    }
  };

  // Nothing sent and nothing filed: no history worth showing.
  if (versions.length === 0 && !sent) return null;

  const chip = "inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] font-semibold";

  return (
    <>
      <div className="flex items-center gap-1.5 overflow-x-auto border-b border-gold/20 bg-ivory/70 px-3 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <History className="h-3.5 w-3.5 shrink-0 text-bronze" />
        {versions.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => setPreview(v)}
            className={cn(chip, "border border-gold/40 bg-white text-ink/70 transition hover:bg-gold/10")}
            title={`Sent ${v.sent_at ? new Date(v.sent_at).toLocaleString() : "—"} · ${v.segment_count} marked. Tap to see exactly what went out.`}
          >
            <Check className="h-3 w-3 text-emerald-600" /> v{v.version_no} · {shortDate(v.sent_at)}
          </button>
        ))}
        <span className={cn(chip, sent ? "bg-emerald-100 text-emerald-800" : "bg-gold/20 text-bronze")}>
          {sent ? <Check className="h-3 w-3" /> : <PencilLine className="h-3 w-3" />}
          v{editingNo} {sent ? "sent" : "editing"}
        </span>
        {sent && (
          <button
            type="button"
            onClick={revise} disabled={busy}
            className={cn(chip, "ml-auto border border-gold/60 bg-white text-bronze transition hover:bg-gold/15 disabled:opacity-50")}
            title="Files this one away and opens a copy to correct. Keeps the drone view, so it takes seconds."
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <PencilLine className="h-3 w-3" />}
            Correct &amp; resend
          </button>
        )}
      </div>

      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={() => setPreview(null)}
        >
          <div className="w-full max-w-lg space-y-2 rounded-2xl bg-ivory p-3 shadow-2xl ring-1 ring-gold/40" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <p className="font-heading text-sm font-bold text-ink">
                Scope v{preview.version_no}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  sent {preview.sent_at ? new Date(preview.sent_at).toLocaleString() : "—"}
                </span>
              </p>
              <button type="button" onClick={() => setPreview(null)} aria-label="Close" className="rounded-lg p-1 text-muted-foreground hover:bg-ink/5 hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <img
              src={api.fenceScopeVersionImageUrl(leadId, preview.id)}
              alt={`Scope version ${preview.version_no}`}
              className="w-full rounded-xl ring-1 ring-ink/10"
            />
            <p className="text-[11px] text-muted-foreground">
              This is exactly what the customer received. Their link still shows this image.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
