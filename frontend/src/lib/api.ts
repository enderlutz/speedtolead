import { toast } from "sonner";

const BASE = import.meta.env.VITE_API_URL || "";

// --- Training mode mutation guard ----------------------------------------
// When the rep flips on Training Mode (see lib/training_mode_context.tsx),
// we read the localStorage flag synchronously from inside request() and
// reject any call that would contact a real customer (SMS, payment link,
// estimate-approve, deposit invoice, immediate follow-up send). Safer than
// touching every send button individually.
//
// Hybrid posture: block customer-facing sends, allow internal mutations
// (notes, drafts, status updates) because reps still need to navigate
// real lead detail pages while practicing.

const TRAINING_BLOCKED_PATTERNS: { method: string; pattern: RegExp; label: string }[] = [
  // Estimate approve sends customer SMS + email + PDF
  { method: "POST", pattern: /\/api\/estimates\/[^/]+\/approve$/, label: "Approve & Send" },
  { method: "POST", pattern: /\/api\/estimates\/[^/]+\/request-review$/, label: "Send Review Link" },
  // Deposit + invoice SMS sends payment link to the customer
  { method: "POST", pattern: /\/api\/quickbooks\/leads\/[^/]+\/send-deposit-invoice$/, label: "Send Deposit Invoice" },
  { method: "POST", pattern: /\/api\/quickbooks\/jobs\/[^/]+\/send-invoice-sms$/, label: "Send Invoice SMS" },
  // Follow-up engine immediate send fires SMS/iMessage
  { method: "POST", pattern: /\/api\/followups\/runs\/[^/]+\/send-now$/, label: "Send Follow-up Now" },
];

function isTrainingModeOn(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem("at_training_mode") === "1";
  } catch {
    return false;
  }
}

function trainingBlocks(path: string, method: string): string | null {
  const m = (method || "GET").toUpperCase();
  for (const { method: bm, pattern, label } of TRAINING_BLOCKED_PATTERNS) {
    if (bm === m && pattern.test(path)) return label;
  }
  return null;
}

// --- Auth helpers ---

function getToken(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)at_auth=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function setToken(token: string) {
  document.cookie = `at_auth=${encodeURIComponent(token)}; path=/; max-age=604800; SameSite=Lax`;
}

export function clearToken() {
  document.cookie = "at_auth=; max-age=0; path=/";
}

export function getCurrentUser(): { sub: string; name: string; role: string; employee_id?: string } | null {
  const token = getToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function isAuthenticated(): boolean {
  return getCurrentUser() !== null;
}

// --- Types ---

export interface Lead {
  id: string;
  ghl_contact_id: string;
  ghl_location_id: string;
  location_label: string;
  contact_name: string;
  contact_phone: string;
  contact_email: string;
  address: string;
  zip_code: string;
  service_type: string;
  status: string;
  kanban_column: string;
  priority: string;
  pipeline_version: "v1" | "v2";
  ghl_pipeline_stage_id: string;
  ghl_opportunity_id: string;
  form_data: Record<string, string>;
  customer_responded: boolean;
  customer_response_text: string;
  precall_done: boolean;
  viewed_at: string | null;
  proposal_viewed_at: string | null;
  proposal_last_viewed_at: string | null;
  proposal_view_count: number;
  ghl_created_at: string;
  dashboard_synced_at: string;
  created_at: string;
  updated_at: string;
  measurement_uploaded?: boolean;
  measurement_filename?: string;
  measurement_uploaded_at?: string | null;
  measurement_uploaded_by?: string;
  lead_source?: LeadSource;
  /** Deposit flow ($250 down to schedule). Empty when not started.
   *  States: "" | "pending" | "paid" | "waived" */
  deposit_status?: string;
  deposit_amount?: number;
  deposit_invoice_sent_at?: string | null;
  deposit_paid_at?: string | null;
  /** Hosted QB payment-link URL the customer taps to pay. */
  deposit_payment_link?: string;
  deposit_qb_invoice_id?: string;
  /** Exterior painting AI estimate fields. Populated only for leads
   *  where the rep clicked "Send capture link" or ran the estimator. */
  exterior_capture_token?: string;
  exterior_photos?: ExteriorPhoto[];
  exterior_estimate?: ExteriorEstimate;
  exterior_activity?: ExteriorActivity;
}

export type LeadSource = "ad" | "referral" | "google_my_business" | "repeat_customer" | "yard_sign" | "other";

export const LEAD_SOURCE_OPTIONS: { value: LeadSource; label: string }[] = [
  { value: "ad", label: "Ad (Facebook / Google / etc.)" },
  { value: "referral", label: "Referral" },
  { value: "google_my_business", label: "Google Business" },
  { value: "repeat_customer", label: "Repeat customer" },
  { value: "yard_sign", label: "Yard sign" },
  { value: "other", label: "Other" },
];

export interface LeadDetail extends Lead {
  estimates: EstimateDetail[];
  estimate?: EstimateDetail;
}

export interface EstimateDetail {
  id: string;
  lead_id: string;
  service_type: string;
  status: string;
  inputs: Record<string, unknown>;
  breakdown: BreakdownItem[];
  estimate_low: number;
  estimate_high: number;
  tiers: { essential: number; signature: number; legacy: number };
  approval_status: string;
  approval_reason: string;
  approval_token: string | null;
  created_at: string;
  sent_at: string | null;
  proposal_url?: string;
  proposal_token?: string;
  precall_done?: boolean;
  precall_at?: string | null;
  precall_notes?: string;
  label?: string;
}

export interface EstimateHistoryItem extends EstimateDetail {
  estimate_number: number;
}

export interface BreakdownItem {
  label: string;
  value: number;
  note?: string;
  rate?: number;
  qty?: number;
}

// --- Call Recording types ---
/** Sprint 2 T2.A — Call disposition enum. Server-side enforced. */
export type CallDispositionOutcome =
  | "closed"
  | "objection_price"
  | "objection_timing"
  | "no_answer"
  | "voicemail"
  | "callback"
  | "other";

export interface CallDispositionEntry {
  id: string;
  lead_id: string;
  outcome: CallDispositionOutcome;
  notes: string;
  disposed_at: string;
  disposed_by: string;
  disposed_by_sub: string;
  callback_at: string | null;
}

/** Sprint 2 T2.E — Follow-up rule engine output. Surfaces on the lead
 *  detail badge + boosts the call list panel sort order. */
export type FollowUpFlagKind = "hot" | "callback_due" | "warm" | "stale" | "cold";
export interface FollowUpFlag {
  kind: FollowUpFlagKind;
  label: string;
  priority_boost: number;
  since: string;
}

/** Sprint 3 T3.B — Route-stack candidate. One scheduled job that
 *  would share a route with this lead if booked. */
export interface NearbyJob {
  job_id: string;
  customer_name: string;
  address: string;
  zip_code: string;
  job_date: string;         // YYYY-MM-DD
  arrival_time: string;     // HH:MM
  lat: number;
  lng: number;
  /** Miles to the target lead. null when one side has no coords (same-ZIP
   *  rows can still surface this way — ZIP match alone is enough). */
  distance_miles: number | null;
  same_zip: boolean;
}

export interface NearbyJobsResponse {
  target: {
    lead_id: string;
    zip_code: string;
    lat: number;
    lng: number;
    address: string;
  };
  window_days: number;
  nearby_jobs: NearbyJob[];
}

export interface CallRecordingEntry {
  id: string;
  lead_id: string | null;
  contact_name?: string;
  duration_seconds: number;
  call_direction: string;
  caller_name: string;
  recorded_by?: string;
  status: string;
  is_archived?: boolean;
  archived_at?: string | null;
  is_favorite?: boolean;
  notes?: string;
  transcript_preview?: string;
  created_at: string;
  transcribed_at: string | null;
  analyzed_at: string | null;
  has_recording: boolean;
  transcript?: {
    id: string;
    full_text: string;
    segments: { speaker: number; text: string; start: number; end: number }[];
    speaker_map: Record<string, string>;
    confidence: number;
  } | null;
  analysis?: {
    id: string;
    summary: string;
    summary_one_line?: string;
    stage_evaluation?: { stage: string; status: "passed" | "missed" | "skipped_okay"; evidence: string; feedback?: string }[];
    boundary_violations?: { type: string; evidence: string; severity: "high" | "medium" | "low" }[];
    what_went_well?: string;
    next_action?: string;
    coaching_tips: string[];
    sentiment: string;
    customer_sentiment: string;
    objections: string[];
    key_topics: string[];
    customer_data_extracted: Record<string, unknown>;
    call_score: number;
    close_likelihood: string;
  } | null;
}

export interface CallReview {
  id: string;
  recording_id: string;
  lead_id: string | null;
  reviewer_user_id: string;
  reviewer_name: string;
  text: string;
  has_audio: boolean;
  audio_mime: string;
  created_at: string;
}

export interface CallPatterns {
  total_calls: number;
  closed_calls: number;
  lost_calls: number;
  avg_score_closed: number;
  avg_score_lost: number;
  avg_duration_closed: number;
  avg_duration_lost: number;
  top_objections: [string, number][];
  top_topics_closed: [string, number][];
  top_coaching_tips: [string, number][];
  sentiment_closed: Record<string, number>;
  sentiment_lost: Record<string, number>;
}

export interface ChatbotMessage {
  id: string;
  direction: "user" | "assistant" | "human";
  content: string;
  is_escalated?: boolean;
  escalation_reason?: string;
  created_at: string;
}

export interface ChatbotPublicConfig {
  enabled: boolean;
  bot_name: string;
  has_profile_picture: boolean;
  google_review_link: string;
  google_review_stars: number;
  google_review_count: number;
  preset_questions: ({ question: string; answer: string } | null)[];
  test_only_lead_ids: string[];
}

export interface ChatbotConfig {
  enabled: boolean;
  bot_name: string;
  has_profile_picture: boolean;
  google_review_link: string;
  google_review_stars: number;
  google_review_count: number;
  preset_q1: string;
  preset_a1: string;
  preset_q2: string;
  preset_a2: string;
  preset_q3: string;
  preset_a3: string;
  system_prompt: string;
  test_only_lead_ids: string;
}

export interface KPIs {
  leads_this_month: number;
  leads_last_month: number;
  leads_change_pct: number;
  estimates_sent: number;
  estimates_sent_last_month: number;
  estimates_sent_change_pct: number;
  close_rate: number;
  close_rate_last_month: number;
  close_rate_change: number;
  revenue_pipeline: number;
  avg_response_minutes: number;
  goal_target: number;
  goal_current: number;
  goal_progress_pct: number;
}

export interface FunnelData {
  total_leads: number;
  estimated: number;
  sent: number;
  estimated_rate: number;
  sent_rate: number;
}

export interface WeeklyCloseRate {
  week_start: string;
  leads: number;
  sent: number;
  close_rate: number;
}

export interface LocationStats {
  [key: string]: { leads: number; sent: number; close_rate: number };
}

export interface SentLogEntry {
  id: string;
  lead_id: string;
  contact_name: string;
  contact_phone: string;
  address: string;
  zip_code: string;
  location_label: string;
  service_type: string;
  sent_at: string;
  created_at: string;
  sqft: number;
  zone: string;
  zone_surcharge: number;
  height: number;
  age_bracket: string;
  size_surcharge_applied: boolean;
  approval_status: string;
  approval_reason: string;
  tiers: { essential: number; signature: number; legacy: number };
  breakdown: BreakdownItem[];
  estimate_low: number;
  estimate_high: number;
  linear_feet: string;
  fence_height: string;
  fence_age: string;
  priority: string;
  closed_tier: string | null;
  closed_at: string | null;
  closed_price: number | null;
  closed_actual_sqft: number | null;
  closed_upsell_per_sqft: number | null;
  closed_discounts: { amount: number; type: "dollar" | "percent"; reason: string }[];
  closed_upsell_notes: string;
  closed_notes: string;
  precall_done: boolean;
  precall_at: string | null;
  precall_notes: string;
  time_to_call_minutes: number | null;
  time_to_send_minutes: number | null;
  time_to_view_minutes: number | null;
  proposal_viewed: boolean;
}

export interface PendingEstimate extends EstimateDetail {
  contact_name: string;
  contact_phone: string;
  address: string;
  location_label: string;
  kanban_column: string;
  priority: string;
  pipeline_version: "v1" | "v2";
}

export interface MessageEntry {
  id: string;
  direction: string;
  body: string;
  message_type: string;
  created_at: string;
}

export interface ActivityEvent {
  id: string;
  lead_id: string | null;
  event_type: string;
  detail: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ProposalData {
  token: string;
  lead_id: string;
  status: string;
  customer_name: string;
  address: string;
  service_type: string;
  tiers: { essential: number; signature: number; legacy: number };
  breakdown: BreakdownItem[];
  pricing_includes: string[];
  has_pdf: boolean;
  page_count: number;
  // Absolute URLs (Supabase Storage CDN) or relative paths starting with
  // "/api/..." that the frontend prepends BASE to. Length matches page_count.
  page_urls?: string[];
  created_at: string;
  correction_pending: boolean;
  correction_requests: CorrectionRequest[];
}

export interface CorrectionRequest {
  id: string;
  estimate_id: string;
  lead_id: string;
  text: string;
  requested_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  escalated_at: string | null;
  status: "pending" | "resolved";
  contact_name?: string;
  contact_phone?: string;
  address?: string;
}

export interface QuickApproveInfo {
  estimate_id: string;
  contact_name: string;
  address: string;
  location_label: string;
  approval_status: string;
  approval_reason: string;
  tiers: { essential: number; signature: number; legacy: number };
  sqft: number;
  zone: string;
}

// --- API client ---

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  // Training-mode mutation guard — fail fast before hitting the network
  // for customer-contacting endpoints.
  if (isTrainingModeOn()) {
    const blocked = trainingBlocks(path, options?.method || "GET");
    if (blocked) {
      toast.error(`Disabled in training mode — would have sent "${blocked}" to a real customer.`);
      throw new Error(`Blocked in training mode: ${blocked}`);
    }
  }

  const token = getToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    headers: { ...headers, ...(options?.headers || {}) },
    ...options,
  });
  if (res.status === 401) {
    clearToken();
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

export const api = {
  // Auth
  login: (username: string, password: string) =>
    request<{ token: string; user: { username: string; name: string; role: string } }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  getMe: () => request<{ sub: string; name: string; role: string; employee_id?: string }>("/api/auth/me"),

  // Leads
  getLeads: (params?: Record<string, string>) => {
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return request<Lead[]>(`/api/leads${qs}`);
  },
  getArchivedLeads: (search?: string, pipeline_version?: string) => {
    const params = new URLSearchParams({ status: "archived" });
    if (search) params.set("search", search);
    if (pipeline_version) params.set("pipeline_version", pipeline_version);
    return request<Lead[]>(`/api/leads?${params.toString()}`);
  },
  getLead: (id: string) => request<LeadDetail>(`/api/leads/${id}`),
  updateColumn: (id: string, kanban_column: string) =>
    request<Lead>(`/api/leads/${id}/column`, {
      method: "PUT",
      body: JSON.stringify({ kanban_column }),
    }),
  updateStage: (id: string, stage_id: string) =>
    request<Lead & { ghl_sync_status?: "synced" | "deferred_rate_limit" | "failed" | "skipped_no_opportunity" }>(`/api/leads/${id}/stage`, {
      method: "PUT",
      body: JSON.stringify({ stage_id }),
    }),
  exportToV2: (id: string, stage_id?: string) =>
    request<Lead>(`/api/leads/${id}/export-to-v2`, {
      method: "POST",
      body: JSON.stringify({ stage_id: stage_id || null }),
    }),
  bulkExportToV2: (lead_ids: string[], stage_id?: string) =>
    request<{ succeeded: string[]; failed: { lead_id: string; reason: string; name?: string }[]; total: number }>(
      `/api/leads/export-to-v2/bulk`,
      { method: "POST", body: JSON.stringify({ lead_ids, stage_id: stage_id || null }) }
    ),
  updateFormData: (id: string, form_data: Record<string, unknown>, estimate_id?: string) =>
    request<LeadDetail>(`/api/leads/${id}/form-data`, {
      method: "PUT",
      body: JSON.stringify(estimate_id ? { form_data, estimate_id } : { form_data }),
    }),
  /** Create a new pending Estimate on this lead (multi-estimate flow). Inputs
   * are seeded from the most-recent estimate so the VA tweaks instead of
   * starts blank. */
  createNewEstimate: (leadId: string) =>
    request<EstimateDetail>(`/api/leads/${leadId}/estimates/new`, { method: "POST" }),
  updateContact: (id: string, data: Record<string, string>) =>
    request<Lead>(`/api/leads/${id}/contact`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  backfillTags: () =>
    request<{ checked: number; archived: number; total_leads: number }>("/api/leads/backfill-tags", { method: "POST" }),
  askForAddress: (id: string) =>
    request<{ status: string; sms_sent: boolean }>(`/api/leads/${id}/ask-address`, { method: "POST" }),
  newBuild: (id: string) =>
    request<{ status: string; sms_sent: boolean }>(`/api/leads/${id}/new-build`, { method: "POST" }),
  archiveLead: (id: string) =>
    request<Lead>(`/api/leads/${id}/archive`, { method: "POST" }),
  unarchiveLead: (id: string) =>
    request<Lead>(`/api/leads/${id}/unarchive`, { method: "POST" }),
  checkResponse: (id: string) =>
    request<{ new_count: number; messages: { direction: string; body: string }[] }>(
      `/api/leads/${id}/check-response`, { method: "POST" }
    ),
  getMessages: (id: string) => request<MessageEntry[]>(`/api/leads/${id}/messages`),

  // Estimates
  getEstimates: () => request<EstimateDetail[]>("/api/estimates"),
  getSentLog: () => request<SentLogEntry[]>("/api/estimates/sent-log"),
  getPendingAction: (pipelineVersion?: string) => {
    const qs = pipelineVersion ? `?pipeline_version=${pipelineVersion}` : "";
    return request<PendingEstimate[]>(`/api/estimates/pending-action${qs}`);
  },
  approveEstimate: (id: string, opts?: { scheduledSendAt?: string; alsoEmail?: boolean; sendSms?: boolean; applyTag?: boolean }) => {
    const body: Record<string, unknown> = {};
    if (opts?.scheduledSendAt) body.scheduled_send_at = opts.scheduledSendAt;
    if (opts?.alsoEmail) body.also_email = true;
    // Only include send_sms when caller wants to flip it off — backend
    // defaults to true so omitting it preserves the legacy SMS-only behavior.
    if (opts && opts.sendSms === false) body.send_sms = false;
    // Same pattern for apply_tag: only send when caller wants to flip OFF
    // the GHL "estimate sent" tag (which would otherwise trigger P1 / P04
    // automations). Default behavior unchanged.
    if (opts && opts.applyTag === false) body.apply_tag = false;
    return request<EstimateDetail & { proposal_url?: string; sms_sent?: boolean; sms_scheduled?: boolean; scheduled_send_at?: string }>(
      `/api/estimates/${id}/approve`,
      {
        method: "POST",
        body: Object.keys(body).length ? JSON.stringify(body) : undefined,
      }
    );
  },
  saveEstimatePdf: (id: string, fields: Record<string, unknown>[]) =>
    request<EstimateDetail>(`/api/estimates/${id}/save-pdf`, {
      method: "POST",
      body: JSON.stringify({ fields, send: false }),
    }),
  saveAndSendEstimate: (id: string, fields: Record<string, unknown>[], opts?: { alsoEmail?: boolean; sendSms?: boolean }) =>
    request<EstimateDetail & { proposal_url?: string }>(`/api/estimates/${id}/save-pdf`, {
      method: "POST",
      body: JSON.stringify({
        fields,
        send: true,
        send_sms: opts?.sendSms !== false,
        also_email: !!opts?.alsoEmail,
      }),
    }),
  overrideBreakdown: (id: string, items: BreakdownItem[]) =>
    request<EstimateDetail>(`/api/estimates/${id}/breakdown`, {
      method: "PUT",
      body: JSON.stringify({ items }),
    }),
  closeEstimate: (id: string, data: {
    tier: string;
    closed_at: string;
    closed_price?: number;
    actual_sqft?: number;
    upsell_per_sqft?: number;
    discounts?: { amount: number; type: string; reason: string }[];
    upsell_notes?: string;
    close_notes?: string;
  }) =>
    request<EstimateDetail>(`/api/estimates/${id}/close`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  logPrecall: (id: string, done: boolean, notes?: string) =>
    request<EstimateDetail>(`/api/estimates/${id}/precall`, {
      method: "POST",
      body: JSON.stringify({ done, notes }),
    }),
  reopenEstimate: (id: string) =>
    request<EstimateDetail>(`/api/estimates/${id}/reopen`, { method: "POST" }),
  cancelEstimate: (id: string) =>
    request<EstimateDetail>(`/api/estimates/${id}/cancel`, { method: "POST" }),
  requestReview: (id: string) =>
    request<{ status: string; approval_token: string }>(`/api/estimates/${id}/request-review`, { method: "POST" }),
  getEstimatePdfUrl: (id: string) => `${BASE}/api/estimates/${id}/pdf`,

  // Estimate history (sent estimates only) + freeform local label
  getEstimateHistory: (leadId: string) =>
    request<{ history: EstimateHistoryItem[] }>(`/api/leads/${leadId}/estimate-history`),
  updateEstimateLabel: (id: string, label: string) =>
    request<EstimateDetail>(`/api/estimates/${id}/label`, {
      method: "PUT",
      body: JSON.stringify({ label }),
    }),

  // Measurement screenshot (Google Maps) — single image per lead
  uploadMeasurement: async (leadId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const token = getToken();
    const res = await fetch(`${BASE}/api/leads/${leadId}/measurement`, {
      method: "POST",
      body: fd,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error((await res.text()) || "Measurement upload failed");
    return res.json() as Promise<{
      measurement_uploaded: boolean;
      measurement_filename: string;
      measurement_uploaded_at: string;
      measurement_uploaded_by: string;
    }>;
  },
  deleteMeasurement: (leadId: string) =>
    request<{ status: string }>(`/api/leads/${leadId}/measurement`, { method: "DELETE" }),
  /** Fetch the measurement image with auth and return an object URL the
   * caller is responsible for revoking. Returns null when there's no image
   * (or auth fails). */
  fetchMeasurementBlobUrl: async (leadId: string): Promise<string | null> => {
    const token = getToken();
    const res = await fetch(`${BASE}/api/leads/${leadId}/measurement`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  },

  previewEstimatePdf: (id: string, fieldOverrides?: Record<string, unknown>, extraFields?: Record<string, unknown>[]) =>
    request<{ pages: { page_num: number; image_data: string }[] }>(`/api/estimates/${id}/preview-pdf`, {
      method: "POST",
      body: JSON.stringify({ field_overrides: fieldOverrides, extra_fields: extraFields }),
    }),
  approveWithOverrides: (
    id: string,
    fieldOverrides?: Record<string, unknown>,
    extraFields?: Record<string, unknown>[],
    opts?: { alsoEmail?: boolean; sendSms?: boolean },
  ) =>
    request<EstimateDetail & { proposal_url?: string }>(`/api/estimates/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({
        field_overrides: fieldOverrides,
        extra_fields: extraFields,
        send_sms: opts?.sendSms !== false,
        also_email: !!opts?.alsoEmail,
      }),
    }),

  // Quick approve (public)
  getQuickApproveInfo: (token: string) => request<QuickApproveInfo>(`/api/estimates/quick-approve/${token}/info`),
  quickApprove: (token: string) =>
    request<EstimateDetail>(`/api/estimates/quick-approve/${token}`, { method: "POST" }),

  // Proposals (public)
  getProposal: (token: string) => request<ProposalData>(`/api/proposal/${token}`),
  getProposalPdfUrl: (token: string) => `${BASE}/api/proposal/${token}/pdf`,
  getProposalPageUrl: (token: string, page: number) => `${BASE}/api/proposal/${token}/page/${page}`,
  requestProposalCorrection: (token: string, text: string) =>
    request<{ status: string; request_id: string; requested_at: string }>(
      `/api/proposal/${token}/request-correction`,
      { method: "POST", body: JSON.stringify({ text }) }
    ),

  // Correction requests (internal dashboard)
  listCorrectionRequests: (status: "pending" | "resolved" | "all" = "pending") =>
    request<CorrectionRequest[]>(`/api/correction-requests?status=${status}`),
  resolveCorrectionRequest: (id: string) =>
    request<CorrectionRequest>(`/api/correction-requests/${id}/resolve`, { method: "POST" }),

  // Analytics
  getKPIs: (pipelineVersion?: string) => {
    const qs = pipelineVersion ? `?pipeline_version=${pipelineVersion}` : "";
    return request<KPIs>(`/api/analytics/kpis${qs}`);
  },
  getFunnel: (pv?: string) => request<FunnelData>(`/api/analytics/funnel${pv ? `?pipeline_version=${pv}` : ""}`),
  getWeeklyCloseRate: (pv?: string) => request<WeeklyCloseRate[]>(`/api/analytics/weekly-close-rate${pv ? `?pipeline_version=${pv}` : ""}`),
  getByLocation: (pv?: string) => request<LocationStats>(`/api/analytics/by-location${pv ? `?pipeline_version=${pv}` : ""}`),
  getSpeedMetrics: (pv?: string) => request<Record<string, unknown>>(`/api/analytics/speed${pv ? `?pipeline_version=${pv}` : ""}`),
  getClosePatterns: (pv?: string) => request<Record<string, unknown>>(`/api/analytics/close-patterns${pv ? `?pipeline_version=${pv}` : ""}`),
  getCohorts: (pv?: string) => request<Record<string, unknown>[]>(`/api/analytics/cohorts${pv ? `?pipeline_version=${pv}` : ""}`),
  getRevenueInsights: (pv?: string) => request<Record<string, unknown>>(`/api/analytics/revenue-insights${pv ? `?pipeline_version=${pv}` : ""}`),
  getDealStats: (pv?: string) => request<Record<string, unknown>>(`/api/analytics/deal-stats${pv ? `?pipeline_version=${pv}` : ""}`),
  getTimingAnalytics: (pv?: string, opts?: { start_date?: string; end_date?: string }) => {
    const params = new URLSearchParams();
    if (pv) params.set("pipeline_version", pv);
    if (opts?.start_date) params.set("start_date", opts.start_date);
    if (opts?.end_date) params.set("end_date", opts.end_date);
    const qs = params.toString();
    return request<Record<string, unknown>>(`/api/analytics/timing${qs ? `?${qs}` : ""}`);
  },

  // AI Fence Estimation
  analyzeFence: (address: string, force?: boolean) =>
    request<{
      id: string;
      address: string;
      lat: number;
      lng: number;
      zip_code: string;
      images?: { zoom: number; label: string; base64: string }[];
      analysis: {
        property_description?: string;
        fence_detected?: boolean;
        fence_material?: string;
        fence_color?: string;
        segments: { label: string; side: string; length_ft: number; confidence: string; notes: string }[];
        total_linear_feet: number;
        overall_confidence: string;
        obstructions?: string;
        measurement_notes?: string;
        sanity_warning?: string;
        input_tokens?: number;
        output_tokens?: number;
      };
      total_linear_feet: number;
      overall_confidence: string;
      cached: boolean;
      created_at: string;
    }>("/api/fence-ai/analyze", {
      method: "POST",
      body: JSON.stringify({ address, force: force || false }),
    }),
  applyFenceMeasurement: (leadId: string, linearFeet: number) =>
    request<{ status: string; tiers: Record<string, number>; approval_status: string }>(
      `/api/fence-ai/apply/${leadId}`,
      { method: "POST", body: JSON.stringify({ linear_feet: linearFeet }) }
    ),
  getFenceAiHistory: () =>
    request<{ id: string; address: string; total_linear_feet: number; overall_confidence: string; created_at: string }[]>(
      "/api/fence-ai/history"
    ),

  // Notifications
  getRecentActivity: (limit?: number, pipelineVersion?: string) => {
    const params = new URLSearchParams();
    if (limit) params.set("limit", String(limit));
    if (pipelineVersion) params.set("pipeline_version", pipelineVersion);
    const qs = params.toString();
    return request<ActivityEvent[]>(`/api/notifications/recent${qs ? `?${qs}` : ""}`);
  },
  getNotificationCount: () => request<{ count: number }>("/api/notifications/count"),

  // Settings
  getGhlPipelines: () => request<Record<string, unknown[]>>("/api/settings/ghl-pipelines"),
  getGhlStageDiff: () => request<GhlStageDiff>("/api/settings/ghl-stage-diff"),
  getCallList: (nearZip?: string) => {
    const qs = nearZip && nearZip.trim() ? `?near_zip=${encodeURIComponent(nearZip.trim())}` : "";
    return request<CallListResponse>(`/api/call-list${qs}`);
  },
  // 2026-06-08 — one-shot Sterling backfill the owner asked for. Kicks
  // off a BackgroundTask; UI polls /status until running flips to false.
  startSterlingBackfill: (lookbackDays: number = 90) =>
    request<{ status: string; lookback_days?: number; sleep_between_leads?: number; message: string }>(
      `/api/calls/backfill-sterling?lookback_days=${lookbackDays}`,
      { method: "POST" },
    ),
  getSterlingBackfillStatus: () =>
    request<SterlingBackfillStatus>("/api/calls/backfill-sterling/status"),
  markCalled: (leadId: string) =>
    request<CallTouchResult>(`/api/call-list/${leadId}/touch`, { method: "POST" }),
  startOppValueBackfill: () =>
    request<OppValueBackfillStartResult>("/api/settings/backfill-opportunity-values", { method: "POST" }),
  getOppValueBackfillStatus: () =>
    request<OppValueBackfillStatus>("/api/settings/backfill-opportunity-values/status"),
  getGhlFields: () => request<Record<string, unknown[]>>("/api/settings/ghl-fields"),
  syncGhlFields: () => request<{ synced: number; fields: { ghl_field_id: string; ghl_field_name: string; ghl_field_key: string; field_type: string; options: string[]; location: string }[] }>("/api/settings/ghl-fields/sync", { method: "POST" }),
  getFieldMappings: () => request<{ mappings: { ghl_field_id: string; ghl_field_key: string; ghl_field_name: string; our_field_name: string }[]; our_field_options: { value: string; label: string }[] }>("/api/settings/ghl-fields/mappings"),
  updateFieldMapping: (ghlFieldId: string, ourFieldName: string) => request("/api/settings/ghl-fields/mapping", { method: "PUT", body: JSON.stringify({ ghl_field_id: ghlFieldId, our_field_name: ourFieldName }) }),
  getPricing: () => request<Record<string, unknown>>("/api/settings/pricing"),
  updatePricing: (service_type: string, config: Record<string, unknown>) =>
    request("/api/settings/pricing", {
      method: "PUT",
      body: JSON.stringify({ service_type, config }),
    }),
  // Promotion / slashed-price control. Markup % applied on top of the
  // actual tier price to render the strikethrough "original" on proposals.
  getPromotionMarkup: () =>
    request<{ markup_percent: number }>("/api/settings/promotion"),
  setPromotionMarkup: (markup_percent: number) =>
    request<{ markup_percent: number }>("/api/settings/promotion", {
      method: "PUT",
      body: JSON.stringify({ markup_percent }),
    }),
  getStats: () => request<{ total_leads: number; total_estimates: number; sent_estimates: number }>("/api/settings/stats"),

  // PDF Templates
  uploadPdfTemplate: async (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    const token = getToken();
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${BASE}/api/pdf-templates/upload`, { method: "POST", body: formData, headers });
    if (!res.ok) throw new Error("Upload failed");
    return res.json();
  },
  getPdfTemplate: () => request<{ id: string; filename: string; page_count: number; field_map: Record<string, unknown> }>("/api/pdf-templates/current"),
  getTemplatePageUrl: (pageNum: number, bust?: string) => `${BASE}/api/pdf-templates/page/${pageNum}${bust ? `?v=${bust}` : ""}`,
  updateFieldMap: (field_map: Record<string, unknown>) =>
    request("/api/pdf-templates/field-map", {
      method: "PUT",
      body: JSON.stringify({ field_map }),
    }),

  // --- Chatbot ---
  getChatbotConfigPublic: () => request<ChatbotPublicConfig>("/api/chatbot/config/public"),
  getChatbotConfig: () => request<ChatbotConfig>("/api/chatbot/config"),
  updateChatbotConfig: (config: Partial<ChatbotConfig>) =>
    request("/api/chatbot/config", { method: "PUT", body: JSON.stringify(config) }),
  getChatbotProfilePictureUrl: () => `${BASE}/api/chatbot/profile-picture`,
  uploadChatbotProfilePicture: async (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    const token = localStorage.getItem("at_token");
    const res = await fetch(`${BASE}/api/chatbot/profile-picture`, {
      method: "POST",
      body: formData,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error("Upload failed");
    return res.json();
  },
  sendChatbotMessage: (token: string, message: string) =>
    request<{ response: string; message_id: string; escalated: boolean }>("/api/chatbot/message", {
      method: "POST",
      body: JSON.stringify({ token, message }),
    }),
  getChatbotMessages: (token: string) => request<ChatbotMessage[]>(`/api/chatbot/messages/${token}`),
  getChatbotLeadMessages: (leadId: string) => request<ChatbotMessage[]>(`/api/chatbot/lead-messages/${leadId}`),
  chatbotReply: (leadId: string, message: string) =>
    request<{ id: string; status: string; nudge_scheduled: boolean }>("/api/chatbot/reply", {
      method: "POST", body: JSON.stringify({ lead_id: leadId, message }),
    }),
  getChatbotSummary: (leadId: string) =>
    request<{ summary: string }>(`/api/chatbot/summary/${leadId}`),
  chatbotHeartbeat: (token: string) =>
    request<{ status: string }>(`/api/chatbot/heartbeat/${token}`, { method: "POST" }),

  clearLeadBadge: (leadId: string, badge: "asked_for_address" | "new_build" | "not_confident") =>
    request<{ status: string }>(`/api/leads/${leadId}/clear-badge`, {
      method: "POST",
      body: JSON.stringify({ badge }),
    }),

  getDeclineReasonPresets: () =>
    request<{ key: string; label: string }[]>("/api/lead-decline-reason-presets"),
  backfillDashboardLinkNotes: (pipelineVersion = "v2") =>
    request<{ total: number; succeeded: number; failed: number; skipped: number }>(
      `/api/leads/backfill-dashboard-link-notes?pipeline_version=${pipelineVersion}`,
      { method: "POST" },
    ),
  resyncStageFromGHL: (leadId: string) =>
    request<{ status: string; changed: boolean; stage_id: string; previous_stage_id?: string }>(
      `/api/leads/${leadId}/resync-stage`,
      { method: "POST" },
    ),
  setDeclineReasons: (leadId: string, reasons: string[], otherText: string) =>
    request<{ status: string; reasons: string[] }>(`/api/leads/${leadId}/decline-reasons`, {
      method: "POST",
      body: JSON.stringify({ reasons, other_text: otherText }),
    }),
  skipDeclineReasons: (leadId: string) =>
    request<{ status: string }>(`/api/leads/${leadId}/decline-skipped`, { method: "POST" }),
  getDeclineReasonsAnalytics: (days = 90, pipelineVersion?: string) => {
    const params = new URLSearchParams({ days: String(days) });
    if (pipelineVersion) params.set("pipeline_version", pipelineVersion);
    return request<{
      total_declined: number;
      days: number;
      breakdown: { key: string; label: string; count: number; leads: { lead_id: string; contact_name: string; address: string; declined_at: string; rank: number | null; other_text: string }[] }[];
    }>(`/api/analytics/decline-reasons?${params}`);
  },

  // --- Call Recordings ---
  getLeadCalls: (leadId: string, includeArchived = false) =>
    request<CallRecordingEntry[]>(`/api/calls/lead/${leadId}?include_archived=${includeArchived}`),
  getCall: (recordingId: string) => request<CallRecordingEntry>(`/api/calls/${recordingId}`),
  getAllCalls: (opts: { limit?: number; offset?: number; archived?: boolean; favoritesOnly?: boolean } = {}) => {
    const { limit = 50, offset = 0, archived = false, favoritesOnly = false } = opts;
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      archived: String(archived),
      favorites_only: String(favoritesOnly),
    });
    return request<{ calls: CallRecordingEntry[]; total: number }>(`/api/calls/all?${params}`);
  },
  getCallStorage: () => request<{ total_bytes: number; active_count: number; archived_count: number }>("/api/calls/storage"),
  getCallAudioUrl: (recordingId: string) => `${BASE}/api/calls/${recordingId}/audio`,
  getCallPatterns: () => request<CallPatterns>("/api/calls/patterns"),
  reanalyzeCall: (recordingId: string) =>
    request<{ status: string }>(`/api/calls/${recordingId}/analyze`, { method: "POST" }),
  archiveCall: (recordingId: string) =>
    request<{ status: string }>(`/api/calls/${recordingId}/archive`, { method: "POST" }),
  unarchiveCall: (recordingId: string) =>
    request<{ status: string }>(`/api/calls/${recordingId}/unarchive`, { method: "POST" }),
  setCallFavorite: (recordingId: string, favorite: boolean) =>
    request<{ is_favorite: boolean }>(`/api/calls/${recordingId}/favorite`, {
      method: "POST",
      body: JSON.stringify({ favorite }),
    }),
  setCallNotes: (recordingId: string, notes: string) =>
    request<{ notes: string }>(`/api/calls/${recordingId}/notes`, {
      method: "PUT",
      body: JSON.stringify({ notes }),
    }),
  hardDeleteCall: (recordingId: string) =>
    request<{ status: string }>(`/api/calls/${recordingId}`, { method: "DELETE" }),
  retryCallTranscription: (recordingId: string) =>
    request<{ status: string }>(`/api/calls/${recordingId}/retry`, { method: "POST" }),
  getCallReviews: (recordingId: string) =>
    request<CallReview[]>(`/api/calls/${recordingId}/reviews`),
  createCallReview: async (recordingId: string, text: string, audio?: Blob, audioFilename = "review.webm") => {
    const formData = new FormData();
    formData.append("text", text);
    if (audio) formData.append("audio", audio, audioFilename);
    const token = getToken();
    const res = await fetch(`${BASE}/api/calls/${recordingId}/reviews`, {
      method: "POST",
      body: formData,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error((await res.text()) || "Review failed");
    return res.json() as Promise<CallReview>;
  },
  getReviewAudioUrl: (reviewId: string) => `${BASE}/api/calls/reviews/${reviewId}/audio`,
  getCoachingProfile: () =>
    request<{ id: string; profile_text: string; reviews_count_at_gen: number; generated_by: string; created_at: string } | null>(
      "/api/calls/coaching-profile",
    ),
  regenerateCoachingProfile: () =>
    request<{ id: string; profile_text: string; reviews_count_at_gen: number; generated_by: string; created_at: string }>(
      "/api/calls/coaching-profile/regenerate",
      { method: "POST" },
    ),
  uploadCallRecording: async (file: File, leadId: string, direction = "outbound", recordedBy?: string) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("lead_id", leadId);
    formData.append("call_direction", direction);
    const name = recordedBy ?? getCurrentUser()?.name ?? "";
    if (name) formData.append("recorded_by", name);
    const token = getToken();
    const res = await fetch(`${BASE}/api/calls/upload`, {
      method: "POST",
      body: formData,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error("Upload failed");
    return res.json() as Promise<{ id: string; status: string }>;
  },

  // --- Crew (admin-only) ---
  listCrew: (rangeKey: "this_week" | "last_week" | "month" | "ytd" = "this_week", includeInactive = false) => {
    const params = new URLSearchParams({ range: rangeKey, include_inactive: String(includeInactive) });
    return request<{
      range: string; start: string; end: string;
      employees: (Employee & { range_totals: RangeTotals; lifetime: LifetimeTotals })[];
    }>(`/api/crew/employees?${params}`);
  },
  getEmployee: (id: string) =>
    request<Employee & { this_week: RangeTotals; last_week: RangeTotals; month: RangeTotals; ytd: RangeTotals; lifetime: LifetimeTotals }>(
      `/api/crew/employees/${id}`,
    ),
  createEmployee: (body: EmployeeBody) =>
    request<Employee>("/api/crew/employees", { method: "POST", body: JSON.stringify(body) }),
  updateEmployee: (id: string, body: EmployeeBody) =>
    request<Employee>(`/api/crew/employees/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  setEmployeeStatus: (id: string, status: "active" | "inactive") =>
    request<Employee>(`/api/crew/employees/${id}/status`, { method: "POST", body: JSON.stringify({ status }) }),
  uploadW9: async (id: string, file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    const token = getToken();
    const res = await fetch(`${BASE}/api/crew/employees/${id}/w9`, {
      method: "POST",
      body: formData,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error((await res.text()) || "W9 upload failed");
    return res.json() as Promise<Employee>;
  },
  getW9Url: (id: string) => `${BASE}/api/crew/employees/${id}/w9`,
  listTimeEntries: (employeeId: string, year?: number) => {
    const qs = year ? `?year=${year}` : "";
    return request<TimeEntry[]>(`/api/crew/employees/${employeeId}/time-entries${qs}`);
  },
  createTimeEntry: (body: TimeEntryBody) =>
    request<TimeEntry>("/api/crew/time-entries", { method: "POST", body: JSON.stringify(body) }),
  updateTimeEntry: (id: string, body: Partial<TimeEntryBody>) =>
    request<TimeEntry>(`/api/crew/time-entries/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteTimeEntry: (id: string) =>
    request<{ status: string }>(`/api/crew/time-entries/${id}`, { method: "DELETE" }),
  listPayments: (employeeId: string, year?: number) => {
    const qs = year ? `?year=${year}` : "";
    return request<Payment[]>(`/api/crew/employees/${employeeId}/payments${qs}`);
  },
  createPayment: (body: PaymentBody) =>
    request<Payment>("/api/crew/payments", { method: "POST", body: JSON.stringify(body) }),
  updatePayment: (id: string, body: PaymentBody) =>
    request<Payment>(`/api/crew/payments/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deletePayment: (id: string) =>
    request<{ status: string }>(`/api/crew/payments/${id}`, { method: "DELETE" }),
  getCrewSummary: () =>
    request<{ active_count: number; total_unpaid_balance: number; w9_missing_count: number; w9_missing_30d_count: number }>("/api/crew/summary"),
  getEmployeeYtdExportUrl: (id: string, year?: number) =>
    `${BASE}/api/crew/employees/${id}/export${year ? `?year=${year}` : ""}`,
  getRosterExportUrl: () => `${BASE}/api/crew/export-roster`,

  // Worker login provisioning
  getWorkerLogin: (employeeId: string) =>
    request<{ has_login: boolean; username?: string; created_at?: string }>(`/api/crew/employees/${employeeId}/login`),
  upsertWorkerLogin: (employeeId: string, body: { username: string; password?: string }) =>
    request<{ status: string; username: string }>(
      `/api/crew/employees/${employeeId}/login`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  revokeWorkerLogin: (employeeId: string) =>
    request<{ status: string }>(`/api/crew/employees/${employeeId}/login`, { method: "DELETE" }),

  // Scheduling
  createScheduledJob: (body: ScheduleJobBody) =>
    request<ScheduledJob>("/api/schedule/jobs", { method: "POST", body: JSON.stringify(body) }),
  listScheduledJobs: (params: { start?: string; end?: string; employee_id?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.start) qs.set("start", params.start);
    if (params.end) qs.set("end", params.end);
    if (params.employee_id) qs.set("employee_id", params.employee_id);
    return request<{ jobs: ScheduledJob[] }>(`/api/schedule/jobs${qs.toString() ? "?" + qs : ""}`);
  },
  getScheduledJob: (id: string) =>
    request<ScheduledJob>(`/api/schedule/jobs/${id}`),
  updateScheduledJob: (id: string, body: UpdateJobBody) =>
    request<ScheduledJob>(`/api/schedule/jobs/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteScheduledJob: (id: string) =>
    request<{ status: string }>(`/api/schedule/jobs/${id}`, { method: "DELETE" }),

  // Google OAuth
  getGoogleAuthUrl: () => request<{ url: string }>("/api/google/auth-url"),
  getGoogleStatus: () => request<{ connected: boolean; email?: string; calendar_id?: string; connected_at?: string }>("/api/google/status"),
  disconnectGoogle: () => request<{ status: string }>("/api/google/disconnect", { method: "POST" }),
  /** Read Alan's Google Calendar events for the given date range. Returns
   * an empty array when Google isn't connected so the caller doesn't crash. */
  getGoogleEvents: (start: string, end: string) =>
    request<{ events: GoogleEvent[] }>(`/api/google/events?start=${start}&end=${end}`),
  /** One-shot backfill: add an email as a guest to every yellow (or
   *  color_id-matched) job event in the date window. Used to migrate
   *  past events from the personal calendar onto a business calendar. */
  backfillGoogleAttendee: (body: GCalAttendeeBackfillBody) =>
    request<GCalAttendeeBackfillResult>("/api/google/backfill-attendee", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // Accounting
  getAccountingSummary: (period: string) =>
    request<AccountingSummary>(`/api/accounting/summary?period=${encodeURIComponent(period)}`),
  getJobProfitability: (period: string) =>
    request<{ jobs: JobProfitabilityRow[]; period: string; start: string; end: string }>(
      `/api/accounting/jobs?period=${encodeURIComponent(period)}`,
    ),
  getOutstanding: () =>
    request<{ jobs: OutstandingJob[]; total_outstanding: number }>("/api/accounting/outstanding"),
  getEmployeeRevenue: (period: string) =>
    request<{ period: string; start: string; end: string; total_company_revenue: number; employees: EmployeeRevenueRow[] }>(
      `/api/accounting/employee-revenue?period=${encodeURIComponent(period)}`,
    ),
  // W2 (2026-06-08) — Recent payment activity for the Dashboard widget.
  // Merges job invoices + deposit payments, newest first, plus a
  // collected-today running total.
  getRecentPayments: (limit: number = 10) =>
    request<{ events: PaymentEvent[]; collected_today: number; today_iso: string }>(
      `/api/payments/recent?limit=${limit}`,
    ),
  // W3 (2026-06-08) — manual reconciliation safety-net trigger.
  // Returns per-pass stats. Skipped_mock=true means QB_MODE isn't 'live'
  // and nothing was checked — caller should surface that to the user.
  reconcileQuickBooks: () =>
    request<{
      jobs: { checked: number; updated: number; errors: number; skipped_mock: boolean };
      deposits: { checked: number; updated: number; errors: number; skipped_mock: boolean };
      skipped_mock?: boolean;
    }>("/api/quickbooks/reconcile", { method: "POST" }),
  // Per-job force refresh — for the per-row sync button.
  refreshJobFromQB: (jobId: string) =>
    request<{
      status: string;
      changed?: boolean;
      payment_status?: string;
      qb_invoice_status?: string;
      amount_collected?: number;
    }>(`/api/quickbooks/jobs/${jobId}/refresh-from-qb`, { method: "POST" }),
  listOverhead: () => request<{ entries: OverheadEntry[] }>("/api/accounting/overhead"),
  createOverhead: (body: OverheadBody) =>
    request<OverheadEntry>("/api/accounting/overhead", { method: "POST", body: JSON.stringify(body) }),
  updateOverhead: (id: string, body: OverheadBody) =>
    request<OverheadEntry>(`/api/accounting/overhead/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteOverhead: (id: string) =>
    request<{ status: string }>(`/api/accounting/overhead/${id}`, { method: "DELETE" }),

  // Mark Paid (manual payment entry)
  markScheduledJobPaid: (jobId: string, body: MarkPaidBody) =>
    request<ScheduledJob>(`/api/schedule/jobs/${jobId}/mark-paid`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // Job lifecycle — worker hits these from the My Day view
  startScheduledJob: (jobId: string) =>
    request<ScheduledJob>(`/api/schedule/jobs/${jobId}/start`, { method: "POST" }),
  completeScheduledJob: (jobId: string) =>
    request<ScheduledJob>(`/api/schedule/jobs/${jobId}/complete`, { method: "POST" }),
  /** Worker (or staff) submits actual stain + bleach gallons used on a job.
   *  Either field can be omitted to leave it unchanged. */
  updateJobMaterials: (
    jobId: string,
    body: { stain_gallons?: number; bleach_gallons?: number },
  ) =>
    request<ScheduledJob>(`/api/schedule/jobs/${jobId}/materials`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // Autocomplete — typeahead + recent. Used by CustomerSearchInput +
  // EmployeeSearchInput across reimbursements, time logs, etc.
  searchLeads: (q: string, limit: number = 10) =>
    request<{ results: LeanLead[] }>(
      `/api/leads/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  recentLeads: (limit: number = 10) =>
    request<{ results: LeanLead[] }>(`/api/leads/recent?limit=${limit}`),
  searchEmployees: (q: string, limit: number = 10) =>
    request<{ results: LeanEmployee[] }>(
      `/api/crew/employees/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  recentEmployees: (limit: number = 10) =>
    request<{ results: LeanEmployee[] }>(`/api/crew/employees/recent?limit=${limit}`),

  // QuickBooks
  getQuickBooksStatus: () => request<QuickBooksStatus>("/api/quickbooks/status"),
  getQuickBooksAuthUrl: () => request<{ url: string; mode: string; note?: string }>("/api/quickbooks/auth-url"),
  disconnectQuickBooks: () => request<{ status: string }>("/api/quickbooks/disconnect", { method: "POST" }),
  refreshQuickBooksDiscovery: () =>
    request<{ authorization_endpoint: string; token_endpoint: string; revocation_endpoint: string }>(
      "/api/quickbooks/refresh-discovery",
      { method: "POST" },
    ),
  generateInvoice: (jobId: string, body: { amount: number; description?: string; due_in_days?: number; line_items?: { description: string; qty: number; rate: number }[] }) =>
    request<GenerateInvoiceResult>(`/api/quickbooks/jobs/${jobId}/generate-invoice`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  sendInvoiceSms: (jobId: string) =>
    request<{ status: string; to_phone: string }>(`/api/quickbooks/jobs/${jobId}/send-invoice-sms`, {
      method: "POST",
    }),
  /** Send the $250 non-refundable scheduling deposit invoice for a Lead.
   *  Returns the hosted QB payment link. Idempotent — re-calling on a
   *  lead that already has one returns the existing record. */
  sendDepositInvoice: (leadId: string) =>
    request<DepositInvoiceResult>(`/api/quickbooks/leads/${leadId}/send-deposit-invoice`, {
      method: "POST",
    }),
  /** Mark a lead's deposit as waived (Alan's call for trusted repeat
   *  customers). Frees the soft schedule gate without taking payment. */
  waiveDeposit: (leadId: string) =>
    request<{ status: string; lead: Lead }>(`/api/quickbooks/leads/${leadId}/waive-deposit`, {
      method: "POST",
    }),

  /** Sprint 2 — Call dispositions. Log the outcome of a sales call so the
   *  funnel finally has why-didn't-this-close data. Append-only history. */
  logCallDisposition: (
    leadId: string,
    body: { outcome: CallDispositionOutcome; notes?: string; callback_at?: string | null },
  ) =>
    request<CallDispositionEntry>(`/api/leads/${leadId}/call-dispositions`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listCallDispositions: (leadId: string) =>
    request<{ dispositions: CallDispositionEntry[] }>(`/api/leads/${leadId}/call-dispositions`),
  /** Sprint 2 T2.E — Compute the current follow-up flag for a lead.
   *  Returns null when no rule fires. */
  getFollowUpFlag: (leadId: string) =>
    request<{ flag: FollowUpFlag | null }>(`/api/leads/${leadId}/follow-up-flag`),
  /** Sprint 3 T3.B — Route-stack candidates near a lead. Returns scheduled
   *  jobs in the next N days (default 14) ranked same-ZIP-first then by
   *  distance. Lazy-geocodes the lead on first call. */
  getNearbyJobs: (leadId: string, days = 14) =>
    request<NearbyJobsResponse>(`/api/leads/${leadId}/nearby-jobs?days=${days}`),
  /** Admin "Ready to Invoice" queue — jobs that started or completed
   * but haven't been invoiced yet. Feeds the dedicated queue page. */
  getReadyToInvoice: () =>
    request<{
      count: number;
      in_progress_count: number;
      completed_count: number;
      jobs: ReadyToInvoiceJob[];
    }>("/api/quickbooks/ready-to-invoice"),

  /** Mock-mode helper: pretend Intuit just told us a payment came in. */
  triggerMockQbPayment: (qbInvoiceId: string, amount: number) =>
    request<{ status: string; marked_paid?: string; reason?: string }>("/api/quickbooks/webhook", {
      method: "POST",
      body: JSON.stringify({ qb_invoice_id: qbInvoiceId, amount }),
    }),

  // QuickBooks Time (separate developer app at api.tsheets.com)
  getQBTimeStatus: () => request<QBTimeStatus>("/api/quickbooks/qbtime/status"),
  getQBTimeAuthUrl: () =>
    request<{ url: string; mode: string; note?: string; state?: string }>("/api/quickbooks/qbtime/auth-url"),
  disconnectQBTime: () =>
    request<{ status: string }>("/api/quickbooks/qbtime/disconnect", { method: "POST" }),

  // Marketing source analytics
  getLeadSources: (days: number = 90, pipelineVersion?: string) => {
    const params = new URLSearchParams({ days: String(days) });
    if (pipelineVersion) params.set("pipeline_version", pipelineVersion);
    return request<{ days: number; total_leads: number; total_revenue: number; sources: LeadSourceRow[] }>(
      `/api/analytics/lead-sources?${params.toString()}`,
    );
  },

  // SOPs (Standard Operating Procedures)
  listSopTemplates: (params: { service_type?: string; include_inactive?: boolean } = {}) => {
    const qs = new URLSearchParams();
    if (params.service_type) qs.set("service_type", params.service_type);
    if (params.include_inactive) qs.set("include_inactive", "true");
    return request<{ templates: SopTemplate[] }>(`/api/sops/templates${qs.toString() ? "?" + qs.toString() : ""}`);
  },
  getSopTemplate: (id: string) =>
    request<SopTemplate & { steps: SopTemplateStep[] }>(`/api/sops/templates/${id}`),
  createSopTemplate: (body: SopTemplateBody) =>
    request<SopTemplate & { steps: SopTemplateStep[] }>("/api/sops/templates", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateSopTemplate: (id: string, body: SopTemplateBody) =>
    request<SopTemplate & { steps: SopTemplateStep[] }>(`/api/sops/templates/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteSopTemplate: (id: string) =>
    request<{ status: string }>(`/api/sops/templates/${id}`, { method: "DELETE" }),
  addSopStep: (templateId: string, body: SopStepBody) =>
    request<SopTemplateStep>(`/api/sops/templates/${templateId}/steps`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateSopStep: (stepId: string, body: SopStepBody) =>
    request<SopTemplateStep>(`/api/sops/steps/${stepId}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteSopStep: (stepId: string) =>
    request<{ status: string }>(`/api/sops/steps/${stepId}`, { method: "DELETE" }),
  reorderSopSteps: (templateId: string, step_ids: string[]) =>
    request<{ status: string }>(`/api/sops/templates/${templateId}/reorder`, {
      method: "POST",
      body: JSON.stringify({ step_ids }),
    }),
  backfillSopRuns: () =>
    request<{ attached: number; skipped_no_template: number; total_jobs: number }>(
      "/api/sops/backfill", { method: "POST" }
    ),
  /** One-click import of the CrewClock Fence Staining template (23 steps,
   * reference data, bleach-vs-power-wash branch). Idempotent — refuses
   * to overwrite an existing template named "Fence Staining SOP". */
  importCrewClockTemplate: () =>
    request<{ status: "imported" | "exists"; template_id: string; step_count?: number; message: string }>(
      "/api/sops/import/crewclock", { method: "POST" }
    ),
  selectSopBranch: (runId: string, branchKey: string) =>
    request<SopRun>(`/api/sops/runs/${runId}/select-branch`, {
      method: "POST",
      body: JSON.stringify({ branch_key: branchKey }),
    }),

  /** Worker (or admin) loads the SOP run for a specific job. Returns
   * `{ run: null }` when no template is configured for the job's service yet. */
  getSopRunByJob: (scheduledJobId: string) =>
    request<{ run: SopRun | null; job_date?: string; editable?: boolean }>(`/api/sops/runs/by-job/${scheduledJobId}`),
  startSopRun: (runId: string) =>
    request<SopRun>(`/api/sops/runs/${runId}/start`, { method: "POST" }),
  checkSopStep: (runId: string, stepId: string, completed: boolean, note: string = "") =>
    request<SopRun>(`/api/sops/runs/${runId}/steps/${stepId}/check`, {
      method: "PUT",
      body: JSON.stringify({ completed, note }),
    }),
  setSopStepNote: (runId: string, stepId: string, note: string) =>
    request<SopRun>(`/api/sops/runs/${runId}/steps/${stepId}/note`, {
      method: "PUT",
      body: JSON.stringify({ note }),
    }),
  requestSopStepHelp: (runId: string, stepId: string, helpNote: string) =>
    request<SopRun>(`/api/sops/runs/${runId}/steps/${stepId}/help`, {
      method: "POST",
      body: JSON.stringify({ help_note: helpNote }),
    }),
  uploadSopStepPhoto: async (runId: string, stepId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const token = getToken();
    const res = await fetch(`${BASE}/api/sops/runs/${runId}/steps/${stepId}/photo`, {
      method: "POST",
      body: fd,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error((await res.text()) || "Photo upload failed");
    return res.json() as Promise<SopRun>;
  },
  deleteSopStepPhoto: (runId: string, stepId: string) =>
    request<SopRun>(`/api/sops/runs/${runId}/steps/${stepId}/photo`, { method: "DELETE" }),
  getSopStepPhotoUrl: (runId: string, stepId: string) =>
    `${BASE}/api/sops/runs/${runId}/steps/${stepId}/photo`,
  /** Fetch the photo with auth and return a blob URL the caller revokes. */
  fetchSopStepPhotoBlobUrl: async (runId: string, stepId: string): Promise<string | null> => {
    const token = getToken();
    const res = await fetch(`${BASE}/api/sops/runs/${runId}/steps/${stepId}/photo`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  },

  // SOP V3 — multi-photo + multiselect_alert + worker hours-logging
  listSopStepPhotos: (runId: string, stepId: string) =>
    request<{ photos: SopRunPhotoMeta[] }>(`/api/sops/runs/${runId}/steps/${stepId}/photos`),
  fetchSopRunPhotoBlobUrl: async (runId: string, photoId: string): Promise<string | null> => {
    const token = getToken();
    const res = await fetch(`${BASE}/api/sops/runs/${runId}/photos/${photoId}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  },
  deleteSopRunPhoto: (runId: string, photoId: string) =>
    request<SopRun>(`/api/sops/runs/${runId}/photos/${photoId}`, { method: "DELETE" }),
  submitSopMultiselect: (runId: string, stepId: string, selectedOptions: string[]) =>
    request<SopRun & { _alert?: { selected: string[]; sms_sent: boolean; skipped_reason?: string | null } }>(
      `/api/sops/runs/${runId}/steps/${stepId}/multiselect`, {
        method: "POST",
        body: JSON.stringify({ selected_options: selectedOptions }),
      },
    ),
  logSopHours: (runId: string, body: { hours: number; task_name?: string; notes?: string }) =>
    request<{ status: string; hours_logged: number; today_total_hours: number; allocation_id: string; time_entry_id: string }>(
      `/api/sops/runs/${runId}/log-hours`, {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),

  // Call Script (single-row, admin-edited)
  getCallScript: () => request<CallScript>("/api/call-script"),
  updateCallScript: (content: string) =>
    request<CallScript>("/api/call-script", {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),

  // Wrapped (CEO digest) — cached. Reads hit cache; force=true triggers
  // a regenerate (re-spends Claude tokens).
  getWeeklyWrapped: (weekEnd?: string) => {
    const qs = weekEnd ? `?week_end=${encodeURIComponent(weekEnd)}` : "";
    return request<WrappedDigest>(`/api/wrapped/weekly${qs}`);
  },
  getMonthlyWrapped: (month?: string) => {
    const qs = month ? `?month=${encodeURIComponent(month)}` : "";
    return request<WrappedDigest>(`/api/wrapped/monthly${qs}`);
  },
  regenerateWeeklyWrapped: (weekEnd?: string) => {
    const qs = weekEnd ? `?week_end=${encodeURIComponent(weekEnd)}` : "";
    return request<WrappedDigest>(`/api/wrapped/weekly/regenerate${qs}`, { method: "POST" });
  },
  regenerateMonthlyWrapped: (month?: string) => {
    const qs = month ? `?month=${encodeURIComponent(month)}` : "";
    return request<WrappedDigest>(`/api/wrapped/monthly/regenerate${qs}`, { method: "POST" });
  },

  // Weather
  getWeather: (zip: string) => request<WeatherForecast>(`/api/weather/${encodeURIComponent(zip)}`),

  // Time logs (TaskAllocations + Reimbursements)
  getCustomersToLog: (employeeId: string) =>
    request<{ unlogged: UnloggedJob[]; all_customers: SearchableCustomer[] }>(
      `/api/time-logs/customers-to-log?employee_id=${encodeURIComponent(employeeId)}`,
    ),
  getDayLog: (employeeId: string, workDate: string) =>
    request<DayLog>(`/api/time-logs/employees/${employeeId}/day?work_date=${encodeURIComponent(workDate)}`),
  createAllocation: (body: AllocationBody) =>
    request<TaskAllocationRow>("/api/time-logs/allocations", { method: "POST", body: JSON.stringify(body) }),
  updateAllocation: (id: string, body: Partial<AllocationBody>) =>
    request<TaskAllocationRow>(`/api/time-logs/allocations/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteAllocation: (id: string) =>
    request<{ status: string }>(`/api/time-logs/allocations/${id}`, { method: "DELETE" }),
  listTaskNames: () =>
    request<{ names: { name: string; count: number }[] }>("/api/time-logs/task-names"),
  uploadReimbursement: async (form: FormData) => {
    const res = await fetch(`${BASE}/api/time-logs/reimbursements`, {
      method: "POST",
      headers: { Authorization: `Bearer ${getToken()}` },
      body: form,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Failed to upload reimbursement");
    return res.json() as Promise<ReimbursementRow>;
  },
  listReimbursements: (params: { employee_id?: string; lead_id?: string; status?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.employee_id) qs.set("employee_id", params.employee_id);
    if (params.lead_id) qs.set("lead_id", params.lead_id);
    if (params.status) qs.set("status", params.status);
    return request<{ reimbursements: ReimbursementRow[] }>(`/api/time-logs/reimbursements${qs.toString() ? "?" + qs : ""}`);
  },
  updateReimbursement: (id: string, body: { amount?: number; description?: string; notes?: string; status?: "pending" | "approved" | "rejected" }) =>
    request<ReimbursementRow>(`/api/time-logs/reimbursements/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteReimbursement: (id: string) =>
    request<{ status: string }>(`/api/time-logs/reimbursements/${id}`, { method: "DELETE" }),
  getReceiptUrl: (id: string) => `${BASE}/api/time-logs/reimbursements/${id}/receipt`,
  getLeadTimeLogs: (leadId: string) =>
    request<{
      allocations: (TaskAllocationRow & { employee_name: string })[];
      reimbursements: (ReimbursementRow & { employee_name: string })[];
      total_hours: number;
      total_reimbursements: number;
      pending_reimbursements: number;
    }>(`/api/leads/${leadId}/time-logs`),

  // Estimate delays (24h alert)
  listOpenDelays: () =>
    request<{ delays: EstimateDelayRow[]; preset_reasons: string[] }>("/api/estimate-delays/open"),
  getLeadDelay: (leadId: string) =>
    request<{ delay: EstimateDelayRow | null; preset_reasons?: string[] }>(`/api/leads/${leadId}/estimate-delay`),
  setDelayReason: (leadId: string, body: { reason_code: string; reason_other_text?: string }) =>
    request<EstimateDelayRow>(
      `/api/leads/${leadId}/estimate-delay/reason`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  clearDelayBadge: (leadId: string) =>
    request<{ status: string }>(`/api/leads/${leadId}/estimate-delay/clear`, { method: "POST" }),

  // Operator AI — Diagnosis Feed (admin-only)
  listAIThoughts: (params?: { status?: string; source?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set("status", params.status);
    if (params?.source) qs.set("source", params.source);
    if (params?.limit) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<{ thoughts: AIThought[]; active_count: number }>(`/api/operator/thoughts${suffix}`);
  },
  getAIThought: (id: string) => request<AIThought>(`/api/operator/thoughts/${id}`),
  approveAIThought: (id: string, note?: string) =>
    request<{ status: string; result: unknown; error?: string }>(`/api/operator/thoughts/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ note: note || "" }),
    }),
  dismissAIThought: (id: string, note?: string) =>
    request<{ status: string }>(`/api/operator/thoughts/${id}/dismiss`, {
      method: "POST",
      body: JSON.stringify({ note: note || "" }),
    }),
  snoozeAIThought: (id: string, until: string) =>
    request<{ status: string; until: string }>(`/api/operator/thoughts/${id}/snooze`, {
      method: "POST",
      body: JSON.stringify({ until }),
    }),
  dropTestAIThought: (body: { title: string; summary: string; severity: string; category: string }) =>
    request<{ id: string }>(`/api/operator/thoughts/_test`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // Follow-up Engine — admin-only
  getFollowupConfig: () => request<FollowUpConfig>("/api/followups/config"),
  updateFollowupConfig: (body: Partial<FollowUpConfig>) =>
    request<FollowUpConfig>("/api/followups/config", { method: "PUT", body: JSON.stringify(body) }),
  listFollowupSequences: () =>
    request<{ sequences: FollowUpSequence[] }>("/api/followups/sequences"),
  getFollowupSequence: (id: string) =>
    request<{ sequence: FollowUpSequence; steps: FollowUpStep[] }>(`/api/followups/sequences/${id}`),
  createFollowupSequence: (body: { name: string; description?: string; trigger_event?: string; pause_on_events?: string }) =>
    request<FollowUpSequence>("/api/followups/sequences", { method: "POST", body: JSON.stringify(body) }),
  updateFollowupSequence: (id: string, body: { name: string; description?: string; trigger_event?: string; pause_on_events?: string }) =>
    request<FollowUpSequence>(`/api/followups/sequences/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  toggleFollowupSequence: (id: string) =>
    request<{ id: string; active: boolean }>(`/api/followups/sequences/${id}/toggle`, { method: "POST" }),
  deleteFollowupSequence: (id: string) =>
    request<{ status: string }>(`/api/followups/sequences/${id}`, { method: "DELETE" }),
  addFollowupStep: (seqId: string, body: { position: number; delay_hours: number; channel: string; message_template: string; use_ai_personalization?: boolean }) =>
    request<FollowUpStep>(`/api/followups/sequences/${seqId}/steps`, { method: "POST", body: JSON.stringify(body) }),
  updateFollowupStep: (stepId: string, body: { position: number; delay_hours: number; channel: string; message_template: string; use_ai_personalization?: boolean }) =>
    request<FollowUpStep>(`/api/followups/steps/${stepId}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteFollowupStep: (stepId: string) =>
    request<{ status: string }>(`/api/followups/steps/${stepId}`, { method: "DELETE" }),
  getFollowupRunsByLead: (leadId: string) =>
    request<{ runs: FollowUpRun[] }>(`/api/followups/runs/by-lead/${leadId}`),
  getFollowupRunEvents: (runId: string) =>
    request<{ events: FollowUpEvent[] }>(`/api/followups/runs/${runId}/events`),
  pauseFollowupRun: (runId: string) =>
    request<FollowUpRun>(`/api/followups/runs/${runId}/pause`, { method: "POST" }),
  resumeFollowupRun: (runId: string) =>
    request<FollowUpRun>(`/api/followups/runs/${runId}/resume`, { method: "POST" }),
  stopFollowupRun: (runId: string) =>
    request<FollowUpRun>(`/api/followups/runs/${runId}/stop`, { method: "POST" }),
  startFollowupTestRun: (body: { sequence_id: string; lead_id?: string }) =>
    request<{ run_id: string; lead_id: string; lead_name: string; master_on: boolean; hint: string }>("/api/followups/test-run", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  startSequenceOnLead: (leadId: string, sequenceId: string) =>
    request<{ run_id: string; master_on: boolean }>(`/api/followups/leads/${leadId}/start-sequence`, {
      method: "POST",
      body: JSON.stringify({ sequence_id: sequenceId }),
    }),
  sendFollowupNow: (runId: string) =>
    request<FollowUpRun>(`/api/followups/runs/${runId}/send-now`, { method: "POST" }),
  skipFollowupStep: (runId: string) =>
    request<FollowUpRun>(`/api/followups/runs/${runId}/skip-step`, { method: "POST" }),
  clearLeadDoNotContact: (leadId: string) =>
    request<{ status: string; do_not_contact: boolean }>(`/api/followups/leads/${leadId}/clear-dnc`, { method: "POST" }),
  compileSequenceInstruction: (seqId: string, instruction: string) =>
    request<{ current: SequencePlan; proposed: SequencePlan; diff: SequenceDiffEntry[] }>(
      `/api/followups/sequences/${seqId}/compile`,
      { method: "POST", body: JSON.stringify({ instruction }) },
    ),
  applySequencePlan: (seqId: string, plan: SequencePlan) =>
    request<{ sequence: FollowUpSequence; step_count: number }>(
      `/api/followups/sequences/${seqId}/apply-plan`,
      { method: "POST", body: JSON.stringify({ plan }) },
    ),

  // Internal value dashboard (fragned only)
  getInternalDashboard: (range: InternalRange) =>
    request<InternalDashboard>(`/api/internal/dashboard?range=${range}`),
  getInternalBaselines: () =>
    request<InternalBaselines>(`/api/internal/baselines`),
  setInternalBaselines: (body: Partial<InternalBaselines>) =>
    request<InternalBaselines>(`/api/internal/baselines`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  // Voice sales training simulator
  listTrainingPersonas: () =>
    request<{
      curated: TrainingPersona[];
      bank: TrainingPersona[];
      moods: TrainingMood[];
      tts_configured: boolean;
    }>(`/api/training/personas`),
  seedTrainingPersonaBank: (count: number) =>
    request<{ created: number; skipped: number; errors: string[] }>(
      `/api/training/personas/seed-from-db`,
      { method: "POST", body: JSON.stringify({ count }) },
    ),
  createTrainingSession: (persona_id: string, mood?: string) =>
    request<{ id: string; ws_path: string; persona: TrainingPersona; tts_configured: boolean }>(
      `/api/training/session`,
      { method: "POST", body: JSON.stringify({ persona_id, mood: mood || "" }) },
    ),
  // Real-lead simulator — builds a fresh persona from a specific real lead
  createTrainingSessionFromLead: (lead_id: string, mood?: string) =>
    request<{ id: string; ws_path: string; persona: TrainingPersona; tts_configured: boolean }>(
      `/api/training/session/from-lead`,
      { method: "POST", body: JSON.stringify({ lead_id, mood: mood || "" }) },
    ),
  // Hard-mode call — random challenging customer who'll grill the rep
  createGrillTrainingSession: () =>
    request<{ id: string; ws_path: string; persona: TrainingPersona; tts_configured: boolean }>(
      `/api/training/session/grill`,
      { method: "POST" },
    ),
  // Spitfire drill — coach runs through the full ~130-question bank
  // back-to-back, no evaluation. Just for answer practice + listen-back.
  createSpitfireTrainingSession: () =>
    request<{ id: string; ws_path: string; persona: TrainingPersona; tts_configured: boolean }>(
      `/api/training/session/spitfire`,
      { method: "POST" },
    ),
  getRandomTrainingLead: () =>
    request<{ lead_id: string; name: string; address: string }>(`/api/training/random-lead`),

  // Coaching-note + baseline endpoints (corvette sandwich + Alan baseline)
  getTrainingCoachingNotes: () =>
    request<{ items: TrainingCoachingNote[] }>(`/api/training/coaching-notes`),
  toggleTrainingCoachingNote: (noteId: string) =>
    request<TrainingCoachingNote>(
      `/api/training/coaching-notes/${noteId}/toggle`,
      { method: "POST" },
    ),
  getTrainingBaselineStatus: () =>
    request<{
      exists: boolean;
      session_id?: string;
      captured_at?: string;
      turns?: number;
      duration_seconds?: number;
    }>(`/api/training/baseline-status`),

  // Exterior painting AI estimate
  issueExteriorCaptureLink: (leadId: string) =>
    request<{ token: string; url: string }>(
      `/api/leads/${leadId}/exterior/capture-link`,
      { method: "POST" },
    ),
  issueExteriorCaptureLinkAndSendSms: (leadId: string) =>
    request<{ token: string; url: string; sent: boolean; body: string }>(
      `/api/leads/${leadId}/exterior/capture-link/send-sms`,
      { method: "POST" },
    ),
  cancelExteriorCaptureLink: (leadId: string) =>
    request<{
      ok: boolean;
      had_token: boolean;
      photos_attempted: number;
      photos_removed: number;
      canceled_by: string;
    }>(`/api/leads/${leadId}/exterior/cancel-link`, { method: "POST" }),
  deleteExteriorPhoto: (leadId: string, photoId: string) =>
    request<{ photos: ExteriorPhoto[] }>(
      `/api/leads/${leadId}/exterior/photos/${photoId}`,
      { method: "DELETE" },
    ),
  runExteriorEstimate: (leadId: string) =>
    request<ExteriorEstimate>(`/api/leads/${leadId}/exterior/run-estimate`, {
      method: "POST",
    }),
  updateExteriorOverrides: (leadId: string, body: Partial<ExteriorOverrides>) =>
    request<ExteriorEstimate>(`/api/leads/${leadId}/exterior/estimate`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  getExteriorCaptureInfo: (token: string) =>
    request<ExteriorCaptureInfo>(`/api/exterior/capture/${token}/info`),
  submitExteriorCapture: (token: string, note?: string) =>
    request<{ ok: boolean }>(`/api/exterior/capture/${token}/submit`, {
      method: "POST",
      body: JSON.stringify({ note: note || "" }),
    }),
  endTrainingSession: (id: string) =>
    request<TrainingSessionRecord>(`/api/training/session/${id}/end`, { method: "POST" }),
  listTrainingSessions: () =>
    request<{ items: TrainingSessionRecord[] }>(`/api/training/sessions`),
  getTrainingSession: (id: string) =>
    request<TrainingSessionRecord>(`/api/training/sessions/${id}`),

  // Customer upsell brief — Claude analysis + SMS sends. Lives on
  // the UpsellTab on the lead detail page.
  getUpsellAnalysis: (leadId: string) =>
    request<UpsellAnalysis>(`/api/leads/${leadId}/upsell-analysis`),
  sendReviewSms: (leadId: string) =>
    request<{ ok: boolean; message_sent: string }>(
      `/api/leads/${leadId}/upsell/send-review-sms`,
      { method: "POST" },
    ),
  sendUpsellSms: (leadId: string, message: string) =>
    request<{ ok: boolean; message_sent: string }>(
      `/api/leads/${leadId}/upsell/send-draft-sms`,
      { method: "POST", body: JSON.stringify({ message }) },
    ),

  // Painting Upsell pipeline — one-shot import from the old GHL account
  // plus the kanban + push-to-v2 flow for the dedicated pipeline view.
  // Paste-and-go import: API key passed in the request body, not stored.
  getPaintingUpsellPreview: (apiKey: string) =>
    request<{ count: number; samples: PaintingUpsellSample[]; error: string | null }>(
      "/api/painting-upsell/preview",
      { method: "POST", body: JSON.stringify({ api_key: apiKey }) },
    ),
  runPaintingUpsellImport: (apiKey: string) =>
    request<{ imported: number; skipped: number; errors: string[] }>(
      "/api/painting-upsell/import",
      { method: "POST", body: JSON.stringify({ api_key: apiKey }) },
    ),
  wipePaintingUpsell: () =>
    request<{ deleted_leads: number; deleted_messages: number; deleted_estimates: number }>(
      "/api/painting-upsell/wipe",
      { method: "POST" },
    ),
  // New-account pipeline discovery (one-time setup so push-to-v2 knows
  // where to drop opportunities in the new GHL account).
  listV2Pipelines: () =>
    request<{ pipelines: { id: string; name: string; stages: { id: string; name: string }[] }[] }>(
      "/api/painting-upsell/v2-pipelines",
    ),
  getPaintingUpsellV2Config: () =>
    request<{ pipeline_id: string; new_stage_id: string; configured: boolean }>(
      "/api/painting-upsell/v2-config",
    ),
  savePaintingUpsellV2Config: (pipelineId: string, newStageId: string) =>
    request<{ pipeline_id: string; new_stage_id: string; configured: boolean }>(
      "/api/painting-upsell/v2-config",
      { method: "PUT", body: JSON.stringify({ pipeline_id: pipelineId, new_stage_id: newStageId }) },
    ),
  getPaintingUpsellStages: () =>
    request<{ stages: PaintingUpsellStage[] }>("/api/painting-upsell/stages"),
  listPaintingUpsellLeads: () =>
    request<{ stages: PaintingUpsellStage[]; leads: LeadDetail[] }>(
      "/api/painting-upsell/leads",
    ),
  movePaintingUpsellStage: (leadId: string, stageId: string) =>
    request<LeadDetail>(`/api/painting-upsell/leads/${leadId}/stage`, {
      method: "PUT",
      body: JSON.stringify({ stage_id: stageId }),
    }),
  pushPaintingUpsellToV2: (leadId: string) =>
    request<LeadDetail>(`/api/painting-upsell/leads/${leadId}/push-to-v2-ghl`, {
      method: "POST",
    }),
};

// --- Training simulator types ---

export interface TrainingPersona {
  id: string;
  name: string;
  headline: string;
  age: number;
  gender: string;
  location: string;
  fence_context: string;
  default_mood: string;
  available_moods: string[];
  traits: string[];
  source: string;
}

export interface TrainingMood {
  id: string;
  label: string;
  subtitle: string;
}

export interface TrainingTranscriptTurn {
  role: "user" | "assistant";
  content: string;
  ts?: string;
}

// --- Exterior painting estimate ---

export interface ExteriorPhoto {
  id: string;
  url: string;
  source: "customer" | "va" | "admin";
  label: string;
  content_type: string;
  bytes?: number;
  uploaded_at: string;
}

export interface ExteriorOverrides {
  perimeter_ft?: number;
  stories?: number;
  wall_height_ft?: number;
  opening_sqft?: number;
  applied_sqft?: number;
  confidence_note?: string;
}

export interface ExteriorEstimate {
  status: "ok" | "skipped" | "";
  skip_reason?: string;
  generated_at?: string;
  perimeter_ft?: number;
  stories?: number;
  wall_height_ft?: number;
  windows_count?: number;
  doors_count?: number;
  gross_wall_sqft?: number;
  opening_sqft?: number;
  paintable_sqft?: number;
  sqft_min?: number;
  sqft_max?: number;
  confidence?: "high" | "medium" | "low";
  /** How many photos this estimate was computed from — drives the
   *  confidence floor (1-2 photos = forced "low" regardless of what
   *  Claude self-reported). */
  photo_count?: number;
  /** False when the lead's address couldn't be geocoded and the
   *  estimator ran in photos-only mode (no Google Satellite tile).
   *  Used to widen the confidence band + warn the VA in the UI. */
  had_satellite?: boolean;
  vision_notes?: string;
  satellite_url?: string;
  va_overrides?: ExteriorOverrides;
  applied_sqft?: number;
  overridden_at?: string;
  overridden_by?: string;
  customer_submitted_at?: string;
  customer_note?: string;
}

export interface ExteriorCaptureInfo {
  first_name: string;
  address: string;
  photos_submitted: number;
  min_photos_required: number;
  recommended_photos: number;
}

/** Customer's capture-page activity timeline. All ISO timestamps;
 *  fields are populated lazily as the customer progresses. */
export interface ExteriorActivity {
  link_sent_at?: string;
  link_sent_count?: number;
  link_sent_by?: string;
  first_opened_at?: string;
  last_opened_at?: string;
  first_upload_at?: string;
  last_upload_at?: string;
  upload_count?: number;
  submitted_at?: string;
  canceled_at?: string;
  canceled_by?: string;
}

export interface TrainingAudioSegment {
  turn_index: number;
  role: "rep" | "persona";
  url: string;
  content_type: string;
  bytes?: number;
}

export interface TrainingSessionRecord {
  id: string;
  rep_user_id: string;
  rep_display_name: string;
  persona_id: string;
  persona_source: string;
  persona: Partial<TrainingPersona>;
  mood: string;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  transcript: TrainingTranscriptTurn[];
  score: Record<string, unknown>;
  audio_seconds: number;
  audio_segments: TrainingAudioSegment[];
}

export interface PaintingUpsellSample {
  name: string;
  phone: string;
  monetary_value: number;
  created_at: string;
}

export interface PaintingUpsellStage {
  id: string;
  label: string;
  short: string;
  header_cls: string;
  bg_cls: string;
  dot_cls: string;
}

export interface UpsellAnalysis {
  status: "ok" | "error";
  skip_reason?: string;
  what_they_bought: string;
  pain_points: string[];
  things_mentioned: string[];
  recommended_upsell: {
    type: string;
    why: string;
    hook: string;
  };
  suggested_opening: string;
  draft_upsell_sms: string;
  source_summary: {
    transcripts: number;
    sms: number;
    has_exterior_photos: boolean;
    has_estimate: boolean;
  };
}

export interface TrainingCoachingNote {
  id: string;
  created_at: string;
  note_text: string;
  captured_in_session_id: string;
  captured_by_user_id: string;
  captured_by_name: string;
  active: boolean;
}

// --- Internal dashboard types ---

export type InternalRange = "this_month" | "last_month" | "last_90_days" | "last_7_days" | "all_time";

export interface InternalBaselines {
  baseline_avg_response_minutes: number | null;
  baseline_close_rate_pct: number | null;
  baseline_monthly_revenue: number | null;
  system_launch_date: string | null;
}

export interface InternalDashboard {
  range: InternalRange;
  range_label: string;
  start: string;
  end: string;
  generated_at: string;
  baselines: InternalBaselines;
  hero: {
    total_revenue_closed: number;
    current_close_rate_pct: number;
    attribution_pct: number;
    attribution_method: "conservative_50pct" | "baseline_delta" | "below_baseline";
    attributable_revenue: number;
    recovered_revenue_from_sequences: number;
  };
  speed: {
    total_quotes_sent: number;
    avg_response_minutes: number;
    median_response_minutes: number;
    under_5_min_count: number;
    under_5_min_pct: number;
    after_hours_count: number;
  };
  persistence: {
    recovered_leads_count: number;
    recovered_revenue: number;
    sequence_runs_started: number;
    sequence_reply_count: number;
    sequence_reply_rate_pct: number;
    avg_touches_per_close: number;
    active_sequences_now: number;
    opt_outs_respected_total: number;
  };
  labor: {
    auto_quotes_generated: number;
    followup_sms_sent: number;
    chatbot_resolved_count: number;
    corrections_routed: number;
    estimated_hours_saved: number;
    labor_dollars_saved: number;
    multipliers: {
      auto_quote_min: number;
      followup_sms_min: number;
      chatbot_reply_min: number;
      correction_route_min: number;
      hourly_rate_usd: number;
    };
  };
  owner_time: {
    decisions_autonomous: number;
    delays_caught_count: number;
    after_hours_revenue: number;
    avg_gross_margin_pct: number;
    completed_jobs_in_range: number;
  };
}

// --- Workflow editor types ---

export interface SequenceStepPlan {
  position: number;
  delay_hours: number;
  channel: string;
  message_template: string;
  use_ai_personalization: boolean;
  wait_kind?: FollowUpWaitKind;
  window_start_hour?: number | null;
  window_start_minute?: number;
  window_end_hour?: number | null;
  window_end_minute?: number;
  action_kind?: FollowUpActionKind;
  tag_value?: string;
  column_value?: string;
  branch_field?: string;
  variants?: Record<string, string>;
  attachment_url?: string;
}

export interface SequencePlan {
  sequence_name: string;
  sequence_description: string;
  trigger_event: string;
  pause_on_events: string;
  send_window_start_hour?: number;
  send_window_end_hour?: number;
  timezone?: string;
  steps: SequenceStepPlan[];
  reasoning?: string;
  _compiler_unavailable?: boolean;
  _error?: string;
  _parse_error?: string;
  _instruction?: string;
}

export interface SequenceDiffEntry {
  kind: "added" | "removed" | "changed" | "unchanged" | "meta";
  position?: number;
  before?: SequenceStepPlan | Record<string, string>;
  after?: SequenceStepPlan | Record<string, string>;
  changes?: string[];
}

// --- Operator AI types ---

export type AIThoughtSeverity = "low" | "medium" | "high";
export type AIThoughtStatus = "active" | "approved" | "dismissed" | "snoozed" | "executed" | "superseded";

export interface AIThought {
  id: string;
  created_at: string;
  source: string;
  source_ref_id: string;
  severity: AIThoughtSeverity;
  category: string;
  title: string;
  summary: string;
  proposed_action_text: string;
  proposed_action_payload: Record<string, unknown>;
  confidence_pct: number;
  status: AIThoughtStatus;
  snooze_until: string;
  decided_at: string;
  decided_by: string;
  decision_note: string;
}

// --- Follow-up Engine types ---

export interface FollowUpSequence {
  id: string;
  name: string;
  description: string;
  trigger_event: string;
  pause_on_events: string;
  active: boolean;
  version: number;
  send_window_start_hour?: number;
  send_window_end_hour?: number;
  timezone?: string;
  created_at: string;
  updated_at: string;
  created_by: string;
}

export type FollowUpWaitKind = "seconds" | "minutes" | "hours" | "calendar_day";
export type FollowUpActionKind = "send_message" | "add_tag" | "move_column" | "notify_internal";

export interface FollowUpStep {
  id: string;
  sequence_id: string;
  position: number;
  delay_hours: number;
  channel: "sms" | "email";
  message_template: string;
  use_ai_personalization: boolean;
  skip_if_conditions: Record<string, unknown>;
  wait_kind?: FollowUpWaitKind;
  window_start_hour?: number | null;
  window_start_minute?: number;
  window_end_hour?: number | null;
  window_end_minute?: number;
  action_kind?: FollowUpActionKind;
  tag_value?: string;
  column_value?: string;
  branch_field?: string;
  variants?: Record<string, string>;
  attachment_url?: string;
  created_at: string;
  updated_at: string;
}

export type FollowUpRunStatus = "active" | "paused" | "stopped" | "completed" | "failed";

export interface FollowUpRun {
  id: string;
  lead_id: string;
  sequence_id: string;
  current_step: number;
  status: FollowUpRunStatus;
  paused_reason: string;
  next_due_at: string;
  last_sent_at: string;
  started_at: string;
  started_by: string;
  completed_at: string;
  test_mode: boolean;
  sequence_name?: string;
}

export interface FollowUpEvent {
  id: string;
  run_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  actor: string;
  created_at: string;
}

export interface FollowUpConfig {
  master_on: boolean;
  /** GHL Custom Conversation Provider ID for MyCRMSim (iMessage routing). */
  mycrmsim_provider_id: string;
  /** Legacy — retained so admin can see + clear old values. Not routed through. */
  imessage_from_number: string;
  sms_from_number: string;
  test_lead_id: string;
}


// --- Scheduling types ---

export interface ScheduleJobBody {
  lead_id: string;
  job_date: string;
  arrival_time?: string;
  estimated_duration_hours?: number;
  package_tier?: string;
  closed_price?: number;
  /** When true, the invite price line renders "Price: X + Tax". Default off. */
  closed_price_plus_tax?: boolean;
  /** Admin-pasted override for the proposal URL on the Google invite. When
   *  set, the invite uses this instead of the auto-resolved Proposal URL. */
  custom_proposal_url?: string;
  /** CSV of selected fence sides. When set, overrides lead.form_data.fence_sides
   *  on both the invite "Sides:" line and the worker view label. */
  fence_sides_override?: string;
  /** Free-form addendum appended to the Sides line on the invite + worker view. */
  additional_sides_text?: string;
  /** Free text — supports multiple colors (e.g. "Cabot Cedar, Behr Padre"). */
  color_choice?: string;
  needs_test_spots?: boolean;
  gallons_estimate?: number;
  /** Cleaning step. Admin-input, no auto-formula. */
  bleach_gallons?: number;
  address?: string;
  zip_code?: string;
  customer_email?: string;
  customer_phone?: string;
  customer_name?: string;
  /** Legacy single-text field — kept for back-compat; new flows use worker/customer notes. */
  job_description?: string;
  /** Worker-facing notes. Sanitized server-side before workers read it. */
  worker_notes?: string;
  /** Customer-facing notes — rendered into the Google invite description block. */
  customer_notes?: string;
  admin_notes?: string;
  materials_cost?: number;
  materials_notes?: string;
  employee_ids?: string[];
  send_thank_you?: boolean;
  send_calendar_invite?: boolean;
}

export interface UpdateJobBody {
  job_date?: string;
  arrival_time?: string;
  estimated_duration_hours?: number;
  package_tier?: string;
  closed_price?: number;
  closed_price_plus_tax?: boolean;
  custom_proposal_url?: string;
  fence_sides_override?: string;
  additional_sides_text?: string;
  color_choice?: string;
  needs_test_spots?: boolean;
  gallons_estimate?: number;
  bleach_gallons?: number;
  address?: string;
  zip_code?: string;
  customer_email?: string;
  customer_phone?: string;
  customer_name?: string;
  job_description?: string;
  worker_notes?: string;
  customer_notes?: string;
  admin_notes?: string;
  materials_cost?: number;
  materials_notes?: string;
  employee_ids?: string[];
  status?: string;
}

export type PaymentStatus = "unpaid" | "paid" | "bnpl_financed";

export interface MarkPaidBody {
  payment_status: PaymentStatus;
  amount_collected?: number;
  payment_method?: string;
  bnpl_vendor?: string;
}

/** An event read from Alan's Google Calendar — purely informational, not
 * editable in our app. Used to show jobs Alan booked on his phone alongside
 * the ones scheduled in the dashboard. Only Banana (yellow → fence) and
 * Tomato (red → pressure washing) events come through; the backend filters
 * out everything else. */
export interface GoogleEvent {
  google_event_id: string;
  summary: string;
  description: string;
  location: string;
  start: string;       // RFC 3339 timestamp OR YYYY-MM-DD for all-day
  end: string;
  all_day: boolean;
  html_link: string;   // Open this to edit in Google Calendar
  status: string;
  color_id: string;            // "5" = banana, "11" = tomato
  service_type: string;        // "fence_staining" | "power_washing"
}

export interface GCalAttendeeBackfillBody {
  attendee_email: string;
  from_date?: string;          // YYYY-MM-DD, defaults to 2026-05-01
  to_date?: string;            // YYYY-MM-DD, defaults to today (Central Time)
  color_id?: string;           // defaults to "5" (yellow / fence staining)
  send_updates?: "none" | "all" | "externalOnly";  // defaults to "none"
}

export interface GCalAttendeeBackfillResult {
  scanned: number;
  matched_color: number;
  updated: number;
  skipped_already: number;
  failed: number;
  details: Array<{
    event_id: string;
    summary: string;
    start: string;
    outcome: "updated" | "skipped_already" | "failed";
    error?: string;
  }>;
  window?: { from: string; to: string };
  attendee_email?: string;
  error?: string;
}

export interface ScheduledJob {
  id: string;
  lead_id: string;
  job_date: string;
  arrival_time: string;
  estimated_duration_hours: number;
  address: string;
  zip_code: string;
  lat?: number;
  lng?: number;
  weather_today?: WeatherDay | null;
  // Formatted fence-sides label from the lead's form_data, e.g.
  // "Inside Fences, Outside Front, Back". Empty string when not set.
  // Workers need this on the calendar so they know which surfaces to stain.
  fence_sides_label?: string;
  customer_name: string;
  /** essential | signature | legacy | custom — workers also see this now */
  package_tier?: string;
  color_choice: string;
  needs_test_spots: boolean;
  gallons_estimate: number;
  bleach_gallons?: number;
  job_description: string;
  /** Worker-facing notes (sanitized when role=worker on backend). */
  worker_notes?: string;
  /** Customer-facing notes — only returned for admin/va, never to workers. */
  customer_notes?: string;
  status: string;  // scheduled | in_progress | completed | cancelled
  started_at?: string | null;
  completed_at?: string | null;
  started_by?: string;
  completed_by?: string;
  google_event_id: string;
  service_type?: string;  // "fence_staining" | "power_washing" — drives calendar chip color
  // Admin/VA only (package_tier is now in the worker-visible block above)
  closed_price?: number;
  /** Only sent for admin/va. True = invite shows "Price: X + Tax". */
  closed_price_plus_tax?: boolean;
  /** Admin-only. When set, overrides the auto-resolved proposal URL on the invite. */
  custom_proposal_url?: string;
  /** Admin-only. CSV of selected fence sides; overrides lead.form_data on display. */
  fence_sides_override?: string;
  /** Admin-only. Free-form addendum appended to Sides on the invite + worker view. */
  additional_sides_text?: string;
  /** Admin-only. Viewable Google Calendar URL captured at event-create time. */
  google_event_html_link?: string;
  customer_email?: string;
  customer_phone?: string;
  admin_notes?: string;
  materials_cost?: number;
  materials_notes?: string;
  payment_status?: PaymentStatus;
  amount_collected?: number;
  payment_method?: string;
  bnpl_vendor?: string;
  paid_at?: string | null;
  paid_marked_by?: string;
  qb_invoice_id?: string;
  qb_invoice_url?: string;
  qb_invoice_status?: string;
  qb_invoice_amount?: number;
  qb_invoice_sent_at?: string | null;
  qb_invoice_paid_at?: string | null;
  customer_invited?: boolean;
  customer_thank_you_sent?: boolean;
  created_at?: string;
  created_by?: string;
  updated_at?: string;
  assigned_employee_ids?: string[];
}

export interface WeatherDay {
  date: string;
  high_f: number | null;
  low_f: number | null;
  precip_in: number;
  precip_chance_pct: number | null;
  summary: string;
}

export interface WeatherForecast {
  zip_code: string;
  days: WeatherDay[];
  accurate_through: string;
  note: string;
}

export interface GhlStageEntry {
  id: string;
  name: string;
}

export interface GhlStageDiff {
  pipeline_name: string;
  pipeline_id: string;
  matched: number;
  missing_from_dashboard: GhlStageEntry[];
  extra_in_dashboard: GhlStageEntry[];
  all_live_stages_in_order: GhlStageEntry[];
}

export interface CallListItem {
  lead_id: string;
  contact_name: string;
  contact_phone: string;
  address: string;
  zip_code?: string;
  signature_price: number;
  stage_id: string;
  stage_label: string;
  is_priority: boolean;
  ghl_opportunity_id: string;
  came_in_at: string;  // ISO datetime — when the lead first arrived (ghl_created_at preferred)
  /** Sprint 2 T2.E — Follow-up flag boosts this row in the queue sort + drives a UI badge. */
  follow_up_flag?: FollowUpFlag | null;
  /** Sprint 3 T3.E — Set when this lead's ZIP matches an upcoming scheduled
   *  job. Lifts the row in the sort and drives an inline 'near Smith Tue'
   *  hint so admin sees why this lead is ranked high. */
  nearby_match?: CallListNearbyMatch | null;
  /** Populated when the panel's near_zip filter is active; distance from
   *  the input ZIP's centroid in miles. null when the lead can't be
   *  geocoded (no coords + no zip). */
  distance_from_near_zip_miles?: number | null;
}

export interface CallListNearbyMatch {
  match_kind: "same_zip";
  job_id: string;
  customer_name: string;
  job_date: string;
  distance_miles: number | null;
  zip_code: string;
}

export interface CallListResponse {
  items: CallListItem[];
  priority_threshold: number;
  suppression_hours: number;
  /** Echoes the ZIP the rep filtered by — empty when no filter active. */
  near_zip?: string;
  /** True when the ZIP filter resolved to coords; false when geocoding
   *  failed (invalid ZIP, missing Maps key) — UI surfaces this so the
   *  rep knows the filter silently didn't apply. */
  near_zip_resolved?: boolean;
}

export interface CallTouchResult {
  status: string;
  touch_id: string;
  marked_at: string;
  marked_by: string;
}

// 2026-06-08 one-shot Sterling backfill state polled by the Settings card.
// `collected_leads` is the answer to "give me a list of names" — only
// leads that contributed at least one new recording show up here.
export interface SterlingBackfillCollectedLead {
  lead_id: string;
  contact_name: string;
  new_recordings: number;
  calls_found: number;
}

export interface SterlingBackfillStatus {
  running: boolean;
  started_at: string | null;
  completed_at: string | null;
  scanned: number;
  total: number;
  new_recordings: number;
  collected_leads: SterlingBackfillCollectedLead[];
  error: string | null;
}

export interface OppValueBackfillStartResult {
  status: string;
  in_scope_leads: number;
  note: string;
}

export interface OppValueBackfillStatus {
  status: "never_run" | "running" | "completed";
  started_at?: string;
  completed_at?: string | null;
  total?: number;
  processed?: number;
  pushed?: number;
  skipped_existing?: number;
  skipped_no_estimate?: number;
  skipped_no_opportunity?: number;
  failed_read?: number;
  failed_write?: number;
}

export interface UnloggedJob {
  scheduled_job_id: string;
  lead_id: string;
  job_date: string;
  customer_name: string;
  address: string;
}

export interface SearchableCustomer {
  lead_id: string;
  name: string;
  address: string;
}

export interface AllocationBody {
  employee_id: string;
  work_date: string;
  lead_id: string;
  task_name: string;
  hours: number;
  notes?: string;
  /** Pay-for-performance override. > 0 = fixed-pay allocation; 0 = hourly. */
  flat_pay_amount?: number;
}

export interface TaskAllocationRow {
  id: string;
  employee_id: string;
  time_entry_id: string;
  work_date: string;
  lead_id: string;
  task_name: string;
  hours: number;
  notes: string;
  flat_pay_amount?: number;
  customer_name?: string;
  created_at: string;
  created_by: string;
  updated_at: string;
}

export interface ReimbursementRow {
  id: string;
  employee_id: string;
  lead_id: string;
  expense_date: string;
  amount: number;
  description: string;
  receipt_uploaded: boolean;
  receipt_filename: string;
  status: "pending" | "approved" | "rejected";
  notes: string;
  created_at: string;
  created_by: string;
  approved_at: string | null;
  approved_by: string;
  employee_name?: string;
  customer_name?: string;
}

export interface DayLog {
  employee: Employee;
  time_entry: TimeEntry | null;
  allocations: (TaskAllocationRow & { customer_name: string })[];
  allocated_total: number;
  day_total: number;
  mismatch: number;
}

export interface EstimateDelayRow {
  id: string;
  lead_id: string;
  detected_at: string;
  reason_code: string;
  reason_other_text: string;
  reason_added_at: string | null;
  reason_added_by: string;
  alan_notified_at: string | null;
  alan_reason_notified_at: string | null;
  resolved_at: string | null;
  resolved_by: string;
  created_at: string;
  is_resolved: boolean;
  lead_name?: string;
  lead_phone?: string;
}


// --- Crew types (defined after the api object since it references them) ---

export interface Employee {
  id: string;
  first_name: string;
  last_name: string;
  display_name: string;
  role: string;
  pay_type: "hourly" | "daily" | "per_job" | "salary";
  pay_rate: number;
  phone: string;
  email: string;
  address: string;
  start_date: string;
  status: "active" | "inactive";
  w9_uploaded: boolean;
  w9_file_name: string;
  w9_uploaded_at: string | null;
  w9_missing: boolean;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface EmployeeBody {
  first_name: string;
  last_name: string;
  display_name?: string;
  role?: string;
  pay_type?: "hourly" | "daily" | "per_job" | "salary";
  pay_rate: number;
  phone?: string;
  email?: string;
  address?: string;
  start_date?: string;
  status?: "active" | "inactive";
  notes?: string;
}

export interface RangeTotals {
  hours: number;
  earned: number;
  paid: number;
  wage_paid: number;
  reimbursement_paid: number;
  bonus_paid: number;
  balance: number;
}

export interface LifetimeTotals {
  lifetime_earned: number;
  lifetime_paid: number;
  unpaid_balance: number;
}

export interface TimeEntry {
  id: string;
  employee_id: string;
  work_date: string;
  hours: number;
  rate_at_entry: number;
  earnings: number;
  job_reference: string;
  notes: string;
  created_at: string;
  created_by: string;
}

export interface TimeEntryBody {
  employee_id: string;
  work_date: string;
  hours: number;
  job_reference?: string;
  notes?: string;
}

export type PaymentMethod = "cash" | "zelle" | "check" | "venmo" | "cashapp" | "other";

export interface Payment {
  id: string;
  employee_id: string;
  payment_date: string;
  wage_amount: number;
  reimbursement_amount: number;
  reimbursement_note: string;
  bonus_amount: number;
  bonus_note: string;
  total_paid: number;
  payment_method: PaymentMethod;
  payment_method_other: string;
  notes: string;
  created_at: string;
  created_by: string;
}

export interface PaymentBody {
  employee_id: string;
  payment_date: string;
  wage_amount: number;
  reimbursement_amount: number;
  reimbursement_note: string;
  bonus_amount: number;
  bonus_note: string;
  payment_method: PaymentMethod;
  payment_method_other: string;
  notes: string;
}

// --- Accounting ---

export interface AccountingSummary {
  period: string;
  start: string;
  end: string;
  months_in_period: number;
  jobs_count: number;
  /** W1 (2026-06-08): collected cash this period (jobs + deposits). The
   *  honest revenue number. */
  revenue: number;
  /** Subtotal: collected against scheduled-job invoices. */
  revenue_from_jobs: number;
  /** Subtotal: $250 (or custom) deposits paid this period. */
  revenue_from_deposits: number;
  /** Pipeline / future money — sum of closed_price across jobs in period. */
  contracted_revenue: number;
  /** revenue_from_jobs ÷ contracted_revenue × 100. */
  collection_rate_pct: number;
  labor_cost: number;
  reimbursement_cost: number;
  materials_cost: number;
  /** Contracted − collected on jobs that aren't fully paid yet (period scope). */
  outstanding_revenue: number;
  overhead_monthly: number;
  overhead_cost: number;
  /** Computed against collected revenue (honest margin). */
  gross_profit: number;
  net_profit: number;
  gross_margin_pct: number;
  net_margin_pct: number;
}

export interface JobProfitabilityRow {
  scheduled_job_id: string;
  lead_id: string;
  customer_name: string;
  job_date: string;
  service_type: string;
  package_tier: string;
  address: string;
  /** W1: collected cash on this job (0 when unpaid). */
  revenue: number;
  /** What the customer agreed to pay — the pipeline number. */
  contracted_price: number;
  labor_cost: number;
  reimbursement_cost: number;
  materials_cost: number;
  /** Collected − costs. Unpaid jobs that already ran show as a loss. */
  profit: number;
  margin_pct: number;
  payment_status: PaymentStatus;
  amount_collected: number;
  qb_invoice_status: string;
  qb_invoice_url: string;
}

/** W2 (2026-06-08) — One payment event in the Dashboard's Recent Payments
 *  widget. Source distinguishes a full job invoice from a $250 deposit. */
export interface PaymentEvent {
  /** Composite id: "job:<scheduled_job_id>" | "deposit:<lead_id>" */
  id: string;
  source: "job" | "deposit";
  lead_id: string;
  customer_name: string;
  amount: number;
  /** ISO timestamp. Sort descending = newest first. */
  paid_at: string;
  /** "quickbooks_invoice" | "cash" | "zelle" | "check" | "bnpl" | ... */
  payment_method: string;
}

export interface OutstandingJob {
  scheduled_job_id: string;
  lead_id: string;
  customer_name: string;
  customer_phone: string;
  job_date: string;
  address: string;
  amount_due: number;
  payment_status: PaymentStatus;
  qb_invoice_status: string;
  qb_invoice_url: string;
  status: string;
}

export interface EmployeeRevenueRow {
  employee_id: string;
  name: string;
  labor_cost: number;
  hours: number;
  revenue_share: number;
  pay_pct_of_revenue: number;
}

export interface LeadSourceRow {
  key: string;
  label: string;
  leads: number;
  sent: number;
  closed: number;
  revenue: number;
  examples: { lead_id: string; contact_name: string; address: string; created_at: string }[];
  close_rate: number;
  send_rate: number;
  share_pct: number;
}

export interface QuickBooksStatus {
  mode: "mock" | "live";
  connected: boolean;
  company_name: string;
  realm_id: string;
  environment: string;
  connected_at: string;
  access_token_expires_at: string;
  refresh_token_expires_at: string;
  needs_reconnect: boolean;
  reconnect_reason: string;
  ready_to_test: boolean;
  /** W4 (2026-06-08) — ISO timestamp of the last signature-verified
   *  webhook receipt. Empty string when none has arrived yet. Powers
   *  the health pill on the QB status card. */
  last_webhook_received_at?: string;
  /** Count of ScheduledJob rows that have a QB invoice id but aren't
   *  marked paid locally yet. If this is > 0 and the webhook has been
   *  quiet for a long time, the pill goes yellow / red. */
  outstanding_invoices?: number;
}

export interface QBTimeStatus {
  mode: "mock" | "live";
  connected: boolean;
  company_name: string;
  company_id: string;
  user_id: string;
  current_user: { first_name?: string; last_name?: string; email?: string } | null;
  connected_at: string;
  access_token_expires_at: string;
  needs_reconnect: boolean;
  reconnect_reason: string;
  credentials_configured: boolean;
}

export interface GenerateInvoiceResult {
  mode: "mock" | "live";
  invoice_id: string;
  invoice_url: string;
  amount: number;
  status: string;
  job: ScheduledJob;
}

export interface DepositInvoiceResult {
  mode?: "mock" | "live";
  /** "sent" (new), "already_sent" (idempotent return), "already_paid",
   *  "waived". Frontend uses this to decide whether to re-show the link. */
  status: string;
  deposit_qb_invoice_id?: string;
  deposit_payment_link?: string;
  deposit_invoice_sent_at?: string | null;
  deposit_paid_at?: string | null;
  amount?: number;
  invoice_number?: string;
  lead?: Lead;
}

// Lean payloads used by the autocomplete components — much smaller than
// the full Lead / Employee types so typeahead can fire on every
// keystroke without measurable cost.
export interface LeanLead {
  id: string;
  contact_name: string;
  contact_phone: string;
  contact_email: string;
  address: string;
  zip_code: string;
  status: string;
  kanban_column: string;
  location_label: string;
}

export interface LeanEmployee {
  id: string;
  first_name: string;
  last_name: string;
  full_name: string;
  phone: string;
  email: string;
  pay_type: string;
  pay_rate: number;
  status: string;
}

export interface ReadyToInvoiceJob {
  id: string;
  lead_id: string;
  customer_name: string;
  address: string;
  job_date: string;
  arrival_time: string;
  status: "in_progress" | "completed";
  started_at: string | null;
  completed_at: string | null;
  closed_price: number;
  package_tier: string;
  customer_email: string;
  customer_phone: string;
  qb_invoice_id: string;
  qb_invoice_url: string;
}

export interface WrappedDigest {
  cadence: "weekly" | "monthly";
  label: string;
  start: string;
  end: string;
  week_end?: string;
  month?: string;
  revenue: number;
  revenue_change_pct: number | null;
  prev_revenue: number;
  new_leads: number;
  new_leads_change_pct: number | null;
  estimates_sent: number;
  close_rate: number;
  jobs_completed: number;
  jobs_scheduled: number;
  outstanding_total: number;
  outstanding_count: number;
  top_source: { key: string; count: number };
  top_employee: { name: string; labor_cost: number; hours: number } | null;
  most_profitable_job: { lead_id: string; scheduled_job_id: string; customer_name: string; revenue: number; profit: number; margin_pct: number; job_date: string } | null;
  biggest_deal: { lead_id: string; customer_name: string; amount: number; tier: string; closed_at: string | null } | null;
  busiest_day: { date: string; jobs: number } | null;
  top_tier: { name: string; count: number } | null;
  anomalies: { type: string; severity: "warn" | "info"; title: string; detail: string }[];

  // V2 additions
  score?: { value: number; grade: string; reason: string };
  bottleneck?: {
    stage_key: string;
    stage_label: string;
    severity: "low" | "medium" | "high";
    stuck_count: number;
    evidence: string;
    stuck_leads: { lead_id: string; name: string; address: string; days_stuck: number; phone: string }[];
  } | null;
  briefing?: {
    opening: string;
    situation: string;
    watch: string;
    profanity_used: boolean;
    generated_at: string;
  };
  recommended_action?: {
    text: string;
    button_label: string;
    link: string | null;
  };
  changelog?: { sha: string; subject: string; date: string }[];
  _from_cache?: boolean;
}

export interface OverheadEntry {
  id: string;
  category: string;
  description: string;
  monthly_amount: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface OverheadBody {
  category: string;
  description: string;
  monthly_amount: number;
  active: boolean;
}

// --- Call Script ---

export interface CallScript {
  id: string;
  content: string;
  updated_at: string;
  updated_by: string;
}

// --- SOPs ---

export type SopCategory = "pre-arrival" | "setup" | "execution" | "cleanup" | "wrap-up";

export const SOP_CATEGORIES: { key: SopCategory; label: string; emoji: string }[] = [
  { key: "pre-arrival", label: "Pre-arrival", emoji: "📞" },
  { key: "setup", label: "Setup", emoji: "🛠️" },
  { key: "execution", label: "Execution", emoji: "🎨" },
  { key: "cleanup", label: "Cleanup", emoji: "🧹" },
  { key: "wrap-up", label: "Wrap-up", emoji: "✅" },
];

export interface SopReferenceItem {
  label: string;
  value: string;
}

export interface SopBranch {
  key: string;
  label: string;
  subtitle?: string;
  icon?: string;
}

export interface SopTemplate {
  id: string;
  name: string;
  service_type: string;
  description: string;
  is_default: boolean;
  active: boolean;
  reference_data: SopReferenceItem[];
  branches: SopBranch[];
  created_at: string;
  updated_at: string;
  created_by: string;
}

export type SopStepKind = "checkbox" | "multiselect_alert";

export interface SopMultiselectConfig {
  options?: string[];
  alert_text?: string;
}

export interface SopTemplateStep {
  id: string;
  sop_template_id: string;
  order_index: number;
  title: string;
  description: string;
  required: boolean;
  category: SopCategory;
  /** Free-text section heading shown on the worker view (e.g. "Bleach
   * / Chemical Wash"). When empty, falls back to the category label. */
  section_name: string;
  /** Branch this step belongs to. Empty = always show. Otherwise must
   * match a key in the parent template's `branches` list. */
  branch_key: string;
  /** Legacy single-photo gate. photo_min_count is the source of truth
   * on V3. */
  photo_required: boolean;
  /** Worker must attach at least N photos before this step can be
   * checked off. 0 = no photo gate. > 1 enables the multi-photo gallery. */
  photo_min_count: number;
  /** Step kind. "checkbox" is the default; "multiselect_alert" shows
   * an option list and SMS-es Alan when any are selected. */
  kind: SopStepKind;
  config: SopMultiselectConfig | Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SopTemplateBody {
  name: string;
  service_type?: string;
  description?: string;
  is_default?: boolean;
  active?: boolean;
  reference_data?: SopReferenceItem[];
  branches?: SopBranch[];
}

export interface SopStepBody {
  title: string;
  description?: string;
  required?: boolean;
  category?: SopCategory;
  section_name?: string;
  branch_key?: string;
  photo_required?: boolean;
  photo_min_count?: number;
  kind?: SopStepKind;
  config?: SopMultiselectConfig | Record<string, unknown> | null;
  order_index?: number | null;
}

/** A snapshotted step on a SopRun — has the template-step fields PLUS
 * the worker's progress + per-step note + photo + help-request state. */
export interface SopRunStep {
  step_id: string;
  order_index: number;
  title: string;
  description: string;
  required: boolean;
  category: SopCategory;
  section_name: string;
  branch_key: string;
  photo_required: boolean;
  photo_min_count: number;
  kind: SopStepKind;
  config: SopMultiselectConfig | Record<string, unknown>;
  completed: boolean;
  completed_at: string | null;
  completed_by: string | null;
  note: string;
  /** Legacy pointer to the most-recent uploaded photo. Multi-photo
   * gallery uses listSopStepPhotos() to enumerate all of them. */
  photo_id: string | null;
  /** multiselect_alert state: null = unanswered, [] = answered "none",
   * [...] = answered with picks. */
  selected_options: string[] | null;
  submitted_at: string | null;
  submitted_by: string | null;
  help_requested_at: string | null;
  help_requested_by: string | null;
  help_note: string;
}

export interface SopRunPhotoMeta {
  id: string;
  filename: string;
  mime: string;
  photo_kind: string;
  uploaded_at: string;
  uploaded_by: string;
}

export interface SopRun {
  id: string;
  scheduled_job_id: string;
  sop_template_id: string;
  template_name_snapshot: string;
  reference_data: SopReferenceItem[];
  branches: SopBranch[];
  selected_branch: string;
  steps: SopRunStep[];
  status: "pending" | "in_progress" | "completed";
  started_at: string | null;
  started_by: string;
  completed_at: string | null;
  snapshot_at: string;
  created_at: string;
  updated_at: string;
  total_steps: number;
  completed_steps: number;
  required_total: number;
  required_completed: number;
  completion_pct: number;
}
