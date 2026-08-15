// Kanban stage definitions for the V2 (FENCE STAINING NEW AUTOMATION FLOW)
// GHL pipeline. Shared by the LeadsV2 board and the Lead Detail export
// picker, so it lives in lib/ rather than beside a page component — a module
// that exports both components and plain data can't Fast Refresh.

export type StageDef = {
  id: string;
  label: string;
  shortLabel: string;
  headerCls: string;
  bgCls: string;
  dotCls: string;
};

// Pre/Post-estimate "Call X" stages share one color per group — uniform
// cyan for pre-estimate warm-up calls, uniform indigo for post-estimate
// callback campaign. The number in the shortLabel (e.g. "Pre 1") tells
// you which call. Keeping the color uniform within each group avoids
// turning the kanban into a rainbow.
export const V2_STAGES: StageDef[] = [
  { id: "e77fa568-8dd1-4f66-83c3-fa70dbd4d570", label: "New Lead", shortLabel: "New", headerCls: "bg-gray-100 text-gray-800", bgCls: "bg-gray-50/50", dotCls: "bg-gray-400" },
  { id: "616087fa-4144-454e-b3d3-ff3669cb9461", label: "HOT LEAD_SEND ESTIMATE", shortLabel: "Hot", headerCls: "bg-red-100 text-red-800", bgCls: "bg-red-50/30", dotCls: "bg-red-500" },
  { id: "86fd0197-38ee-4999-bd26-4cf175aeba6b", label: "Address Follow Up", shortLabel: "Addr F/U", headerCls: "bg-orange-100 text-orange-800", bgCls: "bg-orange-50/30", dotCls: "bg-orange-500" },
  { id: "92585169-bbc1-42c5-945d-63caf780e0b1", label: "Responded to Address Follow Up", shortLabel: "Addr F/U+", headerCls: "bg-yellow-100 text-yellow-800", bgCls: "bg-yellow-50/30", dotCls: "bg-yellow-500" },
  { id: "dc3600f2-009b-4075-95fa-786823131416", label: "ESTIMATE SENT", shortLabel: "Sent", headerCls: "bg-sky-100 text-sky-800", bgCls: "bg-sky-50/30", dotCls: "bg-sky-500" },
  { id: "3ed8e7e3-6852-469c-bb72-effc1b6df76c", label: "ESTIMATE_FOLLOW UP LATER", shortLabel: "Est. F/U", headerCls: "bg-amber-100 text-amber-800", bgCls: "bg-amber-50/30", dotCls: "bg-amber-500" },
  { id: "8e1eb2cd-b9db-4eb7-aacf-901945cfca9b", label: "RESPONDED TO ESTIMATE", shortLabel: "Responded", headerCls: "bg-blue-100 text-blue-800", bgCls: "bg-blue-50/30", dotCls: "bg-blue-500" },
  { id: "147bd53b-3848-449d-b7c2-7a2cfad2a5f5", label: "Top Priority-Responded to Estimate", shortLabel: "Top Pri", headerCls: "bg-rose-100 text-rose-800", bgCls: "bg-rose-50/30", dotCls: "bg-rose-500" },
  { id: "f207a600-81c9-4150-941c-e977ea876929", label: "DECLINED ESTIMATE", shortLabel: "Declined", headerCls: "bg-slate-200 text-slate-700", bgCls: "bg-slate-50/40", dotCls: "bg-slate-500" },
  { id: "bbebbdac-0011-4253-9ed7-65522bafde02", label: "DEAL CLOSED & NOT SCHEDULED", shortLabel: "Closed", headerCls: "bg-emerald-100 text-emerald-800", bgCls: "bg-emerald-50/30", dotCls: "bg-emerald-500" },
  { id: "3eed5964-573f-445e-a181-1ee28068f066", label: "CLOSED & SCHEDULED", shortLabel: "Scheduled", headerCls: "bg-green-100 text-green-800", bgCls: "bg-green-50/30", dotCls: "bg-green-500" },
  { id: "c77b052f-845c-47e9-bba2-4cdba35a94d0", label: "COMPLETED JOB-HAPPY CUSTOMER- SEND REVIEW", shortLabel: "Happy", headerCls: "bg-teal-100 text-teal-800", bgCls: "bg-teal-50/30", dotCls: "bg-teal-500" },
  { id: "5f2cea8e-1f10-411b-b5fd-fa7ffa40cdcc", label: "COMPLETED JOB- UNHAPPY CUSTOMER", shortLabel: "Unhappy", headerCls: "bg-stone-200 text-stone-700", bgCls: "bg-stone-50/40", dotCls: "bg-stone-500" },
  { id: "d836628c-3094-4a63-b95a-8a5358d251d0", label: "LONG TERM NURTURE", shortLabel: "Nurture", headerCls: "bg-purple-100 text-purple-800", bgCls: "bg-purple-50/30", dotCls: "bg-purple-500" },
  { id: "8e17bd4c-5181-40b9-ba1e-bbe9b0547c01", label: "Responded to long term nurture", shortLabel: "Nurture+", headerCls: "bg-violet-100 text-violet-800", bgCls: "bg-violet-50/30", dotCls: "bg-violet-500" },
  { id: "0ca2e2a6-2990-4a5b-8ace-608393e39b5a", label: "Cold Leads (Never answered)", shortLabel: "Cold", headerCls: "bg-zinc-200 text-zinc-700", bgCls: "bg-zinc-50/40", dotCls: "bg-zinc-500" },
];
