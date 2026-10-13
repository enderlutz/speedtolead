// The customer's proposal at /p/<token>. Asks the backend for the
// interactive version first; a proposal that wasn't switched to it (or any
// link sent before the switch existed) gets the PDF page exactly as before.
//
// The two doors on the page are real here: Reserve makes the $250 deposit
// link for the package they picked and sends them to Stripe's Checkout;
// Finance makes the full-price link Stripe shows Klarna and Affirm on. The
// backend records the pick and texts Alan; nothing else happens until the
// money lands (notes: "Payment rules Alan settled on 2026-10-11").
//
// Raw fetch on purpose: the dashboard's API client bounces a 401 to the
// staff login, the wrong place to drop a customer.
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import ProposalMockup, { type Live, type PkgKey } from "@/pages/ProposalMockup";
import ProposalView from "@/pages/ProposalView";
import { sidesInWords } from "@/lib/fenceSides";

const BASE = import.meta.env.VITE_API_URL || "";

type Payload = {
  name: string; address: string; feet: number; sides: string[];
  tiers: { essential: number; signature: number; legacy: number } | null;
  regular: { essential: number; signature: number; legacy: number } | null;
  sent_on: string; has_scope: boolean; token: string; number: string;
  good_through: string; price_days: number; expired: boolean;
  reserved: { kind: string; tier: string; paid_at: string | null; after_url: string } | null;
  open_link: { kind: string; tier: string; url: string } | null;
};

async function door(token: string, which: "reserve" | "finance", tier: PkgKey): Promise<string> {
  const r = await fetch(`${BASE}/api/public/proposal/${encodeURIComponent(token)}/${which}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tier }),
  });
  const data = (await r.json().catch(() => ({}))) as { url?: string; detail?: string };
  if (!r.ok || !data.url) throw new Error(data.detail || "Couldn't open the payment page. Call or text us.");
  return data.url;
}

export default function ProposalLive() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<{ live: Live } | "loading" | "pdf">("loading");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`${BASE}/api/public/proposal/${encodeURIComponent(token || "")}/live`);
        if (!r.ok) throw new Error(String(r.status));
        const p = (await r.json()) as Payload;
        if (!alive) return;
        setState({
          live: {
            name: p.name, address: p.address, feet: p.feet, sides: sidesInWords(p.sides), tiers: p.tiers,
            scopeUrl: p.has_scope ? `${BASE}/api/public/proposal/${encodeURIComponent(token || "")}/scope` : null,
            sentOn: p.sent_on, number: p.number, goodThrough: p.good_through, priceDays: p.price_days, expired: p.expired, regular: p.regular,
            reserved: p.reserved ? { kind: p.reserved.kind, tier: p.reserved.tier as PkgKey, afterUrl: p.reserved.after_url } : null,
          },
        });
      } catch {
        if (alive) setState("pdf");
      }
    })();
    return () => { alive = false; };
  }, [token]);

  useEffect(() => {
    if (state !== "pdf") document.title = "Your fence restoration plan · Sterling Fence Staining";
  }, [state]);

  if (state === "pdf") return <ProposalView />;
  if (state === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F8F3E7] p-6 text-center text-[#15130F]">
        <p className="text-[17px] font-semibold text-[#15130F]/75">Opening your plan…</p>
      </div>
    );
  }
  const t = token || "";
  return (
    <ProposalMockup
      preview
      dressed={state.live}
      doors={{
        reserve: (tier) => door(t, "reserve", tier),
        finance: (tier) => door(t, "finance", tier),
        // Fire and forget; keepalive so the report survives the jump into
        // Messages, which can unload the page.
        shared: (how) => { void fetch(`${BASE}/api/public/proposal/${encodeURIComponent(t)}/shared`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ how }), keepalive: true,
        }).catch(() => {}); },
      }}
    />
  );
}
