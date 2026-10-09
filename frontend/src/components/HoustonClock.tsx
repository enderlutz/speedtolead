// Houston time, to the minute, in the corner of every screen.
//
// The team works from Honduras and elsewhere, and every rule in the app —
// the 8–9 AM send window, "it's late, schedule it", follow-up timing — is
// stated in Houston time. Alan (2026-10-09): "top right, no matter what
// part of the dashboard you're in". It ticks on the minute boundary itself
// rather than every 60 seconds from whenever the page loaded, so it is never
// most of a minute behind the wall clock, and it re-reads the time when the
// app comes back to the foreground after a phone has been asleep.
import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { CENTRAL } from "@/lib/date";
import { cn } from "@/lib/utils";

const FMT = new Intl.DateTimeFormat("en-US", { timeZone: CENTRAL, hour: "numeric", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat("en-US", { timeZone: CENTRAL, weekday: "short" });

function houstonTime(d: Date = new Date()): string {
  return FMT.format(d);
}

export default function HoustonClock({ className }: { className?: string }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timer = 0;
    const arm = () => {
      const untilNextMinute = 60_000 - (Date.now() % 60_000) + 50;
      timer = window.setTimeout(() => { setNow(new Date()); arm(); }, untilNextMinute);
    };
    arm();
    const wake = () => { if (document.visibilityState === "visible") setNow(new Date()); };
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);

  return (
    <span
      title={`${DAY.format(now)} ${houstonTime(now)} in Houston — the time every send window and follow-up rule is measured in`}
      className={cn(
        "inline-flex h-5 items-center gap-1.5 rounded-full bg-ink px-2.5 text-[11px] font-semibold tabular-nums text-gold-light shadow-md shadow-black/20 ring-1 ring-gold/40",
        className,
      )}
    >
      <Clock className="h-3 w-3 opacity-80" />
      {houstonTime(now)}
      <span className="font-medium text-white/50">Houston</span>
    </span>
  );
}
