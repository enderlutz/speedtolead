// /after/{token}: where Stripe sends the customer after they pay. It asks the
// backend whether the link is paid (the backend checks the session itself
// if the webhook is a few seconds behind), then runs Flow A or Flow B and
// saves every tap as it happens. (Alan's post-payment spec, 2026-10-10.)
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { AfterPay, type PayFlow, type PayMethod } from "@/components/proposal/AfterPay";

import { API_BASE as BASE } from "@/lib/apiBase";

type After = {
  paid: boolean; kind: string; flow: "A" | "B"; amount: number; method: string; paid_total: number;
  first_name: string; address: string; answers: Record<string, unknown>;
  ask_review?: boolean; referral_url?: string;
};

export default function AfterPayPage() {
  const { token } = useParams<{ token: string }>();
  const [params] = useSearchParams();
  const [after, setAfter] = useState<After | null>(null);
  const [state, setState] = useState<"checking" | "ready" | "unpaid" | "gone">("checking");
  const tries = useRef(0);

  useEffect(() => {
    let alive = true;
    document.title = "Thank you · Sterling Fence Staining";
    const s = params.get("s") || "";
    const check = async () => {
      try {
        // ?preview=1: staff looking, never counted as the customer's visit.
        const qs = new URLSearchParams();
        if (s) qs.set("s", s);
        if (params.get("preview") === "1") qs.set("preview", "1");
        const r = await fetch(`${BASE}/api/pay/${encodeURIComponent(token || "")}/after${qs.toString() ? `?${qs}` : ""}`);
        if (r.status === 404) { if (alive) setState("gone"); return; }
        const data = (await r.json()) as After;
        if (!alive) return;
        if (data.paid) { setAfter(data); setState("ready"); return; }
        tries.current += 1;
        if (tries.current < 8) setTimeout(check, 1500);
        else setState("unpaid");
      } catch {
        tries.current += 1;
        if (alive && tries.current < 8) setTimeout(check, 1500);
        else if (alive) setState("unpaid");
      }
    };
    void check();
    return () => { alive = false; };
  }, [token, params]);

  // How far they got, for the lead page ("got to 3 of 6"). Fire and forget.
  const reached = useCallback((step: number, of: number, screen: string) => {
    if (params.get("preview") === "1") return;
    void fetch(`${BASE}/api/pay/${encodeURIComponent(token || "")}/reached`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step, of, screen }), keepalive: true,
    }).catch(() => {});
  }, [token, params]);

  const save = (field: string, value: unknown) => {
    void fetch(`${BASE}/api/pay/${encodeURIComponent(token || "")}/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ field, value }),
    }).catch(() => { /* saved on the next tap */ });
  };

  if (state === "ready" && after) {
    // The backend decides which screens a payment gets: B is the job-done set
    // (balance, job done, extra work paid at the end), A is before the job.
    const flow: PayFlow = after.flow === "B" ? "balance" : after.kind === "deposit" ? "deposit" : "full";
    const method: PayMethod = after.method === "klarna" || after.method === "affirm" ? after.method : "card";
    return (
      <AfterPay
        page
        flow={flow}
        method={method}
        paidUpFront={after.kind === "done"}
        amount={after.amount}
        firstName={after.first_name || "there"}
        address={after.address}
        pkgName=""
        feet={0}
        total={after.flow === "B" ? after.paid_total : 0}
        repairs={0}
        initial={after.answers}
        onAnswer={save}
        receiptUrl={after.kind === "done" ? undefined : `/receipt/${token}`}
        onScreen={reached}
        askReview={after.ask_review !== false}
        referralUrl={after.referral_url || undefined}
        onReferFriend={after.referral_url ? async (name, phone) => {
          const code = (after.referral_url || "").split("/").pop() || "";
          const r = await fetch(`${BASE}/api/public/referral/${encodeURIComponent(code)}/claim`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, phone, by_referrer: true, ok_to_text: true }),
          });
          const d = (await r.json().catch(() => ({}))) as { detail?: string };
          if (!r.ok) throw new Error(d.detail || "That didn't go through. Try again.");
        } : undefined}
      />
    );
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F8F3E7] p-6 text-center text-[#15130F]">
      <div className="max-w-sm">
        {state === "gone" ? (
          <>
            <p className="font-heading text-2xl font-bold">This link isn't active.</p>
            <p className="mt-2 text-[15px] text-[#15130F]/75">Call or text Sterling Fence Staining at 346-589-7877.</p>
          </>
        ) : state === "unpaid" ? (
          <>
            <p className="font-heading text-2xl font-bold">We haven't seen your payment yet.</p>
            <p className="mt-2 text-[15px] text-[#15130F]/75">If you just paid, give it a minute and refresh. If not, your payment link still works.</p>
            <button type="button" onClick={() => window.location.reload()} className="mt-4 h-12 w-full rounded-xl bg-[#15130F] text-[16px] font-bold text-[#E3BE63]">Check again</button>
          </>
        ) : (
          <p className="text-[17px] font-semibold text-[#15130F]/75">Confirming your payment…</p>
        )}
      </div>
    </div>
  );
}
