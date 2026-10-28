// Marketing (Alan, 2026-10-28): the Meta ads page and the Social media
// library in one tab. Each person sees the sections they're allowed: the ads
// (spend, leads, cost per customer) are owner-only; the content library is
// for whoever has the social_media permission, including the editor, whose
// whole dashboard is this one section. /social still opens here, on Social
// media, so the editor's landing page and old links keep working.
import { useNavigate, useSearchParams } from "react-router-dom";
import { Clapperboard, Megaphone } from "lucide-react";
import MetaAds from "@/pages/MetaAds";
import SocialMedia from "@/pages/SocialMedia";
import { canSeeRevenue, hasPerm } from "@/lib/api";
import { HubHeader, type HubTab } from "@/components/HubHeader";

type Tab = "ads" | "social";
const ALL: (HubTab<Tab> & { can: () => boolean })[] = [
  { key: "ads", label: "Meta ads", icon: Megaphone, hint: "What each campaign, ad set and ad spends, and what a lead and a customer cost", can: canSeeRevenue },
  { key: "social", label: "Social media", icon: Clapperboard, hint: "Raw photos and videos from jobs, tagged to the customer", can: () => hasPerm("social_media") },
];
const NOTE: Record<Tab, string> = {
  ads: "Spend, leads and cost per customer, straight from the ad account · owner-only",
  social: "Raw photos and videos from jobs, kept at the quality they were shot · tag each one to the customer",
};

/** `forced`: /social opens the hub on Social media. */
export default function Marketing({ forced }: { forced?: Tab } = {}) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const tabs = ALL.filter((t) => t.can());
  const asked = params.get("tab");
  const tab: Tab = forced && tabs.some((t) => t.key === forced) ? forced
    : tabs.some((t) => t.key === asked) ? (asked as Tab) : (tabs[0]?.key ?? "social");
  const pick = (k: Tab) => {
    if (forced) { navigate(`/marketing?tab=${k}`); return; }
    setParams((p) => { const n = new URLSearchParams(p); n.set("tab", k); return n; }, { replace: true });
  };
  if (!tabs.length) return null;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
      <HubHeader icon={Megaphone} title="Marketing"
        subtitle="The ads and the content behind them, in one place."
        tabs={tabs} tab={tab} onTab={pick} note={NOTE[tab]} />
      {tab === "ads" ? <MetaAds embedded /> : null}
      {tab === "social" ? <SocialMedia embedded /> : null}
    </div>
  );
}
