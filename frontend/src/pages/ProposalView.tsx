import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type ProposalData } from "@/lib/api";
import { Phone } from "lucide-react";
import ChatbotWidget from "@/components/ChatbotWidget";

const SUPPORT_PHONE = "+18323346528";  // 832-334-6528

const BASE = import.meta.env.VITE_API_URL || "";

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
  const eager = pageNum === 0;

  return (
    <div className="relative w-full">
      {!loaded && <PageSkeleton />}
      <img
        src={`${BASE}/api/proposal/${token}/page/${pageNum}`}
        alt={`Proposal page ${pageNum + 1} of ${totalPages}`}
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
      <div className="min-h-screen bg-[#1C2235] flex flex-col items-center justify-center px-6">
        <div className="relative mb-6">
          <div className="h-16 w-16 rounded-full border-4 border-white/10 border-t-amber-400 animate-spin" />
        </div>
        <h1 className="text-xl font-bold text-white tracking-tight">Fence Revive Co.</h1>
        <p className="text-white/50 text-sm mt-2 animate-pulse">Loading your proposal...</p>
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
      {/* Header — brand + price includes + call icon */}
      <header className="bg-[#1C2235] text-white sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-lg sm:text-xl font-bold tracking-tight">Fence Revive Co.</h1>
              <div className="mt-2">
                <p className="text-[11px] uppercase tracking-widest text-white/50 font-semibold">Price Includes</p>
                <ul className="mt-1 space-y-0.5">
                  {proposal.pricing_includes.map((bullet, i) => (
                    <li key={i} className="text-sm text-white/90 flex items-start gap-2">
                      <span className="text-amber-400 mt-1.5 inline-block h-1 w-1 rounded-full bg-amber-400 shrink-0" />
                      <span>{bullet}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <a
              href={`tel:${SUPPORT_PHONE}`}
              aria-label="Call us"
              title="Call us"
              className="shrink-0 inline-flex items-center justify-center h-10 w-10 rounded-full bg-amber-500 text-white hover:bg-amber-600 transition-colors shadow-md"
            >
              <Phone className="h-4 w-4" />
            </a>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 sm:py-8 space-y-4">
        {/* PDF page images */}
        {pageCount > 0 && token && (
          <div className="space-y-4">
            {Array.from({ length: pageCount }, (_, i) => (
              <ProposalPage
                key={i}
                token={token}
                pageNum={i}
                totalPages={pageCount}
              />
            ))}
          </div>
        )}

        {/* Footer */}
        <footer className="text-center text-xs text-[#1C2235]/30 pb-6 pt-4">
          Fence Revive Co. &middot; Cypress, TX
        </footer>
      </main>

      {/* Chatbot widget */}
      {token && proposal.lead_id && (
        <ChatbotWidget token={token} leadId={proposal.lead_id} />
      )}
    </div>
  );
}
