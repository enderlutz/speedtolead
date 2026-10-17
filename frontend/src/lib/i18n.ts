// Crew screens in Spanish (Alan, 2026-10-16: "a tick on and off where I can
// give a Spanish speaker the opportunity to see it in Spanish"). The tick is
// on the person's account (Settings → Users → Español); it rides in their
// login token as lang = "es". tr() takes the English text and gives back the
// Spanish when that person has it on. Anything not in the list stays English.
import { getCurrentUser } from "@/lib/api";
import { ES } from "@/lib/i18n_es";

// The person can flip their own screens between Spanish and English from the
// top-right switch (Alan, 2026-10-17: Jose learns the English by seeing both).
// Only for accounts with Español ticked; the choice stays on that phone.
const VIEW_KEY = "at_view_lang";

/** Has the office ticked Español on this account? */
export function spanishAllowed(): boolean {
  return getCurrentUser()?.lang === "es";
}

function viewLang(): string {
  try { return localStorage.getItem(VIEW_KEY) || ""; } catch { return ""; }
}

export function setViewLang(lang: "es" | "en"): void {
  try { localStorage.setItem(VIEW_KEY, lang); } catch { /* private mode: stays as is */ }
}

export function isSpanish(): boolean {
  return spanishAllowed() && viewLang() !== "en";
}

export function tr(en: string): string {
  if (!en || !isSpanish()) return en;
  return ES[en] ?? ES[en.trim()] ?? en;
}
