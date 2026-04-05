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

export function getCurrentUser(): { sub: string; name: string; role: string } | null {
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
  form_data: Record<string, string>;
  customer_responded: boolean;
  customer_response_text: string;
  viewed_at: string | null;
  created_at: string;
  updated_at: string;
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
}

export interface BreakdownItem {
  label: string;
  value: number;
  note?: string;
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
}

export interface PendingEstimate extends EstimateDetail {
  contact_name: string;
  contact_phone: string;
  address: string;
  location_label: string;
  kanban_column: string;
  priority: string;
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
  status: string;
  customer_name: string;
  address: string;
  service_type: string;
  tiers: { essential: number; signature: number; legacy: number };
  breakdown: BreakdownItem[];
  has_pdf: boolean;
  page_count: number;
  created_at: string;
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
  getMe: () => request<{ sub: string; name: string; role: string }>("/api/auth/me"),

  // Leads
  getLeads: (params?: Record<string, string>) => {
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return request<Lead[]>(`/api/leads${qs}`);
  },
  getArchivedLeads: (search?: string) => {
    const params = new URLSearchParams({ status: "archived" });
    if (search) params.set("search", search);
    return request<Lead[]>(`/api/leads?${params.toString()}`);
  },
  getLead: (id: string) => request<LeadDetail>(`/api/leads/${id}`),
  updateColumn: (id: string, kanban_column: string) =>
    request<Lead>(`/api/leads/${id}/column`, {
      method: "PUT",
      body: JSON.stringify({ kanban_column }),
    }),
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
  getPendingAction: () => request<PendingEstimate[]>("/api/estimates/pending-action"),
  approveEstimate: (id: string) =>
    request<EstimateDetail & { proposal_url?: string }>(`/api/estimates/${id}/approve`, { method: "POST" }),
  closeEstimate: (id: string, tier: string, closedAt: string) =>
    request<EstimateDetail>(`/api/estimates/${id}/close`, {
      method: "POST",
      body: JSON.stringify({ tier, closed_at: closedAt }),
    }),
  cancelEstimate: (id: string) =>
    request<EstimateDetail>(`/api/estimates/${id}/cancel`, { method: "POST" }),
  requestReview: (id: string) =>
    request<{ status: string; approval_token: string }>(`/api/estimates/${id}/request-review`, { method: "POST" }),
  getEstimatePdfUrl: (id: string) => `${BASE}/api/estimates/${id}/pdf`,
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

  // Analytics
  getKPIs: () => request<KPIs>("/api/analytics/kpis"),
  getFunnel: () => request<FunnelData>("/api/analytics/funnel"),
  getWeeklyCloseRate: () => request<WeeklyCloseRate[]>("/api/analytics/weekly-close-rate"),
  getByLocation: () => request<LocationStats>("/api/analytics/by-location"),
  getSpeedMetrics: () => request<Record<string, unknown>>("/api/analytics/speed"),
  getClosePatterns: () => request<Record<string, unknown>>("/api/analytics/close-patterns"),
  getCohorts: () => request<Record<string, unknown>[]>("/api/analytics/cohorts"),
  getRevenueInsights: () => request<Record<string, unknown>>("/api/analytics/revenue-insights"),

  // Notifications
  getRecentActivity: (limit?: number) =>
    request<ActivityEvent[]>(`/api/notifications/recent${limit ? `?limit=${limit}` : ""}`),
  getNotificationCount: () => request<{ count: number }>("/api/notifications/count"),

  // Settings
  getGhlPipelines: () => request<Record<string, unknown[]>>("/api/settings/ghl-pipelines"),
  getGhlFields: () => request<Record<string, unknown[]>>("/api/settings/ghl-fields"),
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
  getTemplatePageUrl: (pageNum: number) => `${BASE}/api/pdf-templates/page/${pageNum}`,
  updateFieldMap: (field_map: Record<string, unknown>) =>
    request("/api/pdf-templates/field-map", {
      method: "PUT",
      body: JSON.stringify({ field_map }),
    }),
};
