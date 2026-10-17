// Crew screens in Spanish (Alan, 2026-10-16: "a tick on and off where I can
// give a Spanish speaker the opportunity to see it in Spanish"). The tick is
// on the person's account (Settings → Users → Español); it rides in their
// login token as lang = "es". tr() takes the English text and gives back the
// Spanish when that person has it on. Anything not in the list stays English.
import { getCurrentUser } from "@/lib/api";
import { ES } from "@/lib/i18n_es";

export function isSpanish(): boolean {
  return getCurrentUser()?.lang === "es";
}

export function tr(en: string): string {
  if (!en || !isSpanish()) return en;
  return ES[en] ?? ES[en.trim()] ?? en;
}
