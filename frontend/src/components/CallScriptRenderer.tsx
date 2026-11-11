/**
 * Tiny markdown renderer for the call script. Handles ##/### headings,
 * **bold**, *italic*, > blockquotes, --- separators, and unordered lists.
 * Skips a real markdown library to avoid a 30 KB dep for ~80 lines of code.
 *
 * Read-off-the-screen blocks (Alan, 2026-11-10: "make it so easy, color
 * format it, I want Olga to read off of it"):
 *   > line            SAY card: the words to say, big and green
 *   DO: text          what to do (send the proposal, let them talk)
 *   IF: text          a branch ("If they pick a package")
 *   RULE: text        a hard rule, red
 *   TIP: text         why we say it / a coaching note, gold
 *   ## 3. Title       numbered step header (number becomes a badge)
 *   [LAST NAME]       fill-in placeholder, highlighted
 *
 * Variables that survived render (because the lead doesn't have that data
 * yet) are highlighted in amber so the VA notices "oh, we don't know that".
 */
import React from "react";

export function CallScriptRenderer({ source }: { source: string }) {
  const blocks = parseBlocks(source);
  return (
    <div className="text-[15px] leading-relaxed text-foreground space-y-2.5">
      {blocks.map((b, i) => renderBlock(b, i))}
    </div>
  );
}

type Tag = "DO" | "IF" | "RULE" | "TIP";

type Block =
  | { type: "h2"; text: string }
  | { type: "h3"; text: string }
  | { type: "hr" }
  | { type: "quote"; lines: string[] }
  | { type: "list"; items: string[] }
  | { type: "tag"; tag: Tag; text: string }
  | { type: "p"; text: string };

const TAG_RE = /^(DO|IF|RULE|TIP):\s*/;

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) { i++; continue; }
    if (trimmed === "---") { out.push({ type: "hr" }); i++; continue; }

    if (trimmed.startsWith("## ")) {
      out.push({ type: "h2", text: trimmed.slice(3) });
      i++; continue;
    }
    if (trimmed.startsWith("### ")) {
      out.push({ type: "h3", text: trimmed.slice(4) });
      i++; continue;
    }
    const tag = trimmed.match(TAG_RE);
    if (tag) {
      out.push({ type: "tag", tag: tag[1] as Tag, text: trimmed.slice(tag[0].length) });
      i++; continue;
    }
    if (trimmed.startsWith("> ") || trimmed === ">") {
      const buf: string[] = [];
      while (i < lines.length && (lines[i].trim().startsWith(">") || lines[i].trim() === "")) {
        const t = lines[i].trim();
        if (t.startsWith(">")) buf.push(t.replace(/^>\s?/, ""));
        else if (buf.length > 0) buf.push("");  // preserve in-quote blank lines
        i++;
        if (i < lines.length && !lines[i].trim().startsWith(">") && lines[i].trim() !== "") break;
      }
      // Drop trailing blanks
      while (buf.length && buf[buf.length - 1] === "") buf.pop();
      out.push({ type: "quote", lines: buf });
      continue;
    }
    if (trimmed.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("- ")) {
        items.push(lines[i].trim().slice(2));
        i++;
      }
      out.push({ type: "list", items });
      continue;
    }
    // paragraph — collect contiguous non-blank lines that aren't a special block start
    const buf: string[] = [trimmed];
    i++;
    while (
      i < lines.length
      && lines[i].trim() !== ""
      && !lines[i].trim().startsWith("##")
      && !lines[i].trim().startsWith(">")
      && !lines[i].trim().startsWith("- ")
      && !TAG_RE.test(lines[i].trim())
      && lines[i].trim() !== "---"
    ) {
      buf.push(lines[i].trim());
      i++;
    }
    out.push({ type: "p", text: buf.join(" ") });
  }
  return out;
}

const TAG_STYLE: Record<Tag, { box: string; chip: string; label: string }> = {
  DO: {
    box: "border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/40",
    chip: "bg-ink text-gold-light",
    label: "DO",
  },
  IF: {
    box: "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30",
    chip: "bg-amber-500 text-white",
    label: "IF",
  },
  RULE: {
    box: "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/30",
    chip: "bg-red-600 text-white",
    label: "RULE",
  },
  TIP: {
    box: "border-gold/50 bg-gold/10",
    chip: "bg-cedar text-white",
    label: "WHY",
  },
};

function renderBlock(b: Block, key: number): React.ReactNode {
  switch (b.type) {
    case "h2": {
      const m = b.text.match(/^(\d+)[.)]\s+(.*)$/);
      return (
        <h2 key={key} className="mt-6 first:mt-0 flex items-center gap-2.5 border-b-2 border-ink/10 pb-1.5 text-lg font-bold text-foreground">
          {m && (
            <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-sm font-bold text-gold-light tabular-nums">
              {m[1]}
            </span>
          )}
          <span>{renderInline(m ? m[2] : b.text)}</span>
        </h2>
      );
    }
    case "h3":
      return <h3 key={key} className="mt-4 text-sm font-bold uppercase tracking-wide text-cedar">{renderInline(b.text)}</h3>;
    case "hr":
      return <hr key={key} className="my-4 border-t-2 border-dashed border-border" />;
    case "quote":
      return (
        <blockquote key={key} className="relative rounded-xl border border-emerald-300 bg-emerald-50 px-4 pb-3 pt-6 text-base leading-relaxed text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-50">
          <span className="absolute left-3 top-1.5 rounded bg-emerald-600 px-1.5 py-px text-[11px] font-bold tracking-wider text-white">SAY</span>
          {b.lines.map((l, i) => <p key={i} className={l ? "" : "h-2"}>{renderInline(l)}</p>)}
        </blockquote>
      );
    case "tag": {
      const st = TAG_STYLE[b.tag];
      return (
        <div key={key} className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 ${st.box}`}>
          <span className={`mt-0.5 shrink-0 rounded px-1.5 py-px text-[11px] font-bold tracking-wider ${st.chip}`}>{st.label}</span>
          <div className={b.tag === "IF" ? "font-semibold" : ""}>{renderInline(b.text)}</div>
        </div>
      );
    }
    case "list":
      return (
        <ul key={key} className="list-disc space-y-1 pl-5">
          {b.items.map((it, i) => <li key={i}>{renderInline(it)}</li>)}
        </ul>
      );
    case "p":
      return <p key={key}>{renderInline(b.text)}</p>;
  }
}

/** Inline formatting: **bold**, *italic*, [FILL IN] chips and {{leftover}} variable highlight. */
function renderInline(text: string): React.ReactNode {
  // Tokenize on **bold**, *italic*, {{var}}, [CAPS FILL-IN]; everything else stays as text.
  const tokens = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|\{\{\w+\}\}|\[[A-Z0-9][A-Z0-9 /&'._-]*\])/g).filter(Boolean);
  return tokens.map((tok, i) => {
    if (tok.startsWith("**") && tok.endsWith("**")) {
      return <strong key={i} className="font-bold">{tok.slice(2, -2)}</strong>;
    }
    if (tok.startsWith("*") && tok.endsWith("*") && tok.length > 2) {
      return <em key={i} className="italic">{tok.slice(1, -1)}</em>;
    }
    if (/^\[[A-Z0-9][A-Z0-9 /&'._-]*\]$/.test(tok)) {
      return (
        <span key={i} className="mx-0.5 rounded-md border border-gold/60 bg-gold/20 px-1.5 py-px text-[13px] font-bold not-italic text-ink dark:text-gold-light">
          {tok.slice(1, -1)}
        </span>
      );
    }
    if (tok.startsWith("{{") && tok.endsWith("}}")) {
      // Unsubstituted variable — flag it to the VA
      return (
        <span
          key={i}
          className="bg-amber-100 text-amber-900 px-1 rounded font-mono text-[11px] border border-amber-200"
          title="No data for this variable on the current lead"
        >
          {tok}
        </span>
      );
    }
    return <React.Fragment key={i}>{tok}</React.Fragment>;
  });
}
