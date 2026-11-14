// The Dashboard command center's data (GET /api/dashboard/command,
// backend/services/command_center.py). A section that failed on the server
// comes back as { error } so the rest of the page still shows.

export type SectionError = { error: string };
export type Priority = "red" | "amber" | "blue" | "green";

export interface Scorecard {
  month: string;
  booked: number;
  booked_last_to_date: number;
  jobs: number;
  jobs_last_to_date: number;
  collected: number;
  collected_last_to_date: number;
  goal: number;
  goal_set: boolean;
  goal_pct: number | null;
  pace: number;
  last_month: number;
  owed: number;
  avg_job: number | null;
  booked_list: DetailRow[];
  collected_list: DetailRow[];
  owed_list: DetailRow[];
  unmatched_quickbooks: number;
  collected_stripe: number;
  collected_quickbooks: number;
}

export interface DetailRow {
  lead_id: string;
  name: string;
  date: string;
  amount: number;
  note?: string;
}

export interface ActionItem {
  kind: string;
  title: string;
  lead_id: string;
  who: string;
  amount: number | null;
  since: string;
  waiting_hours: number | null;
  priority: Priority;
  action: string;
  href: string;
  detail: string;
}

export interface TodayJob {
  lead_id: string;
  name: string;
  address: string;
  order: number | null;
  crew: { person: string; task: string; helper: boolean }[];
  tasks: string[];
  color: string;
  stage: string;
  percent: number;
  done: boolean;
  status: string;
  services: string[];
  value: number;
  paid: number;
  left: number | null;
  blockers: string[];
}

export interface PipelineStage {
  key: string;
  label: string;
  count: number;
  value: number;
  avg_days: number | null;
  href: string;
  action: string;
}

export interface Pipeline {
  stages: PipelineStage[];
  bottleneck: { key: string; text: string; href: string; action: string } | null;
  note: string;
}

export interface Marketing {
  since: string;
  until: string;
  meta_connected: boolean;
  spend: number | null;
  meta_leads: number | null;
  leads: number;
  estimates: number;
  booked: number;
  cpl: number | null;
  conversion_pct: number | null;
  cost_per_booked: number | null;
  booked_from_ads: number;
  roas: number | null;
  note: string;
}

export interface WeekDay {
  date: string;
  label: string;
  jobs: number;
  crew: string[];
  no_crew: string[];
  tasks: string[];
  value_starting: number;
  held_unpaid: string[];
  capacity: number | null;
  utilization: number | null;
  empty: boolean;
  sunday: boolean;
}

export interface Week {
  days: WeekDay[];
  capacity_known: boolean;
}

export interface MoneyRow {
  lead_id: string;
  name: string;
  amount: number;
  due?: string;
  sent?: string;
  days?: number | null;
  overdue?: boolean;
  status?: string;
  job_value?: number;
}

export interface Collections {
  deposits: MoneyRow[];
  balances: MoneyRow[];
  quickbooks: MoneyRow[];
  quickbooks_count: number;
  due_this_week: MoneyRow[];
  due_this_week_total: number;
  deposits_total: number;
  overdue_total: number;
  owed_total: number;
  stripe_open_total: number;
  quickbooks_open_total: number;
}

export interface Alert {
  level: Priority;
  text: string;
  href: string;
}

export interface CommandCenter {
  generated_at: string;
  today: string;
  scorecard: Scorecard | SectionError;
  actions: ActionItem[] | SectionError;
  today_jobs: TodayJob[] | SectionError;
  pipeline: Pipeline | SectionError;
  marketing: Marketing | SectionError;
  week: Week | SectionError;
  collections: Collections | SectionError;
  alerts: Alert[] | SectionError;
}

export function isErr(x: unknown): x is SectionError {
  return !!x && typeof x === "object" && !Array.isArray(x) && "error" in (x as object);
}
