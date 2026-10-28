// Design Lab (Alan, 2026-10-23): one tab for everything a customer sees or
// hears from us, before they do. "We're gonna have a lot of things like this
// that come up, so I want to be able to easily access them." Five sections
// across the top; two of them have their own row underneath (Alan,
// 2026-10-27: the Follow-Up Engine tab folds in here, "very organized and
// very simple"):
//   Screens     Proposal (the tap-through mockup) · Quote generator
//   Follow-ups  Overview · Sterling · A&T's · Helpers · Both boards ·
//               The plan (Cardone's year of touches) · Engine
//   Ideas       the save-for-later folder (docs/ideas), readable here
//   Changes     what went live on customer screens, newest first
//   Notes       the proposal project notes
// The section and its row live in the address (?tab=followups&view=sterling)
// so a link lands on the right one. The page is one width in every section
// and the second row is always there (Alan, 2026-10-27: "I want everything
// to stay the same size"), so nothing jumps when you move around. Nothing on
// this page sends anything.
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FlaskConical, History, Lightbulb, Maximize2, NotebookPen, Repeat, ShieldAlert, Smartphone } from "lucide-react";
import ProposalMockup from "@/pages/ProposalMockup";
import QuoteMockup from "@/pages/QuoteMockup";
import FollowUpEngine from "@/pages/FollowUpEngine";
import { FOLLOWUP_VIEWS, type FollowUpView } from "@/pages/followUpViews";
import { DESIGN_CHANGES } from "@/content/design-changes";
import notes from "@/content/proposal-v2.md?raw";
import { Panel } from "@/components/Panel";
import { HubHeader } from "@/components/HubHeader";
import { ACCENT } from "@/lib/accents";
import { cn } from "@/lib/utils";

type Tab = "screens" | "followups" | "ideas" | "changes" | "notes";
const TABS: { key: Tab; label: string; icon: React.ElementType; hint: string }[] = [
  { key: "screens", label: "Screens", icon: Smartphone, hint: "Every customer screen, tap through it" },
  { key: "followups", label: "Follow-ups", icon: Repeat, hint: "Every follow-up: what runs today, and the plan" },
  { key: "ideas", label: "Ideas", icon: Lightbulb, hint: "Saved for later" },
  { key: "changes", label: "Changes", icon: History, hint: "What went live, newest first" },
  { key: "notes", label: "Notes", icon: NotebookPen, hint: "The proposal project notes" },
];
// The row under a section, where it has one.
const SCREEN_VIEWS = [
  { key: "proposal", label: "Proposal", hint: "The interactive proposal and the pay page, as the customer taps through them" },
  { key: "quote", label: "Quote generator", hint: "Get my price: the self-serve quote, as a mock" },
];
// The save-for-later folder, bundled in at build time so it reads here
// without a server. Each file's first heading is its title.
const IDEA_FILES = import.meta.glob("../../../docs/ideas/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const IDEAS = Object.entries(IDEA_FILES)
  .filter(([path]) => !/README\.md$/.test(path))
  .map(([path, text]) => ({
    key: path.split("/").pop()!.replace(/\.md$/, ""),
    title: text.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.split("/").pop()!,
    text,
  }))
  .sort((a, b) => a.title.localeCompare(b.title));

// The "Status:" line near the top of the notes, so the pill and the file
// can never disagree.
const STATUS = notes.match(/^Status:\s*(.+)$/m)?.[1]?.trim() || "Planning";

// What the second row holds for each section: views to pick, or one line
// saying what's below, so the row is always the same height.
const SUBS: Record<Tab, { key: string; label: string; hint?: string }[]> = {
  screens: SCREEN_VIEWS,
  followups: FOLLOWUP_VIEWS,
  ideas: IDEAS.map((i) => ({ key: i.key, label: i.title })),
  changes: [],
  notes: [],
};
const ROW_NOTE: Partial<Record<Tab, string>> = {
  ideas: "Nothing saved yet",
  changes: `${DESIGN_CHANGES.length} changes, newest first · the day is when it went live`,
  notes: `The proposal project notes · Status: ${STATUS} · read-only here`,
};
/** A card's text stays a comfortable reading width even though the page is wide. */
const READ = "max-w-3xl";

const PROSE = [
  "text-sm leading-relaxed text-foreground/90",
  "[&_h1]:font-heading [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:text-ink [&_h1]:mb-2",
  "[&_h2]:font-heading [&_h2]:text-lg [&_h2]:font-bold [&_h2]:text-ink [&_h2]:mt-7 [&_h2]:mb-2 [&_h2]:border-b [&_h2]:border-ink/10 [&_h2]:pb-1",
  "[&_h3]:mt-5 [&_h3]:mb-1 [&_h3]:text-[11px] [&_h3]:font-bold [&_h3]:uppercase [&_h3]:tracking-wider [&_h3]:text-bronze",
  "[&_p]:my-2",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5",
  "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-5",
  "[&_li>p]:my-0",
  "[&_a]:text-bronze [&_a]:underline [&_a]:underline-offset-2",
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12px]",
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-ink [&_pre]:p-3 [&_pre]:text-ivory",
  "[&_blockquote]:my-3 [&_blockquote]:rounded-r-xl [&_blockquote]:border-l-4 [&_blockquote]:border-rose-500 [&_blockquote]:bg-rose-50 [&_blockquote]:px-3 [&_blockquote]:py-2 [&_blockquote]:text-rose-900",
  "[&_table]:my-2 [&_table]:w-full [&_th]:border-b [&_th]:border-ink/10 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:text-[11px] [&_th]:font-bold [&_th]:uppercase [&_td]:border-b [&_td]:border-ink/5 [&_td]:px-2 [&_td]:py-1 [&_td]:align-top",
  "[&_hr]:my-5 [&_hr]:border-ink/10",
  "[&_strong]:font-semibold [&_strong]:text-ink",
  "[&_input[type=checkbox]]:mr-1.5 [&_input[type=checkbox]]:h-3.5 [&_input[type=checkbox]]:w-3.5 [&_input[type=checkbox]]:align-middle [&_input[type=checkbox]]:accent-gold",
  "[&_li:has(input)]:list-none [&_li:has(input)]:-ml-5",
].join(" ");

const day = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
};

export default function DesignLab() {
  const [params, setParams] = useSearchParams();
  const rawTab = params.get("tab");
  // Old addresses still open: ?tab=quote was the quote mock before it moved under Screens.
  const tab: Tab = rawTab === "quote" ? "screens" : TABS.some((t) => t.key === rawTab) ? (rawTab as Tab) : "screens";
  const subs = SUBS[tab] || [];
  const rawView = rawTab === "quote" ? "quote" : params.get("view");
  const view = subs.some((s) => s.key === rawView) ? rawView! : subs[0]?.key || "";
  const pick = (k: Tab) => setParams((p) => { const n = new URLSearchParams(p); n.set("tab", k); n.delete("view"); return n; }, { replace: true });
  const pickView = (v: string) => setParams((p) => { const n = new URLSearchParams(p); n.set("tab", tab); n.set("view", v); return n; }, { replace: true });
  const ideaDoc = IDEAS.find((i) => i.key === view) || IDEAS[0];
  const byDate = useMemo(() => {
    const out: { date: string; items: typeof DESIGN_CHANGES }[] = [];
    for (const c of DESIGN_CHANGES) {
      const last = out[out.length - 1];
      if (last && last.date === c.date) last.items.push(c); else out.push({ date: c.date, items: [c] });
    }
    return out;
  }, []);
  const fullScreen = tab === "screens" ? (view === "quote" ? "/quote-mockup" : "/new-proposal/mockup") : "";
  const count = (k: Tab) => (k === "changes" ? DESIGN_CHANGES.length : k === "ideas" ? IDEAS.length : 0);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
      <HubHeader icon={FlaskConical} title="Design Lab"
        subtitle="Everything a customer sees or hears from us, before they do. Nothing on this page sends anything."
        tabs={TABS.map((t) => ({ ...t, count: count(t.key) }))} tab={tab} onTab={pick}
        views={subs} view={view} onView={pickView} note={ROW_NOTE[tab]}
        action={fullScreen ? (
          <Link to={fullScreen} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-gradient-to-r from-gold to-bronze px-3 text-xs font-bold text-ink shadow-sm ring-1 ring-gold-light/60 transition hover:brightness-110 active:scale-95">
            <Maximize2 className="h-3.5 w-3.5" /> Full screen
          </Link>
        ) : null} />

      {tab === "screens" && view === "proposal" ? (
        <div className="overflow-hidden rounded-2xl ring-1 ring-ink/10">
          <ProposalMockup embedded />
        </div>
      ) : null}

      {tab === "screens" && view === "quote" ? <QuoteMockup embedded /> : null}

      {tab === "followups" ? <FollowUpEngine embedded view={view as FollowUpView} /> : null}

      {tab === "ideas" ? (
        <Panel icon={Lightbulb} title={ideaDoc ? ideaDoc.title : "Ideas, saved for later"} sub='Say "save that for later" in chat and it lands in the matching file' accent={ACCENT.gold} bodyClassName="p-4 md:p-5">
          {ideaDoc
            ? <article className={cn(PROSE, READ)}><ReactMarkdown remarkPlugins={[remarkGfm]}>{ideaDoc.text}</ReactMarkdown></article>
            : <p className="text-sm text-muted-foreground">Nothing saved yet.</p>}
        </Panel>
      ) : null}

      {tab === "changes" ? (
        <Panel icon={History} title="What changed on customer screens" sub="Newest first. The day is when it went live." accent={ACCENT.gold} bodyClassName="p-4 md:p-5">
          <ol className={cn("space-y-5", READ)}>
            {byDate.map((g) => (
              <li key={g.date}>
                <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-bronze">{day(g.date)}</p>
                <ul className="space-y-2">
                  {g.items.map((c) => (
                    <li key={c.title} className="rounded-xl bg-muted/40 px-3.5 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-[15px] font-bold text-ink">{c.title}</p>
                        {c.open ? <Link to={c.open.to} className="shrink-0 text-[13px] font-bold text-bronze underline underline-offset-2">{c.open.label}</Link> : null}
                      </div>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{c.what}</p>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </Panel>
      ) : null}

      {tab === "notes" ? (
        <>
          <div className="flex items-start gap-2 rounded-2xl bg-rose-500/10 px-4 py-2.5 text-xs text-rose-900 ring-1 ring-rose-500/20">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <p>These notes are read-only here; edits land through the chat and a deploy. Status: <b>{STATUS}</b>.</p>
          </div>
          <Panel icon={NotebookPen} title="Project notes" sub="The interactive proposal, as planned and as built" accent={ACCENT.gold} bodyClassName="p-4 md:p-5">
            <article className={cn(PROSE, READ)}><ReactMarkdown remarkPlugins={[remarkGfm]}>{notes}</ReactMarkdown></article>
          </Panel>
        </>
      ) : null}
    </div>
  );
}
