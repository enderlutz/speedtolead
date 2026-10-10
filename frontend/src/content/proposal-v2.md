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

### A. Packages and price — answered 2026-10-09

1. **Same three packages**, all visible, the customer picks one.
2. **Add-ons that change the price: repairs only.** A tally section where
   the customer counts what needs replacing and watches the price build.
   The customer says once whether the fence has a rot board and a cap; that
   sets the post price.

   | Item | Price |
   |---|---|
   | Picket, 6 ft pine treated | $12 |
   | Picket, 8 ft pine treated | $14 |
   | Picket, 6 ft cedar | $14 |
   | Picket, 8 ft cedar | $16 |
   | Rot board | $50 |
   | Cap | $85 |
   | 2x4 rail | $75 |
   | Post, fence with no rot board and no cap | $225 |
   | Post, fence with rot board, no cap | $255 |
   | Post, fence with rot board and cap | $350 |

   Still to confirm: the unit for rot board, cap and 2x4 (per piece, or per
   8 ft section).
3. **Changeable after picking.** Picking a package takes them straight to
   the next step (colours, or the deposit) and **texts Alan and Olga the
   moment it happens**. The GoHighLevel stage: Alan is weighing dropping
   GoHighLevel's automations altogether and running them internally with
   AI. Decision parked (see "Decisions to make" below): the proposal is
   built so every customer action is an event our side owns; GoHighLevel
   stays the text pipe and the board for now; retiring its workflows is its
   own phase after launch.

### B. Stains and photos — answered 2026-10-09

4. **Different colours for each package.** Alan has the names. The list is
   not typed in here: the stain library is built as a screen in this New
   Proposal tab, "add photo, name it, next", so Alan and Olga load the
   colours themselves, one photo at a time. About 10 to 15 colours per
   package.
5. **The real photos exist**: some in Alan's camera roll, some in Olga's,
   some already in the dashboard's stain photos. One to three photos per
   colour, depending on the colour. Tap to enlarge.
6. **Colour choice sets the price through the package**: Essential colours
   at the Essential price, Signature in the middle, Legacy the most
   expensive. Assumed until Alan says otherwise: no extra charge between
   colours inside one package, and the chosen colour pre-fills the crew's
   colour plan on the Company Cam tab.

   Before building the library, look at the existing Fence Photos
   (`frontend/src/pages/FencePhotos.tsx`) and Stain Inventory pages: some
   colour photos and stain names already live there.

### C. Deposit and financing — 7 to 9 answered 2026-10-09

7. **Two ways to pay at the end of the proposal:** a **$250 deposit**, with
   the balance due on completion once the customer is happy, or
   **financing the job** through Affirm or Klarna. The deposit is
   **non-refundable**, and paying it **books the job**: it goes on the
   schedule from there.
8. **Stripe account exists** (created 2026-10-09 under Sterling Fence
   Staining, payouts daily to the Sterling checking account). Alan wants
   **as many ways to pay as possible**: cards, Apple Pay, Google Pay,
   Affirm, Klarna. A&T will get its own Stripe account under the same login
   when it needs one; the dashboard picks the account by business.
9. **Affirm and Klarna inside Stripe.** Alan likes Klarna's pay-in-4 as an
   offer shown with the prices; still deciding the best offer. To verify
   in the sandbox before it goes on an ad: Klarna's four-payment plan is
   usually for smaller purchases (often under about $1,000) and Klarna
   decides per customer; a typical $2,400 job is more likely offered
   Affirm's monthly plan. Realistic pitch: "as low as $X a month", with
   pay-in-4 appearing on smaller jobs.
10. Open. Explained to Alan as: launch once, with the deposit working on day
    one (recommended, since Stripe is ready), or launch earlier with a
    "reserve" button that only texts us.

### D. The page itself — answered 2026-10-09

11. **Word for word:** a **one-year workmanship warranty**. Lifespan per
    package: **Essential about 1 to 2 years, Signature 2 to 4, Legacy 4 to
    7.** Nothing named to drop yet.
12. **Personal on the page:** their name, their address, the scope drawing
    with the sides, and their linear feet.
13. **Social proof:** Google reviews, definitely. Before-and-after photos of
    nearby jobs: undecided.
14. **The price expires at the end of the month.** Detail for the build: a
    proposal sent on the 29th would expire in two days, so propose a rule
    for late-month sends (for example, the end of the following month).
    The extra 10% on top of the 20% promotion: **undecided**, left open.
15. **Sterling only.** A&T appears nowhere. Look and palette: decided in
    the design pass (see Phase 1).

### E. Sending, tracking and notifications — answered 2026-10-09

16. **Same wording, same Send button as today.** One link per customer:
    **"New estimate" updates the proposal at the same link** instead of
    making a new one, so the customer always sees the latest version where
    they already looked. If they want two or three prices for different
    scopes, they sit side by side in that one proposal. (A change from
    today, where each new estimate makes a new link and the old one keeps
    working; old links sent before launch stay as they are.)
17. **Everything is tracked and both Alan and Olga are told:** opened, time
    on the page, which package they looked at longest, stains tapped,
    package chosen, deposit paid. As written up: moments (first open,
    package chosen, stain chosen, deposit paid) are texted to Alan and sent
    to Olga on WhatsApp; the running numbers (time on page, longest-viewed
    package, stain taps) show on the lead page and in the daily summary.
    Alan to say if he wants those texted too.
18. **Yes:** a PDF download, or a way to share the proposal with someone
    else (spouse, HOA).

### F. Review and launch

19. Who reviews and how: you, Olga and Fragne on real phones; ten internal
    test sends to team numbers; a sign-off at the end of each phase?
20. Launch order: Sterling domain live, then one switch, then new sends only.
    Old links untouched. Should anyone with an open estimate be re-sent the
    new one? *Recommend: no mass re-send; only on request, through "New
    estimate".*

## Design brief — Alan on today's proposal (2026-10-09)

Alan walked through the current PDF proposal page by page. What he said:

- **It's good as a PDF.** The new one gets the interactive feel without
  becoming salesy. "I don't want to make it too salesy."
- **Keep on the cover:** the customer's name, the property address, the
  date, the proposal number, and the Sterling logo.
- **The scope drawing is optional.** When we have it, it goes on the
  proposal and the "sides of fence included" list is not needed, because
  the drawing shows the sides. When we don't have it, nothing shows in its
  place and the sides list appears instead, as today. "The visual is just
  going to be a hundred times better for the customer."
- **Keep the package photos exactly as they are:** the Essential photo,
  the Signature photo, and the two Legacy photos.
- **Keep the 20% off and the same pricing guide.** The wording is fine for
  now; revisit later.
- **Add:** "two coats of stain with each application"; the one-year
  workmanship warranty; a link to the terms and conditions.
- **Details page:** Alan will send what goes there.
- **Financing:** today's "or as low as $35.27/mo for 36 mo." is not what
  customers want. "Nobody ever goes with a 36 month. They always want to
  break it down into three or four payments." The plan is Klarna's split
  in 4, shown the way the big retailers show it. (See C9 for the limits
  to verify.)

  What the texts say (read 2026-10-09, every inbound text on file):
  about 20 customers have raised money terms unprompted. They ask "do you
  offer financing?", "do you set up a payment plan?", "half down and the
  remainder in 2 weeks?", "if I can pay it monthly", and "send the Affirm
  link". Nobody has ever mentioned 36 months. Two customers paid through
  Affirm, one asked what the interest would be, and one left because
  "it's not in the budget" after talking to a spouse. The ask is for a
  split, not a long loan.

  **Research (2026-10-09), what the lenders allow through Stripe and what
  the big retailers show:**

  | Through Stripe | Amount per purchase | How it's paid |
  |---|---|---|
  | Klarna | $10 to about $5,000; **Pay in 4 usually up to $2,000**, set per customer | 4 payments, one every 2 weeks, 0% interest |
  | Afterpay | $1 to $2,000 | 4 payments, one every 2 weeks, 0% interest |
  | Affirm | $50 to $30,000 | Pay in 4 on small amounts; **monthly plans (3 to 36 months) on larger**, interest set per customer, 0% offers sometimes |
  | PayPal Pay Later (not Stripe) | Pay in 4 up to $1,500; monthly $199 to $10,000 | same two shapes |

  So for Sterling's prices after the discount (about $1,100 to $2,500):
  pay-in-4 covers Essential and Signature on most jobs and often misses
  Legacy; a monthly plan covers everything. The lender decides per
  customer at checkout; we never see or set the approval.

  What the big retailers do: one line under every price, in the lender's
  wording, and the lender handles approval at checkout. Under $2,000 the
  line is "4 interest-free payments of $X" (Klarna, Afterpay, PayPal);
  over it, "as low as $X/mo" (Affirm, Apple, Peloton). PayPal reports
  carts 39% larger and two thirds of pay-later users more likely to
  finish a purchase when the option is shown. Nobody shows "36 months"
  as the headline.

  **Recommendation:** show "or 4 payments of $X, interest-free" when the
  price is $2,000 or under, and "or as low as $X/mo" above it, with
  Klarna and Affirm both switched on in Stripe so the customer sees
  whichever fits at checkout. The "3 monthly payments at 0% interest" on
  the mockup is not a product any of them sells off the shelf; a true 3-pay
  0% plan would be Sterling's own (charge the card three times), which
  means Sterling carries the non-payment risk. Not recommended. Fees to
  keep in mind: the pay-later methods cost about 6% + 30¢ per payment
  versus 2.9% + 30¢ for a card.
- Alan is sending a newer mockup he started, for direction. Then the first
  mockup gets built from all of this and iterated.

### The mockups Alan sent (2026-10-09, second pass)

- **Packages page ("Three ways to protect your fence").** Alan: "I like
  what we have here… I think it looks great", maybe still a little salesy.
  Headline "Three ways to protect your fence. Same expert service.
  Different levels of protection." A banner: "All packages include two
  coats of stain and a 1-year workmanship warranty." Three cards, each
  with its photo, a "Lasts N years" seal, two or three short lines, the
  regular price struck through, the 20% off price, and a payment line.
  Footer: "Choose based on the condition of your wood and the look you
  want." Lifespans on the mockup read 1–3 / 3–4 / 4–7; Alan's own words
  earlier were 1–2 / 2–4 / 4–7. Confirm which.
- **Cover page (the VA's draft).** Rep and customer looking at the fence
  instead of the family photo. Alan: "I like the family a lot… something
  we can figure out later." Keeps the icons row (Scope of work, Pricing,
  Finish options) and the facts bar (Prepared for, Date, Proposal #,
  contact).
- **What you get page.** Professional fence preparation: full prep wash;
  premium materials; **"Two coats of stain with attention to boards,
  edges and details"** (replaces "controlled application / consistent
  coverage"); clean jobsite. Our proven process and guarantee:
  package-backed guarantee; 5.0 Google rating; fences restored (the mockup
  says 800+, the current PDF says 1,500+ — confirm); **7+ years of
  experience**, not 5+.
- **Neighborhood special.** Alan is leaning away from "10% more if a
  neighbour books within 7 days": "seven days might be too soon… I think
  it'd be better to say if anybody else wants to get it done, you both get
  an extra $100 off, and there's no time frame on it." Written into the
  mockup that way; decision still his.
- **Signature Finish photos page (in progress).** Real job photos with
  the colour name on each: Redwood Naturaltone, Cedar Naturaltone, Cottage
  Gray, Pecan, Monticello Tan, Redwood, Dark Walnut, Chocolate Chips.
  This is the shape of the stain library.
- **Financing on the mockup** reads "or 3 monthly payments of $421.20 at
  0% interest". Alan asked for research on what works best (split in 4
  versus 3 monthly) and what the big companies do; see the research note
  under C9.

### What today's proposal contains (so nothing gets lost)

1. Cover: logo; Prepared for; Property address; Prepared by; Date;
   Proposal #; phone, email, website; "Fence Restoration Proposal" with the
   family photo; "Proposal includes: scope of work · pricing · finish
   options".
2. Packages: Essential Seal (Entry), Signature Finish (Most popular),
   Legacy Finish (Premium), each with a photo, two or three lines, the
   list price struck through, the 20% off price, and the monthly figure.
3. Details: Professional fence preparation (complimentary cleaning;
   removes grey weathering, dirt and mildew; ideal surface for stain;
   maximises durability); Our proven process and guarantee (everything
   included; professional cleaning; premium stain; labour and cleanup;
   1,500+ fences restored; 7+ years); Neighborhood special, save 10% more
   when a neighbour books within 7 days.
4. Colour charts: Signature (transparent and semi-transparent) and Legacy
   (solid). Essential is clear coat only.
5. The web wrapper around the PDF: "Sides of fence included in the price"
   list, "Pay over time with Affirm", a call button, and a footer
   "Sterling Fence Staining · Cypress, TX".

### Today's colour chart (names as printed on the PDF)

A starting list for the stain library. Alan and Olga add the real photos
in the tab; names can be corrected there.

- **Essential Seal:** clear coat only, no colours.
- **Signature Finish, lighter tones (transparent):** Honey Gold, Cedar
  Naturaltone, Redwood Naturaltone, Canyon Brown.
- **Signature Finish, darker tones (semi-transparent):** Rusticana, Redwood
  Naturaltone, Cedar Naturaltone, Simply Cedar, Badlands Red, Quiet
  Chamois, Ferret, Monticello Tan, Potato Skin (printed "Patato Skin"),
  October Brown, Mixed Nuts, Hot Chocolate, Pinebark, Chocolate Chips,
  Found Fossil, Cottage Gray.
- **Legacy Finish, solid colour:** White Out, Simply Cedar, Pinebark,
  Chocolate Chips, Darkest Night, Toasted Armado, Silver Mine, Galapagos
  Grey, Creamy Glen, Coral Beach, Snowstorm, Heartland's, Ghosted Sand,
  Carlsbad Dawn (printed "Carlbad Dawn"), Saddlebag Tan, Quiet Chamois,
  Parisian Gray, Smoked Leather, October Brown, Classic Mahogany, Badlands
  Red, Rusticana, Potato Skin, Plymouth Red.

### The first mockup (built 2026-10-09)

Open it with the **Open the mockup** button at the top of this page
(`/new-proposal/mockup`). Staff only; a made-up customer; every button
changes only that page. It follows the brief above:

1. Top bar: logo and a gold "Call or text" button.
2. Cover: the family photo from today's PDF, "Hi Jordan, here's your fence
   plan", then Prepared for, Date, Property, Proposal #, and the date the
   price is good through (end of the month).
3. Step 1, Your fence: the scope drawing when there is one (a stand-in
   drawing with the editor's blue and red lines), or the "sides included"
   list when there isn't. The staff bar toggles between the two.
4. Step 2, Pick your package: the three cards with the PDF's own photos, a
   "Lasts N years" seal, two or three lines, regular price struck through,
   20% off, the price, and the payment line ("or 4 payments of $X,
   interest-free" up to $2,000, "or as low as $X/mo" above). Banner: two
   coats and the 1-year warranty on every package.
5. Step 3, Pick your color: for Signature, eight real job photos (tap to
   enlarge, tap the name to pick); for Legacy, the 24 solid colours as
   swatches until their photos are loaded; Essential says clear coat.
6. Optional, Anything need replacing?: the repair tally with Alan's
   prices. "Your fence has a rot board / a cap" sets the post price.
7. What you get: prep and process lists, the neighbour offer written as
   "$100 off for both of you, no deadline".
8. Google reviews: 5.0, with sample quotes marked as samples.
9. Save as PDF, Terms, and the sticky bottom bar: the package, the colour,
   the repairs, the total, the payment line, and "Reserve my spot · $250".

Not in it yet: the deposit and financing checkout (Stripe), a real scope
image, real reviews, the Legacy and remaining Signature photos.

**Second pass (Alan, 2026-10-10), all done in the mockup:**

- **Packages side by side**, three across on the phone too, so the
  colours fit below without a long scroll. "I think we have definitely
  advanced into a good direction."
- **Two photos** on Signature and on Legacy (the PDF's own: Legacy orange
  and dark; Signature's two from Alan's mockup). Essential keeps one.
- **Repairs:** no "rot board / cap" questions. Posts are three lines by
  fence height: 6 ft fence $225, 7 ft fence $255, 8 ft fence $350, same
  prices as before.
- **Colours open to everyone**, package picked or not: two tabs,
  Signature (photos) and Legacy (swatches), compact. Picking a colour
  picks its package, with a line saying so. A "Don't see your color? Tell
  us what you have in mind" box, because some customers want a colour
  that isn't on the chart and we help them find it.
- **Paying:** a "How would you like to pay?" step with two cards, Reserve
  my dates ($250 today, the rest when done) and Pay over time (Klarna's
  four payments, Affirm's monthly), both going to the same Stripe
  checkout where the customer picks the lender. The sticky bar keeps the
  total, the pay-over-time line and the $250 button.
- **Wording checked against the lenders' own rules** (Klarna's US
  promotion rules, Afterpay's and Affirm's messaging guides): Klarna's
  approved line is exactly "4 interest-free payments of $X"; Afterpay's
  is "or 4 payments of $X with Afterpay"; Affirm shows an estimated
  monthly figure, "As low as $X/mo". The mockup uses those words. For the
  build: Stripe's **Payment Method Messaging Element** renders these lines
  itself, with the right lender, amount and eligibility, so the real page
  should use it instead of hand-written text.
- **No scope drawing → say the size.** "About 280 ft of fence" plus the
  sides list. Not the gallons: "that's a little overkill." Personal, not
  salesy, very simple.
- **The warranty terms, in plain words**, behind the Terms button: peeling
  or cracking from our application, we come back and touch it up for a
  year; damage from anything else (the lawn guy, a replaced board, the
  customer) is on them, and we give them the exact stain name so they can
  buy it at the nearest store. "7+ years hands-on experience staining wood
  fences." Two coats, and we keep stain off the black hinges and hardware.

## The three phases (draft until the questions are answered)

### Phase 1 — Design and plan

- Answer the questions above; the answers get written into this file.
- Alan walks through screenshots of the mockups he has already tried and of
  today's proposal: what he likes, what he doesn't. That is the design
  brief for the first mockup.
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

## Decisions to make

- **Retire GoHighLevel's automations?** Alan (2026-10-09): "take out
  GoHighLevel's automations altogether and just use AI to automate this…
  have all our automations internally." The dashboard already owns the
  follow-up engine, the objection scanner and the sending; GoHighLevel's
  workflows (intake text, estimate-sent follow-ups, stage moves) are the
  remaining piece. Treat as its own phase after the proposal launches, with
  the proposal's events (opened, package picked, stain picked, deposit paid)
  as its inputs.

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
