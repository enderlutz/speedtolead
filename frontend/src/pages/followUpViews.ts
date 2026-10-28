// The views of the Follow-Up Engine (the Follow-ups section of Design Lab
// since 2026-10-27), in a file of their own so Design Lab can draw the row
// and the page file stays components-only (hot reload wants that).
// The story, then what runs today, then where it's going.
export type FollowUpView = "overview" | "sterling" | "at" | "helpers" | "both" | "plan" | "engine";

export const FOLLOWUP_VIEWS: { key: FollowUpView; label: string; hint: string }[] = [
  { key: "overview", label: "Overview", hint: "The story in five pictures, what's changing, what Alan decided" },
  { key: "sterling", label: "Sterling", hint: "Every Sterling follow-up today, day by day, word for word" },
  { key: "at", label: "A&T's", hint: "Every A&T follow-up today, day by day, word for word" },
  { key: "helpers", label: "Helpers", hint: "The GHL Home-folder workflows, and the ones switched off" },
  { key: "both", label: "Both boards", hint: "Live: everyone with a card on both boards" },
  { key: "plan", label: "The plan", hint: "Cardone's year of touches, the way the customer meets them" },
  { key: "engine", label: "Engine", hint: "The dashboard's own text sender, off until the move is planned" },
];

export const isFollowUpView = (s: string | null | undefined): s is FollowUpView => FOLLOWUP_VIEWS.some((v) => v.key === s);
