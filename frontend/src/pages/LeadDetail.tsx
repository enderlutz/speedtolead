import { useEffect, useState, useCallback } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api, type LeadDetail as LeadDetailType, type EstimateDetail, type MessageEntry } from "@/lib/api";
import { formatCurrency, formatDate, formatDateTime, timeAgo } from "@/lib/utils";
import { toast } from "sonner";
import { useSSE } from "@/hooks/useSSE";
import { playSuccessSound, playWarningSound, playReplySound, playProposalViewedSound } from "@/hooks/useNotificationSound";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ArrowLeft, MapPin, Phone, Mail, User, Calculator, RefreshCw,
  Send, AlertTriangle, CheckCircle2, FileText, MessageSquare, ExternalLink, Shield, Pencil, Save, Archive, ArchiveRestore, Eye, Navigation, Clock, Calendar,
} from "lucide-react";
import PdfPreviewModal from "@/components/PdfPreviewModal";

const FENCE_HEIGHT_OPTIONS = [
  "Didn't answer", "6ft standard", "6.5ft standard with rot board", "7ft", "8ft", "Not sure",
];
const FENCE_AGE_OPTIONS = [
  "Didn't answer", "Brand new (less than 6 months)", "1-6 years", "6-15 years", "Older than 15 years / Not sure",
];
const PREVIOUSLY_STAINED_OPTIONS = ["Didn't answer", "No", "Yes"];
const TIMELINE_OPTIONS = ["As soon as possible", "Within 2 weeks", "Sometime this month", "Just planning ahead"];
const CONFIDENCE_OPTIONS = [
  { label: "I'm confident", value: "100" },
  { label: "Somewhat confident", value: "80" },
  { label: "I'm not confident", value: "60" },
];

const FENCE_SIDES = {
  Inside: ["Inside Front", "Inside Left", "Inside Back", "Inside Right"],
  Outside: ["Outside Front", "Outside Left", "Outside Back", "Outside Right"],
};

const APPROVAL_CONFIG = {
  green: { label: "Ready to Send", cls: "bg-green-50 border-green-300 text-green-800", dot: "bg-green-500" },
  yellow: { label: "Add-ons Pending", cls: "bg-yellow-50 border-yellow-300 text-yellow-800", dot: "bg-yellow-500" },
  red: { label: "Owner Review Required", cls: "bg-red-50 border-red-300 text-red-800", dot: "bg-red-500" },
} as const;

const selectCls = "w-full border border-input rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring";

export default function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [lead, setLead] = useState<LeadDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [checkingResponse, setCheckingResponse] = useState(false);
  const [requestingReview, setRequestingReview] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [editingContact, setEditingContact] = useState(false);
  const [savingContact, setSavingContact] = useState(false);
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactAddress, setContactAddress] = useState("");
  const [messages, setMessages] = useState<MessageEntry[]>([]);

  const [linearFeet, setLinearFeet] = useState("");
  const [fenceHeight, setFenceHeight] = useState("");
  const [fenceAge, setFenceAge] = useState("");
  const [previouslyStained, setPreviouslyStained] = useState("");
  const [timeline, setTimeline] = useState("");
  const [confidencePct, setConfidencePct] = useState("100");
  const [zipCode, setZipCode] = useState("");
  const [fenceSides, setFenceSides] = useState<string[]>([]);
  const [additionalServices, setAdditionalServices] = useState("");
  const [militaryDiscount, setMilitaryDiscount] = useState(false);
  const [confidenceNote, setConfidenceNote] = useState("");
  const [includeFinancing, setIncludeFinancing] = useState(true);
  const [askingAddress, setAskingAddress] = useState(false);
  const [askingNewBuild, setAskingNewBuild] = useState(false);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    Promise.all([
      api.getLead(id),
      api.getMessages(id).catch(() => []),
    ]).then(([data, msgs]) => {
      setLead(data);
      setMessages(msgs);
      // Contact fields
      setContactName(data.contact_name || "");
      setContactPhone(data.contact_phone || "");
      setContactEmail(data.contact_email || "");
      setContactAddress(data.address || "");
      // Estimator fields
      const fd = data.form_data || {};
      setLinearFeet(fd.linear_feet || "");
      setFenceHeight(fd.fence_height || "Didn't answer");
      setFenceAge(fd.fence_age || "Didn't answer");
      setPreviouslyStained(fd.previously_stained || "Didn't answer");
      setTimeline(fd.service_timeline || "");
      setConfidencePct(fd.confident_pct || "100");
      setZipCode(fd.zip_code || data.zip_code || "");
      const rawSides = fd.fence_sides;
      setFenceSides(Array.isArray(rawSides) ? rawSides : rawSides ? String(rawSides).split(",").map((s: string) => s.trim()).filter(Boolean) : []);
      setAdditionalServices(fd.additional_services || "");
      setMilitaryDiscount(Boolean(fd.military_discount));
      setConfidenceNote(fd.confidence_note || "");
      setIncludeFinancing(String(fd.include_financing ?? "true") !== "false");
    }).catch(() => toast.error("Failed to load lead")).finally(() => setLoading(false));
  }, [id]);

  // Real-time: update if customer replies or views proposal for THIS lead
  useSSE(useCallback((event) => {
    if (!id) return;
    const eventLeadId = event.data.lead_id as string;
    if (eventLeadId !== id) return;

    if (event.type === "customer_reply") {
      playReplySound();
      toast.info(`Customer replied: "${(event.data.body as string)?.slice(0, 80)}"`, { duration: 8000 });
      api.getMessages(id).then(setMessages).catch(() => {});
      api.getLead(id).then(setLead).catch(() => {});
    }
    if (event.type === "proposal_viewed") {
      playProposalViewedSound();
      toast(`${lead?.contact_name || "Customer"} is viewing their estimate right now!`, { duration: 6000 });
    }
  }, [id]));

  const estimate: EstimateDetail | undefined = lead?.estimates?.[0];

  const handleSaveRecalculate = async () => {
    if (!id) return;
    setSaving(true);
    try {
      const result = await api.updateFormData(id, {
        linear_feet: linearFeet,
        fence_height: fenceHeight,
        fence_age: fenceAge,
        previously_stained: previouslyStained,
        service_timeline: timeline,
        confident_pct: confidencePct,
        zip_code: zipCode,
        fence_sides: fenceSides,
        additional_services: additionalServices,
        military_discount: militaryDiscount,
        confidence_note: confidenceNote,
        include_financing: includeFinancing,
      });
      setLead((prev) => (prev ? { ...prev, ...result, estimates: result.estimate ? [result.estimate] : prev.estimates } : prev));
      toast.success("Estimate recalculated");
    } catch {
      toast.error("Failed to recalculate");
    } finally {
      setSaving(false);
    }
  };

  const [showScheduler, setShowScheduler] = useState(false);
  const [scheduledDate, setScheduledDate] = useState("");
  const [scheduledTime, setScheduledTime] = useState("08:00");

  // Check if it's after 8 PM CST
  const isAfterHours = () => {
    const now = new Date();
    const cst = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
    return cst.getHours() >= 20 || cst.getHours() < 6;
  };

  const getDefaultScheduleDate = () => {
    const now = new Date();
    const cst = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
    // If after 8 PM, default to tomorrow
    if (cst.getHours() >= 20) {
      cst.setDate(cst.getDate() + 1);
    }
    // If before 6 AM, default to today
    return cst.toISOString().slice(0, 10);
  };

  const handleApprove = async (scheduledSendAt?: string) => {
    if (!estimate) return;
    setApproving(true);
    try {
      const result = await api.approveEstimate(estimate.id, scheduledSendAt);
      const data = await api.getLead(id!);
      setLead(data);
      const url = result.proposal_url;
      const smsScheduled = result.sms_scheduled;
      const smsSent = result.sms_sent;
      if (smsScheduled) {
        playSuccessSound();
        const sendTime = new Date(scheduledSendAt!).toLocaleString("en-US", {
          timeZone: "America/Chicago", month: "short", day: "numeric",
          hour: "numeric", minute: "2-digit", hour12: true,
        });
        toast.success(`SMS scheduled for ${sendTime}! Proposal: ${url}`, { duration: 8000 });
      } else if (smsSent) {
        playSuccessSound();
        toast.success(`SMS sent to customer! Proposal: ${url}`, { duration: 8000 });
      } else if (url) {
        playWarningSound();
        toast.warning(`Estimate approved but SMS failed to send. Proposal link: ${url}`, { duration: 10000 });
      } else {
        playSuccessSound();
        toast.success("Estimate approved!");
      }
      setShowScheduler(false);
    } catch {
      toast.error("Failed to approve");
    } finally {
      setApproving(false);
    }
  };

  const handleCheckResponse = async () => {
    if (!id) return;
    setCheckingResponse(true);
    try {
      const result = await api.checkResponse(id);
      if (result.new_count > 0) {
        toast.success(`${result.new_count} new message(s) found`);
        const msgs = await api.getMessages(id);
        setMessages(msgs);
        const data = await api.getLead(id);
        setLead(data);
      } else {
        toast.info("No new messages");
      }
    } catch {
      toast.error("Failed to check response");
    } finally {
      setCheckingResponse(false);
    }
  };

  const handleRequestReview = async () => {
    if (!estimate) return;
    setRequestingReview(true);
    try {
      await api.requestReview(estimate.id);
      toast.success("Review request sent to Alan via SMS");
    } catch {
      toast.error("Failed to send review request");
    } finally {
      setRequestingReview(false);
    }
  };

  const handleSaveContact = async () => {
    if (!id) return;
    setSavingContact(true);
    try {
      const updated = await api.updateContact(id, {
        contact_name: contactName,
        contact_phone: contactPhone,
        contact_email: contactEmail,
        address: contactAddress,
      });
      setLead((prev) => (prev ? { ...prev, ...updated } : prev));
      setEditingContact(false);
      toast.success("Contact info saved");
    } catch {
      toast.error("Failed to save contact info");
    } finally {
      setSavingContact(false);
    }
  };

  const handleCancel = async () => {
    if (!estimate || !confirm("Cancel this estimate? The customer's proposal link will stop working.")) return;
    setCancelling(true);
    try {
      await api.cancelEstimate(estimate.id);
      const data = await api.getLead(id!);
      setLead(data);
      toast.success("Estimate cancelled — reverted to pending");
    } catch {
      toast.error("Failed to cancel estimate");
    } finally {
      setCancelling(false);
    }
  };

  const handleArchive = async () => {
    if (!id) return;
    try {
      await api.archiveLead(id);
      const data = await api.getLead(id);
      setLead(data);
      toast.success("Lead archived");
    } catch {
      toast.error("Failed to archive");
    }
  };

  const handleUnarchive = async () => {
    if (!id) return;
    try {
      await api.unarchiveLead(id);
      const data = await api.getLead(id);
      setLead(data);
      toast.success("Lead restored");
    } catch {
      toast.error("Failed to restore");
    }
  };

  if (loading) {
    return (
      <div className="p-4 sm:p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 bg-muted rounded" />
          <div className="h-64 bg-muted rounded" />
        </div>
      </div>
    );
  }

  if (!lead) {
    return <div className="p-4 sm:p-6"><p className="text-muted-foreground">Lead not found</p></div>;
  }

  const approvalStatus = estimate?.approval_status as keyof typeof APPROVAL_CONFIG | undefined;
  const approvalCfg = approvalStatus ? APPROVAL_CONFIG[approvalStatus] : null;
  const mapsUrl = lead.address
    ? `https://www.google.com/maps/@?api=1&map_action=map&basemap=satellite&center=${encodeURIComponent(lead.address)}&zoom=20`
    : null;

  return (
    <div className="p-4 sm:p-6 space-y-4 sm:space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link to="/leads" className="text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="min-w-0">
          <h1 className="text-lg sm:text-2xl font-semibold tracking-tight truncate">{lead.contact_name || "Unknown Lead"}</h1>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <Badge variant="outline" className="text-xs">{lead.location_label}</Badge>
            <Badge variant="outline" className="text-xs capitalize">{lead.status}</Badge>
            {lead.customer_responded && <Badge className="text-xs bg-blue-100 text-blue-800">Responded</Badge>}
          </div>
        </div>
      </div>

      {/* Mobile: approval status */}
      {approvalCfg && (
        <div className={`rounded-lg border p-3 sm:p-4 lg:hidden ${approvalCfg.cls}`}>
          <div className="flex items-center gap-2 mb-1">
            <span className={`h-2.5 w-2.5 rounded-full ${approvalCfg.dot}`} />
            <span className="text-sm font-semibold">{approvalCfg.label}</span>
          </div>
          <p className="text-xs">{estimate?.approval_reason}</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
        {/* Left column */}
        <div className="lg:col-span-2 space-y-4 sm:space-y-6">
          {/* Contact info */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm sm:text-base flex items-center gap-2">
                  <User className="h-4 w-4" /> Contact Information
                </CardTitle>
                {!editingContact ? (
                  <div className="flex gap-1.5 flex-wrap">
                    <Button variant="outline" size="sm" onClick={async () => {
                      setAskingAddress(true);
                      try {
                        await api.askForAddress(id!);
                        const data = await api.getLead(id!);
                        setLead(data);
                        toast.success("Address request sent via SMS");
                      } catch { toast.error("Failed to send"); }
                      finally { setAskingAddress(false); }
                    }} disabled={askingAddress || lead?.form_data?.address_action === "asked_for_address"}>
                      <Navigation className="h-3.5 w-3.5 mr-1" />
                      {lead?.form_data?.address_action === "asked_for_address" ? "Asked" : askingAddress ? "Sending..." : "Ask for Address"}
                    </Button>
                    <Button variant="outline" size="sm" onClick={async () => {
                      setAskingNewBuild(true);
                      try {
                        await api.newBuild(id!);
                        const data = await api.getLead(id!);
                        setLead(data);
                        toast.success("New build SMS sent");
                      } catch { toast.error("Failed to send"); }
                      finally { setAskingNewBuild(false); }
                    }} disabled={askingNewBuild || lead?.form_data?.address_action === "new_build"}>
                      <MapPin className="h-3.5 w-3.5 mr-1" />
                      {lead?.form_data?.address_action === "new_build" ? "Sent" : askingNewBuild ? "Sending..." : "New Build"}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditingContact(true)}>
                      <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                    </Button>
                  </div>
                ) : (
                  <div className="flex gap-1.5">
                    <Button variant="ghost" size="sm" onClick={() => setEditingContact(false)}>Cancel</Button>
                    <Button size="sm" onClick={handleSaveContact} disabled={savingContact}>
                      <Save className="h-3.5 w-3.5 mr-1" /> {savingContact ? "Saving..." : "Save"}
                    </Button>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {editingContact ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Name</label>
                    <Input value={contactName} onChange={(e) => setContactName(e.target.value)} />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Phone</label>
                    <Input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Email</label>
                    <Input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Address</label>
                    <Input value={contactAddress} onChange={(e) => setContactAddress(e.target.value)} />
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                  <div className="flex items-center gap-2">
                    <User className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="truncate">{lead.contact_name || "—"}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Phone className="h-4 w-4 text-muted-foreground shrink-0" />
                    <a href={`tel:${lead.contact_phone}`} className="text-primary hover:underline">{lead.contact_phone || "—"}</a>
                  </div>
                  <div className="flex items-center gap-2">
                    <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="truncate">{lead.contact_email || "—"}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="truncate">{lead.address || "—"}</span>
                    {mapsUrl && (
                      <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className="shrink-0">
                        <ExternalLink className="h-3 w-3 text-muted-foreground hover:text-primary" />
                      </a>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Google Maps Satellite View */}
          {lead.address && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm sm:text-base flex items-center gap-2">
                  <MapPin className="h-4 w-4" /> Satellite View
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="rounded-md overflow-hidden border" style={{ minHeight: 250 }}>
                  <iframe
                    title="Satellite view"
                    width="100%"
                    height="300"
                    style={{ border: 0, display: "block" }}
                    loading="lazy"
                    allowFullScreen
                    referrerPolicy="no-referrer-when-downgrade"
                    src={`https://www.google.com/maps/embed/v1/place?key=${import.meta.env.VITE_GOOGLE_MAPS_KEY || ""}&q=${encodeURIComponent(lead.address)}&maptype=satellite&zoom=20`}
                  />
                </div>
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lead.address)}&basemap=satellite`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 w-full inline-flex items-center justify-center gap-2 rounded-md border text-sm py-2 hover:bg-muted transition-colors sm:hidden"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> Open in Google Maps
                </a>
              </CardContent>
            </Card>
          )}

          {/* Estimate input form */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm sm:text-base flex items-center gap-2">
                <Calculator className="h-4 w-4" /> Estimator Input
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Linear Feet</label>
                  <Input type="number" placeholder="e.g. 150" value={linearFeet} onChange={(e) => setLinearFeet(e.target.value)} />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">ZIP Code</label>
                  <Input type="text" placeholder="e.g. 77429" maxLength={5} value={zipCode} onChange={(e) => setZipCode(e.target.value)} />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Fence Height</label>
                  <select className={selectCls} value={fenceHeight} onChange={(e) => setFenceHeight(e.target.value)}>
                    {FENCE_HEIGHT_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Fence Age</label>
                  <select className={selectCls} value={fenceAge} onChange={(e) => setFenceAge(e.target.value)}>
                    {FENCE_AGE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Previously Stained</label>
                  <select className={selectCls} value={previouslyStained} onChange={(e) => setPreviouslyStained(e.target.value)}>
                    {PREVIOUSLY_STAINED_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Timeline</label>
                  <select className={selectCls} value={timeline} onChange={(e) => setTimeline(e.target.value)}>
                    <option value="">Select...</option>
                    {TIMELINE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Confidence</label>
                  <select className={selectCls} value={confidencePct} onChange={(e) => setConfidencePct(e.target.value)}>
                    {CONFIDENCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              </div>

              {/* Confidence Note — shown when not confident */}
              {confidencePct === "60" && (
                <div>
                  <label className="text-xs font-medium text-red-600 mb-1 block">Why are you not confident?</label>
                  <textarea
                    className="w-full border border-red-200 rounded-md px-3 py-2 text-sm bg-red-50/30 focus:outline-none focus:ring-2 focus:ring-red-300 min-h-[60px]"
                    placeholder="Explain why you're not confident in this measurement..."
                    value={confidenceNote}
                    onChange={(e) => setConfidenceNote(e.target.value)}
                  />
                </div>
              )}

              {/* Fence Sides */}
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-2 block">Fence Sides</label>
                <div className="grid grid-cols-2 gap-4">
                  {Object.entries(FENCE_SIDES).map(([group, sides]) => (
                    <div key={group}>
                      <p className="text-[11px] font-semibold text-muted-foreground mb-1.5">{group}</p>
                      <div className="space-y-1.5">
                        {sides.map((side) => (
                          <label key={side} className="flex items-center gap-2 text-sm cursor-pointer">
                            <input
                              type="checkbox"
                              checked={fenceSides.includes(side)}
                              onChange={(e) => {
                                if (e.target.checked) setFenceSides((prev) => [...prev, side]);
                                else setFenceSides((prev) => prev.filter((s) => s !== side));
                              }}
                              className="rounded border-input"
                            />
                            {side.replace("Inside ", "").replace("Outside ", "")}
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Additional Services + Add-on Handled + Military Discount */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Additional Services</label>
                  <Input placeholder="e.g. gate painting, pressure washing" value={additionalServices} onChange={(e) => setAdditionalServices(e.target.value)} />
                  {additionalServices && additionalServices.toLowerCase() !== "none" && (
                    <label className="flex items-center gap-2 text-xs mt-1.5 cursor-pointer text-green-700">
                      <input
                        type="checkbox"
                        checked={Boolean(lead?.form_data?.addons_handled)}
                        onChange={async (e) => {
                          if (!id) return;
                          try {
                            await api.updateFormData(id, { addons_handled: e.target.checked });
                            const data = await api.getLead(id);
                            setLead(data);
                            toast.success(e.target.checked ? "Add-on marked as handled" : "Add-on unmarked");
                          } catch { toast.error("Failed"); }
                        }}
                        className="rounded border-input"
                      />
                      Add-on sent / handled
                    </label>
                  )}
                </div>
                <div className="flex flex-col gap-2 pb-1 justify-end">
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeFinancing}
                      onChange={(e) => setIncludeFinancing(e.target.checked)}
                      className="rounded border-input"
                    />
                    Include Financing
                  </label>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={militaryDiscount}
                      onChange={(e) => setMilitaryDiscount(e.target.checked)}
                      className="rounded border-input"
                    />
                    Military Discount
                  </label>
                </div>
              </div>

              <Button onClick={handleSaveRecalculate} disabled={saving} className="w-full">
                <RefreshCw className={`h-4 w-4 mr-2 ${saving ? "animate-spin" : ""}`} />
                {saving ? "Recalculating..." : "Save & Recalculate"}
              </Button>
            </CardContent>
          </Card>

          {/* Message History */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm sm:text-base flex items-center gap-2">
                  <MessageSquare className="h-4 w-4" /> Messages
                </CardTitle>
                <Button variant="outline" size="sm" onClick={handleCheckResponse} disabled={checkingResponse}>
                  <RefreshCw className={`h-3.5 w-3.5 mr-1 ${checkingResponse ? "animate-spin" : ""}`} />
                  Check
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {messages.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No messages yet</p>
              ) : (
                <div className="space-y-2 max-h-[300px] overflow-y-auto">
                  {messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`rounded-lg px-3 py-2 text-sm max-w-[85%] ${
                        msg.direction === "inbound"
                          ? "bg-muted mr-auto"
                          : "bg-primary/10 ml-auto text-right"
                      }`}
                    >
                      <p className="text-xs font-medium text-muted-foreground mb-0.5">
                        {msg.direction === "inbound" ? "Customer" : "Sent"} — {timeAgo(msg.created_at)}
                      </p>
                      <p>{msg.body}</p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right column */}
        <div className="space-y-4 sm:space-y-6">
          {/* Approval status — desktop */}
          {approvalCfg && (
            <div className={`hidden lg:block rounded-lg border p-4 ${approvalCfg.cls}`}>
              <div className="flex items-center gap-2 mb-1">
                <span className={`h-2.5 w-2.5 rounded-full ${approvalCfg.dot}`} />
                <span className="text-sm font-semibold">{approvalCfg.label}</span>
              </div>
              <p className="text-xs">{estimate?.approval_reason}</p>
            </div>
          )}

          {/* Tier prices */}
          {estimate && estimate.tiers && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm sm:text-base">Estimate</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {(["essential", "signature", "legacy"] as const).map((tier) => {
                  const price = estimate.tiers[tier] || 0;
                  const monthly = Math.round(price / 21);
                  return (
                    <div
                      key={tier}
                      className={`flex items-center justify-between p-2.5 sm:p-3 rounded-md border ${
                        tier === "signature" ? "bg-primary/5 border-primary/20" : "bg-muted/30"
                      }`}
                    >
                      <div>
                        <span className="text-sm font-medium capitalize">{tier}</span>
                        {tier === "signature" && <span className="ml-1 text-[10px] text-primary font-medium">Rec.</span>}
                      </div>
                      <div className="text-right">
                        <span className="text-sm font-bold">{formatCurrency(price)}</span>
                        <span className="text-[10px] text-muted-foreground ml-1">~${monthly}/mo</span>
                      </div>
                    </div>
                  );
                })}
                {estimate.breakdown.length > 0 && (
                  <div className="pt-2 border-t space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">Breakdown</p>
                    {estimate.breakdown.map((item, i) => (
                      <div key={i} className="flex justify-between text-xs">
                        <span className="truncate mr-2">{item.label}</span>
                        <span className="font-medium shrink-0">{formatCurrency(item.value)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Actions */}
          {estimate && estimate.status === "pending" && (
            <div className="space-y-2">
              <Button variant="outline" onClick={() => navigate(`/leads/${id}/edit-pdf`)} className="w-full">
                <Eye className="h-4 w-4 mr-2" /> Edit & Preview PDF
              </Button>

              {/* After-hours warning */}
              {isAfterHours() && !showScheduler && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
                  <div className="flex items-start gap-2">
                    <Clock className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-amber-800">It's late — consider scheduling</p>
                      <p className="text-xs text-amber-600 mt-0.5">Customers respond better to messages received between 8-9 AM</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Schedule send UI */}
              {showScheduler && (
                <div className="rounded-lg border-2 border-blue-300 bg-blue-50/50 p-4 space-y-3">
                  <h4 className="text-xs font-semibold text-blue-800 uppercase tracking-wider flex items-center gap-1.5">
                    <Calendar className="h-3.5 w-3.5" /> Schedule Send
                  </h4>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs font-medium text-muted-foreground mb-1 block">Date</label>
                      <Input type="date" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} className="h-8 text-sm" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground mb-1 block">Time (CST)</label>
                      <Input type="time" value={scheduledTime} onChange={(e) => setScheduledTime(e.target.value)} className="h-8 text-sm" />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={() => {
                        if (!scheduledDate) { toast.error("Pick a date"); return; }
                        // Convert CST date+time to UTC ISO string
                        const cstDateTime = `${scheduledDate}T${scheduledTime}:00`;
                        const cstDate = new Date(cstDateTime + "-06:00"); // CST is UTC-6
                        handleApprove(cstDate.toISOString());
                      }}
                      disabled={approving}
                      className="flex-1 bg-blue-600 hover:bg-blue-700 text-white h-8"
                    >
                      <Clock className="h-3.5 w-3.5 mr-1" />
                      {approving ? "Scheduling..." : "Schedule Send"}
                    </Button>
                    <Button variant="outline" onClick={() => setShowScheduler(false)} className="h-8">Cancel</Button>
                  </div>
                </div>
              )}

              <div className="flex gap-2">
                <Button onClick={() => handleApprove()} disabled={approving} className="flex-1 bg-green-600 hover:bg-green-700 text-white">
                  <Send className={`h-4 w-4 mr-2 ${approving ? "animate-spin" : ""}`} />
                  {approving ? "Sending..." : "Send Now"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setScheduledDate(getDefaultScheduleDate());
                    setShowScheduler(!showScheduler);
                  }}
                  disabled={approving}
                  className="shrink-0"
                >
                  <Clock className="h-4 w-4 mr-1" /> Schedule
                </Button>
              </div>
              {estimate.approval_status === "red" && (
                <>
                  <Button variant="outline" onClick={handleRequestReview} disabled={requestingReview} className="w-full">
                    <Shield className={`h-4 w-4 mr-2 ${requestingReview ? "animate-spin" : ""}`} />
                    {requestingReview ? "Sending..." : "Request Alan's Approval"}
                  </Button>
                  <p className="text-xs text-center text-muted-foreground flex items-center justify-center gap-1">
                    <AlertTriangle className="h-3 w-3" /> Needs review before sending
                  </p>
                </>
              )}
            </div>
          )}

          {estimate && estimate.status === "sent" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-green-600 justify-center">
                <CheckCircle2 className="h-4 w-4" />
                <span className="text-sm font-medium">Sent {estimate.sent_at ? formatDateTime(estimate.sent_at) : ""}</span>
              </div>
              <a href={api.getEstimatePdfUrl(estimate.id)} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" className="w-full">
                  <FileText className="h-4 w-4 mr-2" /> View PDF
                </Button>
              </a>
              <Button variant="destructive" onClick={handleCancel} disabled={cancelling} className="w-full">
                {cancelling ? "Cancelling..." : "Cancel Estimate"}
              </Button>
            </div>
          )}

          {/* Meta info */}
          <Card>
            <CardContent className="pt-4 text-xs space-y-1 text-muted-foreground">
              <p>Created: {formatDate(lead.created_at)}</p>
              <p>ZIP: {lead.zip_code || "—"}</p>
              <p>Service: {lead.service_type}</p>
              {estimate && (
                <>
                  <p>Zone: {String(estimate.inputs?.["_zone"] ?? "—")}</p>
                  <p>Sqft: {String(estimate.inputs?.["_sqft"] ?? "—")}</p>
                </>
              )}
            </CardContent>
          </Card>

          {/* Archive */}
          {lead.status === "archived" ? (
            <Button variant="outline" onClick={handleUnarchive} className="w-full">
              <ArchiveRestore className="h-4 w-4 mr-2" /> Restore from Archive
            </Button>
          ) : (
            <Button variant="outline" onClick={handleArchive} className="w-full text-muted-foreground">
              <Archive className="h-4 w-4 mr-2" /> Archive Lead
            </Button>
          )}
        </div>
      </div>

      {/* PDF Preview Modal */}
      {estimate && lead && (
        <PdfPreviewModal
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          lead={lead}
          estimate={estimate}
          fenceSides={fenceSides}
          onSent={async () => {
            const data = await api.getLead(id!);
            setLead(data);
          }}
        />
      )}
    </div>
  );
}
