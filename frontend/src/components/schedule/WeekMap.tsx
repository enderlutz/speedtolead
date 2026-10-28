/**
 * The week map under the PM HQ calendar (Alan, 2026-10-25): "I don't know
 * how to plot the jobs onto a map." A pin for every customer on the days on
 * screen, by itself, plus anyone Alan puts on it by name (an unpaid booking
 * he's planning around). Any pin can come off for the week (Alan,
 * 2026-10-27) and go back on from the row under the map. Each pin shows only the name and where the job stands:
 * the name alone = nothing done yet, 🧽 = cleaned, a green ✓ = cleaned and
 * stained. A 🔧 means there's a job to fix there on one of these days
 * (Alan, 2026-10-27). For planning cleaning and staining routes.
 */
import { useEffect, useMemo, useState } from "react";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { toast } from "sonner";
import { EyeOff, Loader2, MapPin, Plus, Search, Undo2, X } from "lucide-react";
import { api, type PmMapPin } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { errMessage } from "@/lib/utils";

const HOUSTON: [number, number] = [29.9, -95.5];
const TASK: Record<string, string> = { cleaning: "Cleaning", staining: "Staining", pressure_washing: "Pressure washing", repairs: "Repairs", fix: "Fix" };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const dayName = (d: string) => new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

/** A dot on the house and a name tag above it. */
function pinIcon(p: PmMapPin): L.DivIcon {
  const fix = p.days.some((d) => d.task === "fix" && !d.done) ? `<span style="font-size:15px;line-height:1;">🔧</span>` : "";
  const mark = fix + (p.status === "done"
    ? `<span style="display:inline-flex;width:18px;height:18px;border-radius:50%;background:#15803d;color:#fff;font-size:12px;font-weight:900;align-items:center;justify-content:center;">✓</span>`
    : p.status === "cleaned" ? `<span style="font-size:15px;line-height:1;">🧽</span>` : "");
  const dot = p.status === "done" ? "#15803d" : p.status === "cleaned" ? "#9a6a26" : "#1c1917";
  const html = `
    <div style="position:absolute;left:0;bottom:0;transform:translate(-50%,0);display:flex;flex-direction:column;align-items:center;pointer-events:auto;">
      <div style="display:flex;align-items:center;gap:5px;white-space:nowrap;background:#fffdf8;color:#1c1917;border:1.5px solid ${dot};border-radius:999px;padding:3px 9px;font:600 14px/1.2 Inter,system-ui,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.25);${p.status === "done" ? "opacity:.85;" : ""}">
        ${mark}<span>${esc(p.name || "(no name)")}</span>
      </div>
      <div style="width:2px;height:8px;background:${dot};"></div>
      <div style="width:12px;height:12px;border-radius:50%;background:${dot};border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4);margin-bottom:-6px;"></div>
    </div>`;
  return L.divIcon({ html, className: "", iconSize: [0, 0], iconAnchor: [0, 0], popupAnchor: [0, -40] });
}

/** Zoom to fit every pin whenever the set of pins changes. */
function FitPins({ pts }: { pts: [number, number][] }) {
  const map = useMap();
  const key = pts.map((p) => p.join(",")).join("|");
  useEffect(() => {
    if (!pts.length) return;
    if (pts.length === 1) map.setView(pts[0], 13);
    else map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 13 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map]);
  return null;
}

export function WeekMap({ start, end, refreshKey }: { start: string; end: string; refreshKey?: unknown }) {
  const [pins, setPins] = useState<PmMapPin[] | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);

  useEffect(() => {
    let live = true;
    api.getPmHqMap(start, end)
      .then((r) => { if (live) { setPins(r.pins); setCanEdit(r.can_edit); } })
      .catch((e) => toast.error(errMessage(e, "Couldn't load the map")));
    return () => { live = false; };
  }, [start, end, refreshKey, tick]);

  const shown = useMemo(() => (pins || []).filter((p) => !p.hidden), [pins]);
  const hiddenPins = useMemo(() => (pins || []).filter((p) => p.hidden), [pins]);
  const placed = useMemo(() => shown.filter((p) => p.lat != null && p.lng != null), [shown]);
  const missing = useMemo(() => shown.filter((p) => p.lat == null || p.lng == null), [shown]);
  const pts = useMemo(() => placed.map((p) => [p.lat!, p.lng!] as [number, number]), [placed]);

  const remove = async (p: PmMapPin) => {
    try { await api.pmHqMapRemove(p.lead_id); toast.success(`${p.name} taken off the map`); reload(); }
    catch (e) { toast.error(errMessage(e, "Couldn't take it off")); }
  };
  const hide = async (p: PmMapPin, hidden: boolean) => {
    try {
      await api.pmHqMapHide(p.lead_id, start, hidden);
      toast.success(hidden ? `${p.name} is off this week's map` : `${p.name} is back on the map`);
      reload();
    } catch (e) { toast.error(errMessage(e, "Couldn't change that")); }
  };

  return (
    <section className="space-y-3 rounded-2xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="flex items-center gap-1.5 font-semibold"><MapPin className="h-4 w-4 text-primary" />Where they are</p>
          <p className="text-sm text-muted-foreground">
            Every job on these days is here by itself, and every job to fix at a customer's. Tap a pin to hide it this week.
          </p>
          <p className="text-sm text-muted-foreground">
            Name only = nothing done yet · 🧽 = cleaned · <span className="font-semibold text-green-700">✓</span> = cleaned and stained · 🔧 = a job to fix
          </p>
        </div>
        {!pins ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
      </div>
      {canEdit ? <AddCustomer onAdded={reload} have={new Set((pins || []).map((p) => p.lead_id))} /> : null}
      {/* isolate keeps Leaflet's panes under the page's menus and dialogs */}
      <div className="isolate h-[460px] overflow-hidden rounded-xl border sm:h-[560px]">
        <MapContainer center={HOUSTON} zoom={10} scrollWheelZoom style={{ height: "100%", width: "100%" }}>
          <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                     url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          <FitPins pts={pts} />
          {placed.map((p) => (
            <Marker key={p.lead_id} position={[p.lat!, p.lng!]} icon={pinIcon(p)}>
              <Popup>
                <div className="space-y-1 text-sm">
                  <p className="font-semibold">{p.name}</p>
                  {p.address ? <p className="text-muted-foreground">{p.address}</p> : null}
                  {p.days.length
                    ? p.days.map((d) => <p key={d.date + d.task + (d.note || "")}>{dayName(d.date)} · {TASK[d.task] || d.task}{d.note ? `: ${d.note}` : ""}{d.done ? " ✓" : ""}</p>)
                    : <p className="text-muted-foreground">Not on the calendar yet</p>}
                  <div className="flex flex-wrap gap-3 pt-1">
                    <a className="font-semibold text-blue-700 underline" target="_blank" rel="noreferrer"
                       href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.address)}`}>Google Maps</a>
                    {canEdit ? (
                      <button type="button" className="font-semibold text-red-700 underline" onClick={() => void hide(p, true)}>Hide this week</button>
                    ) : null}
                    {p.added && canEdit ? (
                      <button type="button" className="font-semibold text-red-700 underline" onClick={() => void remove(p)}>Take off map</button>
                    ) : null}
                  </div>
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>
      {pins && !pins.length ? <p className="text-sm text-muted-foreground">Nobody on these days yet. Put a customer on a day, or add one above, to see where they are.</p> : null}
      {hiddenPins.length ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 text-sm text-muted-foreground"><EyeOff className="h-3.5 w-3.5" />Hidden this week:</span>
          {hiddenPins.map((p) => (
            <button key={p.lead_id} type="button" onClick={() => void hide(p, false)} title="Put it back on the map"
                    className="inline-flex min-h-9 items-center gap-1 rounded-full border bg-background px-3 text-sm hover:bg-muted">
              {p.name}<Undo2 className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
      ) : null}
      {missing.length ? (
        <p className="text-sm text-amber-800">
          Couldn't find on the map (check the address): {missing.map((p) => p.name || "(no name)").join(", ")}
        </p>
      ) : null}
      {canEdit && (pins || []).some((p) => p.added) ? (
        <div className="flex flex-wrap gap-2">
          <span className="text-sm text-muted-foreground">Added by you:</span>
          {(pins || []).filter((p) => p.added).map((p) => (
            <button key={p.lead_id} type="button" onClick={() => void remove(p)}
                    className="inline-flex min-h-9 items-center gap-1 rounded-full border bg-background px-3 text-sm hover:bg-muted">
              {p.name}<X className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** Type a name or street, tap the customer, and a pin goes on the map. */
function AddCustomer({ onAdded, have }: { onAdded: () => void; have: Set<string> }) {
  const [q, setQ] = useState("");
  const [options, setOptions] = useState<{ lead_id: string; name: string; address: string }[]>([]);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setOptions([]); return; }
    const t = window.setTimeout(() => {
      api.getCompanyCamJobs(term).then((r) => setOptions(r.slice(0, 8))).catch(() => setOptions([]));
    }, 250);
    return () => window.clearTimeout(t);
  }, [q]);
  const add = async (o: { lead_id: string; name: string }) => {
    try { await api.pmHqMapAdd(o.lead_id); toast.success(`${o.name} is on the map`); setQ(""); setOptions([]); onAdded(); }
    catch (e) { toast.error(errMessage(e, "Couldn't add them")); }
  };
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" />
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add a customer to the map: type a name or street"
             className="h-11 pl-9 text-base sm:text-sm" />
      {options.length ? (
        <ul className="absolute z-[1000] mt-1 w-full overflow-hidden rounded-xl border bg-popover shadow-lg">
          {options.map((o) => (
            <li key={o.lead_id}>
              <button type="button" disabled={have.has(o.lead_id)} onClick={() => void add(o)}
                      className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted disabled:opacity-50">
                <Plus className="h-4 w-4 shrink-0 text-primary" />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{o.name || "(no name)"}</span>
                  <span className="block truncate text-sm text-muted-foreground">{have.has(o.lead_id) ? "Already on the map" : o.address}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
