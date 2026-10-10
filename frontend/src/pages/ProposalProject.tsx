// The project notes for the new interactive proposal, shown in the
// dashboard so they can be read from anywhere. Alan (2026-10-09): "just in
// case I start editing something else I can always refer back to that md
// file." The file, src/content/proposal-v2.md, is the source; this page only
// renders it. Edits land through the chat and a deploy, so the page is
// read-only on purpose — nothing here is a form, and nothing here can send
// anything to a customer.
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "react-router-dom";
import notes from "@/content/proposal-v2.md?raw";
import { Lightbulb, ShieldAlert, GitBranch, Smartphone } from "lucide-react";
import { Panel } from "@/components/Panel";
import { ACCENT } from "@/lib/accents";

// The "Status:" line near the top of the file, so the header and the file
// can never disagree.
const STATUS = notes.match(/^Status:\s*(.+)$/m)?.[1]?.trim() || "Planning";

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

export default function ProposalProject() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <div className="overflow-hidden rounded-2xl bg-ink text-ivory shadow-lg">
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-gold to-bronze shadow-sm">
            <Lightbulb className="h-5 w-5 text-ink" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="font-heading text-xl font-bold leading-tight">New Proposal</h1>
            <p className="text-xs text-ivory/70">Design and planning notes for the interactive proposal</p>
          </div>
          <span className="rounded-full bg-gold/20 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-gold-light ring-1 ring-gold/40">
            {STATUS}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-ivory/80">
            <GitBranch className="h-3 w-3" /> proposal-v2
          </span>
          <Link
            to="/new-proposal/mockup"
            className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-gradient-to-r from-gold to-bronze px-3 text-xs font-bold text-ink shadow-sm ring-1 ring-gold-light/60 transition hover:brightness-110 active:scale-95"
          >
            <Smartphone className="h-3.5 w-3.5" /> Open the mockup
          </Link>
        </div>
        <div className="flex items-start gap-2 border-t border-white/10 bg-rose-500/15 px-5 py-2.5 text-xs text-rose-100">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-300" />
          <p>
            Nothing here reaches a customer. Every send still makes today's proposal until the launch
            gate at the bottom of this page is fully checked and the link runs on the Sterling domain.
          </p>
        </div>
      </div>

      <Panel
        icon={Lightbulb}
        title="Project notes"
        sub="Answer the questions in chat; the answers are written back here"
        accent={ACCENT.gold}
        bodyClassName="p-4 md:p-5"
      >
        <article className={PROSE}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{notes}</ReactMarkdown>
        </article>
      </Panel>
    </div>
  );
}
