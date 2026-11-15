import { Moon, Sun } from "lucide-react";
import { useDashboardTheme } from "@/lib/dashboardTheme";

export default function ThemeToggle() {
  const { theme, toggle } = useDashboardTheme();
  const dark = theme === "dark";
  const Icon = dark ? Moon : Sun;
  return (
    <button type="button" onClick={toggle} aria-pressed={dark}
      aria-label="Dark mode" title="Saved for your account on this browser"
      className="mb-3 flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-sidebar-border px-3 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring">
      <span className="flex items-center gap-2"><Icon aria-hidden="true" className="h-4 w-4" />Dark mode</span>
      <span className="text-xs text-sidebar-foreground/70">{dark ? "On" : "Off"}</span>
    </button>
  );
}
