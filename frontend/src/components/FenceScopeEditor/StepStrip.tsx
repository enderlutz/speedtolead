// The three stages of a scope, and the one button for whichever is next.
//
// Photo ready → Mark the fence → Check & send. The first used to be two
// steps with two buttons (brighten, then drone view) that were always pressed
// one after the other; now it is one. The strip is the editor's navigation:
// whoever opens a scope sees where it is and what to do about it before they
// look at anything else.
import { Check, Sparkles, Loader2, Send, PenLine } from "lucide-react";
import { cn } from "@/lib/utils";
import { STAGES, currentStage, stageDone, type ScopeSteps } from "./steps";

interface Props {
  steps: ScopeSteps;
  aiConfigured: boolean;
  /** The drone render is running. */
  rendering: boolean;
  /** Something is being exported or sent. */
  busy: boolean;
  onPrepare: () => void;
  onConfirmAndSend: () => void;
}

const GOLD = "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-gradient-to-r from-gold-light via-gold to-bronze px-3.5 text-xs font-bold text-ink shadow-md shadow-gold/30 ring-1 ring-gold-light/60 transition hover:from-gold hover:to-bronze active:scale-95 disabled:from-stone-300 disabled:via-stone-300 disabled:to-stone-300 disabled:text-stone-600 disabled:shadow-none disabled:ring-0";

export default function StepStrip({ steps, aiConfigured, rendering, busy, onPrepare, onConfirmAndSend }: Props) {
  const stage = currentStage(steps);

  return (
    <div className="flex items-center gap-3 border-b border-gold/25 bg-ivory px-3 py-2">
      <ol className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2">
        {STAGES.map((s, i) => {
          const done = stageDone(steps, s.n);
          const current = stage === s.n;
          return (
            <li key={s.n} className="flex min-w-0 items-center gap-1.5 sm:gap-2">
              {i > 0 ? <span className={cn("h-px w-3 shrink-0 sm:w-6", done || current ? "bg-gold" : "bg-ink/15")} /> : null}
              <span
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold",
                  done ? "bg-emerald-600 text-white"
                    : current ? "bg-gradient-to-br from-gold-light to-bronze text-ink shadow-sm shadow-gold/40 ring-2 ring-gold/30"
                    : "bg-ink/10 text-ink/50",
                )}
              >
                {done ? <Check className="h-3.5 w-3.5" /> : s.n}
              </span>
              <span className={cn(
                "truncate text-xs",
                done ? "text-muted-foreground line-through decoration-ink/30" : current ? "font-bold text-ink" : "text-muted-foreground",
              )}>
                <span className="sm:hidden">{current ? s.label : s.short}</span>
                <span className="hidden sm:inline">{s.label}</span>
              </span>
            </li>
          );
        })}
      </ol>

      {stage === 1 ? (
        <button type="button" onClick={onPrepare} disabled={rendering || busy} className={GOLD}
                title={aiConfigured
                  ? "Brightens the photo and renders the drone view in one go. Up to a minute."
                  : "Brightens the photo. The drone view needs an OpenAI key on the server."}>
          {rendering ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {rendering ? <><span className="sm:hidden">Rendering…</span><span className="hidden sm:inline">Rendering… up to a minute</span></>
            : <><span className="sm:hidden">Prepare</span><span className="hidden sm:inline">Prepare the photo</span></>}
        </button>
      ) : stage === 2 ? (
        <span className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex">
          <PenLine className="h-3.5 w-3.5 text-bronze" /> Pick a pen below and tap along the fence
        </span>
      ) : (
        <button type="button" onClick={onConfirmAndSend} disabled={busy} className={GOLD}
                title={stage === 3 ? "You've checked it over — text it to the customer" : "Text this scope to the customer"}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {stage === 3
            ? <><span className="sm:hidden">Looks right</span><span className="hidden sm:inline">Looks right — send it</span></>
            : <><span className="sm:hidden">Send</span><span className="hidden sm:inline">Send to customer</span></>}
        </button>
      )}
    </div>
  );
}
