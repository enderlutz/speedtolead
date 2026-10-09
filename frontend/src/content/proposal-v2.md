# New Proposal — project notes

Status: Phase 1 · Planning · nothing is live

This file is the one place for the new interactive proposal: what it is,
the questions still open, the three phases, and where everything lives.
It shows up in the dashboard under **New Proposal** so it can be read from
anywhere, whatever else is being edited that day. Answers given in chat get
written back here.

> **The one rule.** No customer sees the new proposal until all three are
> true: it is complete, it has been through the review in Phase 3, and the
> link runs on the Sterling domain. Until then every send keeps producing
> today's PDF proposal, the new code lives only on the `proposal-v2` branch,
> and nothing from that branch is merged into `main`.

## What Alan asked for (2026-10-09)

- A customer-facing proposal "similar to the one we have right now, but a
  little bit more interactive".
- The customer **chooses the package** themselves: Essential, Signature or
  Legacy.
- **Real photos of real stains** on the different finishes, and the customer
  can pick a stain they like.
- Later, once Stripe is connected: **pay the $250 deposit** in the proposal,
  with **financing** attached.
- Every proposal already sent stays exactly as it is. Every new send gets the
  new proposal, on the **Sterling link** (estimate.sterlingfencetx.com), not
  the A&T link.
- Built separately so the rest of the dashboard never waits on it.

## Questions to answer

Answer in chat, by number. Each has a recommendation so "yes" is enough.

### A. Packages and price

1. Keep the same three packages and prices from the estimate, all three
   visible at once, and the customer picks one? *Recommend: yes. In the first
   version they pick one of three; nothing changes the price live.*
2. Can the customer add things that change the price (outside sides, a gate,
   pressure washing), or does that stay with us? *Recommend: not in the first
   version. An "Ask about adding…" button that texts us instead.*
3. When they pick a package: locked, changeable, or changeable until the
   deposit? And what happens: text you and Olga, move the GoHighLevel stage?
   *Recommend: changeable until the deposit; text you both; the stage moves
   only when the deposit is paid.*

### B. Stains and photos

4. The exact stain list for the picker: product line and colour names. Is it
   the same list for all three packages?
5. Do the real photos exist today, and where (Company Cam, phones, Drive)?
   How many per colour? *Recommend: three to five per colour, your own jobs,
   tap to enlarge.*
6. Does the stain choice change the price? Does it flow to the crew's colour
   plan on the Company Cam tab? *Recommend: no price change; yes, it pre-fills
   the colour plan.*

### C. Deposit and financing

7. Is the deposit $250 for every package? Refundable? Does paying it book
   the job, meaning we then schedule? *Recommend: flat $250, refundable until
   scheduled, deposit = booked.*
8. Stripe: is there an account, and under which company, Sterling or A&T?
   *Recommend: a Sterling account; cards plus Apple Pay.*
9. Financing: through Stripe's own checkout (Affirm or Klarna inside Stripe)
   or a separate Affirm account? Minimum job size to show it? *Recommend:
   Affirm inside Stripe, shown on jobs of $1,000 and up.*
10. Until Stripe is connected: show "Reserve with a $250 deposit" as a request
    that texts us with no payment taken, or hide it? *Recommend: show it as a
    request.*

### D. The page itself

11. What stays from today's PDF word for word: warranty, what's included and
    excluded, prep steps, terms? Anything to drop?
12. What is personal on the page: their name, address, the scope drawing with
    the sides, their linear feet? *Recommend: all of it; the scope drawing is
    the hero image.*
13. Social proof: Google reviews, before-and-after photos of nearby jobs, a
    "fences stained near you" count? Which ones?
14. Does the price expire (14 or 30 days)? The 20% + 10% ad promotion: a
    countdown or a line? *Recommend: a quiet 30-day expiry; the promotion as a
    line, no countdown.*
15. Brand: Sterling only? Does A&T appear anywhere ("sister company")? The
    dashboard's ivory, ink and gold palette, or something of its own?

### E. Sending, tracking and notifications

16. The text that carries the link: same wording and the same Send button as
    today? One link per estimate, and "New estimate" makes a new link, as
    now?
17. What do you want to know back, and who gets told: opened, time on the
    page, which package they looked at longest, stains tapped, package chosen,
    deposit paid? *Recommend: log all of it; text you and WhatsApp Olga on
    first open, package chosen, and deposit paid.*
18. Still offer a PDF download, for a spouse or an HOA? *Recommend: yes, of
    the chosen package, built from the same data.*

### F. Review and launch

19. Who reviews and how: you, Olga and Fragne on real phones; ten internal
    test sends to team numbers; a sign-off at the end of each phase?
20. Launch order: Sterling domain live, then one switch, then new sends only.
    Old links untouched. Should anyone with an open estimate be re-sent the
    new one? *Recommend: no mass re-send; only on request, through "New
    estimate".*

## The three phases (draft until the questions are answered)

### Phase 1 — Design and plan

- Answer the questions above; the answers get written into this file.
- Gather the stain list and the real photos.
- A clickable mock of the page on a preview link, reviewed on Alan's phone.
- Exit: Alan signs off on the design.

### Phase 2 — Build, on the branch only

- Data: a new proposal version ("interactive") behind a switch that is off;
  the proposal endpoint returns tiers, breakdown, sides and photos for it.
- The page: packages, stain picker, scope drawing, what's included, PDF
  download.
- The customer's package and stain choice saved, shown on the lead page, and
  texted to Alan and Olga.
- A photo library screen for the stain photos, ordered by Alan.
- Tracking: opens, time on page, taps, choices.
- Deposit and financing, once the Stripe account exists.
- Every push gives a preview link; `main` and production never change.
- Exit: every item above works on a test lead, on a phone.

### Phase 3 — Review and launch

- Ten internal test sends to team phones; zero customer sends.
- Review by Alan, Olga and Fragne; a fix list; fixes.
- The Sterling domain live in Vercel and the proposal link switched to it.
- The old proposal links checked, still opening unchanged.
- Merge into `main`, switch on, watch the first ten real sends.

**Launch gate — every box, or it does not go out:**

- [ ] Alan, Olga and Fragne have each opened a test proposal on their own phone
- [ ] At least ten internal test sends, and zero customer sends, before launch
- [ ] Old proposal links (PDF and custom PDF) still open unchanged
- [ ] estimate.sterlingfencetx.com is live in Vercel and the proposal link uses it
- [ ] Deposit is either off, or tested with a real $1 charge and refunded
- [ ] The switch is flipped by Alan himself

## Where things are today

- `backend/api/proposals.py`: the public endpoints (`GET /proposal/{token}`,
  page images, PDF, request-correction). `_is_bot_view` keeps iMessage link
  previews out of the view count; keep that.
- `frontend/src/pages/ProposalView.tsx`: today's page, which shows the PDF's
  page images. Public route `/proposal/:token` in `frontend/src/App.tsx`.
  Customer pages use raw `fetch`, never the dashboard's API helper, which
  redirects to the staff login on a 401.
- `database.Proposal`: `token`, `estimate_id`, `lead_id`, `status`,
  `proposal_version` (today `pdf` or `custom_pdf`), `header_variant`,
  `proposal_seq`, view counters. New sends would write
  `proposal_version="interactive"`; old rows are never touched.
- Sending: `backend/api/estimates.py` builds the link from
  `PROPOSAL_BASE_URL` (a Railway env var) in four places. The Sterling domain
  is not live yet: Fragne adds it in Vercel (Settings → Domains), then the
  env var changes. Old A&T links keep working because Vercel serves both
  domains from one build.
- Estimate data: `estimate.tiers` and `breakdown`
  (`frontend/src/lib/breakdown.ts`); sides helpers in
  `frontend/src/lib/fenceSides.ts`; the "what's included" text from
  `_build_pricing_includes` in `backend/api/estimates.py`.
- Stain colours: the Company Cam tab keeps a colour plan per side
  (`frontend/src/components/CompanyCamTab.tsx`); look there and in
  `services/service_catalog.py` before inventing a list.
- Customer-facing images belong in Supabase Storage, not Postgres, because
  of metered egress; the fence-scope photos show the pattern.
- Brand: ivory `#F8F3E7`, ink `#15130F`, gold `#C9972F`, gold-light
  `#E3BE63`, bronze `#8C6224`, cedar, walnut; headings in Playfair. The
  proposal must bypass the dashboard theme so dark mode cannot change it;
  `frontend/src/pages/VideoEstimate.tsx` does this on purpose.

## Decisions already made

- The $250 deposit is hardcoded in six places (a named constant in
  `api/quickbooks.py`; bare 250 in `api/accounting.py`, `api/payments.py`,
  `api/quickbooks.py`, `services/qb_reconcile.py`, and `LeadDetail.tsx`).
  Centralise it before a deposit button exists.
- Stripe: nothing exists yet. When it comes: a fresh Checkout Session per
  click, the lead id in the metadata, the webhook is the truth (idempotent
  on event id), and a new `customer_payments` table. `payments` already
  means payroll; do not reuse it.
- Financing today is a picture plus price ÷ 36. There is no Affirm
  integration to protect.
- Payment detection today is QuickBooks (webhook plus a 3 AM reconcile);
  `_fire_payment_received_pipeline` in `api/quickbooks.py` is the hook if
  "paid" has to flip anything.
- Follow-up sequences never re-enrol a customer (`has_ever_been_enrolled`);
  only relevant if the proposal triggers a sequence.

## Working agreement

- Code lives in the worktree `/Users/alanjoshuabonner/speedtolead-proposal`
  on branch `proposal-v2`, with its own Claude chat. This dashboard and
  `main` are edited from `/Users/alanjoshuabonner/speedtolead`.
- Commit subjects start with `Alan:`. Rebase on `main` now and then so the
  final merge stays small. New work goes in new files where possible.
- Production database access from the laptop is read-only.
- No customer names or phone numbers in this file: it ships inside the
  dashboard.

## Log

- 2026-10-09 — Worktree and branch created. This file created with the
  questions and the draft phases. The New Proposal tab added to the sidebar.
