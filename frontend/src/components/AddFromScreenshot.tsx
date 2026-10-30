// A caller becomes a contact from a screenshot (Alan, 2026-10-29: "send a
// screenshot of their contact and the text messages about them, and you can
// instantly generate a customer profile for them"). Pick the screenshots →
// the AI fills the form → check it → Create: the GHL contact and the lead
// in New Lead with its price. No text goes to the customer.
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ImagePlus, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { api, type CallerFields } from "@/lib/api";
import { Button } from "@/components/ui/button";

const EMPTY: CallerFields = { name: "", phone: "", email: "", address: "", notes: "" };

export function AddFromScreenshot() {
  const nav = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [shots, setShots] = useState<string[]>([]);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState<CallerFields>(EMPTY);
  const [twin, setTwin] = useState<{ lead_id: string; name: string } | null>(null);

  const close = () => { shots.forEach((u) => URL.revokeObjectURL(u)); setShots([]); setF(EMPTY); setTwin(null); setOpen(false); };
  const pick = async (files: File[]) => {
    if (!files.length) return;
    setOpen(true);
    setShots(files.slice(0, 4).map((x) => URL.createObjectURL(x)));
    setReading(true);
    try {
      const out = await api.readCallerScreenshots(files.slice(0, 4));
      setF({ name: out.name, phone: out.phone, email: out.email, address: out.address, notes: out.notes });
      setTwin(out.existing);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't read it. Type it in.");
    } finally {
      setReading(false);
    }
  };
  const create = async () => {
    setBusy(true);
    try {
      const out = await api.createManualLead(f);
      toast.success(out.ghl_ok ? `${f.name} added to Go High Level and the dashboard` : `${f.name} added to the dashboard. Go High Level didn't answer, so texting may not work yet`);
      close();
      nav(`/leads/${out.lead_id}`);
    } catch (e) {
      const id = (e as { leadId?: string }).leadId;
      if (id) setTwin({ lead_id: id, name: f.name });
      toast.error(e instanceof Error ? e.message : "Couldn't add them");
    } finally {
      setBusy(false);
    }
  };
  const field = (k: keyof CallerFields, label: string, props: Record<string, unknown> = {}) => (
    <label className="block text-sm font-semibold">{label}
      {k === "notes" ? (
        <textarea value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} rows={3}
          className="mt-1 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-base font-normal" />
      ) : (
        <input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...props}
          className="mt-1 h-11 w-full rounded-lg border border-border bg-background px-3 text-base font-normal" />
      )}
    </label>
  );

  return (
    <>
      <input ref={input} type="file" accept="image/*" multiple className="hidden"
        onChange={(e) => { const fs = Array.from(e.target.files || []); e.target.value = ""; void pick(fs); }} />
      <Button onClick={() => input.current?.click()} size="sm">
        <ImagePlus className="mr-2 h-4 w-4" /> Add a caller from a screenshot
      </Button>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onClick={close}>
          <div className="flex max-h-[94vh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl bg-background shadow-2xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <p className="font-bold">New contact from a screenshot</p>
              <button type="button" onClick={close} className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-muted" aria-label="Close"><X className="h-5 w-5" /></button>
            </div>
            <div className="space-y-3 overflow-y-auto px-4 py-3">
              <div className="flex gap-2 overflow-x-auto">
                {shots.map((u) => <img key={u} src={u} alt="" className="h-28 shrink-0 rounded-md ring-1 ring-border" />)}
              </div>
              {reading ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Reading the screenshot…</p>
              ) : (
                <>
                  {twin ? (
                    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                      This number is already {twin.name || "a lead"}.{" "}
                      <button type="button" onClick={() => { close(); nav(`/leads/${twin.lead_id}`); }} className="font-bold underline">Open their page</button>
                    </div>
                  ) : null}
                  {field("name", "Name", { autoComplete: "off" })}
                  {field("phone", "Phone", { inputMode: "tel", autoComplete: "off" })}
                  {field("address", "Address", { autoComplete: "off" })}
                  {field("email", "Email", { inputMode: "email", autoComplete: "off" })}
                  {field("notes", "What they want")}
                  <p className="text-xs text-muted-foreground">Check it, then Create. It goes into Go High Level and the dashboard as a New Lead with a price. No text goes to them.</p>
                </>
              )}
            </div>
            <div className="flex gap-2 border-t border-border px-4 py-3">
              <Button variant="outline" className="h-11" onClick={() => input.current?.click()} disabled={reading || busy}>Other screenshots</Button>
              <Button className="h-11 flex-1" onClick={() => void create()} disabled={reading || busy || !f.name.trim() || !f.phone.trim() || !!twin}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null} Create contact
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
