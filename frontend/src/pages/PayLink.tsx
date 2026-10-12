// /pay/{token}: the page a customer lands on from a payment text. It shows
// what they're paying and one button, which asks the backend for a fresh
// Stripe Checkout session and sends them to Stripe. Nothing about the card
// ever touches this page. (Alan's post-payment spec, 2026-10-10.)
//
// Raw fetch on purpose: the dashboard's API client bounces a 401 to the
// staff login, which is the wrong place to drop a customer.
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Lock, Phone } from "lucide-react";
import { formatCurrency } from "@/lib/utils";

const BASE = import.meta.env.VITE_API_URL || "";
const GOLD = "#C9972F";
const PHONE = "346-589-7877";

type Info = {
  kind: string; label: string; amount: number; description: string; status: string;
  first_name: string; address: string; configured: boolean;
};

export default function PayLink() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<Info | "loading" | "gone">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // A deposit link lives 7 days; the API says so with a 410 and a sentence.
  const [goneWhy, setGoneWhy] = useState("");

  useEffect(() => {
    let alive = true;
    document.title = "Pay Sterling Fence Staining";
    (async () => {
      try {
        const r = await fetch(`${BASE}/api/pay/${encodeURIComponent(token || "")}`);
        if (!r.ok) {
          if (r.status === 410) {
            const why = (await r.json().catch(() => ({}))) as { detail?: string };
            if (alive) setGoneWhy(why.detail || "");
          }
          throw new Error(String(r.status));
        }
        const data = (await r.json()) as Info;
        if (!alive) return;
        if (data.status === "paid") {
          window.location.replace(`/after/${token}`);
          return;
        }
        setInfo(data);
      } catch {
        if (alive) setInfo("gone");
      }
    })();
    return () => { alive = false; };
  }, [token]);

  const pay = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`${BASE}/api/pay/${encodeURIComponent(token || "")}/session`, { method: "POST" });
      const data = (await r.json()) as { url?: string; detail?: string };
      if (!r.ok || !data.url) throw new Error(data.detail || "Stripe couldn't start the payment.");
      window.location.assign(data.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
      setBusy(false);
    }
  };

  if (info === "gone") {
    return (
      <Shell>
        <h1 className="font-heading text-3xl font-bold leading-tight">{goneWhy ? "This link has expired." : "This link isn't active."}</h1>
        <p className="mt-2 text-[17px] text-[#15130F]/80">{goneWhy || "If you were expecting to pay, call or text us and we'll send a fresh one."}</p>
        <Contact />
      </Shell>
    );
  }
  if (info === "loading") {
    return <Shell><p className="text-[17px] font-semibold text-[#15130F]/75">One moment…</p></Shell>;
  }
  const deposit = info.kind === "deposit";
  return (
    <Shell>
      <p className="text-[13px] font-bold uppercase tracking-[0.2em]" style={{ color: "#8C6224" }}>{info.label}</p>
      <h1 className="mt-1 font-heading text-3xl font-bold leading-tight">
        {info.first_name ? `Hi ${info.first_name}, ` : ""}{deposit ? "this books your spot." : "here's what's due."}
      </h1>
      <div className="mt-4 rounded-2xl bg-white p-4 ring-1 ring-[#15130F]/10">
        <p className="text-[15px] text-[#15130F]/75">{deposit ? "Deposit today" : "Due today"}</p>
        <p className="font-heading text-5xl font-bold leading-none tabular-nums">{formatCurrency(info.amount)}</p>
        {info.address ? <p className="mt-3 text-[15px] text-[#15130F]/80">{info.address}</p> : null}
        {info.description ? <p className="mt-1 text-[15px] text-[#15130F]/80">{info.description}</p> : null}
      </div>
      {info.configured ? (
        <>
          <button type="button" onClick={pay} disabled={busy}
            className="mt-4 flex h-14 w-full items-center justify-center gap-2 rounded-xl text-[18px] font-bold text-[#15130F] shadow-lg active:scale-[0.98] disabled:opacity-60" style={{ background: GOLD }}>
            <Lock className="h-5 w-5" /> {busy ? "Opening secure checkout…" : `Pay ${formatCurrency(info.amount)}`}
          </button>
          <p className="mt-2 text-center text-[14px] text-[#15130F]/75">
            {deposit ? "Card, Apple Pay or Google Pay. The deposit is not refundable once your dates are set." : "Card, Apple Pay, Google Pay, or pay over time with Klarna or Affirm. You pick on the next screen."}
          </p>
          {error ? <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-[15px] font-semibold text-rose-800">{error}</p> : null}
          <p className="mt-6 flex items-center justify-center gap-2 text-[13px] text-[#15130F]/65"><Lock className="h-3.5 w-3.5" /> Secure checkout by Stripe</p>
        </>
      ) : (
        <p className="mt-4 rounded-xl bg-[#FFF7E6] px-3 py-3 text-[15px] ring-1 ring-[#C9972F]/50">Online payments are being set up. Call or text us and we'll take care of it.</p>
      )}
      <Contact />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#F8F3E7] text-[#15130F]">
      <div className="mx-auto max-w-md">
        <div className="flex items-center justify-between bg-[#15130F] px-4 py-3">
          <img src="/sterling-logo-dark.png" alt="Sterling Fence Staining" className="h-8 w-auto" draggable={false} />
          <a href={`tel:+1${PHONE.replace(/-/g, "")}`} className="inline-flex h-10 items-center gap-2 rounded-full px-4 text-[15px] font-bold text-[#15130F]" style={{ background: GOLD }}>
            <Phone className="h-4 w-4" /> Call
          </a>
        </div>
        <div className="px-5 py-6">{children}</div>
      </div>
    </div>
  );
}

function Contact() {
  return (
    <p className="mt-6 text-center text-[15px] text-[#15130F]/75">
      Questions? Call or text <a href={`tel:+1${PHONE.replace(/-/g, "")}`} className="font-bold text-[#15130F] underline underline-offset-2">{PHONE}</a>
    </p>
  );
}
