import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type WrappedDigest } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  X, Loader2, TrendingUp, TrendingDown, Trophy, Flame, Crown, Sparkles,
  AlertTriangle, DollarSign, Calendar as CalendarIcon,
  Megaphone, Zap, ChevronRight, ChevronLeft, PartyPopper,
  Award, Target, Wrench, MessageSquare, Rocket, RefreshCw,
} from "lucide-react";

interface Props {
  cadence: "weekly" | "monthly";
  /** Optional override — for the manual preview button on Dashboard.
   * Weekly = Saturday end-date YYYY-MM-DD; monthly = YYYY-MM. */
  period?: string;
  onClose: () => void;
}

/** Spotify-Wrapped-style CEO digest. Walks through cards one at a time
 * (Sparkles → Revenue → Crew → Source → Biggest Deal → Most Profitable
 * → Anomalies → Wrap-up). Each card auto-advances if user doesn't tap;
 * tapping advances immediately. The popup is mounted by Dashboard with
 * popup-on-first-load + manual preview button. */
export default function WrappedModal({ cadence, period, onClose }: Props) {
  const navigate = useNavigate();
  const [digest, setDigest] = useState<WrappedDigest | null>(null);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [step, setStep] = useState(0);

  const fetchDigest = (force: boolean) => {
    setLoading(true);
    const fetcher = force
      ? (cadence === "weekly" ? api.regenerateWeeklyWrapped(period) : api.regenerateMonthlyWrapped(period))
      : (cadence === "weekly" ? api.getWeeklyWrapped(period) : api.getMonthlyWrapped(period));
    return fetcher
      .then((d) => { setDigest(d); setStep(0); })
      .catch(() => toast.error("Failed to load wrap"))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchDigest(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [cadence, period]);

  // Slide list — Score first (after intro) since it's the headline.
  // Briefing + Action sit late so the deterministic stats prime the read.
  const slides = (() => {
    if (!digest) return [];
    const arr: { node: React.ReactNode; key: string }[] = [
      { key: "intro", node: <IntroSlide digest={digest} /> },
    ];
    if (digest.score) arr.push({ key: "score", node: <ScoreSlide digest={digest} /> });
    arr.push({ key: "revenue", node: <RevenueSlide digest={digest} /> });
    arr.push({ key: "leads", node: <LeadsSlide digest={digest} /> });
    if (digest.top_employee) arr.push({ key: "crew", node: <CrewSlide digest={digest} /> });
    if (digest.top_source && digest.top_source.count > 0) arr.push({ key: "source", node: <SourceSlide digest={digest} /> });
    if (digest.biggest_deal) arr.push({ key: "biggest", node: <BiggestDealSlide digest={digest} /> });
    if (digest.most_profitable_job) arr.push({ key: "profit", node: <ProfitSlide digest={digest} /> });
    if (digest.busiest_day) arr.push({ key: "busy", node: <BusiestSlide digest={digest} /> });
    if (digest.bottleneck) arr.push({ key: "bottleneck", node: <BottleneckSlide digest={digest} onOpen={(link) => { onClose(); navigate(link); }} /> });
    if (digest.briefing && (digest.briefing.opening || digest.briefing.situation)) {
      arr.push({ key: "briefing", node: <BriefingSlide digest={digest} /> });
    }
    if (digest.recommended_action && digest.recommended_action.text) {
      arr.push({ key: "action", node: <ActionSlide digest={digest} onOpen={(link) => { onClose(); if (link) navigate(link); }} /> });
    }
    if (digest.changelog && digest.changelog.length > 0) {
      arr.push({ key: "shipped", node: <ChangelogSlide digest={digest} /> });
    }
    if (digest.anomalies.length > 0) arr.push({ key: "watchout", node: <AnomaliesSlide digest={digest} /> });
    arr.push({ key: "outro", node: <OutroSlide digest={digest} /> });
    return arr;
  })();

  // Auto-advance every 6s (skip the last one — let admin linger)
  useEffect(() => {
    if (slides.length === 0 || step >= slides.length - 1) return;
    const t = setTimeout(() => setStep((s) => Math.min(s + 1, slides.length - 1)), 6000);
    return () => clearTimeout(t);
  }, [step, slides.length]);

  const next = () => setStep((s) => Math.min(s + 1, slides.length - 1));
  const prev = () => setStep((s) => Math.max(s - 1, 0));

  return (
    <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="relative w-full max-w-md aspect-[9/14] sm:aspect-[9/13] rounded-2xl overflow-hidden shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: gradientFor(step),
          transition: "background 0.6s ease",
        }}
      >
        {/* Progress bars (Spotify style) — z-20 so tap zones don't eat clicks here. */}
        <div className="flex gap-1 px-3 pt-3 relative z-20">
          {slides.map((_, i) => (
            <div key={i} className="h-1 flex-1 bg-white/20 rounded-full overflow-hidden">
              <div
                className="h-full bg-white"
                style={{
                  width: i < step ? "100%" : i === step ? "100%" : "0%",
                  transition: i === step ? "width 6s linear" : "none",
                }}
              />
            </div>
          ))}
        </div>

        {/* Header — z-20 so the X button isn't covered by the right-side
            "next" tap zone below. */}
        <div className="flex items-center justify-between px-4 py-2 text-white/90 relative z-20">
          <div className="flex items-center gap-2 text-xs font-bold tracking-widest uppercase">
            <Sparkles className="h-3.5 w-3.5" />
            {cadence === "weekly" ? "Week Wrapped" : "Month Wrapped"}
            {digest?._from_cache && (
              <span className="text-[8px] font-normal text-white/50 normal-case tracking-normal">cached</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={async () => {
                if (regenerating) return;
                if (!confirm("Regenerate the wrap? This re-runs Claude (small token cost).")) return;
                setRegenerating(true);
                try { await fetchDigest(true); toast.success("Wrap regenerated"); }
                finally { setRegenerating(false); }
              }}
              className="text-white/60 hover:text-white p-1"
              title="Regenerate (re-runs Claude)"
              aria-label="Regenerate"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${regenerating ? "animate-spin" : ""}`} />
            </button>
            <button onClick={onClose} className="text-white/80 hover:text-white p-1" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Slide content */}
        <div className="flex-1 relative overflow-hidden">
          {loading && (
            <div className="absolute inset-0 grid place-items-center text-white">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          )}
          {!loading && digest && slides[step] && (
            <div key={slides[step].key} className="absolute inset-0 p-6 text-white animate-wrapped-slide">
              {slides[step].node}
            </div>
          )}
        </div>

        {/* Tap zones — left = prev, right = next */}
        <div className="absolute inset-0 flex pointer-events-none">
          <button onClick={prev} className="flex-1 pointer-events-auto" aria-label="Previous" tabIndex={-1} />
          <button onClick={next} className="flex-1 pointer-events-auto" aria-label="Next" tabIndex={-1} />
        </div>

        {/* Step controls — bottom, optional */}
        <div className="px-4 pb-3 flex items-center justify-between text-white/80 text-[10px] uppercase tracking-widest font-bold relative z-10">
          <button onClick={prev} disabled={step === 0} className="inline-flex items-center gap-0.5 disabled:opacity-30">
            <ChevronLeft className="h-3 w-3" /> back
          </button>
          <span>{step + 1} / {slides.length}</span>
          <button onClick={next} disabled={step >= slides.length - 1} className="inline-flex items-center gap-0.5 disabled:opacity-30">
            next <ChevronRight className="h-3 w-3" />
          </button>
        </div>
      </div>

      <style>{`
        @keyframes wrapped-slide {
          0% { opacity: 0; transform: translateY(12px) scale(0.98); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
        .animate-wrapped-slide { animation: wrapped-slide 0.5s ease-out forwards; }
      `}</style>
    </div>
  );
}

// Pick a gradient per slide so the whole reveal feels like a story, not a static modal.
function gradientFor(step: number): string {
  const palettes = [
    "linear-gradient(135deg, #1e1b4b 0%, #4c1d95 50%, #7c3aed 100%)",  // intro: deep purple
    "linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #334155 100%)",  // score: graphite
    "linear-gradient(135deg, #064e3b 0%, #047857 50%, #10b981 100%)",  // revenue: green
    "linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%)",                // leads: blue
    "linear-gradient(135deg, #7c2d12 0%, #ea580c 100%)",                // crew: orange
    "linear-gradient(135deg, #831843 0%, #ec4899 100%)",                // source: pink
    "linear-gradient(135deg, #581c87 0%, #c026d3 100%)",                // biggest: magenta
    "linear-gradient(135deg, #064e3b 0%, #059669 50%, #f59e0b 100%)",   // profit: green→gold
    "linear-gradient(135deg, #78350f 0%, #b45309 50%, #f59e0b 100%)",   // bottleneck: dark amber
    "linear-gradient(135deg, #0c0a09 0%, #1c1917 50%, #292524 100%)",   // briefing: near-black hedge fund
    "linear-gradient(135deg, #052e16 0%, #14532d 50%, #16a34a 100%)",   // action: action green
    "linear-gradient(135deg, #1e293b 0%, #475569 100%)",                // changelog: slate
    "linear-gradient(135deg, #7f1d1d 0%, #b91c1c 100%)",                // anomalies: red
    "linear-gradient(135deg, #1e1b4b 0%, #be185d 50%, #f59e0b 100%)",   // outro: triumph
  ];
  return palettes[Math.min(step, palettes.length - 1)];
}


// ─── Slides ──────────────────────────────────────────────────────────────

function BigStat({ value, label, sub }: { value: string; label: string; sub?: string }) {
  return (
    <div className="text-center">
      <p className="text-[10px] uppercase tracking-widest text-white/70 font-bold mb-2">{label}</p>
      <p className="text-5xl sm:text-6xl font-black tracking-tight">{value}</p>
      {sub && <p className="text-xs text-white/80 mt-2">{sub}</p>}
    </div>
  );
}

function ChangePill({ pct }: { pct: number | null }) {
  if (pct === null) return null;
  const up = pct >= 0;
  return (
    <div className={`inline-flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-full ${up ? "bg-white/20" : "bg-black/20"}`}>
      {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {up ? "+" : ""}{pct.toFixed(0)}% vs last
    </div>
  );
}

function IntroSlide({ digest }: { digest: WrappedDigest }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center gap-3">
      <PartyPopper className="h-12 w-12 text-white animate-pulse" />
      <p className="text-[10px] uppercase tracking-[0.3em] text-white/70 font-bold">{digest.label}</p>
      <h2 className="text-3xl sm:text-4xl font-black tracking-tight">Your {digest.cadence === "weekly" ? "week" : "month"}<br />in a snapshot.</h2>
      <p className="text-xs text-white/70 mt-3">Tap to advance · {digest.start} → {digest.end}</p>
    </div>
  );
}

function RevenueSlide({ digest }: { digest: WrappedDigest }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4">
      <DollarSign className="h-10 w-10 text-white/80" />
      <BigStat
        value={formatCurrency(digest.revenue)}
        label="Revenue closed"
        sub={`${digest.jobs_completed} job${digest.jobs_completed === 1 ? "" : "s"} completed`}
      />
      <ChangePill pct={digest.revenue_change_pct} />
      {digest.outstanding_total > 0 && (
        <p className="text-xs text-white/80 italic">
          + {formatCurrency(digest.outstanding_total)} still owed across {digest.outstanding_count} job{digest.outstanding_count === 1 ? "" : "s"}
        </p>
      )}
    </div>
  );
}

function LeadsSlide({ digest }: { digest: WrappedDigest }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4">
      <Zap className="h-10 w-10 text-white/80" />
      <BigStat
        value={String(digest.new_leads)}
        label="New leads"
        sub={`${digest.estimates_sent} estimate${digest.estimates_sent === 1 ? "" : "s"} sent · ${digest.close_rate.toFixed(0)}% close rate`}
      />
      <ChangePill pct={digest.new_leads_change_pct} />
    </div>
  );
}

function CrewSlide({ digest }: { digest: WrappedDigest }) {
  const e = digest.top_employee!;
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4">
      <Crown className="h-10 w-10 text-white/90" />
      <p className="text-[10px] uppercase tracking-widest text-white/70 font-bold">Top crew member</p>
      <p className="text-3xl sm:text-4xl font-black tracking-tight text-center">{e.name}</p>
      <div className="text-center">
        <p className="text-xs text-white/80">{e.hours.toFixed(1)} hours · {formatCurrency(e.labor_cost)} earned</p>
      </div>
    </div>
  );
}

function SourceSlide({ digest }: { digest: WrappedDigest }) {
  const labels: Record<string, string> = {
    ad: "Ads", referral: "Referrals", google_my_business: "Google Business",
    repeat_customer: "Repeat customers", yard_sign: "Yard signs", other: "Other",
  };
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4">
      <Megaphone className="h-10 w-10 text-white/90" />
      <p className="text-[10px] uppercase tracking-widest text-white/70 font-bold">Top lead source</p>
      <BigStat
        value={labels[digest.top_source.key] || digest.top_source.key}
        label="Where leads came from"
        sub={`${digest.top_source.count} lead${digest.top_source.count === 1 ? "" : "s"}`}
      />
    </div>
  );
}

function BiggestDealSlide({ digest }: { digest: WrappedDigest }) {
  const d = digest.biggest_deal!;
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4">
      <Flame className="h-10 w-10 text-white/90" />
      <p className="text-[10px] uppercase tracking-widest text-white/70 font-bold">Biggest deal</p>
      <p className="text-3xl font-black tracking-tight text-center">{d.customer_name || "Customer"}</p>
      <BigStat value={formatCurrency(d.amount)} label="Closed" sub={d.tier ? `${d.tier} package` : undefined} />
    </div>
  );
}

function ProfitSlide({ digest }: { digest: WrappedDigest }) {
  const j = digest.most_profitable_job!;
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4">
      <Trophy className="h-10 w-10 text-white/90" />
      <p className="text-[10px] uppercase tracking-widest text-white/70 font-bold">Most profitable job</p>
      <p className="text-2xl font-black tracking-tight text-center">{j.customer_name || "Customer"}</p>
      <div className="grid grid-cols-2 gap-3 text-center">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-white/70">Revenue</p>
          <p className="text-2xl font-black">{formatCurrency(j.revenue)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-widest text-white/70">Profit</p>
          <p className="text-2xl font-black">{formatCurrency(j.profit)}</p>
        </div>
      </div>
      <p className="text-xs text-white/80">{j.margin_pct.toFixed(0)}% margin</p>
    </div>
  );
}

function ScoreSlide({ digest }: { digest: WrappedDigest }) {
  const s = digest.score!;
  const tone = s.value >= 80 ? "from-emerald-300 to-emerald-100"
    : s.value >= 65 ? "from-amber-200 to-amber-50"
    : "from-rose-300 to-rose-100";
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 text-center">
      <Award className="h-10 w-10 text-white/85" />
      <p className="text-[10px] uppercase tracking-[0.3em] text-white/70 font-bold">Week Grade</p>
      <p className={`text-[8rem] sm:text-[9rem] font-black leading-none tracking-tighter bg-gradient-to-b ${tone} bg-clip-text text-transparent`}>
        {s.grade}
      </p>
      <p className="text-2xl font-black tracking-tight">{s.value} <span className="text-base text-white/60 font-bold">/ 100</span></p>
      <p className="text-xs text-white/85 max-w-xs leading-relaxed">{s.reason}</p>
    </div>
  );
}

function BottleneckSlide({ digest, onOpen }: { digest: WrappedDigest; onOpen: (link: string) => void }) {
  const b = digest.bottleneck!;
  const sevColor = b.severity === "high" ? "bg-red-500/30 text-red-50 border-red-300/40"
    : b.severity === "medium" ? "bg-orange-500/30 text-orange-50 border-orange-300/40"
    : "bg-yellow-500/30 text-yellow-50 border-yellow-300/40";
  return (
    <div className="h-full flex flex-col gap-3 px-1">
      <div className="flex items-center justify-between">
        <Target className="h-7 w-7 text-white/85" />
        <span className={`text-[10px] uppercase tracking-widest font-bold px-2 py-0.5 rounded-full border ${sevColor}`}>
          {b.severity} severity
        </span>
      </div>
      <p className="text-[10px] uppercase tracking-[0.3em] text-white/70 font-bold">Bottleneck</p>
      <h2 className="text-3xl font-black tracking-tight">{b.stage_label}</h2>
      <p className="text-xs text-white/85">{b.evidence}</p>
      <div className="space-y-1.5 mt-1 max-h-[35vh] overflow-y-auto">
        {b.stuck_leads.slice(0, 5).map((sl) => (
          <div key={sl.lead_id} className="bg-white/15 backdrop-blur-sm rounded-lg p-2 border border-white/20 flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold truncate">{sl.name}</p>
              <p className="text-[10px] text-white/70 truncate">{sl.address || sl.phone || "—"}</p>
            </div>
            <span className="text-[10px] font-mono uppercase tracking-wider bg-black/30 px-1.5 py-0.5 rounded">
              {sl.days_stuck}d
            </span>
          </div>
        ))}
      </div>
      <Button
        size="sm"
        variant="secondary"
        className="mt-auto w-full"
        onClick={() => onOpen(`/leads?column=${b.stage_key}`)}
      >
        Open these leads <ChevronRight className="h-3.5 w-3.5 ml-1" />
      </Button>
    </div>
  );
}

function BriefingSlide({ digest }: { digest: WrappedDigest }) {
  const b = digest.briefing!;
  return (
    <div className="h-full flex flex-col gap-3 px-1">
      <div className="flex items-center gap-2">
        <MessageSquare className="h-7 w-7 text-white/85" />
        {b.profanity_used && (
          <span className="text-[9px] uppercase tracking-widest font-bold bg-emerald-500/40 text-emerald-50 border border-emerald-300/40 px-1.5 py-0.5 rounded">
            spicy
          </span>
        )}
      </div>
      <p className="text-[10px] uppercase tracking-[0.3em] text-white/70 font-bold">Briefing</p>
      {b.opening && (
        <p className="text-xl sm:text-2xl font-black tracking-tight leading-tight">{b.opening}</p>
      )}
      {b.situation && (
        <p className="text-sm text-white/90 leading-relaxed">{b.situation}</p>
      )}
      {b.watch && (
        <div className="mt-auto bg-white/10 backdrop-blur-sm rounded-lg p-3 border border-white/20">
          <p className="text-[10px] uppercase tracking-widest text-white/70 font-bold mb-1">Watch next week</p>
          <p className="text-xs text-white/90">{b.watch}</p>
        </div>
      )}
    </div>
  );
}

function ActionSlide({ digest, onOpen }: { digest: WrappedDigest; onOpen: (link: string | null) => void }) {
  const a = digest.recommended_action!;
  return (
    <div className="h-full flex flex-col items-center justify-center gap-5 px-2 text-center">
      <Rocket className="h-10 w-10 text-white/85" />
      <p className="text-[10px] uppercase tracking-[0.3em] text-white/70 font-bold">Do this week</p>
      <p className="text-xl sm:text-2xl font-black tracking-tight leading-tight">{a.text}</p>
      {a.link && (
        <Button size="lg" variant="secondary" onClick={() => onOpen(a.link)} className="mt-2">
          {a.button_label} <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
      )}
    </div>
  );
}

function ChangelogSlide({ digest }: { digest: WrappedDigest }) {
  const entries = digest.changelog || [];
  return (
    <div className="h-full flex flex-col gap-3 px-1">
      <Wrench className="h-7 w-7 text-white/85" />
      <p className="text-[10px] uppercase tracking-[0.3em] text-white/70 font-bold">What shipped</p>
      <h2 className="text-2xl font-black tracking-tight">New in your dashboard</h2>
      <div className="space-y-1.5 mt-1 flex-1 overflow-y-auto">
        {entries.map((c) => (
          <div key={c.sha} className="bg-white/10 backdrop-blur-sm rounded-md p-2 border border-white/15">
            <p className="text-xs text-white/95 leading-snug">{c.subject}</p>
            <p className="text-[9px] text-white/50 mt-0.5 font-mono">{c.date} · {c.sha}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function BusiestSlide({ digest }: { digest: WrappedDigest }) {
  const b = digest.busiest_day!;
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4">
      <CalendarIcon className="h-10 w-10 text-white/90" />
      <p className="text-[10px] uppercase tracking-widest text-white/70 font-bold">Busiest day</p>
      <BigStat value={b.date} label="Most jobs" sub={`${b.jobs} jobs`} />
    </div>
  );
}

function AnomaliesSlide({ digest }: { digest: WrappedDigest }) {
  return (
    <div className="h-full flex flex-col justify-center gap-3 px-2">
      <AlertTriangle className="h-8 w-8 text-white/90 mx-auto" />
      <p className="text-[10px] uppercase tracking-widest text-white/70 font-bold text-center">What to watch</p>
      <div className="space-y-2">
        {digest.anomalies.slice(0, 4).map((a, i) => (
          <div key={i} className="bg-white/15 backdrop-blur-sm rounded-lg p-3 border border-white/20">
            <p className="text-sm font-bold">{a.title}</p>
            <p className="text-xs text-white/85 mt-1">{a.detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function OutroSlide({ digest }: { digest: WrappedDigest }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 text-center">
      <PartyPopper className="h-12 w-12 text-white animate-bounce" />
      <h2 className="text-3xl font-black tracking-tight">That&apos;s a wrap.</h2>
      <p className="text-sm text-white/85 leading-relaxed">
        {digest.cadence === "weekly" ? "See you next Saturday." : "See you next month."}
      </p>
      <div className="grid grid-cols-2 gap-3 mt-3 w-full max-w-xs">
        <div className="bg-white/15 backdrop-blur-sm rounded-lg p-2 border border-white/20">
          <p className="text-[10px] uppercase tracking-widest text-white/80">Revenue</p>
          <p className="text-lg font-black">{formatCurrency(digest.revenue)}</p>
        </div>
        <div className="bg-white/15 backdrop-blur-sm rounded-lg p-2 border border-white/20">
          <p className="text-[10px] uppercase tracking-widest text-white/80">Jobs</p>
          <p className="text-lg font-black">{digest.jobs_completed}</p>
        </div>
        <div className="bg-white/15 backdrop-blur-sm rounded-lg p-2 border border-white/20">
          <p className="text-[10px] uppercase tracking-widest text-white/80">New leads</p>
          <p className="text-lg font-black">{digest.new_leads}</p>
        </div>
        <div className="bg-white/15 backdrop-blur-sm rounded-lg p-2 border border-white/20">
          <p className="text-[10px] uppercase tracking-widest text-white/80">Close %</p>
          <p className="text-lg font-black">{digest.close_rate.toFixed(0)}%</p>
        </div>
      </div>
      <Button variant="secondary" size="sm" className="mt-3">Keep building</Button>
    </div>
  );
}
