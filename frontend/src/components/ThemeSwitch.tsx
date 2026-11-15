import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { savedTheme, saveTheme, type Theme } from "@/lib/theme";

// One tap flips the dashboard between light and dark (see lib/theme). Sits
// next to the clock, top right on a computer and in the phone's top bar.
export default function ThemeSwitch({ className }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>(savedTheme);

  useEffect(() => {
    const on = (e: Event) => setTheme((e as CustomEvent<Theme>).detail);
    window.addEventListener("sterling-theme", on);
    return () => window.removeEventListener("sterling-theme", on);
  }, []);

  const dark = theme === "dark";
  return (
    <button
      type="button"
      onClick={() => saveTheme(dark ? "light" : "dark")}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light mode" : "Dark mode"}
      className={cn(
        "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-sidebar-border bg-sidebar text-sidebar-foreground shadow-sm transition hover:bg-sidebar-accent active:scale-95",
        className,
      )}
    >
      {dark ? <Sun className="h-4 w-4 text-gold-light" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
