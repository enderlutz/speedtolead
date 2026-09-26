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
import { api, type FenceScopeSendPreview } from "@/lib/api";

interface Props {
  leadId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent: () => void;
}

export default function SendScopeDialog({ leadId, open, onOpenChange, onSent }: Props) {
  const [preview, setPreview] = useState<FenceScopeSendPreview | null>(null);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPreview(null);
    api.getFenceScopeSendPreview(leadId)
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
        setMessage(p.message);
      })
      .catch(() => {
        if (!cancelled) toast.error("Couldn't work out who to send this to");
      });
    return () => { cancelled = true; };
  }, [open, leadId]);

  const send = async () => {
    setSending(true);
    try {
      const r = await api.sendFenceScope(leadId, message);
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

            <div>
              <label htmlFor="scope-message" className="text-xs font-medium">Message</label>
              <Textarea
                id="scope-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
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
          <Button onClick={send} disabled={!preview || blocked || sending || !message.trim()}>
            {sending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Send className="h-4 w-4 mr-1.5" />}
            {sending ? "Sending…" : "Send now"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
