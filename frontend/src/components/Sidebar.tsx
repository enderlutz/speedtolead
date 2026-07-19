import { NavLink } from "react-router-dom";
import { LayoutDashboard, Users, BarChart3, Settings2, Menu, X, Zap, TrendingUp, LogOut, DollarSign, Mic, HardHat, Calendar, Calculator, Gauge, FileText, Sun, Brain, MapPin, ListChecks } from "lucide-react";
// Icons removed from this import when their nav items were hidden 2026-06-07:
//   UsersRound (A&T Leads), ClipboardCheck (Sent Log), Brain (AI Fence Est.),
//   Sparkles (Agents). When restoring any of those nav rows, re-add the
//   matching icon here.
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, type KPIs, getCurrentUser, clearToken, hasPerm } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";

// `allowedRoles` (if set) restricts visibility to listed roles. Items without
// it are visible to admin + va but hidden from workers — workers only see
// items that explicitly include "worker" in allowedRoles.
//
// NAV DECLUTTER — 2026-06-07
// Four items hidden from the sidebar per client direction (post-first-principles
// audit). Routes are still mounted in App.tsx and pages are intact, so old
// bookmarks keep working; we just don't surface them in nav while the team
// focuses on the active sales/scheduling flow. To restore any of them, uncomment
// the matching line below.
// Hidden:
//   - A&T Leads ("/old-leads")     — legacy v1 lead view
//   - Sent Log ("/sent-log")       — older lead-state view
//   - Agents ("/agents")           — experimental AI agents page
//   - AI Fence Est. ("/ai-fence")  — internal dev tool
// `perm` (if set) is the permission key that gates this item — visible only
// when the user has it. `restrictTo` is the legacy fragned-only escape hatch.
const NAV_ITEMS: { to: string; icon: typeof LayoutDashboard; label: string; restrictTo?: string; restrictToAny?: string[]; perm?: string }[] = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard", perm: "dashboard" },
  { to: "/daily-tasks", icon: ListChecks, label: "The Hit List", perm: "dashboard" },
  { to: "/leads", icon: Users, label: "Sterling Leads A", perm: "leads" },
  { to: "/leads-b", icon: Users, label: "Sterling Leads B", perm: "leads" },
  // { to: "/leads/painting-upsell", icon: Paintbrush, label: "Painting Upsell", perm: "painting_upsell" }, // hidden 2026-07-14 (page/route kept)
  // { to: "/old-leads", icon: UsersRound, label: "A&T Leads" },   // hidden 2026-06-07
  // { to: "/sent-log", icon: ClipboardCheck, label: "Sent Log" }, // hidden 2026-06-07
  { to: "/analytics", icon: BarChart3, label: "Analytics", perm: "analytics" },
  { to: "/calls", icon: Mic, label: "Call Coach", perm: "calls" },
  { to: "/training", icon: Brain, label: "Training", perm: "training" },
  { to: "/crew", icon: HardHat, label: "Payroll", perm: "payroll" },
  { to: "/accounting", icon: Calculator, label: "Accounting", perm: "accounting" },
  { to: "/calendar", icon: Calendar, label: "Job Calendar", perm: "calendar" },
  { to: "/crew-schedule", icon: HardHat, label: "Crew Schedule", perm: "calendar" },
  { to: "/pm-hq", icon: HardHat, label: "Project Manager", perm: "assign_crew" },
  { to: "/crew-stats", icon: BarChart3, label: "Crew Stats", restrictToAny: ["fragned", "alanbonner"] },
  { to: "/my-schedule", icon: Sun, label: "My Schedule", perm: "my_schedule" },
  { to: "/estimator", icon: MapPin, label: "Estimator", perm: "estimator" },
  { to: "/invoice-queue", icon: FileText, label: "Invoice Queue", perm: "invoice_queue" },
  { to: "/revenue", icon: TrendingUp, label: "Revenue", restrictToAny: ["fragned", "alanbonner"] },
  // { to: "/agents", icon: Sparkles, label: "Agents", allowedRoles: ["admin"] }, // hidden 2026-06-07
  { to: "/pricing", icon: DollarSign, label: "Pricing", perm: "pricing" },
  // { to: "/ai-fence", icon: Brain, label: "AI Fence Est.", restrictTo: "fragned" }, // hidden 2026-06-07
  { to: "/internal", icon: Gauge, label: "Internal", restrictTo: "fragned" },
  { to: "/settings", icon: Settings2, label: "Settings", perm: "settings" },
];

export function MobileHeader({ onToggle }: { onToggle: () => void }) {
  return (
    <div className="md:hidden flex items-center justify-between px-4 py-3 border-b border-sidebar-border bg-sidebar sticky top-0 z-40">
      <div className="flex items-center gap-2">
        <div className="h-7 w-7 rounded-lg bg-primary flex items-center justify-center">
          <Zap className="h-4 w-4 text-primary-foreground" />
        </div>
        <span className="text-sm font-bold text-sidebar-foreground tracking-tight">{"Sterling Fence Staining"}</span>
      </div>
      <button onClick={onToggle} className="p-2 rounded-md text-sidebar-foreground hover:bg-sidebar-accent transition-colors">
        <Menu className="h-5 w-5" />
      </button>
    </div>
  );
}

function SidebarRevenueWidget() {
  const [kpis, setKpis] = useState<KPIs | null>(null);

  useEffect(() => {
    api.getKPIs().then(setKpis).catch(() => {});
  }, []);

  const revenue = kpis?.revenue_pipeline ?? 0;
  const sent = kpis?.estimates_sent ?? 0;
  const goal = kpis?.goal_target ?? 10;
  const current = kpis?.goal_current ?? 0;
  const pct = goal > 0 ? Math.min(Math.round((current / goal) * 100), 100) : 0;

  return (
    <div className="px-4 py-3 border-t border-sidebar-border">
      <div className="flex items-center gap-1.5 mb-2">
        <TrendingUp className="h-3 w-3 text-sidebar-foreground/50" />
        <p className="text-[10px] uppercase tracking-widest text-sidebar-foreground/40 font-semibold">Revenue</p>
      </div>
      <p className="text-lg font-bold text-sidebar-foreground">{formatCurrency(revenue)}</p>
      <p className="text-[10px] text-sidebar-foreground/50 mt-0.5">{sent} estimates sent this month</p>
      {/* Goal progress bar */}
      <div className="mt-2.5">
        <div className="flex justify-between text-[10px] mb-1">
          <span className="text-sidebar-foreground/50">2x Goal</span>
          <span className="text-sidebar-foreground/70 font-medium">{current}/{goal}</span>
        </div>
        <div className="h-1.5 rounded-full bg-sidebar-accent overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-primary to-emerald-400 transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function SidebarFooter() {
  const navigate = useNavigate();
  const user = getCurrentUser();
  const initials = (user?.name || "AT").slice(0, 2).toUpperCase();

  const handleLogout = () => {
    clearToken();
    navigate("/login");
  };

  return (
    <div className="px-4 py-4 border-t border-sidebar-border shrink-0">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <div className="h-7 w-7 rounded-full bg-sidebar-accent flex items-center justify-center text-[10px] font-bold text-sidebar-foreground shrink-0">
            {initials}
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-medium text-sidebar-foreground/80 truncate">{user?.name || "User"}</p>
            <p className="text-[10px] text-sidebar-foreground/40 capitalize">{user?.role || "va"}</p>
          </div>
        </div>
        <button
          onClick={handleLogout}
          className="p-1.5 rounded-md text-sidebar-foreground/40 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
          title="Sign out"
        >
          <LogOut className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export default function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const location = useLocation();

  useEffect(() => { onClose(); }, [location.pathname, onClose]);

  return (
    <>
      {open && <div className="fixed inset-0 bg-black/50 z-40 md:hidden backdrop-blur-sm" onClick={onClose} />}

      <aside
        className={`
          fixed top-0 left-0 z-50 h-dvh w-60 bg-sidebar border-r border-sidebar-border flex flex-col
          transition-transform duration-200 ease-in-out overflow-y-auto
          md:static md:translate-x-0 md:z-auto md:shrink-0
          ${open ? "translate-x-0" : "-translate-x-full"}
        `}
      >
        {/* Logo */}
        <div className="px-4 py-5 border-b border-sidebar-border flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center shadow-md shadow-primary/30">
              <Zap className="h-4.5 w-4.5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-sm font-bold text-sidebar-foreground tracking-tight leading-none">{"Sterling Fence Staining"}</h1>
              <p className="text-[10px] text-sidebar-foreground/50 mt-0.5">Fence Restoration</p>
            </div>
          </div>
          <button onClick={onClose} className="md:hidden p-1.5 rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          <p className="text-[10px] uppercase tracking-widest text-sidebar-foreground/40 font-semibold px-3 mb-2">Menu</p>
          {NAV_ITEMS.filter(item => {
            const u = getCurrentUser();
            if (item.restrictToAny) return !!u && item.restrictToAny.includes((u.sub || "").toLowerCase());
            if (item.restrictTo) return u?.sub === item.restrictTo;
            if (item.perm) return hasPerm(item.perm);
            // Items without a perm default to admin + va, hidden from workers.
            return u?.role !== "worker";
          }).map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[13px] transition-all duration-150 ${
                  isActive
                    ? "bg-primary text-primary-foreground font-semibold shadow-md shadow-primary/20"
                    : "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                }`
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>

        {/* Revenue widget — financial data; admin + Office VA only (anyone
            with price visibility), never crew/workers. */}
        {hasPerm("see_prices") && <SidebarRevenueWidget />}

        {/* Footer */}
        <SidebarFooter />
      </aside>
    </>
  );
}
