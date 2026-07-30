import { useEffect, useMemo, useState } from "react";
import { api, getCurrentUser, type Employee, type ScheduledJob, type Lead, type NearbyJob, type ServiceCatalogItem } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { X, Calendar, Loader2, Users, Plus, AlertTriangle, MapPin, Pencil, Sparkles, Eye, Wrench } from "lucide-react";
import ServiceDescriptionsModal from "@/components/ServiceDescriptionsModal";

// Stain color list — placeholder. Final list comes from Alan tomorrow.
const STAIN_COLORS = [
  "Natural", "Cedar", "Honey Gold", "Redwood",
  "Mahogany", "Walnut", "Dark Oak", "Ebony",
];

// One-time nudge (admin only) pointing Alan at the Service Descriptions editor
// the first time he opens the schedule flow after the line-items launch.
const SERVICE_INTRO_KEY = "serviceLineItemsIntroSeen_v1";

// Editor-local shape for a service line — price is a string while typing so
// decimals aren't clobbered; it's parsed to a number on save.
interface ServiceLine {
  key: string;
  label: string;
  price: string;
  description: string;
}

const inputCls = "w-full border border-input rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring";
const labelCls = "text-xs font-semibold text-muted-foreground";

interface Props {
  lead: Lead;
  existing?: ScheduledJob | null;
  /** Phase 3 (2026-06-08) — pre-selected date from CalendarGlimpse. When
   *  provided on a NEW job, the date input starts here instead of the
   *  default "one week from today". Ignored when editing an existing job. */
  initialDate?: string;
  onClose: () => void;
  onSaved: () => void;
}

export default function ScheduleJobModal({ lead, existing, initialDate, onClose, onSaved }: Props) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [saving, setSaving] = useState(false);

  // Defaults — existing job wins, then CalendarGlimpse pre-pick, then "one
  // week from today" as the safety fallback.
  const defaultDate = useMemo(() => {
    if (existing) return existing.job_date;
    if (initialDate) return initialDate;
    const t = new Date();
    t.setDate(t.getDate() + 7);
    return t.toISOString().slice(0, 10);
  }, [existing, initialDate]);

  const [jobDate, setJobDate] = useState(existing?.job_date || defaultDate);
  const [arrivalTime, setArrivalTime] = useState(existing?.arrival_time || "07:30");
  const [duration, setDuration] = useState(String(existing?.estimated_duration_hours || 6));
  // Invoice-style service line items. Init order: saved services on the job →
  // legacy migration (one line from package_tier + closed_price) → a single
  // blank line to fill in.
  const [serviceLines, setServiceLines] = useState<ServiceLine[]>(() => {
    if (existing?.services && existing.services.length > 0) {
      return existing.services.map((s) => ({
        key: s.key,
        label: s.label,
        price: s.price ? String(s.price) : "",
        description: s.description || "",
      }));
    }
    if (existing && (existing.package_tier || existing.closed_price)) {
      return [{
        key: existing.package_tier || "",
        label: "",
        price: existing.closed_price ? String(existing.closed_price) : "",
        description: "",
      }];
    }
    return [{ key: "", label: "", price: "", description: "" }];
  });
  // Service catalog (labels + default descriptions) + per-tier prices pulled
  // from the lead's estimate, used to prefill a line when a tier is picked.
  const [catalog, setCatalog] = useState<ServiceCatalogItem[]>([]);
  const [tierPrices, setTierPrices] = useState<Record<string, number>>({});
  const [showDescEditor, setShowDescEditor] = useState(false);
  const [showIntro, setShowIntro] = useState(false);
  // Defaults OFF on brand-new jobs — admin opts in per-job. Existing rows
  // respect whatever was saved (undefined treated as off so legacy rows
  // don't surprise-flip on first edit).
  const [plusTax, setPlusTax] = useState(
    existing ? !!existing.closed_price_plus_tax : false,
  );
  // Optional override for the proposal URL on the customer invite. Blank
  // → backend auto-resolves from the lead's latest Proposal row.
  const [customProposalUrl, setCustomProposalUrl] = useState(
    existing?.custom_proposal_url || "",
  );

  // Fence-sides override: admin checks the sides the crew will actually
  // stain (defaults to whatever the lead's proposal listed). Useful when
  // the customer drops a side post-sale. Backend stores selected as CSV
  // in fence_sides_override; if non-empty it beats the lead-data lookup.
  //
  // availableSides is the union of (lead form_data sides ∪ override),
  // so an override referencing a side the lead no longer carries still
  // renders a checkbox the admin can act on.
  const leadFenceSides = useMemo<string[]>(() => {
    const raw = (lead.form_data as Record<string, unknown> | undefined)?.fence_sides;
    if (!raw) return [];
    if (Array.isArray(raw)) return (raw as unknown[]).map(String).filter(Boolean);
    const s = String(raw).trim();
    if (!s) return [];
    // JSON-array string? ("[\"Inside Fences\",\"Back\"]")
    if (s.startsWith("[")) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
      } catch { /* fall through to CSV */ }
    }
    return s.split(",").map((x) => x.trim()).filter(Boolean);
  }, [lead.form_data]);
  const initialOverrideSides = useMemo<string[]>(() => {
    const csv = (existing?.fence_sides_override || "").trim();
    if (!csv) return [];
    return csv.split(",").map((s) => s.trim()).filter(Boolean);
  }, [existing?.fence_sides_override]);
  const availableSides = useMemo<string[]>(() => {
    // Always show the full 8 standard sides (4 inside, 4 outside) so the
    // admin can add sides that weren't on the original proposal — e.g.
    // the customer agreed to add Inside Left after the quote. Anything
    // non-standard from the lead's form_data or a saved override is
    // appended after, deduped, in the order it appeared.
    const STANDARD: string[] = [
      "Inside Front", "Inside Left", "Inside Back", "Inside Right",
      "Outside Front", "Outside Left", "Outside Back", "Outside Right",
    ];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of [...STANDARD, ...leadFenceSides, ...initialOverrideSides]) {
      const t = s.trim();
      if (t && !seen.has(t)) { seen.add(t); out.push(t); }
    }
    return out;
  }, [leadFenceSides, initialOverrideSides]);
  // Initial selection: if this is an existing job with an override, use
  // exactly that. Otherwise (new job, or no override saved), pre-check
  // every lead side so the admin starts from "as proposed."
  const [selectedSides, setSelectedSides] = useState<Set<string>>(() => {
    if (initialOverrideSides.length > 0) return new Set(initialOverrideSides);
    return new Set(leadFenceSides);
  });
  const toggleSide = (s: string) =>
    setSelectedSides((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  const [additionalSides, setAdditionalSides] = useState(
    existing?.additional_sides_text || "",
  );
  // Stable serialization for the payload — keep availableSides order so
  // the rendered string matches what the admin saw checked top-to-bottom.
  const fenceSidesOverrideCsv = availableSides.filter((s) => selectedSides.has(s)).join(", ");
  // Color picker is now a list — admin can add multiple colors via "+ Add"
  // when the customer wants samples. Backend column is still a single text
  // field; we join with ", " on save and split on ", " on load.
  const [colors, setColors] = useState<string[]>(() => {
    const raw = existing?.color_choice || "";
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    return parts.length > 0 ? parts : [""];
  });
  const updateColor = (i: number, v: string) =>
    setColors((prev) => prev.map((c, idx) => (idx === i ? v : c)));
  const addColor = () => setColors((prev) => [...prev, ""]);
  const removeColor = (i: number) =>
    setColors((prev) => (prev.length === 1 ? [""] : prev.filter((_, idx) => idx !== i)));
  const colorChoiceJoined = colors.map((c) => c.trim()).filter(Boolean).join(", ");
  const [needsTestSpots, setNeedsTestSpots] = useState(!!existing?.needs_test_spots);
  // Gallons + bleach default to blank, NOT "0" — the crew fills these in
  // from the My Day card after the job's done, so an admin scheduling
  // shouldn't be forced to guess upfront.
  const [gallons, setGallons] = useState(
    existing?.gallons_estimate ? String(existing.gallons_estimate) : "",
  );
  const [bleach, setBleach] = useState(
    existing?.bleach_gallons ? String(existing.bleach_gallons) : "",
  );
  const [address, setAddress] = useState(existing?.address || lead.address || "");
  const [zip, setZip] = useState(existing?.zip_code || lead.zip_code || "");
  const [customerName, setCustomerName] = useState(existing?.customer_name || lead.contact_name || "");
  const [customerEmail, setCustomerEmail] = useState(existing?.customer_email || lead.contact_email || "");
  const [customerPhone, setCustomerPhone] = useState(existing?.customer_phone || lead.contact_phone || "");
  // Legacy single-field description — kept for back-compat with older rows that
  // were saved before the worker/customer split. New jobs leave this empty and
  // use the two split fields below instead.
  const [jobDescription, setJobDescription] = useState(existing?.job_description || "");
  const [workerNotes, setWorkerNotes] = useState(existing?.worker_notes || "");
  const [customerNotes, setCustomerNotes] = useState(existing?.customer_notes || "");
  const [adminNotes, setAdminNotes] = useState(existing?.admin_notes || "");
  const [materialsCost, setMaterialsCost] = useState(String(existing?.materials_cost || 0));
  const [materialsNotes, setMaterialsNotes] = useState(existing?.materials_notes || "");
  const [assignedIds, setAssignedIds] = useState<string[]>(existing?.assigned_employee_ids || []);
  const [sendInvite, setSendInvite] = useState(true);
  const [sendThankYou, setSendThankYou] = useState(true);

  // Sprint 3 T3.D — Route-stack candidates. Loaded once on mount; UI
  // surfaces top suggestion + the count of other nearby jobs over the
  // next 14 days. Empty state hides the strip entirely so the modal
  // stays clean when route-stacking isn't an option.
  const [nearbyJobs, setNearbyJobs] = useState<NearbyJob[]>([]);

  useEffect(() => {
    api.listCrew("this_week", false)
      .then((r) => setEmployees(r.employees))
      .catch(() => toast.error("Failed to load crew list"));
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.getNearbyJobs(lead.id, 14)
      .then((r) => { if (!cancelled) setNearbyJobs(r.nearby_jobs); })
      .catch(() => { /* silent */ });
    return () => { cancelled = true; };
  }, [lead.id]);

  // Load the service catalog (labels + editable descriptions) for the picker.
  const loadCatalog = () => api.getServiceCatalog().then((r) => setCatalog(r.services)).catch(() => { /* silent */ });
  useEffect(() => { loadCatalog(); }, []);

  // Pull the lead's estimate tier prices so picking a tier prefills its price.
  useEffect(() => {
    let cancelled = false;
    api.getLead(lead.id)
      .then((d) => {
        const t = d.estimate?.tiers;
        if (t && !cancelled) {
          setTierPrices({
            essential: t.essential || 0,
            signature: t.signature || 0,
            legacy: t.legacy || 0,
          });
        }
      })
      .catch(() => { /* silent — prices just won't prefill */ });
    return () => { cancelled = true; };
  }, [lead.id]);

  // One-time intro nudge for Alan the first time he opens the schedule flow
  // after the line-items launch, pointing him at the description editor.
  useEffect(() => {
    if (getCurrentUser()?.role === "admin" && !localStorage.getItem(SERVICE_INTRO_KEY)) {
      setShowIntro(true);
    }
  }, []);
  const dismissIntro = () => {
    localStorage.setItem(SERVICE_INTRO_KEY, "1");
    setShowIntro(false);
  };

  // --- Service line editing ---
  const addServiceLine = () =>
    setServiceLines((prev) => [...prev, { key: "", label: "", price: "", description: "" }]);
  const removeServiceLine = (i: number) =>
    setServiceLines((prev) => (prev.length === 1 ? [{ key: "", label: "", price: "", description: "" }] : prev.filter((_, idx) => idx !== i)));
  const pickService = (i: number, key: string) =>
    setServiceLines((prev) => prev.map((l, idx) => {
      if (idx !== i) return l;
      const cat = catalog.find((c) => c.key === key);
      const label = cat?.label || key;
      // Prefill the description from the catalog default (only if the line
      // doesn't already carry a custom one), and the price from the estimate
      // when this is a staining tier and the line's price is still blank.
      const description = l.description.trim() ? l.description : (cat?.description || "");
      let price = l.price;
      if (cat?.is_tier && !l.price.trim() && tierPrices[key]) price = String(tierPrices[key]);
      return { key, label, price, description };
    }));
  const updateServicePrice = (i: number, v: string) =>
    setServiceLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, price: v } : l)));
  const updateServiceDesc = (i: number, v: string) =>
    setServiceLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, description: v } : l)));
  const servicesTotal = serviceLines.reduce((sum, l) => sum + (parseFloat(l.price) || 0), 0);
  // Build the payload: drop blank lines, coerce price to number.
  const builtServices = serviceLines
    .filter((l) => l.key)
    .map((l) => ({ key: l.key, label: l.label, price: parseFloat(l.price) || 0, description: l.description.trim() }));

  const toggleEmployee = (id: string) => {
    setAssignedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const save = async () => {
    if (!jobDate) {
      toast.error("Job date is required");
      return;
    }
    if (!address.trim()) {
      toast.error("Address is required");
      return;
    }
    setSaving(true);
    try {
      if (existing) {
        await api.updateScheduledJob(existing.id, {
          job_date: jobDate,
          arrival_time: arrivalTime,
          estimated_duration_hours: parseFloat(duration) || 6,
          services: builtServices,
          closed_price_plus_tax: plusTax,
          custom_proposal_url: customProposalUrl.trim(),
          fence_sides_override: fenceSidesOverrideCsv,
          additional_sides_text: additionalSides.trim(),
          color_choice: colorChoiceJoined,
          needs_test_spots: needsTestSpots,
          gallons_estimate: parseFloat(gallons) || 0,
          bleach_gallons: parseFloat(bleach) || 0,
          address,
          zip_code: zip,
          customer_email: customerEmail,
          customer_phone: customerPhone,
          customer_name: customerName,
          job_description: jobDescription,
          worker_notes: workerNotes,
          customer_notes: customerNotes,
          admin_notes: adminNotes,
          materials_cost: parseFloat(materialsCost) || 0,
          materials_notes: materialsNotes,
          employee_ids: assignedIds,
        });
        toast.success("Job updated");
      } else {
        await api.createScheduledJob({
          lead_id: lead.id,
          job_date: jobDate,
          arrival_time: arrivalTime,
          estimated_duration_hours: parseFloat(duration) || 6,
          services: builtServices,
          closed_price_plus_tax: plusTax,
          custom_proposal_url: customProposalUrl.trim(),
          fence_sides_override: fenceSidesOverrideCsv,
          additional_sides_text: additionalSides.trim(),
          color_choice: colorChoiceJoined,
          needs_test_spots: needsTestSpots,
          gallons_estimate: parseFloat(gallons) || 0,
          bleach_gallons: parseFloat(bleach) || 0,
          address,
          zip_code: zip,
          customer_email: customerEmail,
          customer_phone: customerPhone,
          customer_name: customerName,
          job_description: jobDescription,
          worker_notes: workerNotes,
          customer_notes: customerNotes,
          admin_notes: adminNotes,
          materials_cost: parseFloat(materialsCost) || 0,
          materials_notes: materialsNotes,
          employee_ids: assignedIds,
          send_thank_you: sendThankYou,
          send_calendar_invite: sendInvite,
        });
        toast.success("Job scheduled — customer + crew notified");
      }
      onSaved();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-background rounded-lg shadow-xl w-full max-w-2xl max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Calendar className="h-5 w-5 text-primary" />
            {existing ? "Edit Scheduled Job" : "Schedule Job"}
          </h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Sprint 3 T3.D — Route-stack suggestion. Shown only when nearby
              jobs exist for the next 14 days. Two states:
                - Top pick same-ZIP → green callout with one-click date fill
                - Nearby-only → muted info note (still useful awareness) */}
          {nearbyJobs.length > 0 && (() => {
            const top = nearbyJobs[0];
            const others = nearbyJobs.length - 1;
            if (top.same_zip) {
              return (
                <div className="rounded-md border border-emerald-300 bg-emerald-50 p-2.5 flex items-start gap-2">
                  <MapPin className="h-4 w-4 text-emerald-700 mt-0.5 shrink-0" />
                  <div className="flex-1 text-sm">
                    <span className="font-semibold text-emerald-900">💡 Route-stack:</span>{" "}
                    <span>
                      We're already at <span className="font-semibold">{top.customer_name || top.address}</span>
                      {top.distance_miles !== null && <> ({top.distance_miles} mi)</>} on {top.job_date}.
                    </span>
                    {others > 0 && (
                      <span className="text-xs text-emerald-800 ml-1">+ {others} more nearby this window.</span>
                    )}
                  </div>
                  {jobDate !== top.job_date && (
                    <Button size="sm" variant="outline" onClick={() => setJobDate(top.job_date)}>
                      Use this date
                    </Button>
                  )}
                </div>
              );
            }
            return (
              <div className="rounded-md border border-cyan-300 bg-cyan-50 p-2.5 text-sm flex items-start gap-2">
                <MapPin className="h-4 w-4 text-cyan-700 mt-0.5 shrink-0" />
                <div className="text-cyan-900">
                  {nearbyJobs.length} nearby job{nearbyJobs.length === 1 ? "" : "s"} already scheduled in this window
                  {top && (
                    <> — closest: {top.customer_name || top.address}
                    {top.distance_miles !== null && <> ({top.distance_miles} mi)</>} on {top.job_date}</>
                  )}.
                </div>
              </div>
            );
          })()}

          {/* Schedule */}
          <section>
            <h3 className="text-sm font-semibold mb-2">Schedule</h3>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className={labelCls}>Job Date</label>
                <Input type="date" value={jobDate} onChange={(e) => setJobDate(e.target.value)} className="mt-1" />
              </div>
              <div>
                <label className={labelCls}>Arrival Time</label>
                <Input type="time" value={arrivalTime} onChange={(e) => setArrivalTime(e.target.value)} className="mt-1" />
              </div>
              <div>
                <label className={labelCls}>Duration (hrs)</label>
                <Input type="number" step="0.5" value={duration} onChange={(e) => setDuration(e.target.value)} className="mt-1" />
              </div>
            </div>
          </section>

          {/* Job spec — split into a Customer view (everything here lands on
              the calendar invite) and an Operations block (internal only),
              separated by a divider. */}
          <section>
            {/* ─── Customer view ─── */}
            <div className="flex items-center gap-2 mb-3">
              <Eye className="h-4 w-4 text-emerald-600" />
              <h3 className="text-sm font-semibold">Customer view</h3>
              <span className="text-[11px] text-muted-foreground">— what the customer sees on the invite</span>
            </div>
            {/* Services — invoice-style line items. Each carries its own
                price + description; the description shows to the customer on
                the calendar invite. The three staining tiers prefill their
                price from the lead's estimate; add-on services are priced by
                hand. */}
            <div className="mb-4">
              <div className="flex items-center justify-between mb-1">
                <label className={labelCls}>Services</label>
                <button
                  type="button"
                  onClick={() => setShowDescEditor(true)}
                  className="text-[11px] text-primary hover:underline flex items-center gap-1"
                >
                  <Pencil className="h-3 w-3" /> Edit descriptions
                </button>
              </div>
              <div className="space-y-2">
                {serviceLines.map((line, i) => {
                  const cat = catalog.find((c) => c.key === line.key);
                  const isTier = !!cat?.is_tier;
                  return (
                    <div key={i} className="border border-input rounded-md p-2.5 bg-muted/20">
                      <div className="flex gap-2">
                        <select
                          value={line.key}
                          onChange={(e) => pickService(i, e.target.value)}
                          className={`${inputCls} flex-1`}
                        >
                          <option value="">— pick a service —</option>
                          {catalog.map((c) => (
                            <option key={c.key} value={c.key}>{c.label}</option>
                          ))}
                        </select>
                        <div className="relative w-28 shrink-0">
                          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            value={line.price}
                            onChange={(e) => updateServicePrice(i, e.target.value)}
                            placeholder="0.00"
                            className="pl-5"
                          />
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          onClick={() => removeServiceLine(i)}
                          aria-label="Remove service"
                          className="shrink-0"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                      {isTier && (
                        <p className="text-[10px] text-muted-foreground mt-1">
                          Tier price prefilled from the estimate — edit if needed.
                        </p>
                      )}
                      <textarea
                        value={line.description}
                        onChange={(e) => updateServiceDesc(i, e.target.value)}
                        rows={2}
                        placeholder="Description shown to the customer on the invite"
                        className={`${inputCls} mt-2 resize-none text-xs`}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="flex items-center justify-between mt-2">
                <Button type="button" variant="outline" size="sm" onClick={addServiceLine}>
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add service
                </Button>
                <span className="text-sm font-semibold">
                  Total: ${servicesTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  {plusTax ? " + Tax" : ""}
                </span>
              </div>
              <label className="flex items-center gap-1.5 text-xs mt-2 cursor-pointer text-muted-foreground">
                <input type="checkbox" checked={plusTax} onChange={(e) => setPlusTax(e.target.checked)} />
                + Tax on invite
              </label>
            </div>

            {/* Color/s — customer-facing (renders on the invite). */}
            <div className="mb-3">
              <label className={labelCls}>Color/s</label>
              <div className="space-y-1.5 mt-1">
                {colors.map((c, i) => (
                  <div key={i} className="flex gap-1.5">
                    <Input
                      list="stain-colors"
                      value={c}
                      onChange={(e) => updateColor(i, e.target.value)}
                      placeholder={i === 0 ? "Type or pick" : "Another color"}
                    />
                    {/* Remove only renders for additional rows OR when the
                        single row has content — keeps the empty initial
                        state from showing a meaningless X. */}
                    {(colors.length > 1 || c.trim()) && (
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => removeColor(i)}
                        aria-label="Remove color"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addColor}
                  className="w-full"
                >
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add color
                </Button>
              </div>
              <datalist id="stain-colors">
                {STAIN_COLORS.map((c) => <option key={c} value={c} />)}
              </datalist>
              <p className="text-[11px] text-muted-foreground mt-1">
                Leave blank if undecided — the invite will say "we'll bring colors to test."
              </p>
            </div>

            <label className="flex items-center gap-2 text-sm mt-3 cursor-pointer">
              <input type="checkbox" checked={needsTestSpots} onChange={(e) => setNeedsTestSpots(e.target.checked)} />
              Customer wants test stain patches first (same day, before final color)
            </label>

            {/* Fence sides override — check the sides the crew will stain.
                Pre-checked from the lead's proposal data. Renders on the invite
                "Sides:" line + worker view. Free-form "Additional sides" input
                catches the long tail. */}
            <div className="mt-3">
              <label className={labelCls}>Fence Sides for this Job</label>
              {availableSides.length > 0 ? (
                <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1.5">
                  {availableSides.map((side) => (
                    <label key={side} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedSides.has(side)}
                        onChange={() => toggleSide(side)}
                      />
                      <span className="break-words">{side}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground mt-1">
                  No sides on file for this lead. Use "Additional sides" below.
                </p>
              )}
              <Input
                value={additionalSides}
                onChange={(e) => setAdditionalSides(e.target.value)}
                placeholder="Additional sides (e.g. back deck rails)"
                className="mt-2"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Overrides the Sides line on the customer invite + worker view.
              </p>
            </div>

            {/* Additional notes — customer-facing (lands on the Google invite
                under the "Additional notes:" header). */}
            <div className="mt-3">
              <label className={labelCls}>Additional notes (shown to the customer on the invite)</label>
              <textarea
                value={customerNotes}
                onChange={(e) => setCustomerNotes(e.target.value)}
                rows={2}
                placeholder="e.g. We bring samples to test colors on your fence before final coats!"
                className={`${inputCls} mt-1 resize-none`}
              />
            </div>

            {/* Proposal link — customer-facing (the Estimate Link on the invite). */}
            <div className="mt-3">
              <label className={labelCls}>Custom Proposal Link (optional — overrides auto-generated)</label>
              <Input
                type="url"
                value={customProposalUrl}
                onChange={(e) => setCustomProposalUrl(e.target.value)}
                placeholder="https://proposal.atpressurewash.com/proposal/…"
                className="mt-1"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Leave blank to use the lead's most recent proposal URL automatically.
              </p>
            </div>

            {/* ═══════════ Divider — everything below is internal ═══════════ */}
            <div className="relative my-6">
              <div className="border-t-2 border-dashed border-muted-foreground/30" />
              <span className="absolute left-1/2 -translate-x-1/2 -top-2 bg-background px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1 whitespace-nowrap">
                <Wrench className="h-3 w-3" /> Operations — internal, not shown to the customer
              </span>
            </div>

            {/* Gallons — operations (PM / crew fill in). */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Stain Gallons (optional)</label>
                <Input
                  type="number"
                  step="0.1"
                  min="0"
                  value={gallons}
                  onChange={(e) => setGallons(e.target.value)}
                  placeholder="Project coordinator fills in at the start"
                  className="mt-1"
                />
              </div>
              <div>
                <label className={labelCls}>Bleach Gallons (optional)</label>
                <Input
                  type="number"
                  step="0.1"
                  min="0"
                  value={bleach}
                  onChange={(e) => setBleach(e.target.value)}
                  placeholder="Project coordinator fills in at the start"
                  className="mt-1"
                />
              </div>
            </div>

            {/* Worker notes — operations (shown to the crew, sanitized). */}
            <div className="mt-3">
              <label className={labelCls}>Worker Notes (shown to the crew — sanitized of price/proposal language)</label>
              <textarea
                value={workerNotes}
                onChange={(e) => setWorkerNotes(e.target.value)}
                rows={2}
                placeholder="e.g. Gate code 1234, dog in backyard until 10am, stain inside + outside"
                className={`${inputCls} mt-1 resize-none`}
              />
            </div>

            {/* Admin notes — operations (internal only). */}
            <div className="mt-3">
              <label className={labelCls}>Admin Notes (internal only — not on customer invite)</label>
              <textarea
                value={adminNotes}
                onChange={(e) => setAdminNotes(e.target.value)}
                rows={2}
                placeholder="Anything Olga or Alan should know"
                className={`${inputCls} mt-1 resize-none`}
              />
            </div>

            {/* Legacy single-field description — shown only when an older job
                already has it filled in, so it can be edited / migrated away. */}
            {jobDescription ? (
              <div className="mt-3">
                <label className={labelCls}>Job Description (legacy — consider moving to Worker / Customer Notes above)</label>
                <textarea
                  value={jobDescription}
                  onChange={(e) => setJobDescription(e.target.value)}
                  rows={2}
                  className={`${inputCls} mt-1 resize-none`}
                />
              </div>
            ) : null}
          </section>

          {/* Materials cost — drops directly out of gross profit on Accounting */}
          <section>
            <h3 className="text-sm font-semibold mb-2">Materials</h3>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className={labelCls}>Materials Cost ($)</label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={materialsCost}
                  onChange={(e) => setMaterialsCost(e.target.value)}
                  placeholder="0.00"
                  className="mt-1"
                />
              </div>
              <div className="col-span-2">
                <label className={labelCls}>Materials Notes</label>
                <Input
                  value={materialsNotes}
                  onChange={(e) => setMaterialsNotes(e.target.value)}
                  placeholder="e.g. 8 gal Cabot dark oak, 1 stripper"
                  className="mt-1"
                />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              Stain, sealer, brushes, etc. — what you spent on this job. Lowers margin on the Accounting page.
            </p>
          </section>

          {/* Customer */}
          <section>
            <h3 className="text-sm font-semibold mb-2">Customer + Address</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Customer Name</label>
                <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} className="mt-1" />
              </div>
              <div>
                <label className={labelCls}>Phone</label>
                <Input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} className="mt-1" />
              </div>
              <div className="col-span-2">
                <label className={labelCls}>Address</label>
                <Input value={address} onChange={(e) => setAddress(e.target.value)} className="mt-1" />
              </div>
              <div>
                <label className={labelCls}>ZIP (for weather)</label>
                <Input value={zip} onChange={(e) => setZip(e.target.value)} className="mt-1" />
              </div>
              <div>
                <label className={labelCls}>Email (calendar invite)</label>
                <Input type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} className="mt-1" />
              </div>
            </div>
          </section>

          {/* Crew assignment */}
          <section>
            <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" /> Assign Crew
            </h3>
            {employees.length === 0 ? (
              <p className="text-xs text-muted-foreground">No active employees. Add some on the Crew page.</p>
            ) : (
              <div className="grid grid-cols-2 gap-1.5 border rounded-md p-2 max-h-32 overflow-y-auto">
                {employees.map((e) => (
                  <label key={e.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/50 p-1 rounded">
                    <input
                      type="checkbox"
                      checked={assignedIds.includes(e.id)}
                      onChange={() => toggleEmployee(e.id)}
                    />
                    <span>{e.display_name || `${e.first_name} ${e.last_name}`}</span>
                    {e.role && <span className="text-[10px] text-muted-foreground">· {e.role}</span>}
                  </label>
                ))}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground mt-1">
              Assigned workers get a text and see this job in their Calendar view.
            </p>
          </section>

          {/* Send options — create only */}
          {!existing && (
            <section className="border-t pt-3">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={sendInvite} onChange={(e) => setSendInvite(e.target.checked)} />
                Send Google Calendar invite to customer
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer mt-1">
                <input type="checkbox" checked={sendThankYou} onChange={(e) => setSendThankYou(e.target.checked)} />
                Send thank-you text to customer immediately
              </label>
            </section>
          )}
        </div>

        {/* Deposit soft-warning — anti-cancellation gate added 2026-06-07.
            Visible whenever the lead hasn't paid (or waived) the $250
            deposit yet. Soft only: Alan can still click Save. Hides on
            'paid' and 'waived' so the modal stays clean for the happy path. */}
        {(() => {
          const dep = (lead.deposit_status || "").toLowerCase();
          if (dep === "paid" || dep === "waived") return null;
          const msg = dep === "pending"
            ? "Deposit invoice sent but not yet paid. The customer is not fully committed to this date."
            : "No deposit invoice sent for this lead yet. Cancellations are easier without skin in the game.";
          return (
            <div className="px-4 py-2 border-t bg-amber-50 text-amber-900 text-xs flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold">⚠ Deposit not collected. </span>
                <span>{msg} You can still schedule, but consider sending the $250 deposit invoice from the lead detail first.</span>
              </div>
            </div>
          );
        })()}

        <div className="p-4 border-t flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            {existing ? "Save Changes" : "Schedule job & text customer"}
          </Button>
        </div>
      </div>
    </div>

    {/* One-time intro nudge for Alan (admin) — points at the description editor. */}
    {showIntro && (
      <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4" onClick={dismissIntro}>
        <div className="bg-background rounded-lg shadow-xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
          <h3 className="text-base font-semibold flex items-center gap-2 mb-2">
            <Sparkles className="h-5 w-5 text-primary" /> New: Services & descriptions
          </h3>
          <p className="text-sm text-muted-foreground mb-4">
            You can now add individual services to a job — each with its own price and a description
            the customer sees on their calendar invite. Every service comes with a default description
            you can reword once and reuse. Want to review and edit those default descriptions now?
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={dismissIntro}>Maybe later</Button>
            <Button onClick={() => { dismissIntro(); setShowDescEditor(true); }}>
              <Pencil className="h-3.5 w-3.5 mr-1" /> Edit descriptions
            </Button>
          </div>
        </div>
      </div>
    )}

    {showDescEditor && (
      <ServiceDescriptionsModal
        onClose={() => setShowDescEditor(false)}
        onSaved={(services) => setCatalog(services)}
      />
    )}
    </>
  );
}
