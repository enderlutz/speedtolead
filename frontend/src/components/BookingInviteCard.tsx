// The booking invite, on the lead (Alan, 2026-10-14). Pick the day we're
// aiming for, the package and colour, add a note (say, the pergola range
// from the call), preview it, and send it: one link by text, and by email
// when there's an address. Their page says "held" until the $250 deposit is
// paid and "confirmed" by itself after.
import { useEffect, useMemo, useState } from "react";
import { CalendarCheck, Copy, ExternalLink, Eye, Mail, Save, Send, X } from "lucide-react";
import { toast } from "sonner";
import { api, type BookingState, type LeadDetail } from "@/lib/api";
import { Panel } from "@/components/Panel";
import { ACCENT } from "@/lib/accents";
import { sidesInWords } from "@/lib/fenceSides";
import { cn, formatCurrency } from "@/lib/utils";
import { BookingInvite } from "@/components/proposal/BookingInvite";
import { Chips, Counter, FencePart, type FencePartKey } from "@/components/proposal/Repairs";
import { PICKETS, PARTS, POSTS, repairLines, repairsTotal } from "@/lib/repairs";

type Tier = "essential" | "signature" | "legacy";
/** "none": no fence staining, only other services (Alan, 2026-10-21, Teila). */
type Pick = Tier | "none";
const NONE_NAME = "No fence staining";
const tierName = (k: string) => (k === "none" ? NONE_NAME : TIERS.find((t) => t.key === k)?.name || "");
type Draft = {
  date: string; tier: Pick; color: string; notes: string; klarna: boolean;
  /** A discount: dollars or a percent off the package, and why. */
  dtype: "amount" | "percent"; dval: string; dlabel: string;
  /** Repairs agreed on the phone: the proposal's counters, same prices. */
  counts: Record<string, number>; picketType: string; postType: string;
  /** A discount on the repairs alone. */
  rtype: "amount" | "percent"; rval: string; rlabel: string;
  /** Other services booked with the fence (Alan, 2026-10-16), price as typed. */
  services: { name: string; price: string; description: string }[];
  /** Which estimate's prices; "" = the default (the one they closed on). */
  estimateId: string;
};
// One tap adds the line; the price is typed (it comes from their estimate).
const SERVICE_PICKS = ["House soft wash", "Driveway, walkways & front porch", "Back patio cleaning", "Gutter cleaning", "Window cleaning", "Roof soft wash"];
const TIERS: { key: Tier; name: string }[] = [
  { key: "essential", name: "Essential Seal" },
  { key: "signature", name: "Signature Finish" },
  { key: "legacy", name: "Legacy Finish" },
];
const COLORS = ["Redwood Naturaltone", "Cedar Naturaltone", "Simply Cedar", "Pecan", "Redwood", "Cottage Gray", "Monticello Tan", "Dark Walnut", "Chocolate Chips"];
const NOTE_HINT = "e.g. The pergola would be about $750 to $950 more. We'd just need a closer look at it on the day.";
const LINK = "[link]";
// The day is filled in from the booking as it sends, so the text can never
// name a different day than their page (Alan, 2026-10-15).
const DAY = "[day]";
const isoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** The next two weeks as tap targets, weekday on each, so a day is never
 *  picked off the iPhone wheel by mistake. */
/** "Oct 17, 2:13 PM" in Houston time. */
function shortWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function nextDays(n = 14): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = 1; i <= n; i++) { d.setDate(d.getDate() + 1); out.push(isoOf(d)); }
  return out;
}

function nextThursday(): string {
  const d = new Date();
  d.setDate(d.getDate() + (((4 - d.getDay() + 7) % 7) || 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const blank = (): Draft => ({ date: nextThursday(), tier: "signature", color: "", notes: "", klarna: false, dtype: "amount", dval: "", dlabel: "", counts: {}, picketType: PICKETS[0].key, postType: POSTS[0].key, rtype: "amount", rval: "", rlabel: "", services: [], estimateId: "" });

/** The discount in dollars, the same rule as the server: never the whole price. */
function discountOff(price: number, d: Draft): number {
  const v = Number(d.dval) || 0;
  if (!price || v <= 0) return 0;
  const off = d.dtype === "percent" ? Math.round(price * v) / 100 : v;
  return Math.max(0, Math.min(Math.round(off * 100) / 100, price - 1));
}
const longDay = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
const when = (iso?: string | null) => iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" }) : "";

export function BookingInviteCard({ lead }: { lead: LeadDetail }) {
  const first = (lead.contact_name || "").split(" ")[0] || "them";
  const [draft, setDraft] = useState<Draft>(blank);
  const [st, setSt] = useState<BookingState | null>(null);
  const [busy, setBusy] = useState<null | "save" | "send" | "clear" | "cancel" | "update">(null);
  const [preview, setPreview] = useState(false);
  // "Their page", inside the dashboard: a new tab on a phone's home-screen
  // app had no way back (Alan, 2026-10-14).
  const [previewSent, setPreviewSent] = useState(false);
  const [open, setOpen] = useState(false);
  // The text: the preset follows the date until someone edits it.
  const [msg, setMsg] = useState("");
  const [msgEdited, setMsgEdited] = useState(false);
  const [email, setEmail] = useState(true);

  // Paid already (a deposit from Payment links counts): confirm the day,
  // don't ask for the deposit again (Alan, 2026-10-17, Charlotte).
  const svcWords = (() => {
    const n = draft.services.map((x) => x.name.trim().toLowerCase()).filter(Boolean);
    return n.length ? n.length === 1 ? n[0] : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}` : "service";
  })();
  // The deposit is never more than a small services-only job (same as the server).
  const svcDeposit = (() => {
    const sum = draft.services.reduce((t, x) => t + (x.name.trim() ? Number(x.price) || 0 : 0), 0);
    return sum > 0 && sum < 250 ? formatCurrency(sum) : "$250";
  })();
  const presetFor = () => draft.tier === "none"
    ? st?.deposit_paid
      ? `Hi ${first}, it's Alan with Sterling. Your payment is in, so you're booked for ${DAY} for your ${svcWords}. Here's your booking and what's left to pay: ${LINK}`
      : `Hi ${first}, it's Alan with Sterling. I'm holding ${DAY} for your ${svcWords}. Here's your booking, and the ${svcDeposit} deposit locks it in: ${LINK}`
    : st?.deposit_paid
    ? `Hi ${first}, it's Alan with Sterling Fence Staining. Your ${st.deposit_paid.kind === "full" ? "payment" : "$250 deposit"} is in, so you're booked for ${DAY}. Here's your booking with your package, color and what's left to pay: ${LINK}`
    : `Hi ${first}, it's Alan with Sterling Fence Staining. I'm holding ${DAY} for your fence. Here's your booking, and the $250 deposit locks it in: ${LINK}`;

  useEffect(() => {
    let alive = true;
    api.getBooking(lead.id).then((s) => {
      if (!alive) return;
      setSt(s);
      const d = s.draft;
      if (d?.updated_at || s.booking) setOpen(true);
      if (d?.updated_at) setDraft((x) => ({
        date: d.date || x.date, tier: (d.tier || x.tier) as Pick, color: d.color || "", notes: d.notes || "", klarna: !!d.klarna,
        dtype: d.discount_type === "percent" ? "percent" : "amount", dval: d.discount_value ? String(d.discount_value) : "", dlabel: d.discount_label || "",
        counts: d.repair_counts || {}, picketType: d.picket_type || PICKETS[0].key, postType: d.post_type || POSTS[0].key,
        rtype: d.repairs_discount_type === "percent" ? "percent" : "amount", rval: d.repairs_discount_value ? String(d.repairs_discount_value) : "", rlabel: d.repairs_discount_label || "",
        services: (d.services || []).map((x) => ({ name: x.name, price: String(x.price), description: x.description || "" })),
        estimateId: d.estimate_id || "",
      }));
    }).catch(() => { /* nothing saved yet */ });
    return () => { alive = false; };
  }, [lead.id]);
  const text = msgEdited ? msg : presetFor();

  // Every estimate that has prices, newest first. A lead can get more than
  // one (Charlotte: $2,160, then $1,734 after a side came off), so the office
  // picks; with no pick, the one they closed on, then the newest sent, the
  // same rule as the server.
  const priceSets = useMemo(() => [...(lead.estimates || [])]
    .filter((e) => e.tiers && e.tiers.essential && e.tiers.signature && e.tiers.legacy)
    .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "")), [lead.estimates]);
  const defaultSet = priceSets.find((e) => e.status === "closed") || priceSets.find((e) => e.status === "sent") || priceSets[0];
  const chosenSet = priceSets.find((e) => e.id === draft.estimateId) || defaultSet;
  const tiers = (chosenSet?.tiers as Record<string, number> | undefined) || null;
  const fd = (lead.form_data || {}) as Record<string, unknown>;
  const rawSides = fd.fence_sides;
  const sides = sidesInWords(Array.isArray(rawSides) ? (rawSides as string[]) : rawSides ? String(rawSides).split(",").map((v) => v.trim()) : []);
  const noFence = draft.tier === "none";
  const price = noFence ? 0 : tiers?.[draft.tier] || 0;
  const off = noFence ? 0 : discountOff(price, draft);
  const lines = noFence ? [] : repairLines(draft.counts, draft.picketType, draft.postType);
  const repairs = repairsTotal(lines);
  // The repairs discount, the same rule as the server: up to all of the repairs.
  const roff = (() => {
    const v = Number(draft.rval) || 0;
    if (!repairs || v <= 0) return 0;
    const o = draft.rtype === "percent" ? Math.round(repairs * Math.min(v, 100)) / 100 : v;
    return Math.min(Math.round(o * 100) / 100, repairs);
  })();
  const serviceLines = draft.services.map((x) => ({ name: x.name.trim(), price: Math.round((Number(x.price) || 0) * 100) / 100, description: x.description.trim() }))
    .filter((x) => x.name && x.price > 0);
  const servicesSum = serviceLines.reduce((t, x) => t + x.price, 0);
  const total = Math.round((price - off + repairs - roff + servicesSum) * 100) / 100;
  const setService = (i: number, patch: Partial<{ name: string; price: string; description: string }>) =>
    setDraft((d) => ({ ...d, services: d.services.map((x, k) => (k === i ? { ...x, ...patch } : x)) }));
  const [repairsOpen, setRepairsOpen] = useState(false);
  const bump = (key: string, by: number) =>
    setDraft((d) => ({ ...d, counts: { ...d.counts, [key]: Math.max(0, (d.counts[key] || 0) + by) } }));
  const saved = st?.draft?.updated_at ? st.draft : null;
  const pickedId = chosenSet && chosenSet.id !== defaultSet?.id ? chosenSet.id : "";
  const changed = !saved || saved.date !== draft.date || saved.tier !== draft.tier || (saved.estimate_id || "") !== pickedId || (saved.color || "") !== draft.color || (saved.notes || "") !== draft.notes || !!saved.klarna !== draft.klarna
    || (saved.discount_value || 0) !== (Number(draft.dval) || 0)
    || ((saved.discount_value ? saved.discount_type : "") || "") !== (Number(draft.dval) ? draft.dtype : "")
    || (saved.discount_label || "") !== (Number(draft.dval) ? draft.dlabel : "")
    || JSON.stringify((saved.repairs || []).map((r) => [r.name, r.qty, r.unit_price])) !== JSON.stringify(lines.map((r) => [r.name, r.qty, r.unit_price]))
    || (saved.repairs_discount_value || 0) !== (roff ? Number(draft.rval) || 0 : 0)
    || (saved.repairs_discount_label || "") !== (roff ? draft.rlabel : "")
    || ((saved.repairs_discount_value ? saved.repairs_discount_type : "") || "") !== (roff ? draft.rtype : "")
    || JSON.stringify((saved.services || []).map((x) => [x.name, x.price, x.description || ""])) !== JSON.stringify(serviceLines.map((x) => [x.name, x.price, x.description]));
  const sent = st?.booking || null;
  // The card says something different from what they have: a different day,
  // package, price or note. Lights up "Update without texting".
  const draftDiffersFromSent = !!sent && (sent.date !== draft.date || sent.tier !== draft.tier
    || Math.abs((sent.total || 0) - total) > 0.005 || (sent.notes || "") !== draft.notes || (sent.color || "") !== draft.color || sent.klarna !== draft.klarna);

  const save = async () => {
    const d = await api.saveBookingDraft(lead.id, {
      date: draft.date, tier: draft.tier, color: draft.color, notes: draft.notes, klarna: draft.klarna,
      discount_type: Number(draft.dval) ? draft.dtype : "", discount_value: Number(draft.dval) || 0,
      discount_label: Number(draft.dval) ? draft.dlabel : "",
      repairs: lines.map(({ name, qty, unit_price }) => ({ name, qty, unit_price })),
      repair_counts: draft.counts, picket_type: draft.picketType, post_type: draft.postType,
      repairs_discount_type: roff ? draft.rtype : "", repairs_discount_value: roff ? Number(draft.rval) || 0 : 0,
      repairs_discount_label: roff ? draft.rlabel : "",
      services: serviceLines,
      estimate_id: pickedId,
    });
    setSt((s) => (s ? { ...s, draft: d } : s));
    return d;
  };
  const onSave = async () => {
    setBusy("save");
    try { await save(); toast.success("Draft saved"); } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't save"); } finally { setBusy(null); }
  };
  const onClear = async () => {
    if (!window.confirm(`Clear this booking draft for ${lead.contact_name || "this lead"}?${sent ? " The invite already sent stays as it is; cancel it separately." : ""}`)) return;
    setBusy("clear");
    try {
      await api.clearBookingDraft(lead.id);
      setSt((s) => (s ? { ...s, draft: {} } : s));
      setDraft(blank()); setMsgEdited(false);
      toast.success("Draft cleared");
    } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't clear"); } finally { setBusy(null); }
  };
  const onSend = async () => {
    if (!text.includes(LINK)) { toast.error("Keep [link] in the text so they can open their booking."); return; }
    // Say the day out loud before anything goes (Exolei got "October 24"
    // after the day was changed, Alan, 2026-10-15).
    const when = longDay(draft.date);
    const mentions = text.includes(DAY) || text.toLowerCase().includes(when.toLowerCase());
    if (!window.confirm(`Text ${first} the booking for ${when}?${mentions ? "" : `\n\nYour text doesn't say ${when}. Put [day] back in, or check the day you typed.`}`)) return;
    setBusy("send");
    try {
      if (changed) await save();
      const out = await api.sendBooking(lead.id, text, email && !!st?.has_email);
      setSt(out);
      toast.success(`Sent to ${first} by text${out.emailed ? " and email" : ""}${out.calendar ? ", and it's on your Google Calendar" : ""}`);
      if (!out.calendar) toast.warning("It didn't go on your Google Calendar. Check Google is connected in Settings.");
    } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't send"); } finally { setBusy(null); }
  };
  // Fix a sent booking (wrong day, a price) without texting them: their page
  // and the calendar change, nothing goes out (Alan, 2026-10-15).
  const onUpdate = async () => {
    setBusy("update");
    try {
      if (changed) await save();
      const out = await api.updateBooking(lead.id);
      setSt(out);
      toast.success(`Updated${out.booking ? ` to ${longDay(out.booking.date)}` : ""}. Their page and your calendar changed. Nothing was texted.`);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't update"); } finally { setBusy(null); }
  };
  const onCancel = async () => {
    if (!window.confirm(`Cancel ${first}'s booking? Their link will say it was cancelled. Nothing is texted.`)) return;
    setBusy("cancel");
    try { setSt(await api.cancelBooking(lead.id)); toast.success("Booking cancelled"); } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't cancel"); } finally { setBusy(null); }
  };
  const copy = async () => {
    if (!sent) return;
    try { await navigator.clipboard.writeText(sent.url); toast.success("Link copied"); } catch { toast.error("Couldn't copy"); }
  };

  const day = draft.date ? new Date(`${draft.date}T12:00:00`) : null;
  const sub = sent
    ? `${sent.status === "confirmed" ? "Confirmed" : "Sent · held"} · ${new Date(`${sent.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`
    : saved?.date ? `Draft · ${new Date(`${saved.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · not sent`
      : "Date held until the $250 deposit, then confirmed by itself";

  return (
    <Panel icon={CalendarCheck} title="Booking invite" sub={sub} accent={ACCENT.gold}
      collapsed={!open} onToggle={() => setOpen((v) => !v)} bodyClassName="space-y-3 p-3.5">
      {sent ? (
        <div className={cn("rounded-xl border p-3 text-sm", sent.status === "confirmed" ? "border-emerald-300 bg-emerald-50" : "border-amber-300 bg-amber-50")}>
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide", sent.status === "confirmed" ? "bg-emerald-600 text-white" : "bg-amber-500 text-white")}>
              {sent.status === "confirmed" ? "Confirmed · deposit paid" : "Held · waiting on the $250"}
            </span>
            <span className="font-semibold">{longDay(sent.date)} · {tierName(sent.tier)} {formatCurrency(sent.total)}</span>
          </div>
          <p className="mt-1.5 text-muted-foreground">
            Sent {when(sent.sent_at)}{sent.sent_by ? ` by ${sent.sent_by}` : ""}{sent.sent_count > 1 ? ` (${sent.sent_count} times)` : ""} ·{" "}
            {sent.view_count ? <span className="font-semibold text-foreground">Opened {sent.view_count}× · last {when(sent.last_viewed_at)}</span> : <span className="font-semibold text-amber-700">Not opened yet</span>}
            {sent.status !== "confirmed" ? ` · held to ${new Date(`${sent.hold_until}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
          </p>
          <p className={cn("mt-1 text-xs font-semibold", sent.on_calendar ? "text-emerald-700" : "text-amber-700")}>
            {sent.on_calendar ? "✓ On your Google Calendar (just you, they're not a guest)" : "Not on your Google Calendar yet. Send again to retry."}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => setPreviewSent(true)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-input bg-background px-3 text-xs font-semibold hover:bg-muted">
              <ExternalLink className="h-3.5 w-3.5" /> Their page
            </button>
            <button type="button" onClick={copy} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-input bg-background px-3 text-xs font-semibold hover:bg-muted">
              <Copy className="h-3.5 w-3.5" /> Copy link
            </button>
            <button type="button" onClick={onUpdate} disabled={busy !== null || !day || !total}
              title="Change the date or details on their page and your calendar, without texting them"
              className={cn("inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-bold disabled:opacity-50",
                draftDiffersFromSent ? "bg-ink text-gold-light" : "border border-input bg-background hover:bg-muted")}>
              <Save className="h-3.5 w-3.5" /> {busy === "update" ? "Updating…" : "Update without texting"}
            </button>
            <button type="button" onClick={onCancel} disabled={busy === "cancel"} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-rose-200 bg-background px-3 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50">
              <X className="h-3.5 w-3.5" /> Cancel booking
            </button>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
        <div className="min-w-0 text-sm sm:col-span-2">
          <p className="font-semibold">Day we're aiming for{draft.date ? <span className="ml-1.5 rounded-md bg-gold/20 px-2 py-0.5 font-bold text-bronze">{longDay(draft.date)}</span> : null}</p>
          {/* Tap a day: the weekday is on every button. */}
          <div className="mt-1.5 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {nextDays().map((iso) => {
              const d = new Date(`${iso}T12:00:00`);
              const on = draft.date === iso;
              const weekend = d.getDay() === 0 || d.getDay() === 6;
              return (
                <button key={iso} type="button" onClick={() => setDraft({ ...draft, date: iso })}
                  className={cn("flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-xl border text-center leading-tight",
                    on ? "border-bronze bg-ink text-gold-light" : weekend ? "border-gold/50 bg-gold/10" : "border-input bg-background")}>
                  <span className="text-[11px] font-bold uppercase">{d.toLocaleDateString("en-US", { weekday: "short" })}</span>
                  <span className="text-lg font-bold tabular-nums">{d.getDate()}</span>
                </button>
              );
            })}
          </div>
          <label className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            Another day:
            <input type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })}
              className="h-9 rounded-lg border border-input bg-background px-2 text-sm" />
          </label>
        </div>
        {noFence ? null : <label className="block text-sm">
          <span className="font-semibold">Color</span>
          <input list="booking-colors" value={draft.color} placeholder="Pick or type a color" onChange={(e) => setDraft({ ...draft, color: e.target.value })}
            className="mt-1 h-11 w-full rounded-lg border border-input bg-background px-3 text-base" />
          <datalist id="booking-colors">{COLORS.map((c) => <option key={c} value={c} />)}</datalist>
        </label>}
      </div>
      <div>
        {priceSets.length > 1 && !noFence ? (
          <div className="mb-3">
            <p className="text-sm font-semibold">Which estimate? <span className="font-normal text-muted-foreground">({priceSets.length} sent)</span></p>
            <div className="mt-1 space-y-1.5">
              {priceSets.map((e) => {
                const on = chosenSet?.id === e.id;
                return (
                  <button key={e.id} type="button" onClick={() => setDraft({ ...draft, estimateId: e.id })}
                    className={cn("flex min-h-11 w-full flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg border px-3 py-2 text-left text-sm",
                      on ? "border-bronze bg-gold/15 ring-1 ring-gold" : "border-input hover:bg-muted")}>
                    <span className="font-semibold">{shortWhen(e.sent_at || e.created_at)}{e.label ? ` · ${e.label}` : ""}</span>
                    {e.status === "closed" ? <span className="rounded bg-emerald-100 px-1.5 text-xs font-semibold text-emerald-800">Closed on this</span> : null}
                    <span className="tabular-nums text-muted-foreground">
                      {TIERS.map((t) => `${t.name} ${formatCurrency(e.tiers[t.key])}`).join(" · ")}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        <p className="text-sm font-semibold">Package</p>
        <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {TIERS.map((t) => (
            <button key={t.key} type="button" onClick={() => setDraft({ ...draft, tier: t.key })}
              className={cn("rounded-lg border px-2 py-2 text-left text-sm", draft.tier === t.key ? "border-bronze bg-gold/15 font-semibold ring-1 ring-gold" : "border-input hover:bg-muted")}>
              <span className="block">{t.name}</span>
              <span className="block tabular-nums text-muted-foreground">{tiers?.[t.key] ? formatCurrency(tiers[t.key]) : "No price yet"}</span>
            </button>
          ))}
          {/* Not doing the fence, only other services (Teila, 2026-10-21):
              the invite drops the package, colour, sides and proposal. */}
          <button type="button" onClick={() => setDraft({ ...draft, tier: "none" })}
            className={cn("rounded-lg border px-2 py-2 text-left text-sm", noFence ? "border-bronze bg-gold/15 font-semibold ring-1 ring-gold" : "border-dashed border-input hover:bg-muted")}>
            <span className="block">{NONE_NAME}</span>
            <span className="block text-muted-foreground">Other services only</span>
          </button>
        </div>
        {noFence ? <p className="mt-1.5 text-sm text-muted-foreground">Their invite shows only the services below. No package, color, sides or proposal.</p> : null}
      </div>
      {/* A discount on the package (Alan, 2026-10-15). They see it on the
          invite, and the deposit, balance and Klarna all use the new total. */}
      {noFence ? null : <div className="rounded-xl border border-input p-3">
        <p className="text-sm font-semibold">Discount <span className="font-normal text-muted-foreground">(optional)</span></p>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-lg border border-input">
            {(["amount", "percent"] as const).map((t) => (
              <button key={t} type="button" onClick={() => setDraft({ ...draft, dtype: t })}
                className={cn("h-11 w-11 text-base font-bold", draft.dtype === t ? "bg-ink text-gold-light" : "bg-background text-muted-foreground")}>
                {t === "amount" ? "$" : "%"}
              </button>
            ))}
          </div>
          <input inputMode="decimal" value={draft.dval} placeholder={draft.dtype === "percent" ? "10" : "100"}
            onChange={(e) => setDraft({ ...draft, dval: e.target.value.replace(/[^0-9.]/g, "") })}
            className="h-11 w-24 rounded-lg border border-input bg-background px-3 text-base tabular-nums" />
          <input value={draft.dlabel} maxLength={60} placeholder="Why, e.g. Returning customer"
            onChange={(e) => setDraft({ ...draft, dlabel: e.target.value })}
            className="h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-base" />
        </div>
        {off ? (
          <p className="mt-2 text-sm">
            <span className="text-muted-foreground line-through">{formatCurrency(price)}</span>
            <span className="mx-1.5 font-semibold text-emerald-700">− {formatCurrency(off)}</span>
            = <span className="font-bold">{formatCurrency(price - off)}</span>
            <span className="text-muted-foreground"> for the package</span>
          </p>
        ) : null}
      </div>}

      {/* Repairs, folded: most jobs need none. The proposal's own counters
          and prices, so what's agreed on the phone matches what they'd have
          picked themselves (Alan, 2026-10-15). */}
      {noFence ? null : <div className="overflow-hidden rounded-xl border border-input">
        <button type="button" onClick={() => setRepairsOpen((v) => !v)}
          className="flex min-h-12 w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm">
          <span><span className="font-semibold">Repairs</span> <span className="text-muted-foreground">{lines.length ? `· ${lines.length} item${lines.length === 1 ? "" : "s"} · + ${formatCurrency(repairs - roff)}${roff ? ` (${formatCurrency(roff)} off)` : ""}` : "· any pickets, posts or boards to replace?"}</span></span>
          <span className="text-xs font-semibold text-muted-foreground">{repairsOpen ? "Close" : lines.length ? "Change" : "Add"}</span>
        </button>
        {repairsOpen ? (
          <div className="space-y-2.5 border-t bg-white p-3 text-[#15130F]">
            <Counter stack label="Pickets" what="The upright boards" unit="picket" art={<FencePart part="picket" />}
              price={PICKETS.find((p) => p.key === draft.picketType)!.price} n={draft.counts.pickets || 0} onChange={(d) => bump("pickets", d)}>
              <Chips options={PICKETS} value={draft.picketType} onChange={(k) => setDraft({ ...draft, picketType: k })} />
            </Counter>
            {PARTS.map((part) => (
              <Counter stack key={part.key} label={part.label} what={part.what} unit={part.unit} art={<FencePart part={part.key as FencePartKey} />}
                price={part.price} n={draft.counts[part.key] || 0} onChange={(d) => bump(part.key, d)} />
            ))}
            <Counter stack label="Post replacement" what="The thick posts set in the ground" unit="post" art={<FencePart part="post" />}
              price={POSTS.find((p) => p.key === draft.postType)!.price} n={draft.counts.posts || 0} onChange={(d) => bump("posts", d)}>
              <Chips options={POSTS} value={draft.postType} onChange={(k) => setDraft({ ...draft, postType: k })} />
            </Counter>
            {/* A discount on the repairs alone (Alan, 2026-10-15). */}
            <div className="rounded-2xl bg-[#F8F3E7] p-3">
              <p className="text-[15px] font-bold">Repairs discount <span className="font-normal text-[#15130F]/70">(optional)</span></p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <div className="inline-flex overflow-hidden rounded-lg ring-1 ring-[#15130F]/20">
                  {(["amount", "percent"] as const).map((t) => (
                    <button key={t} type="button" onClick={() => setDraft({ ...draft, rtype: t })}
                      className={cn("h-11 w-11 text-base font-bold", draft.rtype === t ? "bg-[#15130F] text-[#E3BE63]" : "bg-white text-[#15130F]/70")}>
                      {t === "amount" ? "$" : "%"}
                    </button>
                  ))}
                </div>
                <input inputMode="decimal" value={draft.rval} placeholder={draft.rtype === "percent" ? "20" : "50"} aria-label="Repairs discount"
                  onChange={(e) => setDraft({ ...draft, rval: e.target.value.replace(/[^0-9.]/g, "") })}
                  className="h-11 w-20 rounded-lg bg-white px-3 text-base tabular-nums ring-1 ring-[#15130F]/20" />
                <input value={draft.rlabel} maxLength={60} placeholder="Why, e.g. Neighbor deal" aria-label="Repairs discount reason"
                  onChange={(e) => setDraft({ ...draft, rlabel: e.target.value })}
                  className="h-11 min-w-0 flex-1 rounded-lg bg-white px-3 text-base ring-1 ring-[#15130F]/20" />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-xl bg-[#15130F] px-4 py-3 text-white">
              <span className="text-[15px] font-semibold">Repairs</span>
              <span className="font-heading text-xl font-bold tabular-nums">
                {roff ? <span className="mr-2 text-base text-white/60 line-through">{formatCurrency(repairs)}</span> : null}
                {repairs ? `+ ${formatCurrency(repairs - roff)}` : "$0"}
              </span>
            </div>
            <button type="button" onClick={() => setRepairsOpen(false)}
              className="h-12 w-full rounded-xl bg-[#C9972F] text-base font-bold text-[#15130F]">Confirm repairs</button>
          </div>
        ) : lines.length ? (
          <ul className="space-y-0.5 border-t px-3 py-2 text-sm">
            {lines.map((l) => (
              <li key={l.key} className="flex justify-between gap-2"><span>{l.name} × {l.qty} @ {formatCurrency(l.unit_price).replace(".00", "")}</span><span className="font-semibold tabular-nums">{formatCurrency(l.qty * l.unit_price)}</span></li>
            ))}
          </ul>
        ) : null}
      </div>}
      {/* Other services booked with the fence (Alan, 2026-10-16): house wash,
          driveway, patio… Each is its own line on their page and in the
          total, so the deposit, balance and Klarna all include it. */}
      <div className={cn("space-y-2 rounded-xl border p-3", noFence && !serviceLines.length ? "border-gold ring-1 ring-gold" : "border-input")}>
        <p className="text-sm">{noFence
          ? <><span className="font-semibold">Services</span> <span className="text-muted-foreground">· what they're booking, with the price</span></>
          : <><span className="font-semibold">Other services</span> <span className="text-muted-foreground">· anything else they're booking with the fence</span></>}</p>
        <div className="flex flex-wrap gap-1.5">
          {SERVICE_PICKS.filter((n) => !draft.services.some((x) => x.name === n)).map((n) => (
            <button key={n} type="button" onClick={() => setDraft((d) => ({ ...d, services: [...d.services, { name: n, price: "", description: "" }] }))}
              className="min-h-10 rounded-full border border-input bg-background px-3 text-sm font-medium hover:bg-muted">+ {n}</button>
          ))}
          <button type="button" onClick={() => setDraft((d) => ({ ...d, services: [...d.services, { name: "", price: "", description: "" }] }))}
            className="min-h-10 rounded-full border border-dashed border-input px-3 text-sm font-medium text-muted-foreground hover:bg-muted">+ Something else</button>
        </div>
        {draft.services.map((x, i) => (
          <div key={i} className="space-y-1.5 rounded-lg bg-muted/40 p-2">
          <div className="flex items-center gap-2">
            <input value={x.name} maxLength={80} placeholder="Service" aria-label={`Service ${i + 1}`}
              onChange={(e) => setService(i, { name: e.target.value })}
              className="h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-base" />
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
              <input inputMode="decimal" value={x.price} placeholder="0.00" aria-label={`Price for service ${i + 1}`}
                onChange={(e) => setService(i, { price: e.target.value.replace(/[^0-9.]/g, "") })}
                className="h-11 w-28 rounded-lg border border-input bg-background pl-6 pr-2 text-base tabular-nums" />
            </div>
            <button type="button" aria-label={`Remove ${x.name || "service"}`} onClick={() => setDraft((d) => ({ ...d, services: d.services.filter((_, k) => k !== i) }))}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-input text-muted-foreground hover:bg-muted"><X className="h-4 w-4" /></button>
          </div>
          <textarea value={x.description} maxLength={300} rows={2} aria-label={`Description for ${x.name || "service"}`}
            placeholder="Description (optional), e.g. Soft wash all 4 sides of the house, gutters and soffits included"
            onChange={(e) => setService(i, { description: e.target.value })}
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-base" />
          </div>
        ))}
        {serviceLines.length ? <p className="text-right text-sm font-semibold tabular-nums">+ {formatCurrency(servicesSum)}</p> : null}
      </div>
      {!noFence && (off || repairs || servicesSum) ? (
        <p className="rounded-xl bg-muted/60 px-3 py-2 text-sm">
          {formatCurrency(price)} {tiers ? TIERS.find((t) => t.key === draft.tier)?.name : ""}
          {off ? <span className="text-emerald-700"> − {formatCurrency(off)} discount</span> : null}
          {repairs ? <span> + {formatCurrency(repairs)} repairs</span> : null}
          {roff ? <span className="text-emerald-700"> − {formatCurrency(roff)} repairs discount</span> : null}
          {servicesSum ? <span> + {formatCurrency(servicesSum)} other services</span> : null}
          {" "}= <span className="font-bold">{formatCurrency(total)}</span>
        </p>
      ) : null}

      <label className="block text-sm">
        <span className="font-semibold">Additional notes</span>
        <span className="ml-1 text-muted-foreground">(they see this on the invite)</span>
        <textarea value={draft.notes} maxLength={1000} rows={3} placeholder={NOTE_HINT} onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-base" />
      </label>
      {/* Klarna beside the $250 on their invite, for a customer who'd
          rather finance the whole job (Alan, 2026-10-15). */}
      <label className="flex items-center gap-3 rounded-xl border border-input px-3 py-2.5 text-sm">
        <input type="checkbox" checked={draft.klarna} onChange={(e) => setDraft({ ...draft, klarna: e.target.checked })} className="h-5 w-5 accent-[#15130F]" />
        <span className="rounded bg-[#FFB3C7] px-1.5 py-0.5 text-xs font-black text-black">Klarna.</span>
        <span><span className="font-semibold">Offer Klarna</span> <span className="text-muted-foreground">· a Klarna Apply button next to Reserve $250{total ? `, for ${formatCurrency(total)}` : ""}</span></span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setPreview(true)} disabled={!day}
          className="inline-flex h-11 items-center gap-2 rounded-lg border border-input px-4 text-sm font-semibold hover:bg-muted disabled:opacity-50">
          <Eye className="h-4 w-4" /> Preview
        </button>
        <button type="button" onClick={onSave} disabled={busy !== null || !changed}
          className="inline-flex h-11 items-center gap-2 rounded-lg border border-input px-4 text-sm font-semibold hover:bg-muted disabled:opacity-50">
          <Save className="h-4 w-4" /> {busy === "save" ? "Saving…" : changed ? "Save draft" : "Saved"}
        </button>
        {saved ? (
          <button type="button" onClick={onClear} disabled={busy !== null} title="Throw this draft away"
            className="ml-auto inline-flex h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50">
            <X className="h-4 w-4" /> Clear
          </button>
        ) : null}
      </div>

      {/* Send. The text is theirs to edit; [link] becomes their booking link. */}
      <div className="space-y-2 rounded-xl border border-gold/50 bg-gold/5 p-3">
        <p className="text-sm font-semibold">{sent ? `Send again to ${first} (same link, updated date and details)` : `Send to ${first}`}</p>
        {st?.deposit_paid ? (
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-emerald-200">
            <b>{st.deposit_paid.kind === "full" ? "Paid in full" : "Deposit already paid"}: {formatCurrency(st.deposit_paid.amount)}</b>
            {st.deposit_paid.paid_at ? ` on ${shortWhen(st.deposit_paid.paid_at)}` : ""}. This confirms {first}'s day. It won't ask for the deposit again.
          </p>
        ) : null}
        <textarea value={text} rows={5} maxLength={1400} onChange={(e) => { setMsg(e.target.value); setMsgEdited(true); }}
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-base" />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span><b>[day]</b> becomes the day you picked, <b>[link]</b> their booking link.</span>
          {msgEdited ? <button type="button" onClick={() => setMsgEdited(false)} className="font-semibold underline">Reset text</button> : null}
        </div>
        {/* Exactly what they'll read, the day filled in. */}
        <p className="rounded-lg bg-background px-3 py-2 text-xs leading-relaxed ring-1 ring-input">
          <span className="font-semibold text-muted-foreground">They'll get: </span>
          {text.split(DAY).join(draft.date ? longDay(draft.date) : "[no day picked]").split(LINK).join("estimate.sterlingfencetx.com/b/…")}
        </p>
        <label className={cn("flex items-center gap-2 text-sm", !st?.has_email && "text-muted-foreground")}>
          <input type="checkbox" checked={email && !!st?.has_email} disabled={!st?.has_email} onChange={(e) => setEmail(e.target.checked)} className="h-4 w-4" />
          <Mail className="h-4 w-4" /> {st?.has_email ? `Also email it to ${lead.contact_email}` : "No email on file, text only"}
        </label>
        <button type="button" onClick={onSend} disabled={busy !== null || !day || !total || st?.has_phone === false}
          className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-ink text-base font-bold text-gold-light disabled:opacity-50">
          <Send className="h-4 w-4" /> {busy === "send" ? "Sending…" : sent ? `Send again to ${first}` : `Send to ${first}`}
        </button>
        {st?.has_phone === false ? <p className="text-xs text-rose-700">This lead has no phone number.</p> : null}
        {!total ? <p className="text-xs text-rose-700">{noFence ? "Add a service with a price first." : "No price for that package yet. Send the estimate first."}</p> : null}
      </div>
      {saved?.updated_at ? <p className="text-xs text-muted-foreground">Draft saved {when(saved.updated_at)}{saved.updated_by ? ` by ${saved.updated_by}` : ""}</p> : null}

      {preview && day ? (
        <BookingInvite
          firstName={first}
          address={lead.address || ""}
          pkgName={noFence ? "" : tierName(draft.tier)}
          servicesOnly={noFence}
          color={draft.color}
          sides={sides}
          feet={Number(fd.linear_feet) || 0}
          total={total}
          date={day}
          notes={draft.notes}
          klarna={draft.klarna}
          discount={off}
          discountLabel={draft.dlabel}
          repairs={lines}
          repairsDiscount={roff}
          repairsDiscountLabel={draft.rlabel}
          services={serviceLines}
          staff
          initial={st?.deposit_paid ? "confirmed" : undefined}
          paidAmount={st?.deposit_paid?.amount}
          onClose={() => setPreview(false)}
          onSave={changed ? () => { void onSave(); } : () => setPreview(false)}
          saveLabel={busy === "save" ? "Saving…" : changed ? "Save draft" : "Saved · close"}
        />
      ) : null}
      {previewSent && sent ? (
        <BookingInvite
          firstName={first}
          address={lead.address || ""}
          pkgName={sent.tier === "none" ? "" : tierName(sent.tier)}
          servicesOnly={sent.tier === "none"}
          color={sent.color}
          sides={sides}
          feet={Number(fd.linear_feet) || 0}
          total={sent.total}
          date={new Date(`${sent.date}T12:00:00`)}
          notes={sent.notes}
          initial={sent.status}
          holdUntilIso={sent.hold_until}
          klarna={sent.klarna}
          discount={sent.discount}
          discountLabel={sent.discount_label}
          repairs={sent.repairs}
          repairsDiscount={sent.repairs_discount}
          repairsDiscountLabel={sent.repairs_discount_label}
          services={sent.services || []}
          staff
          onClose={() => setPreviewSent(false)}
          onSave={() => setPreviewSent(false)}
          saveLabel="Done"
        />
      ) : null}
    </Panel>
  );
}
