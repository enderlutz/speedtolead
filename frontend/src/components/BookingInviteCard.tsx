// The booking invite, drafted on the lead (Alan, 2026-10-14). Pick the day
// we're aiming for, the package and colour, add a note (say, the pergola
// range from the call), and see exactly what the customer gets. Sending it
// comes next; for now this saves the draft and previews it.
import { useEffect, useMemo, useState } from "react";
import { CalendarCheck, Eye, Save } from "lucide-react";
import { toast } from "sonner";
import { api, type BookingDraft, type LeadDetail } from "@/lib/api";
import { Panel } from "@/components/Panel";
import { ACCENT } from "@/lib/accents";
import { sidesInWords } from "@/lib/fenceSides";
import { cn, formatCurrency } from "@/lib/utils";
import { BookingInvite } from "@/components/proposal/BookingInvite";

type Tier = "essential" | "signature" | "legacy";
const TIERS: { key: Tier; name: string }[] = [
  { key: "essential", name: "Essential" },
  { key: "signature", name: "Signature Finish" },
  { key: "legacy", name: "Legacy" },
];
const COLORS = ["Redwood Naturaltone", "Cedar Naturaltone", "Pecan", "Redwood", "Cottage Gray", "Monticello Tan", "Dark Walnut", "Chocolate Chips"];
const NOTE_HINT = "e.g. The pergola would be about $750 to $950 more. We'd just need a closer look at it on the day.";

function nextThursday(): string {
  const d = new Date();
  d.setDate(d.getDate() + (((4 - d.getDay() + 7) % 7) || 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function BookingInviteCard({ lead }: { lead: LeadDetail }) {
  const [draft, setDraft] = useState<{ date: string; tier: Tier; color: string; notes: string }>({ date: nextThursday(), tier: "signature", color: "", notes: "" });
  const [saved, setSaved] = useState<BookingDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    api.getBookingDraft(lead.id).then((d) => {
      if (!alive || !d?.updated_at) return;
      setSaved(d);
      setOpen(true);
      setDraft((x) => ({ date: d.date || x.date, tier: (d.tier || x.tier) as Tier, color: d.color || "", notes: d.notes || "" }));
    }).catch(() => { /* nothing saved yet */ });
    return () => { alive = false; };
  }, [lead.id]);

  // The prices are the ones on the estimate that went out.
  const tiers = useMemo(() => {
    const ests = [...(lead.estimates || [])].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    const est = ests.find((e) => e.status === "sent") || ests[0];
    const t = est?.tiers as Record<string, number> | undefined;
    return t && t.signature ? t : null;
  }, [lead.estimates]);
  const fd = (lead.form_data || {}) as Record<string, unknown>;
  const rawSides = fd.fence_sides;
  const sides = sidesInWords(Array.isArray(rawSides) ? (rawSides as string[]) : rawSides ? String(rawSides).split(",").map((v) => v.trim()) : []);
  const total = tiers?.[draft.tier] || 0;
  const changed = !saved || saved.date !== draft.date || saved.tier !== draft.tier || (saved.color || "") !== draft.color || (saved.notes || "") !== draft.notes;

  const save = async () => {
    setSaving(true);
    try {
      setSaved(await api.saveBookingDraft(lead.id, draft));
      toast.success("Booking invite saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  };

  const day = draft.date ? new Date(`${draft.date}T12:00:00`) : null;
  const sub = saved?.date && day
    ? `Draft · ${day.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · ${TIERS.find((t) => t.key === draft.tier)?.name}`
    : "Our own invite: date held until the $250 deposit, then confirmed";

  return (
    <Panel icon={CalendarCheck} title="Booking invite" sub={sub} accent={ACCENT.gold}
      collapsed={!open} onToggle={() => setOpen((v) => !v)} bodyClassName="space-y-3 p-3.5">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-semibold">Day we're aiming for</span>
          <input type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })}
            className="mt-1 h-11 w-full rounded-lg border border-input bg-background px-3 text-base" />
        </label>
        <label className="block text-sm">
          <span className="font-semibold">Color</span>
          <input list="booking-colors" value={draft.color} placeholder="Pick or type a color" onChange={(e) => setDraft({ ...draft, color: e.target.value })}
            className="mt-1 h-11 w-full rounded-lg border border-input bg-background px-3 text-base" />
          <datalist id="booking-colors">{COLORS.map((c) => <option key={c} value={c} />)}</datalist>
        </label>
      </div>
      <div>
        <p className="text-sm font-semibold">Package</p>
        <div className="mt-1 grid grid-cols-3 gap-2">
          {TIERS.map((t) => (
            <button key={t.key} type="button" onClick={() => setDraft({ ...draft, tier: t.key })}
              className={cn("rounded-lg border px-2 py-2 text-left text-sm", draft.tier === t.key ? "border-bronze bg-gold/15 font-semibold ring-1 ring-gold" : "border-input hover:bg-muted")}>
              <span className="block">{t.name}</span>
              <span className="block tabular-nums text-muted-foreground">{tiers?.[t.key] ? formatCurrency(tiers[t.key]) : "No price yet"}</span>
            </button>
          ))}
        </div>
      </div>
      <label className="block text-sm">
        <span className="font-semibold">Additional notes</span>
        <span className="ml-1 text-muted-foreground">(they see this on the invite)</span>
        <textarea value={draft.notes} maxLength={1000} rows={3} placeholder={NOTE_HINT} onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-base" />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setPreview(true)} disabled={!day}
          className="inline-flex h-11 items-center gap-2 rounded-lg bg-ink px-4 text-sm font-bold text-gold-light disabled:opacity-50">
          <Eye className="h-4 w-4" /> Preview what {lead.contact_name?.split(" ")[0] || "they"} gets
        </button>
        <button type="button" onClick={save} disabled={saving || !changed}
          className="inline-flex h-11 items-center gap-2 rounded-lg border border-input px-4 text-sm font-semibold hover:bg-muted disabled:opacity-50">
          <Save className="h-4 w-4" /> {saving ? "Saving…" : changed ? "Save draft" : "Saved"}
        </button>
        <span className="text-xs text-muted-foreground">Sending it by text and email comes next. Nothing is sent from here yet.</span>
      </div>
      {saved?.updated_at ? (
        <p className="text-xs text-muted-foreground">Last saved {new Date(saved.updated_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" })}{saved.updated_by ? ` by ${saved.updated_by}` : ""}</p>
      ) : null}

      {preview && day ? (
        <BookingInvite
          firstName={lead.contact_name?.split(" ")[0] || "there"}
          address={lead.address || ""}
          pkgName={TIERS.find((t) => t.key === draft.tier)?.name || ""}
          color={draft.color}
          sides={sides}
          feet={Number(fd.linear_feet) || 0}
          total={total}
          date={day}
          notes={draft.notes}
          staff
          onClose={() => setPreview(false)}
        />
      ) : null}
    </Panel>
  );
}
