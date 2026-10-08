import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useNow } from "@/hooks/useNow";
import { api, canSeeRevenue, getCurrentUser, type LeadDetail as LeadDetailType, type EstimateDetail, type MessageEntry, type BreakdownItem, type CallRecordingEntry, type ScheduledJob, type LeadSource, type CallDispositionEntry, type CallDispositionOutcome, type LeadObjectionEntry, type FollowUpFlag, type NearbyJob, type QuickbooksInvoice, LEAD_SOURCE_OPTIONS } from "@/lib/api";
import GenerateInvoiceModal from "@/components/GenerateInvoiceModal";
import CallScriptPanel from "@/components/CallScriptPanel";
import FollowUpStatusPanel from "@/components/FollowUpStatusPanel";
import { cn, formatCurrency, formatMonthly, formatDate, formatDateTime, timeAgo, errMessage, errName } from "@/lib/utils";
import { ACCENT, accentForName, initials, type Accent } from "@/lib/accents";
import { fireConfetti } from "@/lib/confetti";
import { Panel, Field, StatTile, ToggleChip, Pill } from "@/components/Panel";
import { SidesPicker } from "@/components/SidesPicker";
import { TIER_KEYS, tiersFromBreakdown } from "@/lib/breakdown";
import { ghlContactUrl } from "@/lib/ghlLink";
import { toast } from "sonner";
import { useSSE } from "@/hooks/useSSE";
import { playSuccessSound, playWarningSound, playReplySound, playProposalViewedSound } from "@/hooks/useNotificationSound";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import EstimatorLeadPanel from "@/components/EstimatorLeadPanel";
import LeadActivityHistory from "@/components/LeadActivityHistory";
import DailyTaskList from "@/components/DailyTaskList";
import {
  ArrowLeft, MapPin, Phone, Mail, Calculator, RefreshCw,
  Send, AlertTriangle, CheckCircle2, FileText, MessageSquare, ExternalLink, Shield, Pencil, Save, Archive, ArchiveRestore, Eye, Navigation, Clock, Calendar, Plus, Undo2, Trash2, Loader2, WandSparkles, Upload, ChevronDown, ChevronUp, Mic, ArrowRightCircle, Star, Play, Pause, RotateCw, DollarSign, Copy, GraduationCap, X,
  Ruler, Camera, History, Satellite, Rocket, Gem, Crown, Medal, CalendarCheck, CircleDollarSign, Route, Flame, UserRound, Hourglass, Compass, Paintbrush, CreditCard, Check, Receipt, Palette, Sparkles, MessageSquareWarning,
} from "lucide-react";
import { useTrainingMode } from "@/lib/training_mode_context";
import PdfPreviewModal from "@/components/PdfPreviewModal";
import ScheduleJobModal from "@/components/ScheduleJobModal";
import ScheduledVisitsCard from "@/components/ScheduledVisitsCard";
import CalendarGlimpse from "@/components/CalendarGlimpse";
import { LeadDelayPanel } from "@/components/EstimateDelay";
import TimeSpentCard from "@/components/TimeSpentCard";
import MeasurementCard from "@/components/MeasurementCard";
import SatelliteMeasureCard from "@/components/SatelliteMeasureCard";
import EstimateHistoryCard from "@/components/EstimateHistoryCard";
import CustomProposalCard from "@/components/CustomProposalCard";
import ExteriorTab from "@/components/ExteriorTab";
import FenceScopeSummaryCard from "@/components/FenceScopeSummaryCard";
import UpsellTab from "@/components/UpsellTab";
import CompanyCamTab from "@/components/CompanyCamTab";
import { V2_STAGES } from "@/lib/leadStages";
import { bothClocks, centralToUTC, ctHour, ctISO, dayHeader } from "@/lib/date";

// How far out the one-click buffered send goes. Long enough that the estimate
// doesn't look auto-generated the moment the size is confirmed, short enough
// that the customer is still by their phone thinking about the call.
const SEND_BUFFER_MINUTES = 10;
import SyncedTranscriptPlayer from "@/components/SyncedTranscriptPlayer";

const FENCE_HEIGHT_OPTIONS = [
  "Didn't answer", "6ft standard", "6.5ft standard with rot board", "7ft", "8ft", "Not sure",
];
const FENCE_AGE_OPTIONS = [
  "Didn't answer", "Brand new (less than 6 months)", "1-6 years", "6-15 years", "Older than 15 years / Not sure",
];
const PREVIOUSLY_STAINED_OPTIONS = ["Didn't answer", "No", "Yes"];
const TIMELINE_OPTIONS = ["As soon as possible", "Within 2 weeks", "Sometime this month", "Just planning ahead"];

/**
 * Map what GHL actually stores onto the four options above.
 *
 * The Meta lead form has been reworded several times and its picklist labels
 * never matched this list exactly. Measured 2026-10-01 across every non-test
 * lead: 1,418 of the 1,691 that HAD a timeline answer did not match any
 * option, so the <select> rendered blank — and because Save & Recalculate
 * writes whatever the control holds, saving a lead then overwrote the
 * customer's answer with "". The three families of mismatch were
 * "Just planning ahead/ getting a quote" (920), "sometime this month"
 * lowercased (274), and "As soon as possible?" with a trailing question
 * mark (224).
 *
 * Matching is done on intent, not on exact strings, so the next time the ad
 * form is reworded this keeps working. An unrecognised value is returned
 * unchanged rather than blanked — losing the answer is worse than showing an
 * odd label, and `timelineOptionsFor` keeps it selectable so a save
 * round-trips it intact.
 */
function normalizeTimeline(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const v = s.toLowerCase().replace(/[?!.]/g, " ").replace(/\s+/g, " ").trim();
  if (v.includes("as soon as possible") || v.includes("asap")) return "As soon as possible";
  if (v.includes("2 weeks") || v.includes("two weeks")) return "Within 2 weeks";
  if (v.includes("this month")) return "Sometime this month";
  if (v.includes("planning ahead") || v.includes("getting a quote")) return "Just planning ahead";
  return s;
}

/** Options plus the current value when it isn't one of them, so an
 *  unrecognised answer still displays and still survives a save. */
function timelineOptionsFor(current: string): string[] {
  return !current || TIMELINE_OPTIONS.includes(current)
    ? TIMELINE_OPTIONS
    : [current, ...TIMELINE_OPTIONS];
}
const CONFIDENCE_OPTIONS = [
  { label: "I'm confident", value: "100" },
  { label: "Somewhat confident", value: "80" },
  { label: "I'm not confident", value: "60" },
];

// Three states, three colours, carried through the whole page: green is
// always "go", amber is always "waiting on something", red is always "stop".
const APPROVAL_CONFIG = {
  green:  { label: "Ready to send",         icon: CheckCircle2, cls: "border-emerald-300 bg-gradient-to-r from-emerald-50 to-teal-50 text-emerald-900", chip: "from-emerald-500 to-teal-600" },
  yellow: { label: "Add-ons pending",       icon: Hourglass,    cls: "border-amber-300 bg-gradient-to-r from-amber-50 to-orange-50 text-amber-900",     chip: "from-amber-500 to-orange-600" },
  red:    { label: "Owner review required", icon: Shield,       cls: "border-red-300 bg-gradient-to-r from-red-50 to-rose-50 text-red-900",             chip: "from-red-500 to-rose-600" },
} as const;

const selectCls = "h-10 w-full rounded-xl border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

/** The gradient behind each confidence choice: sure is green, unsure is red,
 *  so the VA's own doubt is visible from across the room. */
const CONFIDENCE_TONE: Record<string, string> = {
  "100": "from-emerald-500 to-teal-600",
  "80":  "from-amber-500 to-orange-600",
  "60":  "from-rose-500 to-pink-600",
};

/** Bronze, brand blue, gold. Signature is the one we recommend, so it is the
 *  only one painted solid. */
const TIER_LOOK = {
  essential: { label: "Essential", tag: "Good",        icon: Medal, accent: ACCENT.slate },
  signature: { label: "Signature", tag: "Recommended", icon: Star,  accent: ACCENT.blue },
  legacy:    { label: "Legacy",    tag: "Best finish", icon: Crown, accent: ACCENT.gold },
} as const;

// New Build button, archived 2026-10-08 (Alan: focus on Ask for Address).
// Flip to true to bring it back; the endpoint and its SMS are untouched.
const SHOW_NEW_BUILD: boolean = false;

const STAGE_DECLINED = "f207a600-81c9-4150-941c-e977ea876929";

// True below the `lg` breakpoint (single-column layout). Used to place a few
// sections differently on phones without touching the desktop layout.
function useIsMobile(query = "(max-width: 1023px)"): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setIsMobile(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return isMobile;
}

/** The options, plus the lead's own source when that isn't one of them.
 *
 *  513 leads carry "contact_mirror" (written by the GHL contact mirror, not
 *  a channel anybody picks). A <select> whose value matches no <option>
 *  renders blank, so those leads looked sourceless — and picking anything
 *  from the dropdown would have silently overwritten the provenance. */
function leadSourceOptionsFor(current: string) {
  const known = LEAD_SOURCE_OPTIONS.some((o) => o.value === current);
  if (!current || known) return LEAD_SOURCE_OPTIONS;
  return [
    { value: current as LeadSource, label: `${current} (how we found them)` },
    ...LEAD_SOURCE_OPTIONS,
  ];
}


function ApprovalBanner({
  cfg, reason, className,
}: {
  cfg: (typeof APPROVAL_CONFIG)[keyof typeof APPROVAL_CONFIG];
  reason?: string;
  className?: string;
}) {
  const Icon = cfg.icon;
  return (
    <div className={cn("flex items-start gap-3 rounded-2xl border p-3", cfg.cls, className)}>
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${cfg.chip} shadow-sm`}>
        <Icon className="h-4 w-4 text-white" />
      </div>
      <div className="min-w-0">
        <p className="font-heading text-sm font-bold leading-tight">{cfg.label}</p>
        {reason ? <p className="mt-0.5 text-xs opacity-90">{reason}</p> : null}
      </div>
    </div>
  );
}

type JourneyStep = {
  key: string;
  label: string;
  icon: React.ElementType;
  accent: Accent;
  done: boolean;
  /** Element id to scroll to when the chip is tapped. */
  target: string;
  /** One line on what to do, shown for the current step. */
  hint: string;
  /** Not done, and never will be — we moved past it on purpose (sent the
   *  estimate without ever getting a first reply). Shown amber, and never
   *  "You are here". */
  skipped?: boolean;
  /** "sale" — winning the job; "job" — doing it. Drawn as two rows. */
  phase?: "sale" | "job";
  /** Replaces the scroll-to-card tap, for a step marked by hand. */
  onClick?: () => void;
  /** Started but not finished — "Getting cleaned". Pulses in its colour. */
  active?: boolean;
  activeLabel?: string;
  /** A short count under the label, e.g. "2 objections". */
  badge?: string;
};

/** The six stages of a lead, from "we have an address" to "it's on the
 *  calendar". Each chip scrolls to the card where that stage happens. The
 *  bar fills left to right and the current stage pulses, so the answer to
 *  "what do I do next on this one?" is there before a single card is read. */
function JourneyStrip({ steps }: { steps: JourneyStep[] }) {
  const done = steps.filter((s) => s.done).length;
  const current = steps.find((s) => !s.done && !s.skipped);
  const jump = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-indigo-950 p-4 text-white shadow-lg ring-1 ring-white/10">
      <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-indigo-500/30 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-20 -left-10 h-48 w-48 rounded-full bg-fuchsia-500/20 blur-3xl" />

      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/60">Customer journey</p>
          <p className="font-heading text-lg font-bold leading-tight">
            {current ? `Next up: ${current.label}` : "Every step done — reviewed and paid"}
          </p>
          <p className="mt-0.5 text-xs text-white/70">
            {current ? current.hint : "A finished customer. Ask for a referral."}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-heading text-2xl font-bold tabular-nums leading-none">
            {done}<span className="text-white/40">/{steps.length}</span>
          </p>
          <p className="mt-1 text-[10px] uppercase tracking-wider text-white/60">steps</p>
        </div>
      </div>

      <div className="relative mt-3 flex gap-1">
        {steps.map((s) => (
          <div
            key={s.key}
            className={cn(
              "h-1.5 flex-1 rounded-full transition-all duration-500",
              s.done ? `bg-gradient-to-r ${s.accent.grad}` : s.skipped ? "bg-white/5" : s === current ? "animate-pulse bg-white/40" : "bg-white/15",
            )}
          />
        ))}
      </div>

      {(["sale", "job"] as const).map((phase) => {
        const row = steps.filter((s) => (s.phase || "sale") === phase);
        if (row.length === 0) return null;
        return (
      <div key={phase} className="relative mt-3">
      {phase === "job" ? (
        <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-white/50">The job</p>
      ) : null}
      <div className={cn("grid gap-1.5", phase === "sale" ? "grid-cols-3 sm:grid-cols-9" : "grid-cols-4 sm:grid-cols-7")}>
        {row.map((s) => {
          const isCurrent = s === current;
          const Icon = s.icon;
          // Booked is the win, so it gets a gold star rather than a tick.
          const won = s.key === "booked" && s.done;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => (s.onClick ? s.onClick() : jump(s.target))}
              title={s.hint}
              className={cn(
                "flex flex-col items-center gap-1 rounded-xl px-1.5 py-2 text-center transition active:scale-95",
                won ? "bg-amber-300/15 ring-2 ring-amber-300/70 shadow-[0_0_18px_rgba(252,211,77,0.45)] hover:bg-amber-300/20"
                  : s.done ? "bg-white/10 hover:bg-white/15"
                  : s.skipped ? "border border-dashed border-white/25 bg-transparent text-white/45 hover:border-white/40"
                  : s.active ? `bg-white/10 ring-2 ${s.accent.ring} hover:bg-white/15`
                  : isCurrent ? "bg-white/15 ring-2 ring-white/60 hover:bg-white/20"
                  : "bg-white/5 opacity-70 hover:bg-white/10 hover:opacity-100",
              )}
            >
              <span className={cn(
                "flex h-8 w-8 items-center justify-center rounded-lg",
                won ? "bg-gradient-to-br from-amber-300 to-yellow-500 text-amber-950 shadow-md shadow-amber-500/40"
                  : s.done ? `bg-gradient-to-br ${s.accent.grad} shadow-md shadow-black/20`
                  : s.skipped ? "border border-dashed border-white/25 bg-transparent"
                  : s.active ? `animate-pulse bg-gradient-to-br ${s.accent.grad} opacity-80`
                  : "bg-white/10",
              )}>
                {won ? <Star className="h-4 w-4 fill-current" />
                  : s.done ? <Check className="h-4 w-4" />
                  : <Icon className={cn("h-4 w-4", s.skipped && "opacity-40")} />}
              </span>
              <span className={cn("text-[11px] font-semibold leading-tight", s.skipped && "line-through decoration-white/30")}>{s.label}</span>
              <span className={cn("text-[9px] leading-tight", won ? "font-bold text-amber-200" : "text-white/60")}>
                {won ? "Booked!" : s.done ? "Done" : s.skipped ? "Skipped"
                  : s.active ? (s.activeLabel || "In progress") : isCurrent ? "You are here" : "Later"}
              </span>
              {s.badge ? (
                <span className="rounded-full bg-amber-300/90 px-1.5 text-[9px] font-bold leading-4 text-amber-950">{s.badge}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      </div>
        );
      })}
    </div>
  );
}

function ObjectionsPanel({
  leadId, objections, categories, onChange,
}: {
  leadId: string;
  objections: LeadObjectionEntry[];
  categories: Record<string, { label: string; winnable: boolean }>;
  onChange: () => void;
}) {
  const [scanning, setScanning] = useState(false);
  const after = objections.filter((o) => o.timing === "after_estimate");
  const before = objections.filter((o) => o.timing !== "after_estimate");
  const tone = (cat: string) =>
    cat === "opt_out" ? "border-red-300 bg-red-50 text-red-900"
      : categories[cat]?.winnable === false ? "border-slate-300 bg-slate-50 text-slate-800"
      : "border-amber-300 bg-amber-50 text-amber-950";
  const scan = async () => {
    setScanning(true);
    try {
      const r = await api.scanObjections(leadId);
      toast.success(r.scanned ? `Read ${r.scanned} new text${r.scanned === 1 ? "" : "s"} or calls — ${r.found} objection${r.found === 1 ? "" : "s"} found`
        : "Nothing new to read");
      onChange();
    } catch (e) {
      toast.error(errMessage(e, "Scan failed"));
    } finally {
      setScanning(false);
    }
  };
  const remove = async (o: LeadObjectionEntry) => {
    if (!window.confirm(`Remove "${categories[o.category]?.label || o.category}"? It won't be added back.`)) return;
    try { await api.removeObjection(leadId, o.id); onChange(); }
    catch (e) { toast.error(errMessage(e, "Couldn't remove")); }
  };
  const row = (o: LeadObjectionEntry) => (
    <div key={o.id} className={cn("flex items-start gap-2 rounded-xl border px-2.5 py-2", tone(o.category),
      o.timing !== "after_estimate" && "opacity-70")}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-bold">{categories[o.category]?.label || o.category}</span>
          {o.confidence === "low" ? <span className="text-[9px] font-semibold uppercase tracking-wide opacity-60">maybe</span> : null}
          <span className="text-[10px] opacity-70">
            {o.source === "call" ? (o.mid_call_send ? "on the call the estimate went out" : "on a call") : "by text"} · {timeAgo(o.said_at)}
          </span>
        </div>
        <p className="mt-0.5 text-xs italic leading-snug">“{o.quote}”</p>
      </div>
      <button type="button" onClick={() => remove(o)} title="Wrong — remove it"
              className="shrink-0 rounded-md p-1 opacity-50 transition hover:bg-black/5 hover:opacity-100">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
  return (
    <Panel
      id="est-objections"
      className="scroll-mt-4"
      icon={MessageSquareWarning}
      title="Objections"
      sub={objections.length
        ? `${after.length} after the estimate${before.length ? ` · ${before.length} before` : ""} — read from their texts and calls`
        : "Read automatically from every new text and call"}
      accent={ACCENT.amber}
      right={
        <Button size="sm" variant="outline" onClick={scan} disabled={scanning}
                title="Read this customer's whole history now. New texts and calls are read automatically.">
          {scanning ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
          Scan history
        </Button>
      }
    >
      {objections.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          None found. Older customers aren't read until you press Scan history.
        </p>
      ) : (
        <div className="space-y-1.5">
          {objections.some((o) => o.category === "opt_out") ? (
            <p className="rounded-lg bg-red-600 px-2.5 py-1.5 text-xs font-semibold text-white">
              This customer asked us to stop. Check do-not-contact before reaching out.
            </p>
          ) : null}
          {after.map(row)}
          {before.length ? (
            <>
              <p className="pt-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Before the estimate</p>
              {before.map(row)}
            </>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

/** True when an address has a house number in front of a street name —
 *  "12419 Longwood Trace Ln", not "Longwood Trace Lane", "Conroe TX",
 *  "PO BOX 745" or "# 135". The map and the measurement need the house. */
function hasHouseNumber(address: string | null | undefined): boolean {
  const a = (address || "").trim();
  if (!a || /\bp\.?\s*o\.?\s*box\b/i.test(a)) return false;
  return /(^|[^#\d])\b\d{1,6}[a-z]?\s+[a-z]{2,}/i.test(a);
}

/** One fact about the customer, with the icon doing the labelling. */
function ContactFact({
  icon: Icon, accent, label, right, children,
}: {
  icon: React.ElementType;
  accent: Accent;
  label: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border bg-muted/20 px-2.5 py-2">
      <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${accent.grad} shadow-sm`}>
        <Icon className="h-3.5 w-3.5 text-white" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
        <div className="truncate text-sm font-medium">{children}</div>
      </div>
      {right}
    </div>
  );
}

/** One package price. Signature is the one we lead with, so it is the only
 *  one painted solid; the other two sit either side of it like bronze and
 *  gold. */
function TierCard({ tier, price }: { tier: keyof typeof TIER_LOOK; price: number }) {
  const look = TIER_LOOK[tier];
  const Icon = look.icon;
  const monthly = formatMonthly(price);
  const hero = tier === "signature";
  return (
    <div className={cn(
      "relative flex items-center gap-3 overflow-hidden rounded-xl p-3",
      hero ? "bg-gradient-to-br from-blue-600 to-indigo-700 text-white shadow-md shadow-indigo-500/20" : "border bg-card",
    )}>
      {hero ? <div className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full bg-white/10 blur-2xl" /> : null}
      <div className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl shadow-sm",
        hero ? "bg-white/20 ring-1 ring-white/40" : `bg-gradient-to-br ${look.accent.grad}`,
      )}>
        <Icon className="h-4 w-4 text-white" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-heading text-sm font-semibold">{look.label}</span>
          <span className={cn(
            "rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide",
            hero ? "bg-white/20 text-white" : look.accent.soft,
          )}>
            {look.tag}
          </span>
        </div>
        {monthly ? <p className={cn("text-[10px]", hero ? "text-white/75" : "text-muted-foreground")}>{monthly}</p> : null}
      </div>
      <p className={cn("font-heading font-bold tabular-nums", hero ? "text-2xl" : "text-lg")}>{formatCurrency(price)}</p>
    </div>
  );
}

/** A small labelled fact for the meta card. */
function Fact({ icon: Icon, label, children }: { icon: React.ElementType; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted/30 px-2.5 py-2">
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className="truncate text-xs font-medium">{children}</p>
      </div>
    </div>
  );
}

export default function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [urlParams] = useSearchParams();
  const { trainingModeOn, activeCall, startCall } = useTrainingMode();
  const [practicing, setPracticing] = useState(false);
  const [lead, setLead] = useState<LeadDetailType | null>(null);
  const isMobile = useIsMobile();
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
  const [contactZip, setContactZip] = useState("");
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
  const [activeTab, setActiveTab] = useState<"estimate" | "call" | "exterior" | "upsell" | "estimator" | "companycam">(
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
      setContactZip(data.zip_code || "");
      setLeadSource(data.lead_source || "ad");
      // Estimator fields
      const fd = data.form_data || {};
      setLinearFeet(fd.linear_feet || "");
      setFenceHeight(fd.fence_height || "Didn't answer");
      setFenceAge(fd.fence_age || "Didn't answer");
      setPreviouslyStained(fd.previously_stained || "Didn't answer");
      setTimeline(normalizeTimeline(fd.service_timeline));
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

  // What the objection scanner found for this customer.
  const [objections, setObjections] = useState<LeadObjectionEntry[]>([]);
  const [objectionCats, setObjectionCats] = useState<Record<string, { label: string; winnable: boolean }>>({});
  const loadObjections = useCallback(() => {
    if (!id) return;
    api.listObjections(id)
      .then((r) => { setObjections(r.objections); setObjectionCats(r.categories); })
      .catch(() => { /* the panel just stays empty */ });
  }, [id]);
  useEffect(() => { loadObjections(); }, [loadObjections]);

  // Logged call outcomes, for the "Heard back" step of the customer journey.
  const [dispositions, setDispositions] = useState<CallDispositionEntry[]>([]);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api.listCallDispositions(id)
      .then((r) => { if (!cancelled) setDispositions(r.dispositions || []); })
      .catch(() => { /* the step just stays open */ });
    return () => { cancelled = true; };
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
  }, [id, lead?.contact_name]));

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
    setTimeline(normalizeTimeline(inputs.service_timeline));
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

  // Check if it's after 8 PM Central
  const isAfterHours = () => {
    const h = ctHour();
    return h >= 20 || h < 6;
  };

  // After 8 PM Central, default to tomorrow; otherwise today.
  //
  // This used to build a Date from Central wall-clock digits, add a day, then
  // call toISOString() — which shifted it a second time. At 8 PM the two
  // shifts compounded and the field defaulted TWO days out.
  const getDefaultScheduleDate = () => (ctHour() >= 20 ? ctISO(1) : ctISO(0));

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
        fireConfetti();
        const sendTime = new Date(scheduledSendAt!).toLocaleString("en-US", {
          timeZone: "America/Chicago", month: "short", day: "numeric",
          hour: "numeric", minute: "2-digit", hour12: true,
        });
        toast.success(`SMS scheduled for ${sendTime}${tagNote}! Proposal: ${url}`, { duration: 8000 });
      } else if (smsSent) {
        playSuccessSound();
        fireConfetti();
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
        zip_code: contactZip.trim(),
        lead_source: leadSource,
      });
      setLead((prev) => (prev ? { ...prev, ...updated } : prev));
      setEditingContact(false);
      toast.success("Contact info saved");
    } catch (e) {
      // The bare catch here hid a 400 about lead_source for a fifth of the
      // customer base — the message said nothing and the cause took a
      // database query to find.
      toast.error(errMessage(e, "Failed to save contact info"));
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
    if (!window.confirm(`Archive ${lead?.contact_name || "this lead"}? It'll be removed from the board and Hit List. You can restore it later.`)) return;
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

  // The six stages the strip at the top of the Estimate tab shows. Each one
  // is read straight off data already on the page — nothing is stored.
  // "Replied" — they've answered us at all, usually the intake text.
  // "Heard back" — they've engaged AFTER the estimate went out: a text in,
  // or a call where we actually spoke to them. Voicemail and no-answer don't
  // count; a call logged as closed, an objection or a call-back does.
  // Kept apart from "Viewed" on purpose: viewed-and-silent is the case that
  // needs a call, and it only shows if the two are separate steps.
  const inbound = messages.filter((m) => m.direction === "inbound");
  const firstSentAt = sortedEstimates
    .filter((e) => e.status === "sent" && e.sent_at)
    .map((e) => e.sent_at as string)
    .sort()[0] || "";
  const TALKED: CallDispositionOutcome[] = [
    "closed", "objection_price", "objection_timing", "objection_spouse",
    "objection_hoa", "objection_more_estimates", "callback",
  ];
  const after = (iso: string | null | undefined) =>
    !!firstSentAt && !!iso && new Date(iso).getTime() > new Date(firstSentAt).getTime();
  const afterObjections = objections.filter((o) => o.timing === "after_estimate");
  const heardBack =
    inbound.some((m) => after(m.created_at)) ||
    dispositions.some((d) => TALKED.includes(d.outcome) && after(d.disposed_at)) ||
    afterObjections.length > 0;
  // Replied only counts if it happened BEFORE the first estimate went out.
  // When we sent without one — no answer to the intake text or the calls —
  // that's an override, and a reply afterwards is "Heard back", not this.
  const before = (iso: string | null | undefined) =>
    !!iso && (!firstSentAt || new Date(iso).getTime() <= new Date(firstSentAt).getTime());
  const repliedFirst =
    inbound.some((m) => before(m.created_at)) ||
    dispositions.some((d) => TALKED.includes(d.outcome) && before(d.disposed_at));

  const jp = lead.job_progress;
  const photos = (section: string) => jp?.photos?.[section] || 0;

  const journey: JourneyStep[] = [
    { key: "address", label: "Address", icon: MapPin, accent: ACCENT.blue, target: "est-contact",
      done: hasHouseNumber(lead.address),
      hint: lead.address && !hasHouseNumber(lead.address)
        ? `We only have "${lead.address}" — no house number. Ask for the full address.`
        : "Get a street address on file so the map and the pricing zone can resolve." },
    { key: "replied", label: "Replied", icon: MessageSquare, accent: ACCENT.rose, target: "est-contact",
      done: repliedFirst,
      skipped: !repliedFirst && !!firstSentAt,
      hint: !repliedFirst && firstSentAt
        ? "They never answered before we sent the estimate — sent anyway. A reply now shows under Heard back."
        : "Waiting on their first reply. Answering the intake text is the first sign they're real." },
    // Not every customer gets a scope, so once the estimate has gone out
    // without one this reads "Skipped", not "You are here".
    { key: "scope", label: "Scope sent", icon: FileText, accent: ACCENT.amber, target: "est-measure",
      done: !!lead.fence_scope_first_sent_at,
      skipped: !lead.fence_scope_first_sent_at && !!firstSentAt,
      hint: !lead.fence_scope_first_sent_at && firstSentAt
        ? "No scope of work went to this customer — the estimate was sent without one."
        : "Draw the scope on the Fence Scope tab and text it, so they confirm the sides before we price." },
    { key: "measured", label: "Measured", icon: Ruler, accent: ACCENT.violet, target: "est-measure",
      done: Number(linearFeet) > 0 || !!lead.measurement_uploaded,
      hint: "Trace the fence on the satellite and capture it — Linear Feet fills itself." },
    { key: "priced", label: "Priced", icon: Calculator, accent: ACCENT.fuchsia, target: "est-inputs",
      done: (estimate?.tiers?.signature || 0) > 0,
      hint: "Fill in the inputs and hit Save & Recalculate to get the three prices." },
    { key: "sent", label: "Sent", icon: Send, accent: ACCENT.cyan, target: "est-send",
      done: sortedEstimates.some((e) => e.status === "sent"),
      hint: "Send the proposal — text and email. The follow-ups start on their own." },
    { key: "viewed", label: "Viewed", icon: Eye, accent: ACCENT.amber, target: "est-send",
      done: (lead.proposal_view_count || 0) > 0,
      hint: "Waiting on the customer to open their proposal. A call now beats a text later." },
    { key: "heard", label: "Heard back", icon: Phone, accent: ACCENT.emerald, target: "est-objections",
      done: heardBack,
      badge: afterObjections.length
        ? `${new Set(afterObjections.map((o) => o.category)).size} objection${new Set(afterObjections.map((o) => o.category)).size === 1 ? "" : "s"}`
        : undefined,
      hint: (lead.proposal_view_count || 0) > 0
        ? "They opened it and went quiet. Call them now — this is the moment."
        : "No text or real conversation since the estimate went out. Call, then log how it went." },
    { key: "booked", label: "Booked", icon: CalendarCheck, accent: ACCENT.emerald, target: "est-visits",
      done: !!latestScheduledJob || (lead.deposit_status || "").toLowerCase() === "paid",
      hint: "Collect the deposit and put the visits on the calendar." },

    // ── The job. Read off the last scheduled visit. ──
    { key: "started", label: "Job started", icon: Paintbrush, accent: ACCENT.cyan, target: "est-visits", phase: "job",
      done: !!latestScheduledJob && (!!latestScheduledJob.started_at
        || ["in_progress", "completed"].includes(latestScheduledJob.status)),
      hint: "The crew taps Start on the job when they arrive." },
    { key: "colour", label: "Colour chosen", icon: Palette, accent: ACCENT.fuchsia, target: "est-visits", phase: "job",
      done: !!jp?.final_color || ((jp?.color_rows || 0) > 0 && jp?.color_confirmed === jp?.color_rows),
      active: (jp?.color_rows || 0) > 0 && (jp?.color_confirmed || 0) < (jp?.color_rows || 0) && !jp?.final_color,
      activeLabel: `${jp?.color_confirmed || 0} of ${jp?.color_rows || 0} settled`,
      hint: "Confirm the stain colour for every part of the fence on Company Cam." },
    { key: "cleaned", label: "Fence cleaned", icon: Sparkles, accent: ACCENT.cyan, target: "est-visits", phase: "job",
      done: photos("clean_after") > 0,
      active: photos("clean_before") > 0 && photos("clean_after") === 0,
      activeLabel: "Getting cleaned",
      hint: "Cleaner uploads before-cleaning photos on arrival, after-cleaning photos when done." },
    { key: "stained", label: "Fence stained", icon: Paintbrush, accent: ACCENT.emerald, target: "est-visits", phase: "job",
      done: photos("stain_after") > 0,
      active: photos("stain_before") > 0 && photos("stain_after") === 0,
      activeLabel: "Getting stained",
      hint: "Stainer uploads before-staining photos on arrival, after-staining photos when done." },
    { key: "completed", label: "Job done", icon: CheckCircle2, accent: ACCENT.emerald, target: "est-visits", phase: "job",
      done: !!latestScheduledJob && (latestScheduledJob.status === "completed" || !!latestScheduledJob.completed_at),
      hint: "Walkthrough with the customer, then the crew marks the job complete." },
    { key: "invoiced", label: "Invoiced", icon: Receipt, accent: ACCENT.violet, target: "est-contact", phase: "job",
      done: !!latestScheduledJob && (!!latestScheduledJob.qb_invoice_id
        || ["pending", "paid"].includes((latestScheduledJob.payment_status || "").toLowerCase())),
      hint: "Generate the full invoice under Payment links — it texts them a tap-to-pay link." },
    { key: "reviewed", label: "Google review", icon: Star, accent: ACCENT.gold, target: "est-contact", phase: "job",
      done: !!lead.form_data?.google_review_left_at,
      hint: "Ask every customer for a review, happy or not. Tap here once they've left one.",
      onClick: async () => {
        const left = !lead.form_data?.google_review_left_at;
        const ok = window.confirm(left
          ? `Mark that ${lead.contact_name || "this customer"} left a Google review?`
          : "Un-mark the Google review?");
        if (!ok) return;
        try {
          const r = await api.setGoogleReview(lead.id, left);
          setLead((prev) => prev ? {
            ...prev,
            form_data: { ...prev.form_data, google_review_left_at: r.google_review_left_at || "" },
          } : prev);
          toast.success(left ? "Google review marked" : "Google review un-marked");
        } catch (e) {
          toast.error(errMessage(e, "Couldn't save"));
        }
      } },
  ];

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
        {/* Every customer gets their own colour, hashed from the name, so the
            page is recognisable at a glance when flipping between leads. */}
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br ${accentForName(lead.contact_name || "").grad} font-heading text-sm font-bold text-white shadow-md shadow-black/10`}>
          {initials(lead.contact_name || "")}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="font-heading text-lg sm:text-2xl font-bold tracking-tight truncate">{lead.contact_name || "Unknown Lead"}</h1>
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
                } catch (e) {
                  toast.error(errMessage(e, "Couldn't start practice call"));
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
          {/* Straight back into the customer's GHL conversation. The contact
              detail page is the chat thread, so the two ids already on every
              lead are all this needs — see lib/ghlLink.ts for why the domain
              is not interchangeable. */}
          {ghlContactUrl(lead.ghl_location_id, lead.ghl_contact_id) && (
            <a
              href={ghlContactUrl(lead.ghl_location_id, lead.ghl_contact_id)}
              target="_blank"
              rel="noopener noreferrer"
              title="Open this customer's conversation in GHL"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <MessageSquare className="h-3.5 w-3.5 mr-1" />
              Open in GHL
              <ExternalLink className="h-3 w-3 ml-1 opacity-60" />
            </a>
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
                } catch (e) {
                  toast.error(errMessage(e, "Couldn't sync from GHL"));
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
          const next = v as "estimate" | "call" | "exterior" | "upsell" | "estimator" | "companycam";
          setActiveTab(next);
          if (next === "call" && callTabSeenKey) {
            const now = new Date().toISOString();
            localStorage.setItem(callTabSeenKey, now);
            setCallTabSeenAt(now);
          }
        }}
      >
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="estimate"><Calculator className="hidden sm:block" /> Estimate</TabsTrigger>
          <TabsTrigger value="scope"><Ruler className="hidden sm:block" /> Fence Scope</TabsTrigger>
          <TabsTrigger value="companycam"><Camera className="hidden sm:block" /> Company Cam</TabsTrigger>
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
          <TabsTrigger value="estimator"><WandSparkles className="hidden sm:block" /> Estimator</TabsTrigger>
          <TabsTrigger value="history"><History className="hidden sm:block" /> Activity History</TabsTrigger>
        </TabsList>

        <TabsContent value="estimate" className="space-y-4 sm:space-y-6 mt-4">
          {/* Six stages from "we have an address" to "it's on the calendar",
              each tappable, each the same colour it is everywhere else on
              the page. Answers "what do I do next on this lead?" before a
              single card is read. */}
          <JourneyStrip steps={journey} />

          {/* Every objection the scanner found in this customer's texts and
              calls, each with their exact words and whether it came before or
              after the estimate. Nobody picks; a wrong one can be removed. */}
          <ObjectionsPanel
            leadId={lead.id}
            objections={objections}
            categories={objectionCats}
            onChange={loadObjections}
          />

          {/* Mobile: approval status */}
          {approvalCfg && (
            <ApprovalBanner cfg={approvalCfg} reason={estimate?.approval_reason} className="lg:hidden" />
          )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
        {/* Left column */}
        <div className="lg:col-span-2 space-y-4 sm:space-y-6">
          {/* Contact info */}
          <Panel
            id="est-contact"
            className="scroll-mt-4"
            icon={UserRound}
            title="Contact"
            sub={lead.area || (lead.zip_code ? `ZIP ${lead.zip_code}` : "Who we're quoting")}
            accent={ACCENT.blue}
            right={!editingContact ? (
                  <div className="flex gap-1.5 flex-wrap justify-end">
                    <Button variant="outline" size="sm" onClick={async () => {
                      setAskingAddress(true);
                      try {
                        const r = await api.askForAddress(id!);
                        const data = await api.getLead(id!);
                        setLead(data);
                        toast.success(`Tagged “${r.tag || "asking-for-address"}” — GHL will take it from here`);
                      } catch (e) { toast.error(errMessage(e, "Failed to add tag")); }
                      finally { setAskingAddress(false); }
                    }}
                    disabled={askingAddress || lead?.form_data?.address_action === "asked_for_address" || lead?.pipeline_version === "v1"}
                    title={lead?.pipeline_version === "v1" ? "Export to new pipeline first" : undefined}>
                      <Navigation className="h-3.5 w-3.5 mr-1" />
                      {lead?.form_data?.address_action === "asked_for_address" ? "Asked" : askingAddress ? "Tagging..." : "Ask for Address"}
                    </Button>
                    {/* New Build — archived 2026-10-08, Alan's call: focus on
                        Ask for Address. The endpoint (/leads/{id}/new-build)
                        and its SMS are kept; uncomment to bring it back. */}
                    {SHOW_NEW_BUILD && <Button variant="outline" size="sm" onClick={async () => {
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
                    </Button>}
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
          >
              {editingContact ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="Name">
                    <Input value={contactName} onChange={(e) => setContactName(e.target.value)} />
                  </Field>
                  <Field label="Phone">
                    <Input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
                  </Field>
                  <Field label="Email">
                    <Input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
                  </Field>
                  <Field label="Address">
                    <Input value={contactAddress} onChange={(e) => setContactAddress(e.target.value)} />
                  </Field>
                  <Field label="ZIP code">
                    <Input value={contactZip} maxLength={5} inputMode="numeric" onChange={(e) => setContactZip(e.target.value)} />
                  </Field>
                  <Field label="Lead source">
                    <select
                      value={leadSource}
                      onChange={(e) => setLeadSource(e.target.value)}
                      className={selectCls}
                    >
                      {leadSourceOptionsFor(leadSource).map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </Field>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <ContactFact icon={UserRound} accent={ACCENT.blue} label="Name">
                      {lead.contact_name || "—"}
                    </ContactFact>
                    <ContactFact icon={Phone} accent={ACCENT.emerald} label="Phone">
                      {lead.contact_phone
                        ? <a href={`tel:${lead.contact_phone}`} className="text-primary hover:underline">{lead.contact_phone}</a>
                        : "—"}
                    </ContactFact>
                    <ContactFact icon={Mail} accent={ACCENT.violet} label="Email">
                      {lead.contact_email || "—"}
                    </ContactFact>
                    <ContactFact
                      icon={MapPin}
                      accent={ACCENT.amber}
                      label="Address"
                      right={mapsUrl ? (
                        <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className="shrink-0 self-center" title="Open in Google Maps">
                          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground hover:text-primary" />
                        </a>
                      ) : undefined}
                    >
                      {lead.address || "—"}
                      {lead.area && (
                        <span className="block truncate text-[11px] font-normal text-muted-foreground">{lead.area}</span>
                      )}
                    </ContactFact>
                    <ContactFact icon={Compass} accent={ACCENT.cyan} label="ZIP code">
                      {lead.zip_code || "—"}
                    </ContactFact>
                  </div>
                  {/* Inline source picker — fires save on change so admin doesn't have to enter Edit mode for this one field */}
                  <div className="flex items-center gap-2 pt-2 border-t">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Source</span>
                    <select
                      value={leadSource}
                      onChange={(e) => handleSaveLeadSource(e.target.value as LeadSource)}
                      className="h-8 rounded-lg border border-input bg-background px-2 text-xs"
                    >
                      {leadSourceOptionsFor(leadSource).map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                    <span className="text-[10px] text-muted-foreground italic ml-auto hidden sm:inline">Default = Ad. Update if this came from a different channel.</span>
                  </div>
                </>
              )}

              {/* Payment Links (Phase 2, 2026-06-08). Unified controls for the
                  $250 deposit + full job invoice. Replaces the standalone
                  DepositCard above the tabs and the Generate-Invoice button
                  strip that used to live here. Deposit always shows; Full
                  Invoice prompts admin to schedule first if no job exists. */}
              <div className="pt-3 border-t space-y-2">
                <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                  <CircleDollarSign className="h-3.5 w-3.5 text-emerald-600" /> Payment links
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
          </Panel>

          {/* Google Maps Satellite View */}
          {lead.address && (
            <Panel icon={Satellite} title="Satellite view" sub={mapQuery} accent={ACCENT.cyan} bodyClassName="space-y-2 p-2">
                <div className="rounded-xl overflow-hidden border" style={{ minHeight: 250 }}>
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
                  className="w-full inline-flex items-center justify-center gap-2 rounded-xl border text-sm py-2 hover:bg-muted transition-colors sm:hidden"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> Open in Google Maps
                </a>
            </Panel>
          )}

          {/* "Before you call" pre-call brief — hidden 2026-09-29, Alan's call:
              not useful in practice and it was taking up room above the
              measurement card. Component, API and the Claude dossier builder
              (services/call_prep.py) are all kept. It only ever ran on a
              button press, so hiding it costs nothing and saves the API call.
              Uncomment to bring it back. */}
          {/* <CallPrepCard leadId={lead.id} leadName={lead.contact_name} /> */}

          {/* Measure the property in place. Sits directly above the
              estimator because its output IS the estimator's first input:
              trace the fence, capture, and Linear Feet fills itself. The
              upload card below stays for the cases this can't serve — new
              construction Google Earth hasn't photographed yet, or a
              surveyor's PDF. */}
          <div id="est-measure" className="scroll-mt-4">
            <SatelliteMeasureCard
              leadId={lead.id}
              lat={lead.lat || 0}
              lng={lead.lng || 0}
              address={lead.address || ""}
              zipCode={zipCode || lead.zip_code || ""}
              onLinearFeet={(feet) => setLinearFeet(String(feet))}
              onChange={() => {
                api.getLead(lead.id).then(setLead).catch(() => {});
              }}
            />
          </div>

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
          <Panel
            id="est-inputs"
            className="scroll-mt-4"
            icon={Calculator}
            title="Estimator input"
            sub="What the three prices are built from"
            accent={ACCENT.fuchsia}
            bodyClassName="space-y-4 p-3.5"
          >
              {/* The two numbers that matter most get the biggest boxes. */}
              <div className="grid grid-cols-2 gap-3">
                <StatTile icon={Ruler} label="Linear feet" accent={ACCENT.violet}>
                  <Input
                    type="number"
                    placeholder="e.g. 150"
                    value={linearFeet}
                    onChange={(e) => setLinearFeet(e.target.value)}
                    className="h-11 text-xl font-bold tabular-nums"
                  />
                </StatTile>
                <StatTile icon={MapPin} label="ZIP code" accent={ACCENT.amber}>
                  <Input
                    type="text"
                    placeholder="e.g. 77429"
                    maxLength={5}
                    value={zipCode}
                    onChange={(e) => setZipCode(e.target.value)}
                    className="h-11 text-xl font-bold tabular-nums"
                  />
                </StatTile>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Fence height">
                  <select className={selectCls} value={fenceHeight} onChange={(e) => setFenceHeight(e.target.value)}>
                    {FENCE_HEIGHT_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </Field>
                <Field label="Fence age">
                  <select className={selectCls} value={fenceAge} onChange={(e) => setFenceAge(e.target.value)}>
                    {FENCE_AGE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </Field>
                <Field label="Previously stained">
                  <select className={selectCls} value={previouslyStained} onChange={(e) => setPreviouslyStained(e.target.value)}>
                    {PREVIOUSLY_STAINED_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </Field>
                <Field label="Timeline">
                  <select className={selectCls} value={timeline} onChange={(e) => setTimeline(e.target.value)}>
                    <option value="">Select...</option>
                    {timelineOptionsFor(timeline).map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </Field>
              </div>

              {/* Confidence as three buttons, green to red, instead of a
                  dropdown: the VA's own doubt should be visible at a glance. */}
              <Field label="Confidence in the measurement">
                <div className="grid grid-cols-3 gap-1.5">
                  {CONFIDENCE_OPTIONS.map((o) => {
                    const on = confidencePct === o.value;
                    return (
                      <button
                        key={o.value}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setConfidencePct(o.value)}
                        className={cn(
                          "h-10 rounded-xl border px-2 text-xs font-semibold transition active:scale-95",
                          on
                            ? `border-transparent bg-gradient-to-br ${CONFIDENCE_TONE[o.value]} text-white shadow-sm`
                            : "border-input bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                        )}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              </Field>

              {/* Confidence Note — shown when not confident */}
              {confidencePct === "60" && (
                <Field label={<span className="text-rose-600">Why are you not confident?</span>}>
                  <textarea
                    className="w-full border border-rose-200 rounded-xl px-3 py-2 text-sm bg-rose-50/30 focus:outline-none focus:ring-2 focus:ring-rose-300 min-h-[60px]"
                    placeholder="Explain why you're not confident in this measurement..."
                    value={confidenceNote}
                    onChange={(e) => setConfidenceNote(e.target.value)}
                  />
                </Field>
              )}

              {/* Fence Sides */}
              <Field label="Fence sides" hint="Tap the sides that get stained. Front faces the street.">
                <SidesPicker value={fenceSides} onChange={setFenceSides} />
              </Field>

              {/* Additional Services + Add-on Handled + Military Discount */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Additional services">
                  <Input placeholder="e.g. gate painting, pressure washing" value={additionalServices} onChange={(e) => setAdditionalServices(e.target.value)} />
                  {additionalServices && additionalServices.toLowerCase() !== "none" && (
                    <label className="flex items-center gap-2 text-xs mt-1.5 cursor-pointer text-emerald-700">
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
                </Field>
                <Field label="Options">
                  <div className="flex flex-wrap gap-1.5">
                    <ToggleChip
                      on={includeFinancing}
                      onClick={() => setIncludeFinancing((v) => !v)}
                      icon={CreditCard}
                      accent={ACCENT.blue}
                      title="Show the monthly financing figure on the proposal"
                    >
                      Financing
                    </ToggleChip>
                    <ToggleChip
                      on={militaryDiscount}
                      onClick={() => setMilitaryDiscount((v) => !v)}
                      icon={Shield}
                      accent={ACCENT.emerald}
                      title="Apply the military discount"
                    >
                      Military discount
                    </ToggleChip>
                  </div>
                </Field>
              </div>

              {/* Additional Notes — collapsible so long GHL notes don't dominate */}
              <Field
                label="Additional notes"
                right={additionalNotes ? (
                  <button
                    type="button"
                    onClick={() => setNotesExpanded((v) => !v)}
                    className="text-[11px] text-muted-foreground hover:text-foreground underline"
                  >
                    {notesExpanded ? "Collapse" : "Expand"}
                  </button>
                ) : undefined}
              >
                <textarea
                  className="w-full border border-input rounded-xl px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring resize-y"
                  rows={notesExpanded ? 12 : 3}
                  placeholder="Anything else the customer mentioned (special requests, gate access, pets, etc.)"
                  value={additionalNotes}
                  onChange={(e) => setAdditionalNotes(e.target.value)}
                />
              </Field>

              <Button
                onClick={handleSaveRecalculate}
                disabled={saving}
                className="h-11 w-full rounded-xl bg-gradient-to-r from-fuchsia-600 to-violet-600 text-sm font-semibold text-white shadow-md shadow-fuchsia-500/20 hover:from-fuchsia-700 hover:to-violet-700"
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${saving ? "animate-spin" : ""}`} />
                {saving ? "Recalculating..." : "Save & Recalculate"}
              </Button>
          </Panel>

          {/* (Follow-up automation, Messages, Chatbot, Call Recordings all
              relocated to the Call tab below.) */}
        </div>

        {/* Right column */}
        <div className="space-y-4 sm:space-y-6">
          {/* Approval status — desktop */}
          {approvalCfg && (
            <ApprovalBanner cfg={approvalCfg} reason={estimate?.approval_reason} className="hidden lg:flex" />
          )}

          {/* Estimate switcher — only renders when there are multiple estimates
              on this lead. Lets the VA edit/view different estimates for the
              same customer (e.g. quotes for different houses). */}
          {sortedEstimates.length > 1 && (
            <Card className="gap-0 py-0">
              <div className="p-3.5">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Estimates on this lead</p>
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
                        className={`text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
                          isSel
                            ? "bg-gradient-to-br from-blue-600 to-indigo-700 text-white border-transparent shadow-sm"
                            : "border-border hover:bg-muted/50"
                        }`}
                        title={e.label || `Estimate #${num}`}
                      >
                        <span className="font-semibold">#{num}</span>
                        {e.label && <span className="ml-1">· {e.label.length > 18 ? e.label.slice(0, 18) + "…" : e.label}</span>}
                        {!e.label && sigPrice > 0 && (
                          <span className="ml-1 opacity-80 tabular-nums">· {formatCurrency(sigPrice)}</span>
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
              </div>
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
            <Panel
              icon={Gem}
              title={
                <>
                  Estimate
                  {sortedEstimates.length > 1 && estimate && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      #{sortedEstimates.length - sortedEstimates.findIndex((e) => e.id === estimate.id)}
                      {estimate.label && ` · ${estimate.label}`}
                    </span>
                  )}
                </>
              }
              sub="Three packages, one fence"
              accent={ACCENT.gold}
              bodyClassName="space-y-2 p-3.5"
            >
                {(["essential", "signature", "legacy"] as const).map((tier) => (
                  <TierCard key={tier} tier={tier} price={estimate.tiers[tier] || 0} />
                ))}
                {fenceSides.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 pt-1">
                    <span className="mr-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Sides</span>
                    {fenceSides.map((s) => (
                      <Pill key={s} accent={s.startsWith("Inside") ? ACCENT.violet : ACCENT.cyan}>{s}</Pill>
                    ))}
                  </div>
                )}
                {estimate.breakdown.length > 0 && (
                  <BreakdownEditor
                    estimateId={estimate.id}
                    items={estimate.breakdown}
                    tiers={estimate.tiers}
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
            </Panel>
          )}

          {/* Actions */}
          {estimate && estimate.status === "pending" && (
            <Panel
              id="est-send"
              className="scroll-mt-4"
              icon={Rocket}
              title="Send the estimate"
              sub="Text and email · the follow-ups start on their own"
              accent={ACCENT.emerald}
              bodyClassName="space-y-2.5 p-3.5"
            >
              <Button variant="outline" onClick={() => navigate(`/leads/${id}/edit-pdf`)} className="h-10 w-full rounded-xl">
                <Eye className="h-4 w-4 mr-2" /> Edit & Preview PDF
              </Button>

              {/* Pre-estimate call section removed per spec — VAs no longer
                  required to log a pre-call before sending. Backend
                  Estimate.precall_* fields stay in place for historical data. */}

              {/* Send disabled — old pipeline */}
              {lead.pipeline_version === "v1" && (
                <div className="rounded-xl border-2 border-red-300 bg-gradient-to-r from-red-50 to-rose-50 p-3">
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
                <div className="rounded-xl border border-amber-300 bg-gradient-to-r from-amber-50 to-orange-50 p-3">
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
                <div className="rounded-xl border-2 border-blue-300 bg-gradient-to-r from-blue-50 to-indigo-50 p-4 space-y-3">
                  <h4 className="text-xs font-semibold text-blue-800 uppercase tracking-wider flex items-center gap-1.5">
                    <Calendar className="h-3.5 w-3.5" /> Schedule Send
                  </h4>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Date">
                      <Input type="date" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} className="h-8 text-sm" />
                    </Field>
                    <Field label="Time (Houston)">
                      <Input type="time" value={scheduledTime} onChange={(e) => setScheduledTime(e.target.value)} className="h-8 text-sm" />
                    </Field>
                  </div>
                  {/* Weekday derived from the date — the check that catches an
                      off-by-one before the message goes out. The clock line
                      spells out both times for anyone working outside Houston,
                      because the field means Houston time wherever you are. */}
                  {scheduledDate && (
                    <p className="text-xs text-blue-800">
                      {dayHeader(scheduledDate)}
                      {scheduledTime && <> · {bothClocks(centralToUTC(scheduledDate, scheduledTime))}</>}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button
                      onClick={() => {
                        if (!scheduledDate) { toast.error("Pick a date"); return; }
                        // Houston wall clock to a real instant. Never hardcode
                        // the offset here — it's -5 in summer, -6 in winter.
                        const when = centralToUTC(scheduledDate, scheduledTime);
                        if (isNaN(when.getTime())) { toast.error("Pick a valid time"); return; }
                        handleApprove(when.toISOString());
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

              <Field label="Send via">
                <div className="flex flex-wrap gap-1.5">
                  <ToggleChip
                    on={sendSms && !!lead.contact_phone}
                    disabled={!lead.contact_phone}
                    onClick={() => setSendSms((v) => !v)}
                    icon={MessageSquare}
                    accent={ACCENT.emerald}
                    title={lead.contact_phone ? `SMS to ${lead.contact_phone}` : "No phone on file — SMS unavailable"}
                  >
                    SMS
                    {lead.contact_phone && <span className="font-normal opacity-80">· {lead.contact_phone}</span>}
                  </ToggleChip>
                  <ToggleChip
                    on={alsoEmail && !!lead.contact_email}
                    disabled={!lead.contact_email}
                    onClick={() => setAlsoEmail((v) => !v)}
                    icon={Mail}
                    accent={ACCENT.violet}
                    title={lead.contact_email ? `Email to ${lead.contact_email}` : "No email on file — email unavailable"}
                    className="max-w-full"
                  >
                    Email
                    {lead.contact_email && <span className="truncate font-normal opacity-80">· {lead.contact_email}</span>}
                  </ToggleChip>
                </div>
              </Field>

              <div className="flex gap-2">
                {/* The one button the whole page leads to. It glows when the
                    estimate is cleared to go, and only then. */}
                <div className="relative flex-1">
                  {estimate.approval_status === "green" && !approving && lead.pipeline_version !== "v1" && (
                    <div className="pointer-events-none absolute -inset-1 animate-pulse rounded-2xl bg-gradient-to-r from-emerald-400 to-teal-500 opacity-40 blur-md" />
                  )}
                  <Button
                    onClick={() => handleApprove()}
                    disabled={approving || lead.pipeline_version === "v1"}
                    title={lead.pipeline_version === "v1" ? "Export to new pipeline before sending" : "Sends the proposal + applies the 'estimate sent' GHL tag (triggers P1 / P04 automations)"}
                    className="relative h-11 w-full rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 text-sm font-semibold text-white shadow-md shadow-emerald-500/20 hover:from-emerald-600 hover:to-teal-700 disabled:from-gray-300 disabled:to-gray-300 disabled:shadow-none"
                  >
                    <Send className={`h-4 w-4 mr-2 ${approving ? "animate-spin" : ""}`} />
                    {approving ? "Sending..." : "Send Now"}
                  </Button>
                </div>
                {/* A deliberate buffer, not a delay for its own sake: an
                    estimate landing the second a call ends reads as a machine
                    spitting out a number. Ten minutes reads as someone working
                    on it. No timezone involved — it's ten minutes from now
                    wherever the VA is sitting, so there is nothing to get
                    wrong from Honduras. */}
                <Button
                  variant="outline"
                  onClick={() => {
                    const when = new Date(Date.now() + SEND_BUFFER_MINUTES * 60_000);
                    const who = lead.contact_name || "this customer";
                    const ok = window.confirm(
                      `Send the estimate to ${who} at ${bothClocks(when)}?\n\n` +
                      `That's ${SEND_BUFFER_MINUTES} minutes from now. The 'estimate sent' tag ` +
                      `and the follow-up automations fire once it goes out.`,
                    );
                    if (!ok) return;
                    handleApprove(when.toISOString());
                  }}
                  disabled={approving || lead.pipeline_version === "v1"}
                  title={lead.pipeline_version === "v1"
                    ? "Export to new pipeline before scheduling"
                    : `Schedules the estimate ${SEND_BUFFER_MINUTES} minutes out, so it doesn't land the instant the call ends`}
                  className="h-11 shrink-0 rounded-xl"
                >
                  <Clock className="h-4 w-4 mr-1" /> In {SEND_BUFFER_MINUTES} min
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setScheduledDate(getDefaultScheduleDate());
                    setShowScheduler(!showScheduler);
                  }}
                  disabled={approving || lead.pipeline_version === "v1"}
                  title={lead.pipeline_version === "v1" ? "Export to new pipeline before scheduling" : undefined}
                  className="h-11 shrink-0 rounded-xl"
                >
                  <Calendar className="h-4 w-4 mr-1" /> Schedule
                </Button>
              </div>
              {/* Marks that this estimate was done on-site (in person) vs remote.
                  Auto-detected from estimator activity (photos/videos, recordings,
                  notes); a manual check/uncheck overrides and wins. */}
              {(() => {
                const manuallySet = typeof (lead?.form_data as Record<string, unknown> | undefined)?.estimated_in_person === "boolean";
                const autoDetected = Boolean(lead?.estimated_in_person_auto) && !manuallySet;
                return (
                  <label className="flex items-center gap-2 text-xs mt-1 cursor-pointer text-muted-foreground w-fit">
                    <input
                      type="checkbox"
                      checked={Boolean(lead?.estimated_in_person)}
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
                    {autoDetected && <span className="text-[10px] text-emerald-600">· auto-detected</span>}
                  </label>
                );
              })()}
              {/* Second send path — same proposal + customer SMS, but skips
                  the "estimate sent" GHL tag so the P1/P04 follow-up
                  automations don't fire for this send. Confirmation prompt
                  inside handleApprove guards against accidental clicks. */}
              <Button
                variant="outline"
                onClick={() => handleApprove(undefined, false)}
                disabled={approving || lead.pipeline_version === "v1"}
                title="Send the proposal without applying the 'estimate sent' GHL tag (no GHL automation fires)"
                className="w-full rounded-xl border-amber-300 text-amber-900 hover:bg-amber-50 hover:text-amber-900"
              >
                <Send className={`h-4 w-4 mr-2 ${approving ? "animate-spin" : ""}`} />
                {approving ? "Sending..." : "Send Without Tag (no automation)"}
              </Button>
              {estimate.approval_status === "red" && (
                <>
                  <Button variant="outline" onClick={handleRequestReview} disabled={requestingReview} className="w-full rounded-xl">
                    <Shield className={`h-4 w-4 mr-2 ${requestingReview ? "animate-spin" : ""}`} />
                    {requestingReview ? "Sending..." : "Request Alan's Approval"}
                  </Button>
                  <p className="text-xs text-center text-muted-foreground flex items-center justify-center gap-1">
                    <AlertTriangle className="h-3 w-3" /> Needs review before sending
                  </p>
                </>
              )}
            </Panel>
          )}

          {estimate && estimate.status === "sent" && (
            <div id="est-send" className="relative scroll-mt-4 overflow-hidden rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 p-4 text-white shadow-md shadow-emerald-500/20">
              <div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-white/10 blur-2xl" />
              <div className="relative flex items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/20 ring-2 ring-white/40">
                  <CheckCircle2 className="h-6 w-6" />
                </div>
                <div className="min-w-0">
                  <p className="font-heading text-base font-bold leading-tight">Estimate sent</p>
                  <p className="text-xs text-white/80">{estimate.sent_at ? formatDateTime(estimate.sent_at) : ""}</p>
                </div>
              </div>
              <div className="relative mt-3 flex gap-2">
                <a href={api.getEstimatePdfUrl(estimate.id)} target="_blank" rel="noopener noreferrer" className="flex-1">
                  <Button variant="outline" className="h-10 w-full rounded-xl border-white/40 bg-white/10 text-white hover:bg-white/20 hover:text-white">
                    <FileText className="h-4 w-4 mr-2" /> View PDF
                  </Button>
                </a>
                <Button
                  variant="outline"
                  onClick={handleCancel}
                  disabled={cancelling}
                  className="h-10 rounded-xl border-white/30 bg-white/10 text-white hover:bg-rose-600 hover:text-white"
                >
                  {cancelling ? "Cancelling..." : "Cancel Estimate"}
                </Button>
              </div>
            </div>
          )}

          {/* Send a pre-made PDF as the proposal (same link + viewer + SMS) */}
          <CustomProposalCard
            leadId={lead.id}
            pipelineVersion={lead.pipeline_version}
            onSent={() => { if (id) api.getLead(id).then(setLead).catch(() => {}); }}
          />

          {/* All scheduled visits for this customer (clean/stain/finish-up) —
              add, edit, and reschedule each; shows invite vs internal. */}
          <div id="est-visits" className="scroll-mt-4">
            <ScheduledVisitsCard lead={lead} />
          </div>

          {/* FenceScope video estimates — hidden 2026-09-28. Route, API and
              data all kept: 3 submissions ever, none from a real customer, and
              nothing sent since 25 Aug. Uncomment to bring it back. */}
          {/* <VideoEstimateCard leadId={lead.id} /> */}

          {/* Phone only: The Hit List sits right under "Send a custom PDF".
              Desktop keeps it full-width below the grid (rendered there when
              !isMobile). Only one instance mounts, so no double fetch. */}
          {isMobile && (
            <Panel icon={Flame} title="The Hit List" sub="This lead's row from the daily queue" accent={ACCENT.rose}>
              <DailyTaskList leadId={lead.id} />
            </Panel>
          )}

          {/* Meta info */}
          <Card className="gap-0 py-0">
            <div className="grid grid-cols-2 gap-1.5 p-2">
              <Fact icon={Calendar} label="Created">{formatDate(lead.created_at)}</Fact>
              <Fact icon={MapPin} label="ZIP">{lead.zip_code || "—"}</Fact>
              <Fact icon={Paintbrush} label="Service">{lead.service_type}</Fact>
              {estimate && (
                <>
                  <Fact icon={Compass} label="Zone">{String(estimate.inputs?.["_zone"] ?? "—")}</Fact>
                  <Fact icon={Ruler} label="Sq ft">{String(estimate.inputs?.["_sqft"] ?? "—")}</Fact>
                </>
              )}
            </div>
          </Card>

          {/* Estimate history — every estimate sent to this customer with
              freeform local label + input snapshot. Hides itself when the
              lead has no sent estimates yet. */}
          <EstimateHistoryCard leadId={lead.id} refreshKey={lead.estimates?.length || 0} />

          {/* Export to new pipeline (v1 leads only) */}
          {lead.pipeline_version === "v1" && (
            <Panel icon={ArrowRightCircle} title="Export to new pipeline" sub="History, estimates and contact info all come along" accent={ACCENT.blue}>
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
                <Button onClick={handleExportToV2} disabled={exporting} className="w-full rounded-xl bg-gradient-to-r from-blue-600 to-indigo-700 text-white hover:from-blue-700 hover:to-indigo-800">
                  {exporting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <ArrowRightCircle className="h-4 w-4 mr-2" />}
                  Export to "{V2_STAGES.find((s) => s.id === exportStageId)?.shortLabel}"
                </Button>
            </Panel>
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
              the dashboard queue, mirrored here. Desktop position; on phones
              it's rendered up under "Send a custom PDF" instead. */}
          {!isMobile && (
            <Panel icon={Flame} title="The Hit List" sub="This lead's row from the daily queue" accent={ACCENT.rose}>
              <DailyTaskList leadId={lead.id} />
            </Panel>
          )}

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

        <TabsContent value="scope" className="space-y-4 sm:space-y-6 mt-4">
          <FenceScopeSummaryCard leadId={lead.id} />
        </TabsContent>

        <TabsContent value="exterior" className="space-y-4 sm:space-y-6 mt-4">
          <ExteriorTab lead={lead} onChange={(updated) => setLead(updated)} />
        </TabsContent>

        <TabsContent value="upsell" className="space-y-4 sm:space-y-6 mt-4">
          <UpsellTab lead={lead} />
        </TabsContent>

        {/* Company Cam — the job-site record. Mounted lazily: it creates its
            own row and imports the fence scope drawing on first open, so it
            must not fire for every lead page view. */}
        <TabsContent value="companycam" className="space-y-4 sm:space-y-6 mt-4">
          {activeTab === "companycam" ? <CompanyCamTab leadId={lead.id} /> : null}
        </TabsContent>

        <TabsContent value="estimator" className="space-y-4 sm:space-y-6 mt-4">
          <Card>
            <CardContent className="p-4">
              <EstimatorLeadPanel leadId={lead.id} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history" className="space-y-4 sm:space-y-6 mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Activity History</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              <LeadActivityHistory leadId={lead.id} />
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

  const loadCalls = useCallback(() => {
    api.getLeadCalls(leadId)
      .then(setRecordings)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [leadId]);

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
    } catch (e) {
      toast.error(errMessage(e, "Couldn't archive"));
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

  useEffect(() => { loadCalls(); }, [loadCalls]);

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
    } catch (err) {
      const msg = errName(err) === "NotAllowedError"
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
      try { recorderRef.current.stop(); } catch { /* already stopped */ }
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
  estimateId, items, tiers, onSaved,
}: {
  estimateId: string;
  items: BreakdownItem[];
  tiers: EstimateDetail["tiers"];
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

  // What Save will store — the same rule as the server: each tier is its own
  // base line plus every surcharge line. Shown live so a $10 change to the
  // Essential line reads as a $10 change, not as a mystery.
  const preview = editing ? tiersFromBreakdown(editItems, tiers, items) : null;

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
          <div key={i} className="flex justify-between rounded-md px-2 py-1 text-xs odd:bg-muted/40">
            <span className="truncate mr-2">{item.label}</span>
            <span className="font-medium tabular-nums shrink-0">{formatCurrency(item.value)}</span>
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
      <p className="text-[10px] leading-snug text-muted-foreground">
        Edit a tier's own line to change that price. Every other line is a surcharge and goes on all three.
      </p>
      <div className="flex items-center justify-between gap-2 pt-1.5 border-t">
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs tabular-nums">
          {preview ? TIER_KEYS.map((t) => (
            <span key={t}>
              <span className="capitalize text-muted-foreground">{t}</span>{" "}
              <span className={cn("font-semibold", t === "signature" && "text-primary")}>{formatCurrency(preview[t])}</span>
            </span>
          )) : null}
        </div>
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
  const [refreshing, setRefreshing] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [markingPaid, setMarkingPaid] = useState(false);
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
      // The backend names the actual blocker (no GHL contact, no link, or a
      // QuickBooks sign-in link). Show that instead of guessing at a reason.
      const why = r.sms_skipped_reason ? ` — ${r.sms_skipped_reason}.` : ".";
      if (r.status === "sent") {
        if (r.sms_sent) toast.success("Deposit link texted to the customer.");
        else toast.warning(`Invoice created, but the text didn't send${why} Share the link manually.`, { duration: 10000 });
      } else if (r.status === "already_sent") {
        if (r.sms_sent) toast.success("Deposit link re-texted to the customer.");
        else toast.info(`Deposit invoice exists — couldn't text it${why} Share the link manually.`, { duration: 10000 });
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

  // Re-pull the public pay link WITHOUT texting the customer, so admin can
  // Open + eyeball it before sending. Heals a stale/login link on the server
  // side (send-deposit-invoice refreshes a non-public link when text_customer
  // is false).
  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const r = await api.sendDepositInvoice(lead.id, false);
      const url = r.deposit_payment_link || "";
      if (!url) {
        toast.error("Couldn't get a link — try Cancel & start over.");
      } else {
        toast.success("Link refreshed. Open it to verify, then Text to customer.");
      }
      onChange();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to refresh link");
    } finally {
      setRefreshing(false);
    }
  };

  // Record the deposit as paid outside QB (Zelle/cash/check). Opens the
  // schedule gate without needing the QB link to work.
  const handleMarkPaid = async () => {
    const method = window.prompt(
      `How did ${lead.contact_name || "the customer"} pay the $${amount.toFixed(0)} deposit?`,
      "Zelle",
    );
    if (method === null) return; // canceled
    setMarkingPaid(true);
    try {
      const r = await api.markDepositPaid(lead.id, method.trim() || "offline");
      if (r.status === "already_paid") toast.info("Deposit was already marked paid.");
      else toast.success(`Deposit marked paid${r.deposit_paid_method ? ` via ${r.deposit_paid_method}` : ""}.`);
      onChange();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to mark deposit paid");
    } finally {
      setMarkingPaid(false);
    }
  };

  // Void the QB invoice + reset the deposit so admin can start fresh.
  const handleCancel = async () => {
    if (!confirm(`Cancel this deposit for ${lead.contact_name || "this customer"}? The QuickBooks invoice will be voided and you can send a new one.`)) return;
    setCanceling(true);
    try {
      const r = await api.cancelDeposit(lead.id);
      if (r.voided_in_qb) toast.success("Deposit canceled and invoice voided in QuickBooks.");
      else toast.warning("Deposit reset here, but QuickBooks didn't void the invoice — void it in QB.");
      onChange();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to cancel deposit");
    } finally {
      setCanceling(false);
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
  const barCls =
    status === "paid"    ? "border-l-emerald-500"
    : status === "pending" ? "border-l-amber-500"
    : status === "waived"  ? "border-l-slate-400"
                           : "border-l-blue-500";

  return (
    <div className={`rounded-xl border border-l-4 ${barCls} p-2.5 space-y-2 bg-muted/20`}>
      <div className="flex items-center gap-2 flex-wrap">
        <DollarSign className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-semibold">Deposit · ${amount.toFixed(0)}</span>
        <Badge className={`${badgeCls} text-[10px] h-5`}>{badgeLabel}</Badge>
        {status === "paid" && (
          <span className="text-[11px] text-emerald-700 ml-auto">
            paid{lead.deposit_paid_method ? ` via ${lead.deposit_paid_method}` : ""}{paidAt ? ` · ${timeAgo(paidAt)}` : ""}
          </span>
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
          <div className="flex items-center gap-3">
            <button
              onClick={handleMarkPaid}
              disabled={markingPaid}
              className="text-[11px] text-emerald-700 hover:text-emerald-900 underline underline-offset-2 disabled:opacity-50"
              title="Record a deposit paid outside QuickBooks (Zelle, cash, check)"
            >
              {markingPaid ? "Marking paid…" : "Mark paid (Zelle/cash)"}
            </button>
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
          <p className="text-[11px] text-muted-foreground">
            Verify with <span className="font-medium">Open</span> before you text the customer. A good link starts with{" "}
            <span className="font-mono">connect.intuit.com</span>.
          </p>
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" variant="outline" onClick={handleRefresh} disabled={refreshing || sending || canceling}>
              {refreshing ? (
                <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Refreshing…</>
              ) : (
                <><RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh link</>
              )}
            </Button>
            <Button size="sm" onClick={handleSend} disabled={sending || refreshing || canceling}>
              {sending ? (
                <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Texting…</>
              ) : (
                <><Send className="h-3.5 w-3.5 mr-1" /> Text to customer</>
              )}
            </Button>
            <Button size="sm" variant="outline" onClick={handleCancel} disabled={canceling || sending || refreshing}>
              {canceling ? (
                <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Canceling…</>
              ) : (
                <><X className="h-3.5 w-3.5 mr-1" /> Cancel &amp; start over</>
              )}
            </Button>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleMarkPaid}
              disabled={markingPaid}
              className="text-[11px] text-emerald-700 hover:text-emerald-900 underline underline-offset-2 disabled:opacity-50"
              title="Record a deposit paid outside QuickBooks (Zelle, cash, check)"
            >
              {markingPaid ? "Marking paid…" : "Mark paid (Zelle/cash)"}
            </button>
            <button
              onClick={handleWaive}
              disabled={waiving}
              className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2 disabled:opacity-50"
            >
              {waiving ? "Waiving…" : "Waive instead"}
            </button>
          </div>
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
      <div className="rounded-xl border border-l-4 border-l-slate-300 p-2.5 bg-muted/20">
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
  const barCls =
    status === "paid"    ? "border-l-emerald-500"
    : status === "pending" ? "border-l-amber-500"
                           : "border-l-blue-500";

  return (
    <div className={`rounded-xl border border-l-4 ${barCls} p-2.5 space-y-2 bg-muted/20`}>
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
  // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: raises the loading flag when this fetch's inputs change; the data itself lands asynchronously.
  useEffect(() => { load(); }, [load]);

  const unlink = async (inv: QuickbooksInvoice) => {
    try { await api.unassignQbInvoice(inv.qb_invoice_id); load(); }
    catch { toast.error("Couldn't unlink invoice"); }
  };

  const invoices = data?.invoices ?? [];
  const roll = data?.rollup;

  return (
    <Panel
      icon={CircleDollarSign}
      title="Payments (QuickBooks)"
      sub="Invoices linked to this customer"
      accent={ACCENT.emerald}
      right={
        <Button size="sm" variant="outline" onClick={() => setLinking(true)}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Link invoice
        </Button>
      }
    >
        {loading ? (
          <div className="h-12 bg-muted rounded animate-pulse" />
        ) : invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No QuickBooks invoices linked yet. Use <span className="font-medium">Link invoice</span>, or assign one from the Revenue page.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              <StatTile icon={CheckCircle2} label="Paid" accent={ACCENT.emerald}>
                <p className="font-heading text-lg font-bold tabular-nums text-emerald-700">{qbMoney(roll?.paid || 0)}</p>
              </StatTile>
              <StatTile icon={Hourglass} label="Balance" accent={ACCENT.amber}>
                <p className="font-heading text-lg font-bold tabular-nums text-amber-700">{qbMoney(roll?.balance || 0)}</p>
              </StatTile>
              <StatTile icon={Receipt} label="Total" accent={ACCENT.slate} hint={`${roll?.count} invoice${roll?.count === 1 ? "" : "s"}`}>
                <p className="font-heading text-lg font-bold tabular-nums">{qbMoney(roll?.total || 0)}</p>
              </StatTile>
            </div>
            <div className="rounded-xl border divide-y">
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
      {linking && (
        <LinkInvoiceModal
          leadId={leadId}
          leadName={leadName}
          onClose={() => setLinking(false)}
          onLinked={() => { setLinking(false); load(); }}
        />
      )}
    </Panel>
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
  // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: raises the loading flag when this fetch's inputs change; the data itself lands asynchronously.
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: raises the loading flag when this fetch's inputs change; the data itself lands asynchronously.
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
    <Panel
      icon={Route}
      title="Route-stack — nearby jobs"
      sub="Pitch a date we're already in the area"
      accent={ACCENT.cyan}
      right={<Pill accent={ACCENT.cyan}>Next {data?.window_days ?? 14} days</Pill>}
    >
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
          <div className="rounded-xl border border-emerald-300 bg-gradient-to-r from-emerald-50 to-teal-50 p-2.5">
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
    </Panel>
  );
}

function NearbyJobRow({ job }: { job: NearbyJob }) {
  return (
    <li className="text-xs bg-card border rounded-lg px-2.5 py-1.5 flex items-baseline gap-2 flex-wrap">
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
  const now = useNow();
  if (viewCount <= 0 && !firstViewedAt) {
    return <Badge className="text-xs bg-slate-200 text-slate-700">Proposal not viewed</Badge>;
  }
  const ts = lastViewedAt || firstViewedAt;
  let hot = false;
  if (ts) {
    const minutesAgo = (now - new Date(ts).getTime()) / 60000;
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
