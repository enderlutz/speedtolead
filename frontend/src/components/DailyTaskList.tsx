import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type DailyTask, type Lead, type CallDispositionOutcome, type DailyActivityEvent, type TouchedActor, type Scoreboard as ScoreboardData, type ScorePlayer } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import ScheduleJobModal from "@/components/ScheduleJobModal";
import { playSuccessSound } from "@/hooks/useNotificationSound";
import {
  Loader2, Phone, PhoneOff, Calendar, XCircle, RefreshCw, MessageSquare,
  CheckCircle2, Clock, CalendarClock, Search, X, AlertTriangle,
  CalendarDays, ChevronLeft, ChevronRight, User, ChevronDown, SlidersHorizontal,
  Flame, Trophy, Target, Sparkles,
} from "lucide-react";

// V2 pipeline stage IDs.
const NEW_LEAD_ID = "e77fa568-8dd1-4f66-83c3-fa70dbd4d570";
const HOT_LEAD_ID = "616087fa-4144-454e-b3d3-ff3669cb9461";
const ESTIMATE_SENT_ID = "dc3600f2-009b-4075-95fa-786823131416";
const EST_FU_LATER_ID = "3ed8e7e3-6852-469c-bb72-effc1b6df76c";
const RESPONDED_ID = "8e1eb2cd-b9db-4eb7-aacf-901945cfca9b";
const TOP_PRIORITY_ID = "147bd53b-3848-449d-b7c2-7a2cfad2a5f5";
const NURTURE_ID = "d836628c-3094-4a63-b95a-8a5358d251d0";
const NURTURE_RESPONDED_ID = "8e17bd4c-5181-40b9-ba1e-bbe9b0547c01";
const CLOSED_NOT_SCHEDULED_ID = "bbebbdac-0011-4253-9ed7-65522bafde02";
const SCHEDULED_STAGE_ID = "3eed5964-573f-445e-a181-1ee28068f066";
const DECLINED_STAGE_ID = "f207a600-81c9-4150-941c-e977ea876929";
const WAITING_VALUE = "status:waiting_updated_estimate"; // dashboard-only overlay
const COMPLETED_HAPPY_ID = "c77b052f-845c-47e9-bba2-4cdba35a94d0";
const COMPLETED_UNHAPPY_ID = "5f2cea8e-1f10-411b-b5fd-fa7ffa40cdcc";
// ── Sterling B (STERLING pipeline) stage IDs — twin of A ──────────────────
const B_NEW_LEAD_ID = "13dd5565-5d19-4ebd-bb84-5e57fdfc848e";
const B_CLOSED_NOT_SCHEDULED_ID = "43fa0566-e118-4e70-81ff-429c3afa22e3";
const B_SCHEDULED_STAGE_ID = "09d3a03d-0571-4fd8-b677-9a74d15a094d";
const B_DECLINED_STAGE_ID = "b5f54570-4077-4d83-97e7-328201373930";
const B_COMPLETED_HAPPY_ID = "64d3e3e1-c91c-49e8-86ba-e2d4c8699a72";
const B_COMPLETED_UNHAPPY_ID = "aac2bf8e-27ee-4301-81f6-9b5bf39b61ec";

// A closed-WON deal — either flavor (scheduled or not-yet-scheduled), A or B.
// Drives the green row + celebration on the Daily Task List.
function isWonStage(stageId: string): boolean {
  return stageId === CLOSED_NOT_SCHEDULED_ID || stageId === SCHEDULED_STAGE_ID
    || stageId === B_CLOSED_NOT_SCHEDULED_ID || stageId === B_SCHEDULED_STAGE_ID;
}
// Terminal stages that leave the ACTIVE daily-task queue (A + B): declined,
// closed & scheduled, or a completed job. They are NOT deleted — the "Show"
// dropdown surfaces declined + closed & scheduled so nothing is lost.
// "Closed — not scheduled" is deliberately NOT terminal (still needs booking).
const TERMINAL_STAGE_IDS = new Set<string>([
  DECLINED_STAGE_ID, SCHEDULED_STAGE_ID, COMPLETED_HAPPY_ID, COMPLETED_UNHAPPY_ID,
  B_DECLINED_STAGE_ID, B_SCHEDULED_STAGE_ID, B_COMPLETED_HAPPY_ID, B_COMPLETED_UNHAPPY_ID,
]);
function isTerminalStage(t: DailyTask): boolean {
  return TERMINAL_STAGE_IDS.has(t.stage_id);
}
const DECLINED_IDS = new Set<string>([DECLINED_STAGE_ID, B_DECLINED_STAGE_ID]);
const CLOSED_SCHEDULED_IDS = new Set<string>([SCHEDULED_STAGE_ID, B_SCHEDULED_STAGE_ID]);

// Post-estimate stages (A + B): the estimate is out and the deal isn't resolved.
// These belong on the TODAY queue even with NO scheduled follow-up, so a sent
// estimate is always in front of staff until it's booked or declined (owner
// request 2026-07-15 — "people we sent an estimate to should show even if nobody
// scheduled a callback"). They anchor to today only, not to any other date.
const POST_ESTIMATE_STAGE_IDS = new Set<string>([
  ESTIMATE_SENT_ID, RESPONDED_ID, TOP_PRIORITY_ID, EST_FU_LATER_ID,
  "8c082ba1-95ea-467e-a225-c1750b611bbe", // B — Estimate sent
  "f7a09296-a9bb-4d69-9398-28c495743b4b", // B — Responded to estimate
  "26a01635-5f91-415d-a6c1-671d15c6bd36", // B — Top priority
  "dacf7848-c812-4d33-86ef-d70fc4e4e479", // B — Estimate follow-up later
]);

// Pronounced "past due" treatment for carried-over leads — escalates with age so
// an aging lead reads as URGENT, never as a silent duplicate of today's row.
function overdueBadge(days: number): { cls: string; label: string; pulse: boolean } {
  const d = Math.max(days, 1);
  const label = `${d} day${d === 1 ? "" : "s"} past due!`;
  if (d >= 4) return { cls: "bg-red-600 text-white ring-1 ring-red-700", label, pulse: true };
  if (d >= 2) return { cls: "bg-red-500 text-white", label, pulse: false };
  return { cls: "bg-amber-100 text-amber-800", label, pulse: false };
}
// A post-estimate lead with NO scheduled follow-up is stalled — nobody has set
// the next step. Flag it so staff schedule a callback / kick off the process.
function needsProcess(t: DailyTask): boolean {
  return !t.next_follow_up?.due_at && POST_ESTIMATE_STAGE_IDS.has(t.stage_id);
}
// Row tint + left rail for a carried-over lead, escalating with days waiting.
function carriedTint(days: number): { row: string; rail: string } {
  if (days >= 4) return { row: "bg-red-100/70 hover:bg-red-100", rail: "border-l-[6px] border-red-600" };
  if (days >= 2) return { row: "bg-red-50/80 hover:bg-red-100/70", rail: "border-l-4 border-red-500" };
  return { row: "bg-amber-50/70 hover:bg-amber-100/60", rail: "border-l-4 border-amber-400" };
}

// Options in the per-row stage picker — every pipeline stage in order. A leads
// use A's stages; B leads use B's (so a B lead can't be moved to an A stage).
// "status:*" values set a dashboard-only overlay (no GHL push).
const STAGE_OPTIONS: { value: string; label: string }[] = [
  { value: NEW_LEAD_ID, label: "New lead" },
  { value: HOT_LEAD_ID, label: "Hot lead — send estimate" },
  { value: "86fd0197-38ee-4999-bd26-4cf175aeba6b", label: "Address follow-up" },
  { value: "92585169-bbc1-42c5-945d-63caf780e0b1", label: "Responded to address follow-up" },
  { value: ESTIMATE_SENT_ID, label: "Estimate sent" },
  { value: EST_FU_LATER_ID, label: "Estimate follow-up later" },
  { value: RESPONDED_ID, label: "Responded to estimate" },
  { value: TOP_PRIORITY_ID, label: "Top priority" },
  { value: WAITING_VALUE, label: "Waiting for updated estimate" },
  { value: NURTURE_ID, label: "Long-term nurture" },
  { value: NURTURE_RESPONDED_ID, label: "Responded to nurture" },
  { value: "0ca2e2a6-2990-4a5b-8ace-608393e39b5a", label: "Cold lead (never answered)" },
  { value: DECLINED_STAGE_ID, label: "Declined" },
  { value: CLOSED_NOT_SCHEDULED_ID, label: "Closed — not scheduled" },
  { value: SCHEDULED_STAGE_ID, label: "Closed & scheduled" },
  { value: "c77b052f-845c-47e9-bba2-4cdba35a94d0", label: "Completed — happy (send review)" },
  { value: "5f2cea8e-1f10-411b-b5fd-fa7ffa40cdcc", label: "Completed — unhappy" },
];
const B_STAGE_OPTIONS: { value: string; label: string }[] = [
  { value: B_NEW_LEAD_ID, label: "New lead" },
  { value: "3883dc86-e182-4633-9308-cbcc085abc02", label: "Hot lead — send estimate" },
  { value: "b382eea2-670c-4d3f-b2a1-a6053ce6e412", label: "Estimate scheduled" },
  { value: "a17b60c4-ea92-4703-bdb2-d7de1661ba1a", label: "No response to scheduling" },
  { value: "43a325dd-76ba-4aaf-aba1-f950ac2dd187", label: "Address follow-up" },
  { value: "a7f4039b-0425-492e-a50b-30bf37ad432f", label: "Responded to address follow-up" },
  { value: "8c082ba1-95ea-467e-a225-c1750b611bbe", label: "Estimate sent" },
  { value: "dacf7848-c812-4d33-86ef-d70fc4e4e479", label: "Estimate follow-up later" },
  { value: "f7a09296-a9bb-4d69-9398-28c495743b4b", label: "Responded to estimate" },
  { value: "26a01635-5f91-415d-a6c1-671d15c6bd36", label: "Top priority" },
  { value: WAITING_VALUE, label: "Waiting for updated estimate" },
  { value: "084b08b5-a217-4b54-9506-28dd68107468", label: "Long-term nurture" },
  { value: "969a4e4b-535c-4215-b91c-cbf6867754ad", label: "Responded to nurture" },
  { value: "64dccea5-049f-4c3d-9c26-1142170dd0b6", label: "Cold lead (never answered)" },
  { value: B_DECLINED_STAGE_ID, label: "Declined" },
  { value: B_CLOSED_NOT_SCHEDULED_ID, label: "Closed — not scheduled" },
  { value: B_SCHEDULED_STAGE_ID, label: "Closed & scheduled" },
  { value: B_COMPLETED_HAPPY_ID, label: "Completed — happy (send review)" },
  { value: B_COMPLETED_UNHAPPY_ID, label: "Completed — unhappy" },
  { value: "c54b66d1-0a65-40f7-b851-27d714b76936", label: "Painting upsell" },
];
function stageOptionsFor(t: DailyTask): { value: string; label: string }[] {
  return t.pipeline_version === "v2b" ? B_STAGE_OPTIONS : STAGE_OPTIONS;
}

type StageKey = "new_lead" | "hot" | "estimate_sent" | "responded" | "waiting" | "nurture" | "nurture_responded" | "other";
type TaskTab = "today" | "upcoming" | "date" | "all" | "activity";

// Options in the multi-select stage filter (empty selection = all stages).
const STAGE_FILTER_OPTIONS: { key: StageKey; label: string }[] = [
  { key: "new_lead", label: "New lead" },
  { key: "hot", label: "Hot lead — send estimate" },
  { key: "estimate_sent", label: "Estimate sent" },
  { key: "responded", label: "Responded to estimate" },
  { key: "waiting", label: "Waiting for updated estimate" },
  { key: "nurture", label: "Long-term nurture" },
  { key: "nurture_responded", label: "Responded to nurture" },
  { key: "other", label: "Other stages" },
];

const OUTCOME_LABELS: Record<string, string> = {
  closed: "Closed — won",
  objection_price: "Objection — price",
  objection_timing: "Objection — timing",
  objection_spouse: "Objection — spouse",
  objection_hoa: "Objection — HOA",
  objection_more_estimates: "Objection — Wants more estimates",
  no_answer: "No answer",
  voicemail: "Left voicemail",
  voicemail_texted: "Left voicemail & texted",
  callback: "Callback requested",
  other: "Other",
};
const OUTCOMES: CallDispositionOutcome[] = [
  "no_answer", "voicemail", "voicemail_texted", "callback", "objection_price", "objection_timing", "objection_spouse", "objection_hoa", "objection_more_estimates", "closed", "other",
];
const ACTION_LABELS: Record<string, string> = { call: "Call back", text: "Send text", other: "Follow up" };

const CST = "America/Chicago";
// Exact CST clock time with seconds, e.g. "5:31:28 PM".
function fmtTimeCST(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-US", { timeZone: CST, hour: "numeric", minute: "2-digit", second: "2-digit" });
}
// Full CST date + time with seconds, e.g. "Jul 6, 5:31:28 PM CST".
function fmtDateTimeCST(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const date = d.toLocaleDateString("en-US", { timeZone: CST, month: "short", day: "numeric" });
  return `${date}, ${fmtTimeCST(iso)} CST`;
}
// Central-time calendar day (YYYY-MM-DD) for a timestamp — used by the date view.
function ymdCST(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-CA", { timeZone: CST });
}
function todayCST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: CST });
}
// Add/subtract whole days from a YYYY-MM-DD string (noon anchor avoids DST slips).
function shiftDay(ymd: string, delta: number): string {
  const d = new Date(`${ymd}T12:00:00`);
  if (isNaN(d.getTime())) return ymd;
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function tomorrowCST(): string {
  return new Date(Date.now() + 86400000).toLocaleDateString("en-CA", { timeZone: CST });
}
// Human label for a picked date, e.g. "Tomorrow · Tue, Jul 7".
function dateLabel(ymd: string): string {
  if (!ymd) return "";
  const d = new Date(`${ymd}T12:00:00`);
  if (isNaN(d.getTime())) return ymd;
  const pretty = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  if (ymd === todayCST()) return `Today · ${pretty}`;
  if (ymd === tomorrowCST()) return `Tomorrow · ${pretty}`;
  if (ymd === shiftDay(todayCST(), -1)) return `Yesterday · ${pretty}`;
  return pretty;
}
function money(n: number): string {
  return n > 0 ? `$${n.toLocaleString()}` : "—";
}

// ── Owner / who-touched avatars ─────────────────────────────────────────────
const ACTOR_PALETTE = ["#0891b2", "#7c3aed", "#16a34a", "#ea580c", "#0d9488", "#9333ea", "#ca8a04", "#be123c"];
function actorColor(a: { name: string; sub: string }): string {
  const k = (a.sub || a.name || "").toLowerCase();
  if (k.includes("alan")) return "#2563eb";   // royal blue
  if (k.includes("olga")) return "#ec4899";   // pink
  let h = 0;
  for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
  return ACTOR_PALETTE[h % ACTOR_PALETTE.length];
}
function actorLetter(a: { name: string; sub: string }): string {
  const s = (a.name || a.sub || "?").trim();
  return (s[0] || "?").toUpperCase();
}
function ActorAvatar({ actor, size = 22, title }: { actor: { name: string; sub: string }; size?: number; title?: string }) {
  return (
    <span
      title={title || actor.name}
      className="inline-flex items-center justify-center rounded-full text-white font-semibold ring-2 ring-background shrink-0"
      style={{ background: actorColor(actor), width: size, height: size, fontSize: Math.round(size * 0.46) }}
    >
      {actorLetter(actor)}
    </span>
  );
}
function TouchedAvatars({ actors }: { actors: TouchedActor[] }) {
  if (!actors.length) return <span className="text-muted-foreground text-xs">—</span>;
  const shown = actors.slice(0, 3);
  return (
    <div className="flex -space-x-1.5">
      {shown.map((a, i) => (
        <ActorAvatar key={i} actor={a} title={`${a.name}${a.at ? ` · ${fmtDateTimeCST(a.at)}` : ""}`} />
      ))}
      {actors.length > 3 && (
        <span
          className="inline-flex items-center justify-center rounded-full bg-muted text-muted-foreground text-[10px] font-semibold ring-2 ring-background"
          style={{ width: 22, height: 22 }}
          title={actors.slice(3).map((a) => a.name).join(", ")}
        >
          +{actors.length - 3}
        </span>
      )}
    </div>
  );
}
// ── Gamification: confetti + scoreboard ─────────────────────────────────────
// One-shot confetti burst on a self-removing canvas overlay. No dependency.
function fireConfetti() {
  if (typeof document === "undefined") return;
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999";
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) { canvas.remove(); return; }
  const colors = ["#2563eb", "#ec4899", "#16a34a", "#f59e0b", "#8b5cf6", "#ef4444"];
  const parts = Array.from({ length: 150 }, () => ({
    x: canvas.width / 2 + (Math.random() - 0.5) * 240,
    y: canvas.height / 3,
    vx: (Math.random() - 0.5) * 13,
    vy: Math.random() * -15 - 4,
    size: Math.random() * 7 + 4,
    color: colors[(Math.random() * colors.length) | 0],
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
  }));
  const start = performance.now();
  const DURATION = 2400;
  const frame = (now: number) => {
    const t = now - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of parts) {
      p.vy += 0.35; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = Math.max(0, 1 - t / DURATION);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    }
    if (t < DURATION) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}

// Full-screen "Congratulations!" takeover on a closed-won deal. Sits just under
// the confetti canvas (z-9999) so the confetti rains over the green. Fades +
// pops in, auto-dismisses after ~4.5s, tap anywhere to close early.
function WinOverlay({ name, onClose }: { name: string; onClose: () => void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const inT = setTimeout(() => setShown(true), 20);      // trigger the enter transition
    const outT = setTimeout(onClose, 4500);
    return () => { clearTimeout(inT); clearTimeout(outT); };
  }, [onClose]);
  return (
    <div
      onClick={onClose}
      className={`fixed inset-0 z-[9000] flex flex-col items-center justify-center text-center px-6 cursor-pointer select-none
        bg-gradient-to-br from-green-500 via-emerald-500 to-green-600 text-white
        transition-all duration-500 ${shown ? "opacity-100" : "opacity-0"}`}
    >
      <div className={`transition-transform duration-500 ${shown ? "scale-100" : "scale-75"}`}>
        <div className="text-7xl mb-4 animate-bounce">🎉</div>
        <h1 className="text-5xl sm:text-7xl font-extrabold tracking-tight drop-shadow-lg">Congratulations!</h1>
        <p className="mt-4 text-2xl sm:text-3xl font-bold opacity-95">Closed won{name ? ` — ${name}` : ""}! 🥳</p>
        <p className="mt-8 text-sm uppercase tracking-widest opacity-80">tap anywhere to continue</p>
      </div>
    </div>
  );
}

// Team + head-to-head scoreboard. Reads /daily-tasks/scoreboard (calls,
// follow-ups, estimates sent, deals scheduled/closed → points). Estimates are
// the headline metric; scheduling/closing stack big bonuses on top.
function Scoreboard({ reloadKey }: { reloadKey: number }) {
  const [data, setData] = useState<ScoreboardData | null>(null);
  const [range, setRange] = useState<"today" | "week">("today");
  const celebratedRef = useRef<string>("");

  const fetchIt = useCallback(() => {
    api.getScoreboard().then(setData).catch(() => { /* non-fatal */ });
  }, []);
  useEffect(() => { fetchIt(); }, [fetchIt, reloadKey]);
  useEffect(() => {
    const id = window.setInterval(fetchIt, 30000);
    const onFocus = () => fetchIt();
    window.addEventListener("focus", onFocus);
    return () => { window.clearInterval(id); window.removeEventListener("focus", onFocus); };
  }, [fetchIt]);

  // Celebrate hitting the team's daily goal — once per day.
  useEffect(() => {
    if (!data) return;
    const { worked, target } = data.goal;
    if (target > 0 && worked >= target && celebratedRef.current !== data.date) {
      celebratedRef.current = data.date;
      fireConfetti();
      playSuccessSound();
    }
  }, [data]);

  if (!data || data.players.length === 0) return null;

  const goalPct = data.goal.target > 0 ? Math.min(100, Math.round((data.goal.worked / data.goal.target) * 100)) : 0;
  const stats = (p: ScorePlayer) => (range === "today" ? p.today : p.week);

  return (
    <div className="rounded-xl border bg-gradient-to-br from-muted/40 to-background p-4">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
        <div className="flex items-center gap-2">
          <Trophy className="h-4 w-4 text-amber-500" />
          <span className="font-semibold text-sm">Scoreboard</span>
          <div className="ml-1 inline-flex rounded-md border overflow-hidden text-xs">
            <button type="button" onClick={() => setRange("today")}
              className={`px-2.5 py-1 ${range === "today" ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted"}`}>Today</button>
            <button type="button" onClick={() => setRange("week")}
              className={`px-2.5 py-1 ${range === "week" ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted"}`}>This week</button>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-1 min-w-[220px] max-w-sm">
          <Target className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="flex-1">
            <div className="flex justify-between text-xs mb-1">
              <span className="text-muted-foreground">Leads worked today</span>
              <span className="font-semibold">{data.goal.worked} / {data.goal.target}</span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div className="h-full rounded-full transition-all"
                style={{ width: `${goalPct}%`, background: goalPct >= 100 ? "#16a34a" : "#2563eb" }} />
            </div>
          </div>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {data.players.map((p, i) => {
          const s = stats(p);
          const isLeader = range === "week" && i === 0 && data.players.length > 1 && s.points > 0;
          return (
            <div key={p.sub || p.name}
              className={`flex items-center gap-3 rounded-lg border bg-background p-3 ${isLeader ? "ring-2 ring-amber-400" : ""}`}>
              <ActorAvatar actor={p} size={38} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-sm truncate">{p.name}</span>
                  {isLeader && <Trophy className="h-3.5 w-3.5 text-amber-500 shrink-0" />}
                  {p.streak > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-xs font-semibold text-orange-500" title={`${p.streak}-day streak`}>
                      <Flame className="h-3.5 w-3.5" />{p.streak}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {s.estimate} est · {s.scheduled} sched · {s.closed} closed · {s.call} calls
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-xl font-bold leading-none">{s.points}</div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">pts</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Essential / Signature / Legacy tier prices, stacked. Signature is the headline
// tier so it's bold. Shows "—" when there's no estimate yet.
function TierPrices({ tiers }: { tiers?: { essential: number; signature: number; legacy: number } | null }) {
  const t = tiers || { essential: 0, signature: 0, legacy: 0 };
  if (t.essential <= 0 && t.signature <= 0 && t.legacy <= 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  const rows: [string, number, boolean][] = [
    ["E", t.essential, false],
    ["S", t.signature, true],
    ["L", t.legacy, false],
  ];
  return (
    <div className="space-y-0.5">
      {rows.map(([label, val, bold]) => (
        <div key={label} className="flex items-center justify-end gap-1 text-xs leading-tight">
          <span className="text-muted-foreground">{label}:</span>
          <span className={bold ? "font-semibold" : "font-medium"}>{val > 0 ? money(val) : "—"}</span>
        </div>
      ))}
    </div>
  );
}
// The Call cell: badge + last-action, and a click-to-open call log whose notes
// are editable inline (autosave on pause/blur + an explicit Save button).
function CallCell({ task, onLogCall, onNotesSaved }: { task: DailyTask; onLogCall: () => void; onNotesSaved: (leadId: string, dispositionId: string, notes: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const hasLog = task.dispositions.length > 0;
  return (
    <div className="relative inline-block" ref={ref}>
      <button
        onClick={() => (hasLog ? setOpen((o) => !o) : onLogCall())}
        title={hasLog ? "View / edit call log" : "Log a call"}
        className="text-left"
      >
        {task.called ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-800 hover:bg-emerald-200 px-2 py-0.5 text-[11px] font-medium">
            <Phone className="h-3 w-3" /> Called{task.call_count > 1 ? ` ×${task.call_count}` : ""}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 px-2 py-0.5 text-[11px] font-medium">
            <PhoneOff className="h-3 w-3" /> No call
          </span>
        )}
      </button>
      {task.last_action_at && (
        <div className="mt-1 space-y-0.5" title={fmtDateTimeCST(task.last_action_at)}>
          <div className="text-[10px] text-muted-foreground flex items-center gap-1">
            <Clock className="h-2.5 w-2.5" /> {fmtTimeCST(task.last_action_at)} CST
          </div>
          {task.last_action_by && (
            <div className="text-[10px] text-muted-foreground flex items-center gap-1">
              <User className="h-2.5 w-2.5" /> {task.last_action_by}
            </div>
          )}
        </div>
      )}
      {open && hasLog && (
        <div className="absolute z-30 left-0 top-full mt-1 w-80 max-w-[85vw] rounded-lg border bg-popover p-2 shadow-lg space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Call log — click a note to edit</p>
            <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground" title="Close">
              <X className="h-3 w-3" />
            </button>
          </div>
          {task.dispositions.map((d) => (
            <CallLogEntry key={d.id} leadId={task.id} disposition={d} onSaved={(notes) => onNotesSaved(task.id, d.id, notes)} />
          ))}
          <button onClick={() => { setOpen(false); onLogCall(); }} className="text-[11px] text-primary hover:underline">
            + Log another call
          </button>
        </div>
      )}
    </div>
  );
}

// One editable call-log entry — the outcome/author/time stay as the historical
// record; only the note is editable. Autosaves 800ms after you stop typing (and
// on blur), plus a Save button.
function CallLogEntry({ leadId, disposition, onSaved }: { leadId: string; disposition: DailyTask["dispositions"][number]; onSaved: (notes: string) => void }) {
  const [notes, setNotes] = useState(disposition.notes || "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const timer = useRef<number | null>(null);
  const savedRef = useRef(disposition.notes || "");

  const save = useCallback(async (val: string) => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    if (val === savedRef.current) return;
    setStatus("saving");
    try {
      await api.updateCallDispositionNotes(leadId, disposition.id, val);
      savedRef.current = val;
      onSaved(val);
      setStatus("saved");
      window.setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), 1500);
    } catch {
      setStatus("idle");
      toast.error("Couldn't save note");
    }
  }, [leadId, disposition.id, onSaved]);

  const onChange = (val: string) => {
    setNotes(val);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => save(val), 800);
  };
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const dirty = notes !== savedRef.current;
  return (
    <div className="border-l-2 border-primary/40 pl-2">
      <div className="text-[11px] font-medium">{OUTCOME_LABELS[disposition.outcome] || disposition.outcome}</div>
      <div className="text-[10px] text-muted-foreground">{disposition.disposed_by || "Staff"} · {fmtDateTimeCST(disposition.disposed_at)}</div>
      <textarea
        value={notes}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => save(notes)}
        rows={2}
        placeholder="Add a note…"
        className="mt-1 w-full text-[11px] rounded border border-input bg-background px-1.5 py-1 resize-y focus:outline-none focus:ring-1 focus:ring-ring"
      />
      <div className="flex items-center justify-between mt-0.5">
        <span className="text-[10px] text-muted-foreground">
          {status === "saving" ? "Saving…" : status === "saved" ? "Saved ✓" : dirty ? "Unsaved changes" : ""}
        </span>
        <button
          onClick={() => save(notes)}
          disabled={!dirty || status === "saving"}
          className="text-[10px] px-2 py-0.5 rounded bg-primary text-primary-foreground disabled:opacity-40 hover:bg-primary/90"
        >
          Save
        </button>
      </div>
    </div>
  );
}

function isUpcoming(t: DailyTask): boolean {
  const fu = t.next_follow_up;
  if (!fu?.due_at) return false;
  // A follow-up scheduled for a later Central day is "upcoming".
  return ymdCST(fu.due_at) > todayCST();
}
// Does this lead belong on the "Today" queue for the viewed day? Today is for
// leads with a scheduled action DUE — a follow-up due today, or overdue (which
// rolls forward so a missed callback never gets stranded on a past date). Leads
// nobody has started yet (no follow-up) stay in the Untapped list until someone
// works them — they do NOT flood Today. A specific past/future date shows
// exactly what was scheduled that day.
function belongsOnDate(t: DailyTask, dateYMD: string, isToday: boolean): boolean {
  const fu = t.next_follow_up;
  if (!fu?.due_at) {
    // No scheduled follow-up. Post-estimate leads still belong on TODAY so a sent
    // estimate never slips through the cracks; they don't anchor to any other day.
    return isToday && POST_ESTIMATE_STAGE_IDS.has(t.stage_id);
  }
  const due = ymdCST(fu.due_at);
  // TODAY collects everything due today PLUS all overdue (rolled forward).
  if (isToday) return due <= dateYMD;
  // Every lead appears on EXACTLY ONE day. A PAST day shows nothing that rolled
  // forward — an overdue follow-up has moved to today, so it must not re-appear
  // on its original date (that's the "duplicate"). Only a FUTURE day shows its
  // own scheduled follow-up. (dateYMD !== today here, so > today means future.)
  // The lost past-day record lives in the lead's Activity History tab instead.
  return due === dateYMD && dateYMD > todayCST();
}
// Overdue = the follow-up's day has already passed (all-day tasks aren't
// "overdue" mid-day; a timed task is overdue once its time has passed today).
function fuOverdue(fu: { due_at: string; all_day?: boolean } | null | undefined): boolean {
  if (!fu?.due_at) return false;
  if (fu.all_day) return ymdCST(fu.due_at) < todayCST();
  const d = new Date(fu.due_at);
  return !isNaN(d.getTime()) && d.getTime() < Date.now();
}
// Follow-up "when" label — all-day tasks show the day only, no time.
function fmtFollowUpWhen(fu: { due_at: string; all_day?: boolean }): string {
  if (!fu.due_at) return "";
  if (fu.all_day) {
    const d = new Date(fu.due_at);
    return isNaN(d.getTime()) ? "" : `${d.toLocaleDateString("en-US", { timeZone: CST, weekday: "short", month: "short", day: "numeric" })} · all day`;
  }
  const d = new Date(fu.due_at);
  return isNaN(d.getTime()) ? "" : d.toLocaleString("en-US", { timeZone: CST, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
// Effective stage for display + filtering (the waiting overlay wins).
function effectiveStage(t: DailyTask): string {
  if (t.task_status === "waiting_updated_estimate") return "waiting";
  return t.stage_key;
}
function currentStageValue(t: DailyTask): string {
  if (t.task_status === "waiting_updated_estimate") return WAITING_VALUE;
  return t.stage_id || (t.pipeline_version === "v2b" ? B_NEW_LEAD_ID : NEW_LEAD_ID);
}
function stageSelectCls(t: DailyTask): string {
  const s = effectiveStage(t);
  if (s === "waiting") return "border-purple-300 bg-purple-50 text-purple-800";
  if (s === "responded") return "border-blue-300 bg-blue-50 text-blue-800";
  if (s === "nurture_responded") return "border-violet-300 bg-violet-50 text-violet-800";
  if (s === "nurture") return "border-purple-300 bg-purple-50 text-purple-800";
  if (s === "hot") return "border-orange-300 bg-orange-50 text-orange-800";
  if (s === "estimate_sent") return "border-sky-300 bg-sky-50 text-sky-800";
  return "border-gray-300 bg-gray-50 text-gray-700";
}

export default function DailyTaskList({ leadId }: { leadId?: string } = {}) {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<DailyTask[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TaskTab>(() => {
    try { return (localStorage.getItem("at_tasks_tab") as TaskTab) || "today"; } catch { return "today"; }
  });
  const [dateYMD, setDateYMD] = useState<string>(() => {
    const today = todayCST();
    try {
      const saved = localStorage.getItem("at_tasks_date");
      // Resume a saved date only if it's today or in the future — never
      // resurrect a stale PAST date from a previous session. YYYY-MM-DD
      // strings sort chronologically, so a simple compare is enough. This is
      // what makes the "Today" view always land on the real current day even
      // if the tab was left open / reloaded on a later calendar day.
      return saved && saved >= today ? saved : today;
    } catch { return today; }
  });
  const [stageFilters, setStageFilters] = useState<StageKey[]>(() => {
    try {
      const raw = localStorage.getItem("at_tasks_stage");
      if (!raw) return [];
      if (raw.startsWith("[")) return JSON.parse(raw) as StageKey[];   // new array form
      return raw === "all" ? [] : [raw as StageKey];                   // migrate legacy single value
    } catch { return []; }
  });
  const [search, setSearch] = useState(() => {
    try { return localStorage.getItem("at_tasks_search") ?? ""; } catch { return ""; }
  });
  const [whoFilter, setWhoFilter] = useState(() => {
    try { return localStorage.getItem("at_tasks_who") ?? ""; } catch { return ""; }
  });
  // "Show" dropdown: the active work queue (default) or resolved-lead views that
  // are kept accessible instead of deleted (owner request).
  const [resolvedFilter, setResolvedFilter] = useState<"active" | "declined" | "closed_scheduled">("active");
  const [logFor, setLogFor] = useState<DailyTask | null>(null);
  const [noteFor, setNoteFor] = useState<DailyTask | null>(null);
  const [followUpFor, setFollowUpFor] = useState<DailyTask | null>(null);
  const [scheduleLead, setScheduleLead] = useState<Lead | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [celebration, setCelebration] = useState<string | null>(null);  // closed-won takeover
  // Bumped whenever the task list reloads so the Scoreboard refetches too
  // (a logged call / sent estimate updates the score right away).
  const [scoreTick, setScoreTick] = useState(0);
  // Hidden native date input behind the prominent date header — clicking the
  // header label opens its picker.
  const dateInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    api.getDailyTasks()
      .then((r) => setTasks(r.tasks))
      .catch(() => toast.error("Couldn't load the task list"))
      .finally(() => { setLoading(false); setScoreTick((t) => t + 1); });
  }, []);
  useEffect(() => { load(); }, [load]);

  // Keep the in-memory task list in sync after an inline call-note edit so
  // reopening the call log shows the saved text (no full reload needed).
  const onNotesSaved = useCallback((leadId: string, dispositionId: string, notes: string) => {
    setTasks((prev) => prev ? prev.map((t) => t.id !== leadId ? t : {
      ...t,
      dispositions: t.dispositions.map((d) => d.id === dispositionId ? { ...d, notes } : d),
    }) : prev);
  }, []);
  // Persist the tab + stage filter so returning from a lead restores them.
  useEffect(() => { try { localStorage.setItem("at_tasks_tab", tab); } catch { /* ignore */ } }, [tab]);
  useEffect(() => { try { localStorage.setItem("at_tasks_stage", JSON.stringify(stageFilters)); } catch { /* ignore */ } }, [stageFilters]);
  useEffect(() => { try { localStorage.setItem("at_tasks_search", search); } catch { /* ignore */ } }, [search]);
  useEffect(() => { try { localStorage.setItem("at_tasks_who", whoFilter); } catch { /* ignore */ } }, [whoFilter]);
  useEffect(() => { try { localStorage.setItem("at_tasks_date", dateYMD); } catch { /* ignore */ } }, [dateYMD]);

  const openSchedule = async (id: string) => {
    setBusyId(id);
    try {
      setScheduleLead(await api.getLead(id));
    } catch {
      toast.error("Couldn't open the scheduler for this lead");
    } finally {
      setBusyId(null);
    }
  };

  const changeStage = async (t: DailyTask, value: string) => {
    if (value === currentStageValue(t)) return;
    // Celebrate a fresh win: moving a lead INTO closed-won (from a non-won stage).
    const justWon = !value.startsWith("status:") && isWonStage(value) && !isWonStage(currentStageValue(t));
    setBusyId(t.id);
    try {
      if (value.startsWith("status:")) {
        await api.setTaskStatus(t.id, value.slice("status:".length));
      } else {
        await api.updateStage(t.id, value);
      }
      if (justWon) {
        fireConfetti();
        playSuccessSound();
        setCelebration(t.contact_name || "");
      } else {
        toast.success("Stage updated");
      }
      load();
    } catch {
      toast.error("Couldn't update the stage");
    } finally {
      setBusyId(null);
    }
  };

  const quickAction = async (t: DailyTask, stageId: string, confirmMsg: string, okMsg: string) => {
    if (!window.confirm(confirmMsg)) return;
    setBusyId(t.id);
    try {
      await api.updateStage(t.id, stageId);
      toast.success(okMsg);
      load();
    } catch {
      toast.error("Couldn't update the lead");
    } finally {
      setBusyId(null);
    }
  };

  const completeFollowUp = async (t: DailyTask) => {
    if (!t.next_follow_up) return;
    setBusyId(t.id);
    try {
      await api.completeFollowUp(t.next_follow_up.id);
      toast.success("Follow-up marked done");
      load();
    } catch {
      toast.error("Couldn't complete the follow-up");
    } finally {
      setBusyId(null);
    }
  };

  // Active working set: everything except terminal (declined / closed &
  // scheduled / completed) leads, which leave the list. Everything here carries
  // forward until it's resolved. (Single-lead embedded mode is unaffected.)
  const activeTasks = useMemo(() => (tasks ?? []).filter((t) => !isTerminalStage(t)), [tasks]);

  const shown = useMemo(() => {
    // Single-lead mode (embedded on the Lead Detail page): just this lead's row,
    // no tab / stage / search filtering.
    if (leadId) return (tasks ?? []).filter((t) => t.id === leadId);
    const q = search.trim().toLowerCase();
    const sortFn = (a: DailyTask, b: DailyTask) => {
      // Brand-new leads (arrived today, untouched) get the very top — speed to
      // lead wins deals.
      if (a.is_new !== b.is_new) return a.is_new ? -1 : 1;
      // Leads we've actually started (a follow-up is scheduled) rank ABOVE
      // post-estimate leads nobody has started the process on yet — those
      // "Start process" estimates sink to the bottom of the queue.
      const aNP = needsProcess(a), bNP = needsProcess(b);
      if (aNP !== bNP) return aNP ? 1 : -1;
      // Then carried-over (unfinished from a prior day) floats up, oldest first.
      if (a.carried_over !== b.carried_over) return a.carried_over ? -1 : 1;
      if (a.carried_over && b.carried_over && a.days_waiting !== b.days_waiting) return b.days_waiting - a.days_waiting;
      return (a.next_follow_up?.due_at || "").localeCompare(b.next_follow_up?.due_at || "");
    };

    // GLOBAL SEARCH: a name/address query surfaces the customer wherever they
    // are — any tab, any date, even declined/closed — so staff never have to
    // hunt tab-by-tab. It jumps straight to the matching customer(s).
    if (q) {
      let list = (tasks ?? []).filter((t) => (t.contact_name || "").toLowerCase().includes(q) || (t.address || "").toLowerCase().includes(q));
      if (whoFilter) list = list.filter((t) => (t.touched_by || []).some((a) => a.name === whoFilter));
      return [...list].sort(sortFn);
    }

    // "Show" dropdown — resolved leads are NOT deleted, just tucked behind here.
    if (resolvedFilter === "declined") return (tasks ?? []).filter((t) => DECLINED_IDS.has(t.stage_id)).sort(sortFn);
    if (resolvedFilter === "closed_scheduled") return (tasks ?? []).filter((t) => CLOSED_SCHEDULED_IDS.has(t.stage_id)).sort(sortFn);

    // Active queue (excludes terminal), tab-filtered.
    let list = activeTasks;
    if (tab === "today") list = list.filter((t) => !isUpcoming(t));
    else if (tab === "upcoming") list = list.filter((t) => isUpcoming(t));
    else if (tab === "date") { const isToday = dateYMD === todayCST(); list = list.filter((t) => belongsOnDate(t, dateYMD, isToday)); }
    if (stageFilters.length) list = list.filter((t) => stageFilters.includes(effectiveStage(t) as StageKey));
    if (whoFilter) list = list.filter((t) => (t.touched_by || []).some((a) => a.name === whoFilter));
    return [...list].sort(sortFn);
  }, [tasks, activeTasks, tab, stageFilters, search, whoFilter, dateYMD, leadId, resolvedFilter]);

  // Distinct people who have touched any loaded lead — powers the "Who" filter.
  const whoOptions = useMemo(() => {
    const names = new Set<string>();
    for (const t of tasks ?? []) for (const a of t.touched_by || []) if (a.name) names.add(a.name);
    return [...names].sort();
  }, [tasks]);

  // Embedded (single-lead) view: the scheduled call lives in the Lead column's
  // "Call back" pill, which scrolls off-screen in the narrow lead-detail card.
  // Pull it out so it can be surfaced in an always-visible banner above the table.
  const embeddedSchedule = useMemo(() => {
    if (!leadId) return null;
    const t = (shown ?? [])[0];
    if (!t || !t.next_follow_up) return null;
    return { task: t, fu: t.next_follow_up };
  }, [leadId, shown]);

  const dateCount = useMemo(() => {
    const isToday = dateYMD === todayCST();
    return activeTasks.filter((t) => belongsOnDate(t, dateYMD, isToday)).length;
  }, [activeTasks, dateYMD]);

  const carriedCount = useMemo(() => activeTasks.filter((t) => t.carried_over).length, [activeTasks]);

  const counts = useMemo(() => {
    const upcoming = activeTasks.filter(isUpcoming).length;
    return { today: activeTasks.length - upcoming, upcoming, all: activeTasks.length };
  }, [activeTasks]);

  return (
    <div className="space-y-3">
      {celebration !== null && <WinOverlay name={celebration} onClose={() => setCelebration(null)} />}
      {!leadId && (
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-sm text-muted-foreground">
          Work every lead until you hear a <span className="font-medium text-emerald-600">yes</span> (schedule) or a{" "}
          <span className="font-medium text-red-500">no</span> (decline). Anything left unworked{" "}
          {carriedCount > 0 ? (
            <span className="font-medium text-red-600">rolls into today's queue ({carriedCount} carried over)</span>
          ) : (
            <span>rolls into the next day's queue</span>
          )}{" "}
          with a red flag.
        </p>
        <Button size="sm" variant="outline" onClick={load} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>
      )}

      {!leadId && <Scoreboard reloadKey={scoreTick} />}

      {!leadId && (
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Tabs value={tab} onValueChange={(v) => {
          const next = v as TaskTab;
          // The "Today" tab must always open on the real current date, not
          // wherever the date navigator was last left.
          if (next === "date") setDateYMD(todayCST());
          setTab(next);
          setResolvedFilter("active");   // leaving the resolved-leads view
        }}>
          <TabsList>
            <TabsTrigger value="today">Untapped Leads ({counts.today})</TabsTrigger>
            <TabsTrigger value="upcoming">Upcoming ({counts.upcoming})</TabsTrigger>
            <TabsTrigger value="date">Today ({dateCount})</TabsTrigger>
            <TabsTrigger value="all">All ({counts.all})</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>
        </Tabs>
        {tab !== "activity" && (
        <div className="flex items-center gap-2 flex-wrap">
        <select
          value={resolvedFilter}
          onChange={(e) => setResolvedFilter(e.target.value as "active" | "declined" | "closed_scheduled")}
          className={`text-sm rounded-md border px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-ring ${resolvedFilter === "active" ? "bg-background" : "bg-amber-50 border-amber-300 text-amber-800"}`}
          title="Show the active work queue, or resolved leads that were kept (not deleted)"
        >
          <option value="active">Active queue</option>
          <option value="declined">Declined estimates</option>
          <option value="closed_scheduled">Closed &amp; scheduled</option>
        </select>
        <div className="relative w-56 max-w-full">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setSearch(""); }}
            placeholder="Search a lead by name or address…"
            className="w-full text-sm rounded-md border bg-background pl-8 pr-8 py-1.5 focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" title="Clear">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <StageMultiSelect selected={stageFilters} onChange={setStageFilters} />
        <select
          value={whoFilter}
          onChange={(e) => setWhoFilter(e.target.value)}
          title="Filter by who touched the lead"
          className="text-sm rounded-md border bg-background px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">Anyone</option>
          {whoOptions.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        </div>
        )}
      </div>
      )}

      {!leadId && tab === "activity" && <ActivityLog />}

      {/* Prominent, centered date header — calendar-app pattern so the viewed
          day is unmistakable. Chevrons step days; the big label opens a picker;
          "Jump to today" snaps back when you've navigated away. */}
      {!leadId && tab === "date" && (
        <div className="rounded-xl border bg-muted/30 px-3 py-3">
          <div className="flex items-center justify-center gap-2 sm:gap-4">
            <button
              onClick={() => setDateYMD(shiftDay(dateYMD, -1))}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border bg-background hover:bg-muted text-muted-foreground shrink-0"
              title="Previous day"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <div className="relative">
              <button
                onClick={() => { try { dateInputRef.current?.showPicker(); } catch { dateInputRef.current?.focus(); } }}
                className="flex items-center gap-2 rounded-lg px-3 py-1.5 hover:bg-background/80 transition-colors"
                title="Pick a date"
              >
                <CalendarDays className="h-5 w-5 text-primary shrink-0" />
                <span className="text-lg sm:text-xl font-bold tracking-tight whitespace-nowrap">{dateLabel(dateYMD)}</span>
                <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
              </button>
              <input
                ref={dateInputRef}
                type="date"
                value={dateYMD}
                onChange={(e) => setDateYMD(e.target.value || todayCST())}
                className="absolute inset-0 w-full h-full opacity-0 pointer-events-none"
                tabIndex={-1}
                aria-hidden
              />
            </div>
            <button
              onClick={() => setDateYMD(shiftDay(dateYMD, 1))}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border bg-background hover:bg-muted text-muted-foreground shrink-0"
              title="Next day"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
          <div className="mt-2 flex items-center justify-center gap-2 flex-wrap text-sm text-muted-foreground">
            <span>
              <span className="font-semibold text-foreground">{dateCount}</span> lead{dateCount === 1 ? "" : "s"} to work
              {dateYMD === todayCST() && " — includes overdue callbacks rolled forward"}
            </span>
            {dateYMD !== todayCST() && (
              <button
                onClick={() => setDateYMD(todayCST())}
                className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 text-primary px-2.5 py-0.5 text-xs font-medium hover:bg-primary/20"
              >
                <CalendarDays className="h-3 w-3" /> Jump to today
              </button>
            )}
          </div>
        </div>
      )}

      {/* Embedded lead view: always-visible scheduled-call banner so it isn't
          hidden in the horizontally-scrolling table's Lead column. */}
      {embeddedSchedule && (
        <button
          onClick={() => setFollowUpFor(embeddedSchedule.task)}
          title="Reschedule"
          className={`mb-3 w-full flex items-center gap-2 rounded-lg border px-3 py-2 text-sm text-left ${
            embeddedSchedule.fu && fuOverdue(embeddedSchedule.fu)
              ? "border-red-300 bg-red-50 text-red-800"
              : "border-amber-300 bg-amber-50 text-amber-900"
          }`}
        >
          <CalendarClock className="h-4 w-4 shrink-0" />
          <span>
            <span className="font-semibold">Scheduled call:</span>{" "}
            {ACTION_LABELS[embeddedSchedule.fu.action_type] || "Follow up"} · {fmtFollowUpWhen(embeddedSchedule.fu)}
          </span>
          <span className="ml-auto text-xs underline shrink-0">Reschedule</span>
        </button>
      )}

      {(leadId || tab !== "activity") && (loading && !tasks ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : shown.length === 0 ? (
        <div className="rounded-xl border bg-muted/20 p-6 text-center text-sm text-muted-foreground">
          {leadId ? "This lead isn't on the Daily Task List (it's archived or a test account)."
            : tab === "today" ? "🎉 No untapped leads right now."
            : tab === "upcoming" ? "No follow-ups scheduled for later."
            : tab === "date" ? `No tasks scheduled for ${dateLabel(dateYMD)}.`
            : "No leads match this filter."}
        </div>
      ) : (
        <div className="rounded-xl border overflow-x-auto bg-background">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="pl-4 pr-1 py-2.5 font-medium" title="Who has worked this lead">Who</th>
                <th className="px-4 py-2.5 font-medium">Lead</th>
                <th className="px-4 py-2.5 font-medium">Stage</th>
                <th className="px-4 py-2.5 font-medium">Call</th>
                <th className="px-4 py-2.5 font-medium">Notes</th>
                <th className="px-4 py-2.5 font-medium text-right">Estimate</th>
                <th className="px-4 py-2.5 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <tr
                  key={t.id}
                  className={`border-b last:border-0 transition-colors ${
                    isWonStage(t.stage_id) ? "bg-green-50 hover:bg-green-100/70"
                      : t.is_new ? "bg-sky-50/70 hover:bg-sky-100/60"
                      : t.carried_over ? carriedTint(t.days_waiting).row : "hover:bg-muted/20"
                  }`}
                >
                  {/* Who — owner / who-touched avatars (won leads get a green rail) */}
                  <td className={`pl-4 pr-1 py-3 align-top ${
                    isWonStage(t.stage_id) ? "border-l-4 border-green-500"
                      : t.is_new ? "border-l-4 border-sky-500"
                      : t.carried_over ? carriedTint(t.days_waiting).rail : ""}`}>
                    <TouchedAvatars actors={t.touched_by} />
                  </td>

                  {/* Lead */}
                  <td className="px-4 py-3 align-top">
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => navigate(`/leads/${t.id}`)} className="font-medium text-primary hover:underline text-left">
                        {t.contact_name || "Lead"}
                      </button>
                      {t.pipeline_version === "v2b" && (
                        <span
                          className="inline-flex items-center justify-center rounded bg-indigo-100 text-indigo-700 px-1 py-0.5 text-[10px] font-bold leading-none"
                          title="Sterling Leads B"
                        >
                          B
                        </span>
                      )}
                      {t.is_new && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-sky-100 text-sky-700 px-1.5 py-0.5 text-[10px] font-semibold"
                          title="Brand-new lead — just came in today. Call ASAP (speed to lead wins deals)."
                        >
                          <Sparkles className="h-2.5 w-2.5" />
                          New
                        </span>
                      )}
                      {t.carried_over && (() => {
                        const b = overdueBadge(t.days_waiting);
                        return (
                          <span
                            className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${b.cls} ${b.pulse ? "animate-pulse" : ""}`}
                            title={`Unworked since a prior day — ${b.label}`}
                          >
                            <AlertTriangle className="h-2.5 w-2.5" />
                            {b.label}
                          </span>
                        );
                      })()}
                      {needsProcess(t) && (
                        <button
                          onClick={() => setFollowUpFor(t)}
                          title="Estimate sent but no next step scheduled — click to schedule a follow-up and start the process"
                          className="inline-flex items-center gap-1 rounded-full bg-violet-600 text-white hover:bg-violet-700 px-1.5 py-0.5 text-[10px] font-semibold"
                        >
                          <CalendarClock className="h-2.5 w-2.5" />
                          Start process
                        </button>
                      )}
                    </div>
                    {t.address && <div className="text-xs text-muted-foreground truncate max-w-[200px]">{t.address}</div>}
                    {t.next_follow_up && (
                      <button
                        onClick={() => setFollowUpFor(t)}
                        title="Reschedule follow-up"
                        className={`mt-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                          fuOverdue(t.next_follow_up) ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800"
                        }`}
                      >
                        <CalendarClock className="h-2.5 w-2.5" />
                        {ACTION_LABELS[t.next_follow_up.action_type] || "Follow up"} · {fmtFollowUpWhen(t.next_follow_up)}
                      </button>
                    )}
                  </td>

                  {/* Stage — clickable picker */}
                  <td className="px-4 py-3 align-top">
                    <select
                      value={currentStageValue(t)}
                      disabled={busyId === t.id}
                      onChange={(e) => changeStage(t, e.target.value)}
                      className={`text-[11px] font-medium rounded-full border px-2 py-1 max-w-[150px] focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 ${stageSelectCls(t)}`}
                    >
                      {/* Fall back to the lead's real stage name if it's one we
                          don't list (keeps the picker accurate for any stage). */}
                      {!STAGE_OPTIONS.some((o) => o.value === currentStageValue(t)) && (
                        <option value={currentStageValue(t)}>{t.stage_label || "Current stage"}</option>
                      )}
                      {stageOptionsFor(t).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </td>

                  {/* Call status — click to log a call, hover for the full log */}
                  <td className="px-4 py-3 align-top">
                    <CallCell task={t} onLogCall={() => setLogFor(t)} onNotesSaved={onNotesSaved} />
                  </td>

                  {/* Notes — the client's connected note (form_data.additional_notes) */}
                  <td className="px-4 py-3 align-top max-w-[240px]">
                    <button onClick={() => setNoteFor(t)} className="text-left w-full group" title="Edit the client's note">
                      {t.client_note ? (
                        <div className="relative">
                          <div className="text-xs text-foreground truncate whitespace-pre-wrap line-clamp-2">{t.client_note}</div>
                          <div className="hidden group-hover:block absolute z-30 left-0 top-full mt-1 w-72 rounded-lg border bg-popover p-2 shadow-lg">
                            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Client note</p>
                            <div className="text-[11px] text-foreground whitespace-pre-wrap">{t.client_note}</div>
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-primary hover:underline">+ Add note</span>
                      )}
                    </button>
                  </td>

                  {/* Estimate — Essential / Signature / Legacy tier prices */}
                  <td className="px-4 py-3 align-top text-right whitespace-nowrap">
                    <TierPrices tiers={t.tier_prices} />
                  </td>

                  {/* Actions */}
                  <td className="px-4 py-3 align-top">
                    <div className="flex items-center justify-end gap-1">
                      <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setLogFor(t)}>
                        <MessageSquare className="h-3.5 w-3.5 mr-1" /> Log call
                      </Button>
                      <Button size="sm" className="h-7 px-2 text-xs bg-emerald-600 hover:bg-emerald-700 text-white" disabled={busyId === t.id} onClick={() => openSchedule(t.id)}>
                        <Calendar className="h-3.5 w-3.5 mr-1" /> Schedule
                      </Button>
                      <button
                        title="Reschedule follow-up"
                        onClick={() => setFollowUpFor(t)}
                        className="p-1 rounded text-amber-600 hover:bg-amber-50"
                      >
                        <CalendarClock className="h-4 w-4" />
                      </button>
                      <button
                        title="Decline (a 'no' — moves to DECLINED ESTIMATE)"
                        disabled={busyId === t.id}
                        onClick={() => quickAction(t, DECLINED_STAGE_ID, `Mark ${t.contact_name || "this lead"} as declined?`, "Marked declined")}
                        className="p-1 rounded text-red-600 hover:bg-red-50 disabled:opacity-40"
                      >
                        <XCircle className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {logFor && (
        <LogCallModal task={logFor} onClose={() => setLogFor(null)} onSaved={() => { setLogFor(null); load(); }} />
      )}

      {noteFor && (
        <ClientNoteModal task={noteFor} onClose={() => setNoteFor(null)} onSaved={() => { setNoteFor(null); load(); }} />
      )}

      {followUpFor && (
        <FollowUpModal
          task={followUpFor}
          onClose={() => setFollowUpFor(null)}
          onSaved={() => { setFollowUpFor(null); load(); }}
          onComplete={() => { completeFollowUp(followUpFor); setFollowUpFor(null); }}
        />
      )}

      {scheduleLead && (
        <ScheduleJobModal
          lead={scheduleLead}
          onClose={() => setScheduleLead(null)}
          onSaved={() => { setScheduleLead(null); toast.success("Scheduled"); load(); }}
        />
      )}
    </div>
  );
}

function todayYMD(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
function ymdOf(year: number, month0: number, day: number): string {
  return `${year}-${String(month0 + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** A bigger, nicer inline calendar to replace the native date input. Expands
 *  in-flow below the trigger (so it never gets clipped inside the modal). */
function DatePicker({ value, onChange }: { value: string; onChange: (ymd: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState(() => {
    const d = value ? new Date(`${value}T12:00:00`) : new Date();
    return { year: d.getFullYear(), month0: d.getMonth() };
  });

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const today = todayYMD();
  const grid = useMemo(() => {
    const startDow = new Date(cursor.year, cursor.month0, 1).getDay();
    const daysInMonth = new Date(cursor.year, cursor.month0 + 1, 0).getDate();
    const cells: ({ date: string; day: number } | null)[] = [];
    for (let i = 0; i < startDow; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push({ date: ymdOf(cursor.year, cursor.month0, d), day: d });
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [cursor]);

  const monthLabel = new Date(cursor.year, cursor.month0, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
  const shiftMonth = (delta: number) => setCursor((c) => {
    const m = c.month0 + delta;
    if (m < 0) return { year: c.year - 1, month0: 11 };
    if (m > 11) return { year: c.year + 1, month0: 0 };
    return { year: c.year, month0: m };
  });
  const pick = (ymd: string) => { onChange(ymd); setOpen(false); };
  // e.g. "Sat, 07/11/2026" — weekday prefix + numeric MM/DD/YYYY.
  const label = value
    ? (() => {
        const wd = new Date(`${value}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" });
        const [y, m, d] = value.split("-");
        return `${wd}, ${m}/${d}/${y}`;
      })()
    : "Pick a date";

  return (
    <div ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mt-1 w-full flex items-center justify-between border border-input rounded-md px-3 py-2 text-sm bg-background hover:bg-muted/40 focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <span className={value ? "" : "text-muted-foreground"}>{label}</span>
        <CalendarDays className="h-4 w-4 text-muted-foreground" />
      </button>
      {open && (
        <div className="mt-2 rounded-xl border bg-popover p-3 shadow-lg">
          <div className="flex items-center justify-between mb-2">
            <button type="button" onClick={() => shiftMonth(-1)} className="p-1.5 rounded-md hover:bg-muted text-muted-foreground" title="Previous month">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="text-sm font-semibold">{monthLabel}</div>
            <button type="button" onClick={() => shiftMonth(1)} className="p-1.5 rounded-md hover:bg-muted text-muted-foreground" title="Next month">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-[11px] font-medium text-muted-foreground text-center mb-1">
            {DOW.map((d) => <div key={d} className="py-1">{d}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {grid.map((cell, idx) => cell ? (
              <button
                type="button"
                key={idx}
                onClick={() => pick(cell.date)}
                className={`h-9 rounded-md text-sm flex items-center justify-center transition-colors ${
                  cell.date === value
                    ? "bg-primary text-primary-foreground font-semibold"
                    : cell.date === today
                      ? "ring-1 ring-primary text-foreground hover:bg-muted"
                      : "text-foreground hover:bg-muted"
                }`}
              >
                {cell.day}
              </button>
            ) : <div key={idx} className="h-9" />)}
          </div>
          <div className="flex items-center justify-between mt-2 pt-2 border-t">
            <button type="button" onClick={() => pick(today)} className="text-xs text-primary hover:underline">Today</button>
            <button type="button" onClick={() => setOpen(false)} className="text-xs text-muted-foreground hover:text-foreground">Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Multi-select stage filter — pick any number of stages (none = all). */
function StageMultiSelect({ selected, onChange }: { selected: StageKey[]; onChange: (next: StageKey[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const toggle = (k: StageKey) => onChange(selected.includes(k) ? selected.filter((x) => x !== k) : [...selected, k]);
  const label = selected.length === 0
    ? "All stages"
    : selected.length === 1
      ? (STAGE_FILTER_OPTIONS.find((o) => o.key === selected[0])?.label || "1 stage")
      : `${selected.length} stages`;
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-sm rounded-md border bg-background px-3 py-1.5 flex items-center gap-1.5 focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="max-w-[140px] truncate">{label}</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-56 rounded-lg border bg-popover p-1 shadow-lg">
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Filter by stage</span>
            {selected.length > 0 && (
              <button onClick={() => onChange([])} className="text-[11px] text-primary hover:underline">Clear</button>
            )}
          </div>
          {STAGE_FILTER_OPTIONS.map((o) => (
            <label key={o.key} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted cursor-pointer text-sm">
              <input type="checkbox" checked={selected.includes(o.key)} onChange={() => toggle(o.key)} className="h-3.5 w-3.5" />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** Activity tab — a filterable running log of who touched what lead, when. */
function ActivityLog() {
  const navigate = useNavigate();
  const [events, setEvents] = useState<DailyActivityEvent[]>([]);
  const [actors, setActors] = useState<{ name: string; sub: string }[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [actor, setActor] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);

  const fetchPage = useCallback(async (offset: number, replace: boolean) => {
    setLoading(true);
    try {
      const toIso = (v: string) => { if (!v) return undefined; const d = new Date(v); return isNaN(d.getTime()) ? undefined : d.toISOString(); };
      const r = await api.getDailyActivity({ q: q.trim(), actor, from_ts: toIso(from), to_ts: toIso(to), limit: 50, offset });
      setActors(r.actors);
      setTotal(r.total);
      setEvents((prev) => (replace ? r.events : [...prev, ...r.events]));
    } catch {
      toast.error("Couldn't load the activity log");
    } finally {
      setLoading(false);
    }
  }, [q, actor, from, to]);

  // Debounced reload whenever a filter changes (and on mount).
  useEffect(() => {
    const t = window.setTimeout(() => fetchPage(0, true), 250);
    return () => window.clearTimeout(t);
  }, [fetchPage]);

  const inputCls = "text-sm rounded-md border bg-background px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-ring";
  const anyFilter = !!(q || actor || from || to);

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-2 flex-wrap rounded-lg border bg-muted/20 p-2.5">
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">Lead</label>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Lead name…" className={`${inputCls} pl-7 w-44`} />
          </div>
        </div>
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">Who</label>
          <select value={actor} onChange={(e) => setActor(e.target.value)} className={inputCls}>
            <option value="">Everyone</option>
            {actors.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">From</label>
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">To</label>
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
        </div>
        {anyFilter && (
          <Button size="sm" variant="ghost" onClick={() => { setQ(""); setActor(""); setFrom(""); setTo(""); }}>Clear</Button>
        )}
      </div>

      {loading && events.length === 0 ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : events.length === 0 ? (
        <div className="rounded-xl border bg-muted/20 p-8 text-center text-sm text-muted-foreground">
          No activity for these filters. Default window is the last 14 days — set a <span className="font-medium">From</span> date to go further back.
        </div>
      ) : (
        <div className="rounded-xl border bg-background divide-y">
          {events.map((e) => (
            <div key={e.id} className="flex items-start gap-2.5 px-3 py-2">
              <ActorAvatar actor={{ name: e.actor_name, sub: e.actor_sub }} title={e.actor_name} />
              <div className="min-w-0 flex-1">
                <div className="text-sm">
                  <span className="font-medium">{e.actor_name || "Someone"}</span> {e.summary}
                  {e.lead_name && (
                    <> · <button onClick={() => navigate(`/leads/${e.lead_id}`)} className="text-primary hover:underline">{e.lead_name}</button></>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground">{fmtDateTimeCST(e.at)}</div>
              </div>
            </div>
          ))}
          {events.length < total && (
            <div className="p-3 text-center">
              <Button variant="outline" size="sm" onClick={() => fetchPage(events.length, false)} disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
                Load more ({events.length} of {total})
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Follow-up form fields — shared by the log-call and reschedule modals. */
function FollowUpFields({ action, setAction, date, setDate, time, setTime, allDay, setAllDay, note, setNote }: {
  action: string; setAction: (v: string) => void;
  date: string; setDate: (v: string) => void;
  time: string; setTime: (v: string) => void;
  allDay: boolean; setAllDay: (v: boolean) => void;
  note: string; setNote: (v: string) => void;
}) {
  const inputCls = "mt-1 w-full border border-input rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring";
  return (
    <div className="space-y-2">
      <div>
        <label className="text-xs font-semibold text-muted-foreground">Next action</label>
        <select value={action} onChange={(e) => setAction(e.target.value)} className={inputCls}>
          <option value="call">Call back</option>
          <option value="text">Send text</option>
          <option value="other">Follow up</option>
        </select>
      </div>
      <div>
        <label className="text-xs font-semibold text-muted-foreground">Date</label>
        <DatePicker value={date} onChange={setDate} />
      </div>
      <div className="flex items-end gap-3">
        <div className="w-32">
          <label className="text-xs font-semibold text-muted-foreground">Time</label>
          <input
            type="time"
            value={time}
            disabled={allDay}
            onChange={(e) => setTime(e.target.value)}
            className={`${inputCls} disabled:opacity-40 disabled:cursor-not-allowed`}
          />
        </div>
        <label className="flex items-center gap-2 text-xs cursor-pointer pb-2">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="h-3.5 w-3.5" />
          <span>All day (any time)</span>
        </label>
      </div>
      <div>
        <label className="text-xs font-semibold text-muted-foreground">Follow-up note</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Deciding with spouse, call after 5pm" className={inputCls} />
      </div>
    </div>
  );
}

function LogCallModal({ task, onClose, onSaved }: { task: DailyTask; onClose: () => void; onSaved: () => void }) {
  const [outcome, setOutcome] = useState<CallDispositionOutcome>("no_answer");
  const [notes, setNotes] = useState("");
  const [scheduleFu, setScheduleFu] = useState(false);
  const [fuAction, setFuAction] = useState("call");
  const [fuDate, setFuDate] = useState(todayYMD());
  const [fuTime, setFuTime] = useState("09:00");
  const [fuAllDay, setFuAllDay] = useState(false);
  const [fuNote, setFuNote] = useState("");
  const [saving, setSaving] = useState(false);

  const onOutcome = (o: CallDispositionOutcome) => {
    setOutcome(o);
    if (o === "callback") setScheduleFu(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.logCallDisposition(task.id, { outcome, notes: notes.trim() });
      if (scheduleFu) {
        await api.createFollowUp(task.id, {
          due_date: fuDate,
          time: fuAllDay ? "" : fuTime,
          all_day: fuAllDay,
          action_type: fuAction,
          note: fuNote.trim(),
        });
      }
      toast.success(scheduleFu ? "Call logged + follow-up scheduled" : "Call logged");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title="Log a call" subtitle={task.contact_name || "Lead"} onClose={onClose}>
      <div>
        <label className="text-xs font-semibold text-muted-foreground">Outcome</label>
        <select value={outcome} onChange={(e) => onOutcome(e.target.value as CallDispositionOutcome)} className="mt-1 w-full border border-input rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring">
          {OUTCOMES.map((o) => <option key={o} value={o}>{OUTCOME_LABELS[o]}</option>)}
        </select>
      </div>
      <div>
        <label className="text-xs font-semibold text-muted-foreground">Notes</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="What did the customer say?" className="mt-1 w-full border border-input rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring resize-none" />
      </div>
      <label className="flex items-center gap-2 text-sm cursor-pointer pt-1 border-t">
        <input type="checkbox" checked={scheduleFu} onChange={(e) => setScheduleFu(e.target.checked)} className="h-4 w-4 mt-2" />
        <span className="mt-2">Schedule a follow-up</span>
      </label>
      {scheduleFu && (
        <div className="rounded-lg border bg-muted/30 p-2.5">
          <FollowUpFields action={fuAction} setAction={setFuAction} date={fuDate} setDate={setFuDate} time={fuTime} setTime={setFuTime} allDay={fuAllDay} setAllDay={setFuAllDay} note={fuNote} setNote={setFuNote} />
        </div>
      )}
      <ModalFooter saving={saving} onClose={onClose} onSave={save} />
    </ModalShell>
  );
}

function FollowUpModal({ task, onClose, onSaved, onComplete }: { task: DailyTask; onClose: () => void; onSaved: () => void; onComplete: () => void }) {
  const existing = task.next_follow_up;
  const existingDate = existing ? new Date(existing.due_at) : null;
  const [action, setAction] = useState(existing?.action_type || "call");
  const [date, setDate] = useState(existingDate && !isNaN(existingDate.getTime())
    ? `${existingDate.getFullYear()}-${String(existingDate.getMonth() + 1).padStart(2, "0")}-${String(existingDate.getDate()).padStart(2, "0")}`
    : todayYMD());
  const [time, setTime] = useState(existingDate && !isNaN(existingDate.getTime())
    ? `${String(existingDate.getHours()).padStart(2, "0")}:${String(existingDate.getMinutes()).padStart(2, "0")}`
    : "09:00");
  const [allDay, setAllDay] = useState(!!existing?.all_day);
  const [note, setNote] = useState(existing?.note || "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.createFollowUp(task.id, {
        due_date: date,
        time: allDay ? "" : time,
        all_day: allDay,
        action_type: action,
        note: note.trim(),
      });
      toast.success(existing ? "Follow-up rescheduled" : "Follow-up scheduled");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save follow-up");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title={existing ? "Reschedule follow-up" : "Set follow-up"} subtitle={task.contact_name || "Lead"} onClose={onClose}>
      <FollowUpFields action={action} setAction={setAction} date={date} setDate={setDate} time={time} setTime={setTime} allDay={allDay} setAllDay={setAllDay} note={note} setNote={setNote} />
      <div className="flex items-center justify-between gap-2 pt-1">
        {existing ? (
          <Button size="sm" variant="ghost" className="text-emerald-600 hover:text-emerald-700" onClick={onComplete} disabled={saving}>
            <CheckCircle2 className="h-4 w-4 mr-1" /> Mark done
          </Button>
        ) : <span />}
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}

function ClientNoteModal({ task, onClose, onSaved }: { task: DailyTask; onClose: () => void; onSaved: () => void }) {
  const [note, setNote] = useState(task.client_note || "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.setClientNote(task.id, note.trim());
      toast.success("Note saved");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save the note");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title="Client note" subtitle={task.contact_name || "Lead"} onClose={onClose}>
      <p className="text-[11px] text-muted-foreground">
        Shared with the lead — this is the same "Additional Notes" shown on the lead's detail page.
      </p>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={5}
        placeholder="Notes about this customer…"
        className="mt-1 w-full border border-input rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring resize-none"
      />
      <ModalFooter saving={saving} onClose={onClose} onSave={save} />
    </ModalShell>
  );
}

function ModalShell({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border bg-background p-4 shadow-xl space-y-3 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div>
          <p className="text-sm font-semibold">{title}</p>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

function ModalFooter({ saving, onClose, onSave }: { saving: boolean; onClose: () => void; onSave: () => void }) {
  return (
    <div className="flex justify-end gap-2 pt-1">
      <Button size="sm" variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
      <Button size="sm" onClick={onSave} disabled={saving}>
        {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
        Save
      </Button>
    </div>
  );
}
