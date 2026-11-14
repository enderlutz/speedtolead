// 8. Business alerts: exceptions only, worst first. Normal stays quiet.
import { Link } from "react-router-dom";
import { CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { DOT } from "./format";
import type { Alert } from "./types";

export default function AlertsCard({ alerts }: { alerts: Alert[] }) {
  if (!alerts.length) {
    return (
      <p className="flex items-center gap-2 text-base text-emerald-800 dark:text-emerald-300">
        <CheckCircle2 className="h-5 w-5" /> Nothing unusual right now.
      </p>
    );
  }
  return (
    <ul className="divide-y">
      {alerts.map((a, i) => {
        const body = (
          <div className="flex min-h-11 items-start gap-3 py-2.5">
            <span className={cn("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", DOT[a.level])} aria-hidden />
            <span className={cn("text-sm", a.level === "red" && "font-semibold")}>{a.text}</span>
          </div>
        );
        return <li key={i}>{a.href ? <Link to={a.href} className="block rounded-lg px-1 transition hover:bg-muted/60">{body}</Link> : body}</li>;
      })}
    </ul>
  );
}
