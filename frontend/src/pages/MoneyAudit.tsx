import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import BankSection from "@/components/BankSection";
import { api, type MoneyAudit as Audit } from "@/lib/api";
import { cn, formatCurrency } from "@/lib/utils";

// Where the money went (Alan, 2026-10-17): this month's money in and out of
// QuickBooks, read-only. Owner-only. Below it, the bank lines themselves
// through Plaid (components/BankSection.tsx), for the same dates.

const firstOfMonth = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString("en-CA"); };
const today = () => new Date().toLocaleDateString("en-CA");

export default function MoneyAudit() {
  const [start, setStart] = useState(firstOfMonth());
  const [end, setEnd] = useState(today());
  const [data, setData] = useState<Audit | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<"all" | "out" | "in">("out");

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try { setData(await api.moneyAudit(start, end)); }
    catch (e) { setErr(e instanceof Error ? e.message : "Couldn't reach QuickBooks"); }
    finally { setLoading(false); }
  }, [start, end]);
   
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => (data?.rows || []).filter((r) => filter === "all" || r.direction === filter)
    .slice().sort((a, b) => b.amount - a.amount), [data, filter]);
  const s = data?.summary;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <h1 className="text-2xl font-bold">Where the money went</h1>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-muted-foreground">From<Input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="h-10" /></label>
        <label className="text-xs text-muted-foreground">To<Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="h-10" /></label>
        <button onClick={() => void load()} className="h-10 rounded-lg bg-primary px-4 text-sm font-bold text-primary-foreground">Pull from QuickBooks</button>
        {loading && <Loader2 className="h-5 w-5 animate-spin" />}
      </div>
      {err && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{err}</p>}
      {data && s && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[["Spent", formatCurrency(s.spent)], ["Came in", formatCurrency(s.came_in)], ["Moved between accounts", formatCurrency(s.transfers)], ["Spent, not categorized", formatCurrency(s.uncategorized)]].map(([k, v]) => (
              <Card key={k}><CardContent className="p-3"><div className="text-xs text-muted-foreground">{k}</div><div className="text-xl font-bold tabular-nums">{v}</div></CardContent></Card>
            ))}
          </div>
          <Card><CardContent className="p-3">
            <p className="mb-2 text-sm font-bold">Bank and card balances in QuickBooks today</p>
            {data.accounts.map((a) => (
              <div key={a.name} className="flex justify-between border-t py-1.5 text-sm"><span>{a.name} <span className="text-muted-foreground">· {a.type}</span></span><span className="tabular-nums font-semibold">{formatCurrency(a.balance)}</span></div>
            ))}
          </CardContent></Card>
          <div className="grid gap-3 md:grid-cols-2">
            {([["Spending by category", s.by_category], ["Spending by who got paid", s.by_payee]] as const).map(([title, list]) => (
              <Card key={title}><CardContent className="p-3">
                <p className="mb-2 text-sm font-bold">{title}</p>
                {list.slice(0, 25).map((x) => (
                  <div key={x.name} className="flex justify-between gap-2 border-t py-1.5 text-sm"><span className="min-w-0 truncate">{x.name}</span><span className="shrink-0 tabular-nums">{formatCurrency(x.amount)}</span></div>
                ))}
              </CardContent></Card>
            ))}
          </div>
          <Card><CardContent className="p-3">
            <div className="mb-2 flex items-center gap-2">
              <p className="text-sm font-bold">Every transaction ({data.rows.length})</p>
              {(["out", "in", "all"] as const).map((f) => (
                <button key={f} onClick={() => setFilter(f)} className={cn("rounded-full px-3 py-1 text-xs font-semibold", filter === f ? "bg-primary text-primary-foreground" : "bg-muted")}>{f === "out" ? "Money out" : f === "in" ? "Money in" : "All"}</button>
              ))}
            </div>
            {rows.map((r, i) => (
              <div key={i} className="grid grid-cols-[80px_1fr_auto] gap-2 border-t py-1.5 text-sm">
                <span className="text-muted-foreground">{r.date}</span>
                <span className="min-w-0"><span className="font-medium">{r.payee || r.type}</span> <span className="text-muted-foreground">· {r.category} · {r.account}</span></span>
                <span className={cn("tabular-nums font-semibold", r.direction === "in" && "text-emerald-700")}>{r.direction === "out" ? "−" : r.direction === "in" ? "+" : ""}{formatCurrency(r.amount)}</span>
              </div>
            ))}
          </CardContent></Card>
        </>
      )}
      <div className="border-t pt-4"><BankSection start={start} end={end} /></div>
    </div>
  );
}
