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
  options?: { id: string; label: string; note: string; feet: number; sides: string[];
    tiers: { essential: number; signature: number; legacy: number } | null;
    regular: { essential: number; signature: number; legacy: number } | null; has_scope: boolean }[];
};

async function door(token: string, which: "reserve" | "finance", tier: PkgKey, optionId?: string): Promise<string> {
  const r = await fetch(`${BASE}/api/public/proposal/${encodeURIComponent(token)}/${which}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tier, option_id: optionId || "" }),
  });
  const data = (await r.json().catch(() => ({}))) as { url?: string; detail?: string };
  if (!r.ok || !data.url) throw new Error(data.detail || "Couldn't open the payment page. Call or text us.");
  return data.url;
}

export default function ProposalLive() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<{ live: Live } | "loading" | "pdf" | "error">("loading");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // The dashboard opens this with ?preview=1 so staff never count as a view.
        const preview = new URLSearchParams(window.location.search).get("preview") === "1" ? "?preview=1" : "";
        const r = await fetch(`${BASE}/api/public/proposal/${encodeURIComponent(token || "")}/live${preview}`);
        // 404 = not an interactive proposal: an older PDF one, shown as before.
        if (r.status === 404) { if (alive) setState("pdf"); return; }
        if (!r.ok) throw new Error(String(r.status));
        const p = (await r.json()) as Payload;
        if (!alive) return;
        setState({
          live: {
            name: p.name, address: p.address, feet: p.feet, sides: sidesInWords(p.sides), tiers: p.tiers,
            scopeUrl: p.has_scope ? `${BASE}/api/public/proposal/${encodeURIComponent(token || "")}/scope` : null,
            sentOn: p.sent_on, number: p.number, goodThrough: p.good_through, priceDays: p.price_days, expired: p.expired, regular: p.regular,
            reserved: p.reserved ? { kind: p.reserved.kind, tier: p.reserved.tier as PkgKey, afterUrl: p.reserved.after_url, optionId: (p.reserved as { option_id?: string }).option_id || "" } : null,
            // Each option's own frozen prices and drawing (one proposal, several prices).
            options: (p.options ?? []).map((o) => ({
              id: o.id, label: o.label, note: o.note, feet: o.feet, sides: sidesInWords(o.sides), tiers: o.tiers, regular: o.regular,
              scopeUrl: o.has_scope ? `${BASE}/api/public/proposal/${encodeURIComponent(token || "")}/scope?option=${encodeURIComponent(o.id)}` : null,
            })),
          },
        });
      } catch {
        // No PDF fallback for an interactive proposal (Alan, 2026-10-18).
        if (alive) setState("error");
      }
    })();
    return () => { alive = false; };
  }, [token]);

  useEffect(() => {
    if (state !== "pdf") document.title = "Your fence restoration plan · Sterling Fence Staining";
  }, [state]);

  if (state === "pdf") return <ProposalView />;
  if (state === "error") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-[#F8F3E7] p-6 text-center text-[#15130F]">
        <p className="text-[19px] font-semibold">Your plan didn't open just now.</p>
        <p className="max-w-sm text-[15px] text-[#15130F]/70">Check your signal and tap below to try again, or text us and we'll send it right over.</p>
        <button type="button" onClick={() => window.location.reload()}
                className="mt-2 rounded-full bg-[#15130F] px-6 py-3 text-[15px] font-semibold text-[#F8F3E7]">Try again</button>
      </div>
    );
  }
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
      // The dashboard's "View proposal" opens ?preview=1: staff get buttons
      // to see the after-payment screens. Customers never have the flag.
      staffPeek={new URLSearchParams(window.location.search).get("preview") === "1"}
      dressed={state.live}
      doors={{
        reserve: (tier, optionId) => door(t, "reserve", tier, optionId),
        finance: (tier, optionId) => door(t, "finance", tier, optionId),
        // Fire and forget; keepalive so the report survives the jump into
        // Messages, which can unload the page.
        shared: (how) => { void fetch(`${BASE}/api/public/proposal/${encodeURIComponent(t)}/shared`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ how }), keepalive: true,
        }).catch(() => {}); },
      }}
    />
  );
}
