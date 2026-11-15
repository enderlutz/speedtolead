// Light / dark for the staff dashboard (Alan, 2026-11-15: "a dark mode version
// of the dashboard so our eyes can look at it a little better ... switch from
// dark to light"). Saved per device; light is the default. Customer pages
// (proposal, pay, booking, colors) always stay light: AppLayout only applies
// the saved choice on staff screens.
export type Theme = "light" | "dark";

const KEY = "sterling-theme";

export function savedTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function applyTheme(t: Theme) {
  document.documentElement.classList.toggle("dark", t === "dark");
}

export function saveTheme(t: Theme) {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* private window: the switch still works until reload */
  }
  applyTheme(t);
  window.dispatchEvent(new CustomEvent("sterling-theme", { detail: t }));
}
