import { useEffect, useState, useCallback } from "react";
import {
  api,
  STAIN_FINISH_TYPES,
  STAIN_CONTAINER_SIZES,
  stainFinishLabel,
  type StainInventoryItem,
  type StainContainer,
  type StainBody,
  type StainMovement,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  PaintBucket, Plus, Pencil, Trash2, Check, X, Search,
  ChevronRight, ChevronDown, History,
} from "lucide-react";

// Stain Inventory — what's in the storage unit, container by container.
//
// Containers are tracked individually because they're never equally full: a
// 5-gallon with 3 gallons left sits beside an untouched one. Each container
// records the size it holds and how many gallons are actually in it — one
// number that covers both ways Alan counts, since a half-full 1-gallon can IS
// 0.5 gallons.
//
// Every add / adjust / remove writes an audit row (who, how much, when),
// because workers will eventually be entering usage from the field.

const EMPTY_STAIN: StainBody = {
  brand: "",
  finish_type: "transparent",
  color_name: "",
  notes: "",
  active: true,
};

function gal(n: number): string {
  return `${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} gal`;
}

function stainLabel(s: StainInventoryItem): string {
  return [s.brand, s.color_name].filter(Boolean).join(" · ") || "this stain";
}

function fmtWhen(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function StainInventory() {
  const [items, setItems] = useState<StainInventoryItem[]>([]);
  const [totals, setTotals] = useState({ gallons: 0, containers: 0 });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [finishFilter, setFinishFilter] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editingStain, setEditingStain] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listStainInventory({ q: search.trim() || undefined, finish_type: finishFilter || undefined })
      .then((r) => { setItems(r.items); setTotals({ gallons: r.total_gallons, containers: r.total_containers }); })
      .catch(() => { setItems([]); toast.error("Couldn't load the stain inventory"); })
      .finally(() => setLoading(false));
  }, [search, finishFilter]);

  // Debounced so typing in the search box doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-5xl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight flex items-center gap-2">
            <PaintBucket className="h-5 w-5 text-primary" /> Stain Inventory
          </h1>
          <p className="text-sm text-muted-foreground">
            Every stain we carry and exactly what's left in each container.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowHistory(!showHistory)}>
          <History className="h-3.5 w-3.5 mr-1" /> {showHistory ? "Hide" : "History"}
        </Button>
      </div>

      {showHistory && <MovementHistory />}

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-sm flex items-center gap-2">
              <PaintBucket className="h-4 w-4 text-primary" /> On hand
              <span className="text-xs font-normal text-muted-foreground">
                · {gal(totals.gallons)} in {totals.containers} container{totals.containers === 1 ? "" : "s"}
              </span>
            </CardTitle>
            <Button size="sm" variant={showAdd ? "outline" : "default"} onClick={() => setShowAdd(!showAdd)}>
              <Plus className="h-3.5 w-3.5 mr-1" /> {showAdd ? "Cancel" : "Add stain"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {showAdd && (
            <StainForm
              onSaved={(created) => {
                setShowAdd(false);
                setExpanded((p) => new Set(p).add(created.id));  // open it so containers can go straight in
                load();
              }}
              onCancel={() => setShowAdd(false)}
            />
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
            <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-12 bg-muted rounded animate-pulse" />)}</div>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              {search || finishFilter
                ? "No stains match that search."
                : "No stains yet. Add one, then log each container you've got in the storage unit."}
            </p>
          ) : (
            <div className="space-y-2">
              {items.map((s) => (
                editingStain === s.id ? (
                  <StainForm
                    key={s.id}
                    existing={s}
                    onSaved={() => { setEditingStain(null); load(); }}
                    onCancel={() => setEditingStain(null)}
                  />
                ) : (
                  <StainRow
                    key={s.id}
                    stain={s}
                    open={expanded.has(s.id)}
                    onToggle={() => toggle(s.id)}
                    onEdit={() => setEditingStain(s.id)}
                    onChanged={load}
                  />
                )
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}


function StainRow({
  stain, open, onToggle, onEdit, onChanged,
}: {
  stain: StainInventoryItem;
  open: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);

  return (
    <div className={`border rounded-lg ${stain.active ? "" : "opacity-60"}`}>
      <div className="flex items-center gap-2 px-3 py-2">
        <button onClick={onToggle} className="text-muted-foreground hover:text-foreground shrink-0" aria-label={open ? "Collapse" : "Expand"}>
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <button onClick={onToggle} className="flex-1 min-w-0 text-left">
          <div className="font-medium text-sm truncate">
            {stain.brand || "—"} <span className="text-muted-foreground font-normal">·</span> {stain.color_name || "—"}
          </div>
          <div className="text-xs text-muted-foreground">
            {stainFinishLabel(stain.finish_type)}
            {stain.notes ? ` · ${stain.notes}` : ""}
          </div>
        </button>
        <div className="text-right shrink-0">
          <div className="text-sm font-semibold tabular-nums">{gal(stain.total_gallons)}</div>
          <div className="text-[11px] text-muted-foreground">
            {stain.container_count} container{stain.container_count === 1 ? "" : "s"}
          </div>
        </div>
        {!stain.active && <Badge className="bg-muted text-muted-foreground text-[10px] shrink-0">Retired</Badge>}
        <div className="shrink-0 whitespace-nowrap">
          <button onClick={onEdit} className="text-muted-foreground hover:text-primary p-1" title="Edit stain">
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={async () => {
              if (!confirm(`Delete "${stainLabel(stain)}" and its ${stain.container_count} container(s)? The movement history is kept.`)) return;
              try { await api.deleteStain(stain.id); toast.success("Deleted"); onChanged(); }
              catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
            }}
            className="text-muted-foreground hover:text-red-600 p-1"
            title="Delete stain"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t bg-muted/20 px-3 py-2 space-y-1.5">
          {stain.containers.length === 0 ? (
            <p className="text-xs text-muted-foreground py-1">
              No containers logged yet. Add what's on the shelf.
            </p>
          ) : (
            stain.containers.map((c) => (
              <ContainerRow key={c.id} container={c} onChanged={onChanged} />
            ))
          )}

          {adding ? (
            <AddContainerForm
              stainId={stain.id}
              onSaved={() => { setAdding(false); onChanged(); }}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAdding(true)}>
              <Plus className="h-3 w-3 mr-1" /> Add container
            </Button>
          )}
        </div>
      )}
    </div>
  );
}


/** One physical container. Click the gallons to change what's left in it —
 * that's the daily "we used some" action. */
function ContainerRow({ container, onChanged }: { container: StainContainer; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(String(container.gallons_remaining));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const size = container.size_gallons;

  const save = async (value: number) => {
    if (value < 0) { toast.error("Can't be negative"); return; }
    if (value > size) { toast.error(`A ${size}-gallon container can't hold ${value}`); return; }
    setSaving(true);
    try {
      await api.updateStainContainer(container.id, { gallons_remaining: value, note });
      toast.success("Updated");
      setEditing(false);
      setNote("");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div className="flex items-center gap-2 text-sm bg-background rounded border px-2 py-1.5">
        <span className="text-xs font-medium text-muted-foreground w-14 shrink-0">{size} gal</span>
        <div className="flex-1 min-w-0">
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full ${container.percent_full > 50 ? "bg-emerald-500" : container.percent_full > 20 ? "bg-amber-500" : "bg-red-500"}`}
              style={{ width: `${Math.min(100, Math.max(0, container.percent_full))}%` }}
            />
          </div>
          {container.label && <div className="text-[11px] text-muted-foreground truncate mt-0.5">{container.label}</div>}
        </div>
        <span className="tabular-nums text-sm font-medium w-20 text-right shrink-0">{gal(container.gallons_remaining)}</span>
        <span className="text-[11px] text-muted-foreground w-12 text-right shrink-0">{container.percent_full}%</span>
        <button
          onClick={() => { setAmount(String(container.gallons_remaining)); setEditing(true); }}
          className="text-muted-foreground hover:text-primary p-1 shrink-0"
          title="Update how much is left"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={async () => {
            if (!confirm(`Remove this ${size}-gallon container (${gal(container.gallons_remaining)} left)?`)) return;
            try { await api.deleteStainContainer(container.id); toast.success("Container removed"); onChanged(); }
            catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
          }}
          className="text-muted-foreground hover:text-red-600 p-1 shrink-0"
          title="Remove container"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="bg-background rounded border px-2 py-2 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-medium text-muted-foreground w-14 shrink-0">{size} gal</span>
        <Input
          type="number"
          step="0.01"
          min="0"
          max={size}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="h-7 text-xs w-24"
          autoFocus
        />
        <span className="text-xs text-muted-foreground">gallons left</span>
        {/* Quick fills, computed off the container size — ½ of a 5-gal is 2.5,
            ½ of a 1-gal is 0.5, so the maths never lands on the user. */}
        <div className="flex gap-1">
          {([["Full", 1], ["¾", 0.75], ["½", 0.5], ["¼", 0.25], ["Empty", 0]] as [string, number][]).map(([label, frac]) => (
            <button
              key={label}
              onClick={() => setAmount(String(Number((size * frac).toFixed(2))))}
              className="text-[11px] px-1.5 py-0.5 rounded border hover:bg-muted"
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <Input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="What happened? e.g. used on Smith job (optional)"
        className="h-7 text-xs"
      />
      <div className="flex justify-end gap-1">
        <button onClick={() => save(parseFloat(amount) || 0)} disabled={saving} className="text-emerald-600 hover:text-emerald-800 p-1" title="Save">
          <Check className="h-4 w-4" />
        </button>
        <button onClick={() => { setEditing(false); setNote(""); }} className="text-muted-foreground hover:text-foreground p-1" title="Cancel">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}


function AddContainerForm({
  stainId, onSaved, onCancel,
}: {
  stainId: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [size, setSize] = useState(STAIN_CONTAINER_SIZES[0]);
  const [remaining, setRemaining] = useState(String(STAIN_CONTAINER_SIZES[0]));
  const [count, setCount] = useState("1");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);

  // Picking a size refills the amount so the common case (a new, full
  // container) needs no extra typing.
  const pickSize = (s: number) => { setSize(s); setRemaining(String(s)); };

  const submit = async () => {
    const amount = parseFloat(remaining) || 0;
    const n = parseInt(count, 10) || 1;
    if (amount < 0) { toast.error("Can't be negative"); return; }
    if (amount > size) { toast.error(`A ${size}-gallon container can't hold ${amount}`); return; }
    if (n < 1) { toast.error("Count must be at least 1"); return; }
    setSaving(true);
    try {
      await api.addStainContainers(stainId, {
        size_gallons: size, gallons_remaining: amount, count: n, label,
      });
      toast.success(n === 1 ? "Container added" : `${n} containers added`);
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-background rounded border p-2 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold text-muted-foreground">Size</span>
        {STAIN_CONTAINER_SIZES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => pickSize(s)}
            className={`text-xs px-2 py-1 rounded border ${size === s ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
          >
            {s} gallon
          </button>
        ))}
      </div>
      <div className="flex items-end gap-2 flex-wrap">
        <div className="w-28">
          <label className="text-[11px] font-semibold text-muted-foreground">Gallons in it</label>
          <Input type="number" step="0.01" min="0" max={size} value={remaining}
            onChange={(e) => setRemaining(e.target.value)} className="h-7 text-xs mt-0.5" />
        </div>
        <div className="w-20">
          <label className="text-[11px] font-semibold text-muted-foreground">How many</label>
          <Input type="number" step="1" min="1" value={count}
            onChange={(e) => setCount(e.target.value)} className="h-7 text-xs mt-0.5" />
        </div>
        <div className="flex-1 min-w-[120px]">
          <label className="text-[11px] font-semibold text-muted-foreground">Label (optional)</label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)}
            placeholder="shelf A, truck 2…" className="h-7 text-xs mt-0.5" />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          Adds {gal((parseFloat(remaining) || 0) * (parseInt(count, 10) || 1))} to this stain
        </span>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button size="sm" className="h-7 text-xs" onClick={submit} disabled={saving}>{saving ? "Saving…" : "Add"}</Button>
        </div>
      </div>
    </div>
  );
}


function StainForm({
  existing, onSaved, onCancel,
}: {
  existing?: StainInventoryItem;
  onSaved: (s: StainInventoryItem) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState<StainBody>(
    existing
      ? {
          brand: existing.brand,
          finish_type: existing.finish_type || "transparent",
          color_name: existing.color_name,
          notes: existing.notes,
          active: existing.active,
        }
      : { ...EMPTY_STAIN },
  );
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!body.brand.trim()) { toast.error("Brand is required"); return; }
    if (!body.color_name.trim()) { toast.error("Colour is required"); return; }
    setSaving(true);
    try {
      const saved = existing
        ? await api.updateStain(existing.id, body)
        : await api.createStain(body);
      toast.success(existing ? "Saved" : "Stain added");
      onSaved(saved);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border rounded-lg p-3 bg-muted/20 space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div>
          <label className="text-xs font-semibold text-muted-foreground">Brand</label>
          <Input value={body.brand} onChange={(e) => setBody({ ...body, brand: e.target.value })}
            placeholder="e.g. Behr, Sherwin-Williams" className="mt-0.5" />
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
          <Input value={body.color_name} onChange={(e) => setBody({ ...body, color_name: e.target.value })}
            placeholder="e.g. Cedar Natural" className="mt-0.5" />
        </div>
      </div>
      <div className="flex items-end gap-2 flex-wrap">
        <div className="flex-1 min-w-[160px]">
          <label className="text-xs font-semibold text-muted-foreground">Notes (optional)</label>
          <Input value={body.notes} onChange={(e) => setBody({ ...body, notes: e.target.value })}
            placeholder="Anything worth remembering" className="mt-0.5" />
        </div>
        <label className="text-xs flex items-center gap-1 cursor-pointer pb-2">
          <input type="checkbox" checked={body.active} onChange={(e) => setBody({ ...body, active: e.target.checked })} />
          Still carried
        </label>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button onClick={submit} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
      </div>
    </div>
  );
}


/** Audit trail — every gallon in or out, newest first. */
function MovementHistory() {
  const [rows, setRows] = useState<StainMovement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api.listStainMovements({ limit: 100 })
      .then((r) => { if (alive) setRows(r.movements); })
      .catch(() => { if (alive) toast.error("Couldn't load the history"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <History className="h-4 w-4 text-primary" /> Movement history
          <span className="text-xs font-normal text-muted-foreground">· last 100 changes</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-8 bg-muted rounded animate-pulse" />)}</div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            Nothing logged yet. Adding or updating containers will show up here.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="px-2 py-1.5 font-medium">When</th>
                  <th className="px-2 py-1.5 font-medium">Stain</th>
                  <th className="px-2 py-1.5 font-medium">What</th>
                  <th className="px-2 py-1.5 font-medium text-right">Change</th>
                  <th className="px-2 py-1.5 font-medium text-right">After</th>
                  <th className="px-2 py-1.5 font-medium">Who</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id} className="border-b">
                    <td className="px-2 py-1.5 text-xs text-muted-foreground whitespace-nowrap">{fmtWhen(m.created_at)}</td>
                    <td className="px-2 py-1.5 text-xs">{m.stain_label}</td>
                    <td className="px-2 py-1.5 text-xs text-muted-foreground truncate max-w-[220px]">{m.note || m.action}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums text-xs font-medium ${m.delta_gallons < 0 ? "text-red-600" : "text-emerald-600"}`}>
                      {m.delta_gallons > 0 ? "+" : ""}{Number(m.delta_gallons).toFixed(2)}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-xs">{Number(m.resulting_gallons).toFixed(2)}</td>
                    <td className="px-2 py-1.5 text-xs">{m.actor}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
