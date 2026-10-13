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
import { TermsBody } from "@/components/proposal/TermsBody";

const BASE = import.meta.env.VITE_API_URL || "";
const GOLD = "#C9972F";
const PHONE = "346-589-7877";

export type InvoiceItem = { name: string; description: string; amount: number; discount?: number; discount_label?: string; total_discount?: boolean };

export type Info = {
  kind: string; label: string; amount: number; description: string; status: string;
  first_name: string; address: string; configured: boolean;
  items?: InvoiceItem[]; credit?: number;
  name?: string; invoice_number?: string; date?: string; financing?: boolean;
};

export default function PayLink() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<Info | "loading" | "gone">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [terms, setTerms] = useState(false);
  // A deposit link lives 7 days; the API says so with a 410 and a sentence.
  const [goneWhy, setGoneWhy] = useState("");

  useEffect(() => {
    let alive = true;
    document.title = "Pay Sterling Fence Staining";
    (async () => {
      try {
        // Staff open their own links with ?preview=1 so it never counts as the customer's view.
        const preview = new URLSearchParams(window.location.search).get("preview") === "1" ? "?preview=1" : "";
        const r = await fetch(`${BASE}/api/pay/${encodeURIComponent(token || "")}${preview}`);
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
        {info.first_name ? `Hi ${info.first_name}, ` : ""}{deposit ? "this books your spot." : info.items?.length ? "here's your invoice." : "here's what's due."}
      </h1>
      {!deposit && info.items?.length ? <InvoiceDoc info={info} /> : (
        <div className="mt-4 rounded-2xl bg-white p-4 ring-1 ring-[#15130F]/10">
          <p className="text-[15px] text-[#15130F]/75">{deposit ? "Deposit today" : "Due today"}</p>
          <p className="font-heading text-5xl font-bold leading-none tabular-nums">{formatCurrency(info.amount)}</p>
          {info.address ? <p className="mt-3 text-[15px] text-[#15130F]/80">{info.address}</p> : null}
          {info.description ? <p className="mt-1 text-[15px] text-[#15130F]/80">{info.description}</p> : null}
        </div>
      )}
      {info.configured ? (
        <>
          <button type="button" onClick={pay} disabled={busy}
            className="mt-4 flex h-14 w-full items-center justify-center gap-2 rounded-xl text-[18px] font-bold text-[#15130F] shadow-lg active:scale-[0.98] disabled:opacity-60" style={{ background: GOLD }}>
            <Lock className="h-5 w-5" /> {busy ? "Opening secure checkout…" : `Pay ${formatCurrency(info.amount)}`}
          </button>
          <p className="mt-2 text-center text-[14px] text-[#15130F]/75">
            {deposit ? "Card, Apple Pay, Google Pay, bank account or Cash App. The deposit is not refundable once your dates are set." : info.financing === false ? "Card, Apple Pay, Google Pay, bank account or Cash App. You pick on the next screen." : "Card, Apple Pay, Google Pay, bank account, or pay over time with Klarna. You pick on the next screen."}
          </p>
          <p className="mt-1 text-center text-[14px] text-[#15130F]/75">By paying, you agree to our <button type="button" onClick={() => setTerms(true)} className="inline-flex min-h-[44px] items-center font-bold text-[#8C6224] underline underline-offset-2">Terms</button>.</p>
          {terms ? <TermsSheet onClose={() => setTerms(false)} /> : null}
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

const money = (n: number) => formatCurrency(n);
const minus = (n: number) => `− ${formatCurrency(Math.abs(n))}`;

/** An itemized invoice laid out like a paper one: who it's from, the number
 *  and date, who it's billed to, the lines, then the totals. A line's own
 *  discount sits right under it in green; a discount on the whole invoice
 *  sits in the totals. */
export function InvoiceDoc({ info, paid = false }: { info: Info; paid?: boolean }) {
  const items = info.items ?? [];
  const lines = items.filter((i) => !i.total_discount);
  const wholeOff = items.filter((i) => i.total_discount);
  const subtotal = lines.reduce((t, i) => t + i.amount, 0);
  const lineOff = lines.reduce((t, i) => t + (i.discount || 0), 0);
  const date = info.date ? new Date(info.date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "";
  return (
    <div className="mt-4 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-[#15130F]/10">
      <div className="flex items-end justify-between gap-3 bg-[#15130F] px-4 py-3 text-white">
        <div>
          <p className="text-[13px] font-bold uppercase tracking-[0.18em]" style={{ color: GOLD }}>Sterling</p>
          <p className="text-[13px] text-white/80">Fence Staining · Houston</p>
        </div>
        <p className="font-heading text-2xl font-bold tracking-wide">{paid ? "RECEIPT" : "INVOICE"}</p>
      </div>
      <div className="grid grid-cols-2 gap-3 border-b border-[#15130F]/10 px-4 py-3 text-[15px]">
        <div>
          <p className="text-[12px] font-bold uppercase tracking-wide text-[#15130F]/60">Bill to</p>
          {info.name ? <p className="font-bold capitalize">{info.name.toLowerCase()}</p> : null}
          {info.address ? <p className="text-[#15130F]/75">{info.address}</p> : null}
        </div>
        <div className="text-right">
          {info.invoice_number ? (<>
            <p className="text-[12px] font-bold uppercase tracking-wide text-[#15130F]/60">Invoice no.</p>
            <p className="font-bold tabular-nums">{info.invoice_number}</p>
          </>) : null}
          {date ? (<>
            <p className="mt-1 text-[12px] font-bold uppercase tracking-wide text-[#15130F]/60">Date</p>
            <p className="tabular-nums">{date}</p>
          </>) : null}
        </div>
      </div>
      <div className="flex justify-between bg-[#F8F3E7] px-4 py-2 text-[12px] font-bold uppercase tracking-wide text-[#15130F]/65">
        <span>Description</span><span>Amount</span>
      </div>
      <ul className="divide-y divide-[#15130F]/10 px-4">
        {lines.map((i, n) => (
          <li key={n} className="py-3">
            <div className="flex justify-between gap-3 text-[16px]">
              <div>
                <p className="font-bold">{i.name}</p>
                {i.description ? <p className="text-[14px] text-[#15130F]/70">{i.description}</p> : null}
              </div>
              <p className="shrink-0 font-semibold tabular-nums">{money(i.amount)}</p>
            </div>
            {i.discount ? (
              <div className="mt-1.5 flex justify-between gap-3 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-[15px] font-semibold text-emerald-800">
                <span>{i.discount_label || "Discount"}</span><span className="tabular-nums">{minus(i.discount)}</span>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <dl className="ml-auto space-y-1.5 border-t-2 border-[#15130F]/15 px-4 py-3 text-[15px] sm:w-3/4">
        <div className="flex justify-between gap-3"><dt className="text-[#15130F]/75">Subtotal</dt><dd className="tabular-nums">{money(subtotal)}</dd></div>
        {lineOff ? <div className="flex justify-between gap-3 text-emerald-800"><dt>Discounts</dt><dd className="tabular-nums">{minus(lineOff)}</dd></div> : null}
        {wholeOff.map((i, n) => (
          <div key={n} className="flex justify-between gap-3 text-emerald-800"><dt>{i.name}</dt><dd className="tabular-nums">{minus(i.amount)}</dd></div>
        ))}
        {info.credit ? <div className="flex justify-between gap-3"><dt className="text-[#15130F]/75">Already paid</dt><dd className="tabular-nums">{minus(info.credit)}</dd></div> : null}
      </dl>
      <div className="flex items-center justify-between gap-3 px-4 py-3" style={{ background: "#FBF3DF" }}>
        <span className="text-[17px] font-bold">{paid ? "Total paid" : "Total due"}</span>
        <span className="font-heading text-3xl font-bold tabular-nums">{money(info.amount)}</span>
      </div>
    </div>
  );
}

/** The terms over the pay page, so reading them never leaves checkout. */
function TermsSheet({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener("keydown", onKey); };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center sm:p-4" onClick={onClose}>
      <div className="flex max-h-[92vh] w-full max-w-md flex-col rounded-t-3xl bg-[#F8F3E7] text-[#15130F] shadow-2xl sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="overflow-y-auto p-5">
          <p className="text-[12px] font-bold uppercase tracking-[0.2em] text-[#8C6224]">The fine print, without the fine print</p>
          <h3 className="font-heading text-2xl font-bold leading-tight">Our terms</h3>
          <div className="mt-3 space-y-4 text-[17px] leading-relaxed"><TermsBody /></div>
        </div>
        <div className="border-t border-[#15130F]/10 p-4">
          <button type="button" onClick={onClose} className="h-12 w-full rounded-xl text-base font-bold text-[#15130F]" style={{ background: GOLD }}>Got it</button>
        </div>
      </div>
    </div>
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
