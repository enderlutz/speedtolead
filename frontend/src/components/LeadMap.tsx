import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { api, type LeadMapData, type LeadMapStop } from "@/lib/api";
import { loadGoogleMaps } from "@/lib/googleMaps";
import { Card, CardContent } from "@/components/ui/card";
import { Clock, MapPin, Eye, EyeOff, List, Loader2, ChevronDown, ChevronUp } from "lucide-react";

const HOUSTON = { lat: 29.7604, lng: -95.3698 };
const STOP_COLOR = "#dc2626";   // red — matches the default numbered pin
const SENT_COLOR = "#8b5cf6";   // purple — estimate sent

// Pre-estimate stage → pin color + label (mirror of the Sterling V2 stages).
const NEW_LEAD_ID = "e77fa568-8dd1-4f66-83c3-fa70dbd4d570";
const STAGE_PINS: Record<string, { label: string; color: string }> = {
  "e77fa568-8dd1-4f66-83c3-fa70dbd4d570": { label: "New Lead", color: "#9ca3af" },
  "616087fa-4144-454e-b3d3-ff3669cb9461": { label: "Hot Lead", color: "#f97316" },
  "86fd0197-38ee-4999-bd26-4cf175aeba6b": { label: "Address Follow Up", color: "#f59e0b" },
  "92585169-bbc1-42c5-945d-63caf780e0b1": { label: "Responded to Address", color: "#eab308" },
  "1e8a52ac-a85a-4ee6-bcd5-0699ff64d3a7": { label: "Call 1 Pre-Estimate", color: "#06b6d4" },
  "fe74a5e6-e173-4783-a8a9-1f28168a6c1b": { label: "Call 2 Pre-Estimate", color: "#0ea5e9" },
  "3020bb38-8c84-455d-a840-3650fbe50ecd": { label: "Call 3 Pre-Estimate", color: "#3b82f6" },
};
function catForStage(stageId: string): string {
  return STAGE_PINS[stageId] ? stageId : NEW_LEAD_ID;   // blank/unknown → New Lead
}
function pinColor(stageId: string): string {
  return (STAGE_PINS[stageId] || STAGE_PINS[NEW_LEAD_ID]).color;
}
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
function fmtTime(hhmm: string): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m || 0).padStart(2, "0")} ${period}`;
}
function dayLabel(d: string): string {
  return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

export default function LeadMap() {
  const navigate = useNavigate();
  const [data, setData] = useState<LeadMapData | null>(null);
  const [selectedDate, setSelectedDate] = useState("");
  const [stops, setStops] = useState<LeadMapStop[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [legendOpen, setLegendOpen] = useState(true);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "nokey">("loading");

  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<GMap | null>(null);
  const iwRef = useRef<GInfoWindow | null>(null);
  const markersRef = useRef<GMarker[]>([]);
  const polyRef = useRef<GPolyline | null>(null);
  const fitSigRef = useRef("");

  // Initial load — pins for every active lead (no date yet).
  useEffect(() => {
    api.getLeadMap().then(setData).catch(() => setStatus("error"));
  }, []);

  // Create the map once we have a key.
  useEffect(() => {
    if (!data) return;
    if (!data.maps_api_key) { setStatus("nokey"); return; }
    let cancelled = false;
    loadGoogleMaps(data.maps_api_key)
      .then(() => {
        if (cancelled || !mapDivRef.current || !window.google) return;
        if (!mapRef.current) {
          mapRef.current = new window.google.maps.Map(mapDivRef.current, {
            center: HOUSTON, zoom: 10, mapTypeControl: false, streetViewControl: false,
          });
          iwRef.current = new window.google.maps.InfoWindow();
        }
        setStatus("ready");
      })
      .catch(() => { if (!cancelled) setStatus("error"); });
    return () => { cancelled = true; };
  }, [data]);

  // Fetch a day's estimator stops when a date is picked.
  useEffect(() => {
    if (!selectedDate) { setStops([]); return; }
    api.getLeadMap(selectedDate).then((d) => setStops(d.stops)).catch(() => {});
  }, [selectedDate]);

  // Redraw markers + route whenever data / stops / visibility change.
  useEffect(() => {
    if (status !== "ready" || !mapRef.current || !window.google || !iwRef.current) return;
    const maps = window.google.maps;
    const map = mapRef.current;
    const iw = iwRef.current;

    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];
    if (polyRef.current) { polyRef.current.setMap(null); polyRef.current = null; }

    const leadBounds = new maps.LatLngBounds();
    const stopBounds = new maps.LatLngBounds();
    let leadCount = 0, stopCount = 0;

    // Lead pins (colored circles by stage / estimate-sent).
    for (const lead of data?.leads || []) {
      const cat = lead.group === "sent" ? "sent" : catForStage(lead.stage_id);
      if (hidden.has(cat)) continue;
      const color = lead.group === "sent" ? SENT_COLOR : pinColor(lead.stage_id);
      const pos = { lat: lead.lat, lng: lead.lng };
      const marker = new maps.Marker({
        position: pos, map,
        icon: { path: maps.SymbolPath.CIRCLE, scale: 6, fillColor: color, fillOpacity: 1, strokeColor: "#ffffff", strokeWeight: 1.5 },
      });
      marker.addListener("mouseover", () => {
        iw.setContent(`<div style="font-size:12px;line-height:1.4"><strong>${esc(lead.contact_name || "Lead")}</strong><br/>${esc(lead.address || "")}</div>`);
        iw.open(map, marker);
      });
      marker.addListener("mouseout", () => iw.close());
      marker.addListener("click", () => navigate(`/leads/${lead.id}`));
      markersRef.current.push(marker);
      leadBounds.extend(pos); leadCount++;
    }

    // Estimator stops — red numbered pins + the day's route.
    if (!hidden.has("stops") && stops.length) {
      const path: GLatLngLiteral[] = [];
      stops.forEach((s, i) => {
        if (s.lat == null || s.lng == null) return;
        const pos = { lat: s.lat, lng: s.lng };
        const marker = new maps.Marker({
          position: pos, map, zIndex: 1000,
          label: { text: String((s.visit_order || 0) + 1), color: "#ffffff", fontSize: "12px", fontWeight: "700" },
        });
        marker.addListener("mouseover", () => {
          iw.setContent(`<div style="font-size:12px;line-height:1.4"><strong>${i + 1}. ${esc(s.customer_name || "Customer")}</strong><br/>${fmtTime(s.start_time)}<br/>${esc(s.address || "")}</div>`);
          iw.open(map, marker);
        });
        marker.addListener("mouseout", () => iw.close());
        if (s.lead_id) marker.addListener("click", () => navigate(`/leads/${s.lead_id}`));
        markersRef.current.push(marker);
        path.push(pos); stopBounds.extend(pos); stopCount++;
      });
      if (path.length > 1) {
        polyRef.current = new maps.Polyline({ path, map, strokeColor: STOP_COLOR, strokeOpacity: 0.7, strokeWeight: 3 });
      }
    }

    // Fit only when the meaningful set changes (not on legend toggles): to the
    // day's route when one is selected, otherwise to all the lead pins.
    const sig = `${selectedDate}|${stops.length}|${data?.leads.length || 0}`;
    if (sig !== fitSigRef.current) {
      if (stopCount > 0) map.fitBounds(stopBounds);
      else if (leadCount > 0) map.fitBounds(leadBounds);
      fitSigRef.current = sig;
    }
  }, [status, data, stops, hidden, selectedDate, navigate]);

  // Reset the map on unmount so it rebuilds cleanly when the tab reopens.
  useEffect(() => () => {
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];
    if (polyRef.current) polyRef.current.setMap(null);
    mapRef.current = null;
    iwRef.current = null;
  }, []);

  // Legend categories present on the map right now.
  const categories = useMemo(() => {
    const present = new Map<string, { label: string; color: string }>();
    if (stops.length) present.set("stops", { label: "Estimator stop", color: STOP_COLOR });
    for (const l of data?.leads || []) {
      if (l.group === "sent") present.set("sent", { label: "Estimate Sent", color: SENT_COLOR });
      else { const k = catForStage(l.stage_id); present.set(k, STAGE_PINS[k] || STAGE_PINS[NEW_LEAD_ID]); }
    }
    return [...present.entries()].map(([key, v]) => ({ key, ...v }));
  }, [data, stops]);

  const toggleCat = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  return (
    <div className="space-y-3">
      {/* Day dropdown */}
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={selectedDate}
          onChange={(e) => setSelectedDate(e.target.value)}
          className="text-sm rounded border bg-background px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          <option value="">Pick a day to see routes</option>
          {data?.route_dates.map((rd) => (
            <option key={rd.date} value={rd.date}>{dayLabel(rd.date)} · {rd.count} stop{rd.count === 1 ? "" : "s"}</option>
          ))}
        </select>
        {selectedDate && (
          <button onClick={() => setSelectedDate("")} className="text-xs text-muted-foreground hover:text-foreground underline">Clear route</button>
        )}
        <span className="text-xs text-muted-foreground ml-auto">{data?.leads.length ?? 0} leads on map</span>
      </div>

      <div className="flex flex-col lg:flex-row gap-3">
        {/* Map + legend overlay */}
        <div className="relative flex-1">
          <div ref={mapDivRef} className="h-[68vh] w-full rounded border bg-muted/30" />

          {status === "loading" && (
            <div className="absolute inset-0 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          )}
          {status === "nokey" && (
            <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-amber-600">
              Map unavailable — set GOOGLE_MAPS_BROWSER_KEY (or GOOGLE_MAPS_API_KEY) in the backend.
            </div>
          )}
          {status === "error" && (
            <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-amber-600">
              Couldn't load the map. Check the Maps JavaScript API is enabled on the key.
            </div>
          )}

          {/* Legend — collapsible; each row toggles that pin's visibility */}
          {status === "ready" && categories.length > 0 && (
            <div className="absolute top-2 right-2 w-52 rounded-lg border bg-background/95 shadow-sm backdrop-blur">
              <button onClick={() => setLegendOpen((o) => !o)} className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold">
                <span className="flex items-center gap-1.5"><List className="h-3.5 w-3.5" /> Legend</span>
                {legendOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>
              {legendOpen && (
                <div className="px-2 pb-2 space-y-0.5 max-h-64 overflow-y-auto">
                  {categories.map((c) => {
                    const off = hidden.has(c.key);
                    return (
                      <button
                        key={c.key}
                        onClick={() => toggleCat(c.key)}
                        className={`w-full flex items-center gap-2 rounded px-1.5 py-1 text-[11px] hover:bg-muted transition-colors ${off ? "opacity-40" : ""}`}
                        title={off ? "Show" : "Hide"}
                      >
                        <span className="h-3 w-3 shrink-0 rounded-full border border-white shadow" style={{ backgroundColor: c.color }} />
                        <span className="truncate flex-1 text-left">{c.label}</span>
                        {off ? <EyeOff className="h-3 w-3 shrink-0" /> : <Eye className="h-3 w-3 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right-side stop list for the selected day */}
        {selectedDate && (
          <div className="lg:w-80 shrink-0">
            <Card>
              <CardContent className="p-3 space-y-2">
                <h3 className="text-sm font-semibold">{dayLabel(selectedDate)}</h3>
                {stops.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No estimates scheduled this day.</p>
                ) : (
                  <>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">In visiting order</p>
                    {stops.map((s, i) => (
                      <div key={s.lead_id || i} className="flex items-start gap-2 rounded border bg-muted/30 p-2">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-600 text-[11px] font-semibold text-white">{(s.visit_order || 0) + 1}</span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            {s.lead_id ? (
                              <button onClick={() => navigate(`/leads/${s.lead_id}`)} className="font-medium text-sm text-primary hover:underline truncate text-left">{s.customer_name || "Customer"}</button>
                            ) : (
                              <span className="font-medium text-sm truncate">{s.customer_name || "Customer"}</span>
                            )}
                            <span className="text-xs text-muted-foreground shrink-0 flex items-center gap-1"><Clock className="h-3 w-3" /> {fmtTime(s.start_time)}</span>
                          </div>
                          {s.address && (
                            <a href={`https://maps.google.com/?q=${encodeURIComponent(s.address)}`} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline flex items-start gap-1 mt-0.5">
                              <MapPin className="h-3 w-3 mt-0.5 shrink-0" /> <span className="truncate">{s.address}</span>
                            </a>
                          )}
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
