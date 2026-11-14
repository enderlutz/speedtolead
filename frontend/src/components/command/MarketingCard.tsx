// 5. Marketing: Facebook spend against what the leads actually did. A number
// we can't work out says so instead of showing a made-up one.
import { NotTracked } from "./ui";
import { money } from "./format";
import type { Marketing } from "./types";

function M({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/50 p-3">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-xl font-bold tabular-nums">{value}</p>
      {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export default function MarketingCard({ m }: { m: Marketing }) {
  const noMeta = "Needs Meta";
  return (
    <div className="space-y-3">
      {!m.meta_connected && (
        <NotTracked>Facebook spend didn't load (Meta not connected here), so cost numbers show "—".</NotTracked>
      )}
      <div className="grid grid-cols-2 gap-2">
        <M label="Ad spend" value={money(m.spend)} hint={m.spend == null ? noMeta : undefined} />
        <M label="Leads from ads" value={m.leads} hint={m.meta_leads != null ? `Meta counts ${m.meta_leads}` : undefined} />
        <M label="Cost per lead" value={money(m.cpl)} />
        <M label="Got a price" value={m.estimates} />
        <M label="Booked" value={m.booked} hint={m.conversion_pct != null ? `${m.conversion_pct}% of ad leads` : undefined} />
        <M label="Cost per booked job" value={money(m.cost_per_booked)} />
        <M label="Booked value" value={money(m.booked_from_ads)} />
        <M label="Return on ad spend" value={m.roas != null ? `${m.roas}×` : "—"} />
      </div>
      <p className="text-sm text-muted-foreground">{m.note}</p>
    </div>
  );
}
