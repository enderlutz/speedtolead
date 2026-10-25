// Follow-Up Engine (Alan, 2026-10-24): its own tab, out of Settings, because
// moving the customer-facing follow-ups (texts first, then calls, email and
// maybe handwritten cards) off GHL and into the dashboard is the big job.
//
// For now it is the "before" picture and changes nothing:
//   * Overview — the plan, and what to fix, found while mapping GHL.
//   * Sterling / A&T's — every GHL follow-up chain, step by step, word for word.
//   * Shared — the GHL Home-folder workflows, and the ones not running.
//   * Both boards — live: everyone with a card on both GHL boards, and
//     whether GHL is texting them on both (the thing never to make worse).
//   * Engine — the dashboard's own engine (master switch, sequences), moved
//     here from Settings unchanged. It stays off until the move is planned.
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, ArrowRight, Bell, Clock, GitBranch, Loader2, MessageSquare, Phone, RefreshCw, Rocket, ShieldOff, Tag, Users } from "lucide-react";
import { api, type BoardOverlap } from "@/lib/api";
import { BOARDS, ISSUES, NOT_RUNNING, SHARED, type Chain, type Step, type StepKind } from "@/lib/ghlFollowupMap";
import FollowUpSettingsCard from "@/components/FollowUpSettingsCard";
import { cn } from "@/lib/utils";

const INK = "#1F1A14";
const MUTED = "#6B6052";
const LINE = "#E4DCCB";
const GOLD = "#C9972F";

type TabKey = "overview" | "sterling" | "at" | "shared" | "both" | "engine";
const TABS: [TabKey, string][] = [
  ["overview", "Overview"], ["sterling", "Sterling"], ["at", "A&T's"],
  ["shared", "Shared"], ["both", "Both boards"], ["engine", "Engine"],
];

const KIND: Record<StepKind, { icon: typeof Clock; tint: string; word: string }> = {
  start: { icon: Rocket, tint: "bg-stone-100 text-stone-700", word: "Starts" },
  wait: { icon: Clock, tint: "bg-violet-50 text-violet-700", word: "Wait" },
  text: { icon: MessageSquare, tint: "bg-emerald-50 text-emerald-700", word: "Text" },
  move: { icon: ArrowRight, tint: "bg-sky-50 text-sky-700", word: "Card" },
  tag: { icon: Tag, tint: "bg-amber-50 text-amber-800", word: "Tag" },
  alert: { icon: Bell, tint: "bg-orange-50 text-orange-700", word: "Team" },
  branch: { icon: GitBranch, tint: "bg-stone-100 text-stone-700", word: "Split" },
  stop: { icon: ShieldOff, tint: "bg-rose-50 text-rose-700", word: "Stop" },
  call: { icon: Phone, tint: "bg-rose-50 text-rose-700", word: "Call" },
};

function StepRow({ s }: { s: Step }) {
  const k = KIND[s.kind];
  const Icon = k.icon;
  return (
    <li className="flex gap-3">
      <span className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full", k.tint)}><Icon className="h-4 w-4" /></span>
      <div className="min-w-0 flex-1 pb-3">
        <p className="text-[15px] font-semibold" style={{ color: INK }}>
          {s.label}
          {typeof s.waiting === "number" ? <span className="ml-2 rounded-full bg-sky-50 px-2 py-0.5 text-[13px] font-bold text-sky-800">{s.waiting} here now</span> : null}
        </p>
        {s.text ? <p className={cn("mt-1 whitespace-pre-line rounded-xl px-3 py-2 text-[14px] leading-relaxed", s.kind === "text" ? "bg-emerald-50/60" : "bg-stone-50")} style={{ color: s.text.startsWith("(") ? MUTED : INK }}>{s.text}</p> : null}
        {s.flag ? <p className="mt-1 flex items-start gap-1.5 text-[14px] font-semibold text-rose-700"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{s.flag}</p> : null}
      </div>
    </li>
  );
}

function ChainCard({ c }: { c: Chain }) {
  const [open, setOpen] = useState(false);
  const texts = c.steps.filter((s) => s.kind === "text").length;
  const flagged = c.steps.some((s) => s.flag);
  return (
    <section className="rounded-2xl border bg-white shadow-sm" style={{ borderColor: LINE }}>
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full min-h-11 items-start justify-between gap-3 p-4 text-left">
        <div className="min-w-0">
          <p className="text-[17px] font-bold" style={{ color: INK }}>{c.title}</p>
          <p className="mt-0.5 text-[14px]" style={{ color: MUTED }}>{c.startsWhen}</p>
          <p className="mt-1 text-[13px]" style={{ color: MUTED }}>GHL: {c.workflows.join(" · ")}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {typeof c.now === "number" ? <span className={cn("rounded-full px-2.5 py-1 text-[13px] font-bold", c.now > 0 ? "bg-sky-50 text-sky-800" : "bg-stone-100 text-stone-600")}>{c.now} in it now</span> : null}
          <span className="text-[13px]" style={{ color: MUTED }}>{texts} {texts === 1 ? "text" : "texts"}{typeof c.total === "number" ? ` · ${c.total.toLocaleString()} so far` : ""}</span>
          {flagged ? <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[13px] font-bold text-rose-700">fix</span> : null}
        </div>
      </button>
      {open ? (
        <div className="border-t px-4 pb-2 pt-4" style={{ borderColor: LINE }}>
          <ol>{c.steps.map((s, i) => <StepRow key={i} s={s} />)}</ol>
          {c.onReply?.length ? (
            <div className="mb-3 rounded-xl border border-dashed p-3" style={{ borderColor: LINE }}>
              <p className="mb-2 text-[13px] font-bold uppercase tracking-wide" style={{ color: MUTED }}>When they reply</p>
              <ol>{c.onReply.map((s, i) => <StepRow key={i} s={s} />)}</ol>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function BoardTab({ k }: { k: "sterling" | "at" }) {
  const b = BOARDS.find((x) => x.key === k)!;
  const now = b.chains.reduce((t, c) => t + (c.now || 0), 0);
  return (
    <div className="space-y-3">
      <div className="rounded-2xl border bg-[#FBF8F2] p-4" style={{ borderColor: LINE }}>
        <p className="text-[15px]" style={{ color: INK }}><b>GHL board:</b> {b.ghlBoard} · <b>folder:</b> {b.ghlFolder}</p>
        <p className="mt-1 text-[14px]" style={{ color: MUTED }}>{b.blurb}</p>
        <p className="mt-2 text-[15px] font-bold" style={{ color: INK }}>{now} people are partway through these right now.</p>
      </div>
      {b.chains.map((c) => <ChainCard key={c.id} c={c} />)}
      <section className={cn("rounded-2xl border p-4", b.stopRule.exists ? "bg-white" : "bg-rose-50")} style={{ borderColor: b.stopRule.exists ? LINE : "#FDA4AF" }}>
        <p className="flex items-center gap-2 text-[16px] font-bold" style={{ color: INK }}>
          <ShieldOff className="h-4 w-4" /> When a deal closes {b.stopRule.exists ? "" : <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[13px] text-rose-800">missing</span>}
        </p>
        <p className="mt-1 text-[14px]" style={{ color: INK }}>{b.stopRule.text}</p>
      </section>
    </div>
  );
}

function Overview() {
  const sterlingNow = BOARDS[0].chains.reduce((t, c) => t + (c.now || 0), 0);
  const atNow = BOARDS[1].chains.reduce((t, c) => t + (c.now || 0), 0);
  return (
    <div className="space-y-3">
      <section className="rounded-2xl border bg-white p-4" style={{ borderColor: LINE }}>
        <p className="text-[17px] font-bold" style={{ color: INK }}>GHL sends every follow-up today. Nothing here sends.</p>
        <p className="mt-1 text-[15px]" style={{ color: INK }}>
          The plan: the dashboard takes over the follow-ups the customer sees (texts first, then calls, email and more), and GHL keeps the phone line, the forms and the triggers.
          New leads move first; anyone already partway through a GHL follow-up finishes it there, so nobody is cut off or texted twice.
        </p>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-[15px]" style={{ color: INK }}>
          <li><b>Sterling first</b>: {sterlingNow} people partway through today.</li>
          <li><b>Then A&amp;T&rsquo;s</b>: {atNow} partway through, most of them in long-term nurture.</li>
          <li>Each GHL follow-up is switched off only when it shows 0 people in it.</li>
        </ol>
      </section>
      <p className="pt-1 text-[13px] font-bold uppercase tracking-wide" style={{ color: MUTED }}>Fix, found while mapping GHL</p>
      {ISSUES.map((i) => (
        <section key={i.title} className="rounded-2xl border bg-white p-4" style={{ borderColor: LINE }}>
          <p className="flex items-start gap-2 text-[16px] font-bold text-rose-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{i.title}</p>
          <p className="mt-1 text-[14px]" style={{ color: INK }}>{i.detail}</p>
          <p className="mt-1 text-[14px] font-semibold" style={{ color: GOLD }}>{i.safe}</p>
        </section>
      ))}
    </div>
  );
}

function SharedTab() {
  return (
    <div className="space-y-3">
      {SHARED.map((w) => (
        <section key={w.name} className="rounded-2xl border bg-white p-4" style={{ borderColor: LINE }}>
          <p className="text-[16px] font-bold" style={{ color: INK }}>{w.name}{typeof w.total === "number" ? <span className="ml-2 text-[13px] font-normal" style={{ color: MUTED }}>{w.total.toLocaleString()} so far</span> : null}</p>
          <p className="mt-1 text-[14px]" style={{ color: INK }}>{w.what}</p>
          {w.rule ? <p className="mt-1 text-[14px] font-semibold text-rose-700">{w.rule}</p> : null}
        </section>
      ))}
      <section className="rounded-2xl border border-dashed bg-white p-4" style={{ borderColor: LINE }}>
        <p className="text-[16px] font-bold" style={{ color: INK }}>Not running</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[14px]" style={{ color: MUTED }}>{NOT_RUNNING.map((n) => <li key={n}>{n}</li>)}</ul>
      </section>
    </div>
  );
}

const RISK = {
  both_texting: { word: "Texting column on both", cls: "bg-rose-50 text-rose-800" },
  one_texting: { word: "Texting column on one", cls: "bg-amber-50 text-amber-800" },
  quiet: { word: "Quiet", cls: "bg-stone-100 text-stone-600" },
} as const;

function BothTab() {
  const [d, setD] = useState<BoardOverlap | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [show, setShow] = useState<"risky" | "all">("risky");
  const load = (refresh = false) => {
    setLoading(true); setErr("");
    api.getBoardOverlap(refresh).then(setD).catch((e) => setErr(e instanceof Error ? e.message : "Couldn't read GHL")).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);
  const rows = (d?.both || []).filter((b) => show === "all" || b.risk !== "quiet");
  return (
    <div className="space-y-3">
      <section className="rounded-2xl border bg-white p-4" style={{ borderColor: LINE }}>
        <p className="text-[15px]" style={{ color: INK }}>
          The same person can have a card on <b>A&amp;T&rsquo;s board</b> and on <b>Sterling&rsquo;s</b>, under one GHL contact or two contacts with the same phone.
          GHL runs each board&rsquo;s follow-ups separately, so they can get two sets of texts. &ldquo;Texting column&rdquo; means the card sits where a GHL follow-up runs (New Lead, Address Follow Up, Estimate Sent, Long Term Nurture); GHL doesn&rsquo;t say whether their texts there already finished. Read live from GHL; nothing here changes anything.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {d ? (
            <>
              <span className="rounded-full bg-stone-100 px-3 py-1 text-[14px] font-bold" style={{ color: INK }}><Users className="mr-1 inline h-4 w-4" />{d.counts.both} on both boards</span>
              <span className="rounded-full bg-rose-50 px-3 py-1 text-[14px] font-bold text-rose-800">{d.counts.both_texting} in a texting column on both</span>
              <span className="rounded-full bg-amber-50 px-3 py-1 text-[14px] font-bold text-amber-800">{d.counts.one_texting} on one</span>
              <span className="rounded-full bg-stone-100 px-3 py-1 text-[14px] font-bold" style={{ color: MUTED }}>{d.counts.two_contacts_one_phone} are two contacts, one phone</span>
            </>
          ) : null}
          <button type="button" onClick={() => load(true)} disabled={loading} className="ml-auto inline-flex min-h-11 items-center gap-1.5 rounded-xl border px-3.5 text-[15px] font-bold disabled:opacity-50" style={{ borderColor: LINE, color: INK }}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Check GHL again
          </button>
        </div>
        {d ? (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {(["sterling", "at"] as const).map((k) => (
              <div key={k} className="rounded-xl bg-[#FBF8F2] p-3 text-[14px]" style={{ color: INK }}>
                <b>{k === "at" ? "A&T's board" : "Sterling's board"}</b>: {d.boards[k].total.toLocaleString()} cards, {d.boards[k].texting.toLocaleString()} in a column GHL texts from
              </div>
            ))}
          </div>
        ) : null}
      </section>
      {err ? <p className="rounded-xl bg-red-50 p-3 text-[15px] text-red-800">{err}</p> : null}
      {d ? (
        <div className="flex gap-2">
          {([["risky", "In a texting column"], ["all", "Everyone on both"]] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setShow(k)} className={cn("min-h-10 rounded-full px-3.5 text-[14px] font-bold ring-1", show === k ? "bg-[#1F1A14] text-white ring-[#1F1A14]" : "bg-white ring-[#E4DCCB]")} style={show === k ? undefined : { color: INK }}>{l}</button>
          ))}
        </div>
      ) : null}
      <ul className="space-y-2">
        {rows.map((b) => (
          <li key={`${b.at.opp_id}-${b.sterling.opp_id}`} className="rounded-2xl border bg-white p-3.5" style={{ borderColor: LINE }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[16px] font-bold" style={{ color: INK }}>{b.name || "No name"} <span className="text-[14px] font-normal" style={{ color: MUTED }}>{b.phone}</span></p>
              <span className={cn("rounded-full px-2.5 py-1 text-[13px] font-bold", RISK[b.risk].cls)}>{RISK[b.risk].word}</span>
            </div>
            <div className="mt-2 grid gap-1.5 text-[14px] sm:grid-cols-2">
              {([["Sterling", b.sterling], ["A&T's", b.at]] as const).map(([label, c]) => (
                <p key={label} style={{ color: INK }}>
                  <b>{label}:</b> {c.stage || "unknown column"}{c.status && c.status !== "open" ? ` (${c.status})` : ""}
                  {c.texting ? <span className="ml-1.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[13px] font-bold text-emerald-800">texting column</span> : null}
                </p>
              ))}
            </div>
            {!b.same_contact ? <p className="mt-1 text-[13px]" style={{ color: MUTED }}>Two GHL contacts with the same phone</p> : null}
          </li>
        ))}
      </ul>
      {d && !rows.length ? <p className="rounded-2xl border border-dashed bg-white p-6 text-center text-[15px]" style={{ borderColor: LINE, color: MUTED }}>Nobody here.</p> : null}
    </div>
  );
}

export default function FollowUpEngine() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find(([k]) => k === params.get("tab"))?.[0] || "overview") as TabKey;
  return (
    <div className="mx-auto max-w-4xl space-y-4 px-4 py-5">
      <div>
        <h1 className="text-[24px] font-bold" style={{ color: INK }}>Follow-Up Engine</h1>
        <p className="text-[15px]" style={{ color: MUTED }}>Every follow-up GHL sends today, and where they&rsquo;re moving. Read only for now.</p>
      </div>
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" onClick={() => setParams({ tab: k }, { replace: true })}
            className={cn("min-h-11 shrink-0 rounded-full px-4 text-[15px] font-bold ring-1 transition", tab === k ? "bg-[#1F1A14] text-white ring-[#1F1A14]" : "bg-white ring-[#E4DCCB] hover:bg-[#F8F3E7]")}
            style={tab === k ? undefined : { color: INK }}>
            {label}
          </button>
        ))}
      </div>
      {tab === "overview" ? <Overview /> : null}
      {tab === "sterling" ? <BoardTab k="sterling" /> : null}
      {tab === "at" ? <BoardTab k="at" /> : null}
      {tab === "shared" ? <SharedTab /> : null}
      {tab === "both" ? <BothTab /> : null}
      {tab === "engine" ? (
        <div className="space-y-3">
          <p className="rounded-2xl border bg-[#FBF8F2] p-4 text-[15px]" style={{ borderColor: LINE, color: INK }}>
            The dashboard&rsquo;s own engine, moved here from Settings unchanged. Every sequence in it is switched off; GHL still sends everything. Leave it off until the move is planned.
          </p>
          <FollowUpSettingsCard />
        </div>
      ) : null}
    </div>
  );
}
