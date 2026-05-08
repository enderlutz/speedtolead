import { useEffect, useState } from "react";
import { api, type WrappedDigest } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  X, Loader2, TrendingUp, TrendingDown, Trophy, Flame, Crown, Sparkles,
  AlertTriangle, DollarSign, Calendar as CalendarIcon,
  Megaphone, Zap, ChevronRight, ChevronLeft, PartyPopper,
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
  const [digest, setDigest] = useState<WrappedDigest | null>(null);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(0);

  useEffect(() => {
    setLoading(true);
    const fetcher = cadence === "weekly"
      ? api.getWeeklyWrapped(period)
      : api.getMonthlyWrapped(period);
    fetcher.then(setDigest).catch(() => toast.error("Failed to load wrap")).finally(() => setLoading(false));
  }, [cadence, period]);

  // Build the slide list dynamically — only include slides that have data.
  const slides = (() => {
    if (!digest) return [];
    const arr: { node: React.ReactNode; key: string }[] = [
      { key: "intro", node: <IntroSlide digest={digest} /> },
      { key: "revenue", node: <RevenueSlide digest={digest} /> },
      { key: "leads", node: <LeadsSlide digest={digest} /> },
    ];
    if (digest.top_employee) arr.push({ key: "crew", node: <CrewSlide digest={digest} /> });
    if (digest.top_source && digest.top_source.count > 0) arr.push({ key: "source", node: <SourceSlide digest={digest} /> });
    if (digest.biggest_deal) arr.push({ key: "biggest", node: <BiggestDealSlide digest={digest} /> });
    if (digest.most_profitable_job) arr.push({ key: "profit", node: <ProfitSlide digest={digest} /> });
    if (digest.busiest_day) arr.push({ key: "busy", node: <BusiestSlide digest={digest} /> });
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
        {/* Progress bars (Spotify style) */}
        <div className="flex gap-1 px-3 pt-3">
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

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 text-white/90">
          <div className="flex items-center gap-2 text-xs font-bold tracking-widest uppercase">
            <Sparkles className="h-3.5 w-3.5" />
            {cadence === "weekly" ? "Week Wrapped" : "Month Wrapped"}
          </div>
          <button onClick={onClose} className="text-white/80 hover:text-white p-1">
            <X className="h-4 w-4" />
          </button>
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
    "linear-gradient(135deg, #064e3b 0%, #047857 50%, #10b981 100%)",  // revenue: green
    "linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%)",                // leads: blue
    "linear-gradient(135deg, #7c2d12 0%, #ea580c 100%)",                // crew: orange
    "linear-gradient(135deg, #831843 0%, #ec4899 100%)",                // source: pink
    "linear-gradient(135deg, #581c87 0%, #c026d3 100%)",                // biggest: magenta
    "linear-gradient(135deg, #064e3b 0%, #059669 50%, #f59e0b 100%)",   // profit: green→gold
    "linear-gradient(135deg, #312e81 0%, #6366f1 100%)",                // busiest: indigo
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
