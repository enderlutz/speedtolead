// The proposal's terms on their own page, so the pay page and Stripe's
// checkout can link to them: paying means agreeing to these (Alan,
// 2026-10-13). Same words as the proposal's Terms sheet (TermsBody).
import { Phone } from "lucide-react";
import { TermsBody, TERMS_VERSION } from "@/components/proposal/TermsBody";

const GOLD = "#C9972F";
const PHONE = "346-589-7877";

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-[#F8F3E7] text-[#15130F]">
      <div className="mx-auto max-w-md">
        <div className="flex items-center justify-between bg-[#15130F] px-4 py-3">
          <img src="/sterling-logo-dark.png" alt="Sterling Fence Staining" className="h-8 w-auto" draggable={false} />
          <a href={`tel:+1${PHONE.replace(/-/g, "")}`} className="inline-flex h-10 items-center gap-2 rounded-full px-4 text-[15px] font-bold text-[#15130F]" style={{ background: GOLD }}>
            <Phone className="h-4 w-4" /> Call
          </a>
        </div>
        <div className="px-5 py-6">
          <p className="text-[12px] font-bold uppercase tracking-[0.2em] text-[#8C6224]">The fine print, without the fine print</p>
          <h1 className="font-heading text-2xl font-bold leading-tight">Our terms</h1>
          <div className="mt-3 space-y-4 text-[17px] leading-relaxed">
            <TermsBody />
            <p><span className="font-bold">Your price</span> is good for the number of days shown on your proposal. After that, our regular prices apply.</p>
          </div>
          <p className="mt-6 text-[13px] text-[#15130F]/65">Sterling Fence Staining · Cypress, TX · {PHONE} · Terms of {TERMS_VERSION}</p>
        </div>
      </div>
    </div>
  );
}
