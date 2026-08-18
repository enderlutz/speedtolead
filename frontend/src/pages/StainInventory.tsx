import { useEffect, useState, useCallback, useMemo } from "react";
import {
  api,
  STAIN_FINISH_TYPES,
  stainFinishLabel,
  type StainInventoryItem,
  type StainInventoryBody,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { PaintBucket, Plus, Pencil, Trash2, Check, X, Search } from "lucide-react";

// Stain Inventory — what stain we have on hand, by brand / finish / colour.
//
// Quantity is entered the way it sits in the shop (N containers × G gallons
// each) and displayed as a gallon total, so it lines up with the gallon
// figures jobs already record (gallons_estimate, stain_gallons_used).
//
// Standalone for now: the colour dropdowns in ScheduleJobModal and PmHq still
// use their own hardcoded lists. Pointing them at this table is the intended
// follow-up once real stock has been entered.

const EMPTY_BODY: StainInventoryBody = {
  brand: "",
  finish_type: "transparent",
  color_name: "",
  container_count: 0,
  gallons_per_container: 0,
  notes: "",
  active: true,
};

function gal(n: number): string {
  return `${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} gal`;
}

export default function StainInventory() {
  const [items, setItems] = useState<StainInventoryItem[]>([]);
  const [totalGallons, setTotalGallons] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [finishFilter, setFinishFilter] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listStainInventory({ q: search.trim() || undefined, finish_type: finishFilter || undefined })
      .then((r) => { setItems(r.items); setTotalGallons(r.total_gallons); })
      .catch(() => { setItems([]); setTotalGallons(0); toast.error("Couldn't load the stain inventory"); })
      .finally(() => setLoading(false));
  }, [search, finishFilter]);

  // Debounced so typing in the search box doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const activeCount = useMemo(() => items.filter((i) => i.active).length, [items]);

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-6xl">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight flex items-center gap-2">
          <PaintBucket className="h-5 w-5 text-primary" /> Stain Inventory
        </h1>
        <p className="text-sm text-muted-foreground">
          Every stain we carry — brand, finish, colour, and how much is on hand.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-sm flex items-center gap-2">
              <PaintBucket className="h-4 w-4 text-primary" /> On hand
              <span className="text-xs font-normal text-muted-foreground">
                · {gal(totalGallons)} across {activeCount} stain{activeCount === 1 ? "" : "s"}
              </span>
            </CardTitle>
            <Button size="sm" variant={showAdd ? "outline" : "default"} onClick={() => setShowAdd(!showAdd)}>
              <Plus className="h-3.5 w-3.5 mr-1" /> {showAdd ? "Cancel" : "Add"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {showAdd && (
            <StainForm onSaved={() => { setShowAdd(false); load(); }} onCancel={() => setShowAdd(false)} />
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search brand or colour…"
                className="pl-8 h-8 text-sm"
              />
            </div>
            <select
              value={finishFilter}
              onChange={(e) => setFinishFilter(e.target.value)}
              className="h-8 rounded-md border bg-background px-2 text-sm"
            >
              <option value="">All finishes</option>
              {STAIN_FINISH_TYPES.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </div>

          {loading && items.length === 0 ? (
            <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-10 bg-muted rounded animate-pulse" />)}</div>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              {search || finishFilter
                ? "No stains match that search."
                : "No stains yet. Click Add to record the first one — brand, finish, colour, and how much you have."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b">
                    <th className="px-2 py-1.5 font-medium">Brand</th>
                    <th className="px-2 py-1.5 font-medium">Finish</th>
                    <th className="px-2 py-1.5 font-medium">Colour</th>
                    <th className="px-2 py-1.5 font-medium text-right">Containers</th>
                    <th className="px-2 py-1.5 font-medium text-right">Gal each</th>
                    <th className="px-2 py-1.5 font-medium text-right">Total</th>
                    <th className="px-2 py-1.5 font-medium">Status</th>
                    <th className="px-2 py-1.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    editing === it.id ? (
                      <StainEditRow
                        key={it.id}
                        item={it}
                        onSaved={() => { setEditing(null); load(); }}
                        onCancel={() => setEditing(null)}
                      />
                    ) : (
                      <tr key={it.id} className={`border-b ${it.active ? "" : "opacity-50"}`}>
                        <td className="px-2 py-2 font-medium">{it.brand || "—"}</td>
                        <td className="px-2 py-2 text-xs text-muted-foreground">{stainFinishLabel(it.finish_type)}</td>
                        <td className="px-2 py-2">{it.color_name || "—"}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{it.container_count || 0}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{it.gallons_per_container || 0}</td>
                        <td className="px-2 py-2 text-right font-semibold tabular-nums">{gal(it.total_gallons)}</td>
                        <td className="px-2 py-2">
                          {it.active ? (
                            <Badge className="bg-emerald-100 text-emerald-800 text-[10px]">In stock</Badge>
                          ) : (
                            <Badge className="bg-muted text-muted-foreground text-[10px]">Discontinued</Badge>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right whitespace-nowrap">
                          <button onClick={() => setEditing(it.id)} className="text-muted-foreground hover:text-primary p-1" title="Edit">
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={async () => {
                              const label = [it.brand, it.color_name].filter(Boolean).join(" ") || "this stain";
                              if (!confirm(`Delete "${label}"? This removes it from the inventory.`)) return;
                              try { await api.deleteStainInventoryItem(it.id); toast.success("Deleted"); load(); }
                              catch (err) { toast.error(err instanceof Error ? err.message : "Failed"); }
                            }}
                            className="text-muted-foreground hover:text-red-600 p-1"
                            title="Delete"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    )
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}


function StainForm({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const [body, setBody] = useState<StainInventoryBody>({ ...EMPTY_BODY });
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!body.brand.trim()) { toast.error("Brand is required"); return; }
    if (!body.color_name.trim()) { toast.error("Colour is required"); return; }
    if (body.container_count < 0 || body.gallons_per_container < 0) {
      toast.error("Quantities can't be negative");
      return;
    }
    setSaving(true);
    try {
      await api.createStainInventoryItem(body);
      toast.success("Added");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  };

  const total = (body.container_count || 0) * (body.gallons_per_container || 0);

  return (
    <div className="border rounded-lg p-3 bg-muted/20 space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div>
          <label className="text-xs font-semibold text-muted-foreground">Brand</label>
          <Input
            value={body.brand}
            onChange={(e) => setBody({ ...body, brand: e.target.value })}
            placeholder="e.g. Behr, Sherwin-Williams"
            className="mt-0.5"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-muted-foreground">Finish type</label>
          <select
            value={body.finish_type}
            onChange={(e) => setBody({ ...body, finish_type: e.target.value })}
            className="mt-0.5 w-full h-9 rounded-md border bg-background px-2 text-sm"
          >
            {STAIN_FINISH_TYPES.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold text-muted-foreground">Colour</label>
          <Input
            value={body.color_name}
            onChange={(e) => setBody({ ...body, color_name: e.target.value })}
            placeholder="e.g. Cedar Natural"
            className="mt-0.5"
          />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div>
          <label className="text-xs font-semibold text-muted-foreground">Containers</label>
          <Input
            type="number"
            step="1"
            min="0"
            value={body.container_count || ""}
            onChange={(e) => setBody({ ...body, container_count: parseFloat(e.target.value) || 0 })}
            placeholder="0"
            className="mt-0.5"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-muted-foreground">Gallons per container</label>
          <Input
            type="number"
            step="0.1"
            min="0"
            value={body.gallons_per_container || ""}
            onChange={(e) => setBody({ ...body, gallons_per_container: parseFloat(e.target.value) || 0 })}
            placeholder="5"
            className="mt-0.5"
          />
        </div>
        <div className="sm:col-span-1">
          <label className="text-xs font-semibold text-muted-foreground">Notes (optional)</label>
          <Input
            value={body.notes}
            onChange={(e) => setBody({ ...body, notes: e.target.value })}
            placeholder="Where it's stored, lot #, etc."
            className="mt-0.5"
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground">
          Total: <span className="font-semibold text-foreground">{gal(total)}</span>
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
        </div>
      </div>
    </div>
  );
}


function StainEditRow({
  item, onSaved, onCancel,
}: {
  item: StainInventoryItem;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState<StainInventoryBody>({
    brand: item.brand,
    finish_type: item.finish_type || "transparent",
    color_name: item.color_name,
    container_count: item.container_count,
    gallons_per_container: item.gallons_per_container,
    notes: item.notes,
    active: item.active,
  });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!body.brand.trim()) { toast.error("Brand required"); return; }
    if (!body.color_name.trim()) { toast.error("Colour required"); return; }
    setSaving(true);
    try {
      await api.updateStainInventoryItem(item.id, body);
      toast.success("Saved");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  };

  const total = (body.container_count || 0) * (body.gallons_per_container || 0);

  return (
    <tr className="border-b bg-muted/20">
      <td className="px-2 py-1.5">
        <Input value={body.brand} onChange={(e) => setBody({ ...body, brand: e.target.value })} className="h-7 text-xs" />
      </td>
      <td className="px-2 py-1.5">
        <select
          value={body.finish_type}
          onChange={(e) => setBody({ ...body, finish_type: e.target.value })}
          className="h-7 w-full rounded-md border bg-background px-1 text-xs"
        >
          {STAIN_FINISH_TYPES.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>
      </td>
      <td className="px-2 py-1.5">
        <Input value={body.color_name} onChange={(e) => setBody({ ...body, color_name: e.target.value })} className="h-7 text-xs" />
      </td>
      <td className="px-2 py-1.5">
        <Input
          type="number"
          step="1"
          min="0"
          value={body.container_count || ""}
          onChange={(e) => setBody({ ...body, container_count: parseFloat(e.target.value) || 0 })}
          className="h-7 text-xs text-right"
        />
      </td>
      <td className="px-2 py-1.5">
        <Input
          type="number"
          step="0.1"
          min="0"
          value={body.gallons_per_container || ""}
          onChange={(e) => setBody({ ...body, gallons_per_container: parseFloat(e.target.value) || 0 })}
          className="h-7 text-xs text-right"
        />
      </td>
      <td className="px-2 py-1.5 text-right text-xs font-semibold tabular-nums">{gal(total)}</td>
      <td className="px-2 py-1.5">
        <label className="text-xs flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={body.active} onChange={(e) => setBody({ ...body, active: e.target.checked })} />
          In stock
        </label>
      </td>
      <td className="px-2 py-1.5 text-right whitespace-nowrap">
        <button onClick={save} disabled={saving} className="text-emerald-600 hover:text-emerald-800 p-1" title="Save">
          <Check className="h-3.5 w-3.5" />
        </button>
        <button onClick={onCancel} className="text-muted-foreground hover:text-foreground p-1" title="Cancel">
          <X className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  );
}
