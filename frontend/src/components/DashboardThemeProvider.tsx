import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { Toaster } from "sonner";
import { DashboardThemeContext, type DashboardTheme } from "@/lib/dashboardTheme";

/** A personal preference on this browser; customer-facing pages stay light. */
export default function DashboardThemeProvider({ username, children }: { username: string; children: ReactNode }) {
  const storageKey = `sterling:dashboard-theme:${username}`;
  const [theme, setTheme] = useState<DashboardTheme>(() => {
    try { return localStorage.getItem(storageKey) === "dark" ? "dark" : "light"; }
    catch { return "light"; }
  });

  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    return () => { document.documentElement.classList.remove("dark"); };
  }, [theme]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null) {
        setTheme(event.newValue === "dark" ? "dark" : "light");
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [storageKey]);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try { localStorage.setItem(storageKey, next); }
    catch { /* The switch still works when browser storage is unavailable. */ }
  };

  return (
    <DashboardThemeContext.Provider value={{ theme, toggle }}>
      {children}
      <Toaster position="top-right" richColors theme={theme} />
    </DashboardThemeContext.Provider>
  );
}
