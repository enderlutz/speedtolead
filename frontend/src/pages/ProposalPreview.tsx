// A no-login link to the proposal mockup, so Alan can text it to someone
// for an opinion (2026-10-10: "create a link so I can send it to my friend…
// I want to send the one for Margarita"). The page asks the backend's
// public preview endpoint for the one lead behind the token and dresses
// the mockup in it; a token the backend doesn't know gets a plain "not
// active" page. The staff bar, the phone frame and the live-estimate
// loader stay on the dashboard's own copy at /new-proposal/mockup.
//
// Raw fetch on purpose: the dashboard's API client bounces any 401 to the
// staff login, which is the wrong place to drop a guest.
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import ProposalMockup, { type Live } from "@/pages/ProposalMockup";
import { sidesInWords } from "@/lib/fenceSides";

import { API_BASE as BASE } from "@/lib/apiBase";

type Payload = {
  name: string; address: string; feet: number; sides: string[];
  tiers: { essential: number; signature: number; legacy: number } | null;
  sent_on: string; has_scope: boolean;
};

export default function ProposalPreview() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<{ live: Live } | "loading" | "gone">("loading");
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`${BASE}/api/public/proposal-preview/${encodeURIComponent(token || "")}`);
        if (!r.ok) throw new Error(String(r.status));
        const p = (await r.json()) as Payload;
        if (!alive) return;
        setState({
          live: {
            name: p.name, address: p.address, feet: p.feet, sides: sidesInWords(p.sides), tiers: p.tiers,
            scopeUrl: p.has_scope ? `${BASE}/api/public/proposal-preview/${encodeURIComponent(token || "")}/scope` : null,
            sentOn: p.sent_on,
          },
        });
      } catch {
        if (alive) setState("gone");
      }
    })();
    return () => { alive = false; };
  }, [token]);
  useEffect(() => {
    document.title = state === "gone" ? "Sterling Fence Staining" : "Your fence restoration plan · Sterling Fence Staining";
  }, [state]);

  if (state === "gone") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F8F3E7] p-6 text-center text-[#15130F]">
        <div>
          <p className="font-heading text-2xl font-bold">This link isn't active.</p>
          <p className="mt-2 text-[15px] text-[#15130F]/75">Call or text Sterling Fence Staining at 346-589-7877.</p>
        </div>
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
  return <ProposalMockup preview dressed={state.live} />;
}
