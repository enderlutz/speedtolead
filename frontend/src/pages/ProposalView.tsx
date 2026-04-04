import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type ProposalData } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { Download, Phone } from "lucide-react";

const BASE = import.meta.env.VITE_API_URL || "";

const TIER_META = {
  essential: { label: "Essential", desc: "Quality restoration at a great value" },
  signature: { label: "Signature", desc: "Our most popular full-service package", badge: true },
  legacy: { label: "Legacy", desc: "Premium craftsmanship, built to last" },
} as const;

function PageSkeleton() {
  return (
    <div className="w-full aspect-[8.5/11] bg-gray-200 rounded-lg animate-pulse" />
  );
}

function ProposalPage({
  token,
  pageNum,
  totalPages,
}: {
  token: string;
  pageNum: number;
  totalPages: number;
}) {
  const [loaded, setLoaded] = useState(false);
  const eager = pageNum === 1;

  return (
    <div className="relative w-full">
      {!loaded && <PageSkeleton />}
      <img
        src={`${BASE}/api/proposal/${token}/page/${pageNum}`}
        alt={`Proposal page ${pageNum} of ${totalPages}`}
        loading={eager ? "eager" : "lazy"}
        onLoad={() => setLoaded(true)}
        className={`w-full rounded-lg shadow-sm ${loaded ? "block" : "absolute top-0 left-0 opacity-0"}`}
      />
    </div>
  );
}

export default function ProposalView() {
  const { token } = useParams<{ token: string }>();
  const [proposal, setProposal] = useState<ProposalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    api
      .getProposal(token)
      .then(setProposal)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F8F9FA] flex items-center justify-center">
        <div className="w-full max-w-2xl px-4 space-y-4">
          <div className="h-10 w-56 mx-auto bg-gray-200 rounded animate-pulse" />
          <div className="h-6 w-40 mx-auto bg-gray-200 rounded animate-pulse" />
          <PageSkeleton />
        </div>
      </div>
    );
  }

  if (error || !proposal) {
    return (
      <div className="min-h-screen bg-[#F8F9FA] flex items-center justify-center">
        <div className="text-center px-6">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-[#1C2235]/10 flex items-center justify-center">
            <span className="text-2xl text-[#1C2235]/60">?</span>
          </div>
          <h1 className="text-xl font-semibold text-[#1C2235] mb-2">
            Proposal Not Found
          </h1>
          <p className="text-sm text-[#1C2235]/50">
            This link may have expired or is no longer available.
          </p>
        </div>
      </div>
    );
  }

  const pageCount = proposal.page_count || 0;

  return (
    <div className="min-h-screen bg-[#F8F9FA]">
      {/* Branded header */}
      <header className="bg-[#1C2235] text-white">
        <div className="max-w-2xl mx-auto px-4 py-6 sm:py-8 text-center">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
            A&T Fence Restoration
          </h1>
          <p className="text-white/60 text-sm mt-1 tracking-wide uppercase">
            Your Proposal
          </p>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 sm:py-10 space-y-8">
        {/* Customer info bar */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <h2 className="text-lg font-semibold text-[#1C2235]">
            {proposal.customer_name}
          </h2>
          <p className="text-sm text-[#1C2235]/50 mt-0.5">{proposal.address}</p>
        </div>

        {/* PDF page images */}
        {pageCount > 0 && token && (
          <div className="space-y-4">
            {Array.from({ length: pageCount }, (_, i) => (
              <ProposalPage
                key={i + 1}
                token={token}
                pageNum={i + 1}
                totalPages={pageCount}
              />
            ))}
          </div>
        )}

        {/* Pricing tier cards */}
        <section>
          <h3 className="text-center text-sm font-semibold text-[#1C2235]/40 uppercase tracking-widest mb-4">
            Investment Options
          </h3>
          <div className="grid gap-4">
            {(["essential", "signature", "legacy"] as const).map((tier) => {
              const price = proposal.tiers[tier] || 0;
              const monthly = Math.round(price / 21);
              const meta = TIER_META[tier];
              const isSignature = tier === "signature";

              return (
                <div
                  key={tier}
                  className={`relative rounded-xl border p-5 transition-shadow ${
                    isSignature
                      ? "bg-[#1C2235] text-white border-[#1C2235] shadow-lg shadow-[#1C2235]/20"
                      : "bg-white border-gray-100 shadow-sm"
                  }`}
                >
                  {isSignature && (
                    <span className="absolute -top-2.5 left-5 bg-amber-400 text-[#1C2235] text-[10px] font-bold uppercase tracking-wider px-3 py-0.5 rounded-full">
                      Most Popular
                    </span>
                  )}

                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <h4 className="font-semibold text-base">{meta.label}</h4>
                      <p
                        className={`text-xs mt-0.5 ${
                          isSignature ? "text-white/60" : "text-[#1C2235]/40"
                        }`}
                      >
                        {meta.desc}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-2xl font-bold tracking-tight">
                        {formatCurrency(price)}
                      </div>
                      <p
                        className={`text-xs mt-0.5 ${
                          isSignature ? "text-white/50" : "text-[#1C2235]/40"
                        }`}
                      >
                        ~{formatCurrency(monthly)}/mo
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Action buttons */}
        <div className="flex flex-col sm:flex-row gap-3">
          {proposal.has_pdf && token && (
            <a
              href={`${BASE}/api/proposal/${token}/pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl border border-[#1C2235] text-[#1C2235] font-semibold text-sm py-3.5 px-6 hover:bg-[#1C2235]/5 transition-colors"
            >
              <Download className="h-4 w-4" />
              Download PDF
            </a>
          )}
          <a
            href="tel:+18326515988"
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-[#1C2235] text-white font-semibold text-sm py-3.5 px-6 hover:bg-[#1C2235]/90 transition-colors shadow-md shadow-[#1C2235]/20"
          >
            <Phone className="h-4 w-4" />
            Call to Book
          </a>
        </div>

        {/* Footer */}
        <footer className="text-center text-xs text-[#1C2235]/30 pb-6">
          A&T Fence Restoration &middot; Cypress, TX
        </footer>
      </main>
    </div>
  );
}
