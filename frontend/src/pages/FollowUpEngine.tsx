// Follow-Up Engine (Alan, 2026-10-24): its own tab, out of Settings, because
// moving the customer-facing follow-ups (texts first, then calls, email and
// maybe handwritten cards) off GHL and into the dashboard is the big job.
//
// Written so Olga's daughter could read it: the story first, the GHL names
// in small print, every text drawn as the bubble the customer sees, and a
// day counter down the side so "when" is never a mystery.
//
// For now it is the "before" picture and changes nothing:
//   * Overview — the story in five pictures, what's changing, what Alan
//     decided, what to fix, and a word list.
//   * Sterling / A&T's — every follow-up, day by day, word for word.
//   * Helpers — the GHL Home-folder workflows, and the ones switched off.
//   * Both boards — live: everyone with a card on both boards, and whether
//     GHL could be texting them from both (the thing never to make worse).
//   * Engine — the dashboard's own engine (master switch, sequences), moved
//     here from Settings unchanged. It stays off until the move is planned.
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, ArrowRight, Bell, CheckCircle2, Clock, GitBranch, Loader2, Phone, RefreshCw, ShieldOff, Tag, Users, Wrench } from "lucide-react";
import { api, type BoardOverlap } from "@/lib/api";
import { BOARDS, DECIDED, ISSUES, JOURNEY, NOT_RUNNING, SHARED, WORDS, type Chain, type Step } from "@/lib/ghlFollowupMap";
import FollowUpSettingsCard from "@/components/FollowUpSettingsCard";
import { cn } from "@/lib/utils";

const LINE = "#E4DCCB";

type TabKey = "overview" | "sterling" | "at" | "helpers" | "both" | "engine";
const TABS: [TabKey, string][] = [
  ["overview", "Overview"], ["sterling", "Sterling"], ["at", "A&T's"],
  ["helpers", "Helpers"], ["both", "Both boards"], ["engine", "Engine"],
];

const card = "rounded-2xl border bg-white shadow-sm";

/** "28 days" → "about a month". Sums the waits in a chain. */
function spanText(days: number) {
  if (days < 1) return "same day";
  if (days === 1) return "1 day";
  if (days <= 21) return `${days} days`;
  if (days <= 60) return `about ${Math.round(days / 7)} weeks`;
  if (days <= 330) return `about ${Math.round(days / 30)} months`;
  return "about a year";
}

function Bubble({ s, ageChip }: { s: Step; ageChip?: boolean }) {
  const unknown = !!s.text?.startsWith("(");
  return (
    <div className="max-w-[34rem]">
      <p className="mb-1 flex flex-wrap items-center gap-x-2 text-[14px]">
        {ageChip
          ? <span className="rounded-full bg-gold/15 px-2 py-0.5 font-bold text-bronze">{s.label}</span>
          : <><span className="font-bold text-ink">Amy texts</span><span className="text-muted-foreground">{s.label}</span></>}
      </p>
      <div className={cn("rounded-2xl rounded-tl-md border px-4 py-3 text-[15px] leading-relaxed", unknown ? "border-dashed italic text-muted-foreground" : "text-ink")} style={{ borderColor: LINE, background: unknown ? "transparent" : "#F8F3E7" }}>
        {unknown ? "We don't have the words for this one yet. They weren't on screen." : s.text}
      </div>
      {s.flag ? <p className="mt-1.5 flex items-start gap-1.5 text-[14px] font-bold text-red-700"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{s.flag}</p> : null}
    </div>
  );
}

/** One row of a follow-up. The day rail is drawn by the parent. */
function Row({ s, ageChip }: { s: Step; ageChip?: boolean }) {
  switch (s.kind) {
    case "text":
      return <Bubble s={s} ageChip={ageChip} />;
    case "alert":
      return (
        <div className="flex gap-2.5">
          <Bell className="mt-0.5 h-4 w-4 shrink-0 text-bronze" />
          <div><p className="text-[15px] font-semibold text-ink">{s.label}</p>{s.text ? <p className="text-[14px] text-muted-foreground">{s.text}</p> : null}</div>
        </div>
      );
    case "move":
      return (
        <div className="flex gap-2.5">
          <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-ink" />
          <div><p className="text-[15px] text-ink">{s.label}</p>{s.flag ? <p className="mt-1 flex items-start gap-1.5 text-[14px] font-bold text-red-700"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{s.flag}</p> : null}</div>
        </div>
      );
    case "tag":
      return <p className="flex gap-2.5 text-[14px] text-muted-foreground"><Tag className="mt-0.5 h-4 w-4 shrink-0" />{s.label}</p>;
    case "stop":
      return <p className="inline-flex items-center gap-2 rounded-full bg-red-50 px-3 py-1.5 text-[15px] font-bold text-red-800"><ShieldOff className="h-4 w-4" />{s.label}</p>;
    case "call":
      return (
        <div>
          <p className="inline-flex items-center gap-2 rounded-full bg-gold px-3 py-1.5 text-[15px] font-bold text-ink"><Phone className="h-4 w-4" />{s.label}</p>
          {s.text ? <p className="mt-1.5 text-[14px] text-muted-foreground">{s.text}</p> : null}
        </div>
      );
    case "branch":
      return <p className="flex items-center gap-2 font-heading text-[17px] font-semibold text-ink"><GitBranch className="h-5 w-5 text-bronze" />{s.label}</p>;
    default:
      return null;
  }
}

/** The steps down a rail with "Day N" on the left. Waits move the counter. */
function Rail({ steps }: { steps: Step[] }) {
  let day = 0;
  let shown = -1;
  let inBranch = false;
  const rows: React.ReactNode[] = [];
  steps.forEach((s, i) => {
    if (s.kind === "wait") {
      day += s.days ?? 0;
      inBranch = false;
      rows.push(
        <li key={i} className="relative py-2 pl-6">
          <span className="absolute -left-[7px] top-3 h-3 w-3 rounded-full border-2 border-white bg-stone-300" />
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] text-muted-foreground">
            <Clock className="h-4 w-4" /> then we wait {s.label}
            {typeof s.waiting === "number" ? <span className="rounded-full bg-gold px-2.5 py-0.5 text-[13px] font-bold text-ink">{s.waiting} {s.waiting === 1 ? "person is" : "people are"} waiting here right now</span> : null}
          </p>
        </li>,
      );
      return;
    }
    if (s.kind === "branch") inBranch = true;
    const showDay = day !== shown;
    if (showDay) shown = day;
    const hero = s.kind === "text" || s.kind === "call";
    rows.push(
      <li key={i} className="relative py-2 pl-6">
        <span className={cn("absolute top-3.5 rounded-full border-2 border-white", hero ? "-left-[9px] h-4 w-4 bg-gold" : "-left-[7px] h-3 w-3 bg-stone-400")} />
        {showDay ? <span className="absolute -left-[5.25rem] top-2 w-[4.5rem] whitespace-nowrap rounded-md bg-ink px-1 py-0.5 text-center text-[13px] font-bold text-white">Day {day}</span> : null}
        <Row s={s} ageChip={inBranch && s.kind === "text"} />
      </li>,
    );
  });
  return <ol className="relative ml-[4.75rem] border-l-2 pb-1" style={{ borderColor: LINE }}>{rows}</ol>;
}

function ChainCard({ c, open, onToggle }: { c: Chain; open: boolean; onToggle: () => void }) {
  const texts = c.steps.filter((s) => s.kind === "text").length;
  const days = c.steps.reduce((t, s) => t + (s.kind === "wait" ? s.days || 0 : 0), 0);
  const flagged = c.steps.some((s) => s.flag);
  const now = c.now || 0;
  return (
    <section className={cn(card, open && "ring-2 ring-gold")} style={{ borderColor: LINE }}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full min-h-11 items-start justify-between gap-3 p-4 text-left">
        <div className="min-w-0">
          <p className="font-heading text-[19px] font-semibold leading-tight text-ink">{c.title}</p>
          <p className="mt-1 text-[15px] text-ink">{c.plain}</p>
          <p className="mt-1.5 text-[14px] text-muted-foreground">{texts} {texts === 1 ? "text" : "texts"} · {spanText(days)}{typeof c.total === "number" ? ` · ${c.total.toLocaleString()} people so far` : ""}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span className={cn("rounded-full px-3 py-1 text-[14px] font-bold", now > 0 ? "bg-gold text-ink" : "bg-stone-100 text-muted-foreground")}>{now} in it now</span>
          {flagged ? <span className="rounded-full bg-red-50 px-2.5 py-0.5 text-[13px] font-bold text-red-700">needs a fix</span> : null}
        </div>
      </button>
      {open ? (
        <div className="border-t px-4 pb-4 pt-4" style={{ borderColor: LINE }}>
          <p className="mb-3 text-[15px] text-ink"><b>Starts when:</b> {c.startsWhen}</p>
          <Rail steps={c.steps} />
          {c.onReply?.length ? (
            <div className="mt-3 rounded-2xl border-2 border-emerald-200 bg-emerald-50/50 p-4">
              <p className="mb-2 flex items-center gap-2 font-heading text-[17px] font-semibold text-emerald-900"><CheckCircle2 className="h-5 w-5" />The moment they write back</p>
              <ul className="space-y-2.5">{c.onReply.map((s, i) => <li key={i}><Row s={s} /></li>)}</ul>
            </div>
          ) : null}
          <p className="mt-3 text-[13px] text-muted-foreground">In GHL: {c.workflows.join(" · ")}</p>
        </div>
      ) : null}
    </section>
  );
}

function BoardTab({ k }: { k: "sterling" | "at" }) {
  const b = BOARDS.find((x) => x.key === k)!;
  const now = b.chains.reduce((t, c) => t + (c.now || 0), 0);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <div className="rounded-2xl bg-ink p-5 text-white">
        <p className="font-heading text-[30px] font-semibold leading-none text-gold">{now}</p>
        <p className="mt-1.5 text-[17px] font-semibold">{b.name} customers are in the middle of a follow-up right now.</p>
        <p className="mt-2 text-[15px] text-white/80">{b.blurb}</p>
        <p className="mt-2 text-[13px] text-white/60">GHL board: {b.ghlBoard} · folder: {b.ghlFolder}</p>
      </div>
      <p className="px-1 text-[14px] text-muted-foreground">Tap a follow-up to see it day by day.</p>
      {b.chains.map((c) => <ChainCard key={c.id} c={c} open={open === c.id} onToggle={() => setOpen(open === c.id ? null : c.id)} />)}
      <section className={cn("rounded-2xl border-2 p-4", b.stopRule.exists ? "border-emerald-200 bg-emerald-50/50" : "border-red-200 bg-red-50/60")}>
        <p className="flex items-center gap-2 font-heading text-[18px] font-semibold text-ink">
          <ShieldOff className="h-5 w-5" /> When someone buys, do the texts stop?
          <span className={cn("rounded-full px-2.5 py-0.5 text-[13px] font-bold", b.stopRule.exists ? "bg-emerald-100 text-emerald-900" : "bg-red-100 text-red-800")}>{b.stopRule.exists ? "Yes" : "No"}</span>
        </p>
        <p className="mt-1.5 text-[15px] text-ink">{b.stopRule.text}</p>
      </section>
    </div>
  );
}

function Overview() {
  const sterlingNow = BOARDS[0].chains.reduce((t, c) => t + (c.now || 0), 0);
  const atNow = BOARDS[1].chains.reduce((t, c) => t + (c.now || 0), 0);
  return (
    <div className="space-y-4">
      {/* The story in five pictures. */}
      <section className="rounded-2xl bg-ink p-5 text-white">
        <p className="font-heading text-[22px] font-semibold">How we follow up, in 5 steps</p>
        <ol className="mt-4 grid gap-4 sm:grid-cols-5 sm:gap-3">
          {JOURNEY.map((j, i) => (
            <li key={j.title} className="flex gap-3 sm:flex-col sm:gap-2">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gold font-heading text-[18px] font-bold text-ink">{i + 1}</span>
              <div><p className="text-[16px] font-semibold leading-snug">{j.title}</p><p className="mt-0.5 text-[14px] leading-snug text-white/75">{j.sub}</p></div>
            </li>
          ))}
        </ol>
        <p className="mt-4 rounded-xl bg-white/10 px-3.5 py-2.5 text-[15px]"><b className="text-gold">The moment they write back,</b> the texts stop and a person takes over.</p>
      </section>

      {/* Right now. */}
      <div className="grid grid-cols-2 gap-3">
        {[["Sterling", sterlingNow, "sterling"], ["A&T's", atNow, "at"]].map(([n, v, t]) => (
          <a key={String(t)} href={`/follow-ups?tab=${t}`} className={cn(card, "block p-4 hover:bg-ivory")} style={{ borderColor: LINE }}>
            <p className="font-heading text-[32px] font-semibold leading-none text-ink">{v}</p>
            <p className="mt-1.5 text-[15px] text-ink">{n} customers in a follow-up right now</p>
          </a>
        ))}
      </div>

      {/* What's changing. */}
      <section className={cn(card, "p-4")} style={{ borderColor: LINE }}>
        <p className="font-heading text-[19px] font-semibold text-ink">What&rsquo;s changing</p>
        <p className="mt-1 text-[15px] text-ink">Today GHL sends every text. Soon the dashboard will send the texts the customer sees, and GHL keeps the phone line, the forms and the triggers. This page sends nothing. It only shows.</p>
        <ol className="mt-3 space-y-2">
          {[
            ["Sterling first", `${sterlingNow} customers are partway through today. They finish in GHL. New customers start in the dashboard.`],
            ["Then A&T's", `${atNow} partway through, most in the year of check-ins.`],
            ["Switch GHL off one piece at a time", "Only when it shows 0 people inside."],
          ].map(([t, d], i) => (
            <li key={t} className="flex gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gold text-[15px] font-bold text-ink">{i + 1}</span>
              <p className="text-[15px] text-ink"><b>{t}.</b> {d}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Alan's decisions. */}
      <section className={cn(card, "p-4")} style={{ borderColor: LINE }}>
        <p className="flex flex-wrap items-center gap-2 font-heading text-[19px] font-semibold text-ink">What we decided <span className="rounded-full bg-stone-100 px-2.5 py-0.5 text-[13px] font-bold text-muted-foreground">the plan, not built yet</span></p>
        <ol className="mt-3 space-y-2">
          {DECIDED.map((d, i) => (
            <li key={i} className="flex gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ivory text-[15px] font-bold text-bronze ring-1 ring-gold/40">{i + 1}</span>
              <p className="text-[15px] text-ink">{d}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Things to fix. */}
      <section className="space-y-2">
        <p className="flex items-center gap-2 px-1 font-heading text-[19px] font-semibold text-ink"><Wrench className="h-5 w-5 text-bronze" />Things to fix</p>
        {ISSUES.map((i) => (
          <div key={i.title} className={cn(card, "p-4")} style={{ borderColor: LINE }}>
            <p className="flex items-start gap-2 text-[16px] font-bold text-red-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{i.title}</p>
            <p className="mt-1 text-[15px] text-ink">{i.detail}</p>
            <p className="mt-1.5 text-[14px] font-bold text-bronze">{i.safe}</p>
          </div>
        ))}
      </section>

      {/* Words. */}
      <section className={cn(card, "p-4")} style={{ borderColor: LINE }}>
        <p className="font-heading text-[19px] font-semibold text-ink">Words on this page</p>
        <dl className="mt-2 grid gap-x-4 gap-y-2 sm:grid-cols-2">
          {WORDS.map((w) => <div key={w.word}><dt className="text-[15px] font-bold text-ink">{w.word}</dt><dd className="text-[14px] text-muted-foreground">{w.means}</dd></div>)}
        </dl>
      </section>
    </div>
  );
}

function HelpersTab() {
  return (
    <div className="space-y-3">
      <p className="px-1 text-[15px] text-ink">Little helpers in GHL that aren&rsquo;t follow-ups, but keep everything running.</p>
      {SHARED.map((w) => (
        <section key={w.name} className={cn(card, "p-4")} style={{ borderColor: LINE }}>
          <p className="font-heading text-[17px] font-semibold text-ink">{w.name}{typeof w.total === "number" ? <span className="ml-2 font-sans text-[13px] font-normal text-muted-foreground">used {w.total.toLocaleString()} times</span> : null}</p>
          <p className="mt-1 text-[15px] text-ink">{w.what}</p>
          {w.rule ? <p className="mt-1.5 text-[14px] font-bold text-red-700">{w.rule}</p> : null}
        </section>
      ))}
      <section className="rounded-2xl border border-dashed bg-white p-4" style={{ borderColor: LINE }}>
        <p className="font-heading text-[17px] font-semibold text-ink">Switched off</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[14px] text-muted-foreground">{NOT_RUNNING.map((n) => <li key={n}>{n}</li>)}</ul>
      </section>
    </div>
  );
}

const RISK = {
  both_texting: { word: "Texting column on both", cls: "bg-red-50 text-red-800" },
  one_texting: { word: "Texting column on one", cls: "bg-gold/15 text-bronze" },
  quiet: { word: "Quiet on both", cls: "bg-stone-100 text-muted-foreground" },
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
      <section className={cn(card, "p-4")} style={{ borderColor: LINE }}>
        <p className="font-heading text-[19px] font-semibold text-ink">One person, two cards</p>
        <p className="mt-1 text-[15px] text-ink">
          Some people have a card on <b>Sterling&rsquo;s board</b> and on <b>A&amp;T&rsquo;s</b>. Each board runs its own texts, so one person could get two sets.
          A <b>texting column</b> is a column where texts go out (New Lead, Address Follow Up, Estimate Sent, Long Term Nurture). GHL doesn&rsquo;t tell us if their texts there already finished.
        </p>
        <p className="mt-1.5 text-[14px] text-muted-foreground">Read live from GHL. Nothing here changes anything.</p>
        {d ? (
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              [d.counts.both, "on both boards", "bg-ivory text-ink"],
              [d.counts.both_texting, "texting column on both", "bg-red-50 text-red-800"],
              [d.counts.one_texting, "texting column on one", "bg-gold/15 text-bronze"],
              [d.counts.two_contacts_one_phone, "two contacts, one phone", "bg-stone-100 text-muted-foreground"],
            ].map(([v, l, c]) => (
              <div key={String(l)} className={cn("rounded-xl p-3", String(c))}>
                <p className="font-heading text-[26px] font-semibold leading-none">{v}</p>
                <p className="mt-1 text-[13px] font-bold">{l}</p>
              </div>
            ))}
          </div>
        ) : null}
        {d ? (
          <p className="mt-3 text-[14px] text-muted-foreground">
            Sterling&rsquo;s board: {d.boards.sterling.total.toLocaleString()} cards, {d.boards.sterling.texting.toLocaleString()} in a texting column · A&amp;T&rsquo;s board: {d.boards.at.total.toLocaleString()} cards, {d.boards.at.texting.toLocaleString()} in a texting column
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {d ? ([["risky", "In a texting column"], ["all", "Everyone on both"]] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setShow(k)} className={cn("min-h-11 rounded-full px-4 text-[15px] font-bold ring-1", show === k ? "bg-ink text-white ring-ink" : "bg-white text-ink ring-[#E4DCCB]")}>{l}</button>
          )) : null}
          <button type="button" onClick={() => load(true)} disabled={loading} className="ml-auto inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 text-[15px] font-bold text-ink disabled:opacity-50" style={{ borderColor: LINE }}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Check GHL again
          </button>
        </div>
      </section>
      {err ? <p className="rounded-xl bg-red-50 p-3 text-[15px] text-red-800">{err}</p> : null}
      {loading && !d ? <p className="flex items-center gap-2 px-1 text-[15px] text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Reading both boards from GHL. This takes a minute.</p> : null}
      <ul className="space-y-2">
        {rows.map((b) => (
          <li key={`${b.at.opp_id}-${b.sterling.opp_id}`} className={cn(card, "p-4")} style={{ borderColor: LINE }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[16px] font-bold text-ink">{b.name || "No name"} <span className="text-[14px] font-normal text-muted-foreground">{b.phone}</span></p>
              <span className={cn("rounded-full px-2.5 py-1 text-[13px] font-bold", RISK[b.risk].cls)}>{RISK[b.risk].word}</span>
            </div>
            <div className="mt-2 grid gap-1.5 text-[15px] sm:grid-cols-2">
              {([["Sterling", b.sterling], ["A&T's", b.at]] as const).map(([label, c]) => (
                <p key={label} className="text-ink">
                  <b>{label}:</b> {c.stage || "unknown column"}{c.status && c.status !== "open" ? ` (${c.status})` : ""}
                  {c.texting ? <span className="ml-1.5 rounded-full bg-gold/15 px-1.5 py-0.5 text-[13px] font-bold text-bronze">texts go out here</span> : null}
                </p>
              ))}
            </div>
            {!b.same_contact ? <p className="mt-1 text-[13px] text-muted-foreground">Two GHL contacts with the same phone</p> : null}
          </li>
        ))}
      </ul>
      {d && !rows.length ? <p className="rounded-2xl border border-dashed bg-white p-6 text-center text-[15px] text-muted-foreground" style={{ borderColor: LINE }}>Nobody here.</p> : null}
    </div>
  );
}

export default function FollowUpEngine() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find(([k]) => k === params.get("tab"))?.[0] || "overview") as TabKey;
  return (
    <div className="mx-auto max-w-4xl space-y-4 px-4 py-5">
      <div>
        <h1 className="font-heading text-[28px] font-semibold text-ink">Follow-Up Engine</h1>
        <p className="text-[15px] text-muted-foreground">How we keep in touch with every customer, from first hello to the last check-in.</p>
      </div>
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" onClick={() => setParams({ tab: k }, { replace: true })}
            className={cn("min-h-11 shrink-0 rounded-full px-4 text-[15px] font-bold ring-1 transition", tab === k ? "bg-ink text-white ring-ink" : "bg-white text-ink ring-[#E4DCCB] hover:bg-ivory")}>
            {label}
          </button>
        ))}
      </div>
      {tab === "overview" ? <Overview /> : null}
      {tab === "sterling" ? <BoardTab k="sterling" /> : null}
      {tab === "at" ? <BoardTab k="at" /> : null}
      {tab === "helpers" ? <HelpersTab /> : null}
      {tab === "both" ? <BothTab /> : null}
      {tab === "engine" ? (
        <div className="space-y-3">
          <div className={cn(card, "flex gap-3 p-4")} style={{ borderColor: LINE }}>
            <Users className="mt-0.5 h-5 w-5 shrink-0 text-bronze" />
            <p className="text-[15px] text-ink">This is the dashboard&rsquo;s own text sender, moved here from Settings as it was. Every sequence in it is switched off and GHL still sends everything. One day it takes over. Leave it off until the move is planned.</p>
          </div>
          <FollowUpSettingsCard />
        </div>
      ) : null}
    </div>
  );
}
