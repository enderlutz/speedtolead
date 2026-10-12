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
   | Picket, pine (any height) | $12 |
   | Picket, cedar (any height) | $14 |
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
- **Package cards must read in full** (Alan, 2026-10-10, after seeing a
  competitor's estimate page that copied the three packages: "you can
  still read the information about each package"). Three squeezed columns
  on a phone looked "too elongated… not very professional". Now each card
  has the full layout: photo(s) with a "20% off" badge, one-line name,
  tag, "Lasts" chip, a "Best for" box, the price with the regular price
  struck, the lender line with its mark, three bullets, a button. On a
  phone the three cards are a row you swipe, starting on Signature with
  the neighbours peeking in and three dots underneath; at full width,
  three columns.
- **All three packages on one screen, no scrolling** (Alan, 2026-10-10:
  "they should be able to see all of them on one page"). On a phone the
  packages are a compare grid: the three photos and names across the top,
  then rows that line up (Lasts; Price with the regular price struck and
  "or 4 × $X"; Best for; Adds color; Shows the wood grain; Hides
  imperfections; Sun and water protection as Good / Better / Best), and
  three Pick buttons. Tapping a photo or a button picks; the picked column
  lights up. At full width, three full cards.
- **The payment line, PlayStation's way** (Alan, 2026-10-10, from
  direct.playstation.com: "From $40/month, or 4 payments at 0% interest
  with Klarna. Learn more"). Adopted everywhere a price shows. The monthly
  figure is not our math: Klarna's messaging returns it from Klarna's real
  plans for the exact amount, and on the real page Stripe's Payment Method
  Messaging Element does the same. The mockup estimates it the way Klarna
  does, lowest rate over the longest plan (7.99% APR, 24 months), rounded
  up: $1,450.80 → "From $66/month, or 4 payments of $362.70 at 0% interest
  with Klarna." Above $2,000 only the monthly figure shows.
- **"Learn more" opens Sterling's own Klarna FAQ**, rewritten from
  PlayStation's Klarna page for a fence job: what Klarna is, how to use it
  here, what you need, how the 4 payments run (today, then 14, 28 and 42
  days), fees (none on time; up to $7 late), the soft credit check,
  monthly plans ($200 and up, 7.99% to 29.99% APR, WebBank), what happens
  if something changes on the job, and that Klarna is the lender, not
  Sterling. Nine questions, plain words. The numbers are Klarna's own
  published US terms; the real page links to Klarna's current terms.
- **Klarna and Affirm, each with a Learn more, side by side** (Alan,
  2026-10-10). The Klarna answer about "what if something changes on the
  job" no longer mentions the $250 deposit: a customer who paid through
  Klarna never paid one. It now says: more on the day is a separate
  payment at completion; less is refunded through Klarna, which lowers
  what they owe. Affirm has its own FAQ in the same words (4 payments on
  smaller amounts, monthly 3 to 36 months, 0% to 36% APR, no late fees,
  soft check, Affirm's partner banks lend), and one sheet holds both with
  a compare table at the top: 4 payments, monthly plans, credit check,
  late fees, who lends. Every Learn more opens that sheet on the lender
  tapped.
- **Legacy's tile** (Alan, 2026-10-10: Essential and Signature "look
  perfect", Legacy needed work). The PDF's second Legacy image is a
  near-black wood texture that disappeared into the tile's dark band on a
  phone. It is now the Darkest Night fence from Fence Photos, and a thin
  gold seam separates the two photos and the band under them. To confirm
  with Alan: keep the real fence, or go back to the PDF's texture.
- **The checkout screens, in the mockup** (Alan, 2026-10-10: "what the
  page should look like when they click Reserve my spot, and the one for
  See my options"). Both open a Stripe Checkout page drawn the way Stripe
  draws it on a phone, in Sterling's branding (dark header with the logo,
  the amount, the line items; Apple Pay and Google Pay up top; then the
  payment-method list; a gold Pay button; "Powered by Stripe"). The
  deposit page: $250 today, the balance shown as due on completion, card
  only below the wallets, the non-refundable line under the button. The
  pay-over-time page: the whole job, with Card, Klarna and Affirm in the
  list; Klarna's row shows its "4 payments or monthly" line and Affirm's
  its "as low as" line, and the button becomes "Continue to Klarna /
  Affirm", since the customer finishes on the lender's page. The real
  pages are Stripe's hosted Checkout with branding set in the Stripe
  dashboard (logo, colours); nothing here is custom-built. After a
  payment: a stub ("You're booked" / "Paid in full") until Alan's
  post-payment flow arrives. Alan: the $250 "sets the tone for the job";
  the balance payment after the job is where the Google review and the
  referral ask live. His flow is coming.
- **A small FAQ, from what customers actually ask** (Alan, 2026-10-10:
  "the twenty most asked questions… implement three or four"). Read every
  inbound text with a question mark: 1,023 texts from 458 customers. By
  customers asking: price 162; when can you come 66; which sides, gates,
  what's included 65; colour 62; repairs 48; how to pay 41; the neighbor's
  side and overspray 40; how long it lasts and the warranty 38; cleaning
  first 32; how long the job takes 23; HOA approval 23; what product 22;
  rain 14; pets and plants 15. Price, sides, colour, paying and the
  warranty are answered by the page itself, so the FAQ takes the next
  four: the neighbor's side and overspray; how long it takes; will I know
  the repair price first; does my HOA need to approve the colour. Folded
  until tapped, between What you get and the reviews. **The answers are
  drafts; Alan confirms the facts** (how the other side is shielded; two
  visits, clean then stain; repairs found on the day are priced before
  touched; HOA colour approval).
- **Why financing is on the page at all** (Alan, 2026-10-10): the 20% off
  ends at the end of the month and the price goes back up. Financing lets
  a customer lock in the discount now, even if the job happens in a month
  or two, without having the money today; the price was the reason they
  were waiting. In the mockup, in one quiet line each, never a countdown:
  under the price ("20% off · ends October 31"), at the top of the pay
  step ("Your 20% off ends October 31. Book now and this price is locked,
  even if we do the job next month. Paying over time means you don't need
  the money today."), and on the pay-over-time card ("Were you going to
  do this in a month or two anyway? Lock in today's price and spread the
  payments."). Wording is Alan's to tune.
- **Extras on the day, decided** (Alan, 2026-10-10): if the job ends up
  costing more, the customer gets another payment link at the end of the
  job with everything Stripe offers on it, card, Apple Pay, Google Pay,
  Klarna, Affirm, and pays the extra however they like. Same link
  machinery as the balance page. Both FAQs say so.
- **Open for Alan:** if a customer who paid the whole job through Klarna
  or Affirm cancels after the dates are set, does the $250 booking rule
  still apply (kept back from the refund)? One rule for everyone is the
  simplest to explain. Not written anywhere yet.
- **Legacy colours are real photos now** (Alan, 2026-10-10: "go to our
  solid Valspar line on the fence photos… bring the best photo out of
  there, one per colour, and delete the swatches"). Ten colours from the
  dashboard's Fence Photos, Valspar solid line, served straight from the
  photo storage: Simply Cedar, Pine Bark, October Brown, Potato Skin,
  Chocolate Chip, Classic Mahogany, Plymouth Red, Galapagos Grey, Silver
  Mine, Darkest Night. Picked for a clean fence, good light, nobody and
  nothing in the frame, no watermark. Two Valspar solids have no photo
  yet: Cedar Naturaltone and Midnight Gray. The 24-colour chart from the
  PDF stays in the notes above for the photo library.
- **Phone packages, third pass** (Alan, 2026-10-10: "make the three
  packages look most appealing for how somebody would look at them on
  their phone… holy shit, this company knows exactly what they're doing").
  Three tall photo tiles, always in view, each with its name, price and
  "Lasts" on the photo; the tapped one (Signature until they tap) opens in
  full right below: Best for, the two lines, the price block with the
  lender line, and the Pick button. Pictures first, words second. Package
  lines in Alan's words: Essential "Clear protection · Refreshes your
  fence"; Signature "Enhances the natural wood grain · Balances protection
  and beauty"; Legacy "Solid color protection · Maximum coverage and
  durability".
- **Posts: one "Post replacement" line** with a 6, 7 or 8 ft fence choice,
  like the pickets, instead of three post lines. Same prices ($225, $255,
  $350).
- **No scope drawing → the sides only, no footage** (Alan, 2026-10-10,
  correcting the earlier note): when the fence couldn't be seen, the bid
  is padded on purpose, "because it's better to give them a price than
  nothing", so a footage number next to it would invite the wrong
  conversation. With a drawing, the footage shows. Not the gallons:
  "that's a little overkill." Personal, not salesy, very simple.
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

- **Invoicing: QuickBooks or Stripe?** Decided 2026-10-10 by the payment
  decision below: the balance page has to offer Klarna and Affirm, which a
  QuickBooks invoice cannot, so the balance goes through Stripe and
  QuickBooks stays the books through a sync. Fragne to confirm the sync.

- **Retire GoHighLevel's automations?** Alan (2026-10-09): "take out
  GoHighLevel's automations altogether and just use AI to automate this…
  have all our automations internally." The dashboard already owns the
  follow-up engine, the objection scanner and the sending; GoHighLevel's
  workflows (intake text, estimate-sent follow-ups, stage moves) are the
  remaining piece. Treat as its own phase after the proposal launches, with
  the proposal's events (opened, package picked, stain picked, deposit paid)
  as its inputs.

## The payment decision (Alan, 2026-10-10: "sounds good, make it happen")

Two doors on the proposal, and every way to pay again on the balance page.

1. **Reserve my dates** — $250 today, the rest when the job is done and
   the customer is happy. The big gold button; what most people tap.
2. **Pay over time** — Klarna or Affirm approves them, they pay the
   lender, Sterling is paid in full at checkout, before the job.
3. **The balance page at completion** offers the same ways to pay as the
   proposal: card, Apple Pay, Google Pay, Klarna, Affirm. A customer who
   paid $250 up front can finance the remainder there. No third button on
   the proposal: that's where "deposit now, finance the rest" lives.

Why: a third choice makes the customer think about money twice before
they've picked a colour; the balance is a smaller number, so more jobs fit
under Klarna's pay-in-4 ceiling (a $1,840 Legacy job: $1,590 after the
deposit); and the pay-later fee is paid only on the part that is financed.
Known trade-off of door 2: the customer is charged before any work is
done, which is why door 1 stays first.

## How Stripe ties it together (proposed 2026-10-10)

Alan: "be thinking about how we're going to integrate Stripe into this so
that everything can be seamless, even the invoicing of our company."

- **One Stripe customer per lead**, with the lead id in the metadata, so
  every payment lands on the right customer on the dashboard.
- **The deposit:** a Stripe Checkout Session for $250 (card, Apple Pay,
  Google Pay). The `checkout.session.completed` webhook marks the deposit
  paid, books the dates, and fires today's payment-received pipeline so
  QuickBooks gets the deposit the way it does now.
- **Pay over time:** a Checkout Session for the whole job with Klarna and
  Affirm switched on. Klarna or Affirm pays Sterling in full; the same
  webhook marks both the deposit and the balance paid.
- **The payment line under every price:** Stripe's Payment Method
  Messaging Element, which prints Klarna's "From $X/month, or 4 payments…"
  for the exact amount and handles eligibility. "Learn more" opens the FAQ
  sheet above (or Klarna's own).
- **The balance on completion. Two doors; Alan picks.**
  1. Keep QuickBooks invoicing as today (QuickBooks Payments, the
     customer pays the QuickBooks invoice).
  2. Move the balance to a Stripe Invoice: the crew marks the job done,
     the customer gets one text with a hosted Stripe invoice (card, bank
     transfer, and the pay-later options if Stripe allows them on
     invoices, to verify), the `invoice.paid` webhook closes the job, and
     QuickBooks stays the books through Stripe's QuickBooks Online sync
     (or our own posting, as now). One look for the customer from proposal
     to final payment, and Klarna on the balance too.
  The trade-offs to weigh: card fees (Stripe 2.9% + 30¢ versus QuickBooks
  Payments), the accountant's workflow, and that every money change today
  has to be made in both the webhook and the 3 AM reconcile (see the
  payments plan).

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

## Readability rule for the customer's page (Alan, 2026-10-10)

"We want it to be old-person proof." Applied to the mockup and binding
for the real page: no text under 12px; body text 15px; prices big; muted
text no lighter than 75% ink; every tap target at least 44px; three
colour tiles to a row so the names read; the repair drawings big, with
thick lines, the part lit in gold with a dark edge, and a plain-words
caption under each ("the board along the ground"). Pictures first, few
words, one thing to do per screen.

## Working agreement

- Code lives in the worktree `/Users/alanjoshuabonner/speedtolead-proposal`
  on branch `proposal-v2`, with its own Claude chat. This dashboard and
  `main` are edited from `/Users/alanjoshuabonner/speedtolead`.
- Commit subjects start with `Alan:`. Rebase on `main` now and then so the
  final merge stays small. New work goes in new files where possible.
- Production database access from the laptop is read-only.
- No customer names or phone numbers in this file: it ships inside the
  dashboard.

## After the payment (Alan's spec and prototype, 2026-10-10)

Alan built a clickable prototype of the screens after a payment, with a
build spec, and said: not word for word, this is the idea; financing is
not in it and working that in is ours; the goal is this plus the
invoicing live by 2026-10-11, on Stripe. The mockup now runs both flows
after its fake Stripe checkout, in the proposal's own look.

### Flow A, after the $250 deposit (job not done, so no survey)

1. **Locked in.** "You're locked in, {first name}. Your spot on our
   schedule is yours. We'll text your start date within 24 hours." Card:
   deposit paid, package, address, due after the job. View receipt.
2. **Five things before we show up.** You don't have to be home; water and
   power; clear the fence line; sprinklers off the day before, of and
   after; pets inside on job days. Got it.
3. **Your neighbors' fences are aging too.** $100 off for you / $100 off
   for your friend. Text a friend (Messages opens with the text written),
   Copy link, Share. The link in plain text. "Your $100 off applies once."
   No countdown, no time limit, no percentage.
4. **Done.** "That's it. We'll take it from here." Phone number.

### Flow B, after the final payment (job done)

Referral comes before the review, so nobody leaves for Google first.

1. **Paid in full. Thank you, {first name}.** Receipt card. (The
   before/after slider is parked until job photos exist.)
2. **How did we do?** 0 to 10, saves on tap, can be changed. Optional
   "Anything we could do better?"
3. **Know someone whose fence needs this?** $100 off for them / $100 to
   you when their job is done. Same three share buttons.
4. **Would you share your experience on Google?** One button, identical
   for every score, skipped scores included; never hidden or moved. A
   score of 0 to 6 also shows "Want Alan to call you personally?" The
   review is never tied to the referral reward.
5. **Anything else we can help with?** Chips: house wash, driveway and
   concrete, window cleaning, roof washing, gutter cleaning, sprinkler
   repair, landscaping, other. Finish. (The "when should we check back on
   your fence" question is out on purpose. Fence repairs came off the list
   on 2026-10-10: once the fence is stained it's usually too late.)
6. **Enjoy the fence.** The touch-up stain is in the garage. Phone. "OK to
   feature my comment?" only if they wrote one.

Rules for both: one idea per screen; Skip on every screen but the
confirmations; progress bar on top; every answer saved the moment it is
tapped, not at the end; nothing from QuickBooks where the customer looks.

### Where Klarna and Affirm fit

| What they paid | How | Screens | What is left |
|---|---|---|---|
| $250 deposit | card, Apple Pay, Google Pay | Flow A | the balance after the job, by card or Klarna or Affirm |
| the whole job, up front | Klarna or Affirm. Stripe pays us in full; the customer repays the lender | Flow A, "Paid in full through Klarna", "Nothing more is due to us" | nothing. The balance link never goes out |
| the whole job, up front | card | Flow A, "Paid in full" | nothing |
| the balance, after the job | card or Klarna or Affirm | Flow B | nothing |

The catch: Flow B is "after the final payment", and a financed customer
makes no final payment. So Flow B fires on **job done with a zero
balance**, not on a payment. For a card customer paying at the end the two
happen at once. For a financed customer, the crew marking the job complete
sends the text with the Flow B link. The mockup's staff bar has both
entries ("Balance link" and "Paid up front").

The $100 referral credit comes "off the balance", which works for deposit
customers. A financed customer has no balance, so theirs comes back as a
partial refund through Stripe (the lender adjusts their plan) or a credit
on the next job. Alan's call.

More work after the job (extra repairs): a separate balance link, same
checkout, all three methods, as already decided.

### How Stripe runs it (the real build)

- Every link is a token page on our side, `/pay/{token}`, never a raw
  Stripe URL. Opening it creates a fresh Checkout Session (sessions expire
  in 24 hours; a texted link cannot). `client_reference_id` is the lead id;
  metadata carries lead id, kind (deposit, full, balance, extra), package
  and amount.
- Payment methods on the session: card and wallets always; Klarna and
  Affirm on full and balance, never on the $250 deposit. Stripe shows the
  lender's own messaging at checkout.
- Truth is the webhook (`checkout.session.completed`, idempotent on the
  event id), never the redirect. The webhook writes a `customer_payments`
  row (lead id, kind, amount, method, Stripe ids), fires the GHL tags, and
  mints the after-pay token. The success URL is `/after/{token}`: Flow A
  or B by kind.
- Every tap on the after-pay screens posts to `/after/{token}/answer`:
  score, comment, review_clicked, callback_requested, referral_shared
  (how), prep_acknowledged, services_interested, feature_permission,
  skipped. Saved on tap. Public pages use raw `fetch`, never the
  dashboard's API client, which bounces a 401 to the staff login.
- Job done: the crew's "complete" in the dashboard. Balance owed: text the
  balance link. Balance zero: text the Flow B link.
- QuickBooks stays the books. The webhook marks (or creates and marks) the
  QuickBooks invoice paid with the lead id in the memo, through the
  existing QuickBooks client. The customer never sees QuickBooks.
- Refunds, the $100 credit and payouts run through Stripe. The daily
  payout to Sterling checking is already set.
- GHL automations, placeholder names to map to the live ones:
  `deposit_paid` (Scheduling stage, task "text the start date in 24h"),
  `paid_in_full_upfront`, `prep_confirmed`, `referral_shared`,
  `paid_in_full` (Complete stage), `nps_promoter` / `nps_passive` /
  `nps_detractor` (text Alan on a detractor), `review_link_clicked`, task
  "Alan calls the customer", one lead per service chip,
  `testimonial_permission`. A comment becomes a note on the contact.

### Data captured

| Field | Flow | Values |
|---|---|---|
| payment | A, B | amount, kind, method, Stripe payment id |
| receipt_viewed | A | yes/no |
| prep_acknowledged | A | yes/no |
| referral_shared | A, B | any of text, copy link, share sheet |
| score | B | 0 to 10, or empty |
| comment | B | free text |
| review_clicked | B | yes/no |
| callback_requested | B | yes/no |
| services_interested | B | list, plus the text for Other |
| feature_permission | B | yes/no |
| skipped_screens | A, B | list of screen names |

### Decisions for Alan before this goes live

- ~~The look.~~ Decided 2026-10-10: black and gold, the proposal's own
  look, not the prototype's green and cedar.
- The referral domain: `sterlingfencestaining.com/r/{CODE}` in the spec;
  the proposal is planned for `estimate.sterlingfencetx.com`. Alan
  doesn't know yet and asked to be walked through how referral links
  work; the explanation is in the chat of 2026-10-10 and the short
  version is under "How a referral link works" below.
- The phone on the Done screens is Sterling's, 346-589-7877. The email.
- Sprinklers: "the day before, the day of, the day after" is a guess.
- The $100 for a financed customer: Alan leans refund through Stripe
  (2026-10-10). A partial refund on the Klarna or Affirm payment goes back
  to the lender, who shrinks the customer's remaining payments; the
  customer sees it on their lender app, not from us, so the text that
  announces it has to say so.
- Flow B's $100 to the referrer: capped at once, like Flow A?
- ~~Keep "Fence repair / boards"?~~ Removed 2026-10-10. "Other" stays.
- Referral codes: first name plus a number in the mockup. Real ones are
  unique and stored, and a booking through `/r/{CODE}` tags the new lead
  with who sent it.
- Cancellation after financing: still open from earlier.
- The live GHL tag, pipeline and stage names.

### How a referral link works

Each customer gets a code, stored on their lead (`SARAH14` is the shape;
real ones are made unique by the backend). Their link is our domain plus
`/r/` plus the code. When a friend opens it, the page sets a cookie with
the code, shows the $100 offer and a short form that creates a lead in
GHL tagged with the referrer's lead id. When that friend's job is paid in
full, the referrer's $100 fires: off their balance if they still owe one,
or as a Stripe refund if they paid up front. Which domain hosts `/r/` is
only a DNS choice: any domain Sterling owns, pointed at the dashboard's
Vercel project, works, and the shorter the better for a text message.

### The friend's preview link (2026-10-10)

`/preview/proposal/<token>` is public and shows one real estimate, by
Alan's decision ("approve the public endpoint"). The token is in
`backend/api/proposal_preview.py`; delete it there once the friend has
looked, and the link dies.

### Built on 2026-10-10 (night): the payment rails, in code

Live on the next deploy, inert until the keys are in Railway:

- **Backend** `api/stripe_pay.py`, tables `pay_links` and `customer_payments`
  (not `payments`, which is crew payroll). Settings `STRIPE_SECRET_KEY`,
  `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` in Railway.
- Staff: `POST /api/leads/{id}/pay-links` (kind deposit, full, balance,
  extra, done; amount), `GET …/pay-links`, `POST /api/pay-links/{token}/void`.
  On the lead page, the Payment links panel has a "Stripe links" card:
  amount, four buttons, copy, void, paid status.
- Customer: `/pay/{token}` shows the amount and one Pay button, which asks
  `POST /api/pay/{token}/session` for a fresh Checkout session and goes to
  Stripe. Deposit is card and wallets only; the rest take whatever is
  switched on in Stripe (turn Klarna and Affirm on there).
- Stripe calls `POST /api/stripe/webhook`
  (`https://speedtolead-production-f980.up.railway.app/api/stripe/webhook`,
  events `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`). It books the payment once per
  session, marks the link paid and flags the lead's deposit fields.
- `/after/{token}` runs Flow A or B for real, resumes saved answers, and
  posts every tap to `POST /api/pay/{token}/answer`. If the webhook is a
  few seconds behind, `GET /api/pay/{token}/after?s=` checks the session
  with Stripe and books it the same idempotent way.
- Eight backend tests cover links, sessions, the webhook's signature and
  retries, and the answers.

Also in, later the same night (`services/after_pay_hooks.py`):

- **Text** on the card sends the link through GHL with a message written
  for its kind, refuses a do-not-contact lead or one with no phone, and
  stamps "texted" on the link. `POST /api/pay-links/{token}/send`.
- **Off a payment:** tag `deposit_paid`, `paid_in_full_upfront`,
  `extra_paid` or `paid_in_full`; a note on the contact; a text to Alan.
- **Off each tap:** `prep_confirmed`, `referral_shared`, `nps_promoter` /
  `nps_passive` / `nps_detractor` (a text to Alan on a detractor), the
  comment as a note, `review_link_clicked`, `callback_requested` (a text
  to Alan), `wants_<service>` tags plus a note and a text to Alan,
  `testimonial_permission`. A changed score adds the new band's tag; the
  old one stays (GHL tag removal isn't wired).
- **Job done:** when the crew marks a job complete and the switch on the
  card is on (`stripe_auto_balance_link`, off by default), the balance
  link is made for the price less everything paid (a QuickBooks deposit
  counts) and texted; nothing owed makes the all-paid link instead. Never
  a second open link for the same lead. No price on the job: nothing.

Not yet: the QuickBooks mark-paid, one lead per service chip (today it's a
tag, a note and a text to Alan), and the referral engine.

### What "by tomorrow" can mean

Real by 2026-10-11, in Stripe test mode, behind the launch gate: the token
pay page with Checkout Sessions, the webhook and the ledger, the after-pay
pages and the answer endpoint, the job-done texts, the QuickBooks
mark-paid. From Alan: a $1 test payment on his phone, the decisions above,
and the Sterling domain before anything is texted to a customer.

## Why three tiers, and why they wear three coats (research, 2026-10-11)

Alan (2026-10-11): the three packages had the same fonts and colours, so a
customer couldn't tell what they were getting. "The legacy needs to seem
really premium, the signature very popular, and the essential the very
minimum you'd at least get." What the big companies do, and why:

- **Why a Best exists.** It is the anchor. Next to it the middle looks like
  the sensible choice, and a slice of customers who would have bought the
  middle trade up. Rafi Mohammed's HBR work ("The Good-Better-Best Approach
  to Pricing", 2018) calls the top tier the offensive play (margin and
  trade-ups), the bottom tier the defensive play (keeps the price shopper
  from leaving for a cheaper outfit), and the middle the behavioural play
  (the Goldilocks choice: the decision stops being "buy or not" and becomes
  "which one").
- **The numbers.** Pricing-page benchmarks put the highlighted middle tier
  at about 58% of buyers on three-tier pages; a "most popular" badge alone
  lifts conversion about 11%, visual prominence alone about 14%, the two
  together about 21%. A top tier priced as the anchor lifts the middle's
  take-rate roughly 18%. Three tiers decide in about 47 seconds; five or
  more take over a minute and a quarter. Rafi's guardrails: Good no more
  than ~25% under Better, Best no more than ~50% over Better, no more than
  four things different between neighbours, every higher tier keeps all of
  the lower one. Ours: Essential sits 14% under Signature, Legacy 28% over.
  Inside the band.
- **How they dress it.** Premium is always the darkest, richest coat with
  a metal: Amex Gold then Platinum then the black Centurion, Apple's "Pro"
  in black titanium, Uber Black, Delta Silver/Gold/Platinum/Diamond. Dark
  tones read as scarcity and stability, a metallic as craftsmanship, and
  fewer colours as higher value (80%+ of luxury identities use gold, navy,
  burgundy or onyx). The middle tier gets the warm, bright highlight and
  the badge. The entry tier is plain and light: present, honest, not
  dressed up.
- **What we did with it.** Essential on light clear wood with a sage
  "Entry" badge, the name in green. Signature in gold with a dark-brown
  "Most popular" ribbon. Legacy in black inside a thin gold frame with a
  gold "Premium" badge and a gold price. Same rows and sizes on all three,
  so the names and prices still line up; only the coat changes. Same on the
  three-column desktop cards, with the name and badge heading each column
  like the printed proposal.

Sources: hbr.org/2018/09/the-good-better-best-approach-to-pricing;
visionary-marketing.co.uk pricing-page conversion benchmarks (2026);
zoviz.com luxury brand colour study.

## Payment rules Alan settled on 2026-10-11 (evening)

- **Two doors after the package pick.** "Reserve my spot, $250" (card or
  wallet) or "Finance it, $0 today" (Affirm or Klarna for the full proposal
  price). Financed customers skip the deposit: Affirm approves them on the
  proposal, before the crew goes, and pays Sterling in full. Nothing is
  financed after the work is done.
- **The office** is Alan and Olga (Olga is "Amy" to customers). Only they
  confirm a final total, price an extra, and click the balance link. The
  balance link stays a human click: "I don't want an AI bot sending
  invoices yet."
- **Final total** is usually the proposal price. It changes when the
  package changes (an HOA forcing Legacy down to Signature) or extras are
  added. A paid deposit freezes that customer's proposal price list for the
  whole job, whatever the date.
- **Extras**: approved on site, paid at the end. The cleaner marks broken
  pickets in red and puts the count and wood in the crew app, no price.
  The office texts "20 pine pickets, $240, tap to approve". The tap adds it
  to the job total; one balance link at the end carries everything. Nobody
  on the crew says a price.
- **$250 is non-refundable**, said plainly on the proposal, and the date
  can be moved any time. Alan refunds by hand in Stripe when it's the
  decent thing to do; no exceptions written down.
- **Deposit links die at 7 days.** Not overdue, gone. Until then they sit
  in a "Deposits pending" list on the Dashboard (the daily who-to-call) and
  on the money page. A new send makes a new link.
- **Nothing reaches QuickBooks until money lands.** One invoice per job,
  numbered with the proposal number, created on the deposit with the
  package line, updated to the final total, each payment applied. The
  accountant is to be asked whether QuickBooks' own sequence matters.
  QuickBooks' $250 deposit button stays until Alan says otherwise.
- **Sales tax**: none on the customer's invoice. Residential repair at a
  lump-sum price is not taxable in Texas; Sterling pays tax on stain and
  pickets at purchase. "Tax included" stays. Commercial and HOA common
  fences are taxable on the whole charge. Alan to confirm with the
  accountant.
- **Klarna and Affirm both on**, standard offers (no 0% promos, which cost
  the merchant roughly double).
- **Email**: the address Stripe collects at Checkout is saved to the lead
  and GHL; if it differs from the one on file it becomes a second email,
  not a replacement.
- **Receipts**: Stripe's emailed receipt on, plus our text and the
  after-payment page; the dashboard shows the invoice and receipts itself.
- **No "start date within 24 hours" promise** on the you're-in page.
- **No date-change button yet**; scheduling is not designed. No unpaid
  balance chasing yet; when it comes, email first, text later, built as an
  automation.
- **Sterling only.** A&T untouched.
- **Open**: what replaces the never-ending "20% off". Alan: "we haven't
  changed our prices in six months… some people are catching on."

## Log

- 2026-10-09 — Worktree and branch created. This file created with the
  questions and the draft phases. The New Proposal tab added to the sidebar.
- 2026-10-10 — The mockup took the day's direction: packages side by side
  on one screen with both photos, the picked one lit; repairs with
  drawings and 6/7/8 ft posts; the colours as a tap-to-read gallery
  (Legacy from Fence Photos); every price line sold the PlayStation way;
  two payment doors with Stripe Checkout screens; the FAQ from the most
  asked customer questions; the whole thing dressed in one real estimate.
- 2026-10-10 (evening) — From Alan's voice note: the two colour tabs now
  carry the package (its photo behind the name, three colours fanned out,
  a shine and a spark on the open one); the colour sheet opens on the
  thumbnail already on the page and the big photo fades in over it, so
  Legacy colours no longer "take a minute"; the greeting reads "here's
  your fence restoration plan"; the price at the bottom and on the pay
  step is labelled "Your investment".
- 2026-10-10 (night) — Alan's post-payment spec and prototype came in. Both
  flows run in the mockup after the fake checkout, with the four financing
  cases and a "what fires" strip for staff. The Stripe plan and the open
  decisions are written up above.
- 2026-10-10 (late) — The payment rails built: pay links, Stripe Checkout
  sessions, the webhook, the ledger, the customer pay page and the real
  after-payment pages, plus the Stripe links card on the lead page. All
  inert until the keys are in Railway.
- 2026-10-10 (later) — The hooks: Text on the card, tags, notes and alerts
  off payments and answers, the job-done trigger behind a switch. Fragne
  flipped PROPOSAL_BASE_URL to the Sterling domain tonight; the next send
  will show it.
- 2026-10-10 (late) — Fragne set PROPOSAL_BASE_URL to two addresses with a
  comma and the link came out broken. The variable now reads as a list:
  first address for Sterling (fence), second for A&T (brick), all of them
  allowed origins. New links are the short form `/p/<token>`; `/proposal/`
  still opens every link ever sent. Alan wants a shorter domain than
  estimate.sterlingfencetx.com: Fragne adds it in Vercel and puts it first
  in the variable; no code change.
- 2026-10-11 — The three packages wear three coats: Essential on clear wood
  with a green name and "Entry" badge, Signature in gold with "Most
  popular", Legacy in black inside a gold frame with "Premium". Rows and
  sizes unchanged so everything still lines up. The good-better-best
  research is written up above.

- 2026-10-11 — Pickets simplified to pine $12 and cedar $14, no height
  choice ("the height makes people a little bit more confused, it adds too
  much variability"). Posts keep 6, 7 and 8 ft.
- 2026-10-11 (evening) — Stripe live keys went into Railway (webhook
  confirmed answering). Alan settled the payment rules above.
- 2026-10-11 (night) — The real proposal page, first piece. `/p/<token>`
  asks for the interactive version and falls back to the PDF for every
  proposal not switched to it (`proposal_version = "interactive"`, flipped
  per lead by an admin from the Payment links panel). The two doors are
  real: Reserve makes the $250 deposit link for the package picked and
  sends them to Stripe; "See my options" makes the full-price link Klarna
  and Affirm show on. The pick is logged, noted on the contact and texted
  to Alan. The quoted price ends 30 days after the send: the page then
  shows the regular prices with a banner and still lets them reserve; a
  come-back view texts Alan once a day; "Extend quoted price 7 days" on the
  lead page. Deposit links void themselves at 7 days (410 on the pay page)
  and sit in Deposits pending on the Dashboard with the QuickBooks ones.
  Not yet: the final-total step at job done, the QuickBooks feed, Stripe's
  real financing messaging on the page, a lead's email from Checkout.
