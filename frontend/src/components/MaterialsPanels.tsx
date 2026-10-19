// Materials money (Alan, 2026-10-19): log a receipt (photo required), the
// 2-week shelf count, $ per gallon by store, and what each finished job made.
// The receipt form also lives on Company Cam so the crew can log what they
// buy on the way to a job (Spanish via tr()).
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Camera, Check, Loader2, Receipt, Trash2, X } from "lucide-react";
import {
  api, getCurrentUser, MATERIAL_STORES,
  type JobCosting, type MaterialPrice, type MaterialPurchase, type StainInventoryItem,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { errMessage } from "@/lib/utils";
import { tr } from "@/lib/i18n";

export type ShelfOption = { id: string; label: string };

const money = (n: number) => `$${(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (n: number) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

/** Today in Houston, YYYY-MM-DD. */
function todayCT(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function thisMonth(): string {
  return todayCT().slice(0, 7);
}

const chip = (on: boolean) =>
  `min-h-11 rounded-full border px-3.5 text-sm font-semibold transition-colors ${
    on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background hover:bg-muted"}`;

/** Log one receipt. A photo of the receipt is required (Alan's rule). */
export function LogReceiptForm({ stains, leadId, onSaved, onCancel }: {
  stains: ShelfOption[];
  leadId?: string;
  onSaved: (p: MaterialPurchase) => void;
  onCancel: () => void;
}) {
  const [category, setCategory] = useState<"stain" | "bleach" | "supplies">("stain");
  const [stainId, setStainId] = useState("");
  const [store, setStore] = useState("lowes");
  const [gallons, setGallons] = useState("");
  const [total, setTotal] = useState("");
  const [day, setDay] = useState(todayCT());
  const [what, setWhat] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const needsGallons = category !== "supplies";
  const g = Number(gallons), t = Number(total);
  const ok = !!file && t > 0 && (!needsGallons || g > 0) && (category !== "stain" || !!stainId) && !busy;
  const perGal = needsGallons && g > 0 && t > 0 ? t / g : 0;

  const pick = (f: File | null) => {
    if (preview) URL.revokeObjectURL(preview);
    setFile(f);
    setPreview(f && f.type.startsWith("image/") ? URL.createObjectURL(f) : "");
  };

  const save = async () => {
    if (!ok || !file) return;
    setBusy(true);
    const form = new FormData();
    form.append("category", category);
    form.append("store", store);
    form.append("total_cost", String(t));
    form.append("purchased_on", day);
    form.append("gallons", needsGallons ? String(g) : "0");
    if (category === "stain") form.append("stain_id", stainId);
    form.append("description", what);
    if (leadId) form.append("lead_id", leadId);
    form.append("receipt", file);
    try {
      const r = await api.logMaterialPurchase(form);
      toast.success(category === "supplies" ? tr("Receipt saved") : `${tr("Receipt saved")} · ${num(g)} gal ${tr("added to the shelf")}`);
      onSaved(r);
    } catch (e) {
      toast.error(errMessage(e, tr("Couldn't save the receipt")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap gap-2">
        {([["stain", tr("Stain")], ["bleach", tr("Bleach")], ["supplies", tr("Shop supplies")]] as const).map(([v, l]) => (
          <button key={v} type="button" className={chip(category === v)} onClick={() => setCategory(v)}>{l}</button>
        ))}
      </div>

      {category === "stain" ? (
        <select value={stainId} onChange={(e) => setStainId(e.target.value)}
                className="h-11 w-full rounded-lg border border-input bg-background px-2 text-base">
          <option value="">{tr("Which stain?")}</option>
          {stains.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      ) : null}

      <div>
        <p className="mb-1 text-xs font-semibold text-muted-foreground">{tr("Store")}</p>
        <div className="flex flex-wrap gap-2">
          {MATERIAL_STORES.map((s) => (
            <button key={s.value} type="button" className={chip(store === s.value)} onClick={() => setStore(s.value)}>{s.label}</button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {needsGallons ? (
          <label className="text-xs font-semibold text-muted-foreground">
            {tr("Gallons")}
            <Input type="number" inputMode="decimal" min="0" step="0.5" value={gallons} onChange={(e) => setGallons(e.target.value)}
                   className="mt-1 h-11 text-base tabular-nums" placeholder="5" />
          </label>
        ) : (
          <label className="text-xs font-semibold text-muted-foreground">
            {tr("What was it?")}
            <Input value={what} onChange={(e) => setWhat(e.target.value)} className="mt-1 h-11 text-base" placeholder={tr("Spray tips, tape…")} />
          </label>
        )}
        <label className="text-xs font-semibold text-muted-foreground">
          {tr("Total paid (with tax)")}
          <Input type="number" inputMode="decimal" min="0" step="0.01" value={total} onChange={(e) => setTotal(e.target.value)}
                 className="mt-1 h-11 text-base tabular-nums" placeholder="133.00" />
        </label>
      </div>
      {perGal ? <p className="text-sm font-semibold text-emerald-800">{money(perGal)} {tr("a gallon")}</p> : null}

      <label className="block text-xs font-semibold text-muted-foreground">
        {tr("Day bought")}
        <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="mt-1 h-11 text-base" />
      </label>

      <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden"
             onChange={(e) => pick(e.target.files?.[0] || null)} />
      {file ? (
        <div className="flex items-center gap-3 rounded-lg border border-emerald-300 bg-emerald-50 p-2">
          {preview ? <img src={preview} alt="" className="h-16 w-12 rounded object-cover" /> : <Receipt className="h-8 w-8 text-emerald-700" />}
          <span className="flex-1 truncate text-sm font-semibold text-emerald-900">{tr("Receipt added")}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => pick(null)}><X className="h-4 w-4" /></Button>
        </div>
      ) : (
        <Button type="button" variant="outline" className="h-12 w-full text-base" onClick={() => fileRef.current?.click()}>
          <Camera className="mr-2 h-5 w-5" /> {tr("Take a picture of the receipt")}
        </Button>
      )}

      <div className="flex gap-2">
        <Button type="button" className="h-12 flex-1 text-base" disabled={!ok} onClick={save}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />} {tr("Save receipt")}
        </Button>
        <Button type="button" variant="ghost" className="h-12" onClick={onCancel}>{tr("Cancel")}</Button>
      </div>
      {!file ? <p className="text-xs text-muted-foreground">{tr("A picture of the receipt is required.")}</p> : null}
    </div>
  );
}

/** Shelf items for the receipt form: stains (not bleach), labelled. */
function shelfOptions(items: StainInventoryItem[]): ShelfOption[] {
  return items.filter((i) => i.finish_type !== "bleach" && i.active)
    .map((i) => ({ id: i.id, label: `${i.color_name} · ${i.brand}` }));
}

function ReceiptButton({ id }: { id: string }) {
  const open = async () => {
    const w = window.open("", "_blank");
    const url = await api.fetchReceiptUrl(id);
    if (!url) { w?.close(); toast.error("Couldn't open the receipt"); return; }
    if (w) w.location.href = url; else window.location.href = url;
  };
  return (
    <button type="button" onClick={open} className="inline-flex items-center gap-1 text-xs font-semibold text-primary underline-offset-2 hover:underline">
      <Receipt className="h-3.5 w-3.5" /> Receipt
    </button>
  );
}

/** Receipts for a month, plus $ per gallon by store. */
export function ReceiptsPanel({ items, onChanged }: { items: StainInventoryItem[]; onChanged: () => void }) {
  const [month, setMonth] = useState(thisMonth());
  const [rows, setRows] = useState<MaterialPurchase[] | null>(null);
  const [total, setTotal] = useState(0);
  const [adding, setAdding] = useState(false);
  const [prices, setPrices] = useState<MaterialPrice[]>([]);
  const [tick, setTick] = useState(0);
  const isAdmin = getCurrentUser()?.role === "admin";

  useEffect(() => {
    let live = true;
    api.listMaterialPurchases(month)
      .then((r) => { if (live) { setRows(r.purchases); setTotal(r.total); } })
      .catch(() => { if (live) setRows([]); });
    api.getMaterialPrices().then((r) => { if (live) setPrices(r.prices); }).catch(() => {});
    return () => { live = false; };
  }, [month, tick]);

  const byCategory = useMemo(() => {
    const t = { stain: 0, bleach: 0, supplies: 0 };
    for (const r of rows || []) t[r.category] += r.total_cost;
    return t;
  }, [rows]);

  const remove = async (p: MaterialPurchase) => {
    if (!confirm(`Delete this ${money(p.total_cost)} receipt? Its gallons come back off the shelf.`)) return;
    try { await api.deleteMaterialPurchase(p.id); setTick((x) => x + 1); onChanged(); }
    catch (e) { toast.error(errMessage(e, "Couldn't delete it")); }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm">Receipts</CardTitle>
            <div className="flex items-center gap-2">
              <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="h-9 w-40" />
              {!adding ? <Button size="sm" onClick={() => setAdding(true)}><Camera className="mr-1 h-3.5 w-3.5" /> Log a receipt</Button> : null}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Every stain, bleach and shop-supplies purchase on the company card, with the receipt. Stain and bleach go onto the shelf.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {adding ? (
            <LogReceiptForm stains={shelfOptions(items)} onCancel={() => setAdding(false)}
                            onSaved={() => { setAdding(false); setTick((x) => x + 1); onChanged(); }} />
          ) : null}
          <div className="grid grid-cols-3 gap-2 text-center">
            {([["Stain", byCategory.stain], ["Bleach", byCategory.bleach], ["Supplies", byCategory.supplies]] as const).map(([l, v]) => (
              <div key={l} className="rounded-lg bg-muted/50 p-2">
                <p className="text-[11px] font-semibold uppercase text-muted-foreground">{l}</p>
                <p className="text-sm font-bold tabular-nums">{money(v)}</p>
              </div>
            ))}
          </div>
          {rows === null ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
          {rows && !rows.length ? <p className="text-sm text-muted-foreground">No receipts this month.</p> : null}
          <ul className="divide-y">
            {(rows || []).map((p) => (
              <li key={p.id} className="flex items-start gap-3 py-2">
                <span className="w-14 shrink-0 text-xs text-muted-foreground tabular-nums">{p.purchased_on.slice(5)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">
                    {p.category === "supplies" ? (p.description || "Shop supplies") : p.item_label || p.category}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {p.store_label}
                    {p.gallons ? ` · ${num(p.gallons)} gal · ${money(p.cost_per_gallon)}/gal` : ""}
                    {p.customer ? ` · for ${p.customer}` : ""} · {p.created_by}
                  </span>
                  {p.has_receipt ? <ReceiptButton id={p.id} /> : null}
                </span>
                <span className="shrink-0 text-sm font-bold tabular-nums">{money(p.total_cost)}</span>
                {isAdmin ? (
                  <button type="button" onClick={() => remove(p)} className="shrink-0 p-1 text-muted-foreground hover:text-destructive" title="Delete">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {rows && rows.length ? (
            <div className="flex items-baseline justify-between border-t-2 pt-2">
              <span className="text-sm font-semibold">Month total</span>
              <span className="text-lg font-bold tabular-nums">{money(total)}</span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Price per gallon by store</CardTitle>
          <p className="text-xs text-muted-foreground">From every receipt so far. Cheapest store first for each item.</p>
        </CardHeader>
        <CardContent>
          {!prices.length ? <p className="text-sm text-muted-foreground">Shows up after the first receipts.</p> : null}
          <ul className="divide-y">
            {prices.map((p) => (
              <li key={`${p.stain_id}-${p.store}`} className="flex items-center gap-3 py-1.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{p.item_label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {p.store_label} · {p.receipts} {p.receipts === 1 ? "receipt" : "receipts"} · last {money(p.last_per_gallon)} on {p.last_date}
                  </span>
                </span>
                <span className="shrink-0 text-sm font-bold tabular-nums">{money(p.avg_per_gallon)}/gal</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

/** The 2-week shelf count: type what's really there, every item at once. */
export function ShelfCountPanel({ items, onChanged }: { items: StainInventoryItem[]; onChanged: () => void }) {
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ differences: { id: string; label: string; difference: number; value: number }[]; difference_value: number } | null>(null);
  const active = items.filter((i) => i.active);
  const filled = active.filter((i) => (counts[i.id] ?? "").trim() !== "");

  const save = async () => {
    const lines = filled.map((i) => ({ id: i.id, gallons: Number(counts[i.id]) }));
    if (lines.some((l) => !Number.isFinite(l.gallons) || l.gallons < 0)) { toast.error("Check the numbers"); return; }
    setBusy(true);
    try {
      const r = await api.shelfCount(lines);
      setResult(r); setCounts({}); onChanged();
      toast.success(`Counted ${r.counted} items`);
    } catch (e) {
      toast.error(errMessage(e, "Couldn't save the count"));
    } finally { setBusy(false); }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Shelf count</CardTitle>
        <p className="text-xs text-muted-foreground">
          Every 2 weeks: walk the storage unit and type what's really there. Leave an item blank to skip it.
          Anything that doesn't match the books shows up below in gallons and dollars.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {result ? (
          <div className={`rounded-lg p-3 text-sm ${result.difference_value < 0 ? "bg-rose-50 text-rose-900" : "bg-emerald-50 text-emerald-900"}`}>
            <p className="font-semibold">
              {result.differences.length ? `${money(Math.abs(result.difference_value))} ${result.difference_value < 0 ? "missing" : "more than the books"}` : "Everything matched the books."}
            </p>
            {result.differences.map((d) => (
              <p key={d.id} className="text-xs tabular-nums">{d.label}: {d.difference > 0 ? "+" : ""}{num(d.difference)} gal ({money(d.value)})</p>
            ))}
          </div>
        ) : null}
        <ul className="divide-y">
          {active.map((i) => (
            <li key={i.id} className="flex items-center gap-2 py-1.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{i.color_name}</span>
                <span className="block text-xs text-muted-foreground">{i.brand} · books say {num(i.gallons)} gal</span>
              </span>
              <Input type="number" inputMode="decimal" min="0" step="0.5" placeholder={num(i.gallons)}
                     value={counts[i.id] ?? ""} onChange={(e) => setCounts({ ...counts, [i.id]: e.target.value })}
                     className="h-10 w-24 text-right text-base tabular-nums" />
              <span className="w-7 text-xs text-muted-foreground">gal</span>
            </li>
          ))}
        </ul>
        <Button className="h-11 w-full" disabled={!filled.length || busy} onClick={save}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
          Save count{filled.length ? ` (${filled.length})` : ""}
        </Button>
      </CardContent>
    </Card>
  );
}

/** What each finished job made, PE-style: price minus every job cost. */
export function JobCostsPanel() {
  const [month, setMonth] = useState(thisMonth());
  const [data, setData] = useState<JobCosting | null>(null);
  useEffect(() => {
    let live = true;
    api.getJobCosting(month).then((r) => { if (live) setData(r); }).catch(() => { if (live) setData(null); });
    return () => { live = false; };
  }, [month]);
  const t = data?.totals;
  const pct = (part: number) => (t && t.price ? `${Math.round((part / t.price) * 100)}%` : "–");

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm">Job costs</CardTitle>
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="h-9 w-40" />
        </div>
        <p className="text-xs text-muted-foreground">
          Jobs marked "Job done" on Company Cam that month. Price minus flat crew pay, stain and bleach used (at what they cost us),
          a share of the month's shop supplies, and about {Math.round((data?.card_fee_rate || 0.03) * 100)}% card fees.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {!data ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {data && !data.jobs.length ? <p className="text-sm text-muted-foreground">No finished jobs this month yet.</p> : null}
        {t && data && data.jobs.length ? (
          <div className="rounded-xl bg-slate-900 p-3 text-white">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-semibold">Gross profit · {data.jobs.length} jobs</span>
              <span className="text-xl font-bold tabular-nums">{money(t.gross_profit)} <span className="text-sm font-semibold text-white/70">{t.margin_pct}%</span></span>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-center text-xs sm:grid-cols-6">
              {([["Revenue", t.price, ""], ["Crew", t.crew_pay, pct(t.crew_pay)], ["Stain", t.stain_cost, pct(t.stain_cost)],
                 ["Bleach", t.bleach_cost, pct(t.bleach_cost)], ["Supplies", t.supplies, pct(t.supplies)], ["Card fees", t.fees, pct(t.fees)]] as const)
                .map(([l, v, p]) => (
                  <div key={l} className="rounded-lg bg-white/10 p-1.5">
                    <p className="text-white/60">{l}</p>
                    <p className="font-bold tabular-nums">{money(v)}</p>
                    {p ? <p className="text-white/60">{p}</p> : null}
                  </div>
                ))}
            </div>
          </div>
        ) : null}
        <ul className="space-y-2">
          {(data?.jobs || []).map((j) => (
            <li key={j.lead_id} className="rounded-lg border border-border p-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <a href={`/leads/${j.lead_id}`} className="truncate text-sm font-semibold capitalize underline-offset-2 hover:underline">
                  {(j.customer || "Customer").toLowerCase()}
                </a>
                <span className={`shrink-0 text-sm font-bold tabular-nums ${j.margin_pct < 30 ? "text-rose-700" : "text-emerald-700"}`}>
                  {money(j.gross_profit)} · {j.margin_pct}%
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                {j.completed_on} · {j.package || "—"} · {money(j.price)} · crew {money(j.crew_pay)} · stain {money(j.stain_cost)}
                {j.stain_gallons ? ` (${num(j.stain_gallons)} gal)` : ""} · bleach {money(j.bleach_cost)} · supplies {money(j.supplies)} · fees {money(j.fees)}
              </p>
              {j.hourly_crew.length ? (
                <p className="mt-0.5 text-xs font-semibold text-amber-700">Hourly, not counted: {j.hourly_crew.join(", ")}</p>
              ) : null}
              {!j.price ? <p className="mt-0.5 text-xs font-semibold text-amber-700">No price on the job: set it on Company Cam.</p> : null}
              {j.estimated ? <p className="mt-0.5 text-xs text-muted-foreground">Finished before costing: stain and bleach priced at today's average.</p> : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
