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
import { History, Loader2, PencilLine, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, type FenceScopeVersion } from "@/lib/api";

interface Props {
  leadId: string;
  /** Bumps whenever the scope is saved or sent, so the list refetches. */
  revision: number;
  /** Called once a revision is opened, so the editor reloads the fresh scope. */
  onRevised: () => void;
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

  return (
    <>
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs border-b min-w-0 overflow-x-auto">
        <History className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {versions.map((v) => (
          <button
            key={v.id}
            onClick={() => setPreview(v)}
            className="shrink-0 rounded border px-2 py-0.5 hover:bg-accent text-muted-foreground"
            title={`Sent ${v.sent_at ? new Date(v.sent_at).toLocaleString() : "—"} · ${v.segment_count} marked`}
          >
            v{v.version_no} sent
          </button>
        ))}
        <span className="shrink-0 rounded border border-primary/40 bg-primary/10 px-2 py-0.5 font-medium">
          v{editingNo} {sent ? "sent" : "editing"}
        </span>
        {sent && (
          <Button
            size="sm" variant="outline" className="h-6 px-2 text-[11px] shrink-0 ml-auto"
            onClick={revise} disabled={busy}
            title="Files this one away and opens a copy to correct. Keeps the drone view, so it takes seconds."
          >
            {busy ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <PencilLine className="h-3 w-3 mr-1" />}
            Correct &amp; resend
          </Button>
        )}
      </div>

      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setPreview(null)}
        >
          <div className="bg-background rounded-lg max-w-lg w-full p-3 space-y-2" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">
                Scope v{preview.version_no}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  sent {preview.sent_at ? new Date(preview.sent_at).toLocaleString() : "—"}
                </span>
              </p>
              <button onClick={() => setPreview(null)} aria-label="Close" className="text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <img
              src={api.fenceScopeVersionImageUrl(leadId, preview.id)}
              alt={`Scope version ${preview.version_no}`}
              className="w-full rounded border"
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
