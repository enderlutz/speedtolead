// The three steps a scope has to clear before it can go to a customer.
//
// This exists to stop a half-finished picture reaching someone's phone. Each
// step is a real piece of work — the photo made presentable, the fence marked,
// and somebody actually looking at the result — and Send stays locked until
// all three are done. The confirmation resets on any further edit, so what was
// approved is always what gets sent.

import { Check, Sparkles, Plane, PenLine, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { firstIncompleteStep, type ScopeSteps } from "./steps";

interface Props {
  steps: ScopeSteps;
  aiConfigured: boolean;
  rendering: boolean;
  onEnhance: () => void;
  onGenerateAi: () => void;
  onConfirm: () => void;
}

function Pip({ done, active, n }: { done: boolean; active: boolean; n: number }) {
  return (
    <span
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
        done
          ? "bg-emerald-600 text-white"
          : active
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-muted-foreground"
      }`}
    >
      {done ? <Check className="h-3 w-3" /> : n}
    </span>
  );
}

export default function ScopeChecklist({
  steps, aiConfigured, rendering, onEnhance, onGenerateAi, onConfirm,
}: Props) {
  const step = firstIncompleteStep(steps);

  if (step === null) {
    return (
      <div className="flex items-center gap-2 border-b bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 text-xs">
        <Pip done active={false} n={3} />
        <span className="font-medium text-emerald-700 dark:text-emerald-400">
          Ready to send — all three steps done.
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-muted/40 px-3 py-2 text-xs min-w-0">
      <span className="flex items-center gap-1.5 shrink-0">
        <Pip done={steps.enhanced} active={step === 1} n={1} />
        <span className={steps.enhanced ? "text-muted-foreground line-through" : "font-medium"}>
          Enhance the photo
        </span>
      </span>
      <span className="flex items-center gap-1.5 shrink-0">
        <Pip done={steps.drawn} active={step === 2} n={2} />
        <span className={steps.drawn ? "text-muted-foreground line-through" : "font-medium"}>
          Mark the fence
        </span>
      </span>
      <span className="flex items-center gap-1.5 shrink-0">
        <Pip done={steps.confirmed} active={step === 3} n={3} />
        <span className="font-medium">Confirm</span>
      </span>

      <span className="flex-1 min-w-0" />

      {step === 1 && (
        <span className="flex items-center gap-1.5 shrink-0">
          <Button size="sm" className="h-7" disabled={rendering || !aiConfigured} onClick={onGenerateAi}
                  title={aiConfigured
                    ? "Re-render the photo as a realistic overhead drone shot"
                    : "Needs an OpenAI key on the server"}>
            {rendering ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Plane className="h-3.5 w-3.5 mr-1" />}
            {rendering ? "Rendering…" : "Drone View"}
          </Button>
          <Button size="sm" variant="outline" className="h-7" onClick={onEnhance}
                  title="Sharpen and lift the contrast of the original photo — free and instant">
            <Sparkles className="h-3.5 w-3.5 mr-1" /> Quick Enhance
          </Button>
        </span>
      )}
      {step === 2 && (
        <span className="flex items-center gap-1.5 shrink-0 text-muted-foreground">
          <PenLine className="h-3.5 w-3.5" />
          Pick Blue or Red, trace the fence, then Confirm the line.
        </span>
      )}
      {step === 3 && (
        <Button size="sm" className="h-7 shrink-0" onClick={onConfirm}
                title="Confirm this scope is finished and correct">
          <Check className="h-3.5 w-3.5 mr-1" /> This looks right
        </Button>
      )}
    </div>
  );
}
