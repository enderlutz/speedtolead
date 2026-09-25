import { ExternalLink } from "lucide-react";
import type { ResolvedJob } from "./useJobs";
import type { Site } from "./encoding";
import { REVIEW_LINK, REVIEW_REQUEST_TEXT } from "./useJobs";

// Composition order is fixed — spec Section 5:
// title, meta line, warn block, address, address note, fields, tz warning,
// notes (verbatim), calendar link. The warn block sits right after the meta
// line because it's usually the reason the operator opened the popup at all
// (Section 5.1) — not a footnote.

function isExclusionRow(key: string): boolean {
  const k = key.toUpperCase();
  return k.includes("DO NOT") || k.includes("EXCLU") || k.startsWith("GO-BACK");
}

export function JobPopup({
  job,
  onMarkComplete,
  onArchive,
  onUnstar,
  onReopen,
}: {
  job: ResolvedJob;
  onMarkComplete: (id: string) => void;
  onArchive: (id: string) => void;
  onUnstar: (id: string) => void;
  onReopen: (id: string) => void;
}) {
  return (
    <div style={{ fontSize: 12.5, lineHeight: 1.45, maxWidth: 320 }}>
      <div style={{ fontWeight: 700, fontSize: 14.5, marginBottom: 2 }}>{job.title}</div>
      <div style={{ color: "#555", marginBottom: 6 }}>
        {job.biz} · {job.dayLabel} · {job.time} · <strong>{job.price}</strong>
      </div>

      {job.warn && (
        <div
          style={{
            background: "#fdeceb",
            border: "1px solid #e0433b",
            color: "#7a1c17",
            borderRadius: 6,
            padding: "6px 8px",
            marginBottom: 8,
            fontWeight: 600,
          }}
        >
          ⚠ {job.warn}
        </div>
      )}

      <div style={{ marginBottom: 2 }}>{job.addr}</div>
      {job.addrNote && <div style={{ color: "#777", fontSize: 11, marginBottom: 6 }}>{job.addrNote}</div>}

      {job.fields.map(([k, v], i) => {
        const exclusion = isExclusionRow(k);
        return (
          <div
            key={i}
            style={{
              marginBottom: 3,
              fontWeight: exclusion ? 700 : 400,
              color: exclusion ? "#7a1c17" : undefined,
              background: exclusion ? "#fdeceb" : undefined,
              padding: exclusion ? "2px 4px" : undefined,
              borderRadius: exclusion ? 4 : undefined,
            }}
          >
            <span style={{ color: exclusion ? "#7a1c17" : "#666" }}>{k}:</span> {v}
          </div>
        );
      })}

      {job.tzWarn && (
        <div style={{ color: "#b45309", fontSize: 11, marginTop: 6 }}>
          ⏱ Source calendar invite carries a corrupted timezone — time shown is corrected to America/Chicago.
        </div>
      )}

      {job.notes && (
        <div
          style={{
            marginTop: 8,
            padding: 6,
            background: "#f5f5f5",
            borderRadius: 6,
            maxHeight: 120,
            overflowY: "auto",
            whiteSpace: "pre-wrap",
            fontFamily: "ui-monospace, monospace",
            fontSize: 11,
            color: "#444",
          }}
        >
          {job.notes}
        </div>
      )}

      {job.link && (
        <a href={job.link} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 4, marginTop: 8, fontSize: 11 }}>
          Calendar event <ExternalLink size={11} />
        </a>
      )}

      <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
        {!job.resolvedDone && (
          <button onClick={() => onMarkComplete(job.id)} style={btnStyle}>
            Mark complete
          </button>
        )}
        {job.resolvedDone && !job.resolvedArchived && (
          <>
            <button onClick={() => onUnstar(job.id)} style={btnStyle}>
              Unstar
            </button>
            <button onClick={() => onArchive(job.id)} style={{ ...btnStyle, background: "#1d7a3f", color: "#fff" }}>
              Archive
            </button>
          </>
        )}
        {job.resolvedArchived && (
          <button onClick={() => onReopen(job.id)} style={btnStyle}>
            Reopen
          </button>
        )}
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  fontSize: 11,
  padding: "4px 8px",
  borderRadius: 5,
  border: "1px solid #ccc",
  background: "#fff",
  cursor: "pointer",
};

export function SitePopup({ site }: { site: Site }) {
  return (
    <div style={{ fontSize: 12.5, lineHeight: 1.45, maxWidth: 300 }}>
      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2 }}>{site.n}</div>
      <div style={{ color: "#555", marginBottom: 6 }}>{site.addr}</div>
      {/* Site notes are hand-authored, never ingested from a calendar — this
          is the one place raw HTML is allowed (spec Section 3). */}
      <div dangerouslySetInnerHTML={{ __html: site.note }} />
      {site.kind === "closed" && (
        <div style={{ marginTop: 6, fontSize: 11, color: "#9aa1af", fontStyle: "italic" }}>
          Closed — kept on the map so nobody is sent here by habit.
        </div>
      )}
    </div>
  );
}

// The review-request text shown when an archive attempt is stopped by the
// gate (Section 7.3). Verbatim, owner's own wording — rewritten twice during
// development and rejected both times, so don't touch it.
export function ReviewLinkPrompt({ onClose }: { onClose: () => void }) {
  return (
    <div style={{ fontSize: 12.5, lineHeight: 1.5, maxWidth: 320 }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>Send this before archiving</div>
      <p style={{ marginBottom: 8 }}>{REVIEW_REQUEST_TEXT}</p>
      <a href={REVIEW_LINK} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>
        {REVIEW_LINK}
      </a>
      <div style={{ marginTop: 10 }}>
        <button onClick={onClose} style={btnStyle}>
          Got it
        </button>
      </div>
    </div>
  );
}
