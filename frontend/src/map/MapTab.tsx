import { useCallback, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { AlertTriangle, MapPin, Wrench, CalendarClock } from "lucide-react";
import { useJobs, type ResolvedJob } from "./useJobs";
import { colourFor, sizeOf, zIndexOffsetFor, ringColorFor, hasCoords, type Site } from "./encoding";
import { JobPopup, SitePopup, ReviewLinkPrompt } from "./popup";
import { toast } from "sonner";

const HOUSTON: [number, number] = [29.7604, -95.3698];

// A 5-point star, drawn once and reused at whatever pixel size a job needs.
const STAR_POINTS = "50,5 61,38 97,38 68,59 79,91 50,71 21,91 32,59 3,38 39,38";

function jobIconHtml(job: ResolvedJob): string {
  const size = sizeOf(job);
  const color = colourFor(job);
  const ring = ringColorFor(job);
  const dashed = !!job.approx;
  const ringStyle = ring ? `box-shadow: 0 0 0 3px ${ring};` : "";
  const borderStyle = dashed ? `border: 2px dashed #fff;` : `border: 1.5px solid #fff;`;

  if (job.resolvedDone) {
    // 4.3 — a finished job is a star, 1.5x the circle diameter, same colour.
    const starSize = size * 1.5;
    return `
      <div style="width:${starSize}px;height:${starSize}px;${ringStyle}border-radius:${ring ? "50%" : "0"};display:flex;align-items:center;justify-content:center;">
        <svg width="${starSize}" height="${starSize}" viewBox="0 0 100 100">
          <polygon points="${STAR_POINTS}" fill="${color}" stroke="#fff" stroke-width="3"/>
        </svg>
      </div>`;
  }
  return `
    <div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};${borderStyle}${ringStyle}box-sizing:border-box;"></div>`;
}

function jobIcon(job: ResolvedJob): L.DivIcon {
  const size = job.resolvedDone ? sizeOf(job) * 1.5 : sizeOf(job);
  return L.divIcon({
    html: jobIconHtml(job),
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// 4.6 — sites render as rounded squares, not circles, at a fixed 24px, always
// above jobs. Shape (not colour) carries the job/not-a-job distinction so it
// survives colour-blindness and greyscale printing.
function siteIcon(site: Site): L.DivIcon {
  const closed = site.kind === "closed";
  const bg = closed ? "#9aa1af" : site.c;
  const html = `
    <div style="width:22px;height:22px;border-radius:6px;background:${bg};border:2px solid #fff;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,0.4);${closed ? "opacity:0.75;" : ""}">
      ${closed ? '<span style="color:#fff;font-weight:900;font-size:14px;line-height:1;">×</span>' : ""}
    </div>`;
  return L.divIcon({ html, className: "", iconSize: [24, 24], iconAnchor: [12, 12] });
}

function MapController({ onReady }: { onReady: (map: L.Map) => void }) {
  const map = useMap();
  useMemo(() => onReady(map), [map, onReady]);
  return null;
}

export default function MapTab() {
  const { jobs, sites, grouped, stats, markComplete, unstarJob, reopenJob, archiveJob } = useJobs();
  const [legendOpen, setLegendOpen] = useState(true);
  const mapRef = useRef<L.Map | null>(null);
  const markerRefs = useRef<Record<string, L.Marker>>({});
  const [expandedNullRow, setExpandedNullRow] = useState<string | null>(null);

  const handleFly = useCallback((job: ResolvedJob) => {
    if (!hasCoords(job)) {
      setExpandedNullRow((prev) => (prev === job.id ? null : job.id));
      return;
    }
    const map = mapRef.current;
    if (!map) return;
    map.flyTo([job.lat as number, job.lng as number], 14);
    window.setTimeout(() => markerRefs.current[job.id]?.openPopup(), 300);
  }, []);

  const handleArchive = useCallback(
    (id: string) => {
      const result = archiveJob(id);
      if (result === "archived") {
        mapRef.current?.closePopup();
        toast.success("Archived");
      } else {
        toast.custom((id) => <ReviewLinkPrompt onClose={() => toast.dismiss(id)} />, { duration: 15000 });
      }
    },
    [archiveJob]
  );

  return (
    <div className="flex flex-col lg:flex-row gap-3 h-[calc(100vh-7rem)]">
      {/* Sidebar */}
      <div className="lg:w-80 shrink-0 flex flex-col gap-3 overflow-y-auto pr-1">
        <div>
          <h2 className="text-base font-semibold">Sterling / A&T Job Map</h2>
          <p className="text-xs text-muted-foreground">Every colour, ring and dashed line here means one specific thing — see the legend.</p>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <StatTile icon={Wrench} label="Jobs" value={stats.jobs} />
          <StatTile icon={AlertTriangle} label="Go-backs" value={stats.goBacks} accent="#e53935" />
          <StatTile icon={CalendarClock} label="Booked" value={stats.booked} />
        </div>

        <div className="flex-1 space-y-3">
          {grouped.map((g) => (
            <div key={g.day}>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">{g.dayLabel}</div>
              <div className="space-y-1">
                {g.jobs.map((job) => (
                  <div key={job.id}>
                    <button
                      onClick={() => handleFly(job)}
                      className="w-full flex items-center gap-2 rounded px-1.5 py-1 hover:bg-muted transition-colors text-left"
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full border border-white"
                        style={{
                          backgroundColor: colourFor(job),
                          boxShadow: ringColorFor(job) ? `0 0 0 2px ${ringColorFor(job)}` : undefined,
                        }}
                      />
                      {job.resolvedDone && <span className="text-[10px]">★</span>}
                      <span className="flex-1 truncate text-[12px]">{job.name}</span>
                      <span className="text-[11px] font-medium tabular-nums shrink-0">{job.price}</span>
                    </button>
                    {expandedNullRow === job.id && !hasCoords(job) && (
                      <div className="ml-4 mb-1 rounded bg-amber-50 border border-amber-200 px-2 py-1 text-[10.5px] text-amber-800">
                        No pin — coordinate could not be confirmed.
                        {job.addrNote ? ` ${job.addrNote}` : ""}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Legend */}
        <div className="border-t pt-2">
          <button onClick={() => setLegendOpen((o) => !o)} className="text-xs font-semibold mb-1.5">
            Legend {legendOpen ? "▾" : "▸"}
          </button>
          {legendOpen && (
            <div className="space-y-1 text-[10.5px] text-muted-foreground">
              <LegendRow color="#F6BF26" label="Sterling Fence Staining" />
              <LegendRow color="#D50000" label="A&T's Pressure Washing" />
              <LegendRow color="#039BE5" label="Unassigned (data-quality flag)" />
              <div className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: "#e53935" }} /> Red ring — go-back we owe</div>
              <div className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: "#1e88e5" }} /> Blue ring — go-back on hold (waiting on customer)</div>
              <div className="flex items-center gap-1.5"><span>★</span> Finished job</div>
              <div className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full border-2 border-dashed border-foreground/50" /> Address not confirmed — don't navigate by this pin</div>
              <div className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-foreground/60" /> Supply stop / storage (square, not circle)</div>
            </div>
          )}
        </div>
      </div>

      {/* Map */}
      <div className="flex-1 rounded border overflow-hidden">
        <MapContainer center={HOUSTON} zoom={10} style={{ height: "100%", width: "100%" }}>
          <MapController onReady={(m) => (mapRef.current = m)} />
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {jobs.filter(hasCoords).map((job) => (
            <Marker
              key={job.id}
              position={[job.lat as number, job.lng as number]}
              icon={jobIcon(job)}
              zIndexOffset={zIndexOffsetFor(job)}
              ref={(m) => {
                if (m) markerRefs.current[job.id] = m;
              }}
            >
              <Popup maxWidth={340} autoPan>
                <JobPopup job={job} onMarkComplete={markComplete} onArchive={handleArchive} onUnstar={unstarJob} onReopen={reopenJob} />
              </Popup>
            </Marker>
          ))}
          {sites.filter(hasCoords).map((site) => (
            <Marker key={site.id} position={[site.lat as number, site.lng as number]} icon={siteIcon(site)} zIndexOffset={2000}>
              <Popup maxWidth={300}>
                <SitePopup site={site} />
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>
    </div>
  );
}

function StatTile({ icon: Icon, label, value, accent }: { icon: typeof MapPin; label: string; value: number; accent?: string }) {
  return (
    <div className="rounded border p-2 text-center">
      <Icon className="h-3.5 w-3.5 mx-auto mb-1" style={{ color: accent }} />
      <div className="text-lg font-semibold tabular-nums" style={{ color: accent }}>
        {value}
      </div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}

function LegendRow({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="h-2.5 w-2.5 rounded-full border border-white shadow" style={{ backgroundColor: color }} />
      {label}
    </div>
  );
}
