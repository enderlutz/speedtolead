// A no-login link to the proposal mockup, so Alan can text it to someone
// for an opinion (2026-10-10: "create a link so I can send it to my friend").
// It shows the sample customer only: nothing on this page comes from the
// database, and the link carries no customer's name, address or price.
// The staff bar, the phone frame and the live-estimate dressing stay on the
// dashboard's own copy at /new-proposal/mockup.
import { useEffect } from "react";
import { useParams } from "react-router-dom";
import ProposalMockup from "@/pages/ProposalMockup";

// Change this to retire every link that has been sent.
const PREVIEW_TOKEN = "kT7b_eyUzA5X5HSwpBWc";

export default function ProposalPreview() {
  const { token } = useParams<{ token: string }>();
  const ok = token === PREVIEW_TOKEN;
  useEffect(() => {
    document.title = ok ? "Your fence restoration plan · Sterling Fence Staining" : "Sterling Fence Staining";
  }, [ok]);
  if (!ok) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F8F3E7] p-6 text-center text-[#15130F]">
        <div>
          <p className="font-heading text-2xl font-bold">This link isn't active.</p>
          <p className="mt-2 text-[15px] text-[#15130F]/75">Call or text Sterling Fence Staining at 346-589-7877.</p>
        </div>
      </div>
    );
  }
  return <ProposalMockup preview />;
}
