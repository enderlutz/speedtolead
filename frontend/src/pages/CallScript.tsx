// Call script (Alan, 2026-10-27): the tab opens on the script, word for
// word, built from Alan's own closed calls. Call Coach (the recordings and
// the AI review) is the second view on the same page.
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { BookOpen, Check, CornerDownRight, GraduationCap, Mic, Quote } from "lucide-react";
import { hasPerm } from "@/lib/api";
import Calls from "@/pages/Calls";
import TrainingCourse from "@/pages/TrainingCourse";
import { Card, CardContent } from "@/components/ui/card";
import {
  CHEAT_SHEET, OBJECTIONS, SCRIPT_RULES, SCRIPT_SOURCES, SCRIPT_STEPS, SCRIPT_VERSION,
  type ScriptLine,
} from "@/content/call-script";

type View = "script" | "coach" | "training";

export default function CallScript() {
  const [params, setParams] = useSearchParams();
  const canTrain = hasPerm("training");
  const asked = params.get("view");
  const view: View = asked === "coach" ? "coach" : asked === "training" && canTrain ? "training" : "script";
  const setView = (v: View) => {
    const next = new URLSearchParams(params);
    if (v !== "script") next.set("view", v); else next.delete("view");
    setParams(next, { replace: true });
  };

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-5xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Call script</h1>
          <p className="text-sm text-muted-foreground">
            {view === "script"
              ? `What to say on the first call, word for word. ${SCRIPT_VERSION}, from Alan's last five closed jobs.`
              : view === "coach" ? "The recordings, transcripts and the AI review of every call."
              : "The training modules: videos and steps for every part of the job."}
          </p>
        </div>
        <div className="flex rounded-lg border bg-muted/40 p-1">
          <ViewButton active={view === "script"} onClick={() => setView("script")} icon={<BookOpen className="h-4 w-4" />} label="Call script" />
          <ViewButton active={view === "coach"} onClick={() => setView("coach")} icon={<Mic className="h-4 w-4" />} label="Call coach" />
          {canTrain ? <ViewButton active={view === "training"} onClick={() => setView("training")} icon={<GraduationCap className="h-4 w-4" />} label="Training" /> : null}
        </div>
      </div>

      {view === "coach" ? <CoachEmbed /> : view === "training" ? <TrainingEmbed /> : <ScriptView />}
    </div>
  );
}

function ViewButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-h-[40px] items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors ${
        active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {icon} {label}
    </button>
  );
}

/** The Call Coach page keeps its own header; hide it so the page has one title. */
function CoachEmbed() {
  return (
    <div className="[&>div>div:first-child]:hidden -mx-4 sm:-mx-6 -mt-2">
      <Calls />
    </div>
  );
}

/** The course list keeps its header: it holds the admin's Add module button. */
function TrainingEmbed() {
  return (
    <div className="-mx-4 sm:-mx-6 -mt-2">
      <TrainingCourse />
    </div>
  );
}

function ScriptView() {
  const [active, setActive] = useState<string>(SCRIPT_STEPS[0].id);
  const ids = useMemo(() => SCRIPT_STEPS.map((s) => s.id), []);

  // Highlight the step that's on screen.
  useEffect(() => {
    const els = ids.map((id) => document.getElementById(`step-${id}`)).filter(Boolean) as HTMLElement[];
    if (!els.length || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        const seen = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (seen[0]) setActive(seen[0].target.id.replace("step-", ""));
      },
      { rootMargin: "-20% 0px -70% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [ids]);

  const jump = (id: string) => {
    setActive(id);
    document.getElementById(`step-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="lg:grid lg:grid-cols-[220px_1fr] lg:gap-6">
      {/* Steps: a rail on a laptop, a scrolling strip on a phone */}
      <nav className="sticky top-0 z-10 -mx-4 mb-3 bg-background/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 lg:static lg:mx-0 lg:mb-0 lg:px-0 lg:py-0">
        <ol className="flex gap-2 overflow-x-auto lg:sticky lg:top-4 lg:flex-col lg:gap-1">
          {SCRIPT_STEPS.map((s, i) => (
            <li key={s.id} className="shrink-0">
              <button
                type="button"
                onClick={() => jump(s.id)}
                className={`flex min-h-[40px] w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm whitespace-nowrap lg:whitespace-normal ${
                  active === s.id ? "bg-primary text-primary-foreground" : "bg-muted/60 text-muted-foreground hover:text-foreground"
                }`}
              >
                <span className="text-xs font-semibold tabular-nums">{i + 1}</span>
                <span>{s.title}</span>
              </button>
            </li>
          ))}
          <li className="shrink-0"><button type="button" onClick={() => jump("objections")} className="flex min-h-[40px] w-full items-center rounded-md bg-muted/60 px-3 py-2 text-left text-sm text-muted-foreground hover:text-foreground whitespace-nowrap lg:whitespace-normal">Objections</button></li>
          <li className="shrink-0"><button type="button" onClick={() => jump("cheat")} className="flex min-h-[40px] w-full items-center rounded-md bg-muted/60 px-3 py-2 text-left text-sm text-muted-foreground hover:text-foreground whitespace-nowrap lg:whitespace-normal">Cheat sheet</button></li>
        </ol>
      </nav>

      <div className="space-y-6">
        <Card className="border-amber-300 bg-amber-50/60 dark:border-amber-700 dark:bg-amber-950/30">
          <CardContent className="p-4">
            <div className="mb-2 text-sm font-semibold">The rules</div>
            <ul className="space-y-1.5 text-[15px] leading-snug">
              {SCRIPT_RULES.map((r) => (
                <li key={r} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" /><span>{r}</span></li>
              ))}
            </ul>
          </CardContent>
        </Card>

        {SCRIPT_STEPS.map((s, i) => (
          <section key={s.id} id={`step-${s.id}`} className="scroll-mt-20 lg:scroll-mt-4">
            <Card>
              <CardContent className="p-4 sm:p-5">
                <div className="mb-1 flex items-baseline gap-3">
                  <span className="rounded-full bg-primary px-2.5 py-0.5 text-xs font-semibold text-primary-foreground tabular-nums">Step {i + 1}</span>
                  <h2 className="text-lg font-semibold">{s.title}</h2>
                </div>
                <p className="mb-4 text-sm text-muted-foreground">{s.goal}</p>
                <div className="space-y-3">
                  {s.lines.map((l, j) => <Line key={j} line={l} />)}
                </div>
              </CardContent>
            </Card>
          </section>
        ))}

        <section id="step-objections" className="scroll-mt-20 lg:scroll-mt-4">
          <h2 className="mb-1 text-lg font-semibold">Objections</h2>
          <p className="mb-3 text-sm text-muted-foreground">What they said on real calls, and what Alan said back.</p>
          <div className="space-y-3">
            {OBJECTIONS.map((o) => (
              <Card key={o.when}>
                <CardContent className="p-4">
                  <div className="mb-2 text-[15px] font-semibold">{o.when}</div>
                  <Say text={o.say} />
                  {o.why ? <p className="mt-2 text-sm text-muted-foreground">{o.why}</p> : null}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <section id="step-cheat" className="scroll-mt-20 lg:scroll-mt-4">
          <h2 className="mb-1 text-lg font-semibold">Cheat sheet</h2>
          <p className="mb-3 text-sm text-muted-foreground">The facts you'll get asked. Verify the review counts on the Google page before you quote them.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {CHEAT_SHEET.map((c) => (
              <Card key={c.title}>
                <CardContent className="p-4">
                  <div className="mb-2 text-sm font-semibold">{c.title}</div>
                  <ul className="space-y-1.5 text-[15px] leading-snug">
                    {c.rows.map((r) => <li key={r} className="flex gap-2"><span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/50" /><span>{r}</span></li>)}
                  </ul>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
          <div className="mb-1 font-medium text-foreground">Where these words come from</div>
          <ul className="list-disc space-y-0.5 pl-5">
            {SCRIPT_SOURCES.map((s) => <li key={s}>{s}</li>)}
          </ul>
          <p className="mt-2">Edit the script in <code className="rounded bg-muted px-1">frontend/src/content/call-script.ts</code>. Keep the words a real customer heard on a call that closed.</p>
        </div>
      </div>
    </div>
  );
}

function Say({ text }: { text: string }) {
  return (
    <blockquote className="flex gap-3 rounded-md border-l-4 border-amber-500 bg-amber-50/60 px-3 py-2.5 text-[16px] leading-relaxed dark:bg-amber-950/20">
      <Quote className="mt-1 h-4 w-4 shrink-0 text-amber-600" />
      <span>{text}</span>
    </blockquote>
  );
}

function Line({ line }: { line: ScriptLine }) {
  if (line.kind === "say") return <Say text={line.text} />;
  if (line.kind === "do") {
    return (
      <div className="flex gap-2 text-[15px] leading-snug">
        <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
        <span>{line.text}</span>
      </div>
    );
  }
  if (line.kind === "note") return <p className="text-sm text-muted-foreground">{line.text}</p>;
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <div className="mb-1.5 flex items-start gap-2 text-sm font-semibold">
        <CornerDownRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <span>If: {line.when}</span>
      </div>
      <Say text={line.say} />
      {line.then ? <p className="mt-2 text-sm text-muted-foreground">{line.then}</p> : null}
    </div>
  );
}
