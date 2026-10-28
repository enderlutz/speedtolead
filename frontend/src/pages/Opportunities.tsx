// Opportunities (Alan, 2026-10-28): the two Sterling lead boards in one tab.
// "There's no point in having Sterling Leads A and Sterling Leads B. It's
// just too much extra." Both boards read the same Sterling GHL account; they
// are two pipelines inside it, not two businesses (A&T's has its own GHL
// account and only feeds the A&T Contacts tab):
//   A  "FENCE STAINING NEW AUTOMATION FLOW", where new leads land
//   B  "STERLING", the older pipeline, far quieter
// Both boards at once is the first view, then each on its own. The old
// addresses (/leads, /leads-b) open the hub on that board so every link
// still works. The boards themselves are untouched: same cards, drag, search,
// Queue and Lead Map.
import { useNavigate, useSearchParams } from "react-router-dom";
import { Columns3, KanbanSquare, Rows3 } from "lucide-react";
import LeadsV2 from "@/pages/LeadsV2";
import LeadsB from "@/pages/LeadsB";
import { HubHeader, type HubTab } from "@/components/HubHeader";

type Tab = "both" | "a" | "b";
const TABS: HubTab<Tab>[] = [
  { key: "both", label: "Both boards", icon: Rows3, hint: "Pipeline A on top, pipeline B under it" },
  { key: "a", label: "Fence pipeline (A)", icon: KanbanSquare, hint: "FENCE STAINING NEW AUTOMATION FLOW — where new leads land" },
  { key: "b", label: "Sterling pipeline (B)", icon: Columns3, hint: "The STERLING pipeline — the older board" },
];
const NOTE: Record<Tab, string> = {
  both: "Two pipelines in the one Sterling GHL account · A is where new leads land, B is the older STERLING pipeline",
  a: "The FENCE STAINING NEW AUTOMATION FLOW pipeline · new leads land here · drag a card to move its stage in GHL",
  b: "The STERLING pipeline, the older board · drag a card to move its stage in GHL",
};

/** `forced`: /leads and /leads-b open the hub on that board. */
export default function Opportunities({ forced }: { forced?: Tab } = {}) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const asked = params.get("tab");
  const tab: Tab = forced ?? (TABS.some((t) => t.key === asked) ? (asked as Tab) : "both");
  const pick = (k: Tab) => {
    if (forced) { navigate(`/opportunities?tab=${k}`); return; }
    setParams((p) => { const n = new URLSearchParams(p); n.set("tab", k); return n; }, { replace: true });
  };

  return (
    <div className="space-y-4 p-4 md:p-6">
      <HubHeader icon={KanbanSquare} title="Opportunities"
        subtitle="Every open lead on its stage, both Sterling pipelines. Drag a card to move it; the change goes to GHL."
        tabs={TABS} tab={tab} onTab={pick} note={NOTE[tab]} />
      {tab === "both" ? (
        <div className="space-y-8">
          <LeadsV2 embedded />
          <div className="border-t" />
          <LeadsB embedded />
        </div>
      ) : null}
      {tab === "a" ? <LeadsV2 embedded /> : null}
      {tab === "b" ? <LeadsB embedded /> : null}
    </div>
  );
}
