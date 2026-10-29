/**
 * Money (Alan, 2026-10-27): "accounting, revenue and where the money went —
 * that's all one thing." One tab for the business's numbers, laid out so an
 * investor could read it in six months. Sections:
 *   Overview              this month, the year and the bank on one screen,
 *                         from what the other sections already know
 *   Revenue               QuickBooks invoices matched to leads (pages/Revenue)
 *   Where the money went  QuickBooks money in and out · the bank itself
 *                         through Plaid (pages/MoneyAudit, BankSection)
 *   Accounting            per-job margin, overhead, what's owed (pages/Accounting)
 *   Payroll               time, pay and 1099 prep (pages/Crew), with what the
 *                         bank says went to the crew once it's linked
 * Each person sees the sections they're allowed. Once Plaid is live the bank
 * lines arrive by themselves, so the Overview and Payroll fill in without
 * anyone typing. The old addresses (/revenue, /money-audit, /accounting,
 * /crew) open the hub on that section; /money-audit stays the page Plaid's
 * bank login comes back to.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Calculator, DollarSign, Gauge, HardHat, Landmark, Loader2, RefreshCw, TrendingUp } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, canSeeRevenue, hasPerm, type BankStatus, type BankSummary, type MoneyOverview, type Scoreboard, type ScoreHistoryRow } from "@/lib/api";
import { HubHeader, type HubTab, type HubView } from "@/components/HubHeader";
import { Card, CardContent } from "@/components/ui/card";
import { cn, formatCurrency, timeAgo } from "@/lib/utils";
import Revenue from "@/pages/Revenue";
import MoneyAudit from "@/pages/MoneyAudit";
import Accounting from "@/pages/Accounting";
import Crew from "@/pages/Crew";

type Tab = "overview" | "revenue" | "audit" | "accounting" | "payroll";
const ALL: (HubTab<Tab> & { can: () => boolean })[] = [
  { key: "overview", label: "Overview", icon: Gauge, hint: "This month, the year and the bank, on one screen", can: canSeeRevenue },
  { key: "revenue", label: "Revenue", icon: TrendingUp, hint: "Invoices from QuickBooks, matched to leads", can: canSeeRevenue },
  { key: "audit", label: "Where the money went", icon: DollarSign, hint: "Money in and out: QuickBooks, and the bank through Plaid", can: canSeeRevenue },
  { key: "accounting", label: "Accounting", icon: Calculator, hint: "Per-job margin, overhead, what's still owed", can: () => hasPerm("accounting") },
  { key: "payroll", label: "Payroll", icon: HardHat, hint: "Roster, hours, pay and 1099 prep", can: () => hasPerm("payroll") },
];
const AUDIT_VIEWS: HubView[] = [
  { key: "quickbooks", label: "QuickBooks", hint: "Money in and out as QuickBooks has it" },
  { key: "bank", label: "Bank", hint: "The bank lines themselves, through Plaid" },
];
const NOTE: Partial<Record<Tab, string>> = {
  overview: "This month, this year and the bank · from QuickBooks, the jobs and Plaid",
  revenue: "Invoices from QuickBooks · match each one to a lead to see who's paid",
  accounting: "Per-job margin, overhead and what's still owed · owner-only",
  payroll: "Roster, hours, pay and 1099 prep · owner-only",
};

const firstOfMonth = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString("en-CA"); };
const today = () => new Date().toLocaleDateString("en-CA");
const money = (n: number | null | undefined) => (n == null ? "—" : formatCurrency(n));

/** `forced`: the old addresses open the hub on their section, and the
 *  address's ?tab= then belongs to the page inside (Payroll's own tabs). */
export default function Money({ forced }: { forced?: Tab } = {}) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const tabs = ALL.filter((t) => t.can());
  const asked = params.get("tab");
  const tab: Tab = forced && tabs.some((t) => t.key === forced) ? forced
    : tabs.some((t) => t.key === asked) ? (asked as Tab) : (tabs[0]?.key ?? "overview");
  const views = tab === "audit" ? AUDIT_VIEWS : [];
  const askedView = params.get("view");
  // Plaid's bank login comes back to /money-audit?oauth_state_id=…: open on the bank so it can finish.
  const view = views.some((v) => v.key === askedView) ? askedView!
    : tab === "audit" ? (params.has("oauth_state_id") ? "bank" : "quickbooks") : "";
  const pick = (k: Tab) => {
    if (forced) { navigate(`/money?tab=${k}`); return; }
    setParams((p) => { const n = new URLSearchParams(p); n.set("tab", k); n.delete("view"); return n; }, { replace: true });
  };
  const pickView = (v: string) => setParams((p) => { const n = new URLSearchParams(p); if (!forced) n.set("tab", tab); n.set("view", v); return n; }, { replace: true });
  if (!tabs.length) return null;

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
      <HubHeader icon={Landmark} title="Money"
        subtitle="Revenue, spending, margins and pay, in one place. The bank fills it in by itself once Plaid is linked."
        tabs={tabs} tab={tab} onTab={pick} views={views} view={view} onView={pickView} note={NOTE[tab]} />
      {tab === "overview" ? <Overview /> : null}
      {tab === "revenue" ? <Revenue embedded /> : null}
      {tab === "audit" ? <MoneyAudit embedded view={view === "bank" ? "bank" : "quickbooks"} /> : null}
      {tab === "accounting" ? <Accounting embedded /> : null}
      {tab === "payroll" ? <><BankPay /><Crew embedded /></> : null}
    </div>
  );
}

// ── The bank this month, shared by Overview and Payroll ───────────────────
type BankMonth = { status: BankStatus; summary: BankSummary | null };
function useBankMonth(): BankMonth | null | "off" {
  const [bank, setBank] = useState<BankMonth | null | "off">(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const status = await api.bankStatus().catch(() => null);
      if (!live) return;
      if (!status) { setBank("off"); return; }
      const summary = status.items.length ? await api.bankSummary(firstOfMonth(), today()).catch(() => null) : null;
      if (live) setBank({ status, summary });
    })();
    return () => { live = false; };
  }, []);
  return bank;
}
const catAmount = (s: BankSummary | null, name: string) => s?.by_category.find((c) => c.name === name)?.amount ?? 0;

// ── The three numbers ─────────────────────────────────────────────────────
/** Cost to get a customer, close rate, profit per job, over the last 30
 *  days, saved every day; and the money watch (Alan, 2026-10-29: "know three
 *  numbers every Monday… capture this every single day from now on"). */
function ThreeNumbers() {
  const [sb, setSb] = useState<Scoreboard | null>(null);
  const [failed, setFailed] = useState("");
  const [busy, setBusy] = useState(false);
  const [showJobs, setShowJobs] = useState(false);
  const [stain, setStain] = useState("");
  useEffect(() => {
    api.getScoreboard().then((r) => { setSb(r); setStain(String(r.today.stain_per_gallon)); })
      .catch((e) => setFailed(e instanceof Error ? e.message : "Couldn't load the three numbers"));
  }, []);
  const redo = async (fn: () => Promise<Scoreboard>) => {
    setBusy(true);
    try { const r = await fn(); setSb(r); setStain(String(r.today.stain_per_gallon)); setFailed(""); }
    catch (e) { setFailed(e instanceof Error ? e.message : "Couldn't work it out"); }
    finally { setBusy(false); }
  };
  if (failed && !sb) return <Card><CardContent className="p-4 text-sm text-rose-700">{failed}</CardContent></Card>;
  if (!sb) return <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  const t = sb.today;
  // The same numbers a week ago, for the arrow.
  const weekAgo: ScoreHistoryRow | undefined = sb.history.find((h) => h.day <= new Date(new Date(t.day + "T12:00:00").getTime() - 7 * 864e5).toISOString().slice(0, 10));
  const move = (now: number | null, then: number | null | undefined, betterUp: boolean, fmt: (n: number) => string) => {
    if (now == null || then == null || now === then) return null;
    const good = (now > then) === betterUp;
    return <span className={cn("font-semibold", good ? "text-emerald-700" : "text-rose-700")}>{now > then ? "▲" : "▼"} from {fmt(then)} a week ago</span>;
  };
  const pct = (n: number) => `${n}%`;
  const ms = t.money?.stripe;
  const problems = t.money?.problems || [];
  const sterlingChk = (t.money?.bank || []).find((b) => b.mask === "7061");
  return (
    <section className="space-y-2">
      <SectionTitle title="The three numbers" sub={`Last 30 days (${t.since} → ${t.until}) · saved every day · texted to you Mondays`} />
      <div className="grid gap-3 md:grid-cols-3">
        <Card><CardContent className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cost to get a customer</p>
          <p className="mt-1 text-3xl font-bold tabular-nums">{money(t.cac)}</p>
          <p className="text-sm text-muted-foreground">{money(t.ad_spend)} on ads{t.ad_spend_source === "bank" ? " (what the bank was charged)" : ""} ÷ {t.new_customers} new paying customers</p>
          <p className="text-sm">{move(t.cac, weekAgo?.cac, false, (n) => money(n))}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Close rate</p>
          <p className="mt-1 text-3xl font-bold tabular-nums">{t.close_rate == null ? "—" : `${t.close_rate}%`}</p>
          <p className="text-sm text-muted-foreground">{t.new_customers} paid ÷ {t.estimates_sent} estimates sent</p>
          <p className="text-sm">{move(t.close_rate, weekAgo?.close_rate, true, pct)}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Profit per job</p>
          <p className="mt-1 text-3xl font-bold tabular-nums">{money(t.profit_per_job)}</p>
          <p className="text-sm text-muted-foreground">{money(t.profit_per_job_after_ads)} after ads · {t.jobs_finished} jobs finished · after crew, stain, supplies and card fees</p>
          <p className="text-sm">{move(t.profit_per_job, weekAgo?.profit_per_job, true, (n) => money(n))}</p>
        </CardContent></Card>
      </div>

      {/* The money watch: $28,800 sat in Stripe for weeks in October. */}
      <Card className={cn(problems.length ? "border-rose-300 bg-rose-50" : "")}><CardContent className="space-y-1.5 p-4 text-sm">
        <p className="font-semibold">{problems.length ? "Money check: needs you" : "Money check: all good"}</p>
        {problems.map((p) => <p key={p} className="font-semibold text-rose-800">• {p}</p>)}
        {ms?.ok ? (
          <p className="text-muted-foreground">
            Stripe: {money(ms.ready ?? 0)} ready, {money(ms.on_the_way ?? 0)} on the way ·{" "}
            {ms.last_payout ? `last payout ${money(ms.last_payout.amount)} ${ms.last_payout.status.replace("_", " ")}, sent ${ms.last_payout.sent}, arrives ${ms.last_payout.arrives}` : "no payout yet"}
            {sterlingChk ? ` · Chase 7061: ${money(sterlingChk.balance)}` : ""}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">You get a text at 9 AM any day money sits in Stripe for {sb.stuck_days ?? 3}+ days, a payout fails, or Stripe asks for something.</p>
      </CardContent></Card>

      {t.gaps.length ? (
        <Card><CardContent className="space-y-1 p-4 text-sm">
          <p className="font-semibold">What's estimated, and how to make it exact</p>
          {t.gaps.map((g) => <p key={g} className="text-muted-foreground">• {g}</p>)}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="font-semibold">Stain cost per gallon</span>
            <label className="flex min-h-10 items-center gap-1 rounded-lg border bg-background px-2.5">
              <span>$</span>
              <input inputMode="decimal" value={stain} onChange={(e) => setStain(e.target.value.replace(/[^0-9.]/g, ""))}
                     className="h-9 w-16 bg-transparent tabular-nums outline-none" aria-label="Stain cost per gallon" />
            </label>
            <button type="button" disabled={busy || !(Number(stain) > 0) || Number(stain) === t.stain_per_gallon}
                    onClick={() => void redo(() => api.setStainCost(Number(stain)))}
                    className="min-h-10 rounded-lg bg-primary px-3 font-semibold text-primary-foreground disabled:opacity-50">Save</button>
            {!t.stain_per_gallon_set ? <span className="text-xs text-amber-700">a starting guess until you set it</span> : null}
          </div>
          {t.bank.stain_materials != null ? (
            <p className="text-xs text-muted-foreground">Bank check, same 30 days: crew {money(t.bank.crew)} · stain & materials {money(t.bank.stain_materials)} · ads {money(t.bank.ads)} (includes the HOA and anything not in Company Cam).</p>
          ) : null}
        </CardContent></Card>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 px-1 text-xs text-muted-foreground">
        <span>Saved {sb.saved_at ? timeAgo(sb.saved_at) : "just now"}</span>
        <button type="button" onClick={() => void redo(api.saveScoreboard)} disabled={busy}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border bg-background px-3 font-semibold text-foreground hover:bg-muted disabled:opacity-60">
          <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />{busy ? "Working it out…" : "Work it out again"}
        </button>
        <button type="button" onClick={() => setShowJobs((v) => !v)} className="min-h-9 rounded-lg border bg-background px-3 font-semibold text-foreground hover:bg-muted">
          {showJobs ? "Hide" : "Show"} the {t.jobs_finished} jobs behind profit per job
        </button>
      </div>

      {showJobs ? (
        <Card><CardContent className="overflow-x-auto p-3">
          <table className="w-full text-sm tabular-nums">
            <thead><tr className="text-left text-xs text-muted-foreground">
              <th className="py-1 pr-3 font-semibold">Finished</th><th className="py-1 pr-3 font-semibold">Customer</th>
              <th className="py-1 pr-3 text-right font-semibold">Price</th><th className="py-1 pr-3 text-right font-semibold">Crew</th>
              <th className="py-1 pr-3 text-right font-semibold">Stain</th><th className="py-1 pr-3 text-right font-semibold">Fees</th>
              <th className="py-1 text-right font-semibold">Left</th></tr></thead>
            <tbody>
              {[...t.jobs].sort((a, b) => b.finished.localeCompare(a.finished)).map((j) => (
                <tr key={j.lead_id} className="border-t">
                  <td className="py-1.5 pr-3">{j.finished}</td>
                  <td className="py-1.5 pr-3"><Link to={`/leads/${j.lead_id}`} className="hover:underline">{j.customer || "—"}</Link></td>
                  <td className={cn("py-1.5 pr-3 text-right", j.price_source !== "final price" && "text-amber-700")} title={j.price_source}>{money(j.price)}</td>
                  <td className={cn("py-1.5 pr-3 text-right", j.guessed_crew.length && "text-amber-700")} title={j.guessed_crew.join(", ")}>{money(j.crew)}</td>
                  <td className={cn("py-1.5 pr-3 text-right", j.materials_source !== "logged" && "text-amber-700")} title={j.materials_source}>{money(j.materials)}</td>
                  <td className="py-1.5 pr-3 text-right">{money(j.fees)}</td>
                  <td className={cn("py-1.5 text-right font-semibold", j.profit < 0 && "text-rose-700")}>{money(j.profit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted-foreground">Amber = estimated (hover to see why). Set the job's final price, crew pay and stain used on its Company Cam page to make it exact.</p>
        </CardContent></Card>
      ) : null}

      {sb.history.length > 1 ? (
        <Card><CardContent className="overflow-x-auto p-3">
          <p className="mb-1 text-sm font-semibold">Day by day</p>
          <table className="w-full text-sm tabular-nums">
            <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1 pr-3 font-semibold">Day</th><th className="py-1 pr-3 text-right font-semibold">Cost / customer</th><th className="py-1 pr-3 text-right font-semibold">Close rate</th><th className="py-1 text-right font-semibold">Profit / job</th></tr></thead>
            <tbody>
              {sb.history.slice(0, 14).map((h) => (
                <tr key={h.day} className="border-t"><td className="py-1.5 pr-3">{h.day}</td><td className="py-1.5 pr-3 text-right">{money(h.cac)}</td><td className="py-1.5 pr-3 text-right">{h.close_rate == null ? "—" : `${h.close_rate}%`}</td><td className="py-1.5 text-right">{money(h.profit_per_job)}</td></tr>
              ))}
            </tbody>
          </table>
        </CardContent></Card>
      ) : null}
    </section>
  );
}


// ── Overview ──────────────────────────────────────────────────────────────
function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  return (
    <Card><CardContent className="p-3.5">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn("mt-1 font-heading text-2xl font-bold tabular-nums", tone === "good" && "text-emerald-700", tone === "bad" && "text-rose-700")}>{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p> : null}
    </CardContent></Card>
  );
}

function SectionTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
      <h2 className="font-heading text-lg font-bold">{title}</h2>
      {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

function Overview() {
  const [o, setO] = useState<MoneyOverview | null>(null);
  const [failed, setFailed] = useState("");
  const [syncing, setSyncing] = useState(false);
  const bank = useBankMonth();
  const load = useCallback(() => api.moneyOverview().then((r) => { setO(r); setFailed(""); }).catch((e) => setFailed(e instanceof Error ? e.message : "Couldn't load the numbers")), []);
  useEffect(() => { void load(); }, [load]);
  // Pull QuickBooks again, then redraw (the Revenue section's sync).
  const refresh = async () => {
    setSyncing(true);
    try { await api.syncQbInvoices(); } catch { /* the numbers still reload from what we have */ }
    await load();
    setSyncing(false);
  };
  if (failed && !o) return <Card><CardContent className="p-4 text-sm text-rose-700">{failed}</CardContent></Card>;
  if (!o) return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  const m = o.month, y = o.ytd;
  const monthName = new Date(m.start + "T12:00:00").toLocaleDateString("en-US", { month: "long" });
  const chart = o.months.filter((r) => r.booked || r.collected).map((r) => ({ name: r.label, Booked: Math.round(r.booked), Collected: Math.round(r.collected) }));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
        <span>QuickBooks last pulled {o.qb_synced_at ? timeAgo(o.qb_synced_at) : "never"} · Stripe is live</span>
        <button type="button" onClick={() => void refresh()} disabled={syncing}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border bg-background px-3 font-semibold text-foreground hover:bg-muted disabled:opacity-60">
          <RefreshCw className={cn("h-3.5 w-3.5", syncing && "animate-spin")} />{syncing ? "Pulling QuickBooks…" : "Refresh"}
        </button>
      </div>

      <ThreeNumbers />

      <section className="space-y-2">
        <SectionTitle title={`${monthName} so far`} sub={`${m.start} → ${m.end}`} />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Booked" value={money(m.booked)} sub={`${m.jobs} jobs · on pace for ${money(m.pace)}`} />
          <Stat label="Collected" value={money(m.collected.total)} sub={`${money(m.collected.stripe)} Stripe · ${money(m.collected.quickbooks)} QuickBooks`} />
          <Stat label="Goal" value={money(m.goal)} sub={`${m.goal ? Math.round(m.booked / m.goal * 100) : 0}% there · last month ${money(m.last_month)}`}
                tone={m.goal && m.pace >= m.goal ? "good" : undefined} />
          <Stat label="Close rate" value={m.close_rate == null ? "—" : `${m.close_rate}%`} sub="jobs booked ÷ estimates sent this month" />
        </div>
      </section>

      <section className="space-y-2">
        <SectionTitle title={`${y.start.slice(0, 4)} so far`} sub={`${y.start} → ${y.end}`} />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Booked" value={money(y.booked)} sub={`${y.jobs} jobs`} />
          <Stat label="Collected" value={money(y.collected.total)} sub={`${y.collected.payments} Stripe payments + QuickBooks`} />
          <Stat label="Average job" value={money(y.avg_job)} sub="booked ÷ jobs" />
          <Stat label="Still owed" value={money(o.owed.total)} tone={o.owed.total > 0 ? "bad" : undefined}
                sub={`${o.owed.quickbooks_count} QuickBooks invoices ${money(o.owed.quickbooks)} · ${o.owed.stripe_count} Stripe links ${money(o.owed.stripe)}`} />
        </div>
      </section>

      {chart.length ? (
        <section className="space-y-2">
          <SectionTitle title="Month by month" sub="Booked = full job value in the month they first paid · Collected = money that came in" />
          <Card><CardContent className="p-3">
            <div className="h-60">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`} width={44} />
                  <Tooltip formatter={(v) => formatCurrency(Number(v))} />
                  <Bar dataKey="Booked" fill="#C9972F" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Collected" fill="#15130F" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-sm tabular-nums">
                <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1 pr-3 font-semibold">Month</th><th className="py-1 pr-3 text-right font-semibold">Jobs</th><th className="py-1 pr-3 text-right font-semibold">Booked</th><th className="py-1 text-right font-semibold">Collected</th></tr></thead>
                <tbody>
                  {o.months.filter((r) => r.booked || r.collected).map((r) => (
                    <tr key={r.month} className="border-t"><td className="py-1.5 pr-3">{r.label}</td><td className="py-1.5 pr-3 text-right">{r.jobs}</td><td className="py-1.5 pr-3 text-right">{money(r.booked)}</td><td className="py-1.5 text-right">{money(r.collected)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent></Card>
        </section>
      ) : null}

      <section className="space-y-2">
        <SectionTitle title="The bank" sub="Through Plaid · every line arrives by itself" />
        <BankCards bank={bank} />
      </section>

      <p className="px-1 text-xs text-muted-foreground">
        Where these come from: Booked is the sidebar's number (each customer once, full job value, the month they first paid). Collected is Stripe payments by the day they came in plus what QuickBooks marked paid, by invoice date. Still owed counts every open QuickBooks balance, so an invoice paid by Zelle or Stripe but not marked paid in QuickBooks shows here until it is.
      </p>
    </div>
  );
}

/** The bank on the Overview: not set up, not linked yet, or the month. */
function BankCards({ bank }: { bank: BankMonth | null | "off" }) {
  if (bank === null) return <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (bank === "off" || !bank.status.configured) {
    return <Card><CardContent className="p-4 text-sm text-muted-foreground">Plaid isn't set up on the server yet. Once the production keys are in, link the bank under Where the money went → Bank.</CardContent></Card>;
  }
  const { status, summary } = bank;
  if (!status.items.length) {
    return (
      <Card><CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p className="font-semibold">Bank not linked yet{status.env !== "production" ? ` · Plaid is in ${status.env}` : ""}</p>
          <p className="text-sm text-muted-foreground">Once it's linked, balances, spending by category and every payment to the crew land here on their own.</p>
        </div>
        <Link to="/money?tab=audit&view=bank" className="inline-flex min-h-10 items-center rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground">Link the bank</Link>
      </CardContent></Card>
    );
  }
  const crew = catAmount(summary, "Crew pay") + catAmount(summary, "Payroll & contractors");
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <Card><CardContent className="p-3.5">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Balances</p>
        {(summary?.accounts || []).map((a) => (
          <div key={a.account_id} className="flex justify-between gap-2 border-t py-1.5 text-sm first:border-t-0">
            <span className="min-w-0 truncate">{a.bank} {a.name}{a.mask ? ` ···${a.mask}` : ""}</span>
            <span className="shrink-0 font-semibold tabular-nums">{money(a.current_balance)}</span>
          </div>
        ))}
        <p className="mt-1 text-xs text-muted-foreground">{status.last_synced_at ? `Updated ${timeAgo(status.last_synced_at)}` : "Not pulled yet"}</p>
      </CardContent></Card>
      <Card><CardContent className="p-3.5">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Spent this month</p>
        <p className="mt-1 font-heading text-2xl font-bold tabular-nums">{money(summary?.spent)}</p>
        {(summary?.by_category || []).slice(0, 5).map((c) => (
          <div key={c.name} className="flex justify-between gap-2 border-t py-1 text-sm"><span className="min-w-0 truncate">{c.name}</span><span className="shrink-0 tabular-nums">{money(c.amount)}</span></div>
        ))}
      </CardContent></Card>
      <Card><CardContent className="p-3.5">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Paid to the crew</p>
        <p className="mt-1 font-heading text-2xl font-bold tabular-nums">{money(crew)}</p>
        <p className="text-xs text-muted-foreground">Crew pay + contractors, as it left the account</p>
        <p className="mt-2 text-sm">Came in: <b className="tabular-nums">{money(summary?.came_in)}</b></p>
        {summary?.needs_review ? <Link to="/money?tab=audit&view=bank" className="mt-1 block text-sm font-semibold text-amber-700 underline underline-offset-2">{summary.needs_review} lines to check</Link> : null}
      </CardContent></Card>
    </div>
  );
}

// ── Payroll: what the bank says went to the crew ──────────────────────────
function BankPay() {
  const bank = useBankMonth();
  if (bank === null) return null;
  const linked = bank !== "off" && bank.status.configured && bank.status.items.length > 0;
  if (!linked) {
    return (
      <Card><CardContent className="flex flex-wrap items-center justify-between gap-3 p-3.5 text-sm">
        <span className="text-muted-foreground">Link the bank and every payment to the crew shows here as it leaves the account, next to what the dashboard says they're owed.</span>
        <Link to="/money?tab=audit&view=bank" className="font-semibold text-primary underline underline-offset-2">Where the money went → Bank</Link>
      </CardContent></Card>
    );
  }
  const s = bank.summary;
  return (
    <Card><CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 p-3.5 text-sm">
      <span className="font-semibold">From the bank this month:</span>
      <span>Crew pay <b className="tabular-nums">{money(catAmount(s, "Crew pay"))}</b></span>
      <span>Payroll &amp; contractors <b className="tabular-nums">{money(catAmount(s, "Payroll & contractors"))}</b></span>
      <Link to="/money?tab=audit&view=bank" className="ml-auto font-semibold text-primary underline underline-offset-2">See the lines</Link>
    </CardContent></Card>
  );
}
