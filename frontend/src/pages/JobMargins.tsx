/**
 * Money → Job margins (Alan, 2026-11-19). One row per job: what it brought in,
 * what it cost, what it left. Every number says how sure it is. Alan's rule:
 * every box gets a number, and anything not known for sure is a best guess
 * marked "unconfirmed" — never blank, never $0. Owner-only, read-only.
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, Download, Loader2, Search } from "lucide-react";
import { api, type JobMargins as Data, type MarginJob, type MarginTag, type MarginValue } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const usd = (n: number | null | undefined, cents = false) =>
  n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: cents ? 2 : 0, minimumFractionDigits: cents ? 2 : 0 });
const pct = (n: number | null | undefined) => (n == null ? "—" : `${n.toFixed(0)}%`);

const TAG_STYLE: Record<MarginTag, string> = {
  confirmed: "",
  "worked out": "",
  unconfirmed: "text-amber-700 dark:text-amber-400 italic",
  missing: "text-rose-700 dark:text-rose-400",
};
const TAG_LABEL: Record<MarginTag, string> = {
  confirmed: "Confirmed: typed by the office or logged by the crew",
  "worked out": "Worked out from confirmed records",
  unconfirmed: "Unconfirmed: our best guess",
  missing: "Needs review: not even a guess",
};

function Val({ v, fmt = (n) => usd(n), sub }: { v: MarginValue; fmt?: (n: number) => string; sub?: string }) {
  if (v.value == null) return <span className={TAG_STYLE.missing} title={v.note || TAG_LABEL.missing}>Needs review</span>;
  return (
    <span className={TAG_STYLE[v.tag]} title={`${TAG_LABEL[v.tag]}${v.note ? ` · ${v.note}` : ""}`}>
      {fmt(v.value)}{v.tag === "unconfirmed" ? <sup className="ml-0.5 not-italic">?</sup> : null}
      {sub ? <span className="block text-xs text-muted-foreground not-italic">{sub}</span> : null}
    </span>
  );
}

const tone = (p: number | null) => (p == null ? "" : p >= 55 ? "text-emerald-700 dark:text-emerald-400" : p >= 40 ? "" : "text-rose-700 dark:text-rose-400");

function csv(jobs: MarginJob[]) {
  const head = ["Date", "Customer", "Status", "Package", "Sq ft", "Sq ft sure", "Coats", "Revenue", "Revenue sure", "Collected",
    "Labor", "Labor sure", "Hours", "Stain", "Stain sure", "Gallons", "Bleach", "Fees", "Other", "Direct cost",
    "Contribution", "Contribution %", "Overhead", "Ads", "After overhead", "After overhead %", "Sq ft / hour", "Gal / 1000 sq ft",
    "Previously stained", "Fence age", "Wood", "Stain product", "Crew", "Open questions"];
  const esc = (x: unknown) => { const s = x == null ? "" : String(x); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = jobs.map((j) => [j.date, j.customer, j.status, j.package, j.sqft.value, j.sqft.tag, j.coats, j.revenue.value, j.revenue.tag,
    j.collected, j.labor.value, j.labor.tag, j.hours, j.stain.value, j.stain.tag, j.stain_gallons, j.bleach.value, j.fees.value, j.other,
    j.direct_cost, j.contribution, j.contribution_pct, j.overhead, j.ads, j.after_overhead, j.after_overhead_pct, j.sqft_per_hour,
    j.gal_per_1000, j.previously_stained, j.fence_age, j.wood_type, j.stain_product, j.crew.join(" / "), j.questions.length]);
  const blob = new Blob([[head, ...rows].map((r) => r.map(esc).join(",")).join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `job-margins-${new Date().toLocaleDateString("en-CA")}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function JobMargins() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const [status, setStatus] = useState<"finished" | "in progress" | "all">("finished");
  const [q, setQ] = useState("");
  const [onlyGuesses, setOnlyGuesses] = useState(false);
  const [open, setOpen] = useState<string>("");
  useEffect(() => { api.jobMargins().then(setD).catch((e) => setErr(e instanceof Error ? e.message : "Couldn't load the margins")); }, []);

  const jobs = useMemo(() => (d?.jobs ?? []).filter((j) =>
    (status === "all" || j.status === status)
    && (!q || `${j.customer} ${j.package} ${j.crew.join(" ")} ${j.stain_product}`.toLowerCase().includes(q.toLowerCase()))
    && (!onlyGuesses || j.sure === "unconfirmed" || j.sure === "missing")), [d, status, q, onlyGuesses]);
  const tot = useMemo(() => {
    const c = jobs.filter((j) => j.in_totals);
    const sum = (f: (j: MarginJob) => number | null) => c.reduce((s, j) => s + (f(j) ?? 0), 0);
    const rev = sum((j) => j.revenue.value), contrib = sum((j) => j.contribution), after = sum((j) => j.after_overhead);
    return { n: c.length, rev, cost: sum((j) => j.direct_cost), contrib, after,
      cp: rev ? (contrib / rev) * 100 : null, ap: rev ? (after / rev) * 100 : null,
      labor: rev ? (sum((j) => j.labor.value) / rev) * 100 : null, stain: rev ? (sum((j) => j.stain.value) / rev) * 100 : null };
  }, [jobs]);
  const questions = useMemo(() => (d?.jobs ?? []).filter((j) => j.questions.length)
    .sort((a, b) => (b.revenue.value ?? 0) - (a.revenue.value ?? 0)), [d]);

  if (err && !d) return <Card><CardContent className="p-4 text-sm text-rose-700">{err}</CardContent></Card>;
  if (!d) return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  const oh = d.overhead;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label="Jobs counted" value={String(tot.n)} sub={`of ${jobs.length} shown · ${d.jobs.filter((j) => j.sure === "confirmed").length} fully confirmed`} />
        <Kpi label="Revenue" value={usd(tot.rev)} sub={`direct costs ${usd(tot.cost)}`} />
        <Kpi label="Before overhead" value={pct(tot.cp)} sub={`${usd(tot.contrib)} left · labor ${pct(tot.labor)} · stain ${pct(tot.stain)}`} tone={tot.cp} />
        <Kpi label="After overhead + ads" value={pct(tot.ap)} sub={`${usd(tot.after)} · unconfirmed`} tone={tot.ap} />
        <Kpi label="Overhead per job" value={usd((oh.overhead_per_job ?? 0) + (oh.ads_per_job ?? 0))}
          sub={`${usd(oh.overhead_per_job)} bills + ${usd(oh.ads_per_job)} ads · ${oh.jobs_last_30_days} jobs / 30 days`} />
      </div>

      <div className="flex flex-wrap items-center gap-2 px-1 text-xs text-muted-foreground">
        <span>Regular = confirmed or worked out</span>
        <span className={TAG_STYLE.unconfirmed}>$123<sup className="not-italic">?</sup> = unconfirmed guess</span>
        <span className={TAG_STYLE.missing}>Needs review = no number at all</span>
        <span>· Hover or tap a number to see where it came from · every job is 2 coats</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(["finished", "in progress", "all"] as const).map((s) => (
          <button key={s} onClick={() => setStatus(s)}
            className={cn("h-10 rounded-full border px-4 text-sm font-medium capitalize", status === s ? "border-foreground bg-foreground text-background" : "bg-card")}>{s}</button>
        ))}
        <label className="flex h-10 items-center gap-2 rounded-full border bg-card px-4 text-sm">
          <input type="checkbox" checked={onlyGuesses} onChange={(e) => setOnlyGuesses(e.target.checked)} /> Only jobs with guesses
        </label>
        <div className="flex h-10 flex-1 items-center gap-2 rounded-full border bg-card px-4 text-sm min-w-[180px]">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Customer, crew, package, color" className="w-full bg-transparent outline-none" />
        </div>
        <button onClick={() => csv(jobs)} className="flex h-10 items-center gap-2 rounded-full border bg-card px-4 text-sm font-medium">
          <Download className="h-4 w-4" /> CSV
        </button>
      </div>

      <Card><CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-sm tabular-nums">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="sticky left-0 z-10 bg-muted px-3 py-2">Job</th>
                <th className="px-3 py-2 text-right">Sq ft</th>
                <th className="px-3 py-2 text-right">Revenue</th>
                <th className="px-3 py-2 text-right">Labor</th>
                <th className="px-3 py-2 text-right">Stain</th>
                <th className="px-3 py-2 text-right">Bleach</th>
                <th className="px-3 py-2 text-right">Card fee</th>
                <th className="px-3 py-2 text-right">Left</th>
                <th className="px-3 py-2 text-right">%</th>
                <th className="px-3 py-2 text-right">After OH</th>
                <th className="px-3 py-2 text-right">%</th>
                <th className="px-3 py-2 text-right">Sq ft/hr</th>
                <th className="px-3 py-2 text-right">Gal/1k</th>
                <th className="px-3 py-2 text-right">Open</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <Fragment key={j.lead_id}>
                  <tr className={cn("cursor-pointer border-b hover:bg-muted/30", !j.in_totals && "opacity-70")} onClick={() => setOpen(open === j.lead_id ? "" : j.lead_id)}>
                    <td className="sticky left-0 z-10 bg-card px-3 py-2">
                      <div className="flex items-start gap-1.5">
                        {open === j.lead_id ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" />}
                        <div className="min-w-0">
                          <p className="max-w-[170px] truncate font-medium">{j.customer || "—"}</p>
                          <p className="text-xs text-muted-foreground">{j.date} · {j.package || j.service}{j.status === "in progress" ? " · in progress" : ""}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right"><Val v={j.sqft} fmt={(n) => n.toLocaleString()} /></td>
                    <td className="px-3 py-2 text-right"><Val v={j.revenue} /></td>
                    <td className="px-3 py-2 text-right"><Val v={j.labor} sub={j.hours ? `${j.hours.toFixed(1)} h` : undefined} /></td>
                    <td className="px-3 py-2 text-right"><Val v={j.stain} sub={j.stain_gallons ? `${j.stain_gallons} gal` : undefined} /></td>
                    <td className="px-3 py-2 text-right"><Val v={j.bleach} /></td>
                    <td className="px-3 py-2 text-right"><Val v={j.fees} /></td>
                    <td className="px-3 py-2 text-right font-semibold">{usd(j.contribution)}</td>
                    <td className={cn("px-3 py-2 text-right font-semibold", tone(j.contribution_pct))}>{pct(j.contribution_pct)}</td>
                    <td className={cn("px-3 py-2 text-right", TAG_STYLE.unconfirmed)}>{usd(j.after_overhead)}</td>
                    <td className={cn("px-3 py-2 text-right", TAG_STYLE.unconfirmed)}>{pct(j.after_overhead_pct)}</td>
                    <td className="px-3 py-2 text-right">{j.sqft_per_hour ?? "—"}</td>
                    <td className="px-3 py-2 text-right">{j.gal_per_1000 ?? "—"}</td>
                    <td className="px-3 py-2 text-right">{j.questions.length ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">{j.questions.length}</span> : "✓"}</td>
                  </tr>
                  {open === j.lead_id ? <tr className="border-b bg-muted/20"><td colSpan={14} className="px-3 py-3"><Detail j={j} /></td></tr> : null}
                </Fragment>
              ))}
              {!jobs.length ? <tr><td colSpan={14} className="px-3 py-8 text-center text-muted-foreground">No jobs match.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </CardContent></Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardContent className="space-y-2 p-4">
          <h3 className="font-heading text-base font-bold">Overhead, from the bank</h3>
          <p className="text-xs text-muted-foreground">The bank's last 30 days, shared over the {oh.jobs_last_30_days} jobs finished in the last 30 days. Unconfirmed: a share, not a bill the job caused.</p>
          <table className="w-full text-sm tabular-nums">
            <tbody>
              {Object.entries(oh.breakdown).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                <tr key={k} className="border-b last:border-0"><td className="py-1.5">{k}</td><td className="py-1.5 text-right">{usd(v)}/mo</td></tr>
              ))}
              <tr className="font-semibold"><td className="py-1.5">Overhead</td><td className="py-1.5 text-right">{usd(oh.monthly_overhead)}/mo</td></tr>
              <tr className="font-semibold"><td className="py-1.5">Meta ads</td><td className="py-1.5 text-right">{usd(oh.monthly_ads)}/mo</td></tr>
            </tbody>
          </table>
          <p className="text-xs text-muted-foreground">Stain with no shelf price uses {d.stain_per_gallon_set ? "your" : "a guessed"} ${d.stain_per_gallon.toFixed(2)}/gal. Bleach uses ${d.bleach_per_gallon.toFixed(2)}/gal (your estimate). Card fees are 3% until Stripe's real fees are pulled.</p>
        </CardContent></Card>

        <Card><CardContent className="space-y-2 p-4">
          <h3 className="font-heading text-base font-bold">Questions for you ({questions.reduce((s, j) => s + j.questions.length, 0)})</h3>
          <p className="text-xs text-muted-foreground">Biggest jobs first. Answer on the job page (price, footage, gallons) or Crew hours (start and finish), and the guess here turns into a confirmed number.</p>
          <div className="max-h-[420px] space-y-3 overflow-y-auto pr-1">
            {questions.map((j) => (
              <div key={j.lead_id}>
                <Link to={`/leads/${j.lead_id}`} className="text-sm font-semibold underline-offset-2 hover:underline">{j.customer || "—"}</Link>
                <span className="ml-2 text-xs text-muted-foreground">{j.date} · {usd(j.revenue.value)}</span>
                <ul className="ml-4 list-disc text-sm">
                  {j.questions.map((x, i) => <li key={i}>{x.q}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </CardContent></Card>
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, tone: t }: { label: string; value: string; sub?: string; tone?: number | null }) {
  return (
    <Card><CardContent className="p-3.5">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn("mt-1 font-heading text-2xl font-bold tabular-nums", t !== undefined && tone(t))}>{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p> : null}
    </CardContent></Card>
  );
}

function Detail({ j }: { j: MarginJob }) {
  return (
    <div className="grid gap-4 text-sm md:grid-cols-3">
      <div className="space-y-1">
        <p className="font-semibold">The job</p>
        <p>Package: {j.package || "—"} · {j.coats} coats</p>
        <p>Stain: {j.stain_product || "—"}</p>
        <p>Previously stained: {j.previously_stained || "unconfirmed"} · Wood: {j.wood_type || "unconfirmed"}</p>
        <p>Fence age: {j.fence_age || "unconfirmed"}</p>
        <p>Cleaning: {j.cleaning_days.join(", ") || "—"} · Staining: {j.staining_days.join(", ") || "—"}</p>
        <p>Sq ft: <Val v={j.sqft} fmt={(n) => n.toLocaleString()} /> <span className="text-xs text-muted-foreground">{j.sqft.note}</span></p>
        <p>Revenue: <Val v={j.revenue} /> <span className="text-xs text-muted-foreground">{j.revenue.note}</span></p>
        <p>Collected {usd(j.collected)} · still owed {usd(j.outstanding)}</p>
        <Link to={`/leads/${j.lead_id}`} className="inline-block pt-1 text-sm font-semibold underline">Open the job →</Link>
      </div>
      <div className="space-y-1">
        <p className="font-semibold">Labor</p>
        {j.labor_lines.map((l, i) => (
          <p key={i} className={TAG_STYLE[l.tag]} title={l.note}>
            {l.who} · {l.date || "no day"} · {l.task || "—"} · {l.kind === "flat" ? `flat ${usd(l.cost)}` : l.kind === "included" ? "in a flat" : `${l.hours?.toFixed(1) ?? "?"} h × ${usd(l.rate, true)} = ${usd(l.cost)}`}
            <span className="block text-xs text-muted-foreground not-italic">{l.note}</span>
          </p>
        ))}
        {!j.labor_lines.length ? <p className={TAG_STYLE.missing}>No crew lines</p> : null}
      </div>
      <div className="space-y-1">
        <p className="font-semibold">Materials and fees</p>
        {j.stain_lines.map((s, i) => (
          <p key={i} className={TAG_STYLE[s.tag]}>{s.product}: {s.gallons} gal × {usd(s.unit, true)} = {usd(s.cost)}
            <span className="block text-xs text-muted-foreground not-italic">{s.note}</span></p>
        ))}
        <p className={TAG_STYLE[j.bleach.tag]}>Bleach: {usd(j.bleach.value)} <span className="text-xs text-muted-foreground not-italic">{j.bleach.note}</span></p>
        {j.other ? <p>Crew receipts and supplies: {usd(j.other)}</p> : null}
        <p className={TAG_STYLE[j.fees.tag]}>Card fee: {usd(j.fees.value)} <span className="text-xs text-muted-foreground not-italic">{j.fees.note}</span></p>
        <p className="pt-1 font-semibold">Left before overhead: {usd(j.contribution)} ({pct(j.contribution_pct)})</p>
        <p className={TAG_STYLE.unconfirmed}>Overhead {usd(j.overhead)} + ads {usd(j.ads)} → {usd(j.after_overhead)} ({pct(j.after_overhead_pct)})</p>
      </div>
    </div>
  );
}
