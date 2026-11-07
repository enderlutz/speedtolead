// The BBB Accredited Business seal, tapped to open our real BBB profile
// (Alan, 2026-11-06: a customer who checks the BBB before he buys asked for
// proof we're legit; Sterling Fence Staining LLC was accredited 11/4, rated
// A-). The seal image is BBB's own, from our public profile; the accreditation
// agreement covers using it on our materials. BBB's live "Dynamic Seal" only
// loads on domains registered with them, which is why it isn't hot-linked.
// Sits next to the Google reviews on the proposal and the booking invite.

export const BBB_PROFILE_URL = "https://www.bbb.org/us/tx/cypress/profile/fence-staining/sterling-fence-staining-llc-0915-90078072";
export const BBB_RATING = "A-";

export function BbbBadge({ className = "" }: { className?: string }) {
  return (
    <a href={BBB_PROFILE_URL} target="_blank" rel="noopener noreferrer"
      className={`flex min-h-[44px] items-center gap-3 rounded-2xl bg-white p-3.5 ring-1 ring-[#15130F]/10 active:bg-[#15130F]/5 ${className}`}>
      <img src="/bbb-accredited.png" alt="BBB Accredited Business" className="h-12 w-auto shrink-0" draggable={false} />
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-bold leading-tight text-[#15130F]">BBB Accredited Business</span>
        <span className="block text-[15px] leading-snug text-[#15130F]/75">Rated <b className="text-[#15130F]">{BBB_RATING}</b> by the Better Business Bureau</span>
      </span>
      <span className="shrink-0 text-[15px] font-bold text-[#8C6224] underline underline-offset-2">See it ›</span>
    </a>
  );
}
