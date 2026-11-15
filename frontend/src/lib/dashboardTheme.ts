import { createContext, useContext } from "react";

export type DashboardTheme = "light" | "dark";
export const DashboardThemeContext = createContext<{
  theme: DashboardTheme;
  toggle: () => void;
} | null>(null);

export function useDashboardTheme() {
  const context = useContext(DashboardThemeContext);
  if (!context) throw new Error("Dashboard theme requires its provider");
  return context;
}
