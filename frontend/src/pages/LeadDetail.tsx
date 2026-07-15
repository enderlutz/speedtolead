import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { api, canSeeRevenue, getCurrentUser, type LeadDetail as LeadDetailType, type EstimateDetail, type MessageEntry, type BreakdownItem, type CallRecordingEntry, type ScheduledJob, type LeadSource, type CallDispositionEntry, type CallDispositionOutcome, type FollowUpFlag, type NearbyJob, type QuickbooksInvoice, LEAD_SOURCE_OPTIONS } from "@/lib/api";
import GenerateInvoiceModal from "@/components/GenerateInvoiceModal";
import CallScriptPanel from "@/components/CallScriptPanel";
import FollowUpStatusPanel from "@/components/FollowUpStatusPanel";
import { formatCurrency, formatDate, formatDateTime, timeAgo } from "@/lib/utils";
import { toast } from "sonner";
import { useSSE } from "@/hooks/useSSE";
import { playSuccessSound, playWarningSound, playReplySound, playProposalViewedSound } from "@/hooks/useNotificationSound";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import EstimatorLeadPanel from "@/components/EstimatorLeadPanel";
import DailyTaskList from "@/components/DailyTaskList";
import {
  ArrowLeft, MapPin, Phone, Mail, User, Calculator, RefreshCw,
  Send, AlertTriangle, CheckCircle2, FileText, MessageSquare, ExternalLink, Shield, Pencil, Save, Archive, ArchiveRestore, Eye, Navigation, Clock, Calendar, Plus, Undo2, Trash2, Loader2, WandSparkles, Upload, ChevronDown, ChevronUp, Mic, ArrowRightCircle, Star, Play, Pause, RotateCw, DollarSign, Copy, GraduationCap, X,
} from "lucide-react";
import { useTrainingMode } from "@/lib/training_mode_context";
import PdfPreviewModal from "@/components/PdfPreviewModal";
import ScheduleJobModal from "@/components/ScheduleJobModal";
import CalendarGlimpse from "@/components/CalendarGlimpse";
import { LeadDelayPanel } from "@/components/EstimateDelay";
import TimeSpentCard from "@/components/TimeSpentCard";
import MeasurementCard from "@/components/MeasurementCard";
import EstimateHistoryCard from "@/components/EstimateHistoryCard";
import CustomProposalCard from "@/components/CustomProposalCard";
import ExteriorTab from "@/components/ExteriorTab";
import UpsellTab from "@/components/UpsellTab";
import { V2_STAGES } from "./LeadsV2";
import SyncedTranscriptPlayer from "@/components/SyncedTranscriptPlayer";

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

const STAGE_DECLINED = "f207a600-81c9-4150-941c-e977ea876929";

export default function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [urlParams] = useSearchParams();
  const { trainingModeOn, activeCall, startCall } = useTrainingMode();
  const [practicing, setPracticing] = useState(false);
  const [lead, setLead] = useState<LeadDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [sendSms, setSendSms] = useState(true);
  // Default to also emailing the estimate — VA can uncheck. Only actually
  // sends when the lead has an email (see the checked= guard on the box).
  const [alsoEmail, setAlsoEmail] = useState(true);
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
  const [leadSource, setLeadSource] = useState<string>("ad");
  const [messages, setMessages] = useState<MessageEntry[]>([]);
  const [invoiceModalOpen, setInvoiceModalOpen] = useState(() => urlParams.get("invoice") === "1");
  const [latestScheduledJob, setLatestScheduledJob] = useState<ScheduledJob | null>(null);

  const [linearFeet, setLinearFeet] = useState("");
  const [fenceHeight, setFenceHeight] = useState("");
  const [fenceAge, setFenceAge] = useState("");
  const [previouslyStained, setPreviouslyStained] = useState("");
  const [timeline, setTimeline] = useState("");
  const [confidencePct, setConfidencePct] = useState("100");
  const [zipCode, setZipCode] = useState("");
  const [fenceSides, setFenceSides] = useState<string[]>([]);
  const [additionalServices, setAdditionalServices] = useState("");
  const [additionalNotes, setAdditionalNotes] = useState("");
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [militaryDiscount, setMilitaryDiscount] = useState(false);
  const [confidenceNote, setConfidenceNote] = useState("");
  const [includeFinancing, setIncludeFinancing] = useState(true);
  const [askingAddress, setAskingAddress] = useState(false);
  const [askingNewBuild, setAskingNewBuild] = useState(false);
  const [declineModalOpen, setDeclineModalOpen] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  // Multi-estimate switcher — null means "auto-pick the latest editable one"
  const [selectedEstimateId, setSelectedEstimateId] = useState<string | null>(null);
  const [creatingNewEstimate, setCreatingNewEstimate] = useState(false);

  // Two-tab layout (2026-06-08). Estimate is the default landing tab — it's
  // what VAs hit when refining inputs and sending. Call is the cockpit Alan
  // opens before / during / after a sales call.
  //
  // The "N new" counter on the Call tab counts inbound SMS arrived since the
  // user last opened the Call tab for THIS lead. Stored per-lead in
  // localStorage so the badge resets correctly when you actually look at the
  // messages, not just when you load the page.
  // Estimators live in the Estimator tab — open straight to it for them.
  const [activeTab, setActiveTab] = useState<"estimate" | "call" | "exterior" | "upsell" | "estimator">(
    () => (getCurrentUser()?.role === "estimator" ? "estimator" : "estimate"),
  );
  const callTabSeenKey = id ? `at_lead_${id}_call_seen_at` : "";
  const [callTabSeenAt, setCallTabSeenAt] = useState<string>(() => {
    if (!callTabSeenKey) return "1970-01-01T00:00:00.000Z";
    return localStorage.getItem(callTabSeenKey) || "1970-01-01T00:00:00.000Z";
  });

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
      setLeadSource(data.lead_source || "ad");
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
      setAdditionalNotes(fd.additional_notes || "");
      setMilitaryDiscount(Boolean(fd.military_discount));
      setConfidenceNote(fd.confidence_note || "");
      setIncludeFinancing(String(fd.include_financing ?? "true") !== "false");

      // Auto-open the decline-reasons modal once when a lead lands in
      // DECLINED ESTIMATE without any reasons captured yet, unless the VA
      // has already skipped it. The manual "Capture decline reasons" button
      // stays available regardless.
      const fdAny = fd as Record<string, unknown>;
      const reasonsArr = (fdAny.decline_reasons as string[] | undefined) || [];
      if (
        data.ghl_pipeline_stage_id === STAGE_DECLINED &&
        reasonsArr.length === 0 &&
        !fdAny.decline_skipped
      ) {
        setDeclineModalOpen(true);
      }
    }).catch(() => toast.error("Failed to load lead")).finally(() => setLoading(false));
  }, [id]);

  // Pull the most recent ScheduledJob for this lead — Generate Invoice
  // targets a specific scheduled job (revenue is tracked there). If a lead
  // hasn't been scheduled yet, the Generate Invoice button is hidden.
  useEffect(() => {
    if (!id) return;
    api.listScheduledJobs({}).then((r) => {
      const mine = r.jobs.filter((j) => j.lead_id === id);
      if (mine.length === 0) { setLatestScheduledJob(null); return; }
      mine.sort((a, b) => (b.job_date || "").localeCompare(a.job_date || ""));
      setLatestScheduledJob(mine[0]);
    }).catch(() => {});
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

  // Call-tab unread counter. Counts inbound SMS that arrived after the
  // user's last visit to the Call tab for this lead. Outbound and our own
  // chatbot replies don't count — only new messages FROM the customer.
  const unreadCallCount = useMemo(() => {
    if (!messages.length) return 0;
    return messages.filter(
      (m) => m.direction === "inbound" && (m.created_at || "") > callTabSeenAt,
    ).length;
  }, [messages, callTabSeenAt]);
  void unreadCallCount; // consumed by the Call tab badge (hidden 2026-07-14; kept for restore)

  // Sorted newest-first for the switcher tabs. Cancelled estimates (e.g. a
  // retracted custom-PDF proposal) are hidden — they're managed from the
  // "Send a custom PDF" card, not the normal estimate switcher.
  const sortedEstimates: EstimateDetail[] = useMemo(() => {
    if (!lead?.estimates?.length) return [];
    return [...lead.estimates].filter((e) => e.status !== "cancelled").sort((a, b) => {
      // Pending first, then by created_at desc
      if (a.status === "pending" && b.status !== "pending") return -1;
      if (b.status === "pending" && a.status !== "pending") return 1;
      return (b.created_at || "").localeCompare(a.created_at || "");
    });
  }, [lead?.estimates]);

  // Picks the currently-displayed estimate. Null selectedEstimateId means
  // "auto-pick the most recent editable one" (latest pending → fallback to
  // first overall). Once the user clicks a tab we honor their pick.
  const estimate: EstimateDetail | undefined = useMemo(() => {
    if (!sortedEstimates.length) return undefined;
    if (selectedEstimateId) {
      const found = sortedEstimates.find((e) => e.id === selectedEstimateId);
      if (found) return found;
    }
    return sortedEstimates.find((e) => e.status === "pending") || sortedEstimates[0];
  }, [sortedEstimates, selectedEstimateId]);

  // Repopulate form fields when the user switches to a different estimate
  // (so the inputs match what's actually in that estimate). The initial-load
  // effect populates from lead.form_data on first render — this effect only
  // fires on subsequent estimate changes.
  const lastLoadedEstimateRef = useRef<string | null>(null);
  useEffect(() => {
    if (!estimate) return;
    if (lastLoadedEstimateRef.current === null) {
      // First time we see the estimate, the initial-load effect already
      // populated from form_data (which mirrors the latest estimate's inputs).
      lastLoadedEstimateRef.current = estimate.id;
      return;
    }
    if (lastLoadedEstimateRef.current === estimate.id) return;
    lastLoadedEstimateRef.current = estimate.id;
    const inputs = (estimate.inputs || {}) as Record<string, unknown>;
    setLinearFeet(String(inputs.linear_feet ?? ""));
    setFenceHeight(String(inputs.fence_height ?? "Didn't answer"));
    setFenceAge(String(inputs.fence_age ?? "Didn't answer"));
    setPreviouslyStained(String(inputs.previously_stained ?? "Didn't answer"));
    setTimeline(String(inputs.service_timeline ?? ""));
    setConfidencePct(String(inputs.confident_pct ?? "100"));
    setZipCode(String(inputs.zip_code ?? ""));
    const rawSides = inputs.fence_sides;
    setFenceSides(
      Array.isArray(rawSides)
        ? rawSides as string[]
        : rawSides
          ? String(rawSides).split(",").map((s) => s.trim()).filter(Boolean)
          : [],
    );
    setAdditionalServices(String(inputs.additional_services ?? ""));
    setAdditionalNotes(String(inputs.additional_notes ?? ""));
    setMilitaryDiscount(Boolean(inputs.military_discount));
    setConfidenceNote(String(inputs.confidence_note ?? ""));
    setIncludeFinancing(String(inputs.include_financing ?? "true") !== "false");
  }, [estimate]);

  const handleSaveRecalculate = async () => {
    if (!id) return;
    setSaving(true);
    try {
      const result = await api.updateFormData(
        id,
        {
          linear_feet: linearFeet,
          fence_height: fenceHeight,
          fence_age: fenceAge,
          previously_stained: previouslyStained,
          service_timeline: timeline,
          confident_pct: confidencePct,
          zip_code: zipCode,
          fence_sides: fenceSides,
          additional_services: additionalServices,
          additional_notes: additionalNotes,
          military_discount: militaryDiscount,
          confidence_note: confidenceNote,
          include_financing: includeFinancing,
        },
        estimate?.id,
      );
      // Refetch the full lead so all estimates are up-to-date — we no longer
      // overwrite estimates with [result.estimate] because that would erase
      // other estimates in the multi-estimate view.
      const fresh = await api.getLead(id);
      setLead(fresh);
      void result;
      toast.success("Estimate recalculated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to recalculate");
    } finally {
      setSaving(false);
    }
  };

  const handleCreateNewEstimate = async () => {
    if (!id) return;
    setCreatingNewEstimate(true);
    try {
      const fresh_estimate = await api.createNewEstimate(id);
      const fresh = await api.getLead(id);
      setLead(fresh);
      setSelectedEstimateId(fresh_estimate.id);
      toast.success("New estimate created — adjust inputs and recalculate");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create estimate");
    } finally {
      setCreatingNewEstimate(false);
    }
  };

  const [showScheduler, setShowScheduler] = useState(false);
  const [scheduledDate, setScheduledDate] = useState("");
  const [scheduledTime, setScheduledTime] = useState("08:00");
  const [showScheduleJob, setShowScheduleJob] = useState(false);
  const [existingScheduledJob, setExistingScheduledJob] = useState<import("@/lib/api").ScheduledJob | null>(null);
  // Phase 3 (2026-06-08) — Calendar Glimpse precedes the Schedule modal on
  // brand-new jobs. When editing an existing job we skip the glimpse and
  // jump straight to the modal (the date is already locked).
  const [showCalendarGlimpse, setShowCalendarGlimpse] = useState(false);
  const [glimpsePickedDate, setGlimpsePickedDate] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (urlParams.get("schedule") === "1" && lead) {
      api.listScheduledJobs({})
        .then((r) => setExistingScheduledJob(r.jobs.find((j) => j.lead_id === lead.id) || null))
        .catch(() => setExistingScheduledJob(null))
        .finally(() => setShowScheduleJob(true));
    }
  }, [urlParams, lead]);
  // Pre-estimate call state removed — section was cut from the UI per spec.
  // Backend Estimate.precall_* fields are still preserved for historical data.

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

  const handleApprove = async (scheduledSendAt?: string, applyTag: boolean = true) => {
    if (!estimate) return;
    if (!sendSms && !alsoEmail) {
      toast.error("Pick at least one channel — SMS or email.");
      return;
    }
    if (scheduledSendAt && !sendSms) {
      toast.error("Scheduled sends support SMS only. Send email immediately or schedule SMS.");
      return;
    }
    if (!applyTag) {
      const ok = window.confirm(
        "Send WITHOUT applying the 'estimate sent' GHL tag?\n\n" +
        "The customer SMS + proposal will go out normally, but GHL " +
        "automations (P1 Sterling, P04 reply handler, etc.) won't fire " +
        "for this send.\n\nProceed?"
      );
      if (!ok) return;
    }
    setApproving(true);
    try {
      const result = await api.approveEstimate(estimate.id, {
        scheduledSendAt,
        sendSms,
        alsoEmail: alsoEmail && !!lead?.contact_email,
        applyTag,
      });
      const data = await api.getLead(id!);
      setLead(data);
      const url = result.proposal_url;
      const smsScheduled = result.sms_scheduled;
      const smsSent = result.sms_sent;
      // Surface the no-tag mode in every toast so VA knows the automation
      // skip actually applied.
      const tagNote = applyTag ? "" : " (no GHL tag)";
      if (smsScheduled) {
        playSuccessSound();
        const sendTime = new Date(scheduledSendAt!).toLocaleString("en-US", {
          timeZone: "America/Chicago", month: "short", day: "numeric",
          hour: "numeric", minute: "2-digit", hour12: true,
        });
        toast.success(`SMS scheduled for ${sendTime}${tagNote}! Proposal: ${url}`, { duration: 8000 });
      } else if (smsSent) {
        playSuccessSound();
        toast.success(`SMS sent to customer${tagNote}! Proposal: ${url}`, { duration: 8000 });
      } else if (url) {
        playWarningSound();
        toast.warning(`Estimate approved${tagNote} but SMS failed to send. Proposal link: ${url}`, { duration: 10000 });
      } else {
        playSuccessSound();
        toast.success(`Estimate approved${tagNote}!`);
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
        lead_source: leadSource,
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

  /** Inline source-only update (no full edit modal needed). Fired when admin
   * picks a different option from the lead-source dropdown. */
  const handleSaveLeadSource = async (next: LeadSource) => {
    if (!id) return;
    const prev = leadSource;
    setLeadSource(next);
    try {
      const updated = await api.updateContact(id, { lead_source: next });
      setLead((p) => (p ? { ...p, ...updated } : p));
      toast.success("Source updated");
    } catch {
      setLeadSource(prev);
      toast.error("Failed to save source");
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
    if (!window.confirm(`Archive ${lead?.contact_name || "this lead"}? It'll be removed from the board and task list. You can restore it later.`)) return;
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

  const [exportStageId, setExportStageId] = useState<string>(V2_STAGES[0].id);
  const [exporting, setExporting] = useState(false);
  const handleExportToV2 = async () => {
    if (!id) return;
    setExporting(true);
    try {
      await api.exportToV2(id, exportStageId);
      toast.success("Exported to new pipeline");
      navigate("/leads");
    } catch {
      toast.error("Export failed");
    } finally {
      setExporting(false);
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
  // Facebook-ad leads give a street + ZIP (e.g. "123 Main St., 77014"). The
  // street alone geocodes to the wrong city/state (there are hundreds of
  // "123 Main St" across the country), so always pin the map with the ZIP.
  const mapQuery = [lead.address, lead.zip_code].map((s) => (s || "").trim()).filter(Boolean).join(", ");
  const mapsUrl = lead.address
    ? `https://www.google.com/maps/@?api=1&map_action=map&basemap=satellite&center=${encodeURIComponent(mapQuery)}&zoom=20`
    : null;

  return (
    <div className="p-4 sm:p-6 space-y-4 sm:space-y-6 max-w-5xl">
      {/* Sticky call script panel — auto-fills from this lead. Persistent
          open/closed state so the VA's choice survives navigation. */}
      <CallScriptPanel lead={lead} estimate={estimate} />

      {/* Header — always visible above the Estimate / Call tabs so Alan never
          loses sight of "who am I looking at" when flipping between them. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex items-start gap-3 min-w-0 flex-1">
        <button
          onClick={() => {
            // Go back to wherever they came from (Leads map, Daily Task List,
            // etc.) so their saved view/scroll restores. Fall back to /leads
            // when there's no in-app history (deep link / fresh tab).
            const idx = (window.history.state && window.history.state.idx) || 0;
            if (idx > 0) navigate(-1);
            else navigate("/leads");
          }}
          aria-label="Back"
          className="text-muted-foreground hover:text-foreground transition-colors shrink-0 mt-0.5"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg sm:text-2xl font-semibold tracking-tight truncate">{lead.contact_name || "Unknown Lead"}</h1>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <Badge variant="outline" className="text-xs">{lead.location_label}</Badge>
            <Badge variant="outline" className="text-xs capitalize">{lead.status}</Badge>
            {lead.customer_responded && <Badge className="text-xs bg-blue-100 text-blue-800">Responded</Badge>}
            {/* Sprint 2 T2.B — Proposal view status badge. Highest-leverage
                intent signal in the funnel: green when viewed (call now),
                gray when not (still waiting). Click count + last-viewed
                relative time give Alan everything he needs at a glance. */}
            <ProposalViewBadge
              viewCount={lead.proposal_view_count || 0}
              firstViewedAt={lead.proposal_viewed_at}
              lastViewedAt={lead.proposal_last_viewed_at}
            />
            {/* Sprint 2 T2.E — Smart follow-up flag. Reads call dispositions
                + proposal views + estimate sent timestamps to surface
                "what kind of touch does this lead need next?" Renders
                only when a rule fires (most won't, keeping the header tidy). */}
            <FollowUpFlagBadge leadId={lead.id} />
            {((lead.form_data as Record<string, unknown> | undefined)?.decline_reasons as string[] | undefined)?.length ? (
              <Badge className="text-xs bg-slate-200 text-slate-700">
                Declined ({(((lead.form_data as Record<string, unknown>).decline_reasons) as string[]).length} reason{(((lead.form_data as Record<string, unknown>).decline_reasons) as string[]).length === 1 ? "" : "s"})
              </Badge>
            ) : null}
          </div>
          {/* Sprint 2 T2.C — Last-contact line. Tells Alan/Olga at a glance
              when this lead was last touched so multi-person teams don't
              double-dial. Pulls from call dispositions (T2.A) + estimate.sent_at
              + lead.proposal_last_viewed_at — whichever is most recent. */}
          <LastContactLine
            leadId={lead.id}
            estimateSentAt={estimate?.sent_at}
            proposalLastViewedAt={lead.proposal_last_viewed_at}
          />
        </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap sm:shrink-0 sm:justify-end">
          {trainingModeOn && !activeCall && (
            <Button
              variant="outline"
              size="sm"
              disabled={practicing}
              onClick={async () => {
                if (!lead) return;
                setPracticing(true);
                try {
                  const sess = await api.createTrainingSessionFromLead(lead.id);
                  await startCall({
                    sessionId: sess.id,
                    persona: sess.persona as unknown as import("@/components/training/PersonaCard").Persona,
                    mood: sess.persona.default_mood || "",
                    ttsConfigured: sess.tts_configured,
                  });
                } catch (e: any) {
                  toast.error(e?.message || "Couldn't start practice call");
                } finally {
                  setPracticing(false);
                }
              }}
              className="border-rose-500/40 text-rose-700 hover:bg-rose-500/10"
            >
              {practicing ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <GraduationCap className="h-4 w-4 mr-1.5" />
              )}
              Practice call
            </Button>
          )}
          {lead.pipeline_version !== "v1" && lead.ghl_opportunity_id && (
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                setResyncing(true);
                try {
                  const r = await api.resyncStageFromGHL(lead.id);
                  if (r.changed) {
                    toast.success("Stage re-synced from GHL");
                    const data = await api.getLead(id!);
                    setLead(data);
                  } else {
                    toast.info("Already in sync with GHL");
                  }
                } catch (e: any) {
                  toast.error(e?.message || "Couldn't sync from GHL");
                } finally {
                  setResyncing(false);
                }
              }}
              disabled={resyncing}
              title="Pull this lead's current stage straight from GHL"
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1 ${resyncing ? "animate-spin" : ""}`} />
              Sync from GHL
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDeclineModalOpen(true)}
          >
            {((lead.form_data as Record<string, unknown> | undefined)?.decline_reasons as string[] | undefined)?.length ? "Edit Decline Reasons" : "Capture Decline Reasons"}
          </Button>
          <Button
            size="sm"
            onClick={async () => {
              // Phase 3 (2026-06-08) — if there's already a scheduled job for
              // this lead we're editing it, so go straight to the modal. If
              // it's a new schedule, open the Calendar Glimpse first so the
              // user picks a date in full month context.
              try {
                const r = await api.listScheduledJobs({});
                const existing = r.jobs.find((j) => j.lead_id === lead.id) || null;
                setExistingScheduledJob(existing);
                if (existing) {
                  setGlimpsePickedDate(undefined);
                  setShowScheduleJob(true);
                } else {
                  setShowCalendarGlimpse(true);
                }
              } catch {
                setExistingScheduledJob(null);
                // Network hiccup → fall back to the old direct-modal path.
                setShowScheduleJob(true);
              }
            }}
          >
            <Calendar className="h-3.5 w-3.5 mr-1" />
            Schedule Job
          </Button>
        </div>
      </div>

      {showCalendarGlimpse && (
        <CalendarGlimpse
          lead={lead}
          onClose={() => setShowCalendarGlimpse(false)}
          onPickDate={(date) => {
            // Close the glimpse, stash the date, open the existing modal.
            // ScheduleJobModal's `initialDate` prop seeds its jobDate state
            // so the user lands on the picked date but can still edit it.
            setGlimpsePickedDate(date);
            setShowCalendarGlimpse(false);
            setShowScheduleJob(true);
          }}
        />
      )}

      {showScheduleJob && (
        <ScheduleJobModal
          lead={lead}
          existing={existingScheduledJob}
          initialDate={glimpsePickedDate}
          onClose={() => {
            setShowScheduleJob(false);
            setExistingScheduledJob(null);
            setGlimpsePickedDate(undefined);
          }}
          onSaved={() => {
            setShowScheduleJob(false);
            setExistingScheduledJob(null);
            setGlimpsePickedDate(undefined);
            api.getLead(id!).then(setLead).catch(() => {});
            toast.success("Schedule saved");
          }}
        />
      )}

      {/* 24h delay alarm — auto-hides when no active delay. Above the tabs
          because it's an SLA emergency Alan must resolve regardless of tab.
          (The $250 deposit gate moved to the Contact Information card's
          Payment Links section in Phase 2.) */}
      <LeadDelayPanel leadId={lead.id} />

      {/* Two-tab cockpit (2026-06-08). Estimate is the default — building /
          pricing / sending the proposal. Call is the sales-call cockpit:
          last-call intel, dispositions, conversations, recordings, follow-up
          automation. The "N new" badge on Call counts inbound SMS that
          arrived since the last time this user opened the Call tab for
          THIS lead. */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => {
          const next = v as "estimate" | "call" | "exterior" | "upsell" | "estimator";
          setActiveTab(next);
          if (next === "call" && callTabSeenKey) {
            const now = new Date().toISOString();
            localStorage.setItem(callTabSeenKey, now);
            setCallTabSeenAt(now);
          }
        }}
      >
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="estimate">Estimate</TabsTrigger>
          {/* Call / Exterior / Upsell tabs hidden 2026-07-14 to trim visual fat.
              Their tab panels + logic are untouched; uncomment to restore. */}
          {/*
          <TabsTrigger value="call">
            Call
            {unreadCallCount > 0 && (
              <Badge className="ml-1.5 bg-rose-600 text-white text-[10px] h-4 px-1.5 leading-none">
                {unreadCallCount} new
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="exterior">
            Exterior
            {(lead.exterior_photos?.length ?? 0) > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-[10px] h-4 px-1.5 leading-none">
                {lead.exterior_photos!.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="upsell">Upsell</TabsTrigger>
          */}
          <TabsTrigger value="estimator">Estimator</TabsTrigger>
        </TabsList>

        <TabsContent value="estimate" className="space-y-4 sm:space-y-6 mt-4">
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
                        toast.success("Tagged “asking-for-address” — GHL will take it from here");
                      } catch { toast.error("Failed to add tag"); }
                      finally { setAskingAddress(false); }
                    }}
                    disabled={askingAddress || lead?.form_data?.address_action === "asked_for_address" || lead?.pipeline_version === "v1"}
                    title={lead?.pipeline_version === "v1" ? "Export to new pipeline first" : undefined}>
                      <Navigation className="h-3.5 w-3.5 mr-1" />
                      {lead?.form_data?.address_action === "asked_for_address" ? "Asked" : askingAddress ? "Tagging..." : "Ask for Address"}
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
                    }}
                    disabled={askingNewBuild || lead?.form_data?.address_action === "new_build" || lead?.pipeline_version === "v1"}
                    title={lead?.pipeline_version === "v1" ? "Export to new pipeline before sending SMS" : undefined}>
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
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Lead source</label>
                    <select
                      value={leadSource}
                      onChange={(e) => setLeadSource(e.target.value)}
                      className="w-full border border-input rounded-md px-3 py-2 text-sm bg-background"
                    >
                      {LEAD_SOURCE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
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
                  {/* Inline source picker — fires save on change so admin doesn't have to enter Edit mode for this one field */}
                  <div className="flex items-center gap-2 col-span-1 sm:col-span-2 pt-1 border-t mt-1">
                    <span className="text-xs font-medium text-muted-foreground">Source:</span>
                    <select
                      value={leadSource}
                      onChange={(e) => handleSaveLeadSource(e.target.value as LeadSource)}
                      className="text-xs border border-input rounded-md px-2 py-1 bg-background"
                    >
                      {LEAD_SOURCE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                    <span className="text-[10px] text-muted-foreground italic ml-auto">Default = Ad. Update if this came from a different channel.</span>
                  </div>
                </div>
              )}

              {/* Payment Links (Phase 2, 2026-06-08). Unified controls for the
                  $250 deposit + full job invoice. Replaces the standalone
                  DepositCard above the tabs and the Generate-Invoice button
                  strip that used to live here. Deposit always shows; Full
                  Invoice prompts admin to schedule first if no job exists. */}
              <div className="mt-3 pt-3 border-t space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Payment Links
                </p>
                <DepositRow
                  lead={lead}
                  onChange={() => api.getLead(lead.id).then(setLead).catch(() => {})}
                />
                <FullInvoiceRow
                  job={latestScheduledJob}
                  onGenerate={() => setInvoiceModalOpen(true)}
                />
              </div>
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
                    src={`https://www.google.com/maps/embed/v1/place?key=${import.meta.env.VITE_GOOGLE_MAPS_KEY || ""}&q=${encodeURIComponent(mapQuery)}&maptype=satellite&zoom=20`}
                  />
                </div>
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}&basemap=satellite`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 w-full inline-flex items-center justify-center gap-2 rounded-md border text-sm py-2 hover:bg-muted transition-colors sm:hidden"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> Open in Google Maps
                </a>
              </CardContent>
            </Card>
          )}

          {/* Measurement screenshot — VA's Google Maps screenshot. Sits between
              the satellite view and the estimator because it's the artifact
              that translates "the property" into "the number" Alan inputs. */}
          <MeasurementCard
            leadId={lead.id}
            hasMeasurement={!!lead.measurement_uploaded}
            uploadedAt={lead.measurement_uploaded_at}
            uploadedBy={lead.measurement_uploaded_by}
            filename={lead.measurement_filename}
            onChange={() => {
              // Re-fetch the lead to refresh measurement metadata
              api.getLead(lead.id).then(setLead).catch(() => {});
            }}
          />

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

              {/* Additional Notes — collapsible so long GHL notes don't dominate */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-muted-foreground">Additional Notes</label>
                  {additionalNotes && (
                    <button
                      type="button"
                      onClick={() => setNotesExpanded((v) => !v)}
                      className="text-[11px] text-muted-foreground hover:text-foreground underline"
                    >
                      {notesExpanded ? "Collapse" : "Expand"}
                    </button>
                  )}
                </div>
                <textarea
                  className="w-full border border-input rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring resize-y"
                  rows={notesExpanded ? 12 : 3}
                  placeholder="Anything else the customer mentioned (special requests, gate access, pets, etc.)"
                  value={additionalNotes}
                  onChange={(e) => setAdditionalNotes(e.target.value)}
                />
              </div>

              <Button onClick={handleSaveRecalculate} disabled={saving} className="w-full">
                <RefreshCw className={`h-4 w-4 mr-2 ${saving ? "animate-spin" : ""}`} />
                {saving ? "Recalculating..." : "Save & Recalculate"}
              </Button>
            </CardContent>
          </Card>

          {/* (Follow-up automation, Messages, Chatbot, Call Recordings all
              relocated to the Call tab below.) */}
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

          {/* Estimate switcher — only renders when there are multiple estimates
              on this lead. Lets the VA edit/view different estimates for the
              same customer (e.g. quotes for different houses). */}
          {sortedEstimates.length > 1 && (
            <Card>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <p className="text-xs font-semibold text-muted-foreground">Estimates on this lead</p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={handleCreateNewEstimate}
                    disabled={creatingNewEstimate}
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    {creatingNewEstimate ? "Creating…" : "New Estimate"}
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {sortedEstimates.map((e, i) => {
                    const isSel = e.id === estimate?.id;
                    const num = sortedEstimates.length - i;
                    const sigPrice = e.tiers?.signature || 0;
                    return (
                      <button
                        key={e.id}
                        onClick={() => setSelectedEstimateId(e.id)}
                        className={`text-xs px-2.5 py-1.5 rounded-md border transition-colors ${
                          isSel
                            ? "bg-primary text-primary-foreground border-primary"
                            : "border-border hover:bg-muted/50"
                        }`}
                        title={e.label || `Estimate #${num}`}
                      >
                        <span className="font-semibold">#{num}</span>
                        {e.label && <span className="ml-1">· {e.label.length > 18 ? e.label.slice(0, 18) + "…" : e.label}</span>}
                        {!e.label && sigPrice > 0 && (
                          <span className="ml-1 opacity-80">· {formatCurrency(sigPrice)}</span>
                        )}
                        <span className={`ml-1 text-[9px] uppercase tracking-wide ${
                          isSel ? "opacity-90" : e.status === "sent" ? "text-emerald-600" : e.status === "pending" ? "text-amber-600" : "text-muted-foreground"
                        }`}>
                          {e.status === "sent" ? "Sent" : e.status === "pending" ? "Pending" : e.status}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {/* "+ New Estimate" — also available when there's only one estimate
              (or none). Shown as a small action above the tier prices card. */}
          {sortedEstimates.length <= 1 && lead?.estimates && (
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={handleCreateNewEstimate}
                disabled={creatingNewEstimate}
              >
                <Plus className="h-3 w-3 mr-1" />
                {creatingNewEstimate ? "Creating…" : "New Estimate (different house?)"}
              </Button>
            </div>
          )}

          {/* Tier prices */}
          {estimate && estimate.tiers && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm sm:text-base">
                  Estimate
                  {sortedEstimates.length > 1 && estimate && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      #{sortedEstimates.length - sortedEstimates.findIndex((e) => e.id === estimate.id)}
                      {estimate.label && ` · ${estimate.label}`}
                    </span>
                  )}
                </CardTitle>
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
                {fenceSides.length > 0 && (
                  <div className="rounded-md border bg-muted/20 px-3 py-2 text-xs">
                    <span className="font-semibold text-muted-foreground">Sides included:</span>{" "}
                    <span className="font-medium">{fenceSides.join(", ")}</span>
                  </div>
                )}
                {estimate.breakdown.length > 0 && (
                  <BreakdownEditor
                    estimateId={estimate.id}
                    items={estimate.breakdown}
                    onSaved={(updated) => {
                      setLead((prev) => {
                        if (!prev) return prev;
                        return {
                          ...prev,
                          estimates: prev.estimates.map((e) => (e.id === updated.id ? updated : e)),
                          estimate: prev.estimate?.id === updated.id ? updated : prev.estimate,
                        };
                      });
                    }}
                  />
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

              {/* Pre-estimate call section removed per spec — VAs no longer
                  required to log a pre-call before sending. Backend
                  Estimate.precall_* fields stay in place for historical data. */}

              {/* Send disabled — old pipeline */}
              {lead.pipeline_version === "v1" && (
                <div className="rounded-lg border-2 border-red-300 bg-red-50/60 p-3">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 text-red-600 mt-0.5 shrink-0" />
                    <div>
                      <p className="text-sm font-semibold text-red-800">Send disabled — old pipeline</p>
                      <p className="text-xs text-red-700 mt-0.5">
                        The old GHL account is no longer reachable, so SMS won't deliver to the customer.
                        Use the <span className="font-semibold">Export to New Pipeline</span> card below first, then send from there.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* After-hours warning */}
              {isAfterHours() && !showScheduler && lead.pipeline_version !== "v1" && (
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

              <div className="mb-2 space-y-1">
                <div className="text-xs font-medium text-muted-foreground">Send via</div>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <label
                    className={`flex items-center gap-2 text-xs select-none ${
                      lead.contact_phone ? "text-foreground cursor-pointer" : "text-muted-foreground cursor-not-allowed"
                    }`}
                    title={
                      lead.contact_phone
                        ? `SMS to ${lead.contact_phone}`
                        : "No phone on file — SMS unavailable"
                    }
                  >
                    <input
                      type="checkbox"
                      checked={sendSms && !!lead.contact_phone}
                      disabled={!lead.contact_phone}
                      onChange={(e) => setSendSms(e.target.checked)}
                      className="h-3.5 w-3.5"
                    />
                    SMS
                    {lead.contact_phone && (
                      <span className="text-muted-foreground truncate">→ {lead.contact_phone}</span>
                    )}
                  </label>
                  <label
                    className={`flex items-center gap-2 text-xs select-none ${
                      lead.contact_email ? "text-foreground cursor-pointer" : "text-muted-foreground cursor-not-allowed"
                    }`}
                    title={
                      lead.contact_email
                        ? `Email to ${lead.contact_email}`
                        : "No email on file — email unavailable"
                    }
                  >
                    <input
                      type="checkbox"
                      checked={alsoEmail && !!lead.contact_email}
                      disabled={!lead.contact_email}
                      onChange={(e) => setAlsoEmail(e.target.checked)}
                      className="h-3.5 w-3.5"
                    />
                    Email
                    {lead.contact_email && (
                      <span className="text-muted-foreground truncate">→ {lead.contact_email}</span>
                    )}
                  </label>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => handleApprove()}
                  disabled={approving || lead.pipeline_version === "v1"}
                  title={lead.pipeline_version === "v1" ? "Export to new pipeline before sending" : "Sends the proposal + applies the 'estimate sent' GHL tag (triggers P1 / P04 automations)"}
                  className="flex-1 bg-green-600 hover:bg-green-700 text-white disabled:bg-gray-300"
                >
                  <Send className={`h-4 w-4 mr-2 ${approving ? "animate-spin" : ""}`} />
                  {approving ? "Sending..." : "Send Now"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setScheduledDate(getDefaultScheduleDate());
                    setShowScheduler(!showScheduler);
                  }}
                  disabled={approving || lead.pipeline_version === "v1"}
                  title={lead.pipeline_version === "v1" ? "Export to new pipeline before scheduling" : undefined}
                  className="shrink-0"
                >
                  <Clock className="h-4 w-4 mr-1" /> Schedule
                </Button>
              </div>
              {/* Marks that this estimate was done on-site (in person) vs remote.
                  Stored on the lead's form_data, same pattern as addons_handled. */}
              <label className="flex items-center gap-2 text-xs mt-1 cursor-pointer text-muted-foreground w-fit">
                <input
                  type="checkbox"
                  checked={Boolean(lead?.form_data?.estimated_in_person)}
                  onChange={async (e) => {
                    if (!id) return;
                    try {
                      await api.updateFormData(id, { estimated_in_person: e.target.checked });
                      const data = await api.getLead(id);
                      setLead(data);
                      toast.success(e.target.checked ? "Marked estimated in person" : "Unmarked");
                    } catch { toast.error("Failed to save"); }
                  }}
                  className="rounded border-input"
                />
                Estimated in Person
              </label>
              {/* Second send path — same proposal + customer SMS, but skips
                  the "estimate sent" GHL tag so the P1/P04 follow-up
                  automations don't fire for this send. Confirmation prompt
                  inside handleApprove guards against accidental clicks. */}
              <Button
                variant="outline"
                onClick={() => handleApprove(undefined, false)}
                disabled={approving || lead.pipeline_version === "v1"}
                title="Send the proposal without applying the 'estimate sent' GHL tag (no GHL automation fires)"
                className="w-full border-amber-300 text-amber-900 hover:bg-amber-50 hover:text-amber-900"
              >
                <Send className={`h-4 w-4 mr-2 ${approving ? "animate-spin" : ""}`} />
                {approving ? "Sending..." : "Send Without Tag (no automation)"}
              </Button>
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

          {/* Send a pre-made PDF as the proposal (same link + viewer + SMS) */}
          <CustomProposalCard
            leadId={lead.id}
            pipelineVersion={lead.pipeline_version}
            onSent={() => { if (id) api.getLead(id).then(setLead).catch(() => {}); }}
          />

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

          {/* Estimate history — every estimate sent to this customer with
              freeform local label + input snapshot. Hides itself when the
              lead has no sent estimates yet. */}
          <EstimateHistoryCard leadId={lead.id} refreshKey={lead.estimates?.length || 0} />

          {/* Export to new pipeline (v1 leads only) */}
          {lead.pipeline_version === "v1" && (
            <Card className="border-blue-200 bg-blue-50/40">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <ArrowRightCircle className="h-4 w-4 text-blue-600" />
                  Export to New Pipeline
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 pt-0">
                <p className="text-xs text-muted-foreground">
                  Move this lead onto the new GHL pipeline. All history (estimates, notes, contact info) is preserved.
                </p>
                <select
                  value={exportStageId}
                  onChange={(e) => setExportStageId(e.target.value)}
                  className={selectCls}
                  disabled={exporting}
                >
                  {V2_STAGES.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
                <Button onClick={handleExportToV2} disabled={exporting} className="w-full bg-blue-600 hover:bg-blue-700 text-white">
                  {exporting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <ArrowRightCircle className="h-4 w-4 mr-2" />}
                  Export to "{V2_STAGES.find((s) => s.id === exportStageId)?.shortLabel}"
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

          {/* Below the grid (full width inside the Estimate tab): route
              stacking hints + worker hours. NearbyJobsCard gets the wider
              canvas it couldn't have when stuffed above the grid. */}
          <NearbyJobsCard leadId={lead.id} />
          <TimeSpentCard leadId={lead.id} />

          {/* The lead's Daily Task List row — the exact same row (stage picker,
              call log, notes, E/S/L prices, follow-up, actions) the VA sees on
              the dashboard queue, mirrored here. */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm sm:text-base flex items-center gap-2">
                <MessageSquare className="h-4 w-4" /> Daily Task List
              </CardTitle>
            </CardHeader>
            <CardContent>
              <DailyTaskList leadId={lead.id} />
            </CardContent>
          </Card>

          {/* QuickBooks payments — restricted preview (allowlisted accounts only). */}
          {canSeeRevenue() && <LeadInvoicesCard leadId={lead.id} leadName={lead.contact_name || ""} />}
        </TabsContent>

        <TabsContent value="call" className="space-y-4 sm:space-y-6 mt-4">
          {/* Last AI call intel (Sprint 4 T4.C) — pinned at top so Alan sees
              previous-call context before pinning the next disposition. */}
          <LastCallIntelStrip leadId={lead.id} />

          {/* Disposition picker (Sprint 2 T2.A) — 10-second log post-call. */}
          <CallDispositionCard leadId={lead.id} contactName={lead.contact_name || ""} />

          {/* Recent SMS preview (Sprint 2 T2.D) — last 3 messages with a
              Check button for manual GHL pulls. */}
          <RecentConversationCard
            messages={messages}
            leadPipelineVersion={lead.pipeline_version}
            checking={checkingResponse}
            onCheck={handleCheckResponse}
          />

          {/* Full message history */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm sm:text-base flex items-center gap-2">
                  <MessageSquare className="h-4 w-4" /> Messages
                </CardTitle>
                <Button
                  variant="outline" size="sm"
                  onClick={handleCheckResponse}
                  disabled={checkingResponse || lead.pipeline_version === "v1"}
                  title={lead.pipeline_version === "v1" ? "Old pipeline — export to load messages" : undefined}
                >
                  <RefreshCw className={`h-3.5 w-3.5 mr-1 ${checkingResponse ? "animate-spin" : ""}`} />
                  Check
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {lead.pipeline_version === "v1" ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  Messages won't load — the old GHL account is no longer reachable.
                  Export to the new pipeline to enable message sync.
                </p>
              ) : messages.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No messages yet</p>
              ) : (
                <MessageList messages={messages} />
              )}
            </CardContent>
          </Card>

          {/* Chatbot conversation */}
          <ChatbotMessagesCard leadId={id!} />

          {/* Call recordings + AI analysis (Sprint 4) */}
          <CallRecordingsCard leadId={id!} />

          {/* Automated follow-up runs (admin-only — self-gates) */}
          <FollowUpStatusPanel
            lead={lead}
            onLeadUpdated={() => { if (id) api.getLead(id).then(setLead).catch(() => {}); }}
          />
        </TabsContent>

        <TabsContent value="exterior" className="space-y-4 sm:space-y-6 mt-4">
          <ExteriorTab lead={lead} onChange={(updated) => setLead(updated)} />
        </TabsContent>

        <TabsContent value="upsell" className="space-y-4 sm:space-y-6 mt-4">
          <UpsellTab lead={lead} />
        </TabsContent>

        <TabsContent value="estimator" className="space-y-4 sm:space-y-6 mt-4">
          <Card>
            <CardContent className="p-4">
              <EstimatorLeadPanel leadId={lead.id} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Archive — parked at the very bottom (and behind a confirm) so a lead
          never gets archived by accident. */}
      <div className="mt-8 pt-6 border-t flex justify-center">
        {lead.status === "archived" ? (
          <Button variant="outline" onClick={handleUnarchive} className="max-w-xs">
            <ArchiveRestore className="h-4 w-4 mr-2" /> Restore from Archive
          </Button>
        ) : (
          <Button variant="ghost" onClick={handleArchive} className="max-w-xs text-muted-foreground hover:text-destructive">
            <Archive className="h-4 w-4 mr-2" /> Archive Lead
          </Button>
        )}
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

      {/* Decline Reasons Modal */}
      {lead && (
        <DeclineReasonsModal
          open={declineModalOpen}
          onOpenChange={setDeclineModalOpen}
          leadId={lead.id}
          existingReasons={(((lead.form_data as Record<string, unknown> | undefined)?.decline_reasons) as string[] | undefined) || []}
          existingOtherText={String((lead.form_data as Record<string, unknown> | undefined)?.decline_other_text || "")}
          onSaved={async () => {
            const data = await api.getLead(id!);
            setLead(data);
          }}
        />
      )}

      {/* Generate Invoice modal */}
      {invoiceModalOpen && latestScheduledJob && lead && (
        <GenerateInvoiceModal
          job={latestScheduledJob}
          lead={lead}
          onClose={() => setInvoiceModalOpen(false)}
          onSaved={(updatedJob) => {
            setLatestScheduledJob(updatedJob);
            setInvoiceModalOpen(false);
          }}
        />
      )}
    </div>
  );
}


function ChatbotMessagesCard({ leadId }: { leadId: string }) {
  const [messages, setMessages] = useState<{ id: string; direction: string; content: string; is_escalated?: boolean; escalation_reason?: string; created_at: string }[]>([]);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getChatbotLeadMessages(leadId)
      .then((msgs) => { setMessages(msgs); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, [leadId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const fetchSummary = () => {
    setLoadingSummary(true);
    api.getChatbotSummary(leadId)
      .then((res) => setSummary(res.summary))
      .catch(() => setSummary("Failed to load summary."))
      .finally(() => setLoadingSummary(false));
  };

  const handleReply = async () => {
    if (!reply.trim() || sending) return;
    setSending(true);
    try {
      const result = await api.chatbotReply(leadId, reply.trim());
      setReply("");
      const msgs = await api.getChatbotLeadMessages(leadId);
      setMessages(msgs);
      if (result.nudge_scheduled) {
        toast.success("Reply sent as Amy — customer will be nudged in 2 min if they left the page");
      } else {
        toast.success("Reply sent as Amy");
      }
    } catch {
      toast.error("Failed to send reply");
    } finally {
      setSending(false);
    }
  };

  if (!loaded) return null;

  return (
    <Card id="chatbot">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm sm:text-base flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-amber-600" /> Chatbot Messages
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* AI Summary */}
        {messages.length > 0 && (
          <div className="mb-3 pb-3 border-b">
            {summary === null ? (
              <Button variant="outline" size="sm" onClick={fetchSummary} disabled={loadingSummary} className="w-full">
                {loadingSummary ? (
                  <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Generating summary...</>
                ) : (
                  <><WandSparkles className="h-3.5 w-3.5 mr-1.5" /> Generate AI Summary</>
                )}
              </Button>
            ) : (
              <div className="bg-violet-50 border border-violet-200 rounded-lg p-3">
                <p className="text-xs font-semibold text-violet-700 mb-1.5 flex items-center gap-1">
                  <WandSparkles className="h-3 w-3" /> AI Summary
                </p>
                <div className="text-sm text-violet-900 whitespace-pre-line">{summary}</div>
              </div>
            )}
          </div>
        )}

        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">No chatbot conversations yet</p>
        ) : (
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {messages.map((msg) => (
              <div key={msg.id}>
                {msg.is_escalated && (
                  <div className="flex items-center gap-1 text-[10px] text-amber-600 bg-amber-50 rounded px-2 py-1 mb-1">
                    <AlertTriangle className="h-3 w-3" />
                    Escalated: {msg.escalation_reason || "Could not answer"}
                  </div>
                )}
                <div className={`rounded-lg px-3 py-2 text-sm max-w-[85%] ${
                  msg.direction === "user"
                    ? "bg-muted mr-auto"
                    : msg.direction === "human"
                    ? "bg-blue-50 border border-blue-200 ml-auto text-right"
                    : "bg-amber-50 border border-amber-200 ml-auto text-right"
                }`}>
                  <p className="text-xs font-medium text-muted-foreground mb-0.5">
                    {msg.direction === "user" ? "Customer" : msg.direction === "human" ? "Team (as Amy)" : "Amy"} — {timeAgo(msg.created_at)}
                  </p>
                  <p>{msg.content}</p>
                </div>
              </div>
            ))}
            <div ref={endRef} />
          </div>
        )}

        {/* Reply as Amy */}
        <div className="mt-3 pt-3 border-t space-y-1.5">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleReply()}
              placeholder="Reply as Amy..."
              className="flex-1 px-3 py-1.5 rounded-md border text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <Button size="sm" onClick={handleReply} disabled={!reply.trim() || sending}>
              <Send className="h-3.5 w-3.5" />
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground px-1">
            Tip: Start with "Exact:" to send your message word-for-word as Amy
          </p>
        </div>
      </CardContent>
    </Card>
  );
}


function pickRecorderMime(): { mime: string; ext: string } {
  const candidates: { mime: string; ext: string }[] = [
    { mime: "audio/webm;codecs=opus", ext: "webm" },
    { mime: "audio/webm", ext: "webm" },
    { mime: "audio/mp4", ext: "m4a" },
    { mime: "audio/mp4;codecs=mp4a.40.2", ext: "m4a" },
    { mime: "audio/ogg;codecs=opus", ext: "ogg" },
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c.mime)) return c;
  }
  return { mime: "", ext: "webm" };
}

function CallRecordingsCard({ leadId }: { leadId: string }) {
  const [recordings, setRecordings] = useState<CallRecordingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [recState, setRecState] = useState<"idle" | "recording" | "uploading" | "done">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const loadCalls = () => {
    api.getLeadCalls(leadId)
      .then(setRecordings)
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  const handleToggleFavorite = async (rec: CallRecordingEntry) => {
    const next = !rec.is_favorite;
    setRecordings((prev) => prev.map((r) => (r.id === rec.id ? { ...r, is_favorite: next } : r)));
    try {
      await api.setCallFavorite(rec.id, next);
    } catch {
      toast.error("Couldn't update favorite");
      setRecordings((prev) => prev.map((r) => (r.id === rec.id ? { ...r, is_favorite: !next } : r)));
    }
  };

  const handleArchive = async (rec: CallRecordingEntry) => {
    if (!confirm("Archive this recording? The 'called' icon will be removed if no other recordings remain.")) return;
    try {
      await api.archiveCall(rec.id);
      toast.success("Recording archived");
      loadCalls();
    } catch (e: any) {
      toast.error(e?.message || "Couldn't archive");
    }
  };

  const handleRetry = async (rec: CallRecordingEntry) => {
    try {
      await api.retryCallTranscription(rec.id);
      toast.success("Retrying transcription...");
      setTimeout(loadCalls, 5000);
      setTimeout(loadCalls, 15000);
    } catch {
      toast.error("Couldn't retry");
    }
  };

  const handlePlay = (rec: CallRecordingEntry) => {
    if (playingId === rec.id) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }
    audioRef.current?.pause();
    const audio = new Audio(api.getCallAudioUrl(rec.id));
    audio.onended = () => setPlayingId(null);
    audio.onerror = () => { toast.error("Couldn't play recording"); setPlayingId(null); };
    audio.play().catch(() => { toast.error("Couldn't play recording"); setPlayingId(null); });
    audioRef.current = audio;
    setPlayingId(rec.id);
  };

  useEffect(() => { loadCalls(); }, [leadId]);

  // Warn before tab close while recording
  useEffect(() => {
    if (recState !== "recording") return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "Recording in progress — leaving will lose it.";
      return e.returnValue;
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [recState]);

  const stopTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const releaseStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const triggerUpload = async (file: File) => {
    try {
      await api.uploadCallRecording(file, leadId);
      toast.success("Recording uploaded — transcribing and analyzing...");
      setTimeout(loadCalls, 5000);
      setTimeout(loadCalls, 15000);
      setTimeout(loadCalls, 30000);
    } catch {
      toast.error("Upload failed");
      throw new Error("upload failed");
    }
  };

  const handleStartRecording = async () => {
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      toast.error("Recording not supported in this browser");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const { mime, ext } = pickRecorderMime();
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stopTimer();
        releaseStream();
        const blob = new Blob(chunksRef.current, { type: mime || "audio/webm" });
        chunksRef.current = [];
        if (blob.size === 0) {
          setRecState("idle");
          setElapsed(0);
          return;
        }
        setRecState("uploading");
        const filename = `call-${Date.now()}.${ext}`;
        const file = new File([blob], filename, { type: blob.type });
        try {
          await triggerUpload(file);
          setRecState("done");
          setTimeout(() => { setRecState("idle"); setElapsed(0); }, 3000);
        } catch {
          setRecState("idle");
          setElapsed(0);
        }
      };

      recorder.start();
      setElapsed(0);
      setRecState("recording");
      timerRef.current = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    } catch (err: any) {
      const msg = err?.name === "NotAllowedError"
        ? "Microphone permission denied"
        : "Could not start recording";
      toast.error(msg);
      releaseStream();
    }
  };

  const handleStopRecording = () => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
  };

  const handleCancelRecording = () => {
    chunksRef.current = [];
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      // Detach onstop so cancellation doesn't trigger upload
      recorderRef.current.onstop = () => {
        stopTimer();
        releaseStream();
      };
      recorderRef.current.stop();
    } else {
      stopTimer();
      releaseStream();
    }
    setRecState("idle");
    setElapsed(0);
  };

  // Cleanup on unmount
  useEffect(() => () => {
    stopTimer();
    releaseStream();
    audioRef.current?.pause();
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.onstop = null;
      try { recorderRef.current.stop(); } catch {}
    }
  }, []);

  const fmtElapsed = (s: number) => {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, "0")}`;
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      await api.uploadCallRecording(file, leadId);
      toast.success("Recording uploaded — transcribing and analyzing...");
      // Poll for results after a delay
      setTimeout(loadCalls, 5000);
      setTimeout(loadCalls, 15000);
      setTimeout(loadCalls, 30000);
    } catch { toast.error("Upload failed"); }
    finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const scoreColor = (score: number) => {
    if (score >= 7) return "text-green-600 bg-green-50";
    if (score >= 4) return "text-amber-600 bg-amber-50";
    return "text-red-600 bg-red-50";
  };

  const formatDuration = (secs: number) => {
    if (!secs) return "—";
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm sm:text-base flex items-center gap-2">
            <Mic className="h-4 w-4 text-purple-600" /> Call Recordings
          </CardTitle>
          <div className="flex gap-2 flex-wrap">
            {recState === "idle" && (
              <Button
                variant="default"
                size="sm"
                className="bg-red-600 hover:bg-red-700 text-white"
                onClick={handleStartRecording}
                title="Put your phone on speakerphone first, then start"
              >
                <Mic className="h-3.5 w-3.5 mr-1" />
                Record Call
              </Button>
            )}
            {recState === "recording" && (
              <>
                <div className="flex items-center gap-2 px-2.5 py-1 rounded-md bg-red-50 border border-red-200">
                  <span className="h-2 w-2 rounded-full bg-red-600 animate-pulse" />
                  <span className="text-xs font-mono font-semibold text-red-700">{fmtElapsed(elapsed)}</span>
                </div>
                <Button variant="default" size="sm" className="bg-red-600 hover:bg-red-700 text-white" onClick={handleStopRecording}>
                  Stop
                </Button>
                <Button variant="outline" size="sm" onClick={handleCancelRecording}>
                  Cancel
                </Button>
              </>
            )}
            {recState === "uploading" && (
              <div className="flex items-center gap-2 px-2.5 py-1 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Uploading...
              </div>
            )}
            {recState === "done" && (
              <div className="flex items-center gap-2 px-2.5 py-1 text-xs text-green-700">
                <CheckCircle2 className="h-3.5 w-3.5" /> Saved
              </div>
            )}
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={uploading || recState !== "idle"}>
              <Upload className="h-3.5 w-3.5 mr-1" />
              {uploading ? "Uploading..." : "Upload"}
            </Button>
            <input ref={fileRef} type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg" className="hidden" onChange={handleUpload} />
            <Button variant="outline" size="sm" onClick={loadCalls}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        {recState === "idle" && (
          <p className="text-[11px] text-muted-foreground mt-1.5">
            Put your phone on speakerphone next to your mic, then hit Record. Stop when the call ends — it'll auto-upload.
          </p>
        )}
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="h-10 bg-muted rounded animate-pulse" />
        ) : recordings.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">No call recordings yet. Upload one or wait for GHL sync.</p>
        ) : (
          <div className="space-y-2">
            {recordings.map((rec) => {
              const isExpanded = expandedId === rec.id;
              const analysis = rec.analysis;
              const transcript = rec.transcript;
              const isPlaying = playingId === rec.id;
              const isFailed = rec.status === "failed";
              return (
                <div key={rec.id} className={`border rounded-lg overflow-hidden ${rec.is_favorite ? "border-amber-300" : ""}`}>
                  <div className="px-3 py-2.5 flex items-start gap-2">
                    <button
                      onClick={(e) => { e.stopPropagation(); handleToggleFavorite(rec); }}
                      className="shrink-0 mt-0.5"
                      title={rec.is_favorite ? "Unstar" : "Star for training"}
                    >
                      <Star className={`h-4 w-4 ${rec.is_favorite ? "fill-amber-400 text-amber-400" : "text-muted-foreground hover:text-amber-400"}`} />
                    </button>
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : rec.id)}
                      className="flex-1 min-w-0 text-left"
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">{timeAgo(rec.created_at)}</span>
                        <Badge variant="outline" className="text-[10px] capitalize">{rec.call_direction}</Badge>
                        <span className="text-xs text-muted-foreground">{formatDuration(rec.duration_seconds)}</span>
                        {rec.recorded_by && (
                          <Badge variant="outline" className="text-[10px]">{rec.recorded_by}</Badge>
                        )}
                        {rec.status === "pending" && <Badge className="text-[10px] bg-blue-100 text-blue-800">Processing...</Badge>}
                        {isFailed && <Badge className="text-[10px] bg-red-100 text-red-800">Failed</Badge>}
                      </div>
                      {analysis && (
                        <>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${scoreColor(analysis.call_score)}`}>
                              {analysis.call_score}/10
                            </span>
                            <span className="text-xs text-muted-foreground capitalize">
                              Sentiment: {analysis.customer_sentiment}
                            </span>
                            <span className="text-xs text-muted-foreground capitalize">
                              Close: {(analysis.close_likelihood || "").replace(/_/g, " ")}
                            </span>
                          </div>
                          {/* Sprint 4 T4.E (2026-06-08) — Scannable summary
                              + next action inline so admin can browse past
                              calls without expanding each row. Each line is
                              clamped to 2 lines to keep the row tight. */}
                          {analysis.summary_one_line && (
                            <p className="text-xs text-foreground mt-1 line-clamp-2 whitespace-normal">
                              {analysis.summary_one_line}
                            </p>
                          )}
                          {analysis.next_action && (
                            <p className="text-xs text-violet-700 mt-0.5 line-clamp-2 whitespace-normal">
                              <span className="font-semibold">→ Next:</span> {analysis.next_action}
                            </p>
                          )}
                        </>
                      )}
                    </button>
                    <div className="flex items-center gap-0.5 shrink-0">
                      {rec.has_recording && (
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={(e) => { e.stopPropagation(); handlePlay(rec); }} title={isPlaying ? "Pause" : "Play"}>
                          {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                        </Button>
                      )}
                      {isFailed && (
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={(e) => { e.stopPropagation(); handleRetry(rec); }} title="Retry transcription">
                          <RotateCw className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-red-600" onClick={(e) => { e.stopPropagation(); handleArchive(rec); }} title="Archive">
                        <Archive className="h-3.5 w-3.5" />
                      </Button>
                      <button onClick={() => setExpandedId(isExpanded ? null : rec.id)} className="h-7 w-7 flex items-center justify-center text-muted-foreground">
                        {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="border-t px-3 py-3 space-y-3 bg-muted/10">
                      {rec.has_recording && (
                        <SyncedTranscriptPlayer
                          recordingId={rec.id}
                          segments={transcript?.segments || []}
                          speakerMap={transcript?.speaker_map || {}}
                          initialNotes={rec.notes || ""}
                        />
                      )}
                      {!rec.has_recording && rec.status === "pending" && (
                        <p className="text-xs text-muted-foreground text-center py-2">Transcription in progress…</p>
                      )}
                      {!rec.has_recording && isFailed && (
                        <p className="text-xs text-muted-foreground text-center py-2">
                          Transcription failed. Hit the retry icon to run it again.
                        </p>
                      )}
                      {/* Scoring/coaching analysis hidden for now to match the
                          Call Coach page. Re-enable when scoring comes back. */}
                      {/* {analysis && <CallCoachAnalysis analysis={analysis} />} */}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}


function BreakdownEditor({
  estimateId, items, onSaved,
}: {
  estimateId: string;
  items: BreakdownItem[];
  onSaved: (updated: EstimateDetail) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editItems, setEditItems] = useState<BreakdownItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedSnapshot, setSavedSnapshot] = useState<BreakdownItem[]>([]);

  const startEdit = () => {
    // Deep clone the current items as editable
    const cloned = items.map((item) => ({
      ...item,
      rate: item.rate ?? undefined,
      qty: item.qty ?? undefined,
    }));
    setEditItems(cloned);
    setSavedSnapshot(cloned);
    setEditing(true);
  };

  const updateItem = (index: number, updates: Partial<BreakdownItem>) => {
    setEditItems((prev) =>
      prev.map((item, i) => {
        if (i !== index) return item;
        const updated = { ...item, ...updates };
        // Recalculate value if rate and qty are present
        if (updated.rate != null && updated.qty != null) {
          updated.value = Math.round(updated.rate * updated.qty * 100) / 100;
        }
        return updated;
      }),
    );
  };

  const addSurcharge = (type: "rate" | "flat") => {
    if (type === "rate") {
      setEditItems((prev) => [...prev, { label: "Surcharge", rate: 0, qty: 0, value: 0, note: "Custom surcharge" }]);
    } else {
      setEditItems((prev) => [...prev, { label: "Surcharge", value: 0, note: "Flat surcharge" }]);
    }
  };

  const removeItem = (index: number) => {
    setEditItems((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const result = await api.overrideBreakdown(estimateId, editItems);
      onSaved(result);
      setEditing(false);
      toast.success("Breakdown updated");
    } catch {
      toast.error("Failed to save breakdown");
    } finally {
      setSaving(false);
    }
  };

  const handleUndo = () => {
    setEditItems(savedSnapshot.map((item) => ({ ...item })));
  };

  const total = editing ? editItems.reduce((sum, item) => sum + (item.value || 0), 0) : 0;

  if (!editing) {
    return (
      <div className="pt-2 border-t space-y-1">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground">Breakdown</p>
          <button onClick={startEdit} className="text-[10px] text-primary hover:underline flex items-center gap-0.5">
            <Pencil className="h-3 w-3" /> Edit
          </button>
        </div>
        {items.map((item, i) => (
          <div key={i} className="flex justify-between text-xs">
            <span className="truncate mr-2">{item.label}</span>
            <span className="font-medium shrink-0">{formatCurrency(item.value)}</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="pt-2 border-t space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">Edit Breakdown</p>
        <div className="flex items-center gap-1">
          <button onClick={handleUndo} className="p-1 rounded hover:bg-muted text-muted-foreground" title="Undo changes">
            <Undo2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="space-y-2">
        {editItems.map((item, i) => (
          <div key={i} className="rounded-md border bg-muted/20 p-2 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Input
                value={item.label}
                onChange={(e) => updateItem(i, { label: e.target.value })}
                className="h-7 text-xs flex-1"
                placeholder="Label"
              />
              <button onClick={() => removeItem(i)} className="p-1 rounded hover:bg-red-100 text-muted-foreground hover:text-red-500">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            {item.rate != null && item.qty != null ? (
              <div className="flex items-center gap-1.5 text-xs">
                <span className="text-muted-foreground shrink-0">$</span>
                <Input
                  type="number" step="0.01"
                  value={item.rate}
                  onChange={(e) => updateItem(i, { rate: parseFloat(e.target.value) || 0 })}
                  className="h-6 text-xs w-20"
                  placeholder="Rate"
                />
                <span className="text-muted-foreground shrink-0">x</span>
                <Input
                  type="number" step="1"
                  value={item.qty}
                  onChange={(e) => updateItem(i, { qty: parseFloat(e.target.value) || 0 })}
                  className="h-6 text-xs w-20"
                  placeholder="Qty"
                />
                <span className="text-muted-foreground shrink-0">=</span>
                <span className="font-medium text-xs">{formatCurrency(item.value)}</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-xs">
                <span className="text-muted-foreground shrink-0">$</span>
                <Input
                  type="number" step="0.01"
                  value={item.value}
                  onChange={(e) => updateItem(i, { value: parseFloat(e.target.value) || 0 })}
                  className="h-6 text-xs w-28"
                  placeholder="Amount"
                />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Add surcharge buttons */}
      <div className="flex gap-1.5">
        <button
          onClick={() => addSurcharge("rate")}
          className="flex items-center gap-1 text-[10px] text-primary hover:underline"
        >
          <Plus className="h-3 w-3" /> Rate x Qty
        </button>
        <span className="text-muted-foreground text-[10px]">|</span>
        <button
          onClick={() => addSurcharge("flat")}
          className="flex items-center gap-1 text-[10px] text-primary hover:underline"
        >
          <Plus className="h-3 w-3" /> Flat Amount
        </button>
      </div>

      {/* Total + Save */}
      <div className="flex items-center justify-between pt-1.5 border-t">
        <span className="text-xs font-medium">Essential Total: {formatCurrency(total)}</span>
        <div className="flex gap-1.5">
          <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            <Save className="h-3.5 w-3.5 mr-1" /> {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}


function MessageList({ messages }: { messages: MessageEntry[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  // Sort oldest → newest (backend returns newest first)
  const sorted = [...messages].reverse();

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="space-y-2 max-h-[300px] overflow-y-auto">
      {sorted.map((msg) => (
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
      <div ref={endRef} />
    </div>
  );
}


function DeclineReasonsModal({
  open, onOpenChange, leadId, existingReasons, existingOtherText, onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  leadId: string;
  existingReasons: string[];
  existingOtherText: string;
  onSaved: () => Promise<void> | void;
}) {
  const [presets, setPresets] = useState<{ key: string; label: string }[]>([]);
  const [selected, setSelected] = useState<string[]>(existingReasons);
  const [otherText, setOtherText] = useState(existingOtherText);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    api.getDeclineReasonPresets().then(setPresets).catch(() => {});
    setSelected(existingReasons);
    setOtherText(existingOtherText);
  }, [open, existingReasons, existingOtherText]);

  const toggle = (key: string) => {
    setSelected((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]);
  };

  const move = (idx: number, dir: -1 | 1) => {
    const next = [...selected];
    const swap = idx + dir;
    if (swap < 0 || swap >= next.length) return;
    [next[idx], next[swap]] = [next[swap], next[idx]];
    setSelected(next);
  };

  const handleSave = async () => {
    if (selected.length === 0) {
      toast.error("Pick at least one reason");
      return;
    }
    if (selected.includes("other") && !otherText.trim()) {
      toast.error("Please describe the 'Other' reason");
      return;
    }
    setSaving(true);
    try {
      await api.setDeclineReasons(leadId, selected, otherText);
      toast.success("Decline reasons saved");
      await onSaved();
      onOpenChange(false);
    } catch {
      toast.error("Couldn't save");
    } finally {
      setSaving(false);
    }
  };

  const handleSkip = async () => {
    try {
      await api.skipDeclineReasons(leadId);
      onOpenChange(false);
    } catch { /* silent */ }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => onOpenChange(false)}>
      <div className="bg-background rounded-lg shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b">
          <h2 className="text-lg font-semibold">Why did this customer decline?</h2>
          <p className="text-xs text-muted-foreground mt-1">Pick all that apply. The order matters — drag the most important reason to the top.</p>
        </div>

        <div className="p-4 space-y-3">
          {/* Selected (in rank order) */}
          {selected.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-semibold text-muted-foreground">Selected (rank order)</p>
              {selected.map((key, i) => {
                const preset = presets.find((p) => p.key === key);
                return (
                  <div key={key} className="flex items-center gap-2 p-2 rounded border bg-muted/30">
                    <span className="text-xs font-bold w-5 text-center text-muted-foreground">{i + 1}</span>
                    <span className="text-sm flex-1">{preset?.label || key}</span>
                    <button onClick={() => move(i, -1)} disabled={i === 0} className="text-muted-foreground hover:text-foreground disabled:opacity-30 px-1" title="Move up">↑</button>
                    <button onClick={() => move(i, 1)} disabled={i === selected.length - 1} className="text-muted-foreground hover:text-foreground disabled:opacity-30 px-1" title="Move down">↓</button>
                    <button onClick={() => toggle(key)} className="text-muted-foreground hover:text-red-600 px-1" title="Remove">×</button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Available presets */}
          <div className="space-y-1">
            <p className="text-xs font-semibold text-muted-foreground">Reasons</p>
            {presets.map((p) => {
              const checked = selected.includes(p.key);
              return (
                <label key={p.key} className={`flex items-center gap-2 p-2 rounded cursor-pointer hover:bg-muted/50 ${checked ? "opacity-50" : ""}`}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(p.key)} />
                  <span className="text-sm">{p.label}</span>
                </label>
              );
            })}
          </div>

          {/* Other text */}
          {selected.includes("other") && (
            <div>
              <label className="text-xs font-semibold text-muted-foreground">Describe the "Other" reason</label>
              <textarea
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
                placeholder="What did the customer say?"
                className="w-full mt-1 border border-input rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                rows={3}
              />
            </div>
          )}
        </div>

        <div className="p-4 border-t flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={handleSkip}>Skip for now</Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}


// Phase 2 (2026-06-08): Payment Links section. Two compact rows that live
// inside the Contact Information card — one for the $250 deposit, one for
// the full job invoice. Replaces the standalone DepositCard that used to
// sit above the tabs. The 4-state deposit logic ("" / pending / paid /
// waived) and the API calls are unchanged — only the UI footprint shrunk
// so a busy lead detail page doesn't get dominated by payment widgets.
//
// The schedule-job soft warning in ScheduleJobModal still reads
// lead.deposit_status the same way, so the gate behavior is untouched.
function DepositRow({
  lead,
  onChange,
}: {
  lead: LeadDetailType;
  onChange: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [waiving, setWaiving] = useState(false);
  const [copyingLink, setCopyingLink] = useState(false);
  const status = (lead.deposit_status || "").toLowerCase();
  const link = lead.deposit_payment_link || "";
  const sentAt = lead.deposit_invoice_sent_at || "";
  const paidAt = lead.deposit_paid_at || "";
  const amount = lead.deposit_amount || 250;

  const handleSend = async () => {
    if (!confirm(`Send a $${amount.toFixed(0)} non-refundable deposit invoice to ${lead.contact_name || "this customer"}?`)) return;
    setSending(true);
    try {
      const r = await api.sendDepositInvoice(lead.id);
      if (r.status === "sent") {
        if (r.sms_sent) toast.success("Deposit link texted to the customer.");
        else toast.warning("Invoice created, but the text didn't send (no phone/GHL contact). Share the link manually.");
      } else if (r.status === "already_sent") {
        if (r.sms_sent) toast.success("Deposit link re-texted to the customer.");
        else toast.info("Deposit invoice exists — couldn't text (no phone/GHL contact). Share the link manually.");
      } else if (r.status === "already_paid") {
        toast.success("Deposit already paid.");
      } else if (r.status === "waived") {
        toast.info("Deposit was waived for this lead.");
      } else {
        toast.success("Done.");
      }
      onChange();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to send deposit invoice");
    } finally {
      setSending(false);
    }
  };

  const handleWaive = async () => {
    if (!confirm(`Waive the $${amount.toFixed(0)} deposit for ${lead.contact_name || "this customer"}? Use this for trusted repeats only — the schedule gate's warning goes away.`)) return;
    setWaiving(true);
    try {
      await api.waiveDeposit(lead.id);
      toast.success("Deposit waived.");
      onChange();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to waive deposit");
    } finally {
      setWaiving(false);
    }
  };

  const handleCopy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.success("Payment link copied");
    } catch {
      toast.error("Couldn't copy — select and copy manually");
    }
  };

  // Fallback: generate the deposit invoice and copy its payment link so admin
  // can paste it anywhere (WhatsApp, email) WITHOUT auto-texting the customer.
  const handleCopyLink = async () => {
    setCopyingLink(true);
    try {
      const r = await api.sendDepositInvoice(lead.id, false);
      const url = r.deposit_payment_link || "";
      if (!url) {
        toast.error("Couldn't get a payment link — try Send instead.");
        return;
      }
      try {
        await navigator.clipboard.writeText(url);
        toast.success("Deposit link copied — paste it anywhere.");
      } catch {
        toast.info("Link ready — copy it from the field below.");
      }
      onChange();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create deposit link");
    } finally {
      setCopyingLink(false);
    }
  };

  const badgeCls =
    status === "paid"    ? "bg-emerald-600 text-white"
    : status === "pending" ? "bg-amber-600 text-white"
    : status === "waived"  ? "bg-slate-500 text-white"
                           : "bg-blue-600 text-white";
  const badgeLabel =
    status === "paid"    ? "PAID"
    : status === "pending" ? "PENDING"
    : status === "waived"  ? "WAIVED"
                           : "NOT STARTED";

  return (
    <div className="rounded-md border p-2.5 space-y-2 bg-muted/20">
      <div className="flex items-center gap-2 flex-wrap">
        <DollarSign className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-semibold">Deposit · ${amount.toFixed(0)}</span>
        <Badge className={`${badgeCls} text-[10px] h-5`}>{badgeLabel}</Badge>
        {status === "paid" && paidAt && (
          <span className="text-[11px] text-emerald-700 ml-auto">paid {timeAgo(paidAt)}</span>
        )}
        {status === "pending" && sentAt && (
          <span className="text-[11px] text-amber-700 ml-auto">sent {timeAgo(sentAt)}</span>
        )}
      </div>

      {!status && (
        <div className="space-y-1.5">
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" onClick={handleSend} disabled={sending || copyingLink}>
              {sending ? (
                <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Sending…</>
              ) : (
                <><Send className="h-3.5 w-3.5 mr-1" /> Send ${amount.toFixed(0)} Deposit Link</>
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleCopyLink}
              disabled={copyingLink || sending}
              title="Generate the deposit link and copy it — paste it into WhatsApp/email yourself (doesn't text the customer)"
            >
              {copyingLink ? (
                <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Getting link…</>
              ) : (
                <><Copy className="h-3.5 w-3.5 mr-1" /> Copy Link</>
              )}
            </Button>
          </div>
          <button
            onClick={handleWaive}
            disabled={waiving}
            className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2 disabled:opacity-50"
            title="Skip the deposit gate for trusted repeat customers"
          >
            {waiving ? "Waiving…" : "Waive for trusted repeat"}
          </button>
        </div>
      )}

      {status === "pending" && (
        <div className="space-y-2">
          {link && (
            <div className="flex items-center gap-2 flex-wrap">
              <Input
                readOnly
                value={link}
                className="text-xs flex-1 min-w-[200px] font-mono h-8"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button size="sm" variant="outline" onClick={handleCopy}>
                <Copy className="h-3.5 w-3.5 mr-1" /> Copy
              </Button>
              <a href={link} target="_blank" rel="noreferrer">
                <Button size="sm" variant="outline">
                  <ExternalLink className="h-3.5 w-3.5 mr-1" /> Open
                </Button>
              </a>
            </div>
          )}
          <Button size="sm" variant="outline" onClick={handleWaive} disabled={waiving}>
            {waiving ? "Waiving…" : "Waive instead"}
          </Button>
        </div>
      )}

      {status === "waived" && (
        <p className="text-[11px] text-slate-700">Schedule freely — no gate warning will appear.</p>
      )}
    </div>
  );
}

// Full-job invoice row. Mirrors the old standalone Generate Invoice button
// strip that used to live below the contact fields. Only meaningful once a
// ScheduledJob exists for the lead — before scheduling, the row tells admin
// to schedule first rather than disappearing silently.
function FullInvoiceRow({
  job,
  onGenerate,
}: {
  job: ScheduledJob | null;
  onGenerate: () => void;
}) {
  if (!job) {
    return (
      <div className="rounded-md border p-2.5 bg-muted/20">
        <div className="flex items-center gap-2 flex-wrap">
          <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs font-semibold">Full Invoice</span>
          <Badge className="bg-slate-300 text-slate-800 text-[10px] h-5">N/A YET</Badge>
          <span className="text-[11px] text-muted-foreground ml-auto">Schedule a job to enable.</span>
        </div>
      </div>
    );
  }
  const status = (job.payment_status || "").toLowerCase();
  const badgeCls =
    status === "paid"    ? "bg-emerald-600 text-white"
    : status === "pending" ? "bg-amber-600 text-white"
                           : "bg-blue-600 text-white";
  const badgeLabel =
    status === "paid"    ? "PAID"
    : status === "pending" ? "PENDING"
                           : (job.qb_invoice_id ? "DRAFT" : "NOT GENERATED");

  return (
    <div className="rounded-md border p-2.5 space-y-2 bg-muted/20">
      <div className="flex items-center gap-2 flex-wrap">
        <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-semibold">Full Invoice</span>
        <Badge className={`${badgeCls} text-[10px] h-5`}>{badgeLabel}</Badge>
        {job.qb_invoice_url && (
          <a
            href={job.qb_invoice_url}
            target="_blank"
            rel="noreferrer"
            className="ml-auto text-[11px] text-blue-700 hover:underline"
          >
            View {job.qb_invoice_status || "invoice"}
          </a>
        )}
      </div>
      {status !== "paid" && (
        <div className="flex gap-2 flex-wrap items-center">
          <Button size="sm" onClick={onGenerate}>
            {job.qb_invoice_id ? "Update Invoice" : "Generate Invoice"}
          </Button>
          <span className="text-[11px] text-muted-foreground italic">
            Tap-to-pay SMS link · auto-marks paid on payment.
          </span>
        </div>
      )}
    </div>
  );
}

// Sprint 4 T4.C — Last call intel strip. Compact AI-analysis summary
// of the most recent CALL recording on this lead. Renders the score,
// sentiment, one-line summary, and the next_action so admin sees the
// bottom-line context BEFORE calling again. Hidden until an analyzed
// call exists — fresh leads stay clean. Pending states render a
// muted 'analyzing…' line so admin knows the pipeline is running.
function LastCallIntelStrip({ leadId }: { leadId: string }) {
  const [recordings, setRecordings] = useState<CallRecordingEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.getLeadCalls(leadId)
      .then((r) => { if (!cancelled) setRecordings(r); })
      .catch(() => { /* silent */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [leadId]);

  // No calls at all → render nothing. The full CallRecordingsCard below
  // handles the empty state with its own upload-prompt UI.
  if (loading || recordings.length === 0) return null;

  // Find the most recent recording that's either analyzed OR in flight.
  // Skip archived rows — those have been intentionally hidden from the
  // standard surfaces.
  const candidate = recordings.find((r) => !r.is_archived);
  if (!candidate) return null;

  // Status flavors:
  //   "analyzed" + has analysis  → render the intel
  //   "pending" / "transcribed"  → render an analyzing strip
  //   "failed"                   → render a soft failure note + retry link
  const status = (candidate.status || "").toLowerCase();
  const analysis = candidate.analysis;

  const sentColor = (s?: string) => {
    const v = (s || "").toLowerCase();
    if (v.includes("pos")) return "text-emerald-700";
    if (v.includes("neg")) return "text-red-700";
    return "text-slate-700";
  };
  const scoreColor = (n?: number) => {
    if (!n) return "text-slate-500";
    if (n >= 8) return "text-emerald-700";
    if (n >= 5) return "text-amber-700";
    return "text-red-700";
  };

  if (status === "analyzed" && analysis) {
    return (
      <Card className="border-violet-200 bg-violet-50/40">
        <CardContent className="py-3 px-4 space-y-2">
          <div className="flex items-baseline gap-2 flex-wrap text-sm">
            <Mic className="h-3.5 w-3.5 text-violet-700 shrink-0 self-center" />
            <span className="font-semibold text-violet-900">Last call intel</span>
            {(analysis.call_score ?? 0) > 0 && (
              <span className={`font-mono font-bold ${scoreColor(analysis.call_score)}`}>
                {analysis.call_score}/10
              </span>
            )}
            <span className={`text-xs ${sentColor(analysis.sentiment)}`}>
              · {analysis.sentiment || "neutral"} sentiment
            </span>
            <span className="text-xs text-muted-foreground">
              · {Math.round((candidate.duration_seconds || 0) / 60)} min
            </span>
            <span className="text-xs text-muted-foreground">· {timeAgo(candidate.created_at)}</span>
            <span className="ml-auto text-[11px] text-violet-700 capitalize">
              {analysis.close_likelihood?.replace(/_/g, " ") || ""}
            </span>
          </div>
          {analysis.summary_one_line && (
            <p className="text-sm whitespace-pre-wrap">{analysis.summary_one_line}</p>
          )}
          {analysis.next_action && (
            <p className="text-sm">
              <span className="font-semibold text-violet-900">→ Next: </span>
              {analysis.next_action}
            </p>
          )}
          {analysis.objections && analysis.objections.length > 0 && (
            <p className="text-xs">
              <span className="text-muted-foreground">Objections raised: </span>
              {analysis.objections.join(", ")}
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  if (status === "pending" || status === "transcribed") {
    return (
      <Card className="border-slate-200 bg-slate-50/60">
        <CardContent className="py-2 px-4 text-xs text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Last call captured {timeAgo(candidate.created_at)} — analyzing now ({Math.round((candidate.duration_seconds || 0) / 60)} min recording). The full transcript + analysis appear in the Call Recordings card below once ready.
        </CardContent>
      </Card>
    );
  }

  // status === "failed" — soft fail. CallRecordingsCard below has the
  // retry button so we don't duplicate it here.
  return (
    <Card className="border-amber-200 bg-amber-50/60">
      <CardContent className="py-2 px-4 text-xs text-amber-900">
        Last call (from {timeAgo(candidate.created_at)}) couldn't be transcribed. See Call Recordings below to retry.
      </CardContent>
    </Card>
  );
}


// Sprint 3 T3.C — Nearby jobs card. Surfaces existing scheduled jobs in
// the same ZIP (tier 1) and within ~15 mi (tier 2) so Alan can pitch
// route-stacking during the sales call ("we're already at 21730
// Southern Valley on Tuesday — schedule for Tuesday too and we knock
// 30 min off each drive"). Empty + collapsed states are friendly stubs
// — the card always renders so admin can see at a glance whether
// route-stacking is available.
const QB_STATUS_STYLE: Record<string, string> = {
  paid: "bg-emerald-100 text-emerald-800",
  partial: "bg-amber-100 text-amber-800",
  unpaid: "bg-rose-100 text-rose-700",
  void: "bg-gray-100 text-gray-500",
};
function qbMoney(n: number): string {
  return `$${(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// QuickBooks invoices linked to this lead + a paid/balance rollup. Assignment
// mainly happens on the Revenue page; "Link invoice" here is the shortcut.
function LeadInvoicesCard({ leadId, leadName }: { leadId: string; leadName: string }) {
  const [data, setData] = useState<{ invoices: QuickbooksInvoice[]; rollup: { paid: number; total: number; balance: number; count: number } } | null>(null);
  const [loading, setLoading] = useState(true);
  const [linking, setLinking] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.getLeadQbInvoices(leadId)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [leadId]);
  useEffect(() => { load(); }, [load]);

  const unlink = async (inv: QuickbooksInvoice) => {
    try { await api.unassignQbInvoice(inv.qb_invoice_id); load(); }
    catch { toast.error("Couldn't unlink invoice"); }
  };

  const invoices = data?.invoices ?? [];
  const roll = data?.rollup;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm sm:text-base flex items-center gap-2">
            <DollarSign className="h-4 w-4" /> Payments (QuickBooks)
          </CardTitle>
          <Button size="sm" variant="outline" onClick={() => setLinking(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Link invoice
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="h-12 bg-muted rounded animate-pulse" />
        ) : invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No QuickBooks invoices linked yet. Use <span className="font-medium">Link invoice</span>, or assign one from the Revenue page.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <span>Paid <span className="font-semibold text-emerald-700">{qbMoney(roll?.paid || 0)}</span></span>
              <span>Balance <span className="font-semibold text-amber-700">{qbMoney(roll?.balance || 0)}</span></span>
              <span className="text-muted-foreground">of {qbMoney(roll?.total || 0)} · {roll?.count} invoice{roll?.count === 1 ? "" : "s"}</span>
            </div>
            <div className="rounded-lg border divide-y">
              {invoices.map((inv) => (
                <div key={inv.qb_invoice_id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">#{inv.doc_number || inv.qb_invoice_id}</div>
                    <div className="text-xs text-muted-foreground">{inv.txn_date || "—"}</div>
                  </div>
                  <div className="text-right whitespace-nowrap">
                    <div>{qbMoney(inv.total_amount)}</div>
                    <div className="text-xs text-muted-foreground">
                      paid {qbMoney(inv.amount_paid)}{inv.balance > 0 ? ` · bal ${qbMoney(inv.balance)}` : ""}
                    </div>
                  </div>
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium capitalize ${QB_STATUS_STYLE[inv.status] || "bg-gray-100 text-gray-600"}`}>
                    {inv.status}
                  </span>
                  <button onClick={() => unlink(inv)} title="Unlink" className="text-muted-foreground hover:text-red-600 shrink-0">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
      {linking && (
        <LinkInvoiceModal
          leadId={leadId}
          leadName={leadName}
          onClose={() => setLinking(false)}
          onLinked={() => { setLinking(false); load(); }}
        />
      )}
    </Card>
  );
}

function LinkInvoiceModal({ leadId, leadName, onClose, onLinked }: {
  leadId: string; leadName: string; onClose: () => void; onLinked: () => void;
}) {
  const [q, setQ] = useState(leadName);
  const [results, setResults] = useState<QuickbooksInvoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const search = useCallback((term: string) => {
    setLoading(true);
    api.listQbInvoices({ filter: "unassigned", q: term.trim(), limit: 25 })
      .then((r) => setResults(r.invoices))
      .catch(() => setResults([]))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { search(leadName); }, [search, leadName]);

  const assign = async (inv: QuickbooksInvoice) => {
    setBusyId(inv.qb_invoice_id);
    try { await api.assignQbInvoice(inv.qb_invoice_id, leadId); toast.success("Invoice linked"); onLinked(); }
    catch { toast.error("Couldn't link invoice"); setBusyId(null); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl border bg-background p-4 shadow-xl space-y-3 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div>
          <p className="text-sm font-semibold">Link a QuickBooks invoice</p>
          <p className="text-xs text-muted-foreground">Search unassigned invoices by customer name or invoice #.</p>
        </div>
        <div className="flex gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") search(q); }}
            placeholder="Customer name or invoice #"
            className="flex-1 text-sm rounded-md border bg-background px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <Button size="sm" onClick={() => search(q)} disabled={loading}>Search</Button>
        </div>
        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : results.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No unassigned invoices match. Try a different search, or sync on the Revenue page.</p>
        ) : (
          <div className="rounded-lg border divide-y">
            {results.map((inv) => (
              <div key={inv.qb_invoice_id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">#{inv.doc_number || inv.qb_invoice_id} · {inv.customer_name || "—"}</div>
                  <div className="text-xs text-muted-foreground">{inv.txn_date || "—"} · {qbMoney(inv.total_amount)} · paid {qbMoney(inv.amount_paid)}</div>
                </div>
                <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busyId === inv.qb_invoice_id} onClick={() => assign(inv)}>
                  {busyId === inv.qb_invoice_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Link"}
                </Button>
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}


function NearbyJobsCard({ leadId }: { leadId: string }) {
  const [data, setData] = useState<{ nearby_jobs: NearbyJob[]; window_days: number } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getNearbyJobs(leadId, 14)
      .then((r) => { if (!cancelled) setData(r); })
      .catch(() => { /* silent — empty state is fine */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [leadId]);

  const jobs = data?.nearby_jobs || [];
  const sameZip = jobs.filter((j) => j.same_zip);
  const nearby = jobs.filter((j) => !j.same_zip);
  const topPick = jobs[0]; // first row is already the closest same-ZIP or closest nearby

  return (
    <Card className="border-cyan-200 bg-cyan-50/30">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm sm:text-base flex items-center gap-2">
          <MapPin className="h-4 w-4" /> Route-Stack — Nearby Jobs
          <span className="ml-auto text-[11px] font-normal text-muted-foreground">
            Next {data?.window_days ?? 14} days
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && (
          <p className="text-xs text-muted-foreground italic">Loading…</p>
        )}

        {!loading && jobs.length === 0 && (
          <p className="text-xs text-muted-foreground italic">
            No scheduled jobs in this lead's ZIP or within 15 mi over the next 2 weeks.
            Schedule freely — no route-stacking opportunity here.
          </p>
        )}

        {/* Top pick highlight — only shown when there's a same-ZIP match.
            The 'pitch this date' callout is a one-line shortcut admin
            can read mid-call. */}
        {!loading && topPick?.same_zip && (
          <div className="bg-white border border-emerald-300 rounded-md p-2.5">
            <p className="text-xs font-semibold text-emerald-900 mb-0.5">
              💡 Route-stack suggestion
            </p>
            <p className="text-sm">
              Schedule for <span className="font-semibold">{formatDate(topPick.job_date)}</span> —
              {" "}we're already at <span className="font-semibold">{topPick.customer_name || topPick.address}</span>
              {topPick.distance_miles !== null && (
                <> ({topPick.distance_miles} mi away)</>
              )}.
            </p>
          </div>
        )}

        {/* Same-ZIP tier */}
        {!loading && sameZip.length > 0 && (
          <div>
            <p className="text-[11px] font-semibold text-emerald-800 uppercase tracking-wide mb-1">
              Same ZIP ({sameZip.length})
            </p>
            <ul className="space-y-1">
              {sameZip.map((j) => <NearbyJobRow key={j.job_id} job={j} />)}
            </ul>
          </div>
        )}

        {/* Within-15-mi tier */}
        {!loading && nearby.length > 0 && (
          <div>
            <p className="text-[11px] font-semibold text-cyan-800 uppercase tracking-wide mb-1">
              Nearby ({nearby.length})
            </p>
            <ul className="space-y-1">
              {nearby.map((j) => <NearbyJobRow key={j.job_id} job={j} />)}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function NearbyJobRow({ job }: { job: NearbyJob }) {
  return (
    <li className="text-xs bg-white border rounded-md px-2.5 py-1.5 flex items-baseline gap-2 flex-wrap">
      <span className="font-semibold">{job.customer_name || "(no name)"}</span>
      <span className="text-muted-foreground">·</span>
      <span>{formatDate(job.job_date)}</span>
      {job.distance_miles !== null && (
        <>
          <span className="text-muted-foreground">·</span>
          <span className="font-mono">{job.distance_miles} mi</span>
        </>
      )}
      {job.zip_code && (
        <>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{job.zip_code}</span>
        </>
      )}
      {job.address && (
        <span className="text-muted-foreground truncate ml-auto" title={job.address}>
          {job.address}
        </span>
      )}
    </li>
  );
}


// Sprint 2 T2.E — Follow-up flag badge for the lead detail header.
// Fetches the rule-engine output via /follow-up-flag and renders the
// label in a color appropriate to the kind. Hot leads pulse to draw the
// eye; cold leads are muted so they don't distract.
function FollowUpFlagBadge({ leadId }: { leadId: string }) {
  const [flag, setFlag] = useState<FollowUpFlag | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.getFollowUpFlag(leadId)
      .then((r) => { if (!cancelled) setFlag(r.flag); })
      .catch(() => { /* silent */ });
    return () => { cancelled = true; };
  }, [leadId]);
  if (!flag) return null;
  const cls = {
    hot:          "bg-red-600 text-white animate-pulse",
    callback_due: "bg-blue-600 text-white",
    warm:         "bg-emerald-600 text-white",
    stale:        "bg-amber-200 text-amber-900",
    cold:         "bg-slate-200 text-slate-600",
  }[flag.kind];
  return (
    <Badge className={`text-xs ${cls}`} title={`Follow-up signal: ${flag.kind}`}>
      {flag.label}
    </Badge>
  );
}


// Sprint 2 T2.D — Recent conversation preview. Compact at-a-glance view
// of the last 3 messages so Alan never has to tab-switch to GHL during a
// sales call. Shares the `messages` state with the deeper Messages card
// further down the page — when one updates (via SSE or manual Check),
// both update together. Empty + v1-pipeline states are friendly stubs.
function RecentConversationCard({
  messages,
  leadPipelineVersion,
  checking,
  onCheck,
}: {
  messages: MessageEntry[];
  leadPipelineVersion: string;
  checking: boolean;
  onCheck: () => void;
}) {
  const last = useMemo(() => {
    // Backend returns newest-first. Slice to 3, then re-reverse to render
    // chronologically (oldest at top, newest at bottom) like a real chat.
    return [...messages.slice(0, 3)].reverse();
  }, [messages]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm sm:text-base flex items-center gap-2">
          <MessageSquare className="h-4 w-4" /> Recent Conversation
          {messages.length > 3 && (
            <span className="text-[11px] font-normal text-muted-foreground ml-1">
              (last 3 of {messages.length}, full history below)
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={onCheck}
            disabled={checking || leadPipelineVersion === "v1"}
            className="ml-auto"
            title={leadPipelineVersion === "v1" ? "Old pipeline — export to load messages" : "Pull latest from GHL"}
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${checking ? "animate-spin" : ""}`} />
            Check
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {leadPipelineVersion === "v1" ? (
          <p className="text-xs text-muted-foreground italic">
            Messages won't load — the old GHL account is no longer reachable.
            Export this lead to the new pipeline to enable message sync.
          </p>
        ) : messages.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            No messages yet. When the customer texts (or you reply through GHL), it shows up here automatically.
          </p>
        ) : (
          <div className="space-y-2">
            {last.map((msg) => (
              <div
                key={msg.id}
                className={`rounded-lg px-3 py-1.5 text-sm max-w-[85%] ${
                  msg.direction === "inbound"
                    ? "bg-muted mr-auto"
                    : "bg-primary/10 ml-auto text-right"
                }`}
              >
                <p className="text-[10px] font-medium text-muted-foreground mb-0.5">
                  {msg.direction === "inbound" ? "Customer" : "Sent"} — {timeAgo(msg.created_at)}
                </p>
                <p className="whitespace-pre-wrap break-words">{msg.body}</p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}


// Sprint 2 T2.C — Last contact line for the lead detail header. Composes
// the most recent touch across (call disposition, estimate sent, proposal
// view). Shows up to 2 touchpoints so admin can see "called 14 min ago ·
// estimate sent 2d ago" at a glance — the call answers 'did anyone
// already work this?', the estimate answers 'how stale is it?'.
function LastContactLine({
  leadId,
  estimateSentAt,
  proposalLastViewedAt,
}: {
  leadId: string;
  estimateSentAt?: string | null;
  proposalLastViewedAt?: string | null;
}) {
  const [lastCall, setLastCall] = useState<CallDispositionEntry | null>(null);
  // Fire and forget: fetch the latest disposition for this lead. The
  // CallDispositionCard below also fetches; this duplicate query is
  // cheap (1-row index lookup) and avoids prop-drilling state up.
  useEffect(() => {
    let cancelled = false;
    api.listCallDispositions(leadId)
      .then((r) => { if (!cancelled) setLastCall(r.dispositions[0] || null); })
      .catch(() => { /* silent — empty is a fine default */ });
    return () => { cancelled = true; };
  }, [leadId]);

  type Touch = { kind: "call" | "viewed" | "estimate"; at: string; label: string; icon: string };
  const touches: Touch[] = [];
  if (lastCall?.disposed_at) {
    const optLabel = DISPOSITION_OPTIONS.find((d) => d.value === lastCall.outcome)?.label || lastCall.outcome;
    touches.push({ kind: "call", at: lastCall.disposed_at, label: `Called (${optLabel})`, icon: "📞" });
  }
  if (proposalLastViewedAt) {
    touches.push({ kind: "viewed", at: proposalLastViewedAt, label: "Proposal viewed", icon: "👁" });
  }
  if (estimateSentAt) {
    touches.push({ kind: "estimate", at: estimateSentAt, label: "Estimate sent", icon: "✉️" });
  }
  touches.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  if (touches.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground italic mt-1">
        No contact logged yet — first touch will show here.
      </p>
    );
  }
  // Show top 2 touchpoints to give context without crowding the header.
  return (
    <p className="text-[11px] text-muted-foreground mt-1 flex items-baseline gap-2 flex-wrap">
      {touches.slice(0, 2).map((t, i) => (
        <span key={`${t.kind}-${i}`} className={i === 0 ? "font-semibold text-foreground" : ""}>
          <span className="mr-0.5">{t.icon}</span>
          {t.label} {timeAgo(t.at)}
          {i === 0 && touches.length > 1 && <span className="mx-1.5 text-muted-foreground">·</span>}
        </span>
      ))}
    </p>
  );
}


// Sprint 2 T2.B — Proposal view badge for the lead header. Three states:
//   gray   "Proposal not viewed"            — never opened
//   green  "Viewed 3× · 4 min ago"          — opened recently (hot intent)
//   blue   "Viewed 5× · 2 days ago"         — opened but cold
// 'Recently' threshold: 60 minutes. Past that, the customer's attention
// is gone — no longer a real-time intent signal.
function ProposalViewBadge({
  viewCount,
  firstViewedAt,
  lastViewedAt,
}: {
  viewCount: number;
  firstViewedAt?: string | null;
  lastViewedAt?: string | null;
}) {
  if (viewCount <= 0 && !firstViewedAt) {
    return <Badge className="text-xs bg-slate-200 text-slate-700">Proposal not viewed</Badge>;
  }
  const ts = lastViewedAt || firstViewedAt;
  let hot = false;
  if (ts) {
    const minutesAgo = (Date.now() - new Date(ts).getTime()) / 60000;
    hot = minutesAgo <= 60;
  }
  const count = viewCount || 1;
  return (
    <Badge className={`text-xs ${hot ? "bg-emerald-600 text-white" : "bg-blue-100 text-blue-800"}`}>
      <Eye className="h-3 w-3 mr-1 inline" />
      Viewed {count}×{ts ? ` · ${timeAgo(ts)}` : ""}{hot ? " · 🔥" : ""}
    </Badge>
  );
}


// Sprint 2 T2.A — Call disposition picker. One-tap after every call so
// we finally have why-didn't-this-close data. Renders the option grid +
// optional notes input + a compact timeline of past dispositions for
// this lead.
const DISPOSITION_OPTIONS: Array<{
  value: CallDispositionOutcome;
  label: string;
  icon: string;
  cls: string;
}> = [
  { value: "closed",           label: "Closed",            icon: "✅", cls: "bg-emerald-600 hover:bg-emerald-700 text-white" },
  { value: "objection_price",  label: "Objection: Price",  icon: "💵", cls: "bg-amber-600 hover:bg-amber-700 text-white" },
  { value: "objection_timing", label: "Objection: Timing", icon: "⏳", cls: "bg-amber-600 hover:bg-amber-700 text-white" },
  { value: "objection_spouse", label: "Objection: Spouse", icon: "👫", cls: "bg-amber-600 hover:bg-amber-700 text-white" },
  { value: "objection_hoa",    label: "Objection: HOA",    icon: "🏘️", cls: "bg-amber-600 hover:bg-amber-700 text-white" },
  { value: "objection_more_estimates", label: "Objection: More estimates", icon: "📝", cls: "bg-amber-600 hover:bg-amber-700 text-white" },
  { value: "callback",         label: "Call back",         icon: "📞", cls: "bg-blue-600 hover:bg-blue-700 text-white" },
  { value: "voicemail",        label: "Voicemail",         icon: "📭", cls: "bg-slate-500 hover:bg-slate-600 text-white" },
  { value: "voicemail_texted", label: "Voicemail & texted", icon: "📨", cls: "bg-slate-500 hover:bg-slate-600 text-white" },
  { value: "no_answer",        label: "No answer",         icon: "🤷", cls: "bg-slate-500 hover:bg-slate-600 text-white" },
  { value: "other",            label: "Other",             icon: "✏️", cls: "bg-slate-500 hover:bg-slate-600 text-white" },
];

function CallDispositionCard({ leadId, contactName }: { leadId: string; contactName: string }) {
  const [history, setHistory] = useState<CallDispositionEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [picked, setPicked] = useState<CallDispositionOutcome | null>(null);
  const [notes, setNotes] = useState("");
  const [callbackAt, setCallbackAt] = useState("");
  const [showHistory, setShowHistory] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.listCallDispositions(leadId);
      setHistory(r.dispositions);
    } catch {
      // Silent — empty history is a fine default.
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => { refresh(); }, [refresh]);

  const save = async () => {
    if (!picked) return;
    setSaving(true);
    try {
      await api.logCallDisposition(leadId, {
        outcome: picked,
        notes: notes.trim(),
        callback_at: picked === "callback" && callbackAt ? new Date(callbackAt).toISOString() : null,
      });
      toast.success("Call logged");
      setPicked(null);
      setNotes("");
      setCallbackAt("");
      await refresh();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to log call");
    } finally {
      setSaving(false);
    }
  };

  const lastCall = history[0];
  const optionLabel = (o: CallDispositionOutcome) =>
    DISPOSITION_OPTIONS.find((d) => d.value === o)?.label || o;
  const optionIcon = (o: CallDispositionOutcome) =>
    DISPOSITION_OPTIONS.find((d) => d.value === o)?.icon || "•";

  return (
    <Card className="border-blue-200 bg-blue-50/30">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm sm:text-base flex items-center gap-2">
          <Phone className="h-4 w-4" /> Log a Call
          {lastCall && (
            <span className="ml-auto text-[11px] font-normal text-muted-foreground">
              Last: {optionIcon(lastCall.outcome)} {optionLabel(lastCall.outcome)} · {timeAgo(lastCall.disposed_at)}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Picker row */}
        <div className="flex flex-wrap gap-1.5">
          {DISPOSITION_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setPicked(opt.value === picked ? null : opt.value)}
              className={`text-xs px-2.5 py-1.5 rounded-md font-medium transition-all border ${
                picked === opt.value
                  ? `${opt.cls} border-transparent shadow-sm`
                  : "bg-white hover:bg-muted/40 border-input text-foreground"
              }`}
            >
              <span className="mr-1">{opt.icon}</span>
              {opt.label}
            </button>
          ))}
        </div>

        {/* Conditional inputs once an outcome is picked */}
        {picked && (
          <div className="space-y-2 pt-1">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder={picked === "closed"
                ? `Optional: how ${contactName.split(" ")[0] || "they"} decided to close (price, sides, etc.)`
                : "Optional: notes for follow-up context"}
              className="w-full border border-input rounded-md px-2.5 py-1.5 text-sm bg-background resize-none"
            />
            {picked === "callback" && (
              <div className="flex items-center gap-2">
                <label className="text-xs font-semibold text-muted-foreground">Callback when:</label>
                <input
                  type="datetime-local"
                  value={callbackAt}
                  onChange={(e) => setCallbackAt(e.target.value)}
                  className="border border-input rounded-md px-2 py-1 text-xs bg-background"
                />
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => { setPicked(null); setNotes(""); setCallbackAt(""); }}>
                Cancel
              </Button>
              <Button size="sm" onClick={save} disabled={saving}>
                {saving ? <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Logging…</> : "Log call"}
              </Button>
            </div>
          </div>
        )}

        {/* History toggle */}
        {history.length > 0 && (
          <div className="pt-1 border-t">
            <button
              type="button"
              onClick={() => setShowHistory((v) => !v)}
              className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
            >
              {showHistory ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              {showHistory ? "Hide" : "Show"} call history ({history.length})
            </button>
            {showHistory && (
              <ul className="mt-2 space-y-1.5">
                {history.map((d) => (
                  <li key={d.id} className="text-xs bg-white border rounded-md px-2.5 py-1.5">
                    <div className="flex items-baseline gap-1.5 flex-wrap">
                      <span>{optionIcon(d.outcome)}</span>
                      <span className="font-semibold">{optionLabel(d.outcome)}</span>
                      <span className="text-muted-foreground">·</span>
                      <span className="text-muted-foreground">{timeAgo(d.disposed_at)}</span>
                      {d.disposed_by && (
                        <>
                          <span className="text-muted-foreground">·</span>
                          <span className="text-muted-foreground">by {d.disposed_by}</span>
                        </>
                      )}
                      {d.callback_at && (
                        <>
                          <span className="text-muted-foreground">·</span>
                          <span className="text-blue-700">callback {formatDateTime(d.callback_at)}</span>
                        </>
                      )}
                    </div>
                    {d.notes && (
                      <p className="text-muted-foreground mt-0.5 whitespace-pre-wrap">{d.notes}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {!loading && history.length === 0 && !picked && (
          <p className="text-[11px] text-muted-foreground italic">
            No calls logged yet for this lead. Tap an outcome above after your next call — it takes 5 seconds and finally gives us the data to ask "why don't calls close?"
          </p>
        )}
      </CardContent>
    </Card>
  );
}
