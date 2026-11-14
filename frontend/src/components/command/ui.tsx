// Shared pieces for the Dashboard command center: the section shell, money
// and waiting-time words, and the urgency colors. Red = overdue or serious,
// amber = soon, green = fine, everything else stays neutral (the brief: "do
// not make everything colorful").
import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Priority, SectionError } from "./types";
import { PILL } from "./format";

export function Pill({ tone, children, className }: { tone: Priority; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-medium ring-1 ring-inset", PILL[tone], className)}>
      {children}
    </span>
  );
}

/** One section of the page: a quiet card with a serif title, a one-line
 *  "what this is", and an optional link or control at the right. */
export function Section({
  title, sub, right, children, className, emphasis, id,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** The two sections the brief wants loudest (Action Center, Today). */
  emphasis?: boolean;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={cn(
        "flex min-w-0 flex-col rounded-2xl border bg-card text-card-foreground",
        emphasis ? "border-gold/50 shadow-sm ring-1 ring-gold/20" : "border-border",
        className,
      )}
    >
      <header className="flex items-start justify-between gap-3 border-b px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <h2 className="font-heading text-lg font-semibold leading-tight">{title}</h2>
          {sub ? <p className="mt-0.5 text-sm text-muted-foreground">{sub}</p> : null}
        </div>
        {right ? <div className="shrink-0">{right}</div> : null}
      </header>
      <div className="min-w-0 flex-1 p-4 sm:p-5">{children}</div>
    </section>
  );
}

export function SectionFailed({ err }: { err: SectionError }) {
  return (
    <div className="flex items-start gap-2 rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>This part didn't load ({err.error.slice(0, 120)}). The rest of the page is fine. Refresh to try again.</span>
    </div>
  );
}

/** A 44px-tall button-link (thumb-sized on the phone). */
export function ActionLink({ to, children, tone = "neutral", className }: {
  to: string; children: React.ReactNode; tone?: "primary" | "neutral"; className?: string;
}) {
  return (
    <Link
      to={to}
      className={cn(
        "inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg px-3.5 text-sm font-semibold transition",
        tone === "primary"
          ? "bg-ink text-white hover:bg-ink/85 dark:bg-gold dark:text-ink dark:hover:bg-gold-light"
          : "border border-border bg-background hover:bg-muted",
        className,
      )}
    >
      {children}
    </Link>
  );
}

export function NotTracked({ children }: { children: React.ReactNode }) {
  return <p className="text-sm italic text-muted-foreground">{children}</p>;
}
