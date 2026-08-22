import { useEffect, useState, useCallback, useMemo } from "react";
import {
  api,
  STAIN_FINISH_TYPES,
  stainFinishLabel,
  type StainInventoryItem,
  type StainBody,
  type StainMovement,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { PaintBucket, Plus, Pencil, Trash2, Check, X, Search, History } from "lucide-react";

// Stain Inventory — what's in the storage unit, one number per colour.
//
// Sections are brand + finish (Valspar · Solid, Ready Seal · Oil-Based …) with
// the stains underneath, each showing gallons on hand in an editable box with a
// Save button. Section subtotals and a grand total at the bottom, matching the
// sheet Alan already keeps by hand.
//
// Deliberately NOT tracking individual containers. Two earlier versions did and
// both lost to how the count actually happens: he walks the unit and writes one
// figure per colour. Every save still writes an audit row (who / when / how
// much) for when workers start updating this from the field.

const EMPTY_STAIN: StainBody = {
  brand: "",
  finish_type: "solid",
  color_name: "",
  gallons: 0,
};

const SELECT_CLASS =
  "h-9 rounded-md border border-input bg-background px-2 text-sm shadow-sm " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** Trim trailing zeros — 3.17 stays 3.17, 14.00 reads 14. */
function num(n: number): string {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function gal(n: number): string {
  return `${num(n)} gal`;
}

function fmtWhen(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

type Group = { key: string; brand: string; finish: string; items: StainInventoryItem[]; gallons: number };

/** Walk the already-sorted list and break a new section whenever brand or
 * finish changes. Relies on the backend's sort (brand, then finish by opacity,
 * then name) so the order here and there can't disagree. */
function groupStains(items: StainInventoryItem[]): Group[] {
  const groups: Group[] = [];
  for (const item of items) {
    const key = `${item.brand}|||${item.finish_type}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(item);
      last.gallons += item.gallons;
    } else {
      groups.push({ key, brand: item.brand, finish: item.finish_type, items: [item], gallons: item.gallons });
    }
  }
  return groups.map((g) => ({ ...g, gallons: Math.round(g.gallons * 100) / 100 }));
}

export default function StainInventory() {
  const [items, setItems] = useState<StainInventoryItem[]>([]);
  const [totalGallons, setTotalGallons] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [finishFilter, setFinishFilter] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  // Which section (brand|||finish) has its inline "add stain" line open.
  const [addingTo, setAddingTo] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listStainInventory({ q: search.trim() || undefined, finish_type: finishFilter || undefined })
      .then((r) => { setItems(r.items); setTotalGallons(r.total_gallons); })
      .catch(() => { setItems([]); toast.error("Couldn't load the stain inventory"); })
      .finally(() => setLoading(false));
  }, [search, finishFilter]);

  // Debounced so typing in the search box doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const groups = useMemo(() => groupStains(items), [items]);
  const filtered = Boolean(search.trim() || finishFilter);

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-3xl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight flex items-center gap-2">
            <PaintBucket className="h-5 w-5 text-primary" /> Stain Inventory
          </h1>
          <p className="text-sm text-muted-foreground">
            How many gallons of each stain are in the storage unit. Edit the number, hit Save.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowHistory(!showHistory)}>
          <History className="h-3.5 w-3.5 mr-1" /> {showHistory ? "Hide history" : "History"}
        </Button>
      </div>

      {showHistory && <MovementHistory />}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-sm">On hand</CardTitle>
            <Button size="sm" variant={showAdd ? "outline" : "default"} onClick={() => setShowAdd(!showAdd)}>
              <Plus className="h-3.5 w-3.5 mr-1" /> {showAdd ? "Cancel" : "New brand or finish"}
            </Button>
          </div>
          <div className="flex items-center gap-2 flex-wrap pt-1">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-7 h-9"
                placeholder="Search brand or stain name…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <select
              className={SELECT_CLASS}
              value={finishFilter}
              onChange={(e) => setFinishFilter(e.target.value)}
            >
              <option value="">All finishes</option>
              {STAIN_FINISH_TYPES.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </div>
        </CardHeader>

        <CardContent className="space-y-5">
          {showAdd && (
            <StainForm
              onCancel={() => setShowAdd(false)}
              onSaved={() => { load(); }}
            />
          )}

          {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

          {!loading && groups.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {filtered
                ? "No stains match that search."
                : "Nothing logged yet. Hit “New brand or finish” to start the count."}
            </p>
          )}

          {!loading && groups.map((g) => (
            <div key={g.key} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2 border-b pb-1">
                <h3 className="text-sm font-semibold">
                  {g.brand} <span className="text-muted-foreground font-normal">— {stainFinishLabel(g.finish)}</span>
                </h3>
                <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                  {gal(g.gallons)}
                </span>
              </div>
              {g.items.map((item) => (
                <StainRow
                  key={`${item.id}:${item.updated_at}`}
                  item={item}
                  onChanged={load}
                />
              ))}
              {addingTo === g.key ? (
                <AddToSection
                  brand={g.brand}
                  finish={g.finish}
                  onCancel={() => setAddingTo(null)}
                  onSaved={load}
                />
              ) : (
                <button
                  type="button"
                  className="flex items-center gap-1 pt-1 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setAddingTo(g.key)}
                >
                  <Plus className="h-3 w-3" /> Add stain
                </button>
              )}
            </div>
          ))}

          {!loading && groups.length > 0 && (
            <div className="flex items-baseline justify-between gap-2 border-t-2 pt-3">
              <span className="text-sm font-semibold">
                {filtered ? "Total shown" : "Total Stain Inventory"}
              </span>
              <span className="text-lg font-semibold tabular-nums">{num(totalGallons)} gallons</span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** One stain: name on the left, gallons box + Save on the right. Save only
 * lights up once the number actually differs, so a stray click can't write a
 * no-op movement into the history. */
function StainRow({ item, onChanged }: { item: StainInventoryItem; onChanged: () => void }) {
  const [value, setValue] = useState(num(item.gallons));
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);

  const parsed = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(parsed) && parsed >= 0;
  const dirty = valid && Math.abs(parsed - item.gallons) > 1e-9;

  const save = () => {
    if (!dirty || saving) return;
    setSaving(true);
    api
      .updateStain(item.id, {
        brand: item.brand,
        finish_type: item.finish_type,
        color_name: item.color_name,
        gallons: parsed,
        notes: item.notes,
        active: item.active,
      })
      .then(() => { toast.success(`${item.color_name} → ${gal(parsed)}`); onChanged(); })
      .catch((e) => toast.error(e instanceof Error ? e.message : "Couldn't save"))
      .finally(() => setSaving(false));
  };

  const remove = () => {
    if (!confirm(`Remove ${item.color_name} from the inventory?`)) return;
    api
      .deleteStain(item.id)
      .then(() => { toast.success(`${item.color_name} removed`); onChanged(); })
      .catch((e) => toast.error(e instanceof Error ? e.message : "Couldn't remove"));
  };

  if (editing) {
    return (
      <StainForm
        item={item}
        onCancel={() => setEditing(false)}
        onSaved={() => { setEditing(false); onChanged(); }}
      />
    );
  }

  return (
    <div className="flex items-center gap-2 py-1 group">
      <span className="flex-1 text-sm truncate" title={item.color_name}>
        {item.color_name}
        {item.notes && <span className="text-xs text-muted-foreground ml-2">{item.notes}</span>}
      </span>

      <Input
        type="number"
        step="0.5"
        min="0"
        inputMode="decimal"
        className="h-8 w-24 text-right tabular-nums"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") save(); }}
      />
      <span className="text-xs text-muted-foreground w-7">gal</span>

      <Button
        size="sm"
        className="h-8"
        variant={dirty ? "default" : "outline"}
        disabled={!dirty || saving}
        onClick={save}
      >
        {saving ? "Saving…" : "Save"}
      </Button>

      <Button
        size="sm"
        variant="ghost"
        className="h-8 w-8 p-0 text-muted-foreground"
        title="Edit name / brand / finish"
        onClick={() => setEditing(true)}
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
        title="Remove"
        onClick={remove}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

/** Add a stain to a section that already exists. Brand and finish come from
 * the section heading — "Valspar — Solid" already says both — so all that's
 * left to type is the name and the gallons. Stays open after saving, since a
 * shelf gets entered a few colours at a time. */
function AddToSection({
  brand,
  finish,
  onCancel,
  onSaved,
}: {
  brand: string;
  finish: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [gallonsText, setGallonsText] = useState("");
  const [saving, setSaving] = useState(false);

  const parsed = Number(gallonsText);
  const gallonsOk = gallonsText.trim() === "" || (Number.isFinite(parsed) && parsed >= 0);
  const canSave = Boolean(name.trim()) && gallonsOk && !saving;

  const submit = () => {
    if (!canSave) return;
    setSaving(true);
    const added = name.trim();
    api
      .createStain({
        brand,
        finish_type: finish,
        color_name: added,
        gallons: gallonsText.trim() === "" ? 0 : parsed,
      })
      .then(() => {
        toast.success(`${added} added to ${brand} — ${stainFinishLabel(finish)}`);
        setName("");
        setGallonsText("");
        onSaved();
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : "Couldn't add it"))
      .finally(() => setSaving(false));
  };

  // Esc backs out without leaving a half-typed row behind.
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") submit();
    if (e.key === "Escape") onCancel();
  };

  return (
    <div className="flex items-center gap-2 py-1">
      <Input
        autoFocus
        className="h-8 flex-1"
        placeholder={`New ${stainFinishLabel(finish).toLowerCase()} stain name\u2026`}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={onKey}
      />
      <Input
        type="number"
        step="0.5"
        min="0"
        inputMode="decimal"
        className="h-8 w-24 text-right tabular-nums"
        placeholder="0"
        value={gallonsText}
        onChange={(e) => setGallonsText(e.target.value)}
        onKeyDown={onKey}
      />
      <span className="w-7 text-xs text-muted-foreground">gal</span>
      <Button size="sm" className="h-8" disabled={!canSave} onClick={submit}>
        {saving ? "Saving\u2026" : "Save"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-8 w-8 p-0 text-muted-foreground"
        title="Done adding"
        onClick={onCancel}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
      {/* Keeps the Save button in line with the rows above, which have two icons. */}
      <span className="w-8" />
    </div>
  );
}

/** Add a new stain, or edit an existing one's brand / finish / name / gallons.
 * On add the brand and finish stick around after saving — entering a whole
 * shelf of one brand shouldn't mean re-picking it every time. */
function StainForm({
  item,
  onCancel,
  onSaved,
}: {
  item?: StainInventoryItem;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<StainBody>(
    item
      ? {
          brand: item.brand,
          finish_type: item.finish_type,
          color_name: item.color_name,
          gallons: item.gallons,
          notes: item.notes,
          active: item.active,
        }
      : EMPTY_STAIN,
  );
  const [gallonsText, setGallonsText] = useState(item ? num(item.gallons) : "");
  const [saving, setSaving] = useState(false);

  const parsed = Number(gallonsText);
  const gallonsOk = gallonsText.trim() === "" || (Number.isFinite(parsed) && parsed >= 0);
  const canSave = Boolean(form.brand.trim() && form.color_name.trim()) && gallonsOk && !saving;

  const submit = () => {
    if (!canSave) return;
    setSaving(true);
    const body: StainBody = { ...form, gallons: gallonsText.trim() === "" ? 0 : parsed };
    const req = item ? api.updateStain(item.id, body) : api.createStain(body);
    req
      .then(() => {
        toast.success(item ? "Saved" : `${body.color_name} added`);
        if (!item) {
          // Keep brand + finish for the next one down the shelf.
          setForm({ ...form, color_name: "" });
          setGallonsText("");
        }
        onSaved();
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : "Couldn't save"))
      .finally(() => setSaving(false));
  };

  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-2">
      <div className="flex gap-2 flex-wrap">
        <Input
          className="h-9 flex-1 min-w-[130px]"
          placeholder="Brand (Valspar…)"
          value={form.brand}
          onChange={(e) => setForm({ ...form, brand: e.target.value })}
        />
        <select
          className={SELECT_CLASS}
          value={form.finish_type}
          onChange={(e) => setForm({ ...form, finish_type: e.target.value })}
        >
          {STAIN_FINISH_TYPES.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>
      </div>
      <div className="flex gap-2 flex-wrap items-center">
        <Input
          className="h-9 flex-1 min-w-[150px]"
          placeholder="Stain name (Pine Bark…)"
          value={form.color_name}
          onChange={(e) => setForm({ ...form, color_name: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        />
        <Input
          type="number"
          step="0.5"
          min="0"
          inputMode="decimal"
          className="h-9 w-24 text-right tabular-nums"
          placeholder="0"
          value={gallonsText}
          onChange={(e) => setGallonsText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        />
        <span className="text-xs text-muted-foreground">gal</span>
        <Button size="sm" className="h-9" disabled={!canSave} onClick={submit}>
          <Check className="h-3.5 w-3.5 mr-1" /> {saving ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" className="h-9" onClick={onCancel}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

/** Every gallon change, newest first, with who made it. */
function MovementHistory() {
  const [rows, setRows] = useState<StainMovement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .listStainMovements({ limit: 100 })
      .then((r) => setRows(r.movements))
      .catch(() => toast.error("Couldn't load the history"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">History</CardTitle>
      </CardHeader>
      <CardContent>
        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!loading && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">No changes logged yet.</p>
        )}
        {!loading && rows.length > 0 && (
          <div className="space-y-1 max-h-72 overflow-y-auto text-sm">
            {rows.map((m) => (
              <div key={m.id} className="flex items-center gap-2 py-0.5 border-b last:border-0">
                <span className="text-xs text-muted-foreground w-24 shrink-0">{fmtWhen(m.created_at)}</span>
                <span className="flex-1 truncate">{m.stain_label}</span>
                <span
                  className={`tabular-nums text-xs w-16 text-right ${
                    m.delta_gallons < 0 ? "text-destructive" : "text-emerald-600"
                  }`}
                >
                  {m.delta_gallons > 0 ? "+" : ""}{num(m.delta_gallons)}
                </span>
                <span className="tabular-nums text-xs w-16 text-right text-muted-foreground">
                  → {num(m.resulting_gallons)}
                </span>
                <span className="text-xs text-muted-foreground w-20 truncate text-right">{m.actor}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
