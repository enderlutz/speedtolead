const BASE = import.meta.env.VITE_API_URL || "";

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
}

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
  updateFormData: (id: string, form_data: Record<string, unknown>) =>
    request<LeadDetail>(`/api/leads/${id}/form-data`, {
      method: "PUT",
      body: JSON.stringify({ form_data }),
    }),
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
  approveEstimate: (id: string, scheduledSendAt?: string) =>
    request<EstimateDetail & { proposal_url?: string; sms_sent?: boolean; sms_scheduled?: boolean; scheduled_send_at?: string }>(
      `/api/estimates/${id}/approve`,
      {
        method: "POST",
        body: scheduledSendAt ? JSON.stringify({ scheduled_send_at: scheduledSendAt }) : undefined,
      }
    ),
  saveEstimatePdf: (id: string, fields: Record<string, unknown>[]) =>
    request<EstimateDetail>(`/api/estimates/${id}/save-pdf`, {
      method: "POST",
      body: JSON.stringify({ fields, send: false }),
    }),
  saveAndSendEstimate: (id: string, fields: Record<string, unknown>[]) =>
    request<EstimateDetail & { proposal_url?: string }>(`/api/estimates/${id}/save-pdf`, {
      method: "POST",
      body: JSON.stringify({ fields, send: true }),
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
  approveWithOverrides: (id: string, fieldOverrides?: Record<string, unknown>, extraFields?: Record<string, unknown>[]) =>
    request<EstimateDetail & { proposal_url?: string }>(`/api/estimates/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ field_overrides: fieldOverrides, extra_fields: extraFields }),
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
  getTimingAnalytics: (pv?: string) => request<Record<string, unknown>>(`/api/analytics/timing${pv ? `?pipeline_version=${pv}` : ""}`),

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
    request<{ key: string; label: string }[]>("/api/leads/decline-reason-presets"),
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
};


// --- Scheduling types ---

export interface ScheduleJobBody {
  lead_id: string;
  job_date: string;
  arrival_time?: string;
  estimated_duration_hours?: number;
  package_tier?: string;
  closed_price?: number;
  color_choice?: string;
  needs_test_spots?: boolean;
  gallons_estimate?: number;
  address?: string;
  zip_code?: string;
  customer_email?: string;
  customer_phone?: string;
  customer_name?: string;
  job_description?: string;
  admin_notes?: string;
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
  color_choice?: string;
  needs_test_spots?: boolean;
  gallons_estimate?: number;
  address?: string;
  zip_code?: string;
  customer_email?: string;
  customer_phone?: string;
  customer_name?: string;
  job_description?: string;
  admin_notes?: string;
  employee_ids?: string[];
  status?: string;
}

export interface ScheduledJob {
  id: string;
  lead_id: string;
  job_date: string;
  arrival_time: string;
  estimated_duration_hours: number;
  address: string;
  zip_code: string;
  customer_name: string;
  color_choice: string;
  needs_test_spots: boolean;
  gallons_estimate: number;
  job_description: string;
  status: string;
  google_event_id: string;
  service_type?: string;  // "fence_staining" | "power_washing" — drives calendar chip color
  // Admin/VA only
  package_tier?: string;
  closed_price?: number;
  customer_email?: string;
  customer_phone?: string;
  admin_notes?: string;
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
