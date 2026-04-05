import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type ProposalData } from "@/lib/api";
import { Download, Phone } from "lucide-react";

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
      {/* Header with actions */}
      <header className="bg-[#1C2235] text-white sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-4">
          <h1 className="text-lg sm:text-xl font-bold tracking-tight text-center mb-3">
            A&T Fence Restoration
          </h1>
          <div className="flex gap-2">
            {proposal.has_pdf && token && (
              <a
                href={`${BASE}/api/proposal/${token}/pdf`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/30 text-white font-semibold text-xs sm:text-sm py-2.5 px-3 hover:bg-white/10 transition-colors"
              >
                <Download className="h-4 w-4 shrink-0" />
                <span>PDF</span>
              </a>
            )}
            <a
              href="tel:+18326515988"
              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-amber-500 text-white font-semibold text-xs sm:text-sm py-2.5 px-3 hover:bg-amber-600 transition-colors shadow-md"
            >
              <Phone className="h-4 w-4 shrink-0" />
              <span>Call to Book</span>
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
          A&T Fence Restoration &middot; Cypress, TX
        </footer>
      </main>
    </div>
  );
}
