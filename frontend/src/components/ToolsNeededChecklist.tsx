import { useState } from "react";
import { Wrench } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────
// Tools Needed — a simple pre-job checklist the crew ticks off on the SOP
// page. This is the SOP content we're running with for now until full SOP
// templates are built out.
//
// TODO: the owner is sending the real tool list tomorrow. Drop the tools into
// TOOLS_NEEDED below and they appear automatically. While the list is empty
// the component renders nothing, so there's no empty box in production.
//
// e.g. const TOOLS_NEEDED = ["Airless sprayer", "Brushes", "Drop cloths",
//                            "Painter's tape", "Bleach", "Stain"];
// ─────────────────────────────────────────────────────────────────────────
const TOOLS_NEEDED: string[] = [];

/**
 * Per-job tools checklist. Check state is kept in localStorage keyed by jobId
 * (device-local, no backend yet) — fine for a "did I load the truck" check.
 * Lift to a backend field later if admins need to see completion.
 */
export default function ToolsNeededChecklist({ jobId }: { jobId: string }) {
  const storageKey = `tools-needed:${jobId}`;
  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") return {};
    try {
      return JSON.parse(window.localStorage.getItem(storageKey) || "{}");
    } catch {
      return {};
    }
  });

  if (TOOLS_NEEDED.length === 0) return null;

  const toggle = (tool: string) => {
    setChecked((prev) => {
      const next = { ...prev, [tool]: !prev[tool] };
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* ignore storage failures */
      }
      return next;
    });
  };

  const done = TOOLS_NEEDED.filter((t) => checked[t]).length;

  return (
    <div className="border rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Wrench className="h-4 w-4 text-primary" /> Tools Needed
        </h3>
        <span className="text-[11px] text-muted-foreground">{done}/{TOOLS_NEEDED.length}</span>
      </div>
      <div className="space-y-1">
        {TOOLS_NEEDED.map((tool) => (
          <label key={tool} className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={!!checked[tool]}
              onChange={() => toggle(tool)}
              className="h-4 w-4"
            />
            <span className={checked[tool] ? "line-through text-muted-foreground" : ""}>{tool}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
