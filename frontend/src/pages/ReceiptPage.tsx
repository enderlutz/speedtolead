// /receipt/{token}: a paid link's receipt. The same invoice the customer
// paid, stamped PAID with the date and how they paid, plus the three things
// people do with a receipt: save it (the phone's print sheet saves a PDF to
// Files), share it, or text it to someone. (Alan, 2026-10-13.)
//
// Raw fetch on purpose, as on the pay page: never bounce a customer to the
// staff login.
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Download, MessageSquare, Share2, Check } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { InvoiceDoc, type Info } from "@/pages/PayLink";

import { API_BASE as BASE } from "@/lib/apiBase";
const GOLD = "#C9972F";

type Receipt = Info & { paid_at?: string; method?: string };

const METHOD: Record<string, string> = {
  card: "Card", link: "Card", apple_pay: "Apple Pay", google_pay: "Google Pay", us_bank_account: "Bank account",
  cashapp: "Cash App", klarna: "Klarna", affirm: "Affirm", amazon_pay: "Amazon Pay",
};

export default function ReceiptPage() {
  const { token } = useParams<{ token: string }>();
  const [r, setR] = useState<Receipt | "loading" | "missing">("loading");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    document.title = "Receipt · Sterling Fence Staining";
    // preview=1: a receipt is never a view of an unpaid link, but keep the
    // pay page's counter out of it all the same.
    fetch(`${BASE}/api/pay/${encodeURIComponent(token || "")}?preview=1`)
      .then((x) => (x.ok ? x.json() : null))
      .then((d: Receipt | null) => setR(d && d.status === "paid" ? d : "missing"))
      .catch(() => setR("missing"));
  }, [token]);

  if (r === "loading") return <Page><p className="text-[17px] font-semibold text-[#15130F]/75">One moment…</p></Page>;
  if (r === "missing") {
    return (
      <Page>
        <p className="font-heading text-2xl font-bold">This receipt isn't ready.</p>
        <p className="mt-2 text-[15px] text-[#15130F]/75">If you just paid, give it a minute and refresh. Questions? Call or text 346-589-7877.</p>
      </Page>
    );
  }

  const url = window.location.href.split("?")[0];
  const paidOn = r.paid_at ? new Date(r.paid_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "";
  const how = METHOD[r.method || ""] || "";
  const title = `Sterling Fence Staining receipt${r.invoice_number ? ` ${r.invoice_number}` : ""}`;
  const share = async () => {
    const nav = navigator as Navigator & { share?: (d: { title: string; text: string; url: string }) => Promise<void> };
    if (nav.share) { try { await nav.share({ title, text: title, url }); return; } catch { return; } }
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* nothing to do */ }
  };

  return (
    <Page>
      <div className="print:hidden">
        <p className="text-[13px] font-bold uppercase tracking-[0.2em]" style={{ color: "#8C6224" }}>Receipt</p>
        <h1 className="mt-1 font-heading text-3xl font-bold leading-tight">Paid. Thank you{r.first_name ? `, ${r.first_name}` : ""}!</h1>
      </div>
      <div className="relative">
        {r.items?.length ? (
          <InvoiceDoc info={{ ...r, amount: r.amount }} paid />
        ) : (
          <div className="mt-4 rounded-2xl bg-white p-4 ring-1 ring-[#15130F]/10">
            <p className="text-[15px] font-semibold">{r.label}{r.invoice_number ? ` · ${r.invoice_number}` : ""}</p>
            {r.description ? <p className="text-[15px] text-[#15130F]/75">{r.description}</p> : null}
            {r.address ? <p className="text-[15px] text-[#15130F]/75">{r.address}</p> : null}
            <p className="mt-2 font-heading text-4xl font-bold tabular-nums">{formatCurrency(r.amount)}</p>
          </div>
        )}
      </div>
      <div className="mt-3 rounded-2xl bg-emerald-50 px-4 py-3 text-[15px] text-emerald-900 ring-1 ring-emerald-200">
        <p className="flex items-center gap-2 font-bold"><Check className="h-5 w-5" /> Paid {formatCurrency(r.amount)}</p>
        <p>{[paidOn, how && `by ${how}`].filter(Boolean).join(" ")}</p>
      </div>
      <div className="mt-4 grid gap-2 print:hidden">
        <button type="button" onClick={() => window.print()} className="flex h-14 items-center justify-center gap-2 rounded-xl text-[17px] font-bold text-[#15130F] shadow" style={{ background: GOLD }}>
          <Download className="h-5 w-5" /> Download or save receipt
        </button>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={share} className="flex h-12 items-center justify-center gap-2 rounded-xl bg-white text-[16px] font-bold ring-1 ring-[#15130F]/15">
            <Share2 className="h-5 w-5" /> {copied ? "Link copied" : "Share"}
          </button>
          <a href={`sms:?&body=${encodeURIComponent(`${title}: ${url}`)}`} className="flex h-12 items-center justify-center gap-2 rounded-xl bg-white text-[16px] font-bold ring-1 ring-[#15130F]/15">
            <MessageSquare className="h-5 w-5" /> Text it
          </a>
        </div>
        <p className="text-center text-[14px] text-[#15130F]/70">"Download" opens your phone's print screen. Tap Share there to save it as a PDF to Files, or email it.</p>
      </div>
      <p className="mt-6 text-center text-[14px] text-[#15130F]/75">Sterling Fence Staining · Houston · 346-589-7877</p>
    </Page>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#F8F3E7] text-[#15130F] print:bg-white">
      <div className="mx-auto max-w-md px-4 py-6">{children}</div>
    </div>
  );
}
