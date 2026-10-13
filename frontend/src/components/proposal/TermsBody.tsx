// The proposal's terms, in plain words (Alan, 2026-10-10). One copy, shown in
// the proposal's Terms sheet and on the public /legal/terms page that the pay
// page and Stripe's checkout link to. Paying means agreeing to these, so bump
// TERMS_VERSION whenever a paragraph's meaning changes: each payment records
// the version the customer saw.
export const TERMS_VERSION = "2026-10-13";

export function TermsBody() {
  return (
    <>
      <p><span className="font-bold">Our promise.</span> If the stain peels or cracks because of how we applied it, we come back and fix it. Free. For one year from the day we finish.</p>
      <p><span className="font-bold">What it does not cover.</span> Damage we did not cause. A mower or weed eater hits the fence. A sprinkler sprays it every day. A board you swapped out. Pets, scrapes, a neighbor's project. Those are not our work, so the free fix does not cover them.</p>
      <p><span className="font-bold">Loose boards.</span> We screw a few loose boards back in for free. That can be pickets, rails, caps or the board along the bottom. If a lot of the fence is loose, a board needs replacing, or a post leans, that costs extra. We tell you the price first.</p>
      <p><span className="font-bold">The top of the cap.</span> No cap on your fence? We stain the tops of the pickets, because that's where water gets in. Have a cap (the flat board along the top)? We stain the sides of the cap, but not the top that faces the sky. The cap is there to protect your pickets. Staining its top means a ladder all the way around the fence and a lot more stain, so it is extra. Just ask and we will give you a price.</p>
      <p><span className="font-bold">Something else damaged it?</span> If the damage was not caused by our work, like a mower, a sprinkler, a storm or a pet, it is not free. But we will still come fix it. We tell you the price first. You say yes or no. No surprises.</p>
      <p><span className="font-bold">Sprinklers hitting your fence?</span> Sprinkler water leaves stains and wears the stain out faster. We have our own sprinkler team. We will check your sprinklers for free. Then we give you a fair price to aim them away from the fence.</p>
      <p><span className="font-bold">A complimentary touch-up can.</span> When we finish, we leave you a can of your exact stain, free, as our thank-you on top of everything else. A small scrape becomes a two-minute fix. The stain's name is on the label. Need more? Buy it by that name, or ask us.</p>
      <p><span className="font-bold">* Why we give a range.</span> The years on each package are what we usually see, not a promise. How long a stain lasts depends on things no one controls. How much sun the fence gets matters most, because south and west sides fade first. So do rain, Houston humidity, sprinklers that hit the fence, shade and mildew, the age of the wood, and storms like hail and hurricanes. Two fences on the same street can wear differently. Our written promise is the 1-year warranty above. After that, we're glad to come back and restain at our regular price.</p>
      <p><span className="font-bold">The deposit.</span> $250 reserves your spot on our schedule and isn't refundable. It is not a payment for the work, but it counts toward your total. Move your date any time. The rest is due when the job is done and you're happy.</p>
      <p><span className="font-bold">Free cleaning comes with staining.</span> The cleaning is free because it is part of your staining job. It is not free on its own.</p>
      <p><span className="font-bold">If you stop the job partway.</span> Once we clean your fence, your job has started. Cleaning and prep are half the work. If you stop the job after that, the cleaning is no longer free: you pay 50% of the package you reserved. Your $250 counts toward it. Changing your package or color is fine. That is not stopping the job. Your price just moves to the new package.</p>
    </>
  );
}
