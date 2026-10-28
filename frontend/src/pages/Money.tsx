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
import { api, canSeeRevenue, hasPerm, type BankStatus, type BankSummary, type MoneyOverview } from "@/lib/api";
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
