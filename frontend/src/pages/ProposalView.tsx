import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type ProposalData, type CorrectionRequest } from "@/lib/api";
import { Phone, X, CheckCircle2 } from "lucide-react";
import ChatbotWidget from "@/components/ChatbotWidget";

const SUPPORT_PHONE = "+13465897877";  // 346-589-7877

function formatDateShort(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

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
  customUrl,
}: {
  token: string;
  pageNum: number;
  totalPages: number;
  customUrl?: string;  // Storage CDN URL or "/api/..." path from backend
}) {
  const [loaded, setLoaded] = useState(false);
  const eager = pageNum === 0;

  // Source priority:
  //   1. customUrl from backend's page_urls[] — usually a Supabase Storage
  //      CDN URL (absolute). Bypasses our backend entirely, no DB hit,
  //      no metered DB egress.
  //   2. If customUrl is a relative path like "/api/proposal/.../page/N"
  //      (backfill not run yet, or Storage unavailable), prepend BASE.
  //   3. Fallback to constructing the legacy URL — keeps the page working
  //      even if backend omitted page_urls.
  const src = (() => {
    if (customUrl) {
      return customUrl.startsWith("http") ? customUrl : `${BASE}${customUrl}`;
    }
    return `${BASE}/api/proposal/${token}/page/${pageNum}`;
  })();

  return (
    <div className="relative w-full">
      {!loaded && <PageSkeleton />}
      <img
        src={src}
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
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionText, setCorrectionText] = useState("");
  const [submittingCorrection, setSubmittingCorrection] = useState(false);
  const [correctionSubmitted, setCorrectionSubmitted] = useState(false);
  const [correctionError, setCorrectionError] = useState("");

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    api
      .getProposal(token)
      .then(setProposal)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [token]);

  const submitCorrection = async () => {
    if (!token) return;
    const trimmed = correctionText.trim();
    if (!trimmed) {
      setCorrectionError("Please describe what needs to be corrected.");
      return;
    }
    setSubmittingCorrection(true);
    setCorrectionError("");
    try {
      await api.requestProposalCorrection(token, trimmed);
      setCorrectionSubmitted(true);
      // Refresh the proposal so the new request shows in the history
      const fresh = await api.getProposal(token);
      setProposal(fresh);
      setCorrectionText("");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Something went wrong. Please try again.";
      setCorrectionError(msg.replace(/^\d+:\s*/, ""));
    } finally {
      setSubmittingCorrection(false);
    }
  };

  const closeCorrectionModal = () => {
    setCorrectionOpen(false);
    setCorrectionSubmitted(false);
    setCorrectionError("");
    setCorrectionText("");
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#1C2235] flex flex-col items-center justify-center px-6">
        <div className="relative mb-6">
          <div className="h-16 w-16 rounded-full border-4 border-white/10 border-t-amber-400 animate-spin" />
        </div>
        <h1 className="text-xl font-bold text-white tracking-tight">{"Sterling Fence Staining"}</h1>
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
  // Brick-restoration proposals rebrand the header and drop the "sides of
  // fence included" list (brick staining covers the whole house).
  const isBrick = proposal.header_variant === "brick";

  return (
    <div className="min-h-screen bg-[#F8F9FA]">
      {/* Header — brand + price includes + call icon */}
      <header className="bg-[#1C2235] text-white sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-lg sm:text-xl font-bold tracking-tight">{isBrick ? "Sterling Brick Staining" : "Sterling Fence Staining"}</h1>
              {!isBrick && (
                <div className="mt-2">
                  <p className="text-xs text-white/60 font-medium">Sides of fence included in the price</p>
                  <ul className="mt-1 space-y-0.5">
                    {proposal.pricing_includes.map((bullet, i) => (
                      <li key={i} className="text-sm text-white/90 flex items-start gap-2">
                        <span className="text-amber-400 mt-1.5 inline-block h-1 w-1 rounded-full bg-amber-400 shrink-0" />
                        <span>{bullet}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
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
        {/* Pending requote banner */}
        {proposal.correction_pending && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 flex items-start gap-2">
            <CheckCircle2 className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
            <p className="text-sm text-amber-800">
              We received your correction request and we'll send you an updated quote shortly.
            </p>
          </div>
        )}

        {/* PDF page images */}
        {pageCount > 0 && token && (
          <div className="space-y-4">
            {Array.from({ length: pageCount }, (_, i) => (
              <ProposalPage
                key={i}
                token={token}
                pageNum={i}
                totalPages={pageCount}
                customUrl={proposal.page_urls?.[i]}
              />
            ))}
          </div>
        )}

        {/* Correction request history */}
        {proposal.correction_requests.length > 0 && (
          <div className="rounded-lg border bg-white p-4 space-y-2">
            <p className="text-sm font-semibold text-[#1C2235]">Your correction requests</p>
            <ul className="space-y-2">
              {proposal.correction_requests.map((cr: CorrectionRequest) => (
                <li key={cr.id} className="border-l-2 border-amber-300 pl-3">
                  <p className="text-xs text-muted-foreground">
                    {formatDateShort(cr.requested_at)}
                    {cr.resolved_at && <span className="ml-2 text-emerald-600">· Resolved</span>}
                  </p>
                  <p className="text-sm text-[#1C2235] mt-0.5">{cr.text}</p>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Footer */}
        <footer className="text-center text-xs text-[#1C2235]/30 pb-6 pt-4">
          {"Sterling Fence Staining"} &middot; Cypress, TX
        </footer>
      </main>

      {/* Correction request modal */}
      {correctionOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={closeCorrectionModal}>
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-2">
              <h2 className="text-base font-semibold text-[#1C2235]">
                {correctionSubmitted ? "Got it!" : "Request a side change"}
              </h2>
              <button onClick={closeCorrectionModal} className="text-muted-foreground hover:text-[#1C2235]" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>

            {correctionSubmitted ? (
              <>
                <p className="text-sm text-[#1C2235]/80">
                  We'll review and send you an updated quote shortly. You can submit another correction at any time.
                </p>
                <div className="flex justify-end pt-2">
                  <button
                    onClick={closeCorrectionModal}
                    className="px-4 py-2 rounded-lg bg-[#1C2235] text-white text-sm font-medium hover:bg-[#1C2235]/90 transition-colors"
                  >
                    Done
                  </button>
                </div>
              </>
            ) : (
              <>
                <textarea
                  value={correctionText}
                  onChange={(e) => setCorrectionText(e.target.value)}
                  placeholder="Tell us which sides you actually want stained"
                  className="w-full border rounded-lg px-3 py-2 text-sm h-28 resize-none focus:outline-none focus:ring-2 focus:ring-amber-400"
                  disabled={submittingCorrection}
                  maxLength={2000}
                />
                {correctionError && (
                  <p className="text-xs text-red-600">{correctionError}</p>
                )}
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    onClick={closeCorrectionModal}
                    disabled={submittingCorrection}
                    className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted/50 transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={submitCorrection}
                    disabled={submittingCorrection || !correctionText.trim()}
                    className="px-4 py-2 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 transition-colors disabled:opacity-50"
                  >
                    {submittingCorrection ? "Submitting..." : "Submit"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Chatbot widget */}
      {token && proposal.lead_id && (
        <ChatbotWidget token={token} leadId={proposal.lead_id} />
      )}
    </div>
  );
}
