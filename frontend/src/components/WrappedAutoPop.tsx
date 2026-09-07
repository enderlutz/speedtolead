import { useState } from "react";
import { getCurrentUser } from "@/lib/api";
import WrappedModal from "@/components/WrappedModal";
import { isoFromYMD } from "@/lib/date";

// AUTO-pop trigger for the Spotify-Wrapped-style CEO digest. Lives at
// the AppLayout level so it can fire on ANY page the admin happens to
// be on Saturday / last-of-month — used to live on Dashboard only,
// which meant Alan never saw it because he doesn't open the home page.
//
// Behavior:
//   - Admin-only. Workers + VAs are skipped.
//   - Weekly: fires when today is Saturday and the current week-key
//     hasn't been seen yet (localStorage flag).
//   - Monthly: fires when today is the last day of the month and the
//     current month-key hasn't been seen yet. Monthly takes precedence
//     when both conditions are true the same day.
//   - First-ever seed: if the admin has never seen ANY wrap before,
//     today is treated as the initial pop regardless of weekday so the
//     feature shows itself once.
//
// Manual preview buttons live separately on the Dashboard page and
// don't interact with this auto-pop's localStorage flags.

type AutoState = { cadence: "weekly" | "monthly"; period: string } | null;

// Which wrap (if any) should pop right now. Reads the clock + localStorage,
// so it runs once from the useState initializer below rather than from an
// effect — the decision only ever needs making at mount, and doing it inline
// avoids the render-then-immediately-re-render the effect version caused.
function computeAutoPop(isAdmin: boolean): AutoState {
  if (!isAdmin) return null;
  const now = new Date();
  const isSaturday = now.getDay() === 6;
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const isLastDayOfMonth = now.getDate() === lastDay;

  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const saturday = new Date(now);
  saturday.setDate(saturday.getDate() + (6 - saturday.getDay()));
  // Local calendar fields — toISOString() rolled the key to the next day
  // during Houston evenings, re-showing a popup that had already been seen.
  const weekKey = isoFromYMD(saturday.getFullYear(), saturday.getMonth(), saturday.getDate());

  const everSeen = localStorage.getItem("at_wrapped_ever_seen");

  // Monthly takes precedence on its day (heavier reveal)
  if (isLastDayOfMonth) {
    const seenMonthly = localStorage.getItem(`at_wrapped_monthly_seen_${monthKey}`);
    if (!seenMonthly) return { cadence: "monthly", period: monthKey };
  }
  if (isSaturday || !everSeen) {
    const seenWeekly = localStorage.getItem(`at_wrapped_weekly_seen_${weekKey}`);
    if (!seenWeekly) return { cadence: "weekly", period: weekKey };
  }
  return null;
}

export default function WrappedAutoPop() {
  const currentUser = getCurrentUser();
  const isAdmin = currentUser?.role === "admin";
  const [open, setOpen] = useState<AutoState>(() => computeAutoPop(isAdmin));

  const close = () => {
    if (open) {
      localStorage.setItem("at_wrapped_ever_seen", "1");
      const key = open.cadence === "weekly"
        ? `at_wrapped_weekly_seen_${open.period}`
        : `at_wrapped_monthly_seen_${open.period}`;
      localStorage.setItem(key, "1");
    }
    setOpen(null);
  };

  if (!open || !isAdmin) return null;
  return <WrappedModal cadence={open.cadence} period={open.period} onClose={close} />;
}
