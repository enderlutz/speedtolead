import { NavLink } from "react-router-dom";
import { LayoutDashboard, Users, ClipboardCheck, BarChart3, Settings2, Menu, X, Zap, TrendingUp, LogOut, DollarSign } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, type KPIs, getCurrentUser, clearToken } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";

const NAV_ITEMS = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/leads", icon: Users, label: "Leads" },
  { to: "/sent-log", icon: ClipboardCheck, label: "Sent Log" },
  { to: "/analytics", icon: BarChart3, label: "Analytics" },
  { to: "/pricing", icon: DollarSign, label: "Pricing" },
  { to: "/settings", icon: Settings2, label: "Settings" },
];

export function MobileHeader({ onToggle }: { onToggle: () => void }) {
  return (
    <div className="md:hidden flex items-center justify-between px-4 py-3 border-b border-sidebar-border bg-sidebar sticky top-0 z-40">
      <div className="flex items-center gap-2">
        <div className="h-7 w-7 rounded-lg bg-primary flex items-center justify-center">
          <Zap className="h-4 w-4 text-primary-foreground" />
        </div>
        <span className="text-sm font-bold text-sidebar-foreground tracking-tight">AT-System</span>
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
              <h1 className="text-sm font-bold text-sidebar-foreground tracking-tight leading-none">AT-System</h1>
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
          {NAV_ITEMS.map(({ to, icon: Icon, label }) => (
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

        {/* Revenue widget */}
        <SidebarRevenueWidget />

        {/* Footer */}
        <SidebarFooter />
      </aside>
    </>
  );
}
