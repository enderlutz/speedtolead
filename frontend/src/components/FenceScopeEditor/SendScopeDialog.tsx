// Confirm step before a scope goes to a real customer.
//
// One click sends a picture of someone's house to their phone, which can't be
// taken back — so the dialog shows exactly who it's going to and exactly what
// it will say, and the message is editable before it leaves. Anything that
// would stop the send is listed up front rather than surfacing as a failure
// after the button is pressed.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Send, Loader2, AlertTriangle } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, type FenceScopeSendPreview, type ScopeTemplate } from "@/lib/api";

interface Props {
  leadId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent: () => void;
}

export default function SendScopeDialog({ leadId, open, onOpenChange, onSent }: Props) {
  const [preview, setPreview] = useState<FenceScopeSendPreview | null>(null);
  const [message, setMessage] = useState("");
  const [template, setTemplate] = useState<ScopeTemplate>("new");
  // Set once the message has been typed in, so switching template doesn't
  // quietly throw away wording someone has written.
  const [edited, setEdited] = useState(false);
  const [sending, setSending] = useState(false);
  // Ticked only when someone has read that the photo is turned and meant it.
  const [orientationOk, setOrientationOk] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPreview(null);
    setEdited(false);
    setOrientationOk(false);
    api.getFenceScopeSendPreview(leadId)
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
        setTemplate(p.suggested_template);
        setMessage(p.messages[p.suggested_template]);
      })
      .catch(() => {
        if (!cancelled) toast.error("Couldn't work out who to send this to");
      });
    return () => { cancelled = true; };
  }, [open, leadId]);

  const pickTemplate = (next: ScopeTemplate) => {
    setTemplate(next);
    if (!preview) return;
    if (edited && !window.confirm("Replace your edited message with the standard wording?")) return;
    setMessage(preview.messages[next]);
    setEdited(false);
  };

  const send = async () => {
    setSending(true);
    try {
      const r = await api.sendFenceScope(leadId, message, template, orientationOk);
      toast.success(`Scope sent to ${r.to}`);
      onOpenChange(false);
      onSent();
    } catch (e) {
      // The backend writes these for whoever pressed the button — an opt-out,
      // a missing number, a carrier rejection.
      toast.error(e instanceof Error ? e.message : "The text didn't go through", { duration: 12000 });
    } finally {
      setSending(false);
    }
  };

  const blocked = !!preview && !preview.can_send;
  // A turned photo isn't forbidden — some properties genuinely need it — but
  // it can't go out unnoticed. Carl Hiller got his house upside down because
  // nothing anywhere said the picture had been flipped.
  const needsOrientationOk = !!preview?.reoriented && !orientationOk;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Send the scope to the customer</DialogTitle>
          <DialogDescription>
            {preview
              ? `Texts the scope image to ${preview.contact_name || "this customer"} at ${preview.contact_phone || "their number"}.`
              : "Checking who this goes to…"}
          </DialogDescription>
        </DialogHeader>

        {!preview ? (
          <div className="flex items-center justify-center h-28">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-3">
            {blocked && (
              <div className="flex gap-2 rounded border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-2.5 text-xs">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 mt-0.5" />
                <ul className="space-y-1">
                  {preview.blockers.map((b) => <li key={b}>{b}</li>)}
                </ul>
              </div>
            )}

            {preview.reoriented && (
              <div className="flex gap-2 rounded border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-2.5 text-xs">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 mt-0.5" />
                <div className="space-y-1.5">
                  <p>
                    This photo is <strong>{preview.reoriented}</strong>, so{" "}
                    {preview.contact_name?.split(" ")[0] || "the customer"} would see their
                    property the wrong way round. Close this and use “Put it back”.
                  </p>
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={orientationOk}
                      onChange={(e) => setOrientationOk(e.target.checked)}
                      className="h-3.5 w-3.5"
                    />
                    Send it this way on purpose
                  </label>
                </div>
              </div>
            )}

            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium mr-1">Wording:</span>
              {([
                ["new", "New lead", "Never been quoted"],
                ["returning", "Old lead", "Quoted before, never booked — offers to re-price"],
              ] as const).map(([value, label, hint]) => (
                <Button
                  key={value} size="sm" variant={template === value ? "default" : "outline"}
                  className="h-7 text-[11px]" onClick={() => pickTemplate(value)}
                  disabled={blocked} title={hint}
                >
                  {label}
                </Button>
              ))}
              {preview.suggested_template === "returning" && (
                <span className="text-[11px] text-muted-foreground">already estimated</span>
              )}
            </div>

            <div>
              <label htmlFor="scope-message" className="text-xs font-medium">Message</label>
              <Textarea
                id="scope-message"
                value={message}
                onChange={(e) => { setMessage(e.target.value); setEdited(true); }}
                rows={8}
                className="mt-1 text-sm"
                disabled={blocked}
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                The scope image is attached below this text. {message.length} characters.
              </p>
            </div>

            {preview.last_sent_at && (
              <p className="text-[11px] text-muted-foreground">
                Already sent once on {new Date(preview.last_sent_at).toLocaleString()} — sending again
                replaces nothing, the customer just gets another text.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={send} disabled={!preview || blocked || needsOrientationOk || sending || !message.trim()}>
            {sending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Send className="h-4 w-4 mr-1.5" />}
            {sending ? "Sending…" : "Send now"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
