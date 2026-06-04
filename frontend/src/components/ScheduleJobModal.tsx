import { useEffect, useMemo, useState } from "react";
import { api, type Employee, type ScheduledJob, type Lead } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { X, Calendar, Loader2, Users, Plus } from "lucide-react";

// Stain color list — placeholder. Final list comes from Alan tomorrow.
const STAIN_COLORS = [
  "Natural", "Cedar", "Honey Gold", "Redwood",
  "Mahogany", "Walnut", "Dark Oak", "Ebony",
];

const PACKAGES = [
  { value: "essential", label: "Essential" },
  { value: "signature", label: "Signature" },
  { value: "legacy", label: "Legacy" },
  { value: "custom", label: "Custom" },
];

const inputCls = "w-full border border-input rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring";
const labelCls = "text-xs font-semibold text-muted-foreground";

interface Props {
  lead: Lead;
  existing?: ScheduledJob | null;
  onClose: () => void;
  onSaved: () => void;
}

export default function ScheduleJobModal({ lead, existing, onClose, onSaved }: Props) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [saving, setSaving] = useState(false);

  // Defaults — pull from lead if creating, from existing if editing
  const defaultDate = useMemo(() => {
    if (existing) return existing.job_date;
    const t = new Date();
    t.setDate(t.getDate() + 7);
    return t.toISOString().slice(0, 10);
  }, [existing]);

  const [jobDate, setJobDate] = useState(existing?.job_date || defaultDate);
  const [arrivalTime, setArrivalTime] = useState(existing?.arrival_time || "07:30");
  const [duration, setDuration] = useState(String(existing?.estimated_duration_hours || 6));
  const [pkg, setPkg] = useState(existing?.package_tier || "signature");
  const [price, setPrice] = useState(String(existing?.closed_price || 0));
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

  useEffect(() => {
    api.listCrew("this_week", false)
      .then((r) => setEmployees(r.employees))
      .catch(() => toast.error("Failed to load crew list"));
  }, []);

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
          package_tier: pkg,
          closed_price: parseFloat(price) || 0,
          closed_price_plus_tax: plusTax,
          custom_proposal_url: customProposalUrl.trim(),
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
          package_tier: pkg,
          closed_price: parseFloat(price) || 0,
          closed_price_plus_tax: plusTax,
          custom_proposal_url: customProposalUrl.trim(),
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

          {/* Job spec */}
          <section>
            <h3 className="text-sm font-semibold mb-2">Job Details</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Package</label>
                <select value={pkg} onChange={(e) => setPkg(e.target.value)} className={`${inputCls} mt-1`}>
                  {PACKAGES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Closed Price ($)</label>
                <Input type="number" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} className="mt-1" />
                {/* "+ Tax" toggle — defaults on. When off, the invite
                    price line drops the "+ Tax" suffix. Bookkeeping only. */}
                <label className="flex items-center gap-1.5 text-xs mt-1 cursor-pointer text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={plusTax}
                    onChange={(e) => setPlusTax(e.target.checked)}
                  />
                  + Tax on invite
                </label>
              </div>
              <div>
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
              <div>
                <label className={labelCls}>Stain Gallons (optional)</label>
                <Input
                  type="number"
                  step="0.1"
                  min="0"
                  value={gallons}
                  onChange={(e) => setGallons(e.target.value)}
                  placeholder="Crew fills in at end of day"
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
                  placeholder="Crew fills in at end of day"
                  className="mt-1"
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm mt-3 cursor-pointer">
              <input type="checkbox" checked={needsTestSpots} onChange={(e) => setNeedsTestSpots(e.target.checked)} />
              Customer wants test stain patches first (same day, before final color)
            </label>

            {/* Notes split into 3 audiences: workers (on the job), customer
                (lands in Google invite description above marketing copy), and
                admin-only (never leaves the dashboard). */}
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
            <div className="mt-3">
              <label className={labelCls}>Customer Notes (rendered on the Google Calendar invite they receive)</label>
              <textarea
                value={customerNotes}
                onChange={(e) => setCustomerNotes(e.target.value)}
                rows={2}
                placeholder="e.g. We bring samples to test colors on your fence before final coats!"
                className={`${inputCls} mt-1 resize-none`}
              />
            </div>
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

        <div className="p-4 border-t flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            {existing ? "Save Changes" : "Schedule job & text customer"}
          </Button>
        </div>
      </div>
    </div>
  );
}
