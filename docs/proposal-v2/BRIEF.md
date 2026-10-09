# Interactive proposal (v2) — the brief

Who this is for: the Claude Code chat opened in this folder
(`/Users/alanjoshuabonner/speedtolead-proposal`, branch `proposal-v2`), and
Fragne. Alan's other dashboard work continues in
`/Users/alanjoshuabonner/speedtolead` on `main`. Read this before touching
anything.

## What Alan wants (2026-10-09, in his words, lightly tidied)

- A new customer-facing proposal: "similar to the one we have right now,
  but a little bit more interactive".
- The customer chooses the package themselves (Essential / Signature /
  Legacy).
- Real photos of real stains on the different finishes; the customer can
  pick a stain they like.
- Later, once Stripe is connected: pay the $250 deposit inside the proposal,
  with financing attached.
- Every proposal already sent stays exactly as it is. Every new send gets
  the new proposal, on the Sterling link (estimate.sterlingfencetx.com),
  not the A&T link.
- Built here, separately, so edits to the rest of the dashboard never wait
  on it: "I don't want to go back and forth."

## Working agreement

- This folder is a git worktree of the same repository, on branch
  `proposal-v2`. Commit here and push `proposal-v2`. Never commit to `main`
  from here. Merging into `main` happens from the main window when Alan says
  the proposal is ready.
- Commit subjects start with `Alan:`. End every commit message with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Rebase on main now and then (`git fetch origin && git rebase origin/main`)
  so the eventual merge is small. The main window edits `LeadDetail.tsx`,
  `Contacts.tsx` and the backend services daily; keep this work in new files
  wherever possible and touch shared files late and lightly.
- Production database from the laptop is read-only, through the pooler:
  host `aws-1-us-east-1.pooler.supabase.com`, port 6543, user
  `postgres.<project ref>`, password from `backend/.env` DATABASE_URL, and
  `SET TRANSACTION READ ONLY` first. Never write to it from here.
- Never read credentials from `~/.claude.json`. Never commit `.env` files or
  anything under `docs/` that holds customer names and phone numbers.
- Commands (run from this folder):
  - backend tests: `cd backend && /Users/alanjoshuabonner/speedtolead/backend/.venv/bin/python -m pytest tests/ -q`
    (the main folder's virtualenv works from here; 576 pass today)
  - frontend: `cd frontend && ./node_modules/.bin/tsc --noEmit -p tsconfig.app.json && ./node_modules/.bin/eslint src && npm run build`
  - local backend: `cd backend && /Users/alanjoshuabonner/speedtolead/backend/.venv/bin/uvicorn main:app --reload --port 8001`
    (8000 may be in use by the main folder)
- Deploys: Vercel builds `main` to admin.atpressurewash.com. Pushing
  `proposal-v2` should produce a Vercel preview URL per commit if the GitHub
  integration is on; that is how Alan reviews the design on his phone.
  Railway builds `main` only, so backend changes on this branch run only
  locally until merged.

## What exists today — start here

- `backend/api/proposals.py` — the public endpoints: `GET /proposal/{token}`
  (payload), `/page/{n}` (page images), `/pdf`,
  `POST /proposal/{token}/request-correction`. `_is_bot_view` filters
  iMessage link previews out of the view count; keep that behaviour.
- `frontend/src/pages/ProposalView.tsx` (333 lines) — the current page,
  which renders the PDF's page images. Public route `/proposal/:token` in
  `frontend/src/App.tsx` (the `isPublic` predicate and the `<Route>` block).
  Customer pages use raw `fetch`, never `api.request()`, which redirects to
  `/login` on a 401 and would dump a customer at a staff login.
- `database.Proposal` — `token`, `estimate_id`, `lead_id`, `status`,
  `proposal_version` (today `"pdf"` or `"custom_pdf"`), `header_variant`,
  `proposal_seq`, `pdf_data`, view counters. The natural hook: new sends
  write `proposal_version="interactive"`, the page renders by version, and
  old rows are never touched.
- Sending: `backend/api/estimates.py` builds
  `f"{settings.proposal_base_url}/proposal/{token}"` in four places.
  `PROPOSAL_BASE_URL` is a Railway env var. The Sterling domain
  `estimate.sterlingfencetx.com` is not live yet: Fragne has to add it to
  the Vercel project (Settings → Domains), then the Railway var changes. Old
  A&T links keep working because Vercel serves both domains from one build.
- Estimate data: `estimate.tiers` (`essential`, `signature`, `legacy`) and
  `breakdown` (`frontend/src/lib/breakdown.ts`); sides label helpers in
  `frontend/src/lib/fenceSides.ts`; the "what's included" text comes from
  `_build_pricing_includes` in `backend/api/estimates.py`.
- Stain colours: the Company Cam tab already keeps a colour plan per side
  (`frontend/src/components/CompanyCamTab.tsx`). Look there and in
  `services/service_catalog.py` before inventing a stain list.
- Customer-facing images belong in Supabase Storage, not Postgres BLOBs
  (metered egress). The pattern is in `database.py` near the fence-scope
  photo models and `build_mms_image()` in `api/fence_scope.py`.
- Brand: ivory `#F8F3E7`, ink `#15130F`, gold `#C9972F`, gold-light
  `#E3BE63`, bronze `#8C6224`, cedar, walnut; Tailwind `bg-ivory`,
  `text-ink`, `from-gold`; `font-heading` is Playfair. The dashboard's
  `Panel.tsx` and `accents.ts` are staff-side. The proposal is
  customer-side and must bypass the dashboard theme so dark mode cannot
  change it; `frontend/src/pages/VideoEstimate.tsx` does this on purpose.

## Decisions already made (from the on-hold payments plan; still current)

- The $250 deposit is hardcoded in six places: a named constant in
  `api/quickbooks.py`, bare `250` in `api/accounting.py`, `api/payments.py`
  (twice), `api/quickbooks.py`, `services/qb_reconcile.py`, and in
  `LeadDetail.tsx`. Centralise it before a deposit button exists.
- Stripe: nothing exists (no SDK, no env var, no account confirmed). When it
  comes: `/pay/{token}` mints a fresh Checkout Session per click, metadata
  carries the lead id, the truth is the `checkout.session.completed` webhook
  (idempotent on event id), and the ledger is a new `customer_payments`
  table. `payments` already means employee payroll; do not reuse it.
- Financing today is a PNG plus `price ÷ 36`. There is no Affirm API to
  protect.
- Payment detection today is QuickBooks (webhook plus a 3 AM reconcile).
  `_fire_payment_received_pipeline` in `api/quickbooks.py` is the hook if
  "paid" must flip anything.
- Follow-up sequences: `has_ever_been_enrolled` in
  `services/followup_engine.py` blocks re-enrolment by design. Relevant only
  if the proposal triggers a sequence.

## Suggested order

1. Design first (Alan: "we're gonna have to design it"). A static mock of
   the page with the three packages, the stain photo picker, the sides, and
   a "Reserve my spot — $250" placeholder. Alan reviews it on his phone from
   the preview URL before anything is wired.
2. Backend: `proposal_version="interactive"` on new sends, behind a
   `SystemConfig` toggle so cutover is a switch and nothing already sent
   changes. `GET /proposal/{token}` returns tiers, breakdown, sides and
   photos for the new version.
3. Save the customer's package and stain choice on the proposal, show it on
   the lead page, and text Alan and Olga the way a reply is texted today.
4. A stain photo library: an admin screen to upload and label real photos
   per finish, in the order Alan wants them shown.
5. Deposit and financing, once Alan has a Stripe account. See the decisions
   above.

## Open questions for Alan

- Which finishes, and do the real photos exist already (Company Cam)?
- Should choosing a package move the lead in GoHighLevel, and to which
  stage, or only notify?
- Financing through Stripe's own checkout (Affirm or Klarna), or a separate
  Affirm integration?
- The Sterling domain: has Fragne added it in Vercel yet?
