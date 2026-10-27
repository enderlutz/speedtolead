# Automatic quote generator: research (2026-10-26)

What other companies do when a customer wants a price without talking to anyone, why it works, and what it means for Sterling's fence staining quote tool (and the pressure washing one after it). Four research passes: fence and staining companies, other trades, the mapping tech, and the conversion research. About 120 pages opened. Sources at the bottom of each section.

## 1. The short version

1. **Customers want this.** 70% want a digital estimate before they talk to anyone (Roofr 2026, n=292). 51% say no pricing on the site is a dealbreaker (Elevate 2025, n=1,200). 78% are more likely to contact a contractor who shows prices; 76% of contractors don't (myCLEARopinion 2025).
2. **Nobody in fence staining lets you book on an exact price.** Every staining company we found ends at "we text you a firm number" or "schedule a free look." Only one deck-staining company (deckstaining.com) lets you book and pay online. The install companies (Picket Pros, Two Sons, Strong Perimeter) show a live price before contact. That gap is the opening.
3. **The best staining model is Stainwright (Austin):** 5 questions, 60 seconds, yard-size buckets instead of measuring, "we measure from satellite and text a firm price within 1 business hour." Ranges public, exact number by text.
4. **The best overall model is KC Splash (pressure washing, Kansas City):** type the address, "Measuring from satellite…", the house, driveway and patio auto-outlined, tick the services, running total before any contact, then "Email me this quote" or "Schedule." That is the pattern for both our tools.
5. **Don't make them draw from a blank map.** 95% of self-design configurator sessions are abandoned (Krause & Franke 2023, 32M customers). Pre-draw the fence from the property lines and let them confirm or nudge. You get the "I did it myself" ownership effect without the drop-off.
6. **Precise beats vague.** Precise prices are judged more credible (Thomas, Simon & Kadiyali 2010). Narrow ranges with a low end you'd happily do work better than wide ones (Ames & Mason 2015). "Starting at" installs a low anchor and makes every real quote feel like an overrun. Never "starting at."
7. **Show the work.** Cost transparency raised purchases 21% in a field study (Mohan, Buell & John 2020). People value a result more when they see the system "working" for 2–3 seconds (Buell & Norton 2011). "Measuring your fence from satellite… 212 ft, 6.5 ft tall" before the price.
8. **Promise "no sales visit," not "no human."** 83% say pushy sales tactics are a dealbreaker, but 74% won't hire a roofer without an inspection and the in-home visit was the top differentiator of contractors who won (Mantel 2025). A named real person confirming the price is a trust element.
9. **The tech is nearly free.** City of Houston runs a free parcel server with HCAD, FBCAD and MCAD property lines (verified today). Google's Solar API gives the house footprint and the imagery date (10,000 free a month). Our own VA satellite tool already has the crosshair measuring. All in: about $0–20 a month at 1,000 quotes.
10. **Speed after the quote is the whole game.** Contact within an hour is 7× more likely to qualify than the next hour (HBR, 1.25M leads). Shops answering in 2 minutes convert 62% vs 28% average (ServiceTitan 2025). First touch is a text within 5 minutes. Two follow-ups, not three.

## 2. What fence and staining companies do

### Ergeon (fence installs, the biggest)
Three doors, not one: a self-serve 3D calculator ("No sign-up needed"; draw the fence line on satellite, live price updates, labelled "for budgeting purposes"), a request-a-quote form (call within 24 hours), and a **live video estimate** where a specialist walks the yard with you on your phone and models the fence on screen during the call. Public anchors: wood $22–56/ft; staining $3–10/ft "directional." Deposit: $150 max outside California. Their negative reviews are all about the number going up after the pre-install visit. Lesson: the re-measure is where trust breaks if the price moves up.

### Install companies with their own tools
| Company | Length | Contact | Price |
|---|---|---|---|
| Picket Pros (Dallas) | draw on satellite, gates click-on | name, phone, city AFTER price ("filters casual clicks") | live total from $0.00 |
| Two Sons (DFW) | typed feet | none before price | "$9,100 / Range $8,190–$10,010 / $55 per ft" |
| Strong Perimeter | drop points on map | after | total + per-foot, live |
| Kismet | draw OR "type it if you know it" | name, email, phone BEFORE reveal | range; "guaranteed price after on-site visit" |
| Diversified | draw on image | after | "small range ($5,120–$5,340)" |
| A to Z (MN) | tap to mark layout | contact FIRST | range; has a property-line guide |
| Penn / Ohio / Cool Cat | mySalesman widget ($175/mo) | first | live budget |

### Staining-specific (closest to us)
- **Stainwright / Hill Country Stain (Austin).** "Quoted in minutes, finished in a day. Free quote by text, no salesperson visit." Step 1 of 6, "Takes about 60 seconds. No pushy sales calls." Questions: what needs staining → about how long ("Not sure, we'll measure it" / Small yard / Typical lot / Corner or large lot) → what shape is the wood in (Brand new / Stained before, fading / Gray and weathered) → when (ASAP / This month / Just getting prices) → address + optional photo → name, mobile, email optional. Thank-you: "We'll measure your fence from satellite and text a firm price within 1 business hour." Ranges on the page ("$700–$2,000 most Austin privacy fences"). "Do I need to be home? No." "We remind you when it's time" (2–3 year cycle).
- **Superior Stain Solutions (SC).** Contact first, then footage preset buttons (100/150/200/250/300/400+), height, style, one or both sides, condition, prior stain type, discount checkboxes (veteran, senior, teacher, referred, repeat: 5% each), HOA yes/no. Live panel with three tiers side by side, middle one "Most picked," with per-foot anchors ("Most 6 ft privacy fences run about $9–11 per foot"). Labelled "An estimate to compare, not a quote." Over 600 ft: "text or call, we'll set up a free look." Wisetack 0% for 24 months.
- **deckstaining.com (Kingston).** The only true self-serve book-and-pay: a long questionnaire with condition photos, contact before price, then exact package prices, colour pick, "I confirm my answers are correct," Book Now with Stripe. Expectation-setting lines everywhere ("Older decks may still show some imperfections").
- **Patriot Fence & Stain (OKC).** "Send two photos and your address; they geo-map your fence line by satellite. Quote within a day." No deposit under $10k.
- **Ninja Fence Staining (Houston, our competitor).** Prints per-foot prices on the page: $4.20–4.75/ft by stain brand, "old gray fences $5.20/ft," "mid-size home $600–$900." "For 90% of our customers we can provide an accurate online quote with address and some pictures." Their calculator outputs gallons, not dollars.

### Vendor widgets we'd compete with or copy
FenceFlow ($129–229/mo: exact, range, or lead-capture-only; abandoned quotes saved as warm leads), Next Estimate (satellite trace with every leg measured, property-lines button, good/better/best, AI follow-up, auto-booking), QuoteMyFence, Visual Fence Pro (AI renders the fence on the customer's photo in ~20 s), mySalesman.

Sources: ergeon.com (/fence-calculator/, /how-it-works/, /fences/staining/, blog), picketpros.com/fence-calculator/, twosonsfencing.com/tools/fence-cost-calculator, strongperimeter.com/fence-calculator, kismetfence.com/fence-calculator/, atozqualityfencing.com/quote/, diversifiedfence.com/fence-estimator/, mysalesman.com, hillcountrystain.com (+ app.js), superiorstainsolutions.com/online-estimator/, deckstaining.com/estimate/, patriotstainandseal.com, ninjafencestaining.com, getfenceflow.com, nextestimateagency.com, visualfencepro.com.

## 3. What other trades do

- **KC Splash (pressure washing).** Address → "Measuring from satellite…" (Google Solar API) → building, lot, garage, sidewalk, driveway, patio, deck auto-outlined → adjustable tracings → tick services, total starts at $0 and updates → price BEFORE contact → "Schedule walkthrough" / "Email me this quote" → only then name, email, phone. Rates on the page: house wash $0.20/sq ft, roof $0.25–0.30, driveway $0.25, deck $1.50. "$3M Insured," "300+ five-star reviews," "Love it or you don't pay."
- **Southern Solution (TN, pressure washing).** Step 1 "Diagnose" with before/after photos of black streaks, mildew, oxidation so the customer self-identifies the problem. Step 2 "Build: pick your surfaces, watch the number build." Step 3 three timing questions. Step 4 contact. "Every quote through this builder is reviewed by the owner before anyone contacts you." "The price you approve is the price you pay."
- **LawnStarter.** Address → name → phone → "See My Price." Exact price ("not a range, not starting at"). They measure the lot from satellite; fewer than 0.2% of jobs repriced; if the pro finds it's different, "your first service stays at the quoted price." Fallback for odd lots: "call for manual yard tracing."
- **Roofle (roofing).** Address → aerial map shows every structure, tick the ones to include → "See My Price" → contact → up to 8 product cards like a store → "Email me this quote" / "Get Pre-Qualified." Captures every address typed, even when the customer stops before the form.
- **Roofr.** Address → a few questions → good/better/best ranges (±10%) → contact → team profile cards with faces right after the price → book a meeting. Fallback: a $13 human-made measurement report in 2 hours.
- **Paintzen.** Pick rooms, size each small/medium/large ("no need to measure"), per-room all-in price in 30 seconds, no email first, refundable 10% deposit. "5x5 Pledge": quote in 5 minutes, crew in 5 days.
- **LoadUp (junk).** Zip → pick items → guaranteed price before contact → pick a window. "What you see online is exactly what you pay." Odd jobs: "upload a photo."
- **Renewal by Andersen, 1-800-GOT-JUNK, VersaCourt.** No price online, on purpose. Everyone else in this list is selling against that model ("no calls, no pressure, no in-person estimates").

### Patterns that repeat (3+ tools each)
1. Address is the first and often only question. Satellite or parcel data does the measuring.
2. Show the measured outline and let the customer fix it with a tap or drag. Confirming beats drawing.
3. Price before contact in the best small-company tools. The big marketplaces that gate keep it to address + name + phone, no email, button "See My Price," "Your information is secure" under it.
4. Never more than three fields before the number. Anything else is a bucket (S/M/L, "a two-car driveway is about 600 sq ft"), not typing.
5. A running total that starts at $0 and moves as they tick. The visible $/ft is itself a trust element.
6. Tiers or product cards at the reveal, middle one marked "Most picked."
7. A named step that turns the range into the exact number: "Get my exact quote," "free on-site confirmation, the price you approve is the price you pay," "book online to lock in your price," a video call.
8. A price-protection promise attached to the number ("your first service stays at the quoted price").
9. A time claim next to the form: 26 s, 29 s, "under 60 seconds," "in about a minute."
10. One obvious next action right after the price: pick a day, "Email me this quote," financing pre-qual, small refundable deposit.
11. A fallback door for what the satellite can't see: photo upload, video call, "we'll trace it by hand," and silently keeping the address as a lead.
12. The trust stack sits beside the price, not on an About page: star rating + count, insured amount, a guarantee with teeth, the owner's name, after-photos.

### Mistakes seen
Email-gated results that promise "instant" then say "we'll email it." Wide, disclaimer-first ranges ("$10,000–$20,000," "for educational purposes only"). Desktop-only drawing tools. No path when the property can't be measured (dead end = abandoned lead). Hiding the price behind the appointment. 20+ questions before a number.

Sources: kc-splash.com/residential-pressure-washing-pricing/, southernsolutiontn.com/instant-quote/, lawnstarter.com (how-to-get-lawn-care-quote), offers.roofle.com + win.roofle.com/faqs, roofr.com/instant-estimator, paintzen.com, goloadup.com, drivewaysatellite.com, ezestimate.io, pickleballcourtquote.com, deeplawn.com, myquoteiq.com, responsibid.com.

## 4. The psychology, with the evidence

| Question | What the evidence says | Source |
|---|---|---|
| Exact, range, or tiers? | Three honest tiers; the middle wins by the compromise effect. Precise numbers ($1,240) read as more credible than round ones. If a range, keep it narrow with the low end a number you'd do. Fake "decoy" tiers don't replicate. | Simonson 1989; Thomas et al. 2010 (Marketing Science); Ames & Mason 2015 (JPSP); Frederick et al. 2014 |
| "Starting at"? | Installs a low anchor; every real quote feels like an overrun. 70% would pay more to avoid surprise costs. | Elevate 2025 (n=1,200); Housecall Pro 2025 (n=1,040) |
| Contact before or after the price? | After. 19% abandon over forced sign-up; 18% over long forms. Soft gate = name + phone to "text me this quote." Ergeon and LawnStarter never ask email before booking. | Baymard 2025; Demand IQ case (1.7% → 3.0% site conversion after replacing forms with instant estimates) |
| What proof next to the price? | Detailed reviews with before/after photos (55%); stock/AI images lose trust (65%); tech's name and photo (60%); payment plans (55%). Before contact people judge by reviews (52%); at decision time by explanations (55%) and the visit (71%). | Elevate 2025; Housecall Pro 2025; Mantel 2025 (n=422) |
| Explain the price? | Voluntary cost transparency: +21% purchase probability, +22% sales over 92 days. But explanations alone are "modestly effective"; proof beats words. | Mohan, Buell & John 2020; Bolton, Warlop & Alba 2003 |
| Let them draw? | Self-designed items get higher willingness to pay (IKEA effect, +63%), BUT 95% of configurator sessions are abandoned, 56% of abandoners had purchase intent. Fix: start from a pre-drawn template, not a blank slate. | Franke et al. 2010; Norton et al. 2012; Krause & Franke 2023 (32M customers) |
| Show the work? | A visible 2–3 second "measuring…" raises perceived value and willingness to pay vs an instant identical result. | Buell & Norton 2011 (Management Science) |
| "No sales call, ever"? | 83% hate pushy sales, but 74% won't hire a roofer without an inspection and 51% still prefer an in-person first meeting. Promise "no sales visit, no pressure," never "no human." | Elevate 2025; Roofr 2026; Modernize 2025 |
| Deposit? | Deposits cut no-shows 40–55%; deposits over 50% of price hurt conversion. Full payment up front is a hesitation point. | schedulingkit, PocketSuite (vendor) |
| Mobile? | About two-thirds of traffic. Multi-step forms 13.9% vs 4.5% single page. 44 px targets, numbered steps, under 60 seconds, tap-to-text phone on every screen, autosave + a resume link by text. | Formstack; Apple/Material; ServiceTitan abandoned-lead SMS |
| Follow-up? | Within an hour = 7× more likely to qualify than the next hour; 60× vs 24 hours. 2-minute answer = 62% conversion vs 28% average. 53% appreciate two follow-ups; a third feels excessive to half. Text first. | HBR 2011 (1.25M leads); ServiceTitan 2025; Elevate 2025; Hatch 2024 |
| Price lock "7 days"? | No evidence either way. Only promise it if it's true. | — |

## 5. The tech, verified

- **Property lines, free:** City of Houston ArcGIS FeatureServer `geohwp.houstontx.gov/arcgis/rest/services/03_BaseData_External/Parcels_Current/FeatureServer`, layers 4 (HCAD), 5 (FBCAD), 3 (MCAD). Point-in-parcel query returns the polygon plus `ADDRESS`, `ACREAGE`, `YEAR_BUILT`. Tested today at Cypress, Sugar Land and Spring. No key, no SLA: cache results. Backup: TxGIO StratMap statewide parcels (`/identify` works). Paid if we leave the three counties: Regrid $375/mo (2,000 lookups).
- **House footprint and imagery date:** Google Solar API `buildingInsights`, $10/1,000, 10,000 free/mo. Returns the building box and `imageryDate`. Compare with `YEAR_BUILT`: imagery older than the house = new build = fallback path, automatically.
- **Satellite view:** Google Maps JS satellite, zoom 20–21 (about 5 in/px), $7/1,000 loads, 10,000 free. Static Maps $2/1,000, 10,000 free. Terms: no computer vision on Google tiles and no caching the satellite image. **Freeze the quote as coordinates, re-render the map; never store the PNG with the price.** (The VA tool today stores Static Map PNGs for internal use.)
- **Drawing on a phone:** Google's Drawing Library is gone (May 2026). Our own crosshair "Add point" tool in `SatelliteMeasureCard.tsx` is the right mechanic (Alan's rule: no tap-to-place). Terra Draw (MIT) if we want drag-to-edit corners with big handles. Avoid Mapbox GL Draw (double-tap bug on touch).
- **Auto-detecting the fence:** not realistic now (research exists, nothing to buy; Google's terms forbid it on their tiles). The practical version: back lot line + two sides from the parcel, front excluded, house front from the Solar box. Expected ±5–10% before the customer touches it. Houston subdivision lots make this work well.
- **Height, stained-or-not, condition:** Street View Static ($7/1,000, metadata free) shows only the street-facing fence. Better: two customer photos (one whole section with a gate or door for scale, one close-up) classified by a vision model, about $0.01 per quote. Our fence photo guide (6 / 6.5 / 7 / 8 ft, cap, rot board) is the training reference.
- **Cost at 300–1,000 quotes a month:** Google only ≈ $0–20. Plus county parcels: +$0. Plus Regrid: +$375. Nearmap (sharper, dated, 3× a year): $5–15k a year, quote only. Not needed to start.
- **Fallback ladder (matches the comparable-neighbour / video rule):** (1) parcel-only estimate shown as a narrow range "we confirm before work" → (2) typed footage with a Houston-lot helper ("a typical lot is about 200 ft") → (3) two photos or a 20-second video → (4) "we'll measure it by tomorrow" (VA, Google Earth history). Trigger automatically when the imagery is older than the house or the fence isn't visible.

## 6. Our own numbers (from the dashboard)

- 300–340 leads a month; 700 of 889 since August came from ads, 188 from the website form. The quote tool is an ad landing page first.
- 25% of leads leave height blank or say "I don't know" (222 of 889). The tool cannot depend on the customer knowing height.
- Pricing engine exists: sq ft × age-bracket rate × Essential / Signature / Legacy, size surcharge, zone surcharge by ZIP (Base / Blue +8¢ / Purple +12¢ / Far +20¢), $600 minimum, 15+ yr priced at the 6–15 rate.
- The VA's satellite measuring tool (address → satellite → crosshair → Add point → feet, runs that sum) is the customer tool's mechanic, already built.
- Booking invite (hold a day, $250 deposit, Stripe) and the interactive proposal (three packages, frozen scope drawing) already exist as public pages at estimate.sterlingfencetx.com.
- Houston anchors in the wild: Ninja $4.20–5.20/ft. Ours at 6.5 ft Signature 1–6 yr ≈ $5.59/ft before surcharges.

## 7. Rules for our quote page (derived)

1. Address first. Nothing else before the map.
2. Pre-draw the fence from the property lines; "That's right" or drag a corner. Per-side toggles for "neighbour's side," "brick wall," "wrought iron."
3. Height and condition as pictures to tap, never a text field. "Not sure" is always an allowed answer.
4. Show the work for 2–3 seconds: "Measuring from satellite… 212 ft × 6.5 ft = 1,378 sq ft."
5. Three packages, precise numbers, Signature marked "Most picked," same words as the phone script. Never "starting at."
6. Price before contact. Then two buttons: "Text me this quote" (name + phone) and "Hold a day" ($250, the existing booking page). Email only at booking.
7. Proof under the price: three before/after photos near their ZIP, Google rating and count, one-line warranty, crew first names and faces, what's included, the 2–3 things that could change the price.
8. "What happens next" with durations: text within 5 minutes, a real person checks the price, cleaning day, dry day, stain day, pay at the end.
9. "No sales visit, no pressure. Nobody needs to be home." Never "no human."
10. A named can't-see-my-house path: two photos or a 20-second video, same price promise.
11. Keep the address as a lead even if they stop. Autosave; text a resume link after 10 minutes if they gave a phone.
12. First human touch is a text within 5 minutes. Day 2, day 3, skip, day 5 with an out. Two follow-ups for unsold quotes, then a 30-day "still on file."
13. Price-lock words only if true.
14. Track: quote started, price seen, contact given, day held, repriced after the visit. The reprice rate tells us whether the number is honest.
15. Phone first: 44 px targets, 15 px body, one question per screen, under 60 seconds, four numbered steps.
