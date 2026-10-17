import { isSpanish, setViewLang, spanishAllowed } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// Español / English, top right, for anyone the office ticked Español for
// (Alan, 2026-10-17: "he can switch it back to English or Spanish"). A tap
// reloads the page so every screen changes at once.
// compact: "ES | EN", for the phone's top bar where the clock and menu also sit.
export default function LangSwitch({ className, compact }: { className?: string; compact?: boolean }) {
  if (!spanishAllowed()) return null;
  const es = isSpanish();
  const pick = (lang: "es" | "en") => {
    if ((lang === "es") === es) return;
    setViewLang(lang);
    window.location.reload();
  };
  return (
    <div role="group" aria-label="Language / Idioma"
         className={cn("inline-flex shrink-0 overflow-hidden rounded-full border border-sidebar-border bg-sidebar text-sm font-bold shadow-sm", className)}>
      {(compact ? [["es", "ES"], ["en", "EN"]] as const : [["es", "Español"], ["en", "English"]] as const).map(([lang, label]) => {
        const on = (lang === "es") === es;
        return (
          <button key={lang} type="button" onClick={() => pick(lang)} aria-pressed={on}
                  className={cn(compact ? "min-h-[36px] px-2.5 transition" : "min-h-[40px] px-3 transition", on ? "bg-primary text-primary-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent")}>
            {label}
          </button>
        );
      })}
    </div>
  );
}
