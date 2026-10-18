import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { api, type BankStatus, type BankSummary, type BankTx } from "@/lib/api";
import { cn, formatCurrency } from "@/lib/utils";

// The bank lines themselves, through Plaid, read-only (Alan, 2026-10-17).
// QuickBooks only shows what's been accepted; this is every line the bank
// has, sorted by a saved rule or by Claude. Unsure ones wait in "Needs a look".

type PlaidHandler = { open: () => void; destroy: () => void };
type PlaidMeta = { institution?: { name?: string } | null };
declare global {
  interface Window {
    Plaid?: { create: (o: { token: string; onSuccess: (publicToken: string, meta: PlaidMeta) => void; onExit?: () => void }) => PlaidHandler };
  }
}

// Plaid Link, loaded from Plaid only when the button is tapped.
function loadPlaid(): Promise<void> {
  if (window.Plaid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    const tag = existing || Object.assign(document.createElement("script"), { src, async: true });
    tag.addEventListener("load", () => (window.Plaid ? resolve() : reject(new Error("Plaid didn't load"))));
    tag.addEventListener("error", () => reject(new Error("Plaid didn't load")));
    if (!existing) document.head.appendChild(tag);
  });
}

const msg = (e: unknown, fallback: string) => {
  const m = e instanceof Error ? e.message : "";
  try { return JSON.parse(m.replace(/^\d+: /, "")).detail || fallback; } catch { return m || fallback; }
};
const when = (iso: string) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never");
const btn = "inline-flex h-11 items-center justify-center rounded-lg px-4 text-sm font-bold disabled:opacity-50";

export default function BankSection({ start, end }: { start: string; end: string }) {
  const [status, setStatus] = useState<BankStatus | null>(null);
  const [sum, setSum] = useState<BankSummary | null>(null);
  const [look, setLook] = useState<BankTx[]>([]);
  const [lines, setLines] = useState<BankTx[]>([]);
  const [cat, setCat] = useState("");
  const [dir, setDir] = useState<"out" | "in" | "all">("out");
  const [busy, setBusy] = useState("");
  const [sorting, setSorting] = useState(0);
  const polls = useRef(0);

  const load = useCallback(async () => {
    try {
      const st = await api.bankStatus();
      setStatus(st);
      if (!st.items.length) return;
      const [s, l, all] = await Promise.all([
        api.bankSummary(start, end),
        api.bankTransactions({ needsReview: true }),
        api.bankTransactions({ start, end, category: cat }),
      ]);
      setSum(s); setLook(l); setLines(all);
    } catch (e) { toast.error(msg(e, "Couldn't load the bank lines")); }
  }, [start, end, cat]);

  useEffect(() => { void load(); }, [load]);

  // While Claude sorts a fresh pull in the background, check back a few times.
  useEffect(() => {
    if (!sorting) return;
    const t = setInterval(() => {
      polls.current += 1;
      void load();
      if (polls.current >= 8) { setSorting(0); polls.current = 0; }
    }, 15000);
    return () => clearInterval(t);
  }, [sorting, load]);

  const sync = async () => {
    setBusy("sync");
    try {
      const r = await api.bankSync();
      polls.current = 0;
      setSorting(r.unsorted || 0);
      await load();
    } catch (e) { toast.error(msg(e, "Couldn't pull from the bank")); }
    finally { setBusy(""); }
  };

  const openLink = async (itemId = "") => {
    setBusy(itemId || "connect");
    try {
      const [{ link_token }] = await Promise.all([api.bankLinkToken(itemId), loadPlaid()]);
      const handler = window.Plaid!.create({
        token: link_token,
        onSuccess: (publicToken, meta) => {
          void (async () => {
            try {
              // Reconnect (update mode) keeps the same bank, so no exchange.
              if (!itemId) await api.bankExchange(publicToken, meta?.institution?.name || "");
              toast.success(itemId ? "Bank logged back in" : "Bank connected. Pulling the lines now.");
              await sync();
            } catch (e) { toast.error(msg(e, "Couldn't save the bank")); }
          })();
        },
        onExit: () => setBusy(""),
      });
      handler.open();
    } catch (e) { toast.error(msg(e, "Couldn't open the bank login")); setBusy(""); }
  };

  const disconnect = async (id: string, name: string) => {
    if (!window.confirm(`Disconnect ${name}? Its lines leave this page. Your sorting rules stay.`)) return;
    try { await api.bankRemove(id); toast.success("Disconnected"); setSum(null); await load(); }
    catch (e) { toast.error(msg(e, "Couldn't disconnect")); }
  };

  const saved = () => void load();
  const cats = status?.categories || [];
  const shown = lines.filter((t) => dir === "all" || (dir === "out" ? t.amount > 0 : t.amount < 0));

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-xl font-bold">Bank</h2>
        {status?.configured && (
          <>
            <button onClick={() => void openLink()} disabled={!!busy} className={cn(btn, "bg-primary text-primary-foreground")}>
              {busy === "connect" ? <Loader2 className="h-5 w-5 animate-spin" /> : "Connect bank"}
            </button>
            {!!status.items.length && (
              <button onClick={() => void sync()} disabled={!!busy} className={cn(btn, "bg-muted")}>
                {busy === "sync" ? <Loader2 className="h-5 w-5 animate-spin" /> : "Pull from the bank now"}
              </button>
            )}
          </>
        )}
      </div>
      <p className="text-sm text-muted-foreground">Every line straight from the bank, read-only. Nothing here can move money.</p>

      {status && !status.configured && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">The bank connection isn't set up yet. The Plaid keys go in Railway (PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV).</p>
      )}
      {status?.configured && status.env === "sandbox" && (
        <p className="rounded-lg bg-muted p-3 text-sm">Test mode: this connects to Plaid's pretend banks, not real ones.</p>
      )}

      {!!status?.items.length && (
        <Card><CardContent className="p-3">
          <p className="mb-1 text-sm font-bold">Connected banks</p>
          {status.items.map((it) => (
            <div key={it.id} className="flex flex-wrap items-center gap-2 border-t py-2 text-sm">
              <span className="mr-auto min-w-0">
                <span className="font-semibold">{it.institution_name}</span>
                <span className="text-muted-foreground"> · {it.accounts} account{it.accounts === 1 ? "" : "s"} · pulled {when(it.last_synced_at)}</span>
                {it.error && <span className="block text-red-700">{it.error}</span>}
              </span>
              {it.error && (
                <button onClick={() => void openLink(it.id)} disabled={!!busy} className={cn(btn, "bg-primary text-primary-foreground")}>Reconnect</button>
              )}
              <button onClick={() => void disconnect(it.id, it.institution_name)} className={cn(btn, "text-red-700")}>Disconnect</button>
            </div>
          ))}
        </CardContent></Card>
      )}

      {sorting > 0 && (
        <p className="flex items-center gap-2 rounded-lg bg-muted p-3 text-sm"><Loader2 className="h-4 w-4 animate-spin" />Claude is sorting {sorting} new line{sorting === 1 ? "" : "s"}. This updates on its own.</p>
      )}

      {sum && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[["Spent", formatCurrency(sum.spent)], ["Came in", formatCurrency(sum.came_in)], ["Moved between accounts", formatCurrency(sum.transfers)], ["Needs a look", String(sum.needs_review)]].map(([k, v]) => (
              <Card key={k}><CardContent className="p-3"><div className="text-xs text-muted-foreground">{k}</div><div className="text-xl font-bold tabular-nums">{v}</div></CardContent></Card>
            ))}
          </div>
          {!!sum.refunds && <p className="text-sm text-muted-foreground">Plus {formatCurrency(sum.refunds)} in refunds back from stores.</p>}

          {!!sum.accounts.length && (
            <Card><CardContent className="p-3">
              <p className="mb-2 text-sm font-bold">Balances at the bank</p>
              {sum.accounts.map((a) => (
                <div key={a.account_id} className="flex justify-between gap-2 border-t py-1.5 text-sm">
                  <span className="min-w-0">{a.name}{a.mask && ` ··${a.mask}`} <span className="text-muted-foreground">· {a.bank || a.type}</span></span>
                  <span className="shrink-0 tabular-nums font-semibold">
                    {a.current_balance == null ? "—" : formatCurrency(a.current_balance)}{a.type === "credit" && <span className="font-normal text-muted-foreground"> owed</span>}
                  </span>
                </div>
              ))}
            </CardContent></Card>
          )}

          <Card><CardContent className="p-3">
            <p className="mb-2 text-sm font-bold">Spending by category</p>
            <p className="mb-2 text-xs text-muted-foreground">Tap one to see its lines. Transfers and money in are left out.</p>
            {sum.by_category.map((c) => (
              <button key={c.name} onClick={() => { setCat(cat === c.name ? "" : c.name); setDir("all"); }}
                className={cn("flex min-h-11 w-full items-center justify-between gap-2 border-t px-1 text-left text-sm", cat === c.name && "bg-muted font-semibold")}>
                <span className="min-w-0 truncate">{c.name} <span className="text-muted-foreground">· {c.count}</span></span>
                <span className="shrink-0 tabular-nums">{formatCurrency(c.amount)}</span>
              </button>
            ))}
            {!sum.by_category.length && <p className="text-sm text-muted-foreground">No spending in these dates.</p>}
          </CardContent></Card>
        </>
      )}

      {!!look.length && (
        <Card className="border-amber-300"><CardContent className="p-3">
          <p className="text-sm font-bold">Needs a look ({look.length})</p>
          <p className="mb-2 text-xs text-muted-foreground">Claude wasn't sure about these. Pick the right one, or tap Looks right.</p>
          {look.slice(0, 60).map((t) => <TxRow key={t.transaction_id} t={t} cats={cats} open onSaved={saved} />)}
        </CardContent></Card>
      )}

      {sum && (
        <Card><CardContent className="p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <p className="mr-auto text-sm font-bold">{cat ? `${cat} (${shown.length})` : `Every bank line (${shown.length})`}</p>
            {cat && <button onClick={() => setCat("")} className={cn(btn, "bg-muted")}>Show all</button>}
            {(["out", "in", "all"] as const).map((f) => (
              <button key={f} onClick={() => setDir(f)} className={cn("h-11 rounded-full px-4 text-sm font-semibold", dir === f ? "bg-primary text-primary-foreground" : "bg-muted")}>
                {f === "out" ? "Money out" : f === "in" ? "Money in" : "All"}
              </button>
            ))}
          </div>
          {shown.map((t) => <TxRow key={t.transaction_id} t={t} cats={cats} onSaved={saved} />)}
        </CardContent></Card>
      )}
    </section>
  );
}

function TxRow({ t, cats, open = false, onSaved }: { t: BankTx; cats: string[]; open?: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(open);
  const [pick, setPick] = useState(t.category || "");
  const [remember, setRemember] = useState(false);
  const [saving, setSaving] = useState(false);
  const who = t.merchant_name || t.name;

  const save = async (category: string) => {
    if (!category) return;
    setSaving(true);
    try {
      const r = await api.bankSetCategory(t.transaction_id, category, remember);
      toast.success(r.also_moved ? `Saved, and ${r.also_moved} more from ${who} moved too` : "Saved");
      if (!open) setEditing(false);
      onSaved();
    } catch (e) { toast.error(msg(e, "Couldn't save")); }
    finally { setSaving(false); }
  };

  return (
    <div className="border-t py-2 text-sm">
      <button onClick={() => !open && setEditing(!editing)} className="grid min-h-11 w-full grid-cols-[72px_1fr_auto] items-center gap-2 text-left">
        <span className="text-muted-foreground">{t.date.slice(5)}</span>
        <span className="min-w-0">
          <span className="block truncate font-medium">{who}{t.pending && <span className="font-normal text-muted-foreground"> · pending</span>}</span>
          <span className={cn("text-xs", t.category ? "text-muted-foreground" : "text-amber-800")}>
            {t.category || "Not sorted yet"}{t.account && ` · ${t.account}`}
          </span>
        </span>
        <span className={cn("tabular-nums font-semibold", t.amount < 0 && "text-emerald-700")}>{t.amount < 0 ? "+" : "−"}{formatCurrency(Math.abs(t.amount))}</span>
      </button>
      {editing && (
        <div className="mt-1 flex flex-wrap items-center gap-2 pl-[80px] max-sm:pl-0">
          <select value={pick} onChange={(e) => setPick(e.target.value)} className="h-11 min-w-0 flex-1 rounded-lg border bg-background px-2 text-sm">
            <option value="" disabled>Pick a category</option>
            {cats.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          {open && t.category && pick === t.category ? (
            <button onClick={() => void save(pick)} disabled={saving} className={cn(btn, "bg-primary text-primary-foreground")}>Looks right</button>
          ) : (
            <button onClick={() => void save(pick)} disabled={saving || !pick} className={cn(btn, "bg-primary text-primary-foreground")}>Save</button>
          )}
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="h-5 w-5" />
            Always do this for {who.length > 28 ? who.slice(0, 28) + "…" : who}
          </label>
        </div>
      )}
    </div>
  );
}
