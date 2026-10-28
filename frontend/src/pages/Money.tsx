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
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Calculator, DollarSign, Gauge, HardHat, Landmark, Loader2, TrendingUp } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, canSeeRevenue, hasPerm, type AccountingSummary, type BankStatus, type BankSummary, type QbMonthlyRevenue } from "@/lib/api";
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
const pct = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n)}%`);

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
  const [month, setMonth] = useState<AccountingSummary | null>(null);
  const [ytd, setYtd] = useState<AccountingSummary | null>(null);
  const [qb, setQb] = useState<QbMonthlyRevenue | null>(null);
  const [loaded, setLoaded] = useState(false);
  const bank = useBankMonth();
  useEffect(() => {
    let live = true;
    const quiet = <T,>(p: Promise<T>) => p.catch(() => null);
    (async () => {
      const [m, y, q] = await Promise.all([quiet(api.getAccountingSummary("this_month")), quiet(api.getAccountingSummary("ytd")), quiet(api.getQbMonthlyRevenue())]);
      if (!live) return;
      setMonth(m); setYtd(y); setQb(q); setLoaded(true);
    })();
    return () => { live = false; };
  }, []);
  if (!loaded) return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  const chart = (qb?.months || []).map((r) => ({ name: r.label, Invoiced: Math.round(r.invoiced), Collected: Math.round(r.collected) }));

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <SectionTitle title="This month" sub={month ? `${month.start} → ${month.end} · collected money, not promises` : undefined} />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Collected" value={money(month?.revenue)} sub={month ? `${month.jobs_count} job${month.jobs_count === 1 ? "" : "s"} · ${money(month.revenue_from_deposits)} of it deposits` : undefined} />
          <Stat label="Still owed on jobs" value={money(month?.outstanding_revenue)} sub="sold this month, not collected yet" />
          <Stat label="Gross margin" value={pct(month?.gross_margin_pct)} sub={month ? `after ${money(month.labor_cost)} labor + ${money(month.materials_cost)} materials` : undefined} />
          <Stat label="Net profit" value={money(month?.net_profit)} sub={month ? `${pct(month.net_margin_pct)} after ${money(month.overhead_cost)} overhead` : undefined}
                tone={month ? (month.net_profit >= 0 ? "good" : "bad") : undefined} />
        </div>
      </section>

      <section className="space-y-2">
        <SectionTitle title="This year" sub={ytd ? `${ytd.start} → ${ytd.end}` : undefined} />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Collected" value={money(ytd?.revenue)} sub={ytd ? `${ytd.jobs_count} jobs` : undefined} />
          <Stat label="Invoiced in QuickBooks" value={money(qb?.totals.invoiced)} sub={qb ? `${qb.totals.count} invoices in ${qb.year}` : undefined} />
          <Stat label="Outstanding in QuickBooks" value={money(qb?.totals.outstanding)} sub="invoiced, not paid" tone={qb && qb.totals.outstanding > 0 ? "bad" : undefined} />
          <Stat label="Net margin" value={pct(ytd?.net_margin_pct)} sub={ytd ? `gross ${pct(ytd.gross_margin_pct)} · overhead ${money(ytd.overhead_cost)}` : undefined} />
        </div>
      </section>

      {chart.length ? (
        <section className="space-y-2">
          <SectionTitle title="Revenue by month" sub="QuickBooks invoices by invoice date" />
          <Card><CardContent className="p-3">
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`} width={44} />
                  <Tooltip formatter={(v) => formatCurrency(Number(v))} />
                  <Bar dataKey="Invoiced" fill="#E4DCCB" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Collected" fill="#C9972F" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent></Card>
        </section>
      ) : null}

      <section className="space-y-2">
        <SectionTitle title="The bank" sub="Through Plaid · every line arrives by itself" />
        <BankCards bank={bank} />
      </section>

      <p className="px-1 text-xs text-muted-foreground">
        Where these come from: collected money and margins are the jobs' payments in the dashboard (Accounting); invoiced and outstanding are QuickBooks (Revenue); the bank is Plaid.
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
