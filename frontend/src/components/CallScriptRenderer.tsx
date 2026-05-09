/**
 * Tiny markdown renderer for the call script. Handles ##/### headings,
 * **bold**, *italic*, > blockquotes, --- separators, and unordered lists.
 * Skips a real markdown library to avoid a 30 KB dep for ~80 lines of code.
 *
 * Variables that survived render (because the lead doesn't have that data
 * yet) are highlighted in amber so the VA notices "oh, we don't know that".
 */
import React from "react";

export function CallScriptRenderer({ source }: { source: string }) {
  const blocks = parseBlocks(source);
  return (
    <div className="text-sm leading-relaxed text-foreground space-y-2">
      {blocks.map((b, i) => renderBlock(b, i))}
    </div>
  );
}

type Block =
  | { type: "h2"; text: string }
  | { type: "h3"; text: string }
  | { type: "hr" }
  | { type: "quote"; lines: string[] }
  | { type: "list"; items: string[] }
  | { type: "p"; text: string };

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
    if (trimmed.startsWith("> ")) {
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
      && !lines[i].trim().startsWith("> ")
      && !lines[i].trim().startsWith("- ")
      && lines[i].trim() !== "---"
    ) {
      buf.push(lines[i].trim());
      i++;
    }
    out.push({ type: "p", text: buf.join(" ") });
  }
  return out;
}

function renderBlock(b: Block, key: number): React.ReactNode {
  switch (b.type) {
    case "h2":
      return <h2 key={key} className="text-lg font-bold text-foreground mt-4 first:mt-0 pb-1 border-b">{renderInline(b.text)}</h2>;
    case "h3":
      return <h3 key={key} className="text-sm font-bold text-muted-foreground uppercase tracking-wide mt-3">{renderInline(b.text)}</h3>;
    case "hr":
      return <hr key={key} className="border-t border-border my-2" />;
    case "quote":
      return (
        <blockquote key={key} className="border-l-2 border-primary/40 bg-primary/5 pl-3 py-1.5 italic text-sm">
          {b.lines.map((l, i) => <p key={i} className={l ? "" : "h-2"}>{renderInline(l)}</p>)}
        </blockquote>
      );
    case "list":
      return (
        <ul key={key} className="list-disc list-inside space-y-0.5 ml-1">
          {b.items.map((it, i) => <li key={i}>{renderInline(it)}</li>)}
        </ul>
      );
    case "p":
      return <p key={key}>{renderInline(b.text)}</p>;
  }
}

/** Inline formatting: **bold**, *italic*, and {{leftover}} variable highlight. */
function renderInline(text: string): React.ReactNode {
  // Tokenize on **bold**, *italic*, {{var}}; everything else stays as text.
  const tokens = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|\{\{\w+\}\})/g).filter(Boolean);
  return tokens.map((tok, i) => {
    if (tok.startsWith("**") && tok.endsWith("**")) {
      return <strong key={i} className="font-bold">{tok.slice(2, -2)}</strong>;
    }
    if (tok.startsWith("*") && tok.endsWith("*")) {
      return <em key={i} className="italic">{tok.slice(1, -1)}</em>;
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
