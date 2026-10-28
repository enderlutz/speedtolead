import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Archive, CheckCircle2, Circle, GraduationCap,
  Loader2, MessageSquareQuote, Pencil, Plus, Search, Sparkles, Trash2, Video, X,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  api, type CourseModule, type CourseModuleEdit, type CourseModuleRow, type CourseQuizQ, type CourseVideo,
} from "@/lib/api";

// The VA training course (Alan, 2026-10-16): one module per task, in the
// order a job happens. A recording of Alan doing it, the steps written out,
// mistakes, a checklist and a quiz. Stuck? Search finds the step.

/** A Loom, YouTube or Google Drive link as something we can play inline. */
function embedUrl(url: string): string | null {
  const loom = url.match(/loom\.com\/(?:share|embed)\/([a-zA-Z0-9]+)/);
  if (loom) return `https://www.loom.com/embed/${loom[1]}`;
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,})/);
  if (yt) return `https://www.youtube.com/embed/${yt[1]}`;
  const drive = url.match(/drive\.google\.com\/file\/d\/([\w-]+)/);
  if (drive) return `https://drive.google.com/file/d/${drive[1]}/preview`;
  return null;
}

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

export default function TrainingCourse() {
  const { moduleId } = useParams();
  return moduleId ? <ModuleView key={moduleId} id={moduleId} /> : <CourseList />;
}

// ── The list ───────────────────────────────────────────────────────────────

function CourseList() {
  const navigate = useNavigate();
  const [mods, setMods] = useState<CourseModuleRow[] | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [team, setTeam] = useState<{ total: number; people: { user: string; done: number; last: string }[] } | null>(null);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api.listCourse();
      setMods(r.modules);
      setIsAdmin(r.is_admin);
      if (r.is_admin) api.courseTeam().then(setTeam).catch(() => {});
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load training");
    }
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: fetches on mount; the data lands asynchronously.
  useEffect(() => { load(); }, [load]);

  const live = (mods || []).filter((m) => m.status === "published");
  const done = live.filter((m) => m.progress.done).length;
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (mods || []).filter((m) => words.every((w) => m.search_text.includes(w)));
  const sections = useMemo(() => {
    const out: { name: string; items: CourseModuleRow[] }[] = [];
    for (const m of shown) {
      const name = m.section || "Other";
      const last = out[out.length - 1];
      if (last && last.name === name) last.items.push(m);
      else out.push({ name, items: [m] });
    }
    return out;
  }, [shown]);

  const add = async () => {
    try {
      const m = await api.createCourseModule({ title: "New module" });
      navigate(`/training/${m.id}?edit=1`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't add it");
    }
  };
  const move = async (id: string, dir: number) => {
    await api.moveCourseModule(id, dir).catch(() => toast.error("Couldn't move it"));
    load();
  };

  if (!mods) return <div className="p-8 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><GraduationCap className="h-6 w-6" /> Training</h1>
          <p className="text-sm text-muted-foreground mt-1">Every task, in the order a job happens. Watch the video, read the steps, tick the checklist, pass the quiz.</p>
        </div>
        {isAdmin && <Button onClick={add}><Plus className="h-4 w-4 mr-1" /> Add module</Button>}
      </div>

      <div className="relative">
        <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} className="pl-9 h-11 text-base"
          placeholder="Stuck? Type what you're doing, e.g. HOA, no address, deposit" />
      </div>

      {live.length > 0 && (
        <Card><CardContent className="p-4">
          <div className="flex items-center justify-between text-sm font-medium">
            <span>Your progress</span><span className="tabular-nums">{done} of {live.length} done</span>
          </div>
          <div className="h-2.5 rounded-full bg-muted mt-2 overflow-hidden">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${(100 * done) / live.length}%` }} />
          </div>
        </CardContent></Card>
      )}

      {isAdmin && team && team.people.length > 0 && (
        <Card><CardContent className="p-4">
          <p className="text-sm font-semibold mb-2">The team</p>
          {team.people.map((p) => (
            <div key={p.user} className="flex items-center justify-between text-sm py-1 border-t first:border-t-0">
              <span>{p.user}</span><span className="tabular-nums text-muted-foreground">{p.done} of {team.total} done</span>
            </div>
          ))}
        </CardContent></Card>
      )}

      {isAdmin && mods.some((m) => m.status === "draft") && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
          <b>Drafts are only visible to you.</b> Record the video, paste the transcript, let the AI write it, check it, then Publish.
        </div>
      )}

      {sections.length === 0 && <p className="text-sm text-muted-foreground">{q ? "Nothing matches. Try another word, or ask Alan." : "No modules yet."}</p>}

      {sections.map((s) => (
        <div key={s.name} className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{s.name}</h2>
          {s.items.map((m) => (
            <Card key={m.id} className="hover:border-primary/40 transition-colors">
              <CardContent className="p-0 flex items-stretch">
                <Link to={`/training/${m.id}`} className="flex-1 p-4 flex items-start gap-3 min-w-0">
                  {m.progress.done
                    ? <CheckCircle2 className="h-6 w-6 text-emerald-500 shrink-0" />
                    : <Circle className="h-6 w-6 text-muted-foreground/40 shrink-0" />}
                  <div className="min-w-0">
                    <p className="font-semibold leading-tight flex items-center gap-2 flex-wrap">
                      <span className="text-muted-foreground tabular-nums">{m.position}.</span> {m.title}
                      {m.status === "draft" && <Badge variant="outline" className="text-amber-700 border-amber-500/40">Draft</Badge>}
                      {m.videos.length > 0 && <Video className="h-4 w-4 text-muted-foreground" />}
                    </p>
                    <p className="text-sm text-muted-foreground mt-0.5">{m.summary}</p>
                    {isAdmin && m.status === "draft" && m.record_note && (
                      <p className="text-xs mt-1 text-amber-700 dark:text-amber-300">Record: {m.record_note}</p>
                    )}
                  </div>
                </Link>
                {isAdmin && !q && (
                  <div className="flex flex-col justify-center pr-2">
                    <button aria-label="Move up" className="p-2 text-muted-foreground hover:text-foreground" onClick={() => move(m.id, -1)}><ArrowUp className="h-4 w-4" /></button>
                    <button aria-label="Move down" className="p-2 text-muted-foreground hover:text-foreground" onClick={() => move(m.id, 1)}><ArrowDown className="h-4 w-4" /></button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      ))}

      {isAdmin && (
        <p className="text-xs text-muted-foreground pt-4">
          <Archive className="h-3 w-3 inline mr-1" />
          The old call simulator is archived: <Link className="underline" to="/training/archive">open it</Link>
        </p>
      )}
    </div>
  );
}

// ── One module ─────────────────────────────────────────────────────────────

function ModuleView({ id }: { id: string }) {
  const navigate = useNavigate();
  const [m, setM] = useState<CourseModule | null>(null);
  const [all, setAll] = useState<CourseModuleRow[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [editing, setEditing] = useState(() => new URLSearchParams(window.location.search).get("edit") === "1");
  const [answers, setAnswers] = useState<number[]>([]);
  const [wrong, setWrong] = useState<number[] | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    try {
      const [mod, list] = await Promise.all([api.getCourseModule(id), api.listCourse()]);
      setM(mod);
      setAll(list.modules);
      setIsAdmin(list.is_admin);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load it");
    }
  }, [id]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: fetches on mount; the data lands asynchronously.
  useEffect(() => { load(); }, [load]);

  if (!m) return <div className="p-8 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  if (editing && isAdmin) return <ModuleEditor m={m} onDone={(saved) => { setEditing(false); if (saved) load(); }} />;

  const next = all.find((x) => x.position > m.position && x.status === "published");
  const save = async (body: { watched?: boolean; checked?: number[]; answers?: number[] }) => {
    const r = await api.saveCourseProgress(m.id, body);
    setM({ ...m, progress: r.progress });
    return r;
  };
  const toggle = (i: number) => {
    const set = new Set(m.progress.checked);
    if (set.has(i)) set.delete(i); else set.add(i);
    save({ checked: [...set] }).catch(() => toast.error("Couldn't save"));
  };
  const check = async () => {
    setChecking(true);
    try {
      const r = await save({ answers });
      setWrong(r.quiz_result?.wrong ?? []);
      if (r.quiz_result && r.quiz_result.wrong.length === 0) toast.success("All right. Nice work.");
    } catch {
      toast.error("Couldn't check it");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-2">
        <Link to="/calls?view=training" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"><ArrowLeft className="h-4 w-4" /> All modules</Link>
        {isAdmin && <Button variant="outline" size="sm" onClick={() => setEditing(true)}><Pencil className="h-4 w-4 mr-1" /> Edit</Button>}
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{m.section} · Module {m.position}</p>
        <h1 className="text-2xl font-bold mt-1 flex items-center gap-2 flex-wrap">
          {m.title}
          {m.status === "draft" && <Badge variant="outline" className="text-amber-700 border-amber-500/40">Draft</Badge>}
        </h1>
        {m.summary && <p className="text-base text-muted-foreground mt-2">{m.summary}</p>}
      </div>

      {m.videos.length === 0 && isAdmin && (
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          No video yet.{m.record_note && <> Record: <b className="text-foreground">{m.record_note}</b></>}
        </div>
      )}
      {m.videos.map((v, i) => <VideoBlock key={i} v={v} />)}
      {m.videos.length > 0 && (
        <Button variant={m.progress.watched ? "outline" : "default"} disabled={m.progress.watched}
          onClick={() => save({ watched: true }).catch(() => toast.error("Couldn't save"))}>
          {m.progress.watched ? <><CheckCircle2 className="h-4 w-4 mr-1 text-emerald-500" /> Watched</> : "I watched the video"}
        </Button>
      )}

      {lines(m.steps).length > 0 && (
        <section>
          <h2 className="text-lg font-semibold mb-2">Step by step</h2>
          <Steps text={m.steps} />
        </section>
      )}

      {lines(m.mistakes).length > 0 && (
        <section>
          <h2 className="text-lg font-semibold mb-2">Mistakes to avoid</h2>
          <ul className="space-y-2">
            {lines(m.mistakes).map((l, i) => (
              <li key={i} className="flex gap-2 text-[15px]"><AlertTriangle className="h-4 w-4 text-amber-500 mt-1 shrink-0" />{l}</li>
            ))}
          </ul>
        </section>
      )}

      {m.checklist.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold mb-2">Checklist</h2>
          <div className="space-y-1">
            {m.checklist.map((c, i) => {
              const on = m.progress.checked.includes(i);
              return (
                <button key={i} onClick={() => toggle(i)} className="w-full flex items-center gap-3 text-left p-3 rounded-lg border hover:bg-muted/50 min-h-11">
                  {on ? <CheckCircle2 className="h-5 w-5 text-emerald-500 shrink-0" /> : <Circle className="h-5 w-5 text-muted-foreground/50 shrink-0" />}
                  <span className={on ? "text-muted-foreground" : ""}>{c}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {m.quiz.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold mb-2">Quiz {m.progress.passed && <span className="text-emerald-600 text-sm font-normal ml-1">Passed</span>}</h2>
          <div className="space-y-4">
            {m.quiz.map((qq, i) => (
              <div key={i} className={`rounded-lg border p-3 ${wrong?.includes(i) ? "border-red-500/60 bg-red-500/5" : ""}`}>
                <p className="font-medium mb-2">{i + 1}. {qq.q}</p>
                {qq.options.map((o, j) => (
                  <label key={j} className="flex items-center gap-2 py-1.5 cursor-pointer min-h-9">
                    <input type="radio" name={`q${i}`} checked={answers[i] === j}
                      onChange={() => { const a = [...answers]; a[i] = j; setAnswers(a); setWrong(null); }} />
                    <span>{o}</span>
                  </label>
                ))}
                {wrong?.includes(i) && <p className="text-sm text-red-600 mt-1">Not quite. Look at the steps again.</p>}
              </div>
            ))}
            <Button onClick={check} disabled={checking || answers.filter((a) => a !== undefined).length < m.quiz.length}>
              {checking && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} Check my answers
            </Button>
          </div>
        </section>
      )}

      {m.progress.done && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4 flex items-center justify-between gap-3 flex-wrap">
          <p className="font-semibold text-emerald-700 dark:text-emerald-300 flex items-center gap-2"><CheckCircle2 className="h-5 w-5" /> Module done</p>
          {next && <Button onClick={() => navigate(`/training/${next.id}`)}>Next: {next.title} <ArrowRight className="h-4 w-4 ml-1" /></Button>}
        </div>
      )}
    </div>
  );
}

function VideoBlock({ v }: { v: CourseVideo }) {
  const src = embedUrl(v.url);
  return (
    <div className="space-y-1">
      {v.label && <p className="text-sm font-medium">{v.label}</p>}
      {src ? (
        <div className="relative w-full rounded-lg overflow-hidden border bg-black" style={{ paddingTop: "56.25%" }}>
          <iframe src={src} title={v.label || "Training video"} className="absolute inset-0 w-full h-full" allow="autoplay; fullscreen; picture-in-picture" allowFullScreen />
        </div>
      ) : (
        <a href={v.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-primary underline"><Video className="h-4 w-4" /> Open the video</a>
      )}
    </div>
  );
}

function Steps({ text }: { text: string }) {
  const all = lines(text);
  const isSay = (l: string) => /^say:/i.test(l);
  return (
    <ol className="space-y-2">
      {all.map((l, i) => {
        const say = l.match(/^say:\s*(.*)$/i);
        const n = all.slice(0, i + 1).filter((x) => !isSay(x)).length;
        if (say) {
          return (
            <li key={i} className="ml-8 rounded-lg bg-sky-500/10 border border-sky-500/30 p-3 text-[15px] flex gap-2">
              <MessageSquareQuote className="h-4 w-4 text-sky-600 mt-1 shrink-0" />
              <span>&ldquo;{say[1].replace(/^["“]|["”]$/g, "")}&rdquo;</span>
            </li>
          );
        }
        return (
          <li key={i} className="flex gap-3 text-[15px]">
            <span className="h-6 w-6 rounded-full bg-primary/10 text-primary text-sm font-semibold flex items-center justify-center shrink-0 tabular-nums">{n}</span>
            <span className="pt-0.5">{l}</span>
          </li>
        );
      })}
    </ol>
  );
}

// ── Alan editing a module ──────────────────────────────────────────────────

function ModuleEditor({ m, onDone }: { m: CourseModule; onDone: (saved: boolean) => void }) {
  const navigate = useNavigate();
  const [f, setF] = useState<CourseModuleEdit>({
    section: m.section, title: m.title, summary: m.summary, record_note: m.record_note || "",
    videos: m.videos.length ? m.videos : [{ label: "Computer", url: "" }],
    steps: m.steps, mistakes: m.mistakes, checklist: m.checklist, quiz: m.quiz,
    transcript: m.transcript || "", status: m.status,
  });
  const [checklistText, setChecklistText] = useState(m.checklist.join("\n"));
  const [saving, setSaving] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const set = <K extends keyof CourseModuleEdit>(k: K, v: CourseModuleEdit[K]) => setF((x) => ({ ...x, [k]: v }));

  const save = async (status?: CourseModuleEdit["status"]) => {
    setSaving(true);
    try {
      await api.saveCourseModule(m.id, { ...f, checklist: lines(checklistText), ...(status ? { status } : {}) });
      toast.success(status === "published" ? "Published. The VAs can see it." : status === "archived" ? "Archived" : "Saved");
      if (status === "archived") navigate("/calls?view=training");
      else onDone(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  };
  const draft = async () => {
    setDrafting(true);
    try {
      const d = await api.draftCourseModule(m.id, f.transcript);
      setF((x) => ({ ...x, summary: d.summary || x.summary, steps: d.steps, mistakes: d.mistakes, quiz: d.quiz }));
      setChecklistText(d.checklist.join("\n"));
      toast.success("Written. Look it over, fix anything, then Save.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The AI couldn't write it");
    } finally {
      setDrafting(false);
    }
  };
  const setQ = (i: number, q: CourseQuizQ) => set("quiz", f.quiz.map((x, j) => (j === i ? q : x)));

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <button onClick={() => onDone(false)} className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"><ArrowLeft className="h-4 w-4" /> Back without saving</button>
        <Badge variant="outline">{f.status === "published" ? "Published" : "Draft"}</Badge>
      </div>

      <Field label="Title"><Input value={f.title} onChange={(e) => set("title", e.target.value)} /></Field>
      <Field label="Section" hint="Modules with the same section are grouped together."><Input value={f.section} onChange={(e) => set("section", e.target.value)} /></Field>
      <Field label="What to record (only you see this)"><Input value={f.record_note} onChange={(e) => set("record_note", e.target.value)} /></Field>

      <Field label="Videos" hint="Paste the Loom link. Add a second one for the phone (Loom's iPhone app records the phone screen).">
        <div className="space-y-2">
          {f.videos.map((v, i) => (
            <div key={i} className="flex gap-2">
              <Input className="w-36" placeholder="Computer / Phone" value={v.label}
                onChange={(e) => set("videos", f.videos.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
              <Input placeholder="https://www.loom.com/share/…" value={v.url}
                onChange={(e) => set("videos", f.videos.map((x, j) => (j === i ? { ...x, url: e.target.value.trim() } : x)))} />
              <Button variant="ghost" size="icon" aria-label="Remove video" onClick={() => set("videos", f.videos.filter((_, j) => j !== i))}><X className="h-4 w-4" /></Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => set("videos", [...f.videos, { label: "Phone", url: "" }])}><Plus className="h-4 w-4 mr-1" /> Add a video</Button>
        </div>
      </Field>

      <Card className="border-primary/30"><CardContent className="p-4 space-y-2">
        <p className="font-semibold flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" /> Write it from the recording</p>
        <p className="text-sm text-muted-foreground">In Loom, open the video, go to the Transcript tab and copy it. Paste it here, plus anything you'd add. The AI writes the summary, steps, mistakes, checklist and quiz. Nothing is saved until you press Save.</p>
        <Textarea rows={6} value={f.transcript} onChange={(e) => set("transcript", e.target.value)} placeholder="Paste the transcript here" />
        <Button onClick={draft} disabled={drafting || f.transcript.trim().length < 200}>
          {drafting ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Writing… (about a minute)</> : <><Sparkles className="h-4 w-4 mr-1" /> Write the module</>}
        </Button>
      </CardContent></Card>

      <Field label="Why this matters"><Textarea rows={2} value={f.summary} onChange={(e) => set("summary", e.target.value)} /></Field>
      <Field label="Steps" hint={'One step per line. Start a line with "Say:" for the exact words to use with a customer.'}>
        <Textarea rows={12} value={f.steps} onChange={(e) => set("steps", e.target.value)} />
      </Field>
      <Field label="Mistakes to avoid" hint="One per line."><Textarea rows={4} value={f.mistakes} onChange={(e) => set("mistakes", e.target.value)} /></Field>
      <Field label="Checklist" hint="One per line. The VA ticks each one."><Textarea rows={4} value={checklistText} onChange={(e) => setChecklistText(e.target.value)} /></Field>

      <Field label="Quiz" hint="Pick the right answer with the circle.">
        <div className="space-y-3">
          {f.quiz.map((qq, i) => (
            <div key={i} className="rounded-lg border p-3 space-y-2">
              <div className="flex gap-2">
                <Input value={qq.q} placeholder="Question" onChange={(e) => setQ(i, { ...qq, q: e.target.value })} />
                <Button variant="ghost" size="icon" aria-label="Remove question" onClick={() => set("quiz", f.quiz.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
              </div>
              {qq.options.map((o, j) => (
                <div key={j} className="flex items-center gap-2">
                  <input type="radio" aria-label="Right answer" checked={qq.answer === j} onChange={() => setQ(i, { ...qq, answer: j })} />
                  <Input value={o} placeholder={`Answer ${j + 1}`} onChange={(e) => setQ(i, { ...qq, options: qq.options.map((x, k) => (k === j ? e.target.value : x)) })} />
                </div>
              ))}
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => set("quiz", [...f.quiz, { q: "", options: ["", "", ""], answer: 0 }])}><Plus className="h-4 w-4 mr-1" /> Add a question</Button>
        </div>
      </Field>

      <div className="flex flex-wrap gap-2 pt-2 border-t">
        <Button onClick={() => save()} disabled={saving}>{saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} Save</Button>
        {f.status !== "published"
          ? <Button variant="outline" className="border-emerald-500/50 text-emerald-700" onClick={() => save("published")} disabled={saving}>Save and publish</Button>
          : <Button variant="outline" onClick={() => save("draft")} disabled={saving}>Back to draft (hide from VAs)</Button>}
        <Button variant="ghost" className="text-red-600 ml-auto" disabled={saving}
          onClick={() => { if (window.confirm("Archive this module? VAs won't see it.")) save("archived"); }}>
          <Archive className="h-4 w-4 mr-1" /> Archive
        </Button>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-semibold">{label}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </div>
  );
}
